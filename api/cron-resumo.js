// Disparado 1x por dia pelo Vercel Cron (ver vercel.json) — não é uma ação
// de usuário, por isso fica fora do dispatcher de api/backend.js (que só
// aceita POST com sessão). Vercel manda GET com
// Authorization: Bearer $CRON_SECRET quando essa env var existe; conferimos
// isso aqui pra ninguém de fora poder disparar o envio na mão.
import { getSheetObjects, withCache } from '../lib/sheets.js';
import { readEmailConfig } from '../lib/handlers/config.js';
import { computeResumoDiario, buildResumoEmailHtml } from '../lib/handlers/resumo.js';
import { resolveAdminsAtivos } from '../lib/handlers/lembreteClientes.js';
import { sendPushToVendedor } from '../lib/handlers/push.js';
import { sendEmail } from '../lib/email.js';
import { isConfigOn } from '../lib/common.js';

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

// Lembrete pro admin revisar/atualizar a Base de Clientes — simples e
// incondicional (não depende de "teve atividade ontem" como o resumo).
// Roda dentro desse mesmo cron (em vez de um endpoint próprio) porque o
// plano Hobby da Vercel só permite 2 cron jobs — juntar os dois nessa
// mesma execução diária evita precisar de um 3º.
async function sendLembreteClientes(config) {
    if (!isConfigOn(config.lembrete_atualizar_clientes_ativo)) return 0;
    const admins = await resolveAdminsAtivos();
    const hoje = new Date().toISOString().slice(0, 10);
    let enviados = 0;
    for (const a of admins) {
        if (!a.EmailLogin) continue;
        await sendPushToVendedor(a.EmailLogin, {
            title: '📋 Lembrete diário',
            body: 'Hora de revisar/atualizar a base de Clientes.',
            page: 'admin', tag: 'lembrete-clientes-' + hoje, tipo: 'aviso'
        });
        enviados++;
    }
    return enviados;
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

        const lembreteClientesEnviados = await sendLembreteClientes(config);

        const hasAny = resumo.visitas.total || resumo.agendamentos.vencidosTotal || resumo.agendamentos.proximosTotal
            || resumo.relatorios.total || resumo.campanhas.respondidasOntem || resumo.campanhas.pendentesTotal;
        if (!hasAny) {
            res.status(200).json({ status: 'ok', enviados: 0, lembreteClientesEnviados, motivo: 'dia_sem_atividade' });
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

        res.status(200).json({ status: 'ok', destinatarios: recipients.length, enviados, lembreteClientesEnviados });
    } catch (error) {
        console.error('cron-resumo:', error);
        res.status(200).json({ status: 'error', message: error.message });
    }
}
