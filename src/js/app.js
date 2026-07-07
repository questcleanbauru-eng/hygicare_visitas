import { API_URL, loadStoredUser, getDashboardData, initOfflineQueueSync } from './api.js';
import {
    registerServiceWorker, initOfflineBanner, initSessionExpiry, initNavHoverPrefetch,
    renderNavigation, updateHeaderUI, initSidebarToggle
} from './utils/ui.js';
import { renderLoginPage, renderForgotPasswordPage } from './pages/auth.js';
import { renderDashboard, fillDashboard } from './pages/dashboard.js';

export const state = {
    currentUser: loadStoredUser(),
    currentPage: loadStoredUser() ? 'dashboard' : 'login',
    visits: [],
    proposals: [],
    funil: [],
    formData: null,
    dashboardData: null,
    adminData: null,
    currentVisit: null,
    currentProposal: null,
    currentFunil: null,
    toastTimer: null,
    overdueProposals: 0,
    overdueFunil: 0,
    visitsScope: '3m',
    proposalsScope: '3m',
    funilScope: '3m',
    loadDias: 90,
    _prevLoginAt: null,
    navLoadAll: null,
    formDirty: false,
    scrollPositions: {},
    canDelete: false,
    canCreateProposalFunil: false
};


export const documentClickListeners = [];


export function addDocumentClickListener(handler) {
    document.addEventListener('click', handler);
    documentClickListeners.push(handler);
}


export function clearDocumentClickListeners() {
    documentClickListeners.forEach((h) => document.removeEventListener('click', h));
    documentClickListeners.length = 0;
}


document.addEventListener('DOMContentLoaded', async () => {
    // Wake up GAS immediately — covers both logged-in and login-screen flows
    fetch(API_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ action: 'ping', payload: {} }) }).catch(function() {});

    registerServiceWorker();
    initOfflineBanner();
    initOfflineQueueSync();
    initBackButton();
    initTabVisibilitySync();
    initSessionExpiry();
    initNavHoverPrefetch();
    document.addEventListener('click', (e) => {
        const btn = e.target.closest('.breadcrumb-link[data-page]');
        if (btn) navigateTo(btn.dataset.page);
    });
    if (state.currentUser) {
        // Kick off dashboard fetch now; renderDashboard reuses the same inflight promise
        getDashboardData().catch(() => {});
        await navigateTo('dashboard');
        return;
    }
    renderLoginPage();
});


export function initBackButton() {
    window.history.replaceState({ page: state.currentPage }, '');
    window.addEventListener('popstate', function(e) {
        const pg = e.state && e.state.page;
        if (!pg || pg === 'login') { return; }
        navigateTo(pg, e.state.options || {}, true);
    });
}


export function initTabVisibilitySync() {
    let _lastActive = Date.now();
    document.addEventListener('visibilitychange', function() {
        if (document.visibilityState !== 'visible' || !state.currentUser) return;
        const elapsed = Date.now() - _lastActive;
        _lastActive = Date.now();
        if (elapsed < 5 * 60 * 1000) return;
        if (state.currentPage === 'dashboard') {
            getDashboardData().then(function(r) {
                if (r.status === 'success') fillDashboard(document.getElementById('main-content'), r.data, state.currentUser);
            }).catch(function() {});
        } else if (state.currentPage === 'visits') {
            import('./pages/visits.js').then(function(m) {
                m.getVisits().then(function(r) {
                    if (r.status === 'success') { state.visits = r.visits || []; const el = document.getElementById('visits-content'); if (el) m.fillVisitsContent(el, state.visits); }
                });
            }).catch(function() {});
        } else if (state.currentPage === 'proposals') {
            import('./pages/proposals.js').then(function(m) {
                m.getProposals().then(function(r) {
                    if (r.status === 'success') { state.proposals = r.proposals || []; m.fillProposalsContent(document.getElementById('main-content'), state.proposals); }
                });
            }).catch(function() {});
        } else if (state.currentPage === 'funil') {
            import('./pages/funil.js').then(function(m) {
                m.getFunil().then(function(r) {
                    if (r.status === 'success') { state.funil = r.funil || []; m.fillFunilContent(document.getElementById('main-content'), state.funil); }
                });
            }).catch(function() {});
        }
    });
    document.addEventListener('visibilitychange', function() {
        if (document.visibilityState === 'hidden') _lastActive = Date.now();
    });
}


export const _FORM_PAGES = new Set(['visit-new','visit-edit','proposal-new','proposal-edit','funil-new','funil-edit']);


export async function navigateTo(page, options = {}, _fromPop = false) {
    if (state.formDirty && _FORM_PAGES.has(state.currentPage) && !_fromPop && page !== state.currentPage) {
        if (!confirm('Você tem alterações não salvas. Deseja sair mesmo assim?')) {
            return;
        }
    }
    const _prevPage = state.currentPage;
    const _LIST_PAGES = new Set(['visits', 'proposals', 'funil']);
    if (_LIST_PAGES.has(_prevPage)) {
        state.scrollPositions[_prevPage] = window.scrollY;
    }
    state.formDirty = false;
    clearDocumentClickListeners();
    state.currentPage = page;
    if (!_fromPop && page !== 'login' && page !== 'forgot-password') {
        window.history.pushState({ page, options }, '');
    }
    // Reset any login-page style overrides on main content + trigger slide transition
    const _mc = document.getElementById('main-content');
    if (_mc) {
        _mc.style.cssText = '';
        _mc.classList.remove('page-entering');
        requestAnimationFrame(() => _mc.classList.add('page-entering'));
    }

    if (!state.currentUser && page !== 'login' && page !== 'forgot-password') {
        renderLoginPage();
        return;
    }

    const header = document.querySelector('header');
    const bottomNav = document.getElementById('bottom-nav');

    if (page === 'login' || page === 'forgot-password') {
        header.style.display = 'none';
        bottomNav.style.display = 'none';
    } else {
        header.style.display = 'flex';
        bottomNav.style.display = 'flex';
        renderNavigation();
        updateHeaderUI(state.currentUser);
        initSidebarToggle();
    }

    switch (page) {
        case 'login':
            renderLoginPage();
            break;
        case 'forgot-password':
            renderForgotPasswordPage();
            break;
        case 'dashboard':
            await renderDashboard();
            break;
        case 'visits':
            await (await import('./pages/visits.js')).renderVisitsPage();
            break;
        case 'calendar':
            await (await import('./pages/visits.js')).renderCalendarPage();
            break;
        case 'visit-new':
            await (await import('./pages/visits.js')).renderVisitFormPage();
            break;
        case 'visit-detail':
            await (await import('./pages/visits.js')).renderVisitDetailPage(options.id);
            break;
        case 'visit-edit':
            await (await import('./pages/visits.js')).renderVisitFormPage(options.visit || state.currentVisit);
            break;
        case 'proposals':
            await (await import('./pages/proposals.js')).renderProposalsPage();
            break;
        case 'proposal-detail':
            await (await import('./pages/proposals.js')).renderProposalDetailPage(options.id);
            break;
        case 'proposal-new':
            await (await import('./pages/proposals.js')).renderProposalCreatePage();
            break;
        case 'proposal-edit':
            await (await import('./pages/proposals.js')).renderProposalFormPage(options.proposal || state.currentProposal);
            break;
        case 'funil':
            await (await import('./pages/funil.js')).renderFunilPage();
            break;
        case 'funil-detail':
            await (await import('./pages/funil.js')).renderFunilDetailPage(options.id);
            break;
        case 'funil-new':
            await (await import('./pages/funil.js')).renderFunilCreatePage();
            break;
        case 'funil-edit':
            await (await import('./pages/funil.js')).renderFunilFormPage(options.funil || state.currentFunil);
            break;
        case 'admin':
            await (await import('./pages/admin.js')).renderAdminPage();
            break;
        default:
            await renderDashboard();
    }

    // Restore scroll position when returning from detail/edit back to parent list
    const _scrollParentMap = {
        'visits':    ['visit-detail', 'visit-edit'],
        'proposals': ['proposal-detail', 'proposal-edit'],
        'funil':     ['funil-detail', 'funil-edit'],
    };
    if (_scrollParentMap[page] && _scrollParentMap[page].includes(_prevPage) && state.scrollPositions[page] > 0) {
        const savedY = state.scrollPositions[page];
        delete state.scrollPositions[page];
        requestAnimationFrame(() => window.scrollTo(0, savedY));
    }
}
