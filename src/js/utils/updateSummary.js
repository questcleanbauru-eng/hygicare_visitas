import { state } from '../app.js';
import { showToast, openExternal } from './dom.js';

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

function groupBy(items, keyFn, fallback) {
    const map = new Map();
    items.forEach((r) => {
        const k = String(keyFn(r) || '').trim() || fallback;
        if (!map.has(k)) map.set(k, []);
        map.get(k).push(r);
    });
    return map;
}

const printItems = (lines, arr) => arr.forEach((r) => lines.push(`• ${r.cliente || 'Cliente'} → ${r.status || '-'}`));

// Vendedor só ganha sub-título dentro do grupo se esse grupo (a gerência,
// ou a lista toda quando não há mais de uma gerência) realmente misturar
// mais de uma pessoa — pra quem só atualiza as próprias, a lista continua
// simples, sem repetir nome à toa.
function printByVendedor(lines, arr) {
    const vendedores = Array.from(new Set(arr.map((r) => (r.vendedor || '').trim()).filter(Boolean)));
    if (vendedores.length <= 1) { printItems(lines, arr); return; }
    const byVendedor = groupBy(arr, (r) => r.vendedor, 'Sem vendedor');
    Array.from(byVendedor.keys()).sort((a, b) => a.localeCompare(b, 'pt-BR')).forEach((v) => {
        lines.push(`_${v}_`);
        printItems(lines, byVendedor.get(v));
    });
}

// Uma seção (Propostas ou Funil) da mensagem — organizada por Gerência e,
// dentro de cada gerência, por Vendedor (o caso do admin/gerente
// acompanhando várias regiões e vendedores de uma vez).
function buildSection(lines, title, icon, items) {
    if (!items || !items.length) return;
    lines.push('', `${icon} *${title}:*`);
    const gerencias = Array.from(new Set(items.map((r) => (r.gerencia || '').trim()).filter(Boolean)));
    if (gerencias.length <= 1) {
        printByVendedor(lines, items);
        return;
    }
    const byGerencia = groupBy(items, (r) => r.gerencia, 'Sem gerência');
    Array.from(byGerencia.keys()).sort((a, b) => a.localeCompare(b, 'pt-BR')).forEach((g) => {
        lines.push(`*${g}*`);
        printByVendedor(lines, byGerencia.get(g));
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

// Tela de revisão antes de mandar: mostra a mensagem (dá pra conferir/editar
// à mão) com botão de Copiar — sem limpar a lista, já que copiar não garante
// que foi enviado — e de WhatsApp, que aí sim limpa (mesmo comportamento de
// sempre: mandou, considera resolvido). onDone roda depois de
// WhatsApp/Fechar, pra quem chamou re-renderizar a tela e sumir com o badge.
export function openSummaryModal(onDone) {
    const message = buildSummaryMessage();
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
        <div class="modal-card" style="max-width:480px">
            <h3 style="margin-top:0">Resumo de atualizações</h3>
            <p class="helper-text" style="text-align:left;margin:0 0 0.6rem">Confira antes de mandar — dá pra editar aqui mesmo.</p>
            <textarea id="summary-preview" rows="12" style="width:100%;font-size:0.85rem;line-height:1.4"></textarea>
            <div style="display:flex;gap:0.5rem;margin-top:0.75rem">
                <button type="button" class="mini-button" id="summary-copy" style="flex:1">📋 Copiar</button>
                <button type="button" class="mini-button mini-button-whatsapp" id="summary-wa" style="flex:1">🟢 WhatsApp</button>
            </div>
            <button type="button" class="secondary-button" id="summary-close" style="width:100%;margin-top:0.6rem">Fechar</button>
        </div>`;
    document.body.appendChild(overlay);
    const textarea = overlay.querySelector('#summary-preview');
    textarea.value = message;

    const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });

    overlay.querySelector('#summary-copy').addEventListener('click', () => {
        navigator.clipboard?.writeText(textarea.value)
            .then(() => showToast('Mensagem copiada.'))
            .catch(() => showToast('Não foi possível copiar.', true));
    });
    overlay.querySelector('#summary-wa').addEventListener('click', () => {
        openExternal(`https://wa.me/?text=${encodeURIComponent(textarea.value)}`);
        clearSummary();
        close();
        if (onDone) onDone();
    });
    overlay.querySelector('#summary-close').addEventListener('click', () => { close(); if (onDone) onDone(); });
}
