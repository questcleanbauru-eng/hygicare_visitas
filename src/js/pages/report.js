import { state, navigateTo } from '../app.js';
import { escapeHtml, isAdminOrGerenteUser, getDateRangeForPeriod, parseDisplayDate, normalizeVisit, normalizeProposal, titleCase, parseCurrencyBR, calculateDaysFromDisplayDate } from '../utils/format.js';
import { loadingState, showToast, initializeSearchableInput } from '../utils/dom.js';
import { ensureStyles, renderBreadcrumb } from '../utils/ui.js';
import { downloadXLSX } from '../utils/xlsxWriter.js';

function formatMoney(value) {
    return value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

// Imprime a página inteira (scope vazio) ou só uma seção — o CSS
// @media print esconde as demais quando body[data-print-scope] está setado.
function printReport(scope) {
    if (scope) { document.body.dataset.printScope = scope; }
    const cleanup = () => {
        delete document.body.dataset.printScope;
        window.removeEventListener('afterprint', cleanup);
    };
    window.addEventListener('afterprint', cleanup);
    setTimeout(cleanup, 3000); // fallback: nem todo navegador dispara afterprint
    window.print();
}

// Gera um PDF só com o conteúdo passado (tabelas detalhadas por vendedor),
// sem renderizar isso tudo na tela. Monta um container fora de tela, marca
// body[data-print-scope="detalhe"] (o CSS esconde o resto) e imprime.
function printDetalhe(title, subtitle, innerHtml) {
    document.getElementById('report-detail-print')?.remove();
    const wrap = document.createElement('div');
    wrap.id = 'report-detail-print';
    wrap.innerHTML = `<div class="rdp-head"><h2>${escapeHtml(title)}</h2><p>${escapeHtml(subtitle)}</p></div>${innerHtml}`;
    document.body.appendChild(wrap);
    document.body.dataset.printScope = 'detalhe';
    const cleanup = () => {
        wrap.remove();
        delete document.body.dataset.printScope;
        window.removeEventListener('afterprint', cleanup);
    };
    window.addEventListener('afterprint', cleanup);
    setTimeout(cleanup, 3000);
    window.print();
}

// Modal do botão "Por gerência/vendedor" — deixa escolher UMA gerência só
// pro PDF (sem mexer no filtro "Gerência" geral do relatório, que afeta os
// KPIs/gráficos da tela inteira). null = cancelou; '' = "Todas as gerências".
function pickGerenciaParaPdf(gerencias) {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.innerHTML = `
            <div class="modal-card" style="text-align:left;max-width:360px">
                <h3 style="margin-top:0">📄 Gerência no PDF</h3>
                <p class="helper-text" style="margin:-0.3rem 0 0.9rem">Escolha uma gerência pra gerar o PDF só dela, ou deixe "Todas" pra manter o relatório completo.</p>
                <div class="form-group full-width">
                    <label for="pdf-gerencia-select">Gerência</label>
                    <select id="pdf-gerencia-select">
                        <option value="">Todas as gerências</option>
                        ${gerencias.map((g) => `<option value="${escapeHtml(g)}">${escapeHtml(g)}</option>`).join('')}
                    </select>
                </div>
                <div class="form-actions full-width" style="display:flex;gap:0.5rem">
                    <button type="button" class="secondary-button" id="pdf-gerencia-cancel">Cancelar</button>
                    <button type="button" class="primary-button" id="pdf-gerencia-ok">Gerar PDF</button>
                </div>
            </div>`;
        document.body.appendChild(overlay);
        const close = (result) => { overlay.remove(); resolve(result); };
        overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(null); });
        overlay.querySelector('#pdf-gerencia-cancel').addEventListener('click', () => close(null));
        overlay.querySelector('#pdf-gerencia-ok').addEventListener('click', () => {
            close(overlay.querySelector('#pdf-gerencia-select').value);
        });
    });
}

// Mesma ideia do pickGerenciaParaPdf, mas pra status (multi-seleção — ex.:
// só "Ganhamos" + "Perdido" pra ver fechadas). null = cancelou; array vazio
// = nenhum filtro (todos marcados = mesma coisa que não filtrar).
function pickStatusParaPdf(statusDisponiveis, titulo) {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.innerHTML = `
            <div class="modal-card" style="text-align:left;max-width:360px">
                <h3 style="margin-top:0">📄 ${escapeHtml(titulo)}</h3>
                <p class="helper-text" style="margin:-0.3rem 0 0.9rem">Marque os status que quer no PDF. Todos marcados = relatório completo.</p>
                <div class="form-group full-width" style="display:flex;flex-direction:column;gap:0.5rem">
                    ${statusDisponiveis.map((s) => `
                        <label style="display:flex;align-items:center;gap:0.6rem;font-size:0.87rem;font-weight:500;cursor:pointer">
                            <input type="checkbox" class="pdf-status-check" value="${escapeHtml(s)}" style="width:auto;accent-color:var(--primary)" checked>
                            ${escapeHtml(s)}
                        </label>`).join('')}
                </div>
                <div class="form-actions full-width" style="display:flex;gap:0.5rem">
                    <button type="button" class="secondary-button" id="pdf-status-cancel">Cancelar</button>
                    <button type="button" class="primary-button" id="pdf-status-ok">Gerar PDF</button>
                </div>
            </div>`;
        document.body.appendChild(overlay);
        const close = (result) => { overlay.remove(); resolve(result); };
        overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(null); });
        overlay.querySelector('#pdf-status-cancel').addEventListener('click', () => close(null));
        overlay.querySelector('#pdf-status-ok').addEventListener('click', () => {
            const marcados = Array.from(overlay.querySelectorAll('.pdf-status-check:checked')).map((c) => c.value);
            close(marcados.length === statusDisponiveis.length ? [] : marcados);
        });
    });
}

// Probabilidade de fechamento por estágio do funil — usada no forecast
// ponderado (Vl Mensal × probabilidade).
const FUNIL_PROB = { IDENTIFICAR: 0.10, RETOMAR: 0.15, PROPOSTA: 0.30, NEGOCIAR: 0.60, CONCLUIDO: 1, PERDIDO: 0 };

function propStatusKind(status) {
    const s = String(status || '').trim().toLowerCase();
    if (['ganhamos', 'ganho', 'concluido', 'concluído'].includes(s)) return 'ganha';
    if (['perdido', 'perdida'].includes(s)) return 'perdida';
    return 'aberta';
}

// Pega as N maiores entradas de um countBy e agrupa o resto numa linha
// "Outras (X)" — pra listas por cidade/tipo não ficarem gigantes.
function topN(entries, n = 8, restLabel = 'Outras') {
    if (entries.length <= n + 1) return entries;
    const top = entries.slice(0, n);
    const rest = entries.slice(n);
    const restSum = rest.reduce((s, e) => s + e[1], 0);
    return [...top, [`${restLabel} (${rest.length})`, restSum]];
}

function reportTable(headers, rows) {
    return `<div class="report-table-wrap"><table class="report-table">
        <thead><tr>${headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead>
        <tbody>${rows.map((r) => `<tr>${r.map((c, i) => `<td${i === 0 ? '' : ' class="num"'}>${c}</td>`).join('')}</tr>`).join('')}</tbody>
    </table></div>`;
}

// Idade a partir de uma data dd/mm/aaaa → "0 ano(s), 6 mês(es) e 29 dia(s)".
function formatAge(dateStr) {
    const d = parseDisplayDate(dateStr);
    if (!d) return '-';
    const now = new Date();
    let months = (now.getFullYear() - d.getFullYear()) * 12 + (now.getMonth() - d.getMonth());
    let days = now.getDate() - d.getDate();
    if (days < 0) {
        months -= 1;
        days += new Date(now.getFullYear(), now.getMonth(), 0).getDate();
    }
    if (months < 0) return '-';
    return `${Math.floor(months / 12)} ano(s), ${months % 12} mês(es) e ${days} dia(s)`;
}

// Igual ao reportTable, mas alinha tudo à esquerda (tabela de detalhe com
// muitas colunas de texto — DATA/CLIENTE/FOCO/… — onde alinhar à direita
// fica ilegível).
function reportTableFlat(headers, rows) {
    return `<div class="report-table-wrap"><table class="report-table report-table-flat">
        <thead><tr>${headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead>
        <tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody>
    </table></div>`;
}

// Tabela detalhada agrupada por vendedor: um cabeçalho + tabela por grupo.
function groupedVendorTables(items, vendedorOf, dateOf, headers, rowOf) {
    const groups = {};
    items.forEach((it) => {
        const k = titleCase(vendedorOf(it)) || 'Sem vendedor';
        (groups[k] = groups[k] || []).push(it);
    });
    return Object.keys(groups).sort((a, b) => a.localeCompare(b, 'pt-BR')).map((vend) => {
        const list = groups[vend].slice().sort((a, b) => (parseDisplayDate(dateOf(a)) || 0) - (parseDisplayDate(dateOf(b)) || 0));
        return `<div class="report-group">
            <h4 class="report-group-head">${escapeHtml(vend)} <span>${list.length}</span></h4>
            ${reportTableFlat(headers, list.map(rowOf))}
        </div>`;
    }).join('');
}

// Igual ao groupedVendorTables, mas com um nível extra de agrupamento por
// Gerência acima do vendedor. Se só existir uma gerência nos dados (ex.:
// usuário gerente vendo só a própria equipe), pula direto pra agrupar por
// vendedor — não faz sentido mostrar um grupo único de gerência.
function groupedGerenciaVendorTables(items, gerenciaOf, vendedorOf, dateOf, headers, rowOf) {
    const groups = {};
    items.forEach((it) => {
        const k = titleCase(gerenciaOf(it)) || 'Sem gerência';
        (groups[k] = groups[k] || []).push(it);
    });
    const gerenciaKeys = Object.keys(groups);
    if (gerenciaKeys.length <= 1) {
        return groupedVendorTables(items, vendedorOf, dateOf, headers, rowOf);
    }
    return gerenciaKeys.sort((a, b) => a.localeCompare(b, 'pt-BR')).map((ger) => `
        <div class="report-group report-group-gerencia">
            <h3 class="report-group-head-gerencia">${escapeHtml(ger)} <span>${groups[ger].length}</span></h3>
            ${groupedVendorTables(groups[ger], vendedorOf, dateOf, headers, rowOf)}
        </div>
    `).join('');
}

function countBy(items, keyFn) {
    const counts = {};
    items.forEach((item) => {
        const key = keyFn(item) || '-';
        counts[key] = (counts[key] || 0) + 1;
    });
    return Object.entries(counts).sort((a, b) => b[1] - a[1]);
}

function inRange(date, start, end) {
    if (!start || !end) return true;
    if (!date) return false;
    return date >= start && date <= end;
}

function reportTopRow(index, label, value) {
    return `
        <div class="report-top-row">
            <span class="report-top-rank">${index + 1}</span>
            <span class="report-top-label">${escapeHtml(label)}</span>
            <span class="report-top-value">${value}</span>
        </div>
    `;
}

function reportBar(label, value, total) {
    const pct = total ? Math.round((value / total) * 100) : 0;
    return `
        <div class="report-bar-row">
            <span class="report-bar-label">${escapeHtml(titleCase(label))}</span>
            <div class="report-bar-track"><div class="report-bar-fill" style="width:${pct}%"></div></div>
            <span class="report-bar-value">${value}</span>
        </div>
    `;
}

// ── Hub — 3 telas separadas (Visitas/Propostas/Funil), cada uma com seus
// próprios filtros, em vez de uma página só com tudo junto e "Ir para"
// rolando a mesma tela. ──────────────────────────────────────────────────
export async function renderReportPage() {
    ensureStyles('report');
    const mainContent = document.getElementById('main-content');
    mainContent.innerHTML = `
        ${renderBreadcrumb([{ label: 'Dashboard', page: 'dashboard' }, { label: 'Relatório' }])}
        <div class="page-header">
            <div><h2>Relatórios</h2><p class="page-subtitle">Escolha o que quer ver</p></div>
        </div>
        <div class="report-hub-grid">
            <button type="button" class="card report-hub-card" id="hub-visitas">
                <strong>📋 Visitas</strong>
                <span>Total, por tipo, por vendedor, por cidade, clientes mais visitados.</span>
            </button>
            <button type="button" class="card report-hub-card" id="hub-propostas">
                <strong>📄 Propostas</strong>
                <span>Conversão, por vendedor, por status, por foco, atrasadas e vencendo.</span>
            </button>
            <button type="button" class="card report-hub-card" id="hub-funil">
                <strong>📊 Funil</strong>
                <span>Pipeline, forecast, por vendedor, por status, previsão de fechamento.</span>
            </button>
        </div>
    `;
    document.getElementById('hub-visitas').addEventListener('click', () => navigateTo('report-visitas'));
    document.getElementById('hub-propostas').addEventListener('click', () => navigateTo('report-propostas'));
    document.getElementById('hub-funil').addEventListener('click', () => navigateTo('report-funil'));
}

// Sequencial + 1 retry: as buscas pedem o histórico inteiro (dias:0) —
// pesadas, e numa função serverless fria disputam tempo/cota do Sheets.
async function fetchWithRetry(fn, tries = 2) {
    let last = { status: 'error', message: 'Sem resposta do servidor.' };
    for (let i = 0; i < tries; i++) {
        try { last = await fn(); } catch (e) { last = { status: 'error', message: e && e.message }; }
        if (last && last.status === 'success') return last;
        if (i < tries - 1) await new Promise((r) => setTimeout(r, 1500));
    }
    return last;
}

function reportErrorState(body, label, message, retryPage) {
    body.innerHTML = `<div class="empty-state">
        <span class="empty-state-icon">⚠️</span>
        <p>Não foi possível carregar: ${escapeHtml(label)}.${message ? `<br><span class="helper-text">${escapeHtml(message)}</span>` : ''}</p>
        <button type="button" class="secondary-button" id="report-retry-btn">Tentar novamente</button>
    </div>`;
    document.getElementById('report-retry-btn')?.addEventListener('click', () => navigateTo(retryPage));
}

const PERIOD_LABELS = {
    'semana-atual': 'Semana atual', 'mes-atual': 'Mês atual', 'ultimos-3m': 'Últimos 3 meses',
    'tudo': 'Tudo', 'personalizado': 'Período personalizado'
};

// Monta o HTML do bloco de filtros comum às 3 telas (Período/Gerência/
// Vendedor/Cidade) + um slot (extraHtml) pro que for específico de cada
// uma (Tipo da Visita / Status+Foco / Status+Aplicação).
function filterPanelHtml({ period, isAdmin, gerencia, gerenciasDisponiveis, vendedor, vendedoresDisponiveis, cidade, cidadesDisponiveis, customFrom, customTo, extraHtml }) {
    return `
        <div class="pill-row">
            ${Object.keys(PERIOD_LABELS).map((k) => `<button type="button" class="pill${period === k ? ' active' : ''}" data-period="${k}">${PERIOD_LABELS[k]}</button>`).join('')}
        </div>
        <div class="visits-filter-grid" id="report-filter-panel">
            ${period === 'personalizado' ? `
                <div class="form-group"><label for="report-date-from">De</label><input type="date" id="report-date-from" value="${escapeHtml(customFrom)}"></div>
                <div class="form-group"><label for="report-date-to">Até</label><input type="date" id="report-date-to" value="${escapeHtml(customTo)}"></div>
            ` : ''}
            ${isAdmin ? `
            <div class="form-group">
                <label for="report-gerencia">Gerência</label>
                <select id="report-gerencia">
                    <option value="">Todas</option>
                    ${gerenciasDisponiveis.map((g) => `<option value="${escapeHtml(g)}" ${gerencia === g ? 'selected' : ''}>${escapeHtml(g)}</option>`).join('')}
                </select>
            </div>` : ''}
            <div class="form-group">
                <label for="report-vendedor">Vendedor</label>
                <select id="report-vendedor">
                    <option value="">Todos</option>
                    ${vendedoresDisponiveis.map((v) => `<option value="${escapeHtml(v)}" ${vendedor === v ? 'selected' : ''}>${escapeHtml(v)}</option>`).join('')}
                </select>
            </div>
            <div class="form-group">
                <label for="report-cidade">Cidade</label>
                <select id="report-cidade">
                    <option value="">Todas</option>
                    ${cidadesDisponiveis.map((c) => `<option value="${escapeHtml(c)}" ${cidade === c ? 'selected' : ''}>${escapeHtml(c)}</option>`).join('')}
                </select>
            </div>
            ${extraHtml || ''}
        </div>
    `;
}

// Liga os eventos do bloco de filtros comum (período/gerência/vendedor/
// cidade/limpar/ocultar) — cada tela passa suas próprias chaves de state e
// sua função de re-render.
function wireFilterPanel({ mainContent, rerender, keys, extraClear }) {
    mainContent.querySelectorAll('[data-period]').forEach((btn) => {
        btn.addEventListener('click', () => { state[keys.period] = btn.dataset.period; rerender(); });
    });
    document.getElementById('report-date-from')?.addEventListener('change', (e) => { state[keys.customFrom] = e.target.value; rerender(); });
    document.getElementById('report-date-to')?.addEventListener('change', (e) => { state[keys.customTo] = e.target.value; rerender(); });
    document.getElementById('report-gerencia')?.addEventListener('change', (e) => { state[keys.gerencia] = e.target.value; rerender(); });
    document.getElementById('report-vendedor')?.addEventListener('change', (e) => { state[keys.vendedor] = e.target.value; rerender(); });
    document.getElementById('report-cidade')?.addEventListener('change', (e) => { state[keys.cidade] = e.target.value; rerender(); });
    document.getElementById('report-filter-clear')?.addEventListener('click', () => {
        state[keys.customFrom] = ''; state[keys.customTo] = ''; state[keys.gerencia] = '';
        state[keys.vendedor] = ''; state[keys.cidade] = '';
        if (extraClear) extraClear();
        rerender();
    });
    const filterToggle = document.getElementById('report-filter-toggle');
    const filterPanel = document.getElementById('report-filter-panel');
    if (filterToggle && filterPanel) {
        const isMobile = window.matchMedia('(max-width: 640px)').matches;
        if (state[keys.filterCollapsed] === undefined || state[keys.filterCollapsed] === null) { state[keys.filterCollapsed] = isMobile; }
        let collapsed = state[keys.filterCollapsed];
        filterPanel.classList.toggle('collapsed', collapsed);
        filterToggle.textContent = collapsed ? 'Mostrar' : 'Ocultar';
        filterToggle.addEventListener('click', () => {
            collapsed = !collapsed;
            state[keys.filterCollapsed] = collapsed;
            filterPanel.classList.toggle('collapsed', collapsed);
            filterToggle.textContent = collapsed ? 'Mostrar' : 'Ocultar';
        });
    }
}

// Resolve o range de datas (início/fim) a partir do período selecionado —
// igual nas 3 telas.
function resolvePeriodRange(period, customFrom, customTo) {
    if (period === 'personalizado') {
        return {
            start: customFrom ? new Date(customFrom + 'T00:00:00') : null,
            end: customTo ? new Date(customTo + 'T23:59:59') : null
        };
    }
    return getDateRangeForPeriod(period);
}

function initMultiSelectFilter(id, items, selectedArr, onChange) {
    if (!document.getElementById(id)) return;
    initializeSearchableInput({
        input: document.getElementById(id),
        menu: document.getElementById(id + '-menu'),
        items,
        multiSelect: true,
        maxSelections: 99,
        selectedItems: selectedArr,
        selectedContainer: document.getElementById(id + '-selected'),
        selectionLabel: 'item',
        onSelectionChange: onChange
    });
}

// ── Visitas ───────────────────────────────────────────────────────────
export async function renderReportVisitasPage() {
    ensureStyles('report');
    const mainContent = document.getElementById('main-content');
    mainContent.innerHTML = `
        ${renderBreadcrumb([{ label: 'Dashboard', page: 'dashboard' }, { label: 'Relatórios', page: 'report' }, { label: 'Visitas' }])}
        <div class="page-header no-print">
            <div><h2>📋 Relatório de Visitas</h2></div>
            <div class="report-header-actions">
                <button type="button" class="text-link" id="report-download-pdf">📄 Baixar PDF</button>
                <button type="button" class="text-link" id="report-download-excel">📥 Baixar Excel</button>
            </div>
        </div>
        <div id="report-body">${loadingState('📋', 'Carregando relatório...')}</div>
    `;
    document.getElementById('report-download-pdf').addEventListener('click', () => printReport(''));
    document.getElementById('report-download-excel').addEventListener('click', () => document.getElementById('csv-visitas')?.click());
    const isAdmGer = isAdminOrGerenteUser();

    const visitsMod = await import('./visits.js');
    const res = await fetchWithRetry(() => visitsMod.getVisits(0));
    const body = document.getElementById('report-body');
    if (res.status !== 'success') { reportErrorState(body, 'Visitas', res.message, 'report-visitas'); return; }
    const allVisits = res.visits.map(normalizeVisit);

    state.rptVisPeriod = state.rptVisPeriod || 'mes-atual';
    state.rptVisCustomFrom = state.rptVisCustomFrom || '';
    state.rptVisCustomTo = state.rptVisCustomTo || '';
    if (!Array.isArray(state.rptVisTipo)) state.rptVisTipo = [];

    renderReportVisitasBody(mainContent, allVisits, isAdmGer);
}

function renderReportVisitasBody(mainContent, allVisits, isAdmGer) {
    const body = document.getElementById('report-body');
    if (!body) return;
    const isAdmin = (state.currentUser?.profile || '').toLowerCase() === 'admin';
    const gerencia = state.rptVisGerencia || '';
    const vendedor = state.rptVisVendedor || '';
    const cidade = state.rptVisCidade || '';
    const tipoFiltro = Array.isArray(state.rptVisTipo) ? state.rptVisTipo : [];

    const gerenciasDisponiveis = Array.from(new Set(allVisits.map((v) => titleCase(v.gerencia)).filter(Boolean))).sort();
    const vendedoresDisponiveis = Array.from(new Set(allVisits.map((v) => titleCase(v.vendedorGerente)).filter(Boolean))).sort();
    const cidadesDisponiveis = Array.from(new Set(allVisits.map((v) => titleCase(v.cidade)).filter(Boolean))).sort();
    const tiposDisponiveis = Array.from(new Set(allVisits.map((v) => v.tipoVisita).filter(Boolean))).sort();

    const period = state.rptVisPeriod;
    const { start, end } = resolvePeriodRange(period, state.rptVisCustomFrom, state.rptVisCustomTo);

    const visits = allVisits.filter((v) => inRange(parseDisplayDate(v.dataVisita), start, end)
        && (!gerencia || titleCase(v.gerencia) === gerencia)
        && (!vendedor || titleCase(v.vendedorGerente) === vendedor)
        && (!cidade || titleCase(v.cidade) === cidade)
        && (!tipoFiltro.length || tipoFiltro.includes(v.tipoVisita)));

    const visitsByType = countBy(visits, (v) => v.tipoVisita);
    const visitsByVendor = countBy(visits, (v) => titleCase(v.vendedorGerente));
    const visitsByCidade = countBy(visits, (v) => titleCase(v.cidade));
    const topClientesVisitas = countBy(visits, (v) => titleCase(v.cliente)).slice(0, 5);
    const topTiposComCliente = visitsByType.slice(0, 5).map(([tipo]) => {
        const clientesDoTipo = countBy(visits.filter((v) => (v.tipoVisita || '-') === tipo), (v) => titleCase(v.cliente));
        return { tipo, cliente: clientesDoTipo[0] ? clientesDoTipo[0][0] : null, clienteCount: clientesDoTipo[0] ? clientesDoTipo[0][1] : 0 };
    });
    const periodLabel = PERIOD_LABELS[period] || 'Mês atual';

    body.innerHTML = `
        <div class="report-print-header">
            <h2>Relatório de Visitas — ${escapeHtml(periodLabel)}</h2>
            <p>Gerado por ${escapeHtml(state.currentUser?.name || '')} em ${new Date().toLocaleDateString('pt-BR')}</p>
        </div>
        <div class="card report-period-card no-print">
            <div class="visits-filter-header">
                <strong>Filtros</strong>
                <div class="visits-filter-header-actions">
                    <button type="button" class="text-link" id="report-filter-clear">Limpar</button>
                    <button type="button" class="text-link" id="report-filter-toggle">Ocultar</button>
                </div>
            </div>
            ${filterPanelHtml({
                period, isAdmin, gerencia, gerenciasDisponiveis, vendedor, vendedoresDisponiveis, cidade, cidadesDisponiveis,
                customFrom: state.rptVisCustomFrom, customTo: state.rptVisCustomTo,
                extraHtml: tiposDisponiveis.length ? `
                <div class="form-group report-status-filter">
                    <label for="report-vis-tipo">Tipo da Visita <span class="report-status-hint">(marque um ou mais)</span></label>
                    <div class="searchable-select">
                        <input type="text" id="report-vis-tipo" placeholder="Todos" autocomplete="off">
                        <div class="searchable-select-menu" id="report-vis-tipo-menu"></div>
                    </div>
                    <div class="selected-types" id="report-vis-tipo-selected" style="margin-top:0.3rem"></div>
                </div>` : ''
            })}
        </div>

        <div class="report-section">
        <div class="report-section-head no-print">
            <h3>📋 Visitas</h3>
            <div class="report-section-actions">
                <button type="button" class="text-link" id="pdf-visitas">📄 Resumo</button>
                ${isAdmGer ? '<button type="button" class="text-link" id="pdf-det-visitas">📄 Por gerência/vendedor</button>' : ''}
                <button type="button" class="text-link" id="csv-visitas">📥 Excel</button>
            </div>
        </div>
        <div class="report-kpi-row">
            <div class="report-kpi"><strong>${visits.length}</strong><span>Total no período</span></div>
        </div>
        ${visitsByType.length ? `<p class="report-subtitle">Por tipo (principais)</p><div class="report-bar-list">${topN(visitsByType, 10).map(([k, v]) => reportBar(k, v, visits.length)).join('')}</div>` : ''}
        ${isAdmGer && visitsByVendor.length ? `<p class="report-subtitle">Por vendedor</p><div class="report-bar-list">${topN(visitsByVendor, 15).map(([k, v]) => reportBar(k, v, visits.length)).join('')}</div>` : ''}
        ${visitsByCidade.length ? `<p class="report-subtitle">Por cidade (principais)</p><div class="report-bar-list">${topN(visitsByCidade, 8).map(([k, v]) => reportBar(k, v, visits.length)).join('')}</div>` : ''}
        ${topClientesVisitas.length ? `<p class="report-subtitle">Top 5 clientes com mais visitas</p><div class="report-top-list">${topClientesVisitas.map(([cliente, total], i) => reportTopRow(i, cliente, total)).join('')}</div>` : ''}
        ${topTiposComCliente.length ? `<p class="report-subtitle">Top 5 tipos de visita — cliente mais frequente</p><div class="report-top-list">${topTiposComCliente.map((t, i) => reportTopRow(i, titleCase(t.tipo) + (t.cliente ? ` — ${t.cliente}` : ''), t.clienteCount)).join('')}</div>` : ''}
        </div>
    `;

    wireFilterPanel({
        mainContent, rerender: () => renderReportVisitasBody(mainContent, allVisits, isAdmGer),
        keys: { period: 'rptVisPeriod', customFrom: 'rptVisCustomFrom', customTo: 'rptVisCustomTo', gerencia: 'rptVisGerencia', vendedor: 'rptVisVendedor', cidade: 'rptVisCidade', filterCollapsed: 'rptVisFilterCollapsed' },
        extraClear: () => { state.rptVisTipo = []; }
    });
    initMultiSelectFilter('report-vis-tipo', tiposDisponiveis, tipoFiltro, () => {
        state.rptVisTipo = tipoFiltro.slice();
        renderReportVisitasBody(mainContent, allVisits, isAdmGer);
    });

    document.getElementById('pdf-visitas')?.addEventListener('click', () => printReport(''));
    document.getElementById('pdf-det-visitas')?.addEventListener('click', async () => {
        if (!visits.length) { showToast('Nenhuma visita no período.', true); return; }
        let visitsParaPdf = visits;
        let gerenciaEscolhida = gerencia;
        if (isAdmin && !gerencia && gerenciasDisponiveis.length > 1) {
            const escolha = await pickGerenciaParaPdf(gerenciasDisponiveis);
            if (escolha === null) return;
            if (escolha) {
                gerenciaEscolhida = escolha;
                visitsParaPdf = visits.filter((v) => titleCase(v.gerencia) === escolha);
                if (!visitsParaPdf.length) { showToast(`Nenhuma visita de "${escolha}" no período.`, true); return; }
            }
        }
        printDetalhe('Visitas — detalhado por gerência e vendedor', `${escapeHtml(periodLabel)}${gerenciaEscolhida ? ' · ' + gerenciaEscolhida : ''} — ${visitsParaPdf.length} visita(s)`, groupedGerenciaVendorTables(
            visitsParaPdf, (v) => v.gerencia, (v) => v.vendedorGerente, (v) => v.dataVisita,
            ['Data', 'Cliente', 'Tipo da Visita', 'Cidade', 'Contato'],
            (v) => [
                escapeHtml(v.dataVisita || '-'), escapeHtml(titleCase(v.cliente) || '-'), escapeHtml(v.tipoVisita || '-'),
                escapeHtml(titleCase(v.cidade) || '-'), escapeHtml(v.contato || '-')
            ]
        ));
    });
    document.getElementById('csv-visitas')?.addEventListener('click', () => {
        const _stamp = new Date().toISOString().slice(0, 10);
        const rows = visits.slice().sort((a, b) => (parseDisplayDate(b.dataVisita) || 0) - (parseDisplayDate(a.dataVisita) || 0))
            .map((v) => ({
                data: v.dataVisita || '', vendedor: titleCase(v.vendedorGerente), gerencia: titleCase(v.gerencia),
                cliente: titleCase(v.cliente), cidade: titleCase(v.cidade), tipoVisita: v.tipoVisita || '',
                areaAtuacao: v.areaAtuacao || '', contato: v.contato || '', prospeccao: v.prospeccao || ''
            }));
        if (!rows.length) { showToast('Nenhuma visita no período.', true); return; }
        downloadXLSX(rows, `visitas-${_stamp}.xlsx`, [
            { key: 'data', label: 'Data', type: 'date' }, { key: 'vendedor', label: 'Vendedor' }, { key: 'gerencia', label: 'Gerência' },
            { key: 'cliente', label: 'Cliente' }, { key: 'cidade', label: 'Cidade' }, { key: 'tipoVisita', label: 'Tipo da Visita' },
            { key: 'areaAtuacao', label: 'Área de Atuação' }, { key: 'contato', label: 'Contato' }, { key: 'prospeccao', label: 'Prospecção' }
        ], 'Visitas');
    });
}

// ── Propostas ─────────────────────────────────────────────────────────
export async function renderReportPropostasPage() {
    ensureStyles('report');
    const mainContent = document.getElementById('main-content');
    mainContent.innerHTML = `
        ${renderBreadcrumb([{ label: 'Dashboard', page: 'dashboard' }, { label: 'Relatórios', page: 'report' }, { label: 'Propostas' }])}
        <div class="page-header no-print">
            <div><h2>📄 Relatório de Propostas</h2></div>
            <div class="report-header-actions">
                <button type="button" class="text-link" id="report-download-pdf">📄 Baixar PDF</button>
                <button type="button" class="text-link" id="report-download-excel">📥 Baixar Excel</button>
            </div>
        </div>
        <div id="report-body">${loadingState('📄', 'Carregando relatório...')}</div>
    `;
    document.getElementById('report-download-pdf').addEventListener('click', () => printReport(''));
    document.getElementById('report-download-excel').addEventListener('click', () => document.getElementById('csv-propostas')?.click());
    const isAdmGer = isAdminOrGerenteUser();

    const proposalsMod = await import('./proposals.js');
    const res = await fetchWithRetry(() => proposalsMod.getProposals(0));
    const body = document.getElementById('report-body');
    if (res.status !== 'success') { reportErrorState(body, 'Propostas', res.message, 'report-propostas'); return; }
    const allProposals = res.proposals.map(normalizeProposal);

    state.rptPropPeriod = state.rptPropPeriod || 'mes-atual';
    state.rptPropCustomFrom = state.rptPropCustomFrom || '';
    state.rptPropCustomTo = state.rptPropCustomTo || '';
    if (!Array.isArray(state.rptPropStatus)) state.rptPropStatus = [];
    if (!Array.isArray(state.rptPropFoco)) state.rptPropFoco = [];

    renderReportPropostasBody(mainContent, allProposals, isAdmGer);
}

function renderReportPropostasBody(mainContent, allProposals, isAdmGer) {
    const body = document.getElementById('report-body');
    if (!body) return;
    const isAdmin = (state.currentUser?.profile || '').toLowerCase() === 'admin';
    const gerencia = state.rptPropGerencia || '';
    const vendedor = state.rptPropVendedor || '';
    const cidade = state.rptPropCidade || '';
    const statusFiltro = Array.isArray(state.rptPropStatus) ? state.rptPropStatus : [];
    const focoFiltro = Array.isArray(state.rptPropFoco) ? state.rptPropFoco : [];

    const gerenciasDisponiveis = Array.from(new Set(allProposals.map((p) => titleCase(p.gerencia)).filter(Boolean))).sort();
    const vendedoresDisponiveis = Array.from(new Set(allProposals.map((p) => titleCase(p.vendedor)).filter(Boolean))).sort();
    const cidadesDisponiveis = Array.from(new Set(allProposals.map((p) => titleCase(p.cidade)).filter(Boolean))).sort();
    const statusDisponiveis = Array.from(new Set(allProposals.map((p) => p.status).filter(Boolean))).sort();
    const focosDisponiveis = Array.from(new Set(allProposals.map((p) => p.foco).filter(Boolean))).sort();

    const period = state.rptPropPeriod;
    const { start, end } = resolvePeriodRange(period, state.rptPropCustomFrom, state.rptPropCustomTo);

    const proposals = allProposals.filter((p) => inRange(parseDisplayDate(p.data), start, end)
        && (!gerencia || titleCase(p.gerencia) === gerencia)
        && (!vendedor || titleCase(p.vendedor) === vendedor)
        && (!cidade || titleCase(p.cidade) === cidade)
        && (!statusFiltro.length || statusFiltro.includes(p.status))
        && (!focoFiltro.length || focoFiltro.includes(p.foco)));

    const proposalsByStatus = countBy(proposals, (p) => p.status);
    const proposalsByCidade = countBy(proposals, (p) => titleCase(p.cidade));
    const proposalsGanhas = proposals.filter((p) => (p.status || '').toLowerCase() === 'ganhamos').length;
    const conversao = proposals.length ? Math.round((proposalsGanhas / proposals.length) * 100) : 0;
    const proposalsAtrasadas = proposals.filter((p) => p.atrasada).length;
    const propVendors = Array.from(new Set(proposals.map((p) => titleCase(p.vendedor) || '-')));
    const propByVendor = propVendors.map((vend) => {
        const list = proposals.filter((p) => (titleCase(p.vendedor) || '-') === vend);
        const abertas = list.filter((p) => propStatusKind(p.status) === 'aberta').length;
        const ganhas = list.filter((p) => propStatusKind(p.status) === 'ganha').length;
        const perdidas = list.filter((p) => propStatusKind(p.status) === 'perdida').length;
        const atrasadas = list.filter((p) => p.atrasada).length;
        const fechadas = ganhas + perdidas;
        const conv = fechadas ? Math.round((ganhas / fechadas) * 100) : 0;
        return { vend, total: list.length, abertas, atrasadas, ganhas, perdidas, conv };
    }).sort((a, b) => b.abertas - a.abertas);
    const propByFoco = countBy(proposals, (p) => titleCase(p.foco));
    const propAging = proposals.filter((p) => p.atrasada).sort((a, b) => (b.diasAtraso || 0) - (a.diasAtraso || 0)).slice(0, 15);
    const propVencendo = proposals.filter((p) => {
        if (propStatusKind(p.status) !== 'aberta') return false;
        const dl = parseDisplayDate(p.dataLimite);
        if (!dl) return false;
        const dias = (dl - new Date()) / 86400000;
        return dias >= -3 && dias <= 15;
    }).sort((a, b) => (parseDisplayDate(a.dataLimite) || 0) - (parseDisplayDate(b.dataLimite) || 0));
    const periodLabel = PERIOD_LABELS[period] || 'Mês atual';

    body.innerHTML = `
        <div class="report-print-header">
            <h2>Relatório de Propostas — ${escapeHtml(periodLabel)}</h2>
            <p>Gerado por ${escapeHtml(state.currentUser?.name || '')} em ${new Date().toLocaleDateString('pt-BR')}</p>
        </div>
        <div class="card report-period-card no-print">
            <div class="visits-filter-header">
                <strong>Filtros</strong>
                <div class="visits-filter-header-actions">
                    <button type="button" class="text-link" id="report-filter-clear">Limpar</button>
                    <button type="button" class="text-link" id="report-filter-toggle">Ocultar</button>
                </div>
            </div>
            ${filterPanelHtml({
                period, isAdmin, gerencia, gerenciasDisponiveis, vendedor, vendedoresDisponiveis, cidade, cidadesDisponiveis,
                customFrom: state.rptPropCustomFrom, customTo: state.rptPropCustomTo,
                extraHtml: `
                ${statusDisponiveis.length ? `
                <div class="form-group report-status-filter">
                    <label for="report-prop-status">Status <span class="report-status-hint">(marque um ou mais)</span></label>
                    <div class="searchable-select">
                        <input type="text" id="report-prop-status" placeholder="Todos" autocomplete="off">
                        <div class="searchable-select-menu" id="report-prop-status-menu"></div>
                    </div>
                    <div class="selected-types" id="report-prop-status-selected" style="margin-top:0.3rem"></div>
                </div>` : ''}
                ${focosDisponiveis.length ? `
                <div class="form-group report-status-filter">
                    <label for="report-prop-foco">Foco <span class="report-status-hint">(marque um ou mais)</span></label>
                    <div class="searchable-select">
                        <input type="text" id="report-prop-foco" placeholder="Todos" autocomplete="off">
                        <div class="searchable-select-menu" id="report-prop-foco-menu"></div>
                    </div>
                    <div class="selected-types" id="report-prop-foco-selected" style="margin-top:0.3rem"></div>
                </div>` : ''}
                `
            })}
        </div>

        <div class="report-section">
        <div class="report-section-head no-print">
            <h3>📄 Propostas</h3>
            <div class="report-section-actions">
                <button type="button" class="text-link" id="pdf-propostas">📄 Resumo</button>
                ${isAdmGer ? '<button type="button" class="text-link" id="pdf-det-propostas">📄 Por vendedor</button>' : ''}
                <button type="button" class="text-link" id="csv-propostas">📥 Excel</button>
            </div>
        </div>
        <div class="report-kpi-row">
            <div class="report-kpi"><strong>${proposals.length}</strong><span>Total no período</span></div>
            <div class="report-kpi"><strong>${conversao}%</strong><span>Taxa de conversão</span></div>
            <div class="report-kpi report-kpi-alert"><strong>${proposalsAtrasadas}</strong><span>Atrasadas &gt;30d</span></div>
        </div>
        ${isAdmGer && propByVendor.length ? `<p class="report-subtitle">Por vendedor</p>${reportTable(
            ['Vendedor', 'Total', 'Abertas', 'Atrasadas', 'Ganhas', 'Perdidas', 'Conv. %'],
            propByVendor.map((r) => [escapeHtml(r.vend), r.total, r.abertas, r.atrasadas, r.ganhas, r.perdidas, r.conv + '%'])
        )}` : ''}
        ${proposalsByStatus.length ? `<p class="report-subtitle">Por status</p><div class="report-bar-list">${proposalsByStatus.map(([k, v]) => reportBar(k, v, proposals.length)).join('')}</div>` : ''}
        ${propByFoco.length ? `<p class="report-subtitle">Por linha de produto (foco)</p><div class="report-bar-list">${topN(propByFoco, 10).map(([k, v]) => reportBar(k, v, proposals.length)).join('')}</div>` : ''}
        ${proposalsByCidade.length ? `<p class="report-subtitle">Por cidade (principais)</p><div class="report-bar-list">${topN(proposalsByCidade, 8).map(([k, v]) => reportBar(k, v, proposals.length)).join('')}</div>` : ''}
        ${propAging.length ? `<p class="report-subtitle">Propostas paradas (sem atualização &gt;30d)</p>${reportTable(
            ['Cliente', 'Vendedor', 'Status', 'Dias parado', 'Data limite'],
            propAging.map((p) => [escapeHtml(titleCase(p.cliente)), escapeHtml(titleCase(p.vendedor)), escapeHtml(p.status || '-'), p.diasAtraso || 0, escapeHtml(p.dataLimite || '-')])
        )}` : ''}
        ${propVencendo.length ? `<p class="report-subtitle">Vencendo (data limite nos próximos 15 dias)</p>${reportTable(
            ['Cliente', 'Vendedor', 'Status', 'Data limite'],
            propVencendo.map((p) => [escapeHtml(titleCase(p.cliente)), escapeHtml(titleCase(p.vendedor)), escapeHtml(p.status || '-'), escapeHtml(p.dataLimite || '-')])
        )}` : ''}
        </div>
    `;

    wireFilterPanel({
        mainContent, rerender: () => renderReportPropostasBody(mainContent, allProposals, isAdmGer),
        keys: { period: 'rptPropPeriod', customFrom: 'rptPropCustomFrom', customTo: 'rptPropCustomTo', gerencia: 'rptPropGerencia', vendedor: 'rptPropVendedor', cidade: 'rptPropCidade', filterCollapsed: 'rptPropFilterCollapsed' },
        extraClear: () => { state.rptPropStatus = []; state.rptPropFoco = []; }
    });
    initMultiSelectFilter('report-prop-status', statusDisponiveis, statusFiltro, () => {
        state.rptPropStatus = statusFiltro.slice();
        renderReportPropostasBody(mainContent, allProposals, isAdmGer);
    });
    initMultiSelectFilter('report-prop-foco', focosDisponiveis, focoFiltro, () => {
        state.rptPropFoco = focoFiltro.slice();
        renderReportPropostasBody(mainContent, allProposals, isAdmGer);
    });

    document.getElementById('pdf-propostas')?.addEventListener('click', () => printReport(''));
    document.getElementById('pdf-det-propostas')?.addEventListener('click', async () => {
        if (!proposals.length) { showToast('Nenhuma proposta no período.', true); return; }
        let proposalsParaPdf = proposals;
        if (!statusFiltro.length && statusDisponiveis.length > 1) {
            const escolha = await pickStatusParaPdf(statusDisponiveis, 'Status no PDF');
            if (escolha === null) return;
            if (escolha.length) {
                proposalsParaPdf = proposals.filter((p) => escolha.includes(p.status));
                if (!proposalsParaPdf.length) { showToast('Nenhuma proposta com esses status no período.', true); return; }
            }
        }
        printDetalhe('Propostas — detalhado por vendedor', `${escapeHtml(periodLabel)}${gerencia ? ' · ' + gerencia : ''} — ${proposalsParaPdf.length} proposta(s)`, groupedVendorTables(
            proposalsParaPdf, (p) => p.vendedor, (p) => p.data,
            ['Data', 'Cliente', 'Foco', 'Produtos', 'Cidade', 'Status', 'Atualização', 'Tempo proposta'],
            (p) => [
                escapeHtml(p.data || '-'), escapeHtml(titleCase(p.cliente) || '-'), escapeHtml(p.foco || '-'),
                escapeHtml(p.produtos || '-'), escapeHtml(titleCase(p.cidade) || '-'), escapeHtml(p.status || '-'),
                escapeHtml(p.atualizacao || '-'), escapeHtml(formatAge(p.data))
            ]
        ));
    });
    document.getElementById('csv-propostas')?.addEventListener('click', () => {
        const _stamp = new Date().toISOString().slice(0, 10);
        const rows = proposals.slice().sort((a, b) => (parseDisplayDate(b.data) || 0) - (parseDisplayDate(a.data) || 0))
            .map((p) => ({
                data: p.data || '', vendedor: titleCase(p.vendedor), gerencia: titleCase(p.gerencia),
                cliente: titleCase(p.cliente), cidade: titleCase(p.cidade), foco: p.foco || '', produtos: p.produtos || '',
                status: p.status || '', situacao: propStatusKind(p.status),
                atualizacao: p.atualizacao || '', diasSemAtualizacao: calculateDaysFromDisplayDate(p.atualizacao || p.data || ''),
                atrasada: p.atrasada ? 'Sim' : 'Não', dataLimite: p.dataLimite || '', email: p.email || ''
            }));
        if (!rows.length) { showToast('Nenhuma proposta no período.', true); return; }
        downloadXLSX(rows, `propostas-${_stamp}.xlsx`, [
            { key: 'data', label: 'Data', type: 'date' }, { key: 'vendedor', label: 'Vendedor' }, { key: 'gerencia', label: 'Gerência' },
            { key: 'cliente', label: 'Cliente' }, { key: 'cidade', label: 'Cidade' }, { key: 'foco', label: 'Foco' },
            { key: 'produtos', label: 'Produtos' }, { key: 'status', label: 'Status' }, { key: 'situacao', label: 'Situação' },
            { key: 'atualizacao', label: 'Última atualização', type: 'date' }, { key: 'diasSemAtualizacao', label: 'Dias sem atualização' },
            { key: 'atrasada', label: 'Atrasada' }, { key: 'dataLimite', label: 'Data limite', type: 'date' }, { key: 'email', label: 'E-mail' }
        ], 'Propostas');
    });
}

// ── Funil ─────────────────────────────────────────────────────────────
export async function renderReportFunilPage() {
    ensureStyles('report');
    const mainContent = document.getElementById('main-content');
    mainContent.innerHTML = `
        ${renderBreadcrumb([{ label: 'Dashboard', page: 'dashboard' }, { label: 'Relatórios', page: 'report' }, { label: 'Funil' }])}
        <div class="page-header no-print">
            <div><h2>📊 Relatório de Funil</h2></div>
            <div class="report-header-actions">
                <button type="button" class="text-link" id="report-download-pdf">📄 Baixar PDF</button>
                <button type="button" class="text-link" id="report-download-excel">📥 Baixar Excel</button>
            </div>
        </div>
        <div id="report-body">${loadingState('📊', 'Carregando relatório...')}</div>
    `;
    document.getElementById('report-download-pdf').addEventListener('click', () => printReport(''));
    document.getElementById('report-download-excel').addEventListener('click', () => document.getElementById('csv-funil')?.click());
    const isAdmGer = isAdminOrGerenteUser();

    const funilMod = await import('./funil.js');
    const res = await fetchWithRetry(() => funilMod.getFunil(0));
    const body = document.getElementById('report-body');
    if (res.status !== 'success') { reportErrorState(body, 'Funil', res.message, 'report-funil'); return; }
    const allFunil = res.funil || [];

    state.rptFunPeriod = state.rptFunPeriod || 'mes-atual';
    state.rptFunCustomFrom = state.rptFunCustomFrom || '';
    state.rptFunCustomTo = state.rptFunCustomTo || '';
    if (!Array.isArray(state.rptFunStatus)) state.rptFunStatus = [];
    if (!Array.isArray(state.rptFunAplicacao)) state.rptFunAplicacao = [];

    renderReportFunilBody(mainContent, allFunil, isAdmGer);
}

function renderReportFunilBody(mainContent, allFunil, isAdmGer) {
    const body = document.getElementById('report-body');
    if (!body) return;
    const isAdmin = (state.currentUser?.profile || '').toLowerCase() === 'admin';
    const gerencia = state.rptFunGerencia || '';
    const vendedor = state.rptFunVendedor || '';
    const cidade = state.rptFunCidade || '';
    const statusFiltro = Array.isArray(state.rptFunStatus) ? state.rptFunStatus : [];
    const aplicacaoFiltro = Array.isArray(state.rptFunAplicacao) ? state.rptFunAplicacao : [];

    const gerenciasDisponiveis = Array.from(new Set(allFunil.map((f) => titleCase(f.gerencia)).filter(Boolean))).sort();
    const vendedoresDisponiveis = Array.from(new Set(allFunil.map((f) => titleCase(f.vendedor)).filter(Boolean))).sort();
    const cidadesDisponiveis = Array.from(new Set(allFunil.map((f) => titleCase(f.cidade)).filter(Boolean))).sort();
    const statusDisponiveis = Array.from(new Set(allFunil.map((f) => f.status).filter(Boolean))).sort();
    const aplicacoesDisponiveis = Array.from(new Set(allFunil.map((f) => f.aplicacao).filter(Boolean))).sort();

    const period = state.rptFunPeriod;
    const { start, end } = resolvePeriodRange(period, state.rptFunCustomFrom, state.rptFunCustomTo);

    const funil = allFunil.filter((f) => inRange(parseDisplayDate(f.data), start, end)
        && (!gerencia || titleCase(f.gerencia) === gerencia)
        && (!vendedor || titleCase(f.vendedor) === vendedor)
        && (!cidade || titleCase(f.cidade) === cidade)
        && (!statusFiltro.length || statusFiltro.includes(f.status))
        && (!aplicacaoFiltro.length || aplicacaoFiltro.includes(f.aplicacao)));

    const funilByStatus = countBy(funil, (f) => f.status);
    const funilByCidade = countBy(funil, (f) => titleCase(f.cidade));
    const funilAtivo = funil.filter((f) => String(f.ativo || '').toLowerCase() === 'sim');
    const funilValorTotal = funilAtivo.reduce((sum, f) => sum + parseCurrencyBR(f.vlMensal), 0);
    const funilAtrasado = funil.filter((f) => {
        const dias = parseDisplayDate(f.atualizacao || f.data);
        return String(f.ativo || '').toLowerCase() === 'sim' && dias && (new Date() - dias) / 86400000 > 30;
    }).length;
    const funForecast = (f) => parseCurrencyBR(f.vlMensal) * (FUNIL_PROB[String(f.status || '').toUpperCase()] ?? 0.1);
    const funVendors = Array.from(new Set(funil.map((f) => titleCase(f.vendedor) || '-')));
    const funByVendor = funVendors.map((vend) => {
        const list = funil.filter((f) => (titleCase(f.vendedor) || '-') === vend);
        const ativas = list.filter((f) => String(f.ativo || '').toLowerCase() === 'sim');
        const st = (name) => ativas.filter((f) => String(f.status || '').toUpperCase() === name).length;
        const vlAtivo = ativas.reduce((s, f) => s + parseCurrencyBR(f.vlMensal), 0);
        const fc = list.reduce((s, f) => s + (String(f.ativo || '').toLowerCase() === 'sim' ? funForecast(f) : 0), 0);
        return {
            vend, ativas: ativas.length,
            identificar: st('IDENTIFICAR'), proposta: st('PROPOSTA'), negociar: st('NEGOCIAR'), retomar: st('RETOMAR'),
            concluidas: list.filter((f) => String(f.status || '').toUpperCase() === 'CONCLUIDO').length,
            perdidas: list.filter((f) => String(f.status || '').toUpperCase() === 'PERDIDO').length,
            vlAtivo, forecast: fc
        };
    }).sort((a, b) => b.vlAtivo - a.vlAtivo);
    const funForecastTotal = funilAtivo.reduce((s, f) => s + funForecast(f), 0);
    const funMotivoPerda = countBy(funil.filter((f) => String(f.status || '').toUpperCase() === 'PERDIDO'), (f) => f.motivoPerda || 'Não informado');
    const funPorAtuacao = countBy(funil, (f) => titleCase(f.atuacao));
    const funPorAplicacao = countBy(funil, (f) => titleCase(f.aplicacao));
    const funFechamento = funilAtivo.filter((f) => {
        const c = parseDisplayDate(f.conclusao);
        if (!c) return false;
        const dias = (c - new Date()) / 86400000;
        return dias >= -3 && dias <= 45;
    }).sort((a, b) => (parseDisplayDate(a.conclusao) || 0) - (parseDisplayDate(b.conclusao) || 0));
    const periodLabel = PERIOD_LABELS[period] || 'Mês atual';

    body.innerHTML = `
        <div class="report-print-header">
            <h2>Relatório de Funil — ${escapeHtml(periodLabel)}</h2>
            <p>Gerado por ${escapeHtml(state.currentUser?.name || '')} em ${new Date().toLocaleDateString('pt-BR')}</p>
        </div>
        <div class="card report-period-card no-print">
            <div class="visits-filter-header">
                <strong>Filtros</strong>
                <div class="visits-filter-header-actions">
                    <button type="button" class="text-link" id="report-filter-clear">Limpar</button>
                    <button type="button" class="text-link" id="report-filter-toggle">Ocultar</button>
                </div>
            </div>
            ${filterPanelHtml({
                period, isAdmin, gerencia, gerenciasDisponiveis, vendedor, vendedoresDisponiveis, cidade, cidadesDisponiveis,
                customFrom: state.rptFunCustomFrom, customTo: state.rptFunCustomTo,
                extraHtml: `
                ${statusDisponiveis.length ? `
                <div class="form-group report-status-filter">
                    <label for="report-funil-status">Status <span class="report-status-hint">(marque um ou mais)</span></label>
                    <div class="searchable-select">
                        <input type="text" id="report-funil-status" placeholder="Todos" autocomplete="off">
                        <div class="searchable-select-menu" id="report-funil-status-menu"></div>
                    </div>
                    <div class="selected-types" id="report-funil-status-selected" style="margin-top:0.3rem"></div>
                </div>` : ''}
                ${aplicacoesDisponiveis.length ? `
                <div class="form-group report-status-filter">
                    <label for="report-funil-aplicacao">Aplicação <span class="report-status-hint">(marque uma ou mais)</span></label>
                    <div class="searchable-select">
                        <input type="text" id="report-funil-aplicacao" placeholder="Todas" autocomplete="off">
                        <div class="searchable-select-menu" id="report-funil-aplicacao-menu"></div>
                    </div>
                    <div class="selected-types" id="report-funil-aplicacao-selected" style="margin-top:0.3rem"></div>
                </div>` : ''}
                `
            })}
        </div>

        <div class="report-section">
        <div class="report-section-head no-print">
            <h3>📊 Funil</h3>
            <div class="report-section-actions">
                <button type="button" class="text-link" id="pdf-funil">📄 Resumo</button>
                ${isAdmGer ? '<button type="button" class="text-link" id="pdf-det-funil">📄 Por vendedor</button>' : ''}
                <button type="button" class="text-link" id="csv-funil">📥 Excel</button>
            </div>
        </div>
        <div class="report-kpi-row">
            <div class="report-kpi"><strong>${funilAtivo.length}</strong><span>Ativas no período</span></div>
            <div class="report-kpi"><strong>${formatMoney(funilValorTotal)}</strong><span>Vl Mensal em pipeline</span></div>
            <div class="report-kpi"><strong>${formatMoney(funForecastTotal)}</strong><span>Forecast ponderado</span></div>
            <div class="report-kpi report-kpi-alert"><strong>${funilAtrasado}</strong><span>Sem atualização &gt;30d</span></div>
        </div>
        ${isAdmGer && funByVendor.length ? `<p class="report-subtitle">Por vendedor</p>${reportTable(
            ['Vendedor', 'Ativas', 'Identif.', 'Proposta', 'Negociar', 'Retomar', 'Concl.', 'Perd.', 'Vl Mensal', 'Forecast'],
            funByVendor.map((r) => [escapeHtml(r.vend), r.ativas, r.identificar, r.proposta, r.negociar, r.retomar, r.concluidas, r.perdidas, formatMoney(r.vlAtivo), formatMoney(r.forecast)])
        )}` : ''}
        ${funilByStatus.length ? `<p class="report-subtitle">Por status</p><div class="report-bar-list">${funilByStatus.map(([k, v]) => reportBar(k, v, funil.length)).join('')}</div>` : ''}
        ${funMotivoPerda.length ? `<p class="report-subtitle">Motivo da perda</p><div class="report-bar-list">${funMotivoPerda.map(([k, v]) => reportBar(k, v, funMotivoPerda.reduce((s, x) => s + x[1], 0))).join('')}</div>` : ''}
        ${funPorAtuacao.length ? `<p class="report-subtitle">Por atuação</p><div class="report-bar-list">${topN(funPorAtuacao, 10).map(([k, v]) => reportBar(k, v, funil.length)).join('')}</div>` : ''}
        ${funPorAplicacao.length ? `<p class="report-subtitle">Por aplicação</p><div class="report-bar-list">${topN(funPorAplicacao, 10).map(([k, v]) => reportBar(k, v, funil.length)).join('')}</div>` : ''}
        ${funilByCidade.length ? `<p class="report-subtitle">Por cidade (principais)</p><div class="report-bar-list">${topN(funilByCidade, 8).map(([k, v]) => reportBar(k, v, funil.length)).join('')}</div>` : ''}
        ${funFechamento.length ? `<p class="report-subtitle">Previsão de fechamento (conclusão nos próximos 45 dias)</p>${reportTable(
            ['Cliente', 'Vendedor', 'Status', 'Vl Mensal', 'Conclusão'],
            funFechamento.map((f) => [escapeHtml(titleCase(f.cliente)), escapeHtml(titleCase(f.vendedor)), escapeHtml(f.status || '-'), formatMoney(parseCurrencyBR(f.vlMensal)), escapeHtml(f.conclusao || '-')])
        )}` : ''}
        </div>
    `;

    wireFilterPanel({
        mainContent, rerender: () => renderReportFunilBody(mainContent, allFunil, isAdmGer),
        keys: { period: 'rptFunPeriod', customFrom: 'rptFunCustomFrom', customTo: 'rptFunCustomTo', gerencia: 'rptFunGerencia', vendedor: 'rptFunVendedor', cidade: 'rptFunCidade', filterCollapsed: 'rptFunFilterCollapsed' },
        extraClear: () => { state.rptFunStatus = []; state.rptFunAplicacao = []; }
    });
    initMultiSelectFilter('report-funil-status', statusDisponiveis, statusFiltro, () => {
        state.rptFunStatus = statusFiltro.slice();
        renderReportFunilBody(mainContent, allFunil, isAdmGer);
    });
    initMultiSelectFilter('report-funil-aplicacao', aplicacoesDisponiveis, aplicacaoFiltro, () => {
        state.rptFunAplicacao = aplicacaoFiltro.slice();
        renderReportFunilBody(mainContent, allFunil, isAdmGer);
    });

    document.getElementById('pdf-funil')?.addEventListener('click', () => printReport(''));
    document.getElementById('pdf-det-funil')?.addEventListener('click', async () => {
        if (!funil.length) { showToast('Nenhuma oportunidade no período.', true); return; }
        let funilParaPdf = funil;
        if (!statusFiltro.length && statusDisponiveis.length > 1) {
            const escolha = await pickStatusParaPdf(statusDisponiveis, 'Status no PDF');
            if (escolha === null) return;
            if (escolha.length) {
                funilParaPdf = funil.filter((f) => escolha.includes(f.status));
                if (!funilParaPdf.length) { showToast('Nenhuma oportunidade com esses status no período.', true); return; }
            }
        }
        printDetalhe('Funil — detalhado por vendedor', `${escapeHtml(periodLabel)}${gerencia ? ' · ' + gerencia : ''} — ${funilParaPdf.length} oportunidade(s)`, groupedVendorTables(
            funilParaPdf, (f) => f.vendedor, (f) => f.data,
            ['Data', 'Cliente', 'Foco', 'Atuação', 'Cidade', 'Status', 'Vl Mensal', 'Atualização', 'Tempo no funil'],
            (f) => [
                escapeHtml(f.data || '-'), escapeHtml(titleCase(f.cliente) || '-'), escapeHtml(f.foco || '-'),
                escapeHtml(titleCase(f.atuacao) || '-'), escapeHtml(titleCase(f.cidade) || '-'), escapeHtml(f.status || '-'),
                formatMoney(parseCurrencyBR(f.vlMensal)), escapeHtml(f.atualizacao || '-'), escapeHtml(formatAge(f.data))
            ]
        ));
    });
    document.getElementById('csv-funil')?.addEventListener('click', () => {
        const _stamp = new Date().toISOString().slice(0, 10);
        const rows = funil.slice().sort((a, b) => (parseDisplayDate(b.data) || 0) - (parseDisplayDate(a.data) || 0))
            .map((f) => ({
                data: f.data || '', vendedor: titleCase(f.vendedor), gerencia: titleCase(f.gerencia),
                cliente: titleCase(f.cliente), cidade: titleCase(f.cidade), status: f.status || '',
                ativo: f.ativo || '', foco: f.foco || '', atuacao: f.atuacao || '', aplicacao: f.aplicacao || '',
                equipamentos: f.equipamentos || '', vlMensal: parseCurrencyBR(f.vlMensal),
                forecast: Math.round(funForecast(f) * 100) / 100,
                atualizacao: f.atualizacao || '', diasSemAtualizacao: calculateDaysFromDisplayDate(f.atualizacao || f.data || ''),
                conclusao: f.conclusao || '', motivoPerda: f.motivoPerda || ''
            }));
        if (!rows.length) { showToast('Nenhuma oportunidade no período.', true); return; }
        downloadXLSX(rows, `funil-${_stamp}.xlsx`, [
            { key: 'data', label: 'Data', type: 'date' }, { key: 'vendedor', label: 'Vendedor' }, { key: 'gerencia', label: 'Gerência' },
            { key: 'cliente', label: 'Cliente' }, { key: 'cidade', label: 'Cidade' }, { key: 'status', label: 'Status' },
            { key: 'ativo', label: 'Ativo' }, { key: 'foco', label: 'Foco' }, { key: 'atuacao', label: 'Atuação' },
            { key: 'aplicacao', label: 'Aplicação' }, { key: 'equipamentos', label: 'Equipamentos' },
            { key: 'vlMensal', label: 'Vl Mensal (R$)' }, { key: 'forecast', label: 'Forecast ponderado (R$)' },
            { key: 'atualizacao', label: 'Última atualização', type: 'date' }, { key: 'diasSemAtualizacao', label: 'Dias sem atualização' },
            { key: 'conclusao', label: 'Conclusão prevista', type: 'date' }, { key: 'motivoPerda', label: 'Motivo da perda' }
        ], 'Funil');
    });
}
