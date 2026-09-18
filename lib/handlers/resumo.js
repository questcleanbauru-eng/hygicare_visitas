import { getSheetObjects, withCache } from '../sheets.js';
import { verifyUser, formatDate, parseDate } from '../common.js';
import { readAgendamentoRows } from './agendamentos.js';
import { readCampanhaRows } from './campanhas.js';
import { readManutencaoRows } from './manutencao.js';
import { readRows as readRelatorioTecnicoRows } from './relatorioTecnico.js';

// Objeto "usuário" sintético só pra reaproveitar os mesmos leitores de linha
// que o resto do app já usa (readAgendamentoRows/readCampanhaRows/
// readManutencaoRows/readRelatorioTecnicoRows) — perfil admin faz cada um
// deles devolver tudo sem filtro, que é exatamente o que o resumo precisa
// (visão do dia inteiro, não de um vendedor só).
const RESUMO_USER = { profile: 'admin', name: '', email: '', gerencia: '' };

function isSameDay(a, b) {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function startOfDay(d) {
    const c = new Date(d);
    c.setHours(0, 0, 0, 0);
    return c;
}

// Resumo sempre cobre o dia anterior ao informado (ou a ontem, se nenhuma
// data for passada) — "o que aconteceu" é sempre sobre um dia já fechado.
export async function computeResumoDiario(referenceDate = null) {
    const today = startOfDay(referenceDate || new Date());
    const target = new Date(today);
    target.setDate(target.getDate() - 1);
    const targetLabel = formatDate(target);
    const proximosLimite = new Date(today);
    proximosLimite.setDate(proximosLimite.getDate() + 7);

    // ── Visitas registradas no dia-alvo ──────────────────────────────────
    const rawVisits = await withCache('visitas_sheet_raw', 60, () => getSheetObjects('Visitas'));
    const visitasOntem = rawVisits.filter((v) => {
        const d = parseDate(v['Data da Visita']);
        return d && isSameDay(d, target);
    });
    const porVendedorMap = {};
    visitasOntem.forEach((v) => {
        const nome = String(v['Vendedor/Gerente'] || '').trim() || 'Sem vendedor';
        porVendedorMap[nome] = (porVendedorMap[nome] || 0) + 1;
    });
    const porVendedor = Object.entries(porVendedorMap)
        .map(([nome, total]) => ({ nome, total }))
        .sort((a, b) => b.total - a.total);

    // ── Agendamentos: vencidos (pendentes com data já passada) e próximos
    //    7 dias (pendentes com data entre hoje e o limite) ─────────────────
    const agendamentos = await readAgendamentoRows(RESUMO_USER);
    const pendentesAg = agendamentos.filter((a) => a.status === 'Pendente');
    const vencidos = pendentesAg.filter((a) => {
        const d = parseDate(a.dataAgendada);
        return d && d < today;
    }).sort((a, b) => (parseDate(a.dataAgendada)?.getTime() || 0) - (parseDate(b.dataAgendada)?.getTime() || 0));
    const proximos = pendentesAg.filter((a) => {
        const d = parseDate(a.dataAgendada);
        return d && d >= today && d <= proximosLimite;
    }).sort((a, b) => (parseDate(a.dataAgendada)?.getTime() || 0) - (parseDate(b.dataAgendada)?.getTime() || 0));

    // ── Relatórios criados no dia-alvo (Manutenção: Aferição/Geral + SPSP) ─
    const manutencoes = await readManutencaoRows(RESUMO_USER);
    const manutencoesOntem = manutencoes.filter((m) => {
        const d = parseDate(m.data);
        return d && isSameDay(d, target);
    });
    const aferição = manutencoesOntem.filter((m) => m.tipoRelatorio !== 'geral').length;
    const geral = manutencoesOntem.filter((m) => m.tipoRelatorio === 'geral').length;

    const relatoriosTecnicos = await readRelatorioTecnicoRows(RESUMO_USER);
    const spsp = relatoriosTecnicos.filter((r) => {
        const d = parseDate(r.data);
        return d && isSameDay(d, target);
    }).length;

    // ── Campanhas: itens respondidos no dia-alvo + total ainda pendente ──
    const campanhas = await readCampanhaRows(RESUMO_USER);
    let respondidasOntem = 0;
    let pendentesTotal = 0;
    let maisAntiga = null;
    campanhas.forEach((c) => {
        c.itens.forEach((it) => {
            if (it.respondidoEm) {
                const d = parseDate(it.respondidoEm);
                if (d && isSameDay(d, target)) respondidasOntem++;
            } else if (c.status !== 'concluida') {
                pendentesTotal++;
            }
        });
        if (c.status !== 'concluida' && c.itens.some((it) => !it.respondidoEm)) {
            const criada = parseDate(c.criadaEm);
            if (criada && (!maisAntiga || criada < maisAntiga.data)) {
                maisAntiga = { titulo: c.titulo, data: criada };
            }
        }
    });

    return {
        dataResumo: targetLabel,
        visitas: { total: visitasOntem.length, porVendedor },
        agendamentos: {
            vencidosTotal: vencidos.length,
            vencidos: vencidos.slice(0, 8).map((a) => ({ cliente: a.cliente, dataAgendada: a.dataAgendada })),
            proximosTotal: proximos.length
        },
        relatorios: { total: manutencoesOntem.length + spsp, aferição, geral, spsp },
        campanhas: {
            respondidasOntem,
            pendentesTotal,
            maisAntigaTitulo: maisAntiga ? maisAntiga.titulo : '',
            maisAntigaDias: maisAntiga ? Math.round((today.getTime() - maisAntiga.data.getTime()) / 86400000) : 0
        }
    };
}

// Pra ver o resumo dentro do app (card do Início) — admin só, mesmo escopo
// do e-mail. Cache curto: a tela pode ser aberta várias vezes no mesmo
// dia sem reler as 5 abas toda hora.
export async function handleGetResumoDiario(payload) {
    const user = await verifyUser(payload.user);
    if (String(user.profile || '').trim().toLowerCase() !== 'admin') {
        throw new Error('Resumo diário disponível só para administradores por enquanto.');
    }
    const resumo = await withCache('resumo_diario', 300, () => computeResumoDiario());
    return { status: 'success', resumo };
}
