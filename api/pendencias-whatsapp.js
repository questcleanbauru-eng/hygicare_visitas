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
import { readContratoRows } from '../lib/handlers/contratos.js';
import { nowInSaoPaulo } from '../lib/handlers/resumo.js';
import { readEmailConfig } from '../lib/handlers/config.js';

// Cada categoria manda num horário PRÓPRIO (configurável em Admin), como
// mensagens SEPARADAS — antes era tudo junto numa mensagem só às
// whatsapp_hora_inicio. O robô local decide, a cada checagem, quais
// categorias já passaram do próprio horário hoje e ainda não foram
// enviadas (controle por categoria fica no estado local do robô).
const HORA_PADRAO_POR_CATEGORIA = {
    agendamentos: '08:00',
    propostas: '08:30',
    funil: '09:00',
    campanhas: '09:30',
    inatividade: '10:00',
    contratos: '10:30'
};

const RESUMO_USER = { profile: 'admin', name: '', email: '', gerencia: '' };
// Mesmo padrão de lib/handlers/resumo.js (buildResumoEmailHtml) — pro link
// de campanha no aviso de WhatsApp abrir a campanha certa direto (sem
// precisar procurar na lista depois de logar).
const APP_URL = process.env.APP_URL || 'https://hygicare-visitas.vercel.app';

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
        const horarios = {};
        const ativos = {};
        Object.keys(HORA_PADRAO_POR_CATEGORIA).forEach((cat) => {
            horarios[cat] = config[`whatsapp_hora_${cat}`] || HORA_PADRAO_POR_CATEGORIA[cat];
            // Liga/desliga por categoria, independente da pausa geral —
            // defaultEmailConfig já garante 'true' por padrão.
            ativos[cat] = isConfigOn(config[`whatsapp_ativo_${cat}`]);
        });
        const schedule = {
            horarios,
            ativos,
            diasSemana: String(config.whatsapp_dias_semana || '1,2,3,4,5').split(',').map((d) => Number(d.trim())).filter((d) => !Number.isNaN(d))
        };
        // Pedido de mensagem de teste (botão em Admin > Configurações) —
        // devolvido sempre, mesmo pausado, porque teste deve funcionar
        // independente da pausa/janela (é só pra confirmar que chega).
        let teste = null;
        try { teste = JSON.parse(config.whatsapp_teste_pedido || 'null'); } catch { /* ignora valor inválido */ }
        // Modo aprovação manual (ver Admin > Configurações) — devolvido
        // sempre, igual pausado/schedule, pro robô local decidir se manda
        // sozinho ou só deixa pronto pro admin clicar "Agora".
        const aprovacaoManual = isConfigOn(config.whatsapp_aprovacao_manual);

        if (isConfigOn(config.whatsapp_pendencias_pausado)) {
            res.status(200).json({ status: 'success', data: [], semTelefone: [], pausado: true, schedule, teste, aprovacaoManual });
            return;
        }

        // Configurável em Admin > Configurações — mesmo critério usado no
        // Relatório de Propostas/Funil e no Resumo Diário, só que agora
        // ajustável sem precisar editar código.
        const DIAS_PARADO = Number(config.whatsapp_dias_parado) || 30;
        const DIAS_INATIVIDADE = Number(config.whatsapp_dias_inatividade) || 60;
        // Quantos dias ANTES do fim do contrato já conta como "vencendo" —
        // igual 0 (ou contrato já vencido de verdade) também entra.
        const DIAS_CONTRATO_VENCENDO = Number(config.whatsapp_dias_contrato_vencendo) || 30;

        const today = startOfDay(nowInSaoPaulo());
        const [vendedores, agendamentos, propostasRaw, funil, campanhas, visitasRaw, contratos] = await Promise.all([
            withCache('vendedores_all_wa', 60, () => getSheetObjects('Vendedores')),
            readAgendamentoRows(RESUMO_USER),
            withCache('propostas_sheet_raw', 60, () => getSheetObjects('Propostas')),
            readFunilRows(RESUMO_USER, 0),
            readCampanhaRows(RESUMO_USER),
            withCache('visitas_sheet_raw', 60, () => getSheetObjects('Visitas')),
            readContratoRows(RESUMO_USER)
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
        // RETOMAR fica de fora de propósito: não é "parado" esquecido, é
        // cliente que perdemos e vamos retomar contato eventualmente — não
        // faz sentido cobrar atualização de algo que está assim por decisão,
        // não por esquecimento (era a maior fonte de ruído: casos reais
        // chegando a 800+ dias "parados" eram todos RETOMAR).
        const funilPorVendedor = {};
        funil.forEach((f) => {
            if (String(f.ativo || '').trim().toLowerCase() !== 'sim') return;
            if (String(f.status || '').trim().toUpperCase() === 'RETOMAR') return;
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
            (campanhasPorVendedor[nome] = campanhasPorVendedor[nome] || []).push({ titulo: c.titulo || 'Campanha', pendentes, link: `${APP_URL}/?c=${c.id}` });
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

        // ── Contratos vencendo (ou já vencidos) ───────────────────────────
        const contratosPorVendedor = {};
        contratos.forEach((c) => {
            if (String(c.ativo || '').trim().toLowerCase() === 'nao') return;
            if (String(c.enviarAviso || '').trim().toLowerCase() === 'nao') return; // opt-out por contrato
            const fim = parseDate(c.fim);
            if (!fim) return;
            const diasRestantes = Math.round((fim.getTime() - today.getTime()) / 86400000);
            if (diasRestantes > DIAS_CONTRATO_VENCENDO) return;
            const nome = String(c.vendedor || '').trim();
            if (!nome) return;
            (contratosPorVendedor[nome] = contratosPorVendedor[nome] || []).push({
                cliente: c.cliente || 'Cliente não informado',
                fim: c.fim,
                diasRestantes
            });
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
                    contratos: contratosPorVendedor[nome] || [],
                    diasSemAtividade: inatividadePorVendedor[nome] || null
                };
            })
            .filter((d) => d.agendamentos.length || d.propostas.length || d.funil.length || d.campanhas.length || d.contratos.length || d.diasSemAtividade);

        // Só quem tem telefone recebe de verdade; quem tem pendência mas
        // não cadastrou WhatsApp aparece à parte (semTelefone) — o painel
        // avisa disso em vez de simplesmente sumir essas pessoas da lista.
        const destinatarios = comPendencia.filter((d) => d.telefone);
        const semTelefone = comPendencia.filter((d) => !d.telefone).map(({ telefone, ...resto }) => resto);

        res.status(200).json({ status: 'success', data: destinatarios, semTelefone, pausado: false, schedule, teste, aprovacaoManual });
    } catch (error) {
        console.error('pendencias-whatsapp:', error);
        res.status(200).json({ status: 'error', message: error.message });
    }
}
