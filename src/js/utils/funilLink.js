import { state } from '../app.js';

// "Cliente já está no Funil?" — usado em Visitas e Propostas pra indicar
// (e reaproveitar) uma oportunidade já existente em vez de deixar criar
// duplicada. Match por cliente + foco/potencial (mesmo campo conceitual:
// "Foco" no Funil, "Potencial do Cliente" na Visita, "Foco" na Proposta).

const _key = (name) => String(name || '').trim().toLowerCase();

// Carrega o Funil uma vez (best-effort) só pra essa checagem. Se falhar,
// quem chamou segue funcionando como se não houvesse match.
export async function ensureFunilForDedup() {
    if (Array.isArray(state.funil) && state.funil.length) return;
    try {
        const { getFunil } = await import('../pages/funil.js');
        const r = await getFunil(0);
        if (r && r.status === 'success') state.funil = r.funil || state.funil || [];
    } catch (e) { /* best-effort */ }
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
// já existe uma proposta em andamento pra aquele cliente/foco.
export async function ensurePropostasForDedup() {
    if (Array.isArray(state.proposals) && state.proposals.length) return;
    try {
        const { getProposals } = await import('../pages/proposals.js');
        const r = await getProposals(0);
        if (r && r.status === 'success') state.proposals = r.proposals || state.proposals || [];
    } catch (e) { /* best-effort */ }
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
