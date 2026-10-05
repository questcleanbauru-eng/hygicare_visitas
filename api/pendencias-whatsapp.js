// Chamado pelo robozinho de WhatsApp (roda local, fora da Vercel — ver
// whatsapp-bot/) pra buscar, pra cada vendedor com telefone cadastrado, os
// agendamentos vencidos dele. Não é um Vercel Cron (por isso não está em
// vercel.json "crons") — é puxado sob demanda pelo script local, só quando
// o computador está ligado. Protegido pelo mesmo esquema do cron-resumo.js
// (Authorization: Bearer $WHATSAPP_PENDENCIAS_SECRET), mas com secret
// própria — esse endpoint expõe nome+telefone de todo mundo, então merece
// uma chave só dele em vez de reaproveitar o CRON_SECRET.
import { getSheetObjects, withCache } from '../lib/sheets.js';
import { parseDate, isConfigOn } from '../lib/common.js';
import { readAgendamentoRows } from '../lib/handlers/agendamentos.js';
import { nowInSaoPaulo } from '../lib/handlers/resumo.js';
import { readEmailConfig } from '../lib/handlers/config.js';

const RESUMO_USER = { profile: 'admin', name: '', email: '', gerencia: '' };

function startOfDay(d) {
    const c = new Date(d);
    c.setHours(0, 0, 0, 0);
    return c;
}

export default async function handler(req, res) {
    if (req.method !== 'GET') {
        res.status(405).json({ status: 'error', message: 'Method not allowed.' });
        return;
    }
    const secret = process.env.WHATSAPP_PENDENCIAS_SECRET;
    if (!secret) {
        res.status(500).json({ status: 'error', message: 'WHATSAPP_PENDENCIAS_SECRET não configurado.' });
        return;
    }
    const auth = String(req.headers.authorization || '');
    if (auth !== `Bearer ${secret}`) {
        res.status(401).json({ status: 'error', message: 'Não autorizado.' });
        return;
    }

    try {
        const config = await readEmailConfig();
        // Devolvido em toda resposta (mesmo pausado) — é assim que o robô
        // local sabe horário/dias sem precisar guardar isso no .env dele;
        // o Admin vira a única fonte de verdade pro agendamento de envio.
        const schedule = {
            horaInicio: config.whatsapp_hora_inicio || '08:00',
            horaLimite: config.whatsapp_hora_limite || '18:00',
            diasSemana: String(config.whatsapp_dias_semana || '1,2,3,4,5').split(',').map((d) => Number(d.trim())).filter((d) => !Number.isNaN(d))
        };
        // Pedido de mensagem de teste (botão em Admin > Configurações) —
        // devolvido sempre, mesmo pausado, porque teste deve funcionar
        // independente da pausa/janela (é só pra confirmar que chega).
        let teste = null;
        try { teste = JSON.parse(config.whatsapp_teste_pedido || 'null'); } catch { /* ignora valor inválido */ }

        if (isConfigOn(config.whatsapp_pendencias_pausado)) {
            res.status(200).json({ status: 'success', data: [], pausado: true, schedule, teste });
            return;
        }

        const today = startOfDay(nowInSaoPaulo());
        const [vendedores, agendamentos] = await Promise.all([
            withCache('vendedores_all_wa', 60, () => getSheetObjects('Vendedores')),
            readAgendamentoRows(RESUMO_USER)
        ]);

        const vencidosPorVendedor = {};
        agendamentos.forEach((a) => {
            if (a.status !== 'Pendente') return;
            const d = parseDate(a.dataAgendada);
            if (!d || d >= today) return;
            const nome = String(a.vendedor || '').trim();
            if (!nome) return;
            const diasAtraso = Math.round((today.getTime() - d.getTime()) / 86400000);
            (vencidosPorVendedor[nome] = vencidosPorVendedor[nome] || []).push({
                cliente: a.cliente || 'Cliente não informado',
                dataAgendada: a.dataAgendada,
                diasAtraso
            });
        });

        const destinatarios = vendedores
            .filter((v) => String(v.Ativo || '').trim().toLowerCase() !== 'nao')
            .map((v) => {
                const nome = String(v.NomeVendedor || '').trim();
                const telefone = String(v.TelefoneWhatsapp || '').trim();
                const pendencias = vencidosPorVendedor[nome] || [];
                return { nome, telefone, pendencias };
            })
            .filter((d) => d.telefone && d.pendencias.length);

        res.status(200).json({ status: 'success', data: destinatarios, pausado: false, schedule, teste });
    } catch (error) {
        console.error('pendencias-whatsapp:', error);
        res.status(200).json({ status: 'error', message: error.message });
    }
}
