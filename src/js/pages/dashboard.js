import { state, navigateTo } from '../app.js';
import { callAPI, loadCache, getDashboardData, buildLocalDashboardData, warmListCaches } from '../api.js';
import { escapeHtml, normalizeVisit, normalizeProposal, calculateDaysFromDisplayDate, visitTypeClass, parseDisplayDate } from '../utils/format.js';
import { updateHeaderUI, updateProposalsBadge, updateFunilBadge, refreshNotificacoesBadge, checkOverdueNotification, checkClientesPrincipaisNotification, hasInstallPrompt, consumeInstallPrompt, NAV_ICON_SVG, useClassicInicio, setClassicInicio, resetNavCache, renderNavigation } from '../utils/ui.js';
import { showSuccessPopup, showToast, setSaving } from '../utils/dom.js';
import { isPushSupported, isAppInstalled, isIOS, enablePush } from '../utils/push.js';

// Texto curto de "o que essa tela faz" pro botão (i) de cada card — pedido
// explícito: ajudar vendedor/gerente novo a entender a navegação sem
// precisar perguntar. Aparece como uma linha curta dentro do card (antes era
// um (i) com tooltip, que no celular ninguém conseguia ler).
const TILE_DESCRICOES = {
    visits: 'Registre uma visita feita a um cliente',
    calendar: 'Compromissos e retornos agendados',
    notificacoes: 'Avisos e atualizações do sistema',
    lembretes: 'Tarefas administrativas com data',
    proposals: 'Propostas enviadas aos clientes',
    funil: 'Oportunidades de venda em andamento',
    contratos: 'Contratos assinados e vencimentos',
    manutencao: 'Relatórios de manutenção nos clientes',
    report: 'Métricas e exportações',
    radar: 'Encontre e reserve novos clientes na região',
    campanhas: 'Avisos e pesquisas pro time responder',
    admin: 'Usuários, equipe e configurações do app'
};

// Cor do ícone de cada card — só decoração/escaneabilidade (bate com os
// mesmos tons já usados no painel do robô de WhatsApp pras categorias
// equivalentes), não tem significado além disso.
const TILE_CORES = {
    visits: '#2563eb', calendar: '#7c3aed', notificacoes: '#dc2626', lembretes: '#d97706',
    proposals: '#0891b2', funil: '#4f46e5', contratos: '#0d9488', manutencao: '#ea580c',
    report: '#475569', radar: '#16a34a', campanhas: '#db2777', admin: '#334155'
};

// "!" vermelho no canto do card = essa tela precisa da atenção do usuário
// (proposta/funil parado, contrato vencendo, retorno atrasado...).
const ATENCAO_BADGE = '<span class="atencao-badge" role="img" aria-label="Precisa da sua atenção">!</span>';

function acessarTileHtml({ nav, label, stat, urgent, extraOnClick }) {
    const info = TILE_DESCRICOES[nav] || '';
    const cor = TILE_CORES[nav] || '#64748b';
    const icon = NAV_ICON_SVG[nav] || '';
    return `
        <button type="button" class="acessar-tile" data-nav="${nav}"${extraOnClick ? ` data-nav-all="${extraOnClick}"` : ''}>
            ${urgent ? ATENCAO_BADGE : ''}
            <span class="acessar-tile-icon" style="background:${cor}" aria-hidden="true">${icon}</span>
            <span class="acessar-tile-text">
                <strong class="acessar-tile-label">${escapeHtml(label)}</strong>
                ${info ? `<span class="acessar-tile-desc">${escapeHtml(info)}</span>` : ''}
                ${stat ? `<span class="acessar-tile-stat${urgent ? ' is-urgent' : ''}">${escapeHtml(stat)}</span>` : ''}
            </span>
        </button>`;
}

// Grade de atalho ("Acessar") — um card por tela que esse usuário enxerga,
// cada um já com um número rápido (quando existe um que faça sentido sem
// precisar buscar dado novo nenhum — reaproveita só o que o Início já
// carrega). Mesma regra de telas escondidas (Admin → editar usuário) que a
// navegação já usa, pra nunca oferecer atalho pra tela que esse usuário
// não pode abrir.
function renderAcessarSection(data, user) {
    const telasBloqueadas = data.telasBloqueadas || [];
    const isAdminOrGerente = ['admin', 'gerente'].includes((user.profile || '').toLowerCase());
    const isAdmin = (user.profile || '').toLowerCase() === 'admin';

    const todayStr = (() => { const d = new Date(); return String(d.getDate()).padStart(2, '0') + '/' + String(d.getMonth() + 1).padStart(2, '0') + '/' + d.getFullYear(); })();
    const todayVisitsCount = ((data.recentVisits || []).map(normalizeVisit)).filter((v) => v.dataVisita === todayStr).length;

    const tiles = [];
    if (!telasBloqueadas.includes('visits')) {
        tiles.push(acessarTileHtml({ nav: 'visits', label: 'Visitas', stat: `${data.weeklyVisits || 0} esta semana` }));
    }
    if (!telasBloqueadas.includes('calendar')) {
        tiles.push(acessarTileHtml({ nav: 'calendar', label: 'Agenda', stat: todayVisitsCount ? `${todayVisitsCount} hoje` : 'Nada marcado hoje' }));
    }
    tiles.push(acessarTileHtml({ nav: 'notificacoes', label: 'Notificações' }));
    if (!telasBloqueadas.includes('lembretes')) {
        tiles.push(acessarTileHtml({ nav: 'lembretes', label: 'Lembretes' }));
    }
    if (!telasBloqueadas.includes('proposals')) {
        const overdue = data.overdueProposals || 0;
        tiles.push(acessarTileHtml({ nav: 'proposals', label: 'Propostas', stat: overdue ? `${overdue} atrasada(s)` : `${data.openProposals || 0} aberta(s)`, urgent: overdue > 0, extraOnClick: 'proposals' }));
    }
    if (!telasBloqueadas.includes('funil')) {
        const overdue = data.overdueFunil || 0;
        tiles.push(acessarTileHtml({ nav: 'funil', label: 'Funil', stat: overdue ? `${overdue} parado(s)` : `${data.funilAtivo || 0} ativo(s)`, urgent: overdue > 0, extraOnClick: 'funil' }));
    }
    if (!telasBloqueadas.includes('contratos')) {
        const venceEmBreve = data.contratosVenceEmBreve || 0;
        tiles.push(acessarTileHtml({ nav: 'contratos', label: 'Contratos', stat: venceEmBreve ? `${venceEmBreve} vencendo` : `${data.contratosTotal || 0} contrato(s)`, urgent: venceEmBreve > 0 }));
    }
    if (!telasBloqueadas.includes('manutencao')) {
        tiles.push(acessarTileHtml({ nav: 'manutencao', label: 'Manutenção' }));
    }
    if (!telasBloqueadas.includes('report')) {
        tiles.push(acessarTileHtml({ nav: 'report', label: 'Relatório' }));
    }
    if (data.canAccessRadar) {
        tiles.push(acessarTileHtml({ nav: 'radar', label: 'Radar', stat: `${data.radarClientesProspeccao || 0} em prospecção` }));
    }
    if (isAdminOrGerente) {
        const pendentes = data.campanhasPendentes || 0;
        tiles.push(acessarTileHtml({ nav: 'campanhas', label: 'Campanhas', stat: pendentes ? `${pendentes} aguardando` : `${data.campanhasTotal || 0} criada(s)`, urgent: pendentes > 0 }));
    }
    if (isAdmin) {
        tiles.push(acessarTileHtml({ nav: 'admin', label: 'Admin' }));
    }

    return `
        <div class="section-title-row" style="margin-top:0.2rem">
            <p class="dash-section-heading" style="margin:0">Acessar</p>
        </div>
        <div class="acessar-grid">${tiles.join('')}</div>`;
}

// "Visão geral" — métricas + gráfico de 7 dias + ranking da equipe +
// atividade recente. Morava no Início; a pedido do Bruno, mudou pro
// Relatório (ver pages/report.js → renderReportPage), que é de onde ela é
// chamada agora. Só continua aparecendo no Início pra quem está no Início
// clássico (ver useClassicInicio em fillDashboard) — pra essas pessoas
// nada muda, é a mesma tela de sempre.
export function renderVisaoGeralSection(data, user, recentProposals, recentVisits, recentFunil) {
    const isAdminOrGerente = ['admin', 'gerente'].includes((user.profile || '').toLowerCase());
    return `
        <!-- Métricas -->
        <div class="section-title-row" style="margin-top:0.4rem">
            <p class="dash-section-heading" style="margin:0">Visão geral</p>
        </div>
        <div class="dash-metric-group">
            <p class="dash-metric-group-label">Visitas</p>
            <div class="metrics-grid">
                <button class="metric-card metric-card-blue" data-nav="visits" type="button">
                    <span class="metric-label">Na semana</span>
                    <strong class="metric-value">${data.weeklyVisits || 0}</strong>
                </button>
                ${isAdminOrGerente ? `
                <button class="metric-card metric-card-blue" data-nav="visits" type="button">
                    <span class="metric-label">Da equipe (semana)</span>
                    <strong class="metric-value">${data.teamWeeklyVisits || data.weeklyVisits || 0}</strong>
                </button>` : ''}
            </div>
        </div>

        <div class="dash-metric-group">
            <p class="dash-metric-group-label">Propostas</p>
            <div class="metrics-grid">
                <button class="metric-card metric-card-green" data-nav="proposals" type="button">
                    <span class="metric-label">Abertas</span>
                    <strong class="metric-value">${data.openProposals || 0}</strong>
                </button>
                <button class="metric-card metric-card-orange" data-nav="proposals" type="button">
                    <span class="metric-label">Sem atualização</span>
                    <strong class="metric-value">${data.overdueProposals || 0}</strong>
                    ${(data.overdueProposals || 0) > 0 ? '<span class="metric-badge-urgent">Ação necessária</span>' : ''}
                </button>
            </div>
        </div>

        <div class="dash-metric-group">
            <p class="dash-metric-group-label">Funil</p>
            <div class="metrics-grid">
                <button class="metric-card metric-card-green" data-nav="funil" type="button">
                    <span class="metric-label">Ativo</span>
                    <strong class="metric-value">${data.funilAtivo || 0}</strong>
                </button>
                <button class="metric-card metric-card-orange" data-nav="funil" type="button">
                    <span class="metric-label">Sem atualização</span>
                    <strong class="metric-value">${data.overdueFunil || 0}</strong>
                    ${(data.overdueFunil || 0) > 0 ? '<span class="metric-badge-urgent">Ação necessária</span>' : ''}
                </button>
                <button class="metric-card metric-card-blue" id="dash-funil-diversey" data-nav="funil" type="button">
                    <span class="metric-label">⭐ Funil Diversey</span>
                    <strong class="metric-value">${data.funilDiversey || 0}</strong>
                </button>
            </div>
        </div>

        ${!(data.telasBloqueadas || []).includes('contratos') ? `
        <div class="dash-metric-group">
            <p class="dash-metric-group-label">Contratos</p>
            <div class="metrics-grid">
                <button class="metric-card metric-card-blue" data-nav="contratos" type="button">
                    <span class="metric-label">Total</span>
                    <strong class="metric-value">${data.contratosTotal || 0}</strong>
                </button>
                <button class="metric-card metric-card-orange" data-nav="contratos" type="button">
                    <span class="metric-label">Vencidos</span>
                    <strong class="metric-value">${data.contratosVencidos || 0}</strong>
                </button>
                <button class="metric-card metric-card-orange" data-nav="contratos" type="button">
                    <span class="metric-label">Vencem em 30 dias</span>
                    <strong class="metric-value">${data.contratosVenceEmBreve || 0}</strong>
                    ${(data.contratosVenceEmBreve || 0) > 0 ? '<span class="metric-badge-urgent">Atenção</span>' : ''}
                </button>
            </div>
        </div>` : ''}

        ${isAdminOrGerente ? `
        <div class="dash-metric-group">
            <p class="dash-metric-group-label">Campanhas</p>
            <div class="metrics-grid">
                <button class="metric-card metric-card-blue" data-nav="campanhas" type="button">
                    <span class="metric-label">Links criados</span>
                    <strong class="metric-value">${data.campanhasTotal || 0}</strong>
                </button>
                <button class="metric-card metric-card-green" data-nav="campanhas" type="button">
                    <span class="metric-label">Respondidas</span>
                    <strong class="metric-value">${data.campanhasRespondidas || 0}</strong>
                </button>
                <button class="metric-card metric-card-orange" data-nav="campanhas" type="button">
                    <span class="metric-label">Não respondidas</span>
                    <strong class="metric-value">${data.campanhasPendentes || 0}</strong>
                    ${(data.campanhasPendentes || 0) > 0 ? '<span class="metric-badge-urgent">Ação necessária</span>' : ''}
                </button>
            </div>
        </div>` : ''}

        ${data.canAccessRadar ? `
        <div class="dash-metric-group">
            <p class="dash-metric-group-label">Radar</p>
            <div class="metrics-grid">
                <button class="metric-card metric-card-orange" id="radar-prospeccao-card" type="button">
                    <span class="metric-label">Em prospecção</span>
                    <strong class="metric-value">${data.radarClientesProspeccao || 0}</strong>
                </button>
                <button class="metric-card metric-card-blue" id="radar-carteira-card" type="button">
                    <span class="metric-label">Minha carteira</span>
                    <strong class="metric-value">${data.radarClientesCarteira || 0}</strong>
                </button>
            </div>
        </div>` : ''}

        <!-- Gráfico de visitas + meta (relatorio gerencial — so admin/gerente) -->
        ${(isAdminOrGerente && data.visitsByDay && data.visitsByDay.length > 0) ? `
        <p class="dash-section-heading" style="margin-top:1.1rem">Visitas — últimos 7 dias</p>
        <div class="dash-chart-card">
            ${renderVisitsBarChart(data.visitsByDay, data.metaVisitas || 0, data.weeklyVisits || 0)}
        </div>` : ''}

        ${(data.teamData && data.teamData.length > 0) ? `
        <p class="dash-section-heading" style="margin-top:1.1rem">Desempenho da equipe — esta semana</p>
        <div class="dash-team-table">
            ${data.teamData.sort((a, b) => b.visitas - a.visitas).map(member => `
                <div class="dash-team-row">
                    <span class="dash-team-name">${escapeHtml(member.vendedor)}</span>
                    <span class="dash-team-bar-wrap"><span class="dash-team-bar" style="width:${Math.min(100, Math.round(member.visitas / Math.max(...data.teamData.map(x => x.visitas)) * 100))}%"></span></span>
                    <span class="dash-team-count">${member.visitas}</span>
                </div>
            `).join('')}
        </div>` : ''}

        ${(data.teamRanking && data.teamRanking.length > 0) ? `
        <p class="dash-section-heading" style="margin-top:1.1rem">Ranking do mês — Meta de visitas</p>
        <div class="dash-team-table">
            ${data.teamRanking.map((r, i) => `
                <div class="dash-ranking-row" title="Projeção do mês: ${r.projecao} visitas">
                    <span class="dash-ranking-rank${i < 3 ? ' dash-ranking-rank-' + (i + 1) : ''}">${i + 1}º</span>
                    <span class="dash-team-name">${escapeHtml(r.vendedor)}</span>
                    <span class="dash-ranking-figures">${r.realizado}${r.meta > 0 ? ` <span class="dash-ranking-meta">/ ${r.meta}</span>` : ''}</span>
                    ${r.percentual !== null
                        ? `<span class="dash-ranking-pct ${r.percentual >= 100 ? 'is-ok' : r.percentual >= 60 ? 'is-warn' : 'is-low'}">${r.percentual}%</span>`
                        : '<span class="dash-ranking-pct is-neutral">sem meta</span>'}
                </div>
            `).join('')}
        </div>` : ''}

        <!-- Atividade recente — um painel só, com abas -->
        <p class="dash-section-heading" style="margin-top:1.1rem">Atividade recente</p>
        <div class="dash-activity">
            <div class="dash-activity-tabs" role="tablist">
                <button type="button" class="dash-activity-tab is-active" data-act="visits">Visitas</button>
                <button type="button" class="dash-activity-tab" data-act="proposals">Propostas${recentProposals.length ? ` <span class="dash-activity-tab-n">${recentProposals.length}</span>` : ''}</button>
                <button type="button" class="dash-activity-tab" data-act="funil">Funil</button>
            </div>
            <div class="dash-activity-pane is-active" data-pane="visits">
                ${renderRecentItems(recentVisits, 'Nenhuma visita nos últimos 7 dias.')}
            </div>
            <div class="dash-activity-pane" data-pane="proposals" hidden>
                ${renderRecentItems(recentProposals, 'Nenhuma proposta em atenção.', true)}
            </div>
            <div class="dash-activity-pane" data-pane="funil" hidden>
                ${recentFunil.length === 0
                    ? '<p class="helper-text">Nenhuma oportunidade em atenção.</p>'
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
            <button type="button" class="section-link-button dash-activity-more" id="go-activity">Ver tudo →</button>
        </div>`;
}

// Liga os cliques da Visão Geral (cards de métrica, radar, abas da
// Atividade recente) — chamado tanto pelo Início (fillDashboard, só quando
// useClassicInicio) quanto pelo Relatório (renderReportPage), que é quem
// desenhou renderVisaoGeralSection acima. querySelectorAll com 0 resultado
// não quebra nada, mas go-activity é pego por id — por isso o `?.` nele.
export function wireVisaoGeralEvents(container, recentProposals, recentFunil) {
    container.querySelectorAll('.metric-card[data-nav]').forEach((el) => {
        el.addEventListener('click', () => {
            const nav = el.dataset.nav;
            if (nav === 'proposals' || nav === 'funil') {
                state.navLoadAll = nav;
            }
            navigateTo(nav);
        });
    });
    container.querySelector('#radar-prospeccao-card')?.addEventListener('click', () => navigateTo('radar', { tab: 'meus-clientes' }));
    container.querySelector('#radar-carteira-card')?.addEventListener('click', () => navigateTo('radar', { tab: 'meus-clientes' }));

    let activeAct = 'visits';
    const actTabs  = container.querySelectorAll('.dash-activity-tab');
    const actPanes = container.querySelectorAll('.dash-activity-pane');
    actTabs.forEach((tab) => tab.addEventListener('click', () => {
        activeAct = tab.dataset.act;
        actTabs.forEach((t) => t.classList.toggle('is-active', t === tab));
        actPanes.forEach((p) => {
            const on = p.dataset.pane === activeAct;
            p.classList.toggle('is-active', on);
            p.hidden = !on;
        });
    }));
    container.querySelector('#go-activity')?.addEventListener('click', () => {
        if (activeAct === 'visits') { navigateTo('visits'); return; }
        state.navLoadAll = activeAct;
        navigateTo(activeAct);
    });
}

// Ícones dos botões de "Seu dia" (Início novo) — mesmo traço dos ícones
// da grade "Acessar" (NAV_ICON_SVG), só que esses dois não são telas.
const SEUDIA_ICON = {
    hoje: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
    retornos: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.5 15a9 9 0 1 0 2.1-9.4L1 10"/></svg>',
    agendar: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><line x1="3" y1="10" x2="21" y2="10"/><line x1="8" y1="3" x2="8" y2="7"/><line x1="16" y1="3" x2="16" y2="7"/><line x1="12" y1="13" x2="12" y2="18"/><line x1="9.5" y1="15.5" x2="14.5" y2="15.5"/></svg>',
    relatorio: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 4h2a2 2 0 0 1 2 2v4"/><path d="M9 4H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h4"/><rect x="9" y="2" width="6" height="4" rx="1"/><line x1="9" y1="11" x2="15" y2="11"/><line x1="9" y1="15" x2="12" y2="15"/><path d="M18.4 13.6a1.9 1.9 0 0 1 2.7 2.7L16 21.4l-3.5.9.9-3.5z"/></svg>',
    chevron: '<svg class="seudia-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><polyline points="9 6 15 12 9 18"/></svg>'
};

// Janela que sobe de baixo (no computador fica centralizada) com a lista
// de "Hoje" ou dos "Próximos retornos". Fecha no X, tocando fora ou no Esc.
// corpoHtml já vem escapado (renderRecentItems / retornosListHtml).
function openInicioSheet({ titulo, subtitulo, urgente, cor, icone, corpoHtml, acoes = [] }) {
    document.querySelector('.inicio-sheet-overlay')?.remove();
    const overlay = document.createElement('div');
    overlay.className = 'inicio-sheet-overlay';
    overlay.innerHTML = `
        <div class="inicio-sheet" role="dialog" aria-modal="true" aria-label="${escapeHtml(titulo)}">
            <span class="inicio-sheet-handle" aria-hidden="true"></span>
            <div class="inicio-sheet-head">
                <span class="acessar-tile-icon" style="background:${cor}" aria-hidden="true">${icone}</span>
                <span class="inicio-sheet-titles">
                    <strong>${escapeHtml(titulo)}</strong>
                    <span class="inicio-sheet-sub${urgente ? ' is-urgent' : ''}">${escapeHtml(subtitulo)}</span>
                </span>
                <button type="button" class="inicio-sheet-close" aria-label="Fechar">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>
                </button>
            </div>
            <div class="inicio-sheet-body">${corpoHtml}</div>
            ${acoes.length ? `<div class="inicio-sheet-actions" style="grid-template-columns:repeat(${acoes.length},minmax(0,1fr))">
                ${acoes.map((a, i) => `<button type="button" class="${a.primary ? 'primary-button' : 'secondary-button'}" data-acao="${i}">${escapeHtml(a.label)}</button>`).join('')}
            </div>` : ''}
        </div>`;
    document.body.appendChild(overlay);
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
    document.addEventListener('keydown', onKey);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    overlay.querySelector('.inicio-sheet-close').addEventListener('click', close);
    overlay.querySelectorAll('[data-acao]').forEach((btn) => btn.addEventListener('click', () => {
        close();
        acoes[Number(btn.dataset.acao)].onClick();
    }));
    requestAnimationFrame(() => overlay.classList.add('is-open'));
    overlay.querySelector('.inicio-sheet-close').focus({ preventScroll: true });
}

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
    checkOverdueNotification(state.overdueProposals, state.overdueFunil);
    checkClientesPrincipaisNotification(data.clientesPrincipaisPendentes);

    const isAdminOrGerente = ['admin','gerente'].includes((user.profile || '').toLowerCase());

    const todayStr = (() => { const d = new Date(); return String(d.getDate()).padStart(2,'0') + '/' + String(d.getMonth()+1).padStart(2,'0') + '/' + d.getFullYear(); })();
    const todayVisits = recentVisits.filter((v) => v.dataVisita === todayStr);

    const proximos = data.proximosAgendamentos || [];
    const retornosListHtml = proximos.length === 0
        ? '<p class="helper-text">Nenhum retorno agendado.</p>'
        : `<div class="recent-list">
            ${proximos.map((a) => {
                const dias = -calculateDaysFromDisplayDate(a.dataAgendada);
                const diasLabel = dias === 0 ? 'Hoje' : dias === 1 ? 'Amanhã' : dias > 0 ? `Em ${dias} dias` : 'Atrasado';
                const diasCor = dias < 0 ? 'erro' : dias <= 1 ? 'apresentacao' : 'preventiva';
                return `<div class="recent-item recent-item-proposal">
                    <div style="display:flex;flex-direction:column;gap:0.1rem;min-width:0;flex:1">
                        <strong style="font-size:0.85rem">${escapeHtml(a.cliente || '-')}</strong>
                        <span class="helper-text" style="margin:0">${escapeHtml(a.cidade || '-')}</span>
                    </div>
                    <span class="status-tag ${diasCor}">${diasLabel}</span>
                </div>`;
            }).join('')}
        </div>`;
    const retornosAtrasados = proximos.filter((a) => calculateDaysFromDisplayDate(a.dataAgendada) > 0).length;
    const hojeListHtml = todayVisits.length === 0
        ? '<p class="helper-text">Nenhuma visita registrada hoje ainda.</p>'
        : renderRecentItems(todayVisits, '');

    // Início novo: "Seu dia" — dois botões no mesmo estilo da grade
    // "Acessar"; cada um abre uma janela de baixo pra cima (ver
    // openInicioSheet) com a lista do dia / dos retornos, em vez de ocupar
    // a tela inteira com os cards de antes.
    const seuDiaHtml = `
        <div class="section-title-row" style="margin-top:0.2rem">
            <p class="dash-section-heading" style="margin:0">Seu dia</p>
        </div>
        <div class="seudia-grid">
            <button type="button" class="seudia-tile seudia-hoje" id="seudia-hoje">
                <span class="seudia-tile-top">
                    <span class="acessar-tile-icon" style="background:#0284c7" aria-hidden="true">${SEUDIA_ICON.hoje}</span>
                    ${SEUDIA_ICON.chevron}
                </span>
                <span class="seudia-tile-text">
                    <strong class="acessar-tile-label">Hoje</strong>
                    <span class="acessar-tile-desc">Visitas registradas hoje</span>
                    <span class="seudia-tile-stat"><strong>${todayVisits.length}</strong> visita${todayVisits.length === 1 ? '' : 's'} · ${todayStr.slice(0, 5)}</span>
                </span>
            </button>
            <button type="button" class="seudia-tile seudia-retornos${retornosAtrasados ? ' is-urgent' : ''}" id="seudia-retornos">
                <span class="seudia-tile-top">
                    <span class="acessar-tile-icon" style="background:#e11d48" aria-hidden="true">${SEUDIA_ICON.retornos}</span>
                    ${retornosAtrasados ? ATENCAO_BADGE.replace('atencao-badge', 'atencao-badge is-inline') : SEUDIA_ICON.chevron}
                </span>
                <span class="seudia-tile-text">
                    <strong class="acessar-tile-label">Próximos retornos</strong>
                    <span class="acessar-tile-desc">Clientes pra voltar a visitar</span>
                    <span class="seudia-tile-stat">${retornosAtrasados
                        ? `<strong>${retornosAtrasados}</strong> atrasado${retornosAtrasados === 1 ? '' : 's'}`
                        : `<strong>${proximos.length}</strong> agendado${proximos.length === 1 ? '' : 's'}`}</span>
                </span>
            </button>
        </div>
        <button type="button" class="seudia-relatorio" id="seudia-agendar">
            <span class="seudia-relatorio-icon" aria-hidden="true">${SEUDIA_ICON.relatorio}</span>
            <span class="seudia-relatorio-text">
                <strong>Preencher relatório de visita</strong>
                <span>Registre o que foi feito no cliente</span>
            </span>
            <span class="seudia-relatorio-arrow" aria-hidden="true">${SEUDIA_ICON.chevron}</span>
        </button>`;

    const clientesPrincipaisHtml = `
        ${(data.clientesPrincipaisPendentes && data.clientesPrincipaisPendentes.length > 0) ? `
        <div class="dash-today-card dash-cp-card dash-cp-collapsed" id="dash-cp-card" style="margin-top:0.5rem">
            <button type="button" class="dash-cp-toggle" id="dash-cp-toggle" aria-expanded="false" aria-controls="dash-cp-body">
                <span class="dash-cp-title">⭐ Clientes principais sem relatório este mês</span>
                <span class="dash-cp-count" aria-label="${data.clientesPrincipaisPendentes.length} pendente(s)">${data.clientesPrincipaisPendentes.length}</span>
                <span class="dash-cp-chevron" aria-hidden="true">▾</span>
            </button>
            <div class="recent-list" id="dash-cp-body">
                ${data.clientesPrincipaisPendentes.map((c) => `
                    <div class="recent-item recent-item-proposal">
                        <div style="display:flex;flex-direction:column;gap:0.1rem;min-width:0;flex:1">
                            <strong style="font-size:0.85rem;overflow-wrap:break-word">${escapeHtml(c.cliente)}</strong>
                        </div>
                        <button type="button" class="mini-button dash-cp-report-btn" data-cliente="${escapeHtml(c.cliente)}">Fazer relatório</button>
                    </div>
                `).join('')}
            </div>
        </div>` : ''}
    `;

    const quickActionsHtml = `
        <!-- Ações rápidas -->
        <div class="dash-actions-bar">
            <button type="button" class="text-link" id="qa-new-visit">📋 Nova Visita</button>
            ${state.canCreateProposalFunil ? '<button type="button" class="text-link" id="qa-new-proposal">📄 Nova Proposta</button>' : ''}
            ${state.canCreateProposalFunil ? '<button type="button" class="text-link" id="qa-new-funil">📊 Nova Oportunidade</button>' : ''}
            ${user.profile && String(user.profile).toLowerCase() === 'admin' ? '<button type="button" class="text-link" id="qa-resumo-diario">📋 Resumo de ontem</button>' : ''}
        </div>
    `;

    // Início clássico: Ações rápidas + Hoje + Próximos retornos + Clientes
    // principais, como sempre foi, antes da Visão geral. No Início novo
    // Hoje/Retornos viram os botões de "Seu dia" (seuDiaHtml).
    const resumoDoDiaHtml = `
        ${quickActionsHtml}

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
        <div class="dash-today-card" style="margin-top:0.5rem">
            <div class="section-title-row">
                <h3 style="font-size:0.88rem;font-weight:700;margin:0">📌 Próximos retornos</h3>
                <button class="section-link-button" id="go-agenda-retornos">Ver agenda →</button>
            </div>
            ${retornosListHtml}
        </div>` : ''}

        ${clientesPrincipaisHtml}
    `;

    mainContent.innerHTML = `
        <div class="page-header page-header-hero" style="margin-bottom:0.6rem">
            <div>
                <h2>Início</h2>
                <p class="page-subtitle" style="margin:0.1rem 0 0">${(() => { const h = new Date().getHours(); return h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite'; })()}, ${escapeHtml(user.name.split(' ')[0])} 👋</p>
            </div>
        </div>

        <p class="inicio-view-toggle">${useClassicInicio()
            ? 'Está no Início clássico. <button type="button" id="inicio-toggle-view">Experimentar o novo Início →</button>'
            : 'Prefere o Início de antes? <button type="button" id="inicio-toggle-view">Voltar pro Início clássico →</button>'}</p>

        <div class="card push-banner" id="push-banner" hidden>
            <div class="push-banner-text">
                <strong class="push-banner-title"></strong>
                <p class="helper-text push-banner-desc" style="margin:0.2rem 0 0"></p>
            </div>
            <div class="push-banner-actions">
                <button type="button" class="mini-button" id="push-banner-dismiss">Agora não</button>
                <button type="button" class="primary-button" id="push-banner-install" style="width:auto" hidden>Instalar app</button>
                <button type="button" class="primary-button" id="push-banner-enable" style="width:auto" hidden>Ativar notificações</button>
            </div>
        </div>

        ${state.canCreateProposalFunil ? '<div id="visitas-sinalizadas-card"></div>' : ''}

        ${useClassicInicio() ? resumoDoDiaHtml : `
            ${seuDiaHtml}
            ${renderAcessarSection(data, user)}
            ${clientesPrincipaisHtml}`}


        ${useClassicInicio() ? renderVisaoGeralSection(data, user, recentProposals, recentVisits, recentFunil) : ''}
    `;

    document.getElementById('go-agenda')?.addEventListener('click',    () => navigateTo('calendar'));
    document.getElementById('go-agenda-retornos')?.addEventListener('click', () => navigateTo('calendar', { filter: 'retornos' }));
    document.getElementById('inicio-toggle-view')?.addEventListener('click', () => {
        setClassicInicio(!useClassicInicio());
        // A troca também muda a barra de baixo (só "Início" no Início novo,
        // ver renderNavigation) — sem isso ela só atualizaria na próxima
        // navegação/login, deixando a barra "atrasada" em relação à tela.
        resetNavCache();
        renderNavigation();
        renderDashboard();
    });
    if (useClassicInicio()) { wireVisaoGeralEvents(mainContent, recentProposals, recentFunil); }

    document.getElementById('seudia-hoje')?.addEventListener('click', () => openInicioSheet({
        titulo: 'Hoje',
        subtitulo: `${todayStr} · ${todayVisits.length} visita${todayVisits.length === 1 ? '' : 's'}`,
        cor: '#0284c7',
        icone: SEUDIA_ICON.hoje,
        corpoHtml: hojeListHtml,
        acoes: [
            { label: 'Ver agenda', onClick: () => navigateTo('calendar') },
            { label: '+ Nova visita', primary: true, onClick: () => navigateTo('visit-new') }
        ]
    }));
    // Mesma tela do "+ Nova Visita" da tela Visitas (formulário de visita).
    document.getElementById('seudia-agendar')?.addEventListener('click', () => navigateTo('visit-new'));
    document.getElementById('seudia-retornos')?.addEventListener('click', () => openInicioSheet({
        titulo: 'Próximos retornos',
        subtitulo: retornosAtrasados
            ? `${retornosAtrasados} atrasado${retornosAtrasados === 1 ? '' : 's'}`
            : `${proximos.length} agendado${proximos.length === 1 ? '' : 's'}`,
        urgente: retornosAtrasados > 0,
        cor: '#e11d48',
        icone: SEUDIA_ICON.retornos,
        corpoHtml: retornosListHtml,
        acoes: [
            { label: 'Ver agenda completa', primary: true, onClick: () => navigateTo('calendar', { filter: 'retornos' }) }
        ]
    }));

    document.getElementById('qa-new-visit')?.addEventListener('click',     () => navigateTo('visit-new'));
    document.getElementById('qa-new-proposal')?.addEventListener('click', () => navigateTo('proposal-new'));
    document.getElementById('qa-new-funil')?.addEventListener('click',    () => navigateTo('funil-new'));
    document.getElementById('qa-resumo-diario')?.addEventListener('click', () => showResumoDiarioModal());
    mainContent.querySelectorAll('.acessar-tile[data-nav]').forEach((el) => {
        el.addEventListener('click', () => {
            if (el.dataset.navAll) state.navLoadAll = el.dataset.navAll;
            navigateTo(el.dataset.nav);
        });
    });
    mainContent.querySelectorAll('.dash-cp-report-btn').forEach((btn) => {
        btn.addEventListener('click', () => navigateTo('manutencao-new', { prefillCliente: btn.dataset.cliente }));
    });
    // Card "Clientes principais" nasce recolhido — o número no cabeçalho é o
    // ponto de atenção; o usuário abre quando quiser ver a lista.
    document.getElementById('dash-cp-toggle')?.addEventListener('click', () => {
        const card = document.getElementById('dash-cp-card');
        if (!card) return;
        const collapsed = card.classList.toggle('dash-cp-collapsed');
        document.getElementById('dash-cp-toggle').setAttribute('aria-expanded', String(!collapsed));
    });

    // Refresh header notification dot after data loads
    updateHeaderUI(user);
    updateProposalsBadge(recentProposals.length);
    updateFunilBadge(data.overdueFunil || 0);
    refreshNotificacoesBadge();

    if (state.newItemNotification) {
        const notif = state.newItemNotification;
        state.newItemNotification = null;
        setTimeout(() => {
            showSuccessPopup(`${notif.tipo} adicionado${notif.tipo === 'Proposta' ? 'a' : ''} com sucesso!${notif.cliente ? '\n' + notif.cliente : ''}`);
        }, 300);
    }

    setupPushBanner();
}

// Convite (nunca trava o uso do app — só um banner dispensável) pra
// instalar E ativar notificação push de verdade (ver src/js/utils/
// push.js). Reaparece a cada 24h enquanto faltar alguma das duas coisas.
// No iPhone sem instalar nem dá pra pedir notificação, então a única
// coisa que ajuda ali é a instrução de instalação.
async function setupPushBanner() {
    const banner = document.getElementById('push-banner');
    if (!banner) return;

    const dismissedAt = parseInt(localStorage.getItem('push_banner_dismissed_at') || '0', 10);
    if (Date.now() - dismissedAt < 24 * 60 * 60 * 1000) { banner.hidden = true; return; }

    const installBtn = banner.querySelector('#push-banner-install');
    const enableBtn = banner.querySelector('#push-banner-enable');
    const titleEl = banner.querySelector('.push-banner-title');
    const descEl = banner.querySelector('.push-banner-desc');
    installBtn.hidden = true;
    enableBtn.hidden = true;

    const installed = isAppInstalled();
    const iosNeedsManualInstall = isIOS() && !installed;
    const canPromptInstall = !installed && !isIOS() && hasInstallPrompt();
    // Sem 'Notification' no navegador (raro, mas existe), trata como
    // "nunca vai conseguir ativar" em vez de arriscar um erro ao ler
    // Notification.permission — só o convite de instalar (se aplicável)
    // ainda faz sentido mostrar.
    const notifPermission = ('Notification' in window) ? Notification.permission : 'denied';

    if (notifPermission === 'granted' && installed) {
        // Já tem os dois — só garante que a inscrição deste aparelho segue
        // válida no servidor, sem precisar mostrar nada.
        enablePush().catch(() => {});
        banner.hidden = true;
        return;
    }
    // Permissão bloqueada de vez e nada de instalação pendente: nenhum
    // botão resolveria isso, então não insiste (nem trava, nem repete).
    if (notifPermission === 'denied' && !iosNeedsManualInstall && !canPromptInstall) {
        banner.hidden = true;
        return;
    }

    let descText;
    let needsInstall = false, needsNotif = false;
    if (iosNeedsManualInstall) {
        needsInstall = true;
        descText = 'Toque em Compartilhar e depois em "Adicionar à Tela de Início".';
    } else {
        const parts = [];
        if (canPromptInstall) { needsInstall = true; installBtn.hidden = false; parts.push('instale o app pra ter acesso rápido'); }
        // Só quando ainda não foi decidido ('default') — 'granted' não tem
        // mais nada a pedir aqui (bug antigo: mostrava o botão de novo
        // mesmo já ativado, parecendo que o clique anterior não fez nada).
        if (isPushSupported() && notifPermission === 'default') { needsNotif = true; enableBtn.hidden = false; parts.push('ative as notificações pra saber na hora quando pedirem uma atualização sua'); }
        if (!parts.length) { banner.hidden = true; return; }
        descText = parts.join(' e ') + '.';
        descText = descText.charAt(0).toUpperCase() + descText.slice(1);
    }

    titleEl.textContent = needsInstall && needsNotif ? '📲🔔 Instale o app e ative as notificações'
        : needsInstall ? '📲 Instale o app'
        : '🔔 Ative as notificações';
    descEl.textContent = descText;
    banner.hidden = false;

    banner.querySelector('#push-banner-dismiss').onclick = () => {
        localStorage.setItem('push_banner_dismissed_at', String(Date.now()));
        banner.hidden = true;
    };
    installBtn.onclick = async (e) => {
        const btn = e.currentTarget;
        setSaving(true, btn, 'Instalando...');
        const outcome = await consumeInstallPrompt();
        if (outcome === 'accepted') showToast('App instalado!');
        else if (outcome === 'dismissed') showToast('Instalação cancelada — clique em "Instalar app" de novo quando quiser.', true);
        else showToast('O navegador não ofereceu a instalação agora. Tente pelo menu (⋮) → "Instalar app".', true);
        setSaving(false, btn);
        setupPushBanner();
    };
    enableBtn.onclick = async (e) => {
        const btn = e.currentTarget;
        setSaving(true, btn, 'Ativando...');
        try {
            await enablePush();
            showToast('Notificações ativadas!');
        } catch (err) {
            showToast(err.message || 'Não foi possível ativar.', true);
        } finally {
            setSaving(false, btn);
            setupPushBanner();
        }
    };
}


// Linhas clicáveis do modal "Resumo de ontem" (showResumoDiarioModal,
// acessível pelo botão em Ações rápidas).
function buildResumoRows(r) {
    const plural = (n, s, p) => `${n} ${n === 1 ? s : p}`;
    return [
        { page: 'visits', text: plural(r.visitas.total, 'visita registrada', 'visitas registradas') },
        (r.agendamentos.vencidosTotal || r.agendamentos.proximosTotal) ? {
            page: 'calendar', params: { filter: 'retornos' },
            text: [
                r.agendamentos.vencidosTotal ? plural(r.agendamentos.vencidosTotal, 'agendamento vencido', 'agendamentos vencidos') : '',
                r.agendamentos.proximosTotal ? `${r.agendamentos.proximosTotal} nos próximos 7 dias` : ''
            ].filter(Boolean).join(' · ')
        } : null,
        r.relatorios.total ? {
            page: 'manutencao',
            text: `${plural(r.relatorios.total, 'relatório criado', 'relatórios criados')} (${[
                r.relatorios.aferição ? `${r.relatorios.aferição} Aferição` : '',
                r.relatorios.spsp ? `${r.relatorios.spsp} SPSP` : '',
                r.relatorios.geral ? `${r.relatorios.geral} Geral` : ''
            ].filter(Boolean).join(' · ')})`
        } : null,
        (r.campanhas.respondidasOntem || r.campanhas.pendentesTotal) ? {
            page: 'campanhas',
            text: `Campanhas: ${[
                r.campanhas.respondidasOntem ? plural(r.campanhas.respondidasOntem, 'respondida', 'respondidas') : '',
                r.campanhas.pendentesTotal ? plural(r.campanhas.pendentesTotal, 'pendente', 'pendentes') : ''
            ].filter(Boolean).join(' · ')}`
        } : null
    ].filter(Boolean);
}

// Modal "Resumo de ontem" — acessível a qualquer momento pelo botão em
// Ações rápidas.
export async function showResumoDiarioModal() {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `<div class="modal-card" style="text-align:left;max-width:400px">
        <h3 style="margin-top:0">📋 Resumo de ontem</h3>
        <p class="helper-text" id="resumo-modal-body">Carregando...</p>
        <div class="form-actions full-width"><button type="button" class="secondary-button" id="resumo-modal-close">Fechar</button></div>
    </div>`;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
    overlay.querySelector('#resumo-modal-close').addEventListener('click', close);

    const result = await callAPI('getResumoDiario', { user: state.currentUser }).catch((e) => ({ status: 'error', message: e.message }));
    if (!overlay.isConnected) return;
    const body = overlay.querySelector('#resumo-modal-body');
    if (!result || result.status !== 'success') {
        body.textContent = (result && result.message) || 'Não foi possível carregar o resumo.';
        return;
    }
    const r = result.resumo;
    overlay.querySelector('h3').textContent = `📋 Resumo de ${r.dataResumo}`;
    const rows = buildResumoRows(r);
    if (!rows.length) {
        body.textContent = 'Nenhuma atividade registrada.';
        return;
    }
    body.outerHTML = `<div class="resumo-diario-list" id="resumo-modal-list">
        ${rows.map((row) => `<button type="button" class="resumo-diario-row" data-page="${row.page}" data-params='${escapeHtml(JSON.stringify(row.params || {}))}'>${escapeHtml(row.text)}</button>`).join('')}
    </div>`;
    overlay.querySelectorAll('[data-page]').forEach((btn) => {
        btn.addEventListener('click', () => { close(); navigateTo(btn.dataset.page, JSON.parse(btn.dataset.params || '{}')); });
    });
}

// Card "Visitas sinalizadas para vincular" — pedido pra quando o vendedor
// sinaliza uma visita pelo celular (onde o Vincular a Proposta/Funil fica
// escondido, ver components.css) e precisa de um jeito de achar essas
// visitas de novo ao abrir o computador. Some sozinha assim que a visita
// ganha um vínculo com Funil ou Proposta (ver linkVisitaCampo/
// handleGetVisitasSinalizadas em lib/handlers/visits.js) — sem isso, uma
// visita já vinculada continuava "cobrando" aqui até alguém lembrar de
// desmarcar o 🚩 manualmente.
export async function loadVisitasSinalizadasCard() {
    const container = document.getElementById('visitas-sinalizadas-card');
    if (!container) return;
    const result = await callAPI('getVisitasSinalizadas', { user: state.currentUser }).catch((e) => ({ status: 'error', message: e.message }));
    if (document.getElementById('visitas-sinalizadas-card') !== container) return;
    if (!result || result.status !== 'success' || !result.visitas || !result.visitas.length) {
        container.remove();
        return;
    }
    const rows = result.visitas.map((v) => {
        const texto = [v.cliente || 'Cliente', v.vendedorGerente, v.dataVisita].filter(Boolean).join(' · ');
        return `<button type="button" class="resumo-diario-row" data-id="${escapeHtml(v.id)}">${escapeHtml(texto)}</button>`;
    }).join('');
    container.innerHTML = `
        <div class="card resumo-diario-card">
            <div class="section-title-row">
                <h3 style="font-size:0.88rem;font-weight:700;margin:0">🚩 Visitas sinalizadas p/ vincular (${result.visitas.length})</h3>
            </div>
            <div class="resumo-diario-list">${rows}</div>
        </div>`;
    container.querySelectorAll('[data-id]').forEach((btn) => {
        btn.addEventListener('click', () => navigateTo('visit-detail', { id: btn.dataset.id }));
    });
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
        // Só depois do fillDashboard "de verdade" (dado fresco) — ele
        // reescreve mainContent.innerHTML do zero, o que apagaria o card se
        // ele já tivesse sido preenchido antes (ver #visitas-sinalizadas-card).
        loadVisitasSinalizadasCard();
    } else if (!cached && result.status !== 'success') {
        // Sem cache e a busca falhou — mostrar erro real, não um dashboard
        // "zerado" a partir de state.visits/proposals vazios, que passaria
        // a impressão enganosa de que não há nenhuma atividade registrada.
        if (document.getElementById('main-content') === mainContent) {
            mainContent.innerHTML = `<div class="page-header"><div><h2>Dashboard</h2></div></div>
                <div class="empty-state">
                    <span class="empty-state-icon">⚠️</span>
                    <p>${escapeHtml(result.message || 'Não foi possível carregar o dashboard.')}</p>
                    <button type="button" class="secondary-button" id="dashboard-retry-btn">Tentar novamente</button>
                </div>`;
            document.getElementById('dashboard-retry-btn')?.addEventListener('click', () => navigateTo('dashboard'));
        }
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

