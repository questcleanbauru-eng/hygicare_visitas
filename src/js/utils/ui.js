import { state, navigateTo } from '../app.js';
import { escapeHtml, normalizeVisit, normalizeProposal, normalizeContrato, normalizeManutencao } from './format.js';
import { debounce, showToast } from './dom.js';
import { ensureFormData, logout, saveCache } from '../api.js';

const REFRESHABLE_PAGE_CACHE_KEYS = {
    dashboard: ['dashboard'],
    visits: ['visits', 'visits_all'],
    proposals: ['proposals', 'proposals_all'],
    funil: ['funil', 'funil_all'],
    admin: ['admin_data', 'admin_email'],
    // Radar não guarda cache em localStorage (o dado vive só em variável de
    // módulo dentro de radar.js) — não tem chave pra zerar aqui, mas precisa
    // constar no mapa (mesmo com lista vazia) senão refreshCurrentPage()
    // simplesmente não faz nada nessa página (retorno antecipado por
    // REFRESHABLE_PAGE_CACHE_KEYS[page] vir undefined).
    radar: []
};

function refreshCurrentPage() {
    const page = state.currentPage;
    const keys = REFRESHABLE_PAGE_CACHE_KEYS[page];
    if (!keys) { return; }
    const btn = document.getElementById('header-refresh-btn');
    btn?.classList.add('spinning');
    keys.forEach((k) => saveCache(k, null));
    Promise.resolve(navigateTo(page)).finally(() => btn?.classList.remove('spinning'));
}

export let _installPrompt = null;

export let _navBuilt = false;

export let _headerBuilt = false;

export function resetNavCache() {
    _navBuilt = false;
    _headerBuilt = false;
}

const _loadedStyles = new Set();

export function ensureStyles(name, _isRetry) {
    if (_loadedStyles.has(name)) return;
    _loadedStyles.add(name);
    const manifest = (typeof window !== 'undefined' && window.__ASSET_MANIFEST__) || {};
    const href = manifest['css/' + name] || `./${name}.css`;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.onerror = () => {
        // Sem isso, uma falha de rede passageira (ou o service worker ainda
        // sem essa rota em cache) marcava _loadedStyles como "carregado" pra
        // sempre, e a página ficava sem esse CSS até um F5 — exatamente o
        // "às vezes o Funil perde o CSS" relatado. Tenta uma vez de novo
        // depois de um instante; se falhar de novo, libera pra próxima
        // navegação tentar sozinha (sem loop infinito aqui).
        link.remove();
        _loadedStyles.delete(name);
        if (!_isRetry) { setTimeout(() => ensureStyles(name, true), 800); }
    };
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
        document.getElementById('mobile-extra-menu')?.querySelectorAll('.nav-btn[data-page]').forEach(btn => {
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
        contratos: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="15" x2="15" y2="15"/></svg>',
        manutencao: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>',
        report: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>',
        radar: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="2"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="10"/><line x1="12" y1="12" x2="19" y2="5"/></svg>',
        admin: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>'
    };

    // Desktop sidebar: all items (inclui Contratos); Mobile bottom nav: sem Contratos (menu já cheio) — acessível via link no Dashboard.
    const allNavItems = [
        { id: 'dashboard', label: 'Início',        icon: NAV_ICON_SVG.dashboard },
        { id: 'visits',    label: 'Visitas',        icon: NAV_ICON_SVG.visits },
        { id: 'calendar',  label: 'Agenda',         icon: NAV_ICON_SVG.calendar },
        { id: 'proposals', label: 'Propostas',      icon: NAV_ICON_SVG.proposals },
        { id: 'funil',     label: 'Funil',          icon: NAV_ICON_SVG.funil },
        { id: 'contratos', label: 'Contratos',      icon: NAV_ICON_SVG.contratos },
        { id: 'manutencao', label: 'Manutenção',    icon: NAV_ICON_SVG.manutencao },
        { id: 'report',    label: 'Relatório',      icon: NAV_ICON_SVG.report }
    ];

    if (state.canAccessRadar) {
        allNavItems.push({ id: 'radar', label: 'Radar', icon: NAV_ICON_SVG.radar });
    }

    if (state.currentUser && (state.currentUser.profile || '').toLowerCase() === 'admin') {
        allNavItems.push({ id: 'admin', label: 'Admin', icon: NAV_ICON_SVG.admin });
    }

    // Desktop: sidebar com tudo. Mobile: barra de baixo só com os itens
    // mais usados no dia a dia (senão fica apertado demais numa tela de
    // celular) — o resto (Contratos, Relatório, Radar) fica na gaveta do
    // botão ☰, mesmo conjunto que já era assim quando a barra existia.
    const MOBILE_BAR_IDS = ['dashboard', 'visits', 'calendar', 'proposals', 'funil', 'admin'];
    const mobileItems = allNavItems.filter((item) => MOBILE_BAR_IDS.includes(item.id));
    const navItems = isDesktop ? allNavItems : mobileItems;
    const drawerItems = isDesktop ? allNavItems : allNavItems.filter((item) => !MOBILE_BAR_IDS.includes(item.id));

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

    const navBtnHtml = (item) => `
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
    `;

    bottomNav.innerHTML = navItems.map(navBtnHtml).join('') + userInfoHtml;

    bottomNav.querySelectorAll('[data-page]').forEach((button) => {
        button.addEventListener('click', () => navigateTo(button.dataset.page));
    });

    // Restore sidebar expanded state on desktop
    if (isDesktop) {
        const expanded = localStorage.getItem('sidebar_expanded') === '1';
        if (expanded) { bottomNav.classList.add('sidebar-expanded'); }
        applySidebarWidthVar(expanded);
    }

    // Menu do mobile — itens que não cabem na barra de baixo (Contratos,
    // Relatório, Radar). Aberto pelo ☰ do cabeçalho (ver initSidebarToggle).
    const extraMenu = document.getElementById('mobile-extra-menu');
    if (extraMenu && drawerItems.length) {
        const heading = isDesktop ? '' : '<p class="mobile-extra-menu-heading">Mais opções</p>';
        extraMenu.innerHTML = heading + drawerItems.map(navBtnHtml).join('');
        extraMenu.querySelectorAll('[data-page]').forEach((button) => {
            button.addEventListener('click', () => {
                navigateTo(button.dataset.page);
                closeMobileExtraMenu();
            });
        });
    }
}


export function closeMobileExtraMenu() {
    document.getElementById('mobile-extra-menu')?.classList.remove('open');
    document.getElementById('mobile-extra-overlay')?.classList.remove('open');
}


// O sino sempre abria Propostas, mesmo quando só o Funil estava atrasado —
// agora vai direto pra quem tem pendência; com os dois pendentes, mostra um
// menuzinho pra escolher (mesmo padrão visual do editor de status inline
// das Propostas, só que ancorado no sino em vez de num status pill).
function handleNotifBellClick() {
    const overdueProposals = state.overdueProposals || 0;
    const overdueFunil = state.overdueFunil || 0;
    if (overdueFunil > 0 && overdueProposals === 0) { navigateTo('funil'); return; }
    if (overdueProposals > 0 && overdueFunil === 0) { navigateTo('proposals'); return; }
    if (overdueProposals > 0 && overdueFunil > 0) {
        document.querySelector('.inline-status-editor')?.remove();
        const btn = document.getElementById('header-notif');
        const editor = document.createElement('div');
        editor.className = 'inline-status-editor';
        editor.innerHTML = `
            <button type="button" class="inline-status-opt" data-notif-go="proposals">Propostas atrasadas (${overdueProposals})</button>
            <button type="button" class="inline-status-opt" data-notif-go="funil">Funil sem atualização (${overdueFunil})</button>
        `;
        const rect = btn.getBoundingClientRect();
        editor.style.cssText = `position:fixed;top:${Math.round(rect.bottom + 4)}px;right:${Math.round(window.innerWidth - rect.right)}px;z-index:1000`;
        document.body.appendChild(editor);
        editor.addEventListener('click', (e) => e.stopPropagation());
        editor.querySelectorAll('[data-notif-go]').forEach((opt) => {
            opt.addEventListener('click', () => { editor.remove(); navigateTo(opt.dataset.notifGo); });
        });
        setTimeout(() => document.addEventListener('click', () => editor.remove(), { once: true }), 0);
        return;
    }
    navigateTo('proposals');
}


// Número no ícone do app (Badging API) — só funciona com o app aberto/logado
// (sem push/backend nenhum, é só espelhar o que já está em `state`); não
// suportado em todo navegador, daí o "in navigator" antes de chamar.
function updateAppBadge(count) {
    if (!('setAppBadge' in navigator)) return;
    if (count > 0) { navigator.setAppBadge(count).catch(() => {}); }
    else { navigator.clearAppBadge?.().catch(() => {}); }
}


// Lembrete de pendências (propostas/funil atrasados) mostrado quando o app
// está aberto ou volta a ficar visível — sem push real (sem VAPID nem
// trigger no backend), só reaproveita o mesmo dado que já alimenta o sino e
// o badge. Guarda o último total avisado em localStorage pra não repetir a
// mesma notificação a cada navegação; só dispara de novo se o total mudar
// (ex.: mais um item atrasou, ou zerou e depois voltou a ter pendência).
export function checkOverdueNotification(overdueProposals, overdueFunil) {
    if (!('Notification' in window) || !('serviceWorker' in navigator)) return;
    const total = (overdueProposals || 0) + (overdueFunil || 0);
    if (total === 0) return;
    if (Notification.permission === 'denied') return;

    const lastNotified = parseInt(localStorage.getItem('last_notified_overdue') || '0', 10);
    if (total === lastNotified) return;

    const fire = () => {
        localStorage.setItem('last_notified_overdue', String(total));
        const parts = [];
        if (overdueProposals > 0) parts.push(`${overdueProposals} proposta${overdueProposals > 1 ? 's' : ''} atrasada${overdueProposals > 1 ? 's' : ''}`);
        if (overdueFunil > 0) parts.push(`${overdueFunil} oportunidade${overdueFunil > 1 ? 's' : ''} no funil sem atualização`);
        navigator.serviceWorker.ready.then((reg) => {
            reg.showNotification('Pendências no Hygicare Visitas', {
                body: parts.join(' · '),
                tag: 'overdue-items',
                icon: './icons/apple-touch-icon.png',
                data: { page: overdueProposals > 0 ? 'proposals' : 'funil' }
            }).catch(() => {});
        }).catch(() => {});
    };

    if (Notification.permission === 'granted') { fire(); }
    else { Notification.requestPermission().then((perm) => { if (perm === 'granted') fire(); }); }
}

// Mesmo padrão do checkOverdueNotification acima, mas pra Clientes
// Principais sem Relatório de Manutenção no mês corrente (ver Admin →
// Listas → Clientes Principais). Comparação por mês+ano (não só a
// contagem) evita reavisar todo santo dia enquanto o número não muda, mas
// ainda assim avisa de novo quando o mês vira — mesmo que a contagem tenha
// ficado igual à do mês anterior por coincidência.
export function checkClientesPrincipaisNotification(pendentes) {
    if (!('Notification' in window) || !('serviceWorker' in navigator)) return;
    const total = (pendentes || []).length;
    if (total === 0) return;
    if (Notification.permission === 'denied') return;

    const now = new Date();
    const monthKey = `${now.getFullYear()}-${now.getMonth()}`;
    const lastNotified = localStorage.getItem('last_notified_cp');
    if (lastNotified === `${monthKey}:${total}`) return;

    const fire = () => {
        localStorage.setItem('last_notified_cp', `${monthKey}:${total}`);
        const nomes = pendentes.slice(0, 3).map((c) => c.cliente).join(', ');
        navigator.serviceWorker.ready.then((reg) => {
            reg.showNotification('Clientes principais sem relatório', {
                body: `${total} cliente${total > 1 ? 's' : ''} ainda sem Relatório de Manutenção este mês: ${nomes}${total > 3 ? '...' : ''}`,
                tag: 'clientes-principais-pendentes',
                icon: './icons/apple-touch-icon.png',
                data: { page: 'dashboard' }
            }).catch(() => {});
        }).catch(() => {});
    };

    if (Notification.permission === 'granted') { fire(); }
    else { Notification.requestPermission().then((perm) => { if (perm === 'granted') fire(); }); }
}


export function updateHeaderUI(user) {
    const area = document.getElementById('header-user-area');
    if (!area) { return; }
    if (!user) { area.innerHTML = ''; _headerBuilt = false; updateAppBadge(0); return; }

    const pendingCount = (state.overdueProposals || 0) + (state.overdueFunil || 0);
    updateAppBadge(pendingCount);

    if (_headerBuilt) {
        const notifBtn = document.getElementById('header-notif');
        if (notifBtn) notifBtn.innerHTML = `🔔${pendingCount > 0 ? '<span class="header-notif-dot"></span>' : ''}`;
        return;
    }
    _headerBuilt = true;

    const initial = (user.name || user.nomeVendedor || 'U')[0].toUpperCase();
    const name    = escapeHtml(user.name || user.nomeVendedor || '');
    const role    = escapeHtml(user.profile || '');
    const hasPending = pendingCount > 0;
    area.innerHTML = `
        <button class="header-notif-btn" id="header-install-btn" type="button" aria-label="Instalar App" style="display:none" title="Instalar App">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 2v13M8 11l4 4 4-4"/><path d="M3 17v2a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-2"/></svg>
        </button>
        <button class="header-notif-btn" id="header-refresh-btn" type="button" aria-label="Atualizar" title="Atualizar">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
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
    document.getElementById('header-refresh-btn').addEventListener('click', refreshCurrentPage);
    document.getElementById('header-notif').addEventListener('click', handleNotifBellClick);
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


// Esconde a barra inferior ao rolar pra baixo (mais espaço pra ler
// lista/detalhe), mostra de novo ao rolar pra cima ou parar. Chamado uma
// vez só no boot (main-content e bottom-nav são elementos persistentes,
// só o conteúdo/innerHTML troca a cada navegação — não precisa reatar isso
// a cada página). Só ativa no mobile: no desktop a barra vira sidebar
// (position:static, ver dashboard.css), onde "esconder" não faz sentido —
// tanto essa checagem quanto um `transform: none !important` lá garantem
// que a sidebar nunca suma por engano.
export function initBottomNavAutoHide() {
    const main = document.getElementById('main-content');
    const nav = document.getElementById('bottom-nav');
    if (!main || !nav) return;

    let lastScrollTop = main.scrollTop;
    let stopTimer = null;
    const isMobile = () => window.innerWidth < 1024;

    main.addEventListener('scroll', () => {
        if (!isMobile()) return;
        const current = main.scrollTop;
        const delta = current - lastScrollTop;

        if (current <= 40) {
            nav.classList.remove('nav-hidden');
        } else if (delta > 6) {
            nav.classList.add('nav-hidden');
            lastScrollTop = current;
        } else if (delta < -6) {
            nav.classList.remove('nav-hidden');
            lastScrollTop = current;
        }

        // Parou de rolar (sem novo evento por um instante) → mostra de novo,
        // pra nunca deixar o usuário "preso" sem acesso à navegação.
        clearTimeout(stopTimer);
        stopTimer = setTimeout(() => nav.classList.remove('nav-hidden'), 800);
    }, { passive: true });

    window.addEventListener('resize', () => {
        if (!isMobile()) nav.classList.remove('nav-hidden');
    });
}


// #app usa CSS Grid pra reservar a coluna da sidebar no desktop
// (grid-template-columns: var(--sidebar-w) 1fr, ver dashboard.css) — mas
// --sidebar-w só era definida uma vez em :root (base.css), sempre com o
// valor colapsado (64px), e nunca atualizada quando a sidebar expande pra
// 220px (#bottom-nav.sidebar-expanded). Resultado: a barra crescia
// visualmente mas a coluna do grid não acompanhava, e a sobra (220-64=156px)
// ficava sobrepondo o início do #main-content (rótulos/campos cobertos) em
// qualquer página que não fosse o Dashboard — só lá "funcionava por acaso"
// porque nada mais tocava nessa variável mesmo. Atualiza a custom property
// no :root nos dois pontos onde o estado expandido é decidido (restauração
// do localStorage no carregamento, e o clique do próprio toggle).
function applySidebarWidthVar(expanded) {
    document.documentElement.style.setProperty('--sidebar-w', expanded ? 'var(--sidebar-expanded)' : 'var(--sidebar-collapsed)');
}

export function initSidebarToggle() {
    const btn = document.getElementById('sidebar-toggle');
    if (!btn || btn.dataset.toggleBound) { return; }
    btn.dataset.toggleBound = '1';
    btn.addEventListener('click', () => {
        // No mobile a barra lateral não existe — o mesmo botão ☰ abre/fecha
        // o menu extra (Contratos/Relatório) em vez de expandir a sidebar.
        if (window.innerWidth < 1024) {
            const menu = document.getElementById('mobile-extra-menu');
            if (menu?.classList.contains('open')) { closeMobileExtraMenu(); }
            else {
                menu?.classList.add('open');
                document.getElementById('mobile-extra-overlay')?.classList.add('open');
            }
            return;
        }
        const nav = document.getElementById('bottom-nav');
        if (!nav) { return; }
        const expanded = nav.classList.toggle('sidebar-expanded');
        localStorage.setItem('sidebar_expanded', expanded ? '1' : '0');
        applySidebarWidthVar(expanded);
    });

    document.getElementById('mobile-extra-overlay')?.addEventListener('click', closeMobileExtraMenu);
}


// Tooltip do item de menu quando a sidebar desktop está recolhida.
// position:fixed + posição calculada via getBoundingClientRect, em vez de
// um ::after absoluto dentro do #bottom-nav — esse container tem
// overflow-y:auto, e por regra do CSS overflow-x não pode ficar "visible"
// sozinho quando o outro eixo tem scroll (vira "auto" e corta do mesmo
// jeito), então o pseudo-elemento antigo sempre saía cortado.
export function initSidebarTooltip() {
    const nav = document.getElementById('bottom-nav');
    if (!nav || nav.dataset.tooltipBound) { return; }
    nav.dataset.tooltipBound = '1';

    const tooltip = document.createElement('div');
    tooltip.className = 'sidebar-tooltip';
    tooltip.id = 'sidebar-tooltip';
    document.body.appendChild(tooltip);

    const show = (btn) => {
        if (window.innerWidth < 1024 || nav.classList.contains('sidebar-expanded')) return;
        const label = btn.dataset.label;
        if (!label) return;
        const rect = btn.getBoundingClientRect();
        tooltip.textContent = label;
        tooltip.style.left = `${rect.right + 8}px`;
        tooltip.style.top = `${rect.top + rect.height / 2}px`;
        tooltip.style.transform = 'translateY(-50%)';
        tooltip.classList.add('visible');
    };
    const hide = () => tooltip.classList.remove('visible');

    nav.addEventListener('mouseover', (e) => {
        const btn = e.target.closest('.nav-btn[data-label]');
        if (btn) show(btn);
    });
    nav.addEventListener('mouseout', (e) => {
        const btn = e.target.closest('.nav-btn[data-label]');
        if (btn) hide();
    });
    nav.addEventListener('focusin', (e) => {
        const btn = e.target.closest('.nav-btn[data-label]');
        if (btn) show(btn);
    });
    nav.addEventListener('focusout', (e) => {
        const btn = e.target.closest('.nav-btn[data-label]');
        if (btn) hide();
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
    if (navId === 'contratos') {
        return ['contratos', 'contrato-new', 'contrato-detail', 'contrato-edit'].includes(state.currentPage);
    }
    if (navId === 'manutencao') {
        return ['manutencao', 'manutencao-new', 'manutencao-detail', 'manutencao-edit'].includes(state.currentPage);
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
        'btn-new-visit','btn-new-proposal','btn-new-funil','empty-new-visit']);
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
                <input type="text" id="global-search-input" placeholder="Buscar cliente em visitas, propostas, funil, contratos..." autofocus>
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
        const contratos = (state.contratos || []).filter(c => {
            const n = normalizeContrato(c);
            return [n.cliente, n.cidade, n.vendedor].some(f => String(f || '').toLowerCase().includes(query));
        }).slice(0, 5);
        const manutencoes = (state.manutencoes || []).filter(m => {
            const n = normalizeManutencao(m);
            return [n.cliente, n.cidade, n.tecnico].some(f => String(f || '').toLowerCase().includes(query));
        }).slice(0, 5);

        const total = visits.length + proposals.length + funil.length + contratos.length + manutencoes.length;
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
        if (contratos.length > 0) {
            html += `<div class="gs-group-label">Contratos</div>`;
            html += contratos.map(c => { const n = normalizeContrato(c); return `<button class="gs-result-item" data-type="contrato-detail" data-id="${escapeHtml(n.id)}" type="button"><span class="gs-result-icon">📑</span><span class="gs-result-text"><strong>${escapeHtml(n.cliente || '-')}</strong><span>${escapeHtml(n.cidade || '')}${n.vencido ? ' · vencido' : ''}</span></span></button>`; }).join('');
        }
        if (manutencoes.length > 0) {
            html += `<div class="gs-group-label">Manutenção</div>`;
            html += manutencoes.map(m => { const n = normalizeManutencao(m); return `<button class="gs-result-item" data-type="manutencao-detail" data-id="${escapeHtml(n.id)}" type="button"><span class="gs-result-icon">🔧</span><span class="gs-result-text"><strong>${escapeHtml(n.cliente || '-')}</strong><span>${escapeHtml(n.cidade || '')} · ${escapeHtml(n.data || '')}</span></span></button>`; }).join('');
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
    if (!('serviceWorker' in navigator)) { return; }

    let refreshing = false;
    // When the new SW takes over (after the user confirms via o banner), reload
    // so stale cached JS/CSS don't linger.
    navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (refreshing) { return; }
        refreshing = true;
        window.location.reload();
    });

    navigator.serviceWorker.register('./sw.js').then((registration) => {
        const notifyIfWaiting = () => {
            if (registration.waiting && navigator.serviceWorker.controller) {
                showUpdateBanner(registration.waiting);
            }
        };
        notifyIfWaiting();

        registration.addEventListener('updatefound', () => {
            const installing = registration.installing;
            if (!installing) { return; }
            installing.addEventListener('statechange', () => {
                if (installing.state === 'installed' && navigator.serviceWorker.controller) {
                    showUpdateBanner(installing);
                }
            });
        });

        // Verifica se ha uma versao nova sempre que a aba volta a ficar visivel
        // (usuario reabre o app depois de um tempo) — sem isso, uma aba PWA
        // deixada aberta o dia todo nunca percebe um novo deploy sozinha.
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') { registration.update().catch(() => {}); }
        });
    }).catch(() => {});
}


function showUpdateBanner(worker) {
    let banner = document.getElementById('update-banner');
    if (banner) { return; }
    banner = document.createElement('div');
    banner.id = 'update-banner';
    banner.innerHTML = `
        <span>🔄 Nova versão disponível</span>
        <button type="button" id="update-banner-btn">Atualizar agora</button>
    `;
    document.body.appendChild(banner);
    requestAnimationFrame(() => banner.classList.add('visible'));
    document.getElementById('update-banner-btn').addEventListener('click', () => {
        worker.postMessage({ type: 'SKIP_WAITING' });
    });
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
