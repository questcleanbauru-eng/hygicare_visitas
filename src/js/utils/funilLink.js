import { state } from '../app.js';

// "Cliente já está no Funil?" — usado em Visitas e Propostas pra indicar
// (e reaproveitar) uma oportunidade já existente em vez de deixar criar
// duplicada. Match por cliente + foco/potencial (mesmo campo conceitual:
// "Foco" no Funil, "Potencial do Cliente" na Visita, "Foco" na Proposta).

const _key = (name) => String(name || '').trim().toLowerCase();

// Carrega o Funil uma vez (best-effort) só pra essa checagem — barato de
// propósito (ícone ✅/⚠️ na lista de Visitas/Propostas): usa o que já
// estiver carregado/em cache, sem forçar o histórico completo (com 500+
// oportunidades isso sozinho já deixava a lista lenta pra abrir). Quem
// precisa garantir o histórico INTEIRO (Vincular a uma Proposta/Visita, que
// não pode "não achar" por causa de um recorte) usa fetchTudoFunil/
// fetchTudoVisitas/fetchTudoPropostas sob demanda — ver linkPicker.js.
export async function ensureFunilForDedup() {
    if (Array.isArray(state.funil) && state.funil.length) return;
    try {
        const { getFunil } = await import('../pages/funil.js');
        const r = await getFunil(0);
        if (r && r.status === 'success') state.funil = r.funil || state.funil || [];
    } catch (e) { /* best-effort */ }
}

// Carrega TODO o Funil (não só o que já estiver em cache) — usado pelo botão
// "Carregar histórico completo" dentro do modal de Vincular, quando a busca
// rápida (ensureFunilForDedup, acima) não acha o que o usuário procura.
export async function fetchTudoFunil() {
    try {
        const { getFunil } = await import('../pages/funil.js');
        const r = await getFunil(0);
        if (r && r.status === 'success') { state.funil = r.funil || state.funil || []; return true; }
    } catch (e) { /* best-effort */ }
    return false;
}

export function funilItemFor(cliente, foco) {
    const kc = _key(cliente);
    if (!kc) return null;
    const kf = _key(foco);
    return (state.funil || []).find((f) =>
        _key(f.cliente || f.Cliente) === kc && _key(f.foco || f.Foco) === kf) || null;
}

// Funil "em alerta" (Perdido ou Retomar) → indicador em vermelho.
export function funilEmAlerta(item) {
    return /PERDID|RETOMAR/i.test(String((item && (item.status || item.Status)) || ''));
}

// Reverso: "essa oportunidade do Funil já tem Proposta?" — mesmo critério
// de match (cliente + foco), usado no Funil pra indicar visualmente quando
// já existe uma proposta em andamento pra aquele cliente/foco. Mesmo
// raciocínio "barato de propósito" de ensureFunilForDedup acima.
export async function ensurePropostasForDedup() {
    if (Array.isArray(state.proposals) && state.proposals.length) return;
    try {
        const { getProposals } = await import('../pages/proposals.js');
        const r = await getProposals(0);
        if (r && r.status === 'success') state.proposals = r.proposals || state.proposals || [];
    } catch (e) { /* best-effort */ }
}

// Carrega TODAS as Propostas — ver fetchTudoFunil acima.
export async function fetchTudoPropostas() {
    try {
        const { getProposals } = await import('../pages/proposals.js');
        const r = await getProposals(0);
        if (r && r.status === 'success') { state.proposals = r.proposals || state.proposals || []; return true; }
    } catch (e) { /* best-effort */ }
    return false;
}

export function propostaItemFor(cliente, foco) {
    const kc = _key(cliente);
    if (!kc) return null;
    const kf = _key(foco);
    return (state.proposals || []).find((p) =>
        _key(p.cliente || p.Cliente) === kc && _key(p.foco || p.Foco) === kf) || null;
}

// Proposta "em alerta" (Perdido) → indicador em vermelho.
export function propostaEmAlerta(item) {
    return /PERDID/i.test(String((item && (item.status || item.Status)) || ''));
}

// Mesma ideia de ensurePropostasForDedup, pro Funil poder vincular/listar
// Visitas (ver handleLinkVisitaFunil, lib/handlers/visits.js) sem depender
// de já ter passado pela tela de Visitas antes. Barato de propósito — com
// dezenas de milhares de visitas no total, forçar o histórico completo aqui
// (usado toda hora só pro ícone ✅/⚠️) deixava a lista lenta pra abrir.
export async function ensureVisitsForDedup() {
    if (Array.isArray(state.visits) && state.visits.length) return;
    try {
        const { getVisits } = await import('../pages/visits.js');
        const r = await getVisits(0);
        if (r && r.status === 'success') state.visits = r.visits || state.visits || [];
    } catch (e) { /* best-effort */ }
}

// Carrega TODAS as Visitas — ver fetchTudoFunil acima. É o que o botão
// "Carregar histórico completo" do modal de Vincular chama quando a busca
// rápida (ensureVisitsForDedup, acima, ou o que já estava em cache) não
// encontra a visita — o padrão já vem rápido (só o que já estiver
// carregado), e o histórico completo (pode ser lento com volume grande) só
// é buscado quando o usuário pede.
export async function fetchTudoVisitas() {
    try {
        const { getVisits } = await import('../pages/visits.js');
        const r = await getVisits(0);
        if (r && r.status === 'success') { state.visits = r.visits || state.visits || []; return true; }
    } catch (e) { /* best-effort */ }
    return false;
}
