import { state, navigateTo } from '../app.js';
import { escapeHtml, normalizeVisit, normalizeProposal } from './format.js';
import { debounce, showToast } from './dom.js';
import { ensureFormData, logout } from '../api.js';

export let _installPrompt = null;

export let _navBuilt = false;

export let _headerBuilt = false;

export function resetNavCache() {
    _navBuilt = false;
    _headerBuilt = false;
}

const _loadedStyles = new Set();

export function ensureStyles(name) {
    if (_loadedStyles.has(name)) return;
    _loadedStyles.add(name);
    const manifest = (typeof window !== 'undefined' && window.__ASSET_MANIFEST__) || {};
    const href = manifest['css/' + name] || `./${name}.css`;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    document.head.appendChild(link);
}

window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    _installPrompt = e;
    const btn = document.getElementById('header-install-btn');
    if (btn) btn.style.display = '';
});


export function renderNavigation() {
    const bottomNav = document.getElementById('bottom-nav');
    if (!bottomNav) return;
    const isDesktop = window.innerWidth >= 1024;

    if (_navBuilt) {
        bottomNav.querySelectorAll('.nav-btn[data-page]').forEach(btn => {
            btn.classList.toggle('active', isNavActive(btn.dataset.page));
        });
        return;
    }
    _navBuilt = true;

    // Ícones em SVG (não emoji) para renderizar igual em qualquer SO/navegador.
    const NAV_ICON_SVG = {
        dashboard: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9.5"/></svg>',
        visits: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="1"/><line x1="9" y1="12" x2="15" y2="12"/><line x1="9" y1="16" x2="15" y2="16"/></svg>',
        calendar: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>',
        proposals: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
        funil: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="20" x2="6" y2="16"/><line x1="12" y1="20" x2="12" y2="10"/><line x1="18" y1="20" x2="18" y2="4"/></svg>',
        admin: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>'
    };

    // Desktop sidebar: all items; Mobile bottom nav: 4 primary items only
    const allNavItems = [
        { id: 'dashboard', label: 'Início',        icon: NAV_ICON_SVG.dashboard },
        { id: 'visits',    label: 'Visitas',        icon: NAV_ICON_SVG.visits },
        { id: 'calendar',  label: 'Agenda',         icon: NAV_ICON_SVG.calendar },
        { id: 'proposals', label: 'Propostas',      icon: NAV_ICON_SVG.proposals },
        { id: 'funil',     label: 'Funil',          icon: NAV_ICON_SVG.funil }
    ];

    if (state.currentUser && (state.currentUser.profile || '').toLowerCase() === 'admin') {
        allNavItems.push({ id: 'admin', label: 'Admin', icon: NAV_ICON_SVG.admin });
    }

    const mobileItems = allNavItems.filter((i) => ['dashboard','visits','proposals','funil','admin'].includes(i.id));
    const navItems = isDesktop ? allNavItems : mobileItems;

    const user = state.currentUser;
    const userInitial = user ? (user.name || user.nomeVendedor || 'U')[0].toUpperCase() : 'U';
    const userName = user ? escapeHtml(user.name || user.nomeVendedor || '') : '';
    const userProfile = user ? escapeHtml(user.profile || '') : '';

    const userInfoHtml = (user && isDesktop) ? `
        <div class="nav-user-info">
            <div class="nav-user-avatar"><span>${userInitial}</span></div>
            <div class="nav-user-details">
                <strong>${userName}</strong>
                <span>${userProfile}</span>
            </div>
        </div>
    ` : '';

    bottomNav.innerHTML = navItems.map((item) => `
        <button
            id="nav-${item.id}"
            class="nav-btn ${isNavActive(item.id) ? 'active' : ''}"
            data-page="${item.id}"
            data-label="${item.label}"
            type="button"
            title="${item.label}"
        >
            <span class="nav-icon">${item.icon}</span>
            <span class="nav-btn-label">${item.label}</span>
        </button>
    `).join('') + userInfoHtml;

    bottomNav.querySelectorAll('[data-page]').forEach((button) => {
        button.addEventListener('click', () => navigateTo(button.dataset.page));
    });

    // Restore sidebar expanded state on desktop
    if (isDesktop) {
        const expanded = localStorage.getItem('sidebar_expanded') === '1';
        if (expanded) { bottomNav.classList.add('sidebar-expanded'); }
    }
}


export function updateHeaderUI(user) {
    const area = document.getElementById('header-user-area');
    if (!area) { return; }
    if (!user) { area.innerHTML = ''; _headerBuilt = false; return; }

    if (_headerBuilt) {
        const hasPending = (state.overdueProposals || 0) > 0 || (state.overdueFunil || 0) > 0;
        const notifBtn = document.getElementById('header-notif');
        if (notifBtn) notifBtn.innerHTML = `🔔${hasPending ? '<span class="header-notif-dot"></span>' : ''}`;
        return;
    }
    _headerBuilt = true;

    const initial = (user.name || user.nomeVendedor || 'U')[0].toUpperCase();
    const name    = escapeHtml(user.name || user.nomeVendedor || '');
    const role    = escapeHtml(user.profile || '');
    const hasPending = (state.overdueProposals || 0) > 0 || (state.overdueFunil || 0) > 0;
    area.innerHTML = `
        <button class="header-notif-btn" id="header-install-btn" type="button" aria-label="Instalar App" style="display:none" title="Instalar App">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 2v13M8 11l4 4 4-4"/><path d="M3 17v2a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-2"/></svg>
        </button>
        <button class="header-notif-btn" id="header-search-btn" type="button" aria-label="Busca global">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        </button>
        <button class="header-notif-btn" id="header-notif" type="button" aria-label="Notificações">
            🔔${hasPending ? '<span class="header-notif-dot"></span>' : ''}
        </button>
        <div class="header-user-details">
            <span class="header-user-name">${name}</span>
            <span class="header-user-role">${role}</span>
        </div>
        <div class="header-avatar" id="header-avatar-btn" title="${name}">${initial}</div>
    `;
    document.getElementById('header-notif').addEventListener('click', () => navigateTo('proposals'));
    document.getElementById('header-avatar-btn').addEventListener('click', () => navigateTo('dashboard'));
    document.getElementById('header-search-btn').addEventListener('click', openGlobalSearch);
    const _installBtn = document.getElementById('header-install-btn');
    if (_installBtn) {
        if (_installPrompt) _installBtn.style.display = '';
        _installBtn.addEventListener('click', async () => {
            if (!_installPrompt) return;
            _installPrompt.prompt();
            await _installPrompt.userChoice;
            _installPrompt = null;
            _installBtn.style.display = 'none';
        });
    }
}


export function initSidebarToggle() {
    const btn = document.getElementById('sidebar-toggle');
    if (!btn || btn.dataset.toggleBound) { return; }
    btn.dataset.toggleBound = '1';
    btn.addEventListener('click', () => {
        const nav = document.getElementById('bottom-nav');
        if (!nav) { return; }
        const expanded = nav.classList.toggle('sidebar-expanded');
        localStorage.setItem('sidebar_expanded', expanded ? '1' : '0');
    });
}


export function isNavActive(navId) {
    if (navId === 'visits') {
        return ['visits', 'visit-new', 'visit-detail', 'visit-edit'].includes(state.currentPage);
    }
    if (navId === 'calendar') {
        return state.currentPage === 'calendar';
    }
    if (navId === 'proposals') {
        return ['proposals', 'proposal-new', 'proposal-detail', 'proposal-edit'].includes(state.currentPage);
    }
    if (navId === 'funil') {
        return ['funil', 'funil-new', 'funil-detail', 'funil-edit'].includes(state.currentPage);
    }
    return state.currentPage === navId;
}


export function initSessionExpiry() {
    const SESSION_MS = 8 * 60 * 60 * 1000;
    let _idleTimer = null;
    function resetTimer() {
        clearTimeout(_idleTimer);
        if (!state.currentUser) return;
        _idleTimer = setTimeout(() => {
            showToast('Sessão expirada por inatividade.', true);
            setTimeout(() => logout(), 2000);
        }, SESSION_MS);
    }
    ['click','keydown','touchstart','scroll'].forEach(ev => {
        document.addEventListener(ev, resetTimer, { passive: true, capture: true });
    });
    resetTimer();
}

// ── Hover prefetch on nav ────────────────────────────────────────

export function initNavHoverPrefetch() {
    const prefetched = new Set();

    // Prefetch listas ao hover nos botões de nav
    document.addEventListener('mouseover', (e) => {
        const btn = e.target.closest('[data-page]');
        if (!btn || !state.currentUser) return;
        const page = btn.dataset.page;
        if (prefetched.has(page)) return;
        prefetched.add(page);
        if (page === 'visits')         import('../pages/visits.js').then((m) => m.getVisits()).catch(() => {});
        else if (page === 'proposals') import('../pages/proposals.js').then((m) => m.getProposals()).catch(() => {});
        else if (page === 'funil')     import('../pages/funil.js').then((m) => m.getFunil()).catch(() => {});
    });

    // Prefetch formData ao hover em botões de nova visita/proposta/funil (desktop)
    const _FORM_BTN_IDS = new Set(['qa-new-visit','qa-new-proposal','qa-new-funil',
        'btn-new-visit','btn-new-proposal','btn-new-funil','empty-new-visit','page-fab']);
    document.addEventListener('mouseover', (e) => {
        if (!state.currentUser || state.formData) return;
        const btn = e.target.closest('button, a');
        if (!btn) return;
        const text = (btn.textContent || '').toLowerCase();
        if (_FORM_BTN_IDS.has(btn.id) ||
            text.includes('nova visita') || text.includes('nova proposta') ||
            text.includes('nova oportunidade') || text.includes('novo funil')) {
            ensureFormData().catch(() => {});
        }
    });

    // Prefetch formData ao tocar em mobile (touchstart dispara antes do click)
    document.addEventListener('touchstart', (e) => {
        if (!state.currentUser || state.formData) return;
        const btn = e.target.closest('button');
        if (!btn) return;
        if (_FORM_BTN_IDS.has(btn.id)) {
            ensureFormData().catch(() => {});
        }
    }, { passive: true });
}

// ── Pull-to-refresh ──────────────────────────────────────────────

export function initPullToRefresh(onRefresh) {
    const main = document.getElementById('main-content');
    if (!main) return;
    let startY = 0;
    let pulling = false;
    let indicator = null;

    main.addEventListener('touchstart', (e) => {
        startY = e.touches[0].clientY;
        pulling = main.scrollTop === 0;
    }, { passive: true });

    main.addEventListener('touchmove', (e) => {
        if (!pulling) return;
        const dy = e.touches[0].clientY - startY;
        if (dy > 10 && !indicator) {
            indicator = document.createElement('div');
            indicator.className = 'pull-refresh-indicator';
            indicator.innerHTML = '<span class="pull-refresh-spinner"></span>';
            main.prepend(indicator);
        }
    }, { passive: true });

    main.addEventListener('touchend', (e) => {
        const dy = e.changedTouches[0].clientY - startY;
        if (indicator) { indicator.remove(); indicator = null; }
        if (pulling && dy > 72) {
            onRefresh();
        }
        pulling = false;
    }, { passive: true });
}

// ── CSV export ───────────────────────────────────────────────────

export function renderBreadcrumb(items) {
    const parts = items.map((item, i) => {
        if (i < items.length - 1 && item.page) {
            return `<button class="breadcrumb-link" data-page="${escapeHtml(item.page)}" type="button">${escapeHtml(item.label)}</button>`;
        }
        return `<span class="breadcrumb-current">${escapeHtml(item.label)}</span>`;
    }).join('<span class="breadcrumb-sep">›</span>');
    return `<nav class="breadcrumb" aria-label="Navegação">${parts}</nav>`;
}

// ── Global search ────────────────────────────────────────────────

export function openGlobalSearch() {
    const existing = document.getElementById('global-search-modal');
    if (existing) { existing.remove(); return; }
    const modal = document.createElement('div');
    modal.id = 'global-search-modal';
    modal.className = 'global-search-modal';
    modal.innerHTML = `
        <div class="global-search-inner">
            <div class="global-search-bar">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                <input type="text" id="global-search-input" placeholder="Buscar visitas, propostas, funil..." autofocus>
                <button type="button" class="global-search-close" id="global-search-close" aria-label="Fechar">✕</button>
            </div>
            <div id="global-search-results" class="global-search-results">
                <p class="helper-text" style="text-align:center;padding:1rem">Digite para buscar...</p>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    setTimeout(() => { const inp = document.getElementById('global-search-input'); if (inp) inp.focus(); }, 50);

    document.getElementById('global-search-close').addEventListener('click', () => modal.remove());
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });

    const resultsEl = document.getElementById('global-search-results');
    const searchFn = debounce((q) => {
        const query = q.trim().toLowerCase();
        if (!query || query.length < 2) {
            resultsEl.innerHTML = '<p class="helper-text" style="text-align:center;padding:1rem">Digite para buscar...</p>';
            return;
        }
        const visits = (state.visits || []).filter(v => {
            const n = normalizeVisit(v);
            return [n.cliente, n.cidade, n.tipoVisita, n.vendedorGerente, n.observacao].some(f => String(f || '').toLowerCase().includes(query));
        }).slice(0, 5);
        const proposals = (state.proposals || []).filter(p => {
            const n = normalizeProposal(p);
            return [n.cliente, n.cidade, n.produto, n.vendedor, n.status].some(f => String(f || '').toLowerCase().includes(query));
        }).slice(0, 5);
        const funil = (state.funil || []).filter(f => {
            return [f.cliente, f.status, f.vendedor].some(fi => String(fi || '').toLowerCase().includes(query));
        }).slice(0, 5);

        const total = visits.length + proposals.length + funil.length;
        if (total === 0) {
            resultsEl.innerHTML = `<p class="helper-text" style="text-align:center;padding:1rem">Nenhum resultado para "${escapeHtml(q.trim())}"</p>`;
            return;
        }
        let html = '';
        if (visits.length > 0) {
            html += `<div class="gs-group-label">Visitas</div>`;
            html += visits.map(v => { const n = normalizeVisit(v); return `<button class="gs-result-item" data-type="visit-detail" data-id="${escapeHtml(n.id)}" type="button"><span class="gs-result-icon">📋</span><span class="gs-result-text"><strong>${escapeHtml(n.cliente || '-')}</strong><span>${escapeHtml(n.dataVisita || '')} · ${escapeHtml(n.tipoVisita || '')}</span></span></button>`; }).join('');
        }
        if (proposals.length > 0) {
            html += `<div class="gs-group-label">Propostas</div>`;
            html += proposals.map(p => { const n = normalizeProposal(p); return `<button class="gs-result-item" data-type="proposal-detail" data-id="${escapeHtml(n.id)}" type="button"><span class="gs-result-icon">📄</span><span class="gs-result-text"><strong>${escapeHtml(n.cliente || '-')}</strong><span>${escapeHtml(n.status || '')} · ${escapeHtml(n.produto || '')}</span></span></button>`; }).join('');
        }
        if (funil.length > 0) {
            html += `<div class="gs-group-label">Funil</div>`;
            html += funil.map(f => `<button class="gs-result-item" data-type="funil-detail" data-id="${escapeHtml(f.id || '')}" type="button"><span class="gs-result-icon">📊</span><span class="gs-result-text"><strong>${escapeHtml(f.cliente || '-')}</strong><span>${escapeHtml(f.status || '')}</span></span></button>`).join('');
        }
        resultsEl.innerHTML = html;
        resultsEl.querySelectorAll('.gs-result-item').forEach(btn => {
            btn.addEventListener('click', () => {
                modal.remove();
                navigateTo(btn.dataset.type, { id: btn.dataset.id });
            });
        });
    }, 250);

    document.getElementById('global-search-input').addEventListener('input', (e) => searchFn(e.target.value));
}

// ── Inline status editor (proposals) ────────────────────────────

export function registerServiceWorker() {
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('./sw.js').catch(() => {});
        // When a new SW takes over, reload the page so stale cached JS doesn't linger
        navigator.serviceWorker.addEventListener('controllerchange', () => {
            window.location.reload();
        });
    }
}


export function initOfflineBanner() {
    const wifiOffIcon = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="1" y1="1" x2="23" y2="23"/><path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55M5 12.55a10.94 10.94 0 0 1 5.17-2.39M10.71 5.05A16 16 0 0 1 22.56 9M1.42 9a15.91 15.91 0 0 1 4.7-2.88M8.53 16.11a6 6 0 0 1 6.95 0M12 20h.01"/></svg>`;
    let banner = null;
    function getBanner() {
        if (!banner) {
            banner = document.createElement('div');
            banner.id = 'offline-banner';
            banner.innerHTML = `${wifiOffIcon} Você está offline — exibindo dados salvos`;
            document.body.appendChild(banner);
        }
        return banner;
    }
    function show() { getBanner().classList.add('visible'); }
    function hide() { if (banner) banner.classList.remove('visible'); }
    window.addEventListener('online', hide);
    window.addEventListener('offline', show);
    if (!navigator.onLine) show();
}


export function updateProposalsBadge(count) {
    const btn = document.getElementById('nav-proposals');
    if (!btn) { return; }
    let badge = btn.querySelector('.nav-badge');
    if (count > 0) {
        const label = count > 99 ? '99+' : String(count);
        if (!badge) {
            badge = document.createElement('span');
            badge.className = 'nav-badge';
            btn.appendChild(badge); // append AFTER icon+label so layout is not affected
        }
        badge.textContent = label;
    } else if (badge) {
        badge.remove();
    }
}


export function updateFunilBadge(count) {
    const btn = document.getElementById('nav-funil');
    if (!btn) { return; }
    let badge = btn.querySelector('.nav-badge');
    if (count > 0) {
        const label = count > 99 ? '99+' : String(count);
        if (!badge) {
            badge = document.createElement('span');
            badge.className = 'nav-badge';
            btn.appendChild(badge);
        }
        badge.textContent = label;
    } else if (badge) {
        badge.remove();
    }
}
