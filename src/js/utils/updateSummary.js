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

// Uma seção (Propostas ou Funil) da mensagem — se tiver mais de um
// vendedor misturado na lista (comum pro admin/gerente, que atualiza em
// nome de vários), agrupa com um sub-título por vendedor; se for tudo de
// uma pessoa só (o caso mais comum: o próprio vendedor compartilhando o
// que ele mexeu), a lista continua simples, sem repetir o nome à toa.
function buildSection(lines, title, icon, items) {
    if (!items || !items.length) return;
    lines.push('', `${icon} *${title}:*`);
    const vendedores = Array.from(new Set(items.map((r) => (r.vendedor || '').trim()).filter(Boolean)));
    if (vendedores.length <= 1) {
        items.forEach((r) => lines.push(`• ${r.cliente || 'Cliente'} → ${r.status || '-'}`));
        return;
    }
    const byVendedor = new Map();
    items.forEach((r) => {
        const v = (r.vendedor || '').trim() || 'Sem vendedor';
        if (!byVendedor.has(v)) byVendedor.set(v, []);
        byVendedor.get(v).push(r);
    });
    Array.from(byVendedor.keys()).sort((a, b) => a.localeCompare(b, 'pt-BR')).forEach((v) => {
        lines.push(`_${v}_`);
        byVendedor.get(v).forEach((r) => lines.push(`• ${r.cliente || 'Cliente'} → ${r.status || '-'}`));
    });
}

export function buildSummaryMessage() {
    const data = load();
    const lines = ['*Resumo de atualizações*'];
    buildSection(lines, 'Propostas', '📄', data.proposals);
    buildSection(lines, 'Funil', '📊', data.funil);
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
