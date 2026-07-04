import { state, addDocumentClickListener } from '../app.js';
import { escapeHtml, parseDisplayDate } from './format.js';

export function showLoginNotification(prevDate) {
    const newVisits = (state.visits || []).filter((v) => {
        const d = parseDisplayDate(v.dataVisita);
        return d && d > prevDate;
    }).length;
    const newProposals = (state.proposals || []).filter((p) => {
        const d = parseDisplayDate(p.data);
        return d && d > prevDate;
    }).length;
    const newFunil = (state.funil || []).filter((f) => {
        const d = parseDisplayDate(f.data);
        return d && d > prevDate;
    }).length;

    if (newVisits + newProposals + newFunil === 0) return;

    const parts = [];
    if (newVisits > 0) parts.push(`${newVisits} nova${newVisits !== 1 ? 's' : ''} visita${newVisits !== 1 ? 's' : ''}`);
    if (newProposals > 0) parts.push(`${newProposals} nova${newProposals !== 1 ? 's' : ''} proposta${newProposals !== 1 ? 's' : ''}`);
    if (newFunil > 0) parts.push(`${newFunil} nova${newFunil !== 1 ? 's' : ''} oportunidade${newFunil !== 1 ? 's' : ''}`);

    document.querySelector('.login-notif-banner')?.remove();

    const banner = document.createElement('div');
    banner.className = 'login-notif-banner';
    banner.innerHTML = `
        <span style="font-size:1.1rem">🔔</span>
        <div style="flex:1;min-width:0">
            <strong>Desde seu último acesso</strong><br>
            <span>${escapeHtml(parts.join(', '))}</span>
        </div>
        <button type="button" class="login-notif-close" onclick="this.closest('.login-notif-banner').remove()">✕</button>
    `;

    const mainContent = document.getElementById('main-content');
    if (mainContent) { mainContent.insertBefore(banner, mainContent.firstChild); }
}


export function debounce(fn, ms) {
    var t;
    return function() {
        var args = arguments;
        clearTimeout(t);
        t = setTimeout(function() { fn.apply(null, args); }, ms);
    };
}


export function renderSimpleOptions(values, selectedValue) {
    const items = Array.isArray(values) ? values : [];
    return ['<option value="">Selecione</option>'].concat(
        items.map((value) => `<option value="${escapeHtml(value)}" ${value === selectedValue ? 'selected' : ''}>${escapeHtml(value)}</option>`)
    ).join('');
}


export function rebuildFilterOptions(selector, values) {
    const sel = document.querySelector(selector);
    if (!sel) return;
    const current = sel.value;
    sel.innerHTML = `<option value="">Todos</option>` +
        (Array.isArray(values) ? values : []).map((v) =>
            `<option value="${escapeHtml(v)}"${v === current ? ' selected' : ''}>${escapeHtml(v)}</option>`
        ).join('');
}


export function initializeSearchableInput({ input, menu, items = [], onSelect = null, multiSelect = false, maxSelections = 1, selectedItems = [], selectedContainer = null, selectionLabel = 'item', onSelectionChange = null }) {
    if (!input || !menu) {
        return;
    }

    const normalizedItems = Array.from(new Set((Array.isArray(items) ? items : []).filter(Boolean)));
    const selectedValues = Array.isArray(selectedItems) ? selectedItems : [];

    const renderSelectedItems = () => {
        if (!selectedContainer) {
            return;
        }

        if (selectedValues.length === 0) {
            selectedContainer.innerHTML = '';
            return;
        }

        selectedContainer.innerHTML = selectedValues.map((item) => `
            <button type="button" class="selected-type-chip" data-remove-value="${escapeHtml(item)}">
                <span>${escapeHtml(item)}</span>
                <span aria-hidden="true">x</span>
            </button>
        `).join('');

        selectedContainer.querySelectorAll('[data-remove-value]').forEach((button) => {
            button.addEventListener('click', () => {
                const valueToRemove = button.dataset.removeValue || '';
                const index = selectedValues.indexOf(valueToRemove);
                if (index >= 0) {
                    selectedValues.splice(index, 1);
                }
                renderSelectedItems();
                if (onSelectionChange) {
                    onSelectionChange(selectedValues.slice());
                }
                input.focus();
            });
        });
    };

    const closeMenu = () => {
        menu.innerHTML = '';
        menu.classList.remove('visible');
    };

    const openMenu = (query = '') => {
        const normalizedQuery = String(query || '').trim().toLowerCase();
        const filteredItems = normalizedQuery
            ? normalizedItems.filter((item) => String(item).toLowerCase().includes(normalizedQuery))
            : normalizedItems;

        if (filteredItems.length === 0) {
            closeMenu();
            return;
        }

        menu.innerHTML = filteredItems.slice(0, 150).map((item) => `
            <button type="button" class="searchable-select-option" data-value="${escapeHtml(item)}">${escapeHtml(item)}</button>
        `).join('');
        menu.classList.add('visible');

        menu.querySelectorAll('[data-value]').forEach((button) => {
            button.addEventListener('click', () => {
                const selectedValue = button.dataset.value || '';
                if (multiSelect) {
                    if (selectedValues.includes(selectedValue)) {
                        closeMenu();
                        input.value = '';
                        return;
                    }
                    if (selectedValues.length >= maxSelections) {
                        showToast(`Voce pode selecionar ate ${maxSelections} ${selectionLabel === 'tipo' ? 'tipos' : 'itens'}.`, true);
                        closeMenu();
                        return;
                    }
                    selectedValues.push(selectedValue);
                    input.value = '';
                    renderSelectedItems();
                    if (onSelectionChange) {
                        onSelectionChange(selectedValues.slice());
                    }
                } else {
                    input.value = selectedValue;
                    if (onSelect) {
                        onSelect(input.value);
                    }
                    if (onSelectionChange) {
                        onSelectionChange([selectedValue]);
                    }
                }
                closeMenu();
                input.dispatchEvent(new Event('change', { bubbles: true }));
            });
        });
    };

    input.addEventListener('focus', () => openMenu(input.value));
    input.addEventListener('input', () => openMenu(input.value));
    input.addEventListener('blur', () => {
        setTimeout(closeMenu, 120);
    });

    addDocumentClickListener((event) => {
        if (!menu.contains(event.target) && event.target !== input) {
            closeMenu();
        }
    });

    renderSelectedItems();
}


export function renderDetailRow(label, value) {
    return `
        <div class="detail-row">
            <span class="detail-label">${escapeHtml(label)}</span>
            <strong class="detail-value">${escapeHtml(value || '-')}</strong>
        </div>
    `;
}


export function openExternal(url) {
    const a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
}


export function showSuccessPopup(message) {
    let overlay = document.getElementById('success-popup-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'success-popup-overlay';
        document.body.appendChild(overlay);
    }
    overlay.innerHTML = `
        <div class="success-popup">
            <div class="success-popup-icon">✓</div>
            <p class="success-popup-msg">${escapeHtml(message)}</p>
            <button type="button" class="success-popup-close">OK</button>
        </div>`;
    overlay.classList.add('visible');
    const close = () => overlay.classList.remove('visible');
    overlay.querySelector('.success-popup-close').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) { close(); } });
    setTimeout(close, 4000);
}


export function showRefreshIndicator() {
    let el = document.getElementById('refresh-indicator');
    if (!el) {
        el = document.createElement('div');
        el.id = 'refresh-indicator';
        el.className = 'refresh-indicator';
        const app = document.getElementById('app');
        const main = document.getElementById('main-content');
        if (app && main) { app.insertBefore(el, main); }
    }
    el.classList.add('visible');
}


export function hideRefreshIndicator() {
    const el = document.getElementById('refresh-indicator');
    if (el) { el.classList.remove('visible'); }
}


export function showToast(message, isError = false, undoFn = null) {
    let toast = document.getElementById('app-toast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'app-toast';
        toast.className = 'toast';
        document.body.appendChild(toast);
    }
    if (undoFn) {
        toast.innerHTML = `<span>${escapeHtml(message)}</span><button class="toast-undo-btn" type="button">Desfazer</button>`;
        toast.querySelector('.toast-undo-btn').addEventListener('click', () => {
            clearTimeout(state.toastTimer);
            toast.classList.remove('visible');
            undoFn();
        });
    } else {
        toast.textContent = message;
    }
    toast.className = `toast ${isError ? 'toast-error' : 'toast-success'} visible`;
    if (state.toastTimer) { clearTimeout(state.toastTimer); }
    state.toastTimer = setTimeout(() => { toast.classList.remove('visible'); }, 4500);
}


export function addFabAndScrollTop(fabLabel, fabAction) {
    // Remove previous FAB/scroll if any
    document.getElementById('page-fab')?.remove();
    document.getElementById('page-scroll-top')?.remove();

    const fab = document.createElement('button');
    fab.id = 'page-fab';
    fab.className = 'fab';
    fab.setAttribute('type', 'button');
    fab.setAttribute('aria-label', fabLabel);
    fab.textContent = '+';
    fab.addEventListener('click', fabAction);
    document.getElementById('app').appendChild(fab);

    const scrollBtn = document.createElement('button');
    scrollBtn.id = 'page-scroll-top';
    scrollBtn.className = 'scroll-top-btn';
    scrollBtn.setAttribute('type', 'button');
    scrollBtn.setAttribute('aria-label', 'Voltar ao topo');
    scrollBtn.textContent = '↑';
    scrollBtn.addEventListener('click', () => {
        document.getElementById('main-content').scrollTo({ top: 0, behavior: 'smooth' });
    });
    document.getElementById('app').appendChild(scrollBtn);

    const main = document.getElementById('main-content');
    const onScroll = () => {
        scrollBtn.classList.toggle('visible', main.scrollTop > 200);
    };
    main.addEventListener('scroll', onScroll, { passive: true });
}

// ── Session expiry ──────────────────────────────────────────────

export function downloadCSV(data, filename, columns) {
    const header = columns.map(c => `"${c.label}"`).join(',');
    const rows = (data || []).map(row =>
        columns.map(c => `"${String(row[c.key] || '').replace(/"/g, '""')}"`).join(',')
    );
    const blob = new Blob(['﻿' + [header, ...rows].join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

// ── Field validation helpers ─────────────────────────────────────

export function showFieldError(el, msg) {
    const group = el.closest('.form-group');
    if (!group) return;
    group.classList.add('has-error');
    group.classList.remove('is-valid');
    let errEl = group.querySelector('.field-error-msg');
    if (!errEl) {
        errEl = document.createElement('span');
        errEl.className = 'field-error-msg';
        group.appendChild(errEl);
    }
    errEl.textContent = msg;
}


export function clearFieldError(el) {
    const group = el.closest('.form-group');
    if (!group) return;
    group.classList.remove('has-error');
}

// ── Breadcrumb ───────────────────────────────────────────────────

export function skeletonLine(width = '60%', height = '0.85rem') {
    return `<div class="skel-line" style="width:${width};height:${height}"></div>`;
}


export function skeletonCard(lines = [['70%'], ['45%', '0.7rem']]) {
    return `<div class="skel-card">${lines.map(([w, h]) => skeletonLine(w, h || '0.82rem')).join('')}</div>`;
}


export function skeletonDashboard() {
    return `
        <div style="display:flex;flex-direction:column;gap:0.8rem">
            <div class="skel-welcome"></div>
            <div class="skel-grid">
                ${Array.from({length: 4}, () => `<div class="skel-stat"></div>`).join('')}
            </div>
            <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:0.55rem">
                ${Array.from({length: 3}, () => `<div class="skel-stat" style="height:68px"></div>`).join('')}
            </div>
            ${skeletonCard([['55%', '1rem'], ['80%', '0.7rem'], ['60%', '0.7rem']])}
            ${skeletonCard([['55%', '1rem'], ['80%', '0.7rem'], ['60%', '0.7rem']])}
        </div>
    `;
}


export function skeletonList(count = 6) {
    return `<div class="skel-list">${Array.from({length: count}, (_, i) =>
        skeletonCard([['65%'], [i % 2 === 0 ? '40%' : '55%', '0.7rem']])
    ).join('')}</div>`;
}


export function loadingState(icon, message) {
    return `
        <div class="contextual-loading">
            <div class="contextual-loading-icon">${icon}</div>
            <div class="contextual-loading-spinner"></div>
            <p class="contextual-loading-msg">${message}</p>
        </div>
    `;
}


export function skeletonDetail(rows = 10) {
    const wLabel = [32, 45, 28, 55, 38, 42, 30, 50, 36, 48];
    const wValue = [55, 70, 60, 45, 80, 65, 75, 50, 68, 58];
    return `
        <div class="page-header compact-header" style="gap:0">
            <div class="skel-line" style="width:56px;height:1.5rem;border-radius:8px"></div>
            <div class="skel-line" style="width:160px;height:1rem;border-radius:6px"></div>
            <div style="width:56px"></div>
        </div>
        <div class="card detail-card">
            ${Array.from({length: rows}, (_, i) => `
                <div class="detail-row">
                    <div class="skel-line" style="width:${wLabel[i % wLabel.length]}%;height:0.72rem"></div>
                    <div class="skel-line" style="width:${wValue[i % wValue.length]}%;height:0.88rem"></div>
                </div>
            `).join('')}
        </div>
    `;
}
