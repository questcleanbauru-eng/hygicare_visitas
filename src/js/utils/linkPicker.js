import { escapeHtml, calculateDaysFromDisplayDate } from './format.js';

// Modal de "Vincular a uma Proposta/Funil" — busca com agrupamento (mesmo
// nome do cliente atual primeiro), destaque do termo buscado, avatar com
// iniciais e confirmação em duas etapas (selecionar → confirmar), em vez
// de vincular no primeiro clique. Compartilhado entre funil.js e
// proposals.js pra não deixar as duas implementações divergirem — a
// especificação visual é bem detalhada (cores, espaçamento, estrutura),
// então vale a pena manter uma fonte só.

function initials(name) {
    const words = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!words.length) return '?';
    if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
    return (words[0][0] + words[1][0]).toUpperCase();
}

function relativeLabel(displayDate) {
    if (!displayDate) return '';
    const dias = calculateDaysFromDisplayDate(displayDate);
    if (!dias || dias < 0) return dias === 0 ? 'hoje' : '';
    if (dias < 30) return dias <= 1 ? 'há 1 dia' : `há ${dias} dias`;
    const meses = Math.round(dias / 30);
    if (meses < 12) return meses <= 1 ? 'há 1 mês' : `há ${meses} meses`;
    const anos = Math.round(meses / 12);
    return anos <= 1 ? 'há 1 ano' : `há ${anos} anos`;
}

function highlight(text, query) {
    const safe = escapeHtml(text || '');
    const q = String(query || '').trim();
    if (!q) return safe;
    const idx = safe.toLowerCase().indexOf(escapeHtml(q).toLowerCase());
    if (idx === -1) return safe;
    return safe.slice(0, idx) + '<mark class="lkp-mark">' + safe.slice(idx, idx + q.length) + '</mark>' + safe.slice(idx + q.length);
}

/**
 * config: {
 *   eyebrow: string,               // "Proposta · SANTA CASA DE ITAPOLIS"
 *   title: string,                 // "Vincular a uma proposta"
 *   contextText: string,           // "Vinculando à proposta de ... · 14/09/2026 · Paulo Sergio · Potirendaba"
 *   searchPlaceholder: string,
 *   confirmLabel: string,          // "Vincular proposta selecionada"
 *   emptyNoun: string,             // "proposta" / "oportunidade do Funil"
 *   currentCliente: string,        // pro agrupamento "mesmo nome" antes de digitar
 *   items: [{ id, cliente, tag, cidade, data }],
 *   onConfirm: (id) => void
 * }
 */
export function openLinkPickerModal(config) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
        <div class="lkp-modal" role="dialog" aria-modal="true">
            <button type="button" class="lkp-close" id="lkp-close" aria-label="Fechar">✕</button>
            <p class="lkp-eyebrow">${escapeHtml(config.eyebrow || '')}</p>
            <h3 class="lkp-title">${escapeHtml(config.title || '')}</h3>
            <div class="lkp-context">
                <span class="lkp-context-icon">✓</span>
                <span>${escapeHtml(config.contextText || '')}</span>
            </div>
            <div class="lkp-search-wrap">
                <span class="lkp-search-icon">🔍</span>
                <input type="text" class="lkp-search-input" id="lkp-search" placeholder="${escapeHtml(config.searchPlaceholder || 'Buscar...')}" autocomplete="off">
            </div>
            <div class="lkp-meta-row">
                <span id="lkp-count"></span>
                <button type="button" class="lkp-sort-btn" id="lkp-sort">Ordenar: mais recentes</button>
            </div>
            <div class="lkp-results" id="lkp-results"></div>
            <div class="lkp-footer">
                <button type="button" class="secondary-button" id="lkp-cancel">Cancelar</button>
                <button type="button" class="primary-button" id="lkp-confirm" disabled>${escapeHtml(config.confirmLabel || 'Vincular')}</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
    overlay.querySelector('#lkp-close').addEventListener('click', close);
    overlay.querySelector('#lkp-cancel').addEventListener('click', close);

    const searchInput = overlay.querySelector('#lkp-search');
    const resultsEl = overlay.querySelector('#lkp-results');
    const countEl = overlay.querySelector('#lkp-count');
    const sortBtn = overlay.querySelector('#lkp-sort');
    const confirmBtn = overlay.querySelector('#lkp-confirm');

    let selectedId = null;
    let sortMode = 'recentes'; // 'recentes' | 'az'
    const currentClienteKey = String(config.currentCliente || '').trim().toLowerCase();

    const dataMs = (it) => {
        const dias = calculateDaysFromDisplayDate(it.data);
        return dias ? -dias : 0; // menor "dias atrás" = mais recente
    };

    function render() {
        const q = searchInput.value.trim().toLowerCase();
        let filtered = (config.items || []).filter((it) => {
            if (!q) return true;
            return [it.cliente, it.tag, it.cidade].some((v) => String(v || '').toLowerCase().includes(q));
        });

        filtered = filtered.slice().sort((a, b) => sortMode === 'az'
            ? String(a.cliente || '').localeCompare(String(b.cliente || ''))
            : dataMs(b) - dataMs(a));

        countEl.innerHTML = `<strong>${filtered.length}</strong> ${filtered.length === 1 ? config.emptyNoun + ' encontrada' : config.emptyNoun + 's encontradas'}`;

        if (!filtered.length) {
            resultsEl.innerHTML = `
                <div class="lkp-empty">
                    <span class="lkp-empty-icon">🔎</span>
                    <p>Nenhuma ${escapeHtml(config.emptyNoun)} encontrada${q ? ` para "${escapeHtml(searchInput.value.trim())}"` : ''}.</p>
                    <p class="lkp-empty-hint">Tente buscar por outro nome ou cidade.</p>
                </div>`;
            confirmBtn.disabled = true;
            return;
        }

        // Agrupa: mesmo nome do cliente atual (ou do termo buscado, se já
        // digitou algo) primeiro, o resto depois — ajuda a achar rápido
        // quando é só uma questão de grafia diferente.
        const sameNameKey = q || currentClienteKey;
        const mesmoNome = [];
        const outros = [];
        filtered.forEach((it) => {
            const k = String(it.cliente || '').trim().toLowerCase();
            if (sameNameKey && (k === sameNameKey || k.includes(sameNameKey))) mesmoNome.push(it);
            else outros.push(it);
        });

        const itemHtml = (it) => {
            const rel = relativeLabel(it.data);
            return `
            <button type="button" class="lkp-item${String(it.id) === String(selectedId) ? ' is-selected' : ''}" data-id="${escapeHtml(String(it.id))}" ${it.hint ? `title="${escapeHtml(it.hint)}"` : ''}>
                <span class="lkp-avatar">${escapeHtml(initials(it.cliente))}</span>
                <span class="lkp-item-body">
                    <span class="lkp-item-name">${highlight(it.cliente || 'Cliente', searchInput.value.trim())}</span>
                    <span class="lkp-item-meta">${[it.tag ? `🏷 ${escapeHtml(it.tag)}` : '', it.cidade ? `📍 ${escapeHtml(it.cidade)}` : ''].filter(Boolean).join(' &nbsp; ')}</span>
                </span>
                <span class="lkp-item-date">
                    <span>${escapeHtml(it.data || '-')}</span>
                    ${rel ? `<span class="lkp-item-rel">${escapeHtml(rel)}</span>` : ''}
                </span>
            </button>`;
        };

        resultsEl.innerHTML = [
            mesmoNome.length ? `<p class="lkp-group-label">CLIENTE COM O MESMO NOME</p>${mesmoNome.map(itemHtml).join('')}` : '',
            outros.length ? `<p class="lkp-group-label">${mesmoNome.length ? 'OUTROS CLIENTES' : 'RESULTADOS'}</p>${outros.map(itemHtml).join('')}` : ''
        ].join('');

        resultsEl.querySelectorAll('.lkp-item').forEach((btn) => {
            btn.addEventListener('click', () => {
                selectedId = btn.dataset.id;
                resultsEl.querySelectorAll('.lkp-item').forEach((x) => x.classList.toggle('is-selected', x === btn));
                confirmBtn.disabled = false;
            });
        });
        confirmBtn.disabled = !filtered.some((it) => String(it.id) === String(selectedId));
    }

    searchInput.addEventListener('input', render);
    sortBtn.addEventListener('click', () => {
        sortMode = sortMode === 'recentes' ? 'az' : 'recentes';
        sortBtn.textContent = sortMode === 'recentes' ? 'Ordenar: mais recentes' : 'Ordenar: A-Z';
        render();
    });
    confirmBtn.addEventListener('click', () => {
        if (!selectedId) return;
        close();
        config.onConfirm(selectedId);
    });

    render();
    setTimeout(() => searchInput.focus(), 30);
}
