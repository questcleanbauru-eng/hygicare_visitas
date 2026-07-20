import { state, navigateTo } from '../app.js';
import { escapeHtml, isAdminOrGerenteUser, getDateRangeForPeriod, parseDisplayDate, normalizeVisit, normalizeProposal, titleCase, parseCurrencyBR } from '../utils/format.js';
import { loadingState, showToast } from '../utils/dom.js';
import { ensureStyles, renderBreadcrumb } from '../utils/ui.js';

function formatMoney(value) {
    return value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
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

export async function renderReportPage() {
    ensureStyles('report');
    const mainContent = document.getElementById('main-content');
    mainContent.innerHTML = `
        ${renderBreadcrumb([{ label: 'Dashboard', page: 'dashboard' }, { label: 'Relatório' }])}
        <div class="page-header">
            <div><h2>Relatório de KPIs</h2><p class="page-subtitle">Resumo de visitas, propostas e funil</p></div>
            <button type="button" class="btn-add no-print" id="report-download-pdf">📄 Baixar PDF</button>
        </div>
        <div id="report-body">${loadingState('📊', 'Carregando relatório...')}</div>
    `;
    document.getElementById('report-download-pdf').addEventListener('click', () => window.print());

    const isAdmGer = isAdminOrGerenteUser();
    const [visitsMod, proposalsMod, funilMod] = await Promise.all([
        import('./visits.js'), import('./proposals.js'), import('./funil.js')
    ]);

    const [visitsRes, proposalsRes, funilRes] = await Promise.all([
        visitsMod.getVisits(0), proposalsMod.getProposals(0), funilMod.getFunil(0)
    ]);

    state.reportPeriod = state.reportPeriod || 'mes-atual';
    state.reportCustomFrom = state.reportCustomFrom || '';
    state.reportCustomTo = state.reportCustomTo || '';

    const allVisits = (visitsRes.status === 'success' ? visitsRes.visits : []).map(normalizeVisit);
    const allProposals = (proposalsRes.status === 'success' ? proposalsRes.proposals : []).map(normalizeProposal);
    const allFunil = funilRes.status === 'success' ? (funilRes.funil || []) : [];

    renderReportBody(mainContent, allVisits, allProposals, allFunil, isAdmGer);
}

function renderReportBody(mainContent, allVisits, allProposals, allFunil, isAdmGer) {
    const body = document.getElementById('report-body');
    if (!body) return;

    const period = state.reportPeriod;
    let start = null, end = null;
    if (period === 'personalizado') {
        start = state.reportCustomFrom ? new Date(state.reportCustomFrom + 'T00:00:00') : null;
        end = state.reportCustomTo ? new Date(state.reportCustomTo + 'T23:59:59') : null;
    } else {
        const range = getDateRangeForPeriod(period);
        start = range.start; end = range.end;
    }

    const visits = allVisits.filter((v) => inRange(parseDisplayDate(v.dataVisita), start, end));
    const proposals = allProposals.filter((p) => inRange(parseDisplayDate(p.data), start, end));
    const funil = allFunil.filter((f) => inRange(parseDisplayDate(f.data), start, end));

    const visitsByType = countBy(visits, (v) => v.tipoVisita);
    const visitsByVendor = countBy(visits, (v) => titleCase(v.vendedorGerente));

    const proposalsByStatus = countBy(proposals, (p) => p.status);
    const proposalsGanhas = proposals.filter((p) => (p.status || '').toLowerCase() === 'ganhamos').length;
    const conversao = proposals.length ? Math.round((proposalsGanhas / proposals.length) * 100) : 0;
    const proposalsAtrasadas = proposals.filter((p) => p.atrasada).length;

    const funilByStatus = countBy(funil, (f) => f.status);
    const funilAtivo = funil.filter((f) => String(f.ativo || '').toLowerCase() === 'sim');
    const funilValorTotal = funilAtivo.reduce((sum, f) => sum + parseCurrencyBR(f.vlMensal), 0);
    const funilAtrasado = funil.filter((f) => {
        const dias = parseDisplayDate(f.atualizacao || f.data);
        return String(f.ativo || '').toLowerCase() === 'sim' && dias && (new Date() - dias) / 86400000 > 30;
    }).length;

    const periodLabel = {
        'semana-atual': 'Semana atual',
        'mes-atual': 'Mês atual',
        'ultimos-3m': 'Últimos 3 meses',
        'personalizado': 'Período personalizado'
    }[period] || 'Mês atual';

    body.innerHTML = `
        <div class="report-print-header">
            <h2>Relatório de KPIs — ${escapeHtml(periodLabel)}</h2>
            <p>Gerado por ${escapeHtml(state.currentUser?.name || '')} em ${new Date().toLocaleDateString('pt-BR')}</p>
        </div>
        <div class="card report-period-card no-print">
            <div class="report-period-buttons">
                <button type="button" class="mini-button ${period === 'semana-atual' ? 'active' : ''}" data-period="semana-atual">Semana atual</button>
                <button type="button" class="mini-button ${period === 'mes-atual' ? 'active' : ''}" data-period="mes-atual">Mês atual</button>
                <button type="button" class="mini-button ${period === 'ultimos-3m' ? 'active' : ''}" data-period="ultimos-3m">Últimos 3 meses</button>
                <button type="button" class="mini-button ${period === 'personalizado' ? 'active' : ''}" data-period="personalizado">Personalizado</button>
            </div>
            ${period === 'personalizado' ? `
            <div class="report-custom-range">
                <div class="form-group"><label for="report-date-from">De</label><input type="date" id="report-date-from" value="${escapeHtml(state.reportCustomFrom)}"></div>
                <div class="form-group"><label for="report-date-to">Até</label><input type="date" id="report-date-to" value="${escapeHtml(state.reportCustomTo)}"></div>
            </div>` : ''}
        </div>

        <div class="report-section">
            <h3>📋 Visitas</h3>
            <div class="report-kpi-row">
                <div class="report-kpi"><strong>${visits.length}</strong><span>Total no período</span></div>
            </div>
            ${visitsByType.length ? `<p class="report-subtitle">Por tipo</p><div class="report-bar-list">${visitsByType.map(([k, v]) => reportBar(k, v, visits.length)).join('')}</div>` : ''}
            ${isAdmGer && visitsByVendor.length ? `<p class="report-subtitle">Por vendedor</p><div class="report-bar-list">${visitsByVendor.map(([k, v]) => reportBar(k, v, visits.length)).join('')}</div>` : ''}
        </div>

        <div class="report-section">
            <h3>📄 Propostas</h3>
            <div class="report-kpi-row">
                <div class="report-kpi"><strong>${proposals.length}</strong><span>Total no período</span></div>
                <div class="report-kpi"><strong>${conversao}%</strong><span>Taxa de conversão</span></div>
                <div class="report-kpi report-kpi-alert"><strong>${proposalsAtrasadas}</strong><span>Atrasadas</span></div>
            </div>
            ${proposalsByStatus.length ? `<p class="report-subtitle">Por status</p><div class="report-bar-list">${proposalsByStatus.map(([k, v]) => reportBar(k, v, proposals.length)).join('')}</div>` : ''}
        </div>

        <div class="report-section">
            <h3>📊 Funil</h3>
            <div class="report-kpi-row">
                <div class="report-kpi"><strong>${funilAtivo.length}</strong><span>Ativas no período</span></div>
                <div class="report-kpi"><strong>${formatMoney(funilValorTotal)}</strong><span>Valor em pipeline</span></div>
                <div class="report-kpi report-kpi-alert"><strong>${funilAtrasado}</strong><span>Sem atualização &gt;30d</span></div>
            </div>
            ${funilByStatus.length ? `<p class="report-subtitle">Por status</p><div class="report-bar-list">${funilByStatus.map(([k, v]) => reportBar(k, v, funil.length)).join('')}</div>` : ''}
        </div>
    `;

    body.querySelectorAll('[data-period]').forEach((btn) => {
        btn.addEventListener('click', () => {
            state.reportPeriod = btn.dataset.period;
            renderReportBody(mainContent, allVisits, allProposals, allFunil, isAdmGer);
        });
    });
    document.getElementById('report-date-from')?.addEventListener('change', (e) => {
        state.reportCustomFrom = e.target.value;
        renderReportBody(mainContent, allVisits, allProposals, allFunil, isAdmGer);
    });
    document.getElementById('report-date-to')?.addEventListener('change', (e) => {
        state.reportCustomTo = e.target.value;
        renderReportBody(mainContent, allVisits, allProposals, allFunil, isAdmGer);
    });
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
