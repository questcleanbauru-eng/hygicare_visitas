import { state } from '../app.js';

// Registra atualizacoes de proposta/funil pra gerar um resumo unico pra
// compartilhar de uma vez, em vez de interromper o usuario a cada atualizacao
// (como o compartilhamento obrigatorio ja faz nas Visitas).

function storageKey() {
    return 'apv_update_summary_' + (state.currentUser && state.currentUser.email || '');
}

function load() {
    try {
        const raw = JSON.parse(localStorage.getItem(storageKey()) || 'null');
        return raw && raw.proposals && raw.funil ? raw : { proposals: [], funil: [] };
    } catch (e) {
        return { proposals: [], funil: [] };
    }
}

function save(data) {
    try { localStorage.setItem(storageKey(), JSON.stringify(data)); } catch (e) {}
}

export function trackUpdate(entity, record) {
    const data = load();
    data[entity] = (data[entity] || []).filter((r) => String(r.id) !== String(record.id));
    data[entity].push({ ...record, at: Date.now() });
    save(data);
}

export function getSummaryCount() {
    const data = load();
    return (data.proposals || []).length + (data.funil || []).length;
}

export function buildSummaryMessage() {
    const data = load();
    const lines = ['*Resumo de atualizações*'];
    if (data.proposals && data.proposals.length) {
        lines.push('', '📄 *Propostas:*');
        data.proposals.forEach((p) => lines.push(`• ${p.cliente || 'Cliente'} → ${p.status || '-'}`));
    }
    if (data.funil && data.funil.length) {
        lines.push('', '📊 *Funil:*');
        data.funil.forEach((f) => lines.push(`• ${f.cliente || 'Cliente'} → ${f.status || '-'}`));
    }
    return lines.join('\n');
}

export function clearSummary() {
    save({ proposals: [], funil: [] });
}

export function shareSummaryAndClear() {
    const message = buildSummaryMessage();
    const url = `https://wa.me/?text=${encodeURIComponent(message)}`;
    const a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    clearSummary();
}
