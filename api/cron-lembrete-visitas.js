// Disparado pelo Vercel Cron de segunda a sexta às 17h de Brasília (20h UTC,
// ver vercel.json) — lembra quem ainda não registrou nenhuma visita no dia
// de lançar as visitas no app. Só push no aparelho (não grava na tela de
// Notificações, senão virava um aviso igual por dia). Fora do dispatcher de
// api/backend.js pelo mesmo motivo dos outros crons: Vercel manda GET com
// Authorization: Bearer $CRON_SECRET.
import { getSheetObjects, withCache } from '../lib/sheets.js';
import { readEmailConfig } from '../lib/handlers/config.js';
import { sendPushOnly } from '../lib/handlers/push.js';
import { isConfigOn } from '../lib/common.js';

function hojeBrasilia() {
    // dd/mm/aaaa no fuso de Brasília — o cron roda em UTC.
    const parts = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric' }).formatToParts(new Date());
    const get = (t) => parts.find((p) => p.type === t).value;
    return { label: `${get('day')}/${get('month')}/${get('year')}`, d: Number(get('day')), m: Number(get('month')), y: Number(get('year')) };
}

function mesmaData(valor, hoje) {
    const txt = String(valor || '').trim().split(' ')[0];
    const p = txt.split('/');
    if (p.length !== 3) return false;
    return Number(p[0]) === hoje.d && Number(p[1]) === hoje.m && Number(p[2]) === hoje.y;
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
        const config = await readEmailConfig();
        if (!isConfigOn(config.lembrete_registrar_visitas_ativo ?? 'true')) {
            res.status(200).json({ status: 'ok', enviados: 0, motivo: 'desligado_nas_configuracoes' });
            return;
        }

        const hoje = hojeBrasilia();
        const [vendedores, visitas] = await Promise.all([
            withCache('vendedores_all_cron', 60, () => getSheetObjects('Vendedores')),
            withCache('visitas_sheet_raw', 60, () => getSheetObjects('Visitas'))
        ]);

        const comVisitaHoje = new Set(visitas
            .filter((v) => mesmaData(v['Data da Visita'], hoje))
            .map((v) => String(v['Vendedor/Gerente'] || '').trim().toLowerCase()));

        const destinatarios = vendedores.filter((row) => {
            if (String(row.Ativo || '').trim().toLowerCase() === 'nao') return false;
            if (!String(row.EmailLogin || '').trim()) return false;
            return !comVisitaHoje.has(String(row.NomeVendedor || '').trim().toLowerCase());
        });

        let enviados = 0;
        for (const row of destinatarios) {
            const primeiroNome = String(row.NomeVendedor || '').trim().split(' ')[0];
            enviados += await sendPushOnly(row.EmailLogin, {
                title: '📋 Registre suas visitas de hoje',
                body: `${primeiroNome ? primeiroNome + ', a' : 'A'}inda não tem visita sua lançada hoje. Toque pra registrar.`,
                page: 'visit-new',
                tag: 'lembrete-registrar-visitas-' + hoje.label
            });
        }

        res.status(200).json({ status: 'ok', data: hoje.label, semVisita: destinatarios.length, enviados });
    } catch (error) {
        console.error('cron-lembrete-visitas:', error);
        res.status(200).json({ status: 'error', message: error.message });
    }
}
