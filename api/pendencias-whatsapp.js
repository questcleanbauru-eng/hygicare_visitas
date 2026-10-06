// Chamado pelo robozinho de WhatsApp (roda local, fora da Vercel — ver
// whatsapp-bot/) pra buscar TUDO que pode virar aviso pra cada vendedor:
// agendamentos vencidos, propostas paradas, funil parado, campanhas
// pendentes de resposta e falta de atividade recente (sem visita/
// prospecção há mais de LIMITE_INATIVIDADE_DIAS). Quem tem WhatsApp
// cadastrado vai em "data" (recebe de verdade); quem tem pendência mas não
// cadastrou telefone vai em "semTelefone" (só aparece no painel como
// aviso, não recebe nada). Não é um Vercel Cron (por isso não está em
// vercel.json "crons") — é puxado sob demanda pelo script local, só quando
// o computador está ligado. Protegido pelo mesmo esquema do cron-resumo.js
// (Authorization: Bearer $WHATSAPP_PENDENCIAS_SECRET), mas com secret
// própria — esse endpoint expõe nome+telefone de todo mundo, então merece
// uma chave só dele em vez de reaproveitar o CRON_SECRET.
import { getSheetObjects, withCache } from '../lib/sheets.js';
import { parseDate, isConfigOn } from '../lib/common.js';
import { readAgendamentoRows } from '../lib/handlers/agendamentos.js';
import { normalizeProposalRow } from '../lib/handlers/proposals.js';
import { readFunilRows } from '../lib/handlers/funil.js';
import { readCampanhaRows } from '../lib/handlers/campanhas.js';
import { nowInSaoPaulo } from '../lib/handlers/resumo.js';
import { readEmailConfig } from '../lib/handlers/config.js';

const RESUMO_USER = { profile: 'admin', name: '', email: '', gerencia: '' };

// Mesmo critério de "parado" já usado no Relatório de Propostas/Funil e no
// Resumo Diário — não inventa um novo número.
const DIAS_PARADO = 30;
// Sem nenhuma visita/prospecção registrada há mais que isso = "favor
// atualizar o aplicativo" (pedido do admin).
const DIAS_INATIVIDADE = 60;

function startOfDay(d) {
    const c = new Date(d);
    c.setHours(0, 0, 0, 0);
    return c;
}

function diasEntre(hoje, data) {
    const d = parseDate(data);
    if (!d) return null;
    return Math.round((hoje.getTime() - d.getTime()) / 86400000);
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
            res.status(200).json({ status: 'success', data: [], semTelefone: [], pausado: true, schedule, teste });
            return;
        }

        const today = startOfDay(nowInSaoPaulo());
        const [vendedores, agendamentos, propostasRaw, funil, campanhas, visitasRaw] = await Promise.all([
            withCache('vendedores_all_wa', 60, () => getSheetObjects('Vendedores')),
            readAgendamentoRows(RESUMO_USER),
            withCache('propostas_sheet_raw', 60, () => getSheetObjects('Propostas')),
            readFunilRows(RESUMO_USER, 0),
            readCampanhaRows(RESUMO_USER),
            withCache('visitas_sheet_raw', 60, () => getSheetObjects('Visitas'))
        ]);
        const propostas = propostasRaw.map(normalizeProposalRow);

        // ── Agendamentos vencidos ────────────────────────────────────────
        const agendamentosPorVendedor = {};
        agendamentos.forEach((a) => {
            if (a.status !== 'Pendente') return;
            const d = parseDate(a.dataAgendada);
            if (!d || d >= today) return;
            const nome = String(a.vendedor || '').trim();
            if (!nome) return;
            (agendamentosPorVendedor[nome] = agendamentosPorVendedor[nome] || []).push({
                cliente: a.cliente || 'Cliente não informado',
                dataAgendada: a.dataAgendada,
                diasAtraso: diasEntre(today, a.dataAgendada)
            });
        });

        // ── Propostas paradas (Aguardando, sem atualização há >30d) ──────
        const propostasPorVendedor = {};
        propostas.forEach((p) => {
            const status = String(p.Status || '').trim().toUpperCase();
            if (status !== 'AGUARDANDO') return;
            const dias = diasEntre(today, p['Atualização'] || p.Data);
            if (dias === null || dias <= DIAS_PARADO) return;
            const nome = String(p.Vendedor || '').trim();
            if (!nome) return;
            (propostasPorVendedor[nome] = propostasPorVendedor[nome] || []).push({
                cliente: p.Cliente || 'Cliente não informado',
                diasParada: dias
            });
        });

        // ── Funil parado (ativo, sem atualização há >30d) ────────────────
        const funilPorVendedor = {};
        funil.forEach((f) => {
            if (String(f.ativo || '').trim().toLowerCase() !== 'sim') return;
            const dias = diasEntre(today, f.atualizacao || f.data);
            if (dias === null || dias <= DIAS_PARADO) return;
            const nome = String(f.vendedor || '').trim();
            if (!nome) return;
            (funilPorVendedor[nome] = funilPorVendedor[nome] || []).push({
                cliente: f.cliente || 'Cliente não informado',
                diasParado: dias
            });
        });

        // ── Campanhas com item pendente de resposta ──────────────────────
        const campanhasPorVendedor = {};
        campanhas.forEach((c) => {
            if (c.status === 'concluida') return;
            const pendentes = c.itens.filter((it) => !it.respondidoEm).length;
            if (!pendentes) return;
            const nome = String(c.vendedorDestino || '').trim();
            if (!nome) return;
            (campanhasPorVendedor[nome] = campanhasPorVendedor[nome] || []).push({ titulo: c.titulo || 'Campanha', pendentes });
        });

        // ── Sem visita/prospecção registrada há mais de 60 dias ──────────
        const ultimaVisitaPorVendedor = {};
        visitasRaw.forEach((v) => {
            const nome = String(v['Vendedor/Gerente'] || '').trim();
            if (!nome) return;
            const d = parseDate(v['Data da Visita']);
            if (!d) return;
            if (!ultimaVisitaPorVendedor[nome] || d > ultimaVisitaPorVendedor[nome]) ultimaVisitaPorVendedor[nome] = d;
        });
        const inatividadePorVendedor = {};
        Object.entries(ultimaVisitaPorVendedor).forEach(([nome, data]) => {
            const dias = Math.round((today.getTime() - data.getTime()) / 86400000);
            if (dias > DIAS_INATIVIDADE) inatividadePorVendedor[nome] = dias;
        });

        const comPendencia = vendedores
            .filter((v) => String(v.Ativo || '').trim().toLowerCase() !== 'nao')
            .map((v) => {
                const nome = String(v.NomeVendedor || '').trim();
                const telefone = String(v.TelefoneWhatsapp || '').trim();
                const email = String(v.EmailLogin || '').trim();
                return {
                    nome,
                    telefone,
                    email,
                    agendamentos: agendamentosPorVendedor[nome] || [],
                    propostas: propostasPorVendedor[nome] || [],
                    funil: funilPorVendedor[nome] || [],
                    campanhas: campanhasPorVendedor[nome] || [],
                    diasSemAtividade: inatividadePorVendedor[nome] || null
                };
            })
            .filter((d) => d.agendamentos.length || d.propostas.length || d.funil.length || d.campanhas.length || d.diasSemAtividade);

        // Só quem tem telefone recebe de verdade; quem tem pendência mas
        // não cadastrou WhatsApp aparece à parte (semTelefone) — o painel
        // avisa disso em vez de simplesmente sumir essas pessoas da lista.
        const destinatarios = comPendencia.filter((d) => d.telefone);
        const semTelefone = comPendencia.filter((d) => !d.telefone).map(({ telefone, ...resto }) => resto);

        res.status(200).json({ status: 'success', data: destinatarios, semTelefone, pausado: false, schedule, teste });
    } catch (error) {
        console.error('pendencias-whatsapp:', error);
        res.status(200).json({ status: 'error', message: error.message });
    }
}
