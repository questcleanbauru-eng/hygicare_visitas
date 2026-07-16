import { state, navigateTo } from '../app.js';
import { logout, loadCache, getDashboardData, buildLocalDashboardData, warmListCaches } from '../api.js';
import { escapeHtml, normalizeVisit, normalizeProposal, calculateDaysFromDisplayDate, visitTypeClass, parseDisplayDate } from '../utils/format.js';
import { updateHeaderUI, updateProposalsBadge, updateFunilBadge } from '../utils/ui.js';
import { showSuccessPopup } from '../utils/dom.js';

export function fillDashboard(mainContent, data, user) {
    const sevenDaysAgo    = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const recentVisits    = (data.recentVisits || []).map(normalizeVisit)
        .filter((v) => { const d = parseDisplayDate(v.dataVisita); return d && d >= sevenDaysAgo; })
        .sort((a, b) => (parseDisplayDate(b.dataVisita) || 0) - (parseDisplayDate(a.dataVisita) || 0));
    const recentProposals = (data.recentProposals || []).map(normalizeProposal)
        .filter((p) => p.atrasada)
        .sort((a, b) => (b.diasAtraso || 0) - (a.diasAtraso || 0));
    const recentFunil     = (data.recentFunil || [])
        .sort((a, b) => (b.diasAtualizacao || calculateDaysFromDisplayDate(b.atualizacao || b.data || ''))
            - (a.diasAtualizacao || calculateDaysFromDisplayDate(a.atualizacao || a.data || '')));

    // Cache overdue counts for notification dot
    state.overdueProposals = data.overdueProposals || 0;
    state.overdueFunil     = data.overdueFunil || 0;

    const isAdminOrGerente = ['admin','gerente'].includes((user.profile || '').toLowerCase());

    const todayStr = (() => { const d = new Date(); return String(d.getDate()).padStart(2,'0') + '/' + String(d.getMonth()+1).padStart(2,'0') + '/' + d.getFullYear(); })();
    const todayVisits = recentVisits.filter((v) => v.dataVisita === todayStr);

    mainContent.innerHTML = `
        <div class="page-header" style="margin-bottom:1rem">
            <div>
                <h2 style="font-size:1.2rem;font-weight:700;margin:0">Dashboard</h2>
                <p class="page-subtitle" style="margin:0.15rem 0 0">${(() => { const h = new Date().getHours(); return h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite'; })()}, ${escapeHtml(user.name.split(' ')[0])} 👋</p>
            </div>
            <button id="logout-button" class="secondary-button" type="button" style="font-size:0.8rem;padding:0.42rem 0.85rem">Sair</button>
        </div>

        <!-- Ações rápidas -->
        <div class="dash-actions-bar">
            <button type="button" class="dash-action-primary" id="qa-new-visit">📋 Nova Visita</button>
            <button type="button" class="dash-action-outline" id="qa-new-proposal" ${state.canCreateProposalFunil ? '' : 'disabled title="Peça ao administrador para liberar a criação de propostas."'}>📄 Nova Proposta</button>
            <button type="button" class="dash-action-outline" id="qa-new-funil" ${state.canCreateProposalFunil ? '' : 'disabled title="Peça ao administrador para liberar a criação de oportunidades."'}>📊 Nova Oportunidade</button>
        </div>

        <!-- Hoje -->
        <div class="dash-today-card">
            <div class="section-title-row">
                <h3 style="font-size:0.88rem;font-weight:700;margin:0">📅 Hoje</h3>
                <button class="section-link-button" id="go-agenda">Ver agenda completa →</button>
            </div>
            ${todayVisits.length === 0
                ? '<p class="helper-text">Nenhuma visita registrada hoje ainda.</p>'
                : renderRecentItems(todayVisits, '')}
        </div>

        ${(data.proximosAgendamentos && data.proximosAgendamentos.length > 0) ? `
        <div class="dash-today-card" style="margin-top:0.6rem">
            <div class="section-title-row">
                <h3 style="font-size:0.88rem;font-weight:700;margin:0">📌 Próximos retornos</h3>
                <button class="section-link-button" id="go-agenda-retornos">Ver agenda →</button>
            </div>
            <div class="recent-list">
                ${data.proximosAgendamentos.map((a) => {
                    const dias = -calculateDaysFromDisplayDate(a.dataAgendada);
                    const diasLabel = dias === 0 ? 'Hoje' : dias === 1 ? 'Amanhã' : dias > 0 ? `Em ${dias} dias` : 'Atrasado';
                    return `<div class="recent-item recent-item-proposal">
                        <div style="display:flex;flex-direction:column;gap:0.1rem;min-width:0;flex:1">
                            <strong style="font-size:0.85rem">${escapeHtml(a.cliente || '-')}</strong>
                            <span class="helper-text" style="margin:0">${escapeHtml(a.cidade || '-')}</span>
                        </div>
                        <span class="dias-atraso-badge" style="background:#f3e8ff;color:#7e22ce">${diasLabel}</span>
                    </div>`;
                }).join('')}
            </div>
        </div>` : ''}

        <!-- Métricas -->
        <div class="section-title-row" style="margin-top:0.4rem">
            <p class="dash-section-heading" style="margin:0">Visão geral</p>
            <div style="display:flex;gap:0.6rem">
                <button class="section-link-button" id="go-contratos">📑 Contratos →</button>
                <button class="section-link-button" id="go-report">📊 Relatório completo →</button>
            </div>
        </div>
        <div class="metrics-grid">
            <button class="metric-card metric-card-blue" data-nav="visits" type="button">
                <span class="metric-label">Visitas na semana</span>
                <strong class="metric-value">${data.weeklyVisits || 0}</strong>
                <span class="metric-link">Ver todas →</span>
            </button>
            <button class="metric-card metric-card-green" data-nav="proposals" type="button">
                <span class="metric-label">Propostas abertas</span>
                <strong class="metric-value">${data.openProposals || 0}</strong>
                <span class="metric-link">Em acompanhamento →</span>
            </button>
            <button class="metric-card metric-card-orange" data-nav="proposals" type="button">
                <span class="metric-label">Propostas sem atualização</span>
                <strong class="metric-value">${data.overdueProposals || 0}</strong>
                <span class="metric-link">Pedem revisão →</span>
                ${(data.overdueProposals || 0) > 0 ? '<span class="metric-badge-urgent">Ação necessária</span>' : ''}
            </button>
            <button class="metric-card metric-card-green" data-nav="funil" type="button">
                <span class="metric-label">Funil ativo</span>
                <strong class="metric-value">${data.funilAtivo || 0}</strong>
                <span class="metric-link">Oportunidades em aberto →</span>
            </button>
            <button class="metric-card metric-card-orange" data-nav="funil" type="button">
                <span class="metric-label">Funil sem atualização</span>
                <strong class="metric-value">${data.overdueFunil || 0}</strong>
                <span class="metric-link">Pedem atenção →</span>
                ${(data.overdueFunil || 0) > 0 ? '<span class="metric-badge-urgent">Ação necessária</span>' : ''}
            </button>
            ${isAdminOrGerente ? `
            <button class="metric-card metric-card-blue" data-nav="visits" type="button">
                <span class="metric-label">Visitas da equipe</span>
                <strong class="metric-value">${data.teamWeeklyVisits || data.weeklyVisits || 0}</strong>
                <span class="metric-link">Ver equipe →</span>
            </button>` : ''}
        </div>

        <!-- Gráfico de visitas + meta (relatorio gerencial — so admin/gerente) -->
        ${(isAdminOrGerente && data.visitsByDay && data.visitsByDay.length > 0) ? `
        <p class="dash-section-heading" style="margin-top:1.5rem">Visitas — últimos 7 dias</p>
        <div class="dash-chart-card">
            ${renderVisitsBarChart(data.visitsByDay, data.metaVisitas || 0, data.weeklyVisits || 0)}
        </div>` : ''}

        ${(data.teamData && data.teamData.length > 0) ? `
        <p class="dash-section-heading" style="margin-top:1.5rem">Desempenho da equipe — esta semana</p>
        <div class="dash-team-table">
            ${data.teamData.sort((a, b) => b.visitas - a.visitas).map(member => `
                <div class="dash-team-row">
                    <span class="dash-team-name">${escapeHtml(member.vendedor)}</span>
                    <span class="dash-team-bar-wrap"><span class="dash-team-bar" style="width:${Math.min(100, Math.round(member.visitas / Math.max(...data.teamData.map(x => x.visitas)) * 100))}%"></span></span>
                    <span class="dash-team-count">${member.visitas}</span>
                </div>
            `).join('')}
        </div>` : ''}

        <!-- Painéis de atividade recente -->
        <p class="dash-section-heading" style="margin-top:1.5rem">Atividade recente</p>
        <div class="dash-panels-grid">
            <div class="dash-panel">
                <div class="section-title-row">
                    <h3 style="font-size:0.88rem;font-weight:700;margin:0">Visitas — últimos 7 dias</h3>
                    <button class="section-link-button" id="go-visits">Ver tudo</button>
                </div>
                ${renderRecentItems(recentVisits, 'Nenhuma visita recente.')}
            </div>
            <div class="dash-panel">
                <div class="section-title-row">
                    <h3 style="font-size:0.88rem;font-weight:700;margin:0">Propostas em atenção</h3>
                    <button class="section-link-button" id="go-proposals">Ver tudo</button>
                </div>
                ${renderRecentItems(recentProposals, 'Nenhuma proposta em destaque.', true)}
            </div>
            <div class="dash-panel">
                <div class="section-title-row">
                    <h3 style="font-size:0.88rem;font-weight:700;margin:0">Funil de vendas</h3>
                    <button class="section-link-button" id="go-funil">Ver tudo</button>
                </div>
                ${recentFunil.length === 0
                    ? '<p class="helper-text">Nenhuma oportunidade ativa.</p>'
                    : `<div class="recent-list">${recentFunil.map((f) => {
                        const dias = calculateDaysFromDisplayDate(f.atualizacao || f.data || '');
                        return `<div class="recent-item recent-item-proposal">
                            <div style="display:flex;flex-direction:column;gap:0.1rem;min-width:0;flex:1">
                                <strong style="font-size:0.85rem">${escapeHtml(f.cliente || '-')}</strong>
                                <span class="status-pill funil-status-${escapeHtml((f.status || '').toLowerCase())}" style="align-self:flex-start">${escapeHtml(f.status || '-')}</span>
                            </div>
                            ${dias > 0 ? `<span class="dias-atraso-badge">${dias}d sem atualização</span>` : ''}
                        </div>`;
                    }).join('')}</div>`
                }
            </div>
        </div>
    `;

    document.getElementById('go-agenda').addEventListener('click',    () => navigateTo('calendar'));
    document.getElementById('go-agenda-retornos')?.addEventListener('click', () => navigateTo('calendar'));
    document.getElementById('go-contratos').addEventListener('click', () => navigateTo('contratos'));
    document.getElementById('go-report').addEventListener('click',    () => navigateTo('report'));
    document.getElementById('go-visits').addEventListener('click',    () => navigateTo('visits'));
    document.getElementById('go-proposals').addEventListener('click', () => navigateTo('proposals'));
    document.getElementById('go-funil').addEventListener('click',     () => navigateTo('funil'));
    document.getElementById('qa-new-visit').addEventListener('click',     () => navigateTo('visit-new'));
    document.getElementById('qa-new-proposal').addEventListener('click',  () => navigateTo('proposal-new'));
    document.getElementById('qa-new-funil').addEventListener('click',     () => navigateTo('funil-new'));
    document.getElementById('logout-button').addEventListener('click', logout);
    mainContent.querySelectorAll('.metric-card[data-nav]').forEach((el) => {
        el.addEventListener('click', () => {
            const nav = el.dataset.nav;
            if (nav === 'proposals' || nav === 'funil') {
                state.navLoadAll = nav;
            }
            navigateTo(nav);
        });
    });

    // Refresh header notification dot after data loads
    updateHeaderUI(user);
    updateProposalsBadge(recentProposals.length);
    updateFunilBadge(data.overdueFunil || 0);

    if (state.newItemNotification) {
        const notif = state.newItemNotification;
        state.newItemNotification = null;
        setTimeout(() => {
            showSuccessPopup(`${notif.tipo} adicionado${notif.tipo === 'Proposta' ? 'a' : ''} com sucesso!${notif.cliente ? '\n' + notif.cliente : ''}`);
        }, 300);
    }
}


export async function renderDashboard() {
    const mainContent = document.getElementById('main-content');
    const cached = loadCache('dashboard');
    if (cached) {
        fillDashboard(mainContent, cached, state.currentUser);
    } else {
        fillDashboard(mainContent, buildLocalDashboardData(), state.currentUser);
        const pageHeader = mainContent.querySelector('.page-header');
        if (pageHeader) {
            pageHeader.insertAdjacentHTML('afterend', '<div class="sync-banner"><span class="sync-spinner"></span><span>Atualizando dashboard...</span></div>');
        }
    }
    const result = await getDashboardData();
    if (result.status === 'success' && document.getElementById('main-content') === mainContent) {
        if (result.data.loadDias) { state.loadDias = result.data.loadDias; }
        fillDashboard(mainContent, result.data, state.currentUser);
    } else if (!cached) {
        fillDashboard(mainContent, buildLocalDashboardData(), state.currentUser);
    }
    warmListCaches();
}


export function renderRecentItems(items = [], emptyText, proposalMode = false) {
    if (!items || items.length === 0) {
        return `<p class="helper-text">${escapeHtml(emptyText)}</p>`;
    }
    return `
        <div class="recent-list">
            ${items.map((item) => proposalMode
                ? `<div class="recent-item recent-item-proposal">
                    <div style="display:flex;flex-direction:column;gap:0.15rem;min-width:0;flex:1">
                        <strong style="font-size:0.88rem">${escapeHtml(item.cliente || '-')}</strong>
                        ${item.foco ? `<span style="font-size:0.75rem;color:var(--text-muted-strong)">${escapeHtml(item.foco)}</span>` : ''}
                        <span style="font-size:0.72rem;color:var(--text-muted-strong)">Atualiz.: ${escapeHtml(item.atualizacao || '-')}</span>
                    </div>
                    <span class="dias-atraso-badge">${item.diasAtraso || 0} dias sem atualização</span>
                   </div>`
                : `<div class="recent-item">
                    <div style="display:flex;flex-direction:column;gap:0.1rem;min-width:0;flex:1">
                        <strong style="font-size:0.88rem">${escapeHtml(item.cliente || '-')}</strong>
                        ${item.tipoVisita ? `<span class="${visitTypeClass(item.tipoVisita)}" style="align-self:flex-start">${escapeHtml(item.tipoVisita)}</span>` : ''}
                    </div>
                    <span style="font-size:0.75rem;color:var(--text-muted-strong);white-space:nowrap">${escapeHtml(item.dataVisita || '-')}</span>
                   </div>`
            ).join('')}
        </div>
    `;
}


export function renderVisitsBarChart(visitsByDay, meta, weeklyTotal) {
    if (!visitsByDay || visitsByDay.length === 0) return '';
    const maxCount = Math.max(...visitsByDay.map(d => d.count), meta || 0, 1);
    const dayLabels = ['D', 'S', 'T', 'Q', 'Q', 'S', 'S'];
    const bars = visitsByDay.map((d, i) => {
        const pct = Math.round(d.count / maxCount * 100);
        const dow = new Date(d.date + 'T12:00:00').getDay();
        return `
            <div class="chart-bar-col">
                <span class="chart-bar-count">${d.count > 0 ? d.count : ''}</span>
                <div class="chart-bar-wrap">
                    <div class="chart-bar-fill ${d.count === 0 ? 'chart-bar-empty' : ''}" style="height:${pct}%"></div>
                </div>
                <span class="chart-bar-label">${dayLabels[dow]}</span>
            </div>`;
    }).join('');
    const metaLine = meta > 0 ? `<div class="chart-meta-label">Meta: ${meta}/semana · Atual: ${weeklyTotal}</div>` : '';
    const progressBar = meta > 0 ? `<div class="chart-progress-wrap"><div class="chart-progress-fill" style="width:${Math.min(100, Math.round(weeklyTotal / meta * 100))}%"></div></div>` : '';
    return `<div class="chart-bars">${bars}</div>${metaLine}${progressBar}`;
}
