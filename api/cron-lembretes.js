// Disparado 1x por dia pelo Vercel Cron (ver vercel.json) — avisa cada
// vendedor/gerente (notificação + e-mail) sobre agendamentos marcados pra
// daqui a exatamente 7 dias. Fora do dispatcher de api/backend.js pelo
// mesmo motivo do cron-resumo: não é ação de usuário, Vercel manda GET com
// Authorization: Bearer $CRON_SECRET.
import { computeLembretesAgendamento, buildLembreteEmailHtml } from '../lib/handlers/lembretesAgendamento.js';
import { readEmailConfig } from '../lib/handlers/config.js';
import { sendPushToVendedor } from '../lib/handlers/push.js';
import { sendEmail } from '../lib/email.js';
import { isConfigOn } from '../lib/common.js';

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
        const config = await readEmailConfig();
        if (!isConfigOn(config.lembrete_agendamento_ativo)) {
            res.status(200).json({ status: 'ok', enviados: 0, motivo: 'desligado_nas_configuracoes' });
            return;
        }

        const { dataAlvoLabel, porVendedor } = await computeLembretesAgendamento();
        if (!porVendedor.length) {
            res.status(200).json({ status: 'ok', enviados: 0, motivo: 'nenhum_agendamento_na_data' });
            return;
        }

        let enviados = 0;
        for (const dest of porVendedor) {
            if (!dest.email) continue;
            const html = buildLembreteEmailHtml(dest.vendedor, dest.agendamentos, dataAlvoLabel);
            const result = await sendEmail({
                to: dest.email,
                subject: `📅 Agendamento em ${dataAlvoLabel}`,
                html
            });
            if (result.enviado) enviados++;
            // Notificação é um canal independente do e-mail (não uma
            // confirmação dele) — manda sempre, best-effort.
            await sendPushToVendedor(dest.email, {
                title: '📅 Agendamento chegando',
                body: dest.agendamentos.length > 1
                    ? `${dest.agendamentos.length} agendamentos em ${dataAlvoLabel}.`
                    : `${dest.agendamentos[0].cliente} — ${dataAlvoLabel}.`,
                page: 'calendar', tag: 'lembrete-agendamento-' + dataAlvoLabel, tipo: 'aviso'
            });
        }

        res.status(200).json({ status: 'ok', vendedores: porVendedor.length, enviados });
    } catch (error) {
        console.error('cron-lembretes:', error);
        res.status(200).json({ status: 'error', message: error.message });
    }
}
