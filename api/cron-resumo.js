// Disparado 1x por dia pelo Vercel Cron (ver vercel.json) — não é uma ação
// de usuário, por isso fica fora do dispatcher de api/backend.js (que só
// aceita POST com sessão). Vercel manda GET com
// Authorization: Bearer $CRON_SECRET quando essa env var existe; conferimos
// isso aqui pra ninguém de fora poder disparar o envio na mão.
import { getSheetObjects, withCache } from '../lib/sheets.js';
import { readEmailConfig } from '../lib/handlers/config.js';
import { computeResumoDiario, buildResumoEmailHtml } from '../lib/handlers/resumo.js';
import { sendPushToVendedor } from '../lib/handlers/push.js';
import { sendEmail } from '../lib/email.js';

const TOGGLE_BY_PROFILE = {
    admin: 'resumo_diario_admin',
    gerente: 'resumo_diario_gerente',
    vendedor: 'resumo_diario_vendedor'
};

async function resolveRecipients(config) {
    const rows = await withCache('vendedores_all_cron', 60, () => getSheetObjects('Vendedores'));
    return rows.filter((row) => {
        const perfil = String(row.Perfil || '').trim().toLowerCase();
        const toggleKey = TOGGLE_BY_PROFILE[perfil];
        if (!toggleKey || String(config[toggleKey]).trim().toLowerCase() !== 'true') return false;
        return String(row.Ativo || '').trim().toLowerCase() !== 'nao';
    }).map((row) => ({ email: row.EmailLogin, nome: row.NomeVendedor }));
}

export default async function handler(req, res) {
    if (req.method !== 'GET') {
        res.status(405).json({ status: 'error', message: 'Method not allowed.' });
        return;
    }
    const cronSecret = process.env.CRON_SECRET;
    if (cronSecret) {
        const auth = String(req.headers.authorization || '');
        if (auth !== `Bearer ${cronSecret}`) {
            res.status(401).json({ status: 'error', message: 'Não autorizado.' });
            return;
        }
    }

    try {
        const [resumo, config] = await Promise.all([computeResumoDiario(), readEmailConfig()]);
        const hasAny = resumo.visitas.total || resumo.agendamentos.vencidosTotal || resumo.agendamentos.proximosTotal
            || resumo.relatorios.total || resumo.campanhas.respondidasOntem || resumo.campanhas.pendentesTotal;
        if (!hasAny) {
            res.status(200).json({ status: 'ok', enviados: 0, motivo: 'dia_sem_atividade' });
            return;
        }

        const recipients = await resolveRecipients(config);
        const html = buildResumoEmailHtml(resumo);
        let enviados = 0;
        for (const dest of recipients) {
            if (!dest.email) continue;
            const result = await sendEmail({ to: dest.email, subject: `📋 Resumo de ${resumo.dataResumo}`, html });
            if (result.enviado) {
                enviados++;
                // Best-effort: um push que não entrega não deve derrubar o
                // loop nem o restante dos envios de e-mail.
                await sendPushToVendedor(dest.email, {
                    title: '📧 Seu resumo de ontem foi enviado por e-mail',
                    body: `Resumo de ${resumo.dataResumo} — confira sua caixa de entrada.`,
                    page: 'dashboard', tag: 'resumo-diario-' + resumo.dataResumo, tipo: 'aviso'
                });
            }
        }

        res.status(200).json({ status: 'ok', destinatarios: recipients.length, enviados });
    } catch (error) {
        console.error('cron-resumo:', error);
        res.status(200).json({ status: 'error', message: error.message });
    }
}
