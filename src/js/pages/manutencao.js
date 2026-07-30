import { state, navigateTo } from '../app.js';
import { callAPI, saveCache, loadCache, ensureFormData, attemptOrQueue } from '../api.js';
import { escapeHtml, isAdminOrGerenteUser, normalizeManutencao, titleCase, TIPOS_RELATORIO_MANUTENCAO } from '../utils/format.js';
import {
    debounce, initializeSearchableInput, renderDetailRow, showToast,
    skeletonList, skeletonDetail, addScrollTop, setSaving
} from '../utils/dom.js';
import { initPullToRefresh, renderBreadcrumb, ensureStyles } from '../utils/ui.js';

const TIPO_ICON = { afericao_vazao: '🔬', calibracao_manutencao: '🔧', atendimento_lavanderia: '🧺' };

// Grupos de checklist do relatório "Atendimento ao Cliente — Lavanderia" —
// listKey bate com formData.manutencaoListas (MANUTENCAO_LISTS em
// lib/handlers/manutencao.js), key bate com o campo normalizado (mesmo nome
// usado em normalizeManutencao/LAVANDERIA_FIELDS).
const CHECKLIST_GRUPOS = [
    { key: 'checklistDosador1', listKey: 'mntDosadorGrupo1', title: 'Dosador — Grupo 1' },
    { key: 'checklistDosador2', listKey: 'mntDosadorGrupo2', title: 'Dosador — Grupo 2' },
    { key: 'checklistMaquina1', listKey: 'mntMaquinaGrupo1', title: 'Máquina — Grupo 1' },
    { key: 'checklistMaquina2', listKey: 'mntMaquinaGrupo2', title: 'Máquina — Grupo 2' },
    { key: 'checklistEstocagem1', listKey: 'mntEstocagemGrupo1', title: 'Estocagem — Grupo 1' },
    { key: 'checklistEstocagem2', listKey: 'mntEstocagemGrupo2', title: 'Estocagem — Grupo 2' }
];
const VAZOES_BOMBAS_QTD = 6;

function tipoLabel(tipo, labels) {
    return (labels && labels[tipo]) || TIPOS_RELATORIO_MANUTENCAO[tipo] || tipo || '-';
}

function safeParseJson(value, fallback) {
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : fallback;
    } catch (e) {
        return fallback;
    }
}

export function fillManutencaoContent(mainContent, manutencoes, formData) {
    const fd = formData || {};
    const labels = fd.manutencaoLabels || TIPOS_RELATORIO_MANUTENCAO;
    const normalized = (manutencoes || []).map(normalizeManutencao);
    const isAdmGer = isAdminOrGerenteUser();

    if (normalized.length === 0) {
        mainContent.innerHTML = `
            <div class="page-header">
                <div><h2>Manutenção</h2></div>
                <button type="button" class="btn-add" id="btn-new-manutencao">+ Novo Relatório</button>
            </div>
            <div class="empty-state">
                <span class="empty-state-icon">🔧</span>
                <p>Nenhum relatório de manutenção registrado ainda.</p>
                <button type="button" class="btn-add" id="btn-new-manutencao2">+ Novo Relatório</button>
            </div>
        `;
        document.getElementById('btn-new-manutencao')?.addEventListener('click', () => navigateTo('manutencao-new'));
        document.getElementById('btn-new-manutencao2')?.addEventListener('click', () => navigateTo('manutencao-new'));
        return;
    }

    const availableCidades = Array.from(new Set(normalized.map((m) => m.cidade).filter(Boolean))).sort();
    const availableTecnicos = isAdmGer
        ? Array.from(new Set(normalized.map((m) => m.tecnico).filter(Boolean))).sort()
        : [];

    mainContent.innerHTML = `
        <div class="page-header">
            <div><h2>Manutenção</h2><p class="page-subtitle">${normalized.length} relatório(s)</p></div>
            <button type="button" class="btn-add" id="btn-new-manutencao">+ Novo Relatório</button>
        </div>
        <div class="search-bar-wrapper">
            <div class="search-bar-input-group">
                <span class="search-bar-icon">🔍</span>
                <input type="text" id="mnt-search" placeholder="Buscar cliente, cidade ou técnico..." class="form-input">
            </div>
        </div>
        <div class="card visits-filter-card">
            <div class="visits-filter-header">
                <strong>Filtros</strong>
                <div class="visits-filter-header-actions">
                    <button type="button" class="mini-button" id="mnt-filter-clear">Limpar</button>
                    <button type="button" class="mini-button" id="mnt-filter-toggle">Ocultar</button>
                </div>
            </div>
            <div class="visits-filter-grid" id="mnt-filter-panel">
                <div class="form-group">
                    <label for="mnt-tipo">Tipo de relatório</label>
                    <select id="mnt-tipo">
                        <option value="">Todos</option>
                        <option value="afericao_vazao">${escapeHtml(labels.afericao_vazao || 'Aferição de Vazão')}</option>
                        <option value="calibracao_manutencao">${escapeHtml(labels.calibracao_manutencao || 'Calibração/Manutenção')}</option>
                        <option value="atendimento_lavanderia">${escapeHtml(labels.atendimento_lavanderia || 'Atendimento ao Cliente — Lavanderia')}</option>
                    </select>
                </div>
                <div class="form-group">
                    <label for="mnt-cidade">Cidade</label>
                    <div class="searchable-select">
                        <input type="text" id="mnt-cidade" placeholder="Todas" autocomplete="off">
                        <div class="searchable-select-menu" id="mnt-cidade-menu"></div>
                    </div>
                </div>
                ${isAdmGer ? `
                <div class="form-group">
                    <label for="mnt-tecnico">Técnico</label>
                    <div class="searchable-select">
                        <input type="text" id="mnt-tecnico" placeholder="Todos" autocomplete="off">
                        <div class="searchable-select-menu" id="mnt-tecnico-menu"></div>
                    </div>
                </div>` : ''}
            </div>
        </div>
        <div id="manutencao-list-container"></div>
    `;

    const filterPanel  = document.getElementById('mnt-filter-panel');
    const filterToggle = document.getElementById('mnt-filter-toggle');
    const isMobile = window.matchMedia('(max-width: 640px)').matches;
    let collapsed = isMobile;
    filterPanel.classList.toggle('collapsed', collapsed);
    filterToggle.textContent = collapsed ? 'Mostrar' : 'Ocultar';
    filterToggle.addEventListener('click', () => {
        collapsed = !collapsed;
        filterPanel.classList.toggle('collapsed', collapsed);
        filterToggle.textContent = collapsed ? 'Mostrar' : 'Ocultar';
    });

    const renderFiltered = () => {
        const search  = document.getElementById('mnt-search')?.value.trim().toLowerCase() || '';
        const tipo    = document.getElementById('mnt-tipo')?.value || '';
        const cidade  = document.getElementById('mnt-cidade')?.value || '';
        const tecnico = document.getElementById('mnt-tecnico')?.value || '';

        const filtered = normalized.filter((m) => {
            const matchSearch  = !search || [m.cliente, m.cidade, m.tecnico].some((v) => String(v || '').toLowerCase().includes(search));
            const matchTipo    = !tipo || m.tipoRelatorio === tipo;
            const matchCidade  = !cidade || m.cidade === cidade;
            const matchTecnico = !tecnico || m.tecnico === tecnico;
            return matchSearch && matchTipo && matchCidade && matchTecnico;
        });

        const container = document.getElementById('manutencao-list-container');
        if (!container) return;

        if (filtered.length === 0) {
            container.innerHTML = `<div class="empty-state"><span class="empty-state-icon">🔍</span><p>Nenhum relatório para os filtros selecionados.</p></div>`;
            return;
        }

        const sorted = [...filtered].sort((a, b) => Number(b.id) - Number(a.id));

        container.innerHTML = `<div class="visits-list">${sorted.map((m) => `
            <button type="button" class="proposal-card" data-manutencao-id="${escapeHtml(m.id)}">
                <div class="visit-card-header">
                    <strong><span aria-hidden="true">${TIPO_ICON[m.tipoRelatorio] || '🔧'}</span> ${escapeHtml(m.cliente || 'Cliente não informado')}</strong>
                    ${m._pending ? '<span class="pending-badge" title="Aguardando conexão para enviar">⏳ Pendente</span>' : (m.pendenteAprovacao === 'Sim' ? '<span class="status-pill funil-status-proposta">Pendente de aprovação</span>' : '')}
                </div>
                <div class="proposal-meta">
                    <span>${escapeHtml(tipoLabel(m.tipoRelatorio, labels))}</span>
                    <span>${escapeHtml(m.cidade || '-')}</span>
                </div>
                <div class="proposal-meta">
                    <span>${escapeHtml(titleCase(m.tecnico) || '-')}</span>
                    <span>${escapeHtml(m.data || '-')}</span>
                </div>
            </button>
        `).join('')}</div>`;

        container.querySelectorAll('[data-manutencao-id]').forEach((btn) => {
            btn.addEventListener('click', () => navigateTo('manutencao-detail', { id: btn.dataset.manutencaoId }));
        });
    };

    initializeSearchableInput({ input: document.getElementById('mnt-cidade'), menu: document.getElementById('mnt-cidade-menu'), items: availableCidades });
    if (isAdmGer) {
        initializeSearchableInput({ input: document.getElementById('mnt-tecnico'), menu: document.getElementById('mnt-tecnico-menu'), items: availableTecnicos });
    }

    const _filterIds = ['mnt-search', 'mnt-tipo', 'mnt-cidade', 'mnt-tecnico'];
    const _textFilterIds = new Set(['mnt-search', 'mnt-cidade', 'mnt-tecnico']);
    const _debouncedFilter = debounce(renderFiltered, 250);
    _filterIds.forEach((id) => {
        const isText = _textFilterIds.has(id);
        document.getElementById(id)?.addEventListener(isText ? 'input' : 'change', isText ? _debouncedFilter : renderFiltered);
    });
    document.getElementById('mnt-filter-clear')?.addEventListener('click', () => {
        _filterIds.forEach((id) => { const el = document.getElementById(id); if (el) el.value = ''; });
        renderFiltered();
    });

    document.getElementById('btn-new-manutencao')?.addEventListener('click', () => navigateTo('manutencao-new'));
    renderFiltered();
}

export async function renderManutencaoPage() {
    ensureStyles('manutencao');
    const mainContent = document.getElementById('main-content');
    const cachedRaw = loadCache('manutencoes');
    const cached = (Array.isArray(cachedRaw) && cachedRaw.length > 0) ? cachedRaw : null;
    if (cached) {
        state.manutencoes = cached;
        const fd = (await ensureFormData()).data || {};
        fillManutencaoContent(mainContent, state.manutencoes, fd);
        addScrollTop();
        initPullToRefresh(async () => {
            const r = await getManutencoes();
            if (r.status === 'success' && state.currentPage === 'manutencao') {
                state.manutencoes = r.manutencoes || [];
                const el = document.getElementById('main-content');
                if (el) fillManutencaoContent(el, state.manutencoes, state.formData);
            }
        });
        getManutencoes();
        return;
    }
    mainContent.innerHTML = skeletonList(5);
    const [result, fdResult] = await Promise.all([getManutencoes(), ensureFormData()]);
    if (result.status !== 'success') {
        mainContent.innerHTML = `<p class="error-message">${escapeHtml(result.message || 'Erro ao carregar relatórios de manutenção.')}</p>`;
        return;
    }
    state.manutencoes = result.manutencoes || [];
    fillManutencaoContent(mainContent, state.manutencoes, fdResult.data || {});
    addScrollTop();
    initPullToRefresh(async () => {
        const r = await getManutencoes();
        if (r.status === 'success' && state.currentPage === 'manutencao') {
            state.manutencoes = r.manutencoes || [];
            const el = document.getElementById('main-content');
            if (el) fillManutencaoContent(el, state.manutencoes, state.formData);
        }
    });
}

function vazoesTableHtml(rows) {
    const body = Array.from({ length: VAZOES_BOMBAS_QTD }, (_, i) => rows[i] || {});
    return `<table class="mnt-table"><thead><tr><th>Bomba</th><th>Produto</th><th>Diluição</th><th>Vazão Aferida</th></tr></thead>
        <tbody>${body.map((r, i) => `<tr><td>Bomba ${i + 1}</td><td>${escapeHtml(r.produto || '-')}</td><td>${escapeHtml(r.diluicao || '-')}</td><td>${escapeHtml(r.vazaoAferida || '-')}</td></tr>`).join('')}</tbody></table>`;
}

function checklistDetailHtml(grupo, items, checked) {
    return `
    <p class="mnt-checklist-group-title">${escapeHtml(grupo.title)}</p>
    <p class="mnt-checklist-detail-items">${items.length ? items.map((it) => `${checked.includes(it) ? '✅' : '⬜'} ${escapeHtml(it)}`).join(' &nbsp; ') : '-'}</p>`;
}

export async function renderManutencaoDetailPage(id) {
    ensureStyles('manutencao');
    const mainContent = document.getElementById('main-content');
    if (!state.manutencoes.find((m) => String(m.Id || m.id) === String(id))) {
        mainContent.innerHTML = skeletonDetail(10);
    }
    // A lista deixa um botão de "voltar ao topo" pra trás (só o próprio
    // addScrollTop remove o anterior, e essa página não chama de novo).
    document.getElementById('page-scroll-top')?.remove();

    const [result, fdResult] = await Promise.all([getManutencaoById(id), ensureFormData()]);
    if (result.status !== 'success') {
        mainContent.innerHTML = `<p class="error-message">${escapeHtml(result.message || 'Relatório não encontrado.')}</p>`;
        return;
    }

    const fd = fdResult.data || {};
    const labels = fd.manutencaoLabels || TIPOS_RELATORIO_MANUTENCAO;
    const lists = fd.manutencaoListas || {};
    const m = normalizeManutencao(result.manutencao);
    state.currentManutencao = m;
    const isAdmin = (state.currentUser?.profile || '').toLowerCase() === 'admin';
    const jaAssinado = !!(m.assinaturaTecnico && m.assinaturaCliente);
    const isLavanderia = m.tipoRelatorio === 'atendimento_lavanderia';
    const itens = safeParseJson(m.itensTabela, []);
    const pecas = safeParseJson(m.pecasDiluidor, []);

    const tabelaHtml = m.tipoRelatorio === 'afericao_vazao'
        ? `<table class="mnt-table"><thead><tr><th>Equipamento</th><th>Produto</th><th>Diluição</th><th>Aferido</th></tr></thead>
            <tbody>${itens.map((i) => `<tr><td>${escapeHtml(i.equipamento || '-')}</td><td>${escapeHtml(i.produto || '-')}</td><td>${escapeHtml(i.diluicao || '-')}</td><td>${escapeHtml(i.aferido || '-')}</td></tr>`).join('') || '<tr><td colspan="4">Sem itens.</td></tr>'}</tbody></table>`
        : `<table class="mnt-table"><thead><tr><th>Produto</th><th>Referência Diluição</th><th>Aferição</th></tr></thead>
            <tbody>${itens.map((i) => `<tr><td>${escapeHtml(i.produto || '-')}</td><td>${escapeHtml(i.referenciaDiluicao || '-')}</td><td>${escapeHtml(i.afericao || '-')}</td></tr>`).join('') || '<tr><td colspan="3">Sem itens.</td></tr>'}</tbody></table>`;

    mainContent.innerHTML = `
        ${renderBreadcrumb([{ label: 'Manutenção', page: 'manutencao' }, { label: m.cliente || 'Relatório' }])}
        <div class="page-header compact-header">
            <button type="button" class="mini-button" id="back-manutencao">Voltar</button>
            <h2>Detalhes do Relatório</h2>
            <div class="header-actions-group">
                <button type="button" class="mini-button" id="edit-manutencao">Editar</button>
                ${state.canDelete ? '<button type="button" class="mini-button mini-button-danger" id="delete-manutencao" aria-label="Apagar" title="Apagar">🗑️</button>' : ''}
            </div>
        </div>
        ${m.pendenteAprovacao === 'Sim' ? `
        <div class="alert-banner">
            <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#F59E0B" stroke-width="2" stroke-linecap="round" style="flex-shrink:0;margin-top:1px"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
            <span style="flex:1">Este relatório foi editado após ser assinado e está pendente de aprovação.</span>
            ${isAdmin ? '<button type="button" class="mini-button" id="approve-manutencao" style="margin-left:0.5rem">Aprovar</button>' : ''}
        </div>` : ''}
        <div class="card detail-card">
            ${renderDetailRow('Tipo de Relatório', tipoLabel(m.tipoRelatorio, labels))}
            ${renderDetailRow('Cliente', titleCase(m.cliente))}
            ${renderDetailRow('Cidade', titleCase(m.cidade))}
            ${renderDetailRow('Técnico', titleCase(m.tecnico))}
            ${renderDetailRow('Data', m.data)}
            ${m.tipoRelatorio === 'calibracao_manutencao' ? renderDetailRow('Tipo de Visita', m.tipoVisita || '-') : ''}
            ${m.tipoRelatorio === 'calibracao_manutencao' ? renderDetailRow('Tipo de Equipamento', m.tipoEquipamento || '-') : ''}
        </div>
        ${!isLavanderia ? `
        <div class="card detail-card">
            <p class="report-subtitle" style="margin-top:0">Tabela de Aferição</p>
            <div style="overflow-x:auto">${tabelaHtml}</div>
        </div>` : ''}
        ${m.tipoRelatorio === 'calibracao_manutencao' ? `
        <div class="card detail-card">
            <p class="report-subtitle" style="margin-top:0">Peças (Diluidor)</p>
            <p>${(lists.mntPecasDiluidor || []).map((p) => `${pecas.includes(p) ? '✅' : '⬜'} ${escapeHtml(p)}`).join(' &nbsp; ') || '-'}</p>
        </div>` : ''}
        ${isLavanderia ? `
        <div class="card detail-card">
            <p class="report-subtitle" style="margin-top:0">Dados do Atendimento</p>
            ${renderDetailRow('Vendedor', titleCase(m.vendedor) || '-')}
            ${renderDetailRow('Equipamento', m.equipamentoNome || '-')}
            ${renderDetailRow('Tipo de Máquina', m.tipoMaquina || '-')}
            ${renderDetailRow('Tipo de Visita', m.tipoVisita || '-')}
            ${renderDetailRow('Hora de Chegada', m.horaChegada || '-')}
            ${renderDetailRow('Hora de Saída', m.horaSaida || '-')}
            ${renderDetailRow('Refeição', m.refeicao || '-')}
            ${renderDetailRow('Km Inicial', m.kmInicial || '-')}
            ${renderDetailRow('Km Final', m.kmFinal || '-')}
        </div>
        <div class="card detail-card">
            <p class="report-subtitle" style="margin-top:0">Checklist</p>
            ${CHECKLIST_GRUPOS.map((g) => checklistDetailHtml(g, lists[g.listKey] || [], safeParseJson(m[g.key], []))).join('')}
        </div>
        <div class="card detail-card">
            <p class="report-subtitle" style="margin-top:0">Vazões das Bombas</p>
            <div style="overflow-x:auto">${vazoesTableHtml(safeParseJson(m.vazoesBombas, []))}</div>
        </div>
        <div class="card detail-card">
            ${renderDetailRow('Problemas na Máquina', m.problemasMaquina || '-')}
            ${renderDetailRow('Problemas na Estocagem', m.problemasEstocagem || '-')}
        </div>` : ''}
        <div class="card detail-card">
            ${renderDetailRow('Observação', m.observacao || '-')}
        </div>
        <div class="card detail-card">
            <p class="report-subtitle" style="margin-top:0">Assinaturas</p>
            <p class="helper-text" style="margin:0">${jaAssinado ? 'Assinado pelo técnico e pelo cliente.' : 'Ainda sem assinatura — a captura de assinatura na tela chega no próximo bloco desta funcionalidade.'}</p>
        </div>
    `;

    document.getElementById('back-manutencao').addEventListener('click', () => navigateTo('manutencao'));
    document.getElementById('edit-manutencao').addEventListener('click', () => navigateTo('manutencao-edit', { manutencao: m }));
    document.getElementById('approve-manutencao')?.addEventListener('click', async (event) => {
        const btn = event.currentTarget;
        setSaving(true, btn, 'Aprovando...');
        const result2 = await callAPI('approveManutencao', { id: m.id, user: state.currentUser });
        if (result2 && result2.status === 'success') {
            showToast('Relatório aprovado.');
            saveCache('manutencoes', null);
            state.manutencoes = [];
            navigateTo('manutencao-detail', { id: m.id });
        } else {
            showToast((result2 && result2.message) || 'Não foi possível aprovar.', true);
            setSaving(false, btn);
        }
    });
    document.getElementById('delete-manutencao')?.addEventListener('click', async (event) => {
        if (!confirm(`Apagar o relatório de "${m.cliente || 'cliente'}"? Essa ação não pode ser desfeita.`)) return;
        const btn = event.currentTarget;
        setSaving(true, btn, 'Apagando...');
        const result2 = await callAPI('deleteManutencao', { id: m.id, user: state.currentUser });
        if (result2 && result2.status === 'success') {
            state.manutencoes = state.manutencoes.filter((item) => String(item.id) !== String(m.id));
            saveCache('manutencoes', state.manutencoes);
            showToast('Relatório apagado.');
            navigateTo('manutencao');
        } else {
            showToast((result2 && result2.message) || 'Não foi possível apagar o relatório.', true);
            setSaving(false, btn);
        }
    });
}

function itemRowHtml(tipoRelatorio, item = {}) {
    if (tipoRelatorio === 'afericao_vazao') {
        return `
        <div class="mnt-item-row" data-item-row>
            <input type="text" placeholder="Equipamento" class="mnt-item-equipamento" value="${escapeHtml(item.equipamento || '')}">
            <input type="text" placeholder="Produto" class="mnt-item-produto" value="${escapeHtml(item.produto || '')}">
            <input type="text" placeholder="Diluição" class="mnt-item-diluicao" value="${escapeHtml(item.diluicao || '')}">
            <input type="text" placeholder="Aferido" class="mnt-item-aferido" value="${escapeHtml(item.aferido || '')}">
            <button type="button" class="mini-button mini-button-danger mnt-item-remove" aria-label="Remover linha">×</button>
        </div>`;
    }
    return `
    <div class="mnt-item-row" data-item-row>
        <input type="text" placeholder="Produto" class="mnt-item-produto" value="${escapeHtml(item.produto || '')}">
        <input type="text" placeholder="Referência Diluição" class="mnt-item-referencia" value="${escapeHtml(item.referenciaDiluicao || '')}">
        <input type="text" placeholder="Aferição" class="mnt-item-afericao" value="${escapeHtml(item.afericao || '')}">
        <button type="button" class="mini-button mini-button-danger mnt-item-remove" aria-label="Remover linha">×</button>
    </div>`;
}

function bindItemRowRemove(container) {
    container.querySelectorAll('.mnt-item-remove').forEach((btn) => {
        if (btn.dataset.bound) return;
        btn.dataset.bound = '1';
        btn.addEventListener('click', () => btn.closest('[data-item-row]')?.remove());
    });
}

function collectItens(tipoRelatorio, container) {
    const rows = Array.from(container.querySelectorAll('[data-item-row]'));
    if (tipoRelatorio === 'afericao_vazao') {
        return rows.map((row) => ({
            equipamento: row.querySelector('.mnt-item-equipamento').value.trim(),
            produto: row.querySelector('.mnt-item-produto').value.trim(),
            diluicao: row.querySelector('.mnt-item-diluicao').value.trim(),
            aferido: row.querySelector('.mnt-item-aferido').value.trim()
        })).filter((i) => i.equipamento || i.produto || i.diluicao || i.aferido);
    }
    return rows.map((row) => ({
        produto: row.querySelector('.mnt-item-produto').value.trim(),
        referenciaDiluicao: row.querySelector('.mnt-item-referencia').value.trim(),
        afericao: row.querySelector('.mnt-item-afericao').value.trim()
    })).filter((i) => i.produto || i.referenciaDiluicao || i.afericao);
}

function mntField(id, label, value, opts = {}) {
    return `
    <div class="form-group mnt-tipo-fields" data-tipo-fields="atendimento_lavanderia">
        <label for="${id}">${escapeHtml(label)}</label>
        <input type="${opts.type || 'text'}" id="${id}" value="${escapeHtml(value || '')}">
    </div>`;
}

function checklistGroupFormHtml(grupo, items, checkedInitial) {
    return `
    <div class="mnt-checklist-group">
        <p class="mnt-checklist-group-title">${escapeHtml(grupo.title)}</p>
        <div class="mnt-checklist-items" data-checklist-key="${grupo.key}">
            ${items.length ? items.map((item) => `
            <label class="mnt-checklist-check">
                <input type="checkbox" value="${escapeHtml(item)}" ${checkedInitial.includes(item) ? 'checked' : ''}>
                <span>${escapeHtml(item)}</span>
            </label>`).join('') : '<p class="helper-text" style="margin:0">Nenhum item cadastrado — adicione em Admin &rarr; Listas.</p>'}
        </div>
    </div>`;
}

function collectChecklist(key) {
    const group = document.querySelector(`[data-checklist-key="${key}"]`);
    if (!group) return '[]';
    return JSON.stringify(Array.from(group.querySelectorAll('input:checked')).map((el) => el.value));
}

function vazoesRowHtml(n, row = {}) {
    return `
    <tr data-vazao-row="${n}">
        <td>Bomba ${n}</td>
        <td><input type="text" class="mnt-vazao-produto" value="${escapeHtml(row.produto || '')}"></td>
        <td><input type="text" class="mnt-vazao-diluicao" value="${escapeHtml(row.diluicao || '')}"></td>
        <td><input type="text" class="mnt-vazao-aferida" value="${escapeHtml(row.vazaoAferida || '')}"></td>
    </tr>`;
}

function collectVazoes() {
    const rows = Array.from(document.querySelectorAll('#mnt-vazoes-container [data-vazao-row]'));
    return JSON.stringify(rows.map((row) => ({
        produto: row.querySelector('.mnt-vazao-produto').value.trim(),
        diluicao: row.querySelector('.mnt-vazao-diluicao').value.trim(),
        vazaoAferida: row.querySelector('.mnt-vazao-aferida').value.trim()
    })).filter((r) => r.produto || r.diluicao || r.vazaoAferida));
}

// Alterna quais blocos `.mnt-tipo-fields` ficam visíveis pro tipo de
// relatório escolhido — cada bloco declara pra quais tipos ele vale em
// data-tipo-fields (separado por vírgula quando vale pra mais de um, ex.: a
// Tabela de Aferição comum a Aferição de Vazão e Calibração/Manutenção).
function syncTipoFieldsVisibility(tipoAtual) {
    document.querySelectorAll('.mnt-tipo-fields').forEach((el) => {
        const tipos = (el.dataset.tipoFields || '').split(',');
        el.style.display = tipos.includes(tipoAtual) ? '' : 'none';
    });
}

export async function renderManutencaoFormPage(record) {
    ensureStyles('manutencao');
    const mainContent = document.getElementById('main-content');
    const isEdit = Boolean(record && (record.Id || record.id));
    const m = isEdit ? normalizeManutencao(record) : normalizeManutencao({});
    const isAdmin = (state.currentUser?.profile || '').toLowerCase() === 'admin';

    if (!state.formData) {
        mainContent.innerHTML = `
            <div class="page-header compact-header">
                <button type="button" class="mini-button" id="back-manutencao-overlay">Voltar</button>
                <h2>${isEdit ? 'Editar Relatório' : 'Novo Relatório de Manutenção'}</h2>
            </div>
            <div class="card form-card" style="position:relative;min-height:200px;">
                <div class="form-loading-overlay">
                    <div class="form-loading-spinner"></div>
                    <span>Carregando formulario...</span>
                </div>
            </div>
        `;
        document.getElementById('back-manutencao-overlay')?.addEventListener('click', () => navigateTo(isEdit ? 'manutencao-detail' : 'manutencao', isEdit ? { id: m.id } : {}));
    }

    const fdResult = await ensureFormData();
    const cidades = (fdResult.data && fdResult.data.cidades) || [];
    const clientes = (fdResult.data && fdResult.data.clientes) || [];
    const lists = (fdResult.data && fdResult.data.manutencaoListas) || {};
    const labels = (fdResult.data && fdResult.data.manutencaoLabels) || TIPOS_RELATORIO_MANUTENCAO;

    const itensIniciais = isEdit ? safeParseJson(m.itensTabela, []) : [];
    const pecasIniciais = isEdit ? safeParseJson(m.pecasDiluidor, []) : [];
    const vazoesIniciais = isEdit ? safeParseJson(m.vazoesBombas, []) : [];
    const tipoInicial = m.tipoRelatorio || 'afericao_vazao';

    mainContent.innerHTML = `
        <div class="page-header compact-header">
            <button type="button" class="mini-button" id="back-manutencao-form">Voltar</button>
            <h2>${isEdit ? 'Editar Relatório' : 'Novo Relatório de Manutenção'}</h2>
        </div>
        <form id="manutencao-form" class="card form-card form-layout">
            <div class="form-group full-width">
                <label>Tipo de Relatório</label>
                <div class="radio-group">
                    <label class="radio-pill"><input type="radio" name="mnt-tipo-relatorio" value="afericao_vazao" ${tipoInicial === 'afericao_vazao' ? 'checked' : ''}><span>${escapeHtml(labels.afericao_vazao || 'Aferição de Vazão')}</span></label>
                    <label class="radio-pill"><input type="radio" name="mnt-tipo-relatorio" value="calibracao_manutencao" ${tipoInicial === 'calibracao_manutencao' ? 'checked' : ''}><span>${escapeHtml(labels.calibracao_manutencao || 'Calibração/Manutenção')}</span></label>
                    <label class="radio-pill"><input type="radio" name="mnt-tipo-relatorio" value="atendimento_lavanderia" ${tipoInicial === 'atendimento_lavanderia' ? 'checked' : ''}><span>${escapeHtml(labels.atendimento_lavanderia || 'Atendimento ao Cliente — Lavanderia')}</span></label>
                </div>
            </div>
            <div class="form-group full-width">
                <label for="mnt-cliente">Cliente</label>
                <div class="searchable-select">
                    <input type="text" id="mnt-cliente" value="${escapeHtml(m.cliente)}" placeholder="Busque ou digite o cliente" autocomplete="off" required>
                    <div class="searchable-select-menu" id="mnt-cliente-menu"></div>
                </div>
            </div>
            <div class="form-group">
                <label for="mnt-cidade">Cidade</label>
                <div class="searchable-select">
                    <input type="text" id="mnt-cidade" value="${escapeHtml(m.cidade)}" placeholder="Pesquise a cidade" autocomplete="off">
                    <div class="searchable-select-menu" id="mnt-cidade-menu"></div>
                </div>
            </div>
            <div class="form-group">
                <label for="mnt-tecnico">Técnico</label>
                <input type="text" id="mnt-tecnico" value="${escapeHtml(m.tecnico || state.currentUser?.name || '')}" ${isAdmin ? '' : 'readonly'}>
            </div>

            <div class="form-group full-width mnt-tipo-fields" data-tipo-fields="calibracao_manutencao">
                <label>Tipo de Visita</label>
                <div class="radio-group">
                    ${(lists.mntTipoVisitaCalibracao || []).map((t) => `<label class="radio-pill"><input type="radio" name="mnt-tipo-visita" value="${escapeHtml(t)}" ${m.tipoVisita === t ? 'checked' : ''}><span>${escapeHtml(t)}</span></label>`).join('')}
                </div>
            </div>
            <div class="form-group full-width mnt-tipo-fields" data-tipo-fields="calibracao_manutencao">
                <label>Tipo de Equipamento</label>
                <div class="radio-group">
                    ${(lists.mntTipoEquipamento || []).map((t) => `<label class="radio-pill"><input type="radio" name="mnt-tipo-equipamento" value="${escapeHtml(t)}" ${m.tipoEquipamento === t ? 'checked' : ''}><span>${escapeHtml(t)}</span></label>`).join('')}
                </div>
            </div>

            <div class="form-group full-width mnt-tipo-fields" data-tipo-fields="afericao_vazao,calibracao_manutencao">
                <label>Tabela de Aferição</label>
                <div id="mnt-itens-container">${(itensIniciais.length ? itensIniciais : [{}, {}, {}]).map((i) => itemRowHtml(tipoInicial, i)).join('')}</div>
                <button type="button" class="mini-button" id="mnt-add-item" style="margin-top:0.5rem">+ Adicionar linha</button>
            </div>

            <div class="form-group full-width mnt-tipo-fields" data-tipo-fields="calibracao_manutencao">
                <label>Peças (Diluidor)</label>
                ${(lists.mntPecasDiluidor || []).map((p) => `
                <label style="display:flex;align-items:center;gap:0.6rem;font-size:0.87rem;font-weight:500;cursor:pointer;margin-bottom:0.5rem">
                    <input type="checkbox" class="mnt-peca-check" value="${escapeHtml(p)}" style="width:auto;accent-color:var(--primary)" ${pecasIniciais.includes(p) ? 'checked' : ''}>
                    ${escapeHtml(p)}
                </label>`).join('')}
            </div>

            ${mntField('mnt-vendedor', 'Vendedor', m.vendedor)}
            ${mntField('mnt-equipamento-nome', 'Equipamento', m.equipamentoNome)}

            <div class="form-group full-width mnt-tipo-fields" data-tipo-fields="atendimento_lavanderia">
                <label>Tipo de Máquina</label>
                <div class="radio-group">
                    ${(lists.mntTipoMaquinaLavanderia || []).map((t) => `<label class="radio-pill"><input type="radio" name="mnt-tipo-maquina" value="${escapeHtml(t)}" ${m.tipoMaquina === t ? 'checked' : ''}><span>${escapeHtml(t)}</span></label>`).join('')}
                </div>
            </div>
            <div class="form-group full-width mnt-tipo-fields" data-tipo-fields="atendimento_lavanderia">
                <label>Tipo de Visita</label>
                <div class="radio-group">
                    ${(lists.mntTipoVisitaLavanderia || []).map((t) => `<label class="radio-pill"><input type="radio" name="mnt-tipo-visita-lav" value="${escapeHtml(t)}" ${m.tipoVisita === t ? 'checked' : ''}><span>${escapeHtml(t)}</span></label>`).join('')}
                </div>
            </div>

            ${mntField('mnt-hora-chegada', 'Hora de Chegada', m.horaChegada, { type: 'time' })}
            ${mntField('mnt-hora-saida', 'Hora de Saída', m.horaSaida, { type: 'time' })}
            <div class="form-group mnt-tipo-fields" data-tipo-fields="atendimento_lavanderia">
                <label>Refeição</label>
                <div class="radio-group">
                    <label class="radio-pill"><input type="radio" name="mnt-refeicao" value="Sim" ${m.refeicao === 'Sim' ? 'checked' : ''}><span>Sim</span></label>
                    <label class="radio-pill"><input type="radio" name="mnt-refeicao" value="Não" ${m.refeicao === 'Não' ? 'checked' : ''}><span>Não</span></label>
                </div>
            </div>
            ${mntField('mnt-km-inicial', 'Km Inicial', m.kmInicial, { type: 'number' })}
            ${mntField('mnt-km-final', 'Km Final', m.kmFinal, { type: 'number' })}

            <div class="form-group full-width mnt-tipo-fields" data-tipo-fields="atendimento_lavanderia">
                <label>Checklist</label>
                ${CHECKLIST_GRUPOS.map((g) => checklistGroupFormHtml(g, lists[g.listKey] || [], safeParseJson(m[g.key], []))).join('')}
            </div>

            <div class="form-group full-width mnt-tipo-fields" data-tipo-fields="atendimento_lavanderia">
                <label>Vazões das Bombas</label>
                <div style="overflow-x:auto">
                    <table class="mnt-table mnt-vazoes-table">
                        <thead><tr><th>Bomba</th><th>Produto</th><th>Diluição</th><th>Vazão Aferida</th></tr></thead>
                        <tbody id="mnt-vazoes-container">${Array.from({ length: VAZOES_BOMBAS_QTD }, (_, i) => vazoesRowHtml(i + 1, vazoesIniciais[i] || {})).join('')}</tbody>
                    </table>
                </div>
            </div>

            <div class="form-group full-width mnt-tipo-fields" data-tipo-fields="atendimento_lavanderia">
                <label for="mnt-problemas-maquina">Problemas na Máquina</label>
                <textarea id="mnt-problemas-maquina" rows="3">${escapeHtml(m.problemasMaquina || '')}</textarea>
            </div>
            <div class="form-group full-width mnt-tipo-fields" data-tipo-fields="atendimento_lavanderia">
                <label for="mnt-problemas-estocagem">Problemas na Estocagem</label>
                <textarea id="mnt-problemas-estocagem" rows="3">${escapeHtml(m.problemasEstocagem || '')}</textarea>
            </div>

            <div class="form-group full-width">
                <label for="mnt-observacao">Observação</label>
                <textarea id="mnt-observacao" rows="5">${escapeHtml(m.observacao || '')}</textarea>
            </div>

            <div class="form-group full-width">
                <p class="helper-text" style="margin:0">A assinatura do técnico e do cliente na tela chega no próximo bloco desta funcionalidade — por enquanto o relatório é salvo sem assinatura.</p>
            </div>

            <div class="form-actions full-width">
                <button type="button" class="secondary-button" id="cancel-manutencao">Cancelar</button>
                <button type="submit" id="save-manutencao">Salvar Relatório</button>
            </div>
        </form>
    `;

    syncTipoFieldsVisibility(tipoInicial);

    initializeSearchableInput({
        input: document.getElementById('mnt-cliente'),
        menu: document.getElementById('mnt-cliente-menu'),
        items: clientes.map((c) => c.nome),
        allowFreeText: true
    });
    initializeSearchableInput({
        input: document.getElementById('mnt-cidade'),
        menu: document.getElementById('mnt-cidade-menu'),
        items: cidades
    });

    const itensContainer = document.getElementById('mnt-itens-container');
    bindItemRowRemove(itensContainer);
    document.getElementById('mnt-add-item').addEventListener('click', () => {
        const tipoAtual = document.querySelector('input[name="mnt-tipo-relatorio"]:checked').value;
        itensContainer.insertAdjacentHTML('beforeend', itemRowHtml(tipoAtual));
        bindItemRowRemove(itensContainer);
    });

    document.querySelectorAll('input[name="mnt-tipo-relatorio"]').forEach((radio) => {
        radio.addEventListener('change', () => {
            const tipoAtual = radio.value;
            syncTipoFieldsVisibility(tipoAtual);
            if (tipoAtual !== 'atendimento_lavanderia') {
                // Troca o formato das linhas já preenchidas pro novo tipo —
                // mantém "produto" (comum aos dois), zera o resto pra não
                // salvar valor no campo errado (ex.: "diluição" indo pra
                // "referência diluição").
                itensContainer.innerHTML = itemRowHtml(tipoAtual);
                bindItemRowRemove(itensContainer);
            }
        });
    });

    document.getElementById('back-manutencao-form').addEventListener('click', () => navigateTo(isEdit ? 'manutencao-detail' : 'manutencao', isEdit ? { id: m.id } : {}));
    document.getElementById('cancel-manutencao').addEventListener('click', () => navigateTo(isEdit ? 'manutencao-detail' : 'manutencao', isEdit ? { id: m.id } : {}));

    document.getElementById('manutencao-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        const button = document.getElementById('save-manutencao');
        setSaving(true, button, 'Salvando...');

        const tipoRelatorio = document.querySelector('input[name="mnt-tipo-relatorio"]:checked').value;
        const clienteVal = document.getElementById('mnt-cliente').value.trim();
        if (!clienteVal) {
            showToast('Informe o cliente.', true);
            setSaving(false, button);
            return;
        }
        const cidadeVal = document.getElementById('mnt-cidade').value.trim();
        const tecnicoVal = document.getElementById('mnt-tecnico').value.trim();
        const isLavanderia = tipoRelatorio === 'atendimento_lavanderia';
        const tipoVisitaVal = isLavanderia
            ? (document.querySelector('input[name="mnt-tipo-visita-lav"]:checked')?.value || '')
            : (document.querySelector('input[name="mnt-tipo-visita"]:checked')?.value || '');
        const tipoEquipamentoVal = document.querySelector('input[name="mnt-tipo-equipamento"]:checked')?.value || '';
        const observacaoVal = document.getElementById('mnt-observacao').value.trim();

        const payload = {
            cliente: clienteVal, cidade: cidadeVal, tecnico: tecnicoVal,
            tipoRelatorio, tipoVisita: tipoVisitaVal, tipoEquipamento: tipoEquipamentoVal,
            observacao: observacaoVal,
            user: state.currentUser
        };

        if (isLavanderia) {
            payload.vendedor = document.getElementById('mnt-vendedor').value.trim();
            payload.equipamentoNome = document.getElementById('mnt-equipamento-nome').value.trim();
            payload.tipoMaquina = document.querySelector('input[name="mnt-tipo-maquina"]:checked')?.value || '';
            payload.horaChegada = document.getElementById('mnt-hora-chegada').value;
            payload.horaSaida = document.getElementById('mnt-hora-saida').value;
            payload.refeicao = document.querySelector('input[name="mnt-refeicao"]:checked')?.value || '';
            payload.kmInicial = document.getElementById('mnt-km-inicial').value.trim();
            payload.kmFinal = document.getElementById('mnt-km-final').value.trim();
            CHECKLIST_GRUPOS.forEach((g) => { payload[g.key] = collectChecklist(g.key); });
            payload.vazoesBombas = collectVazoes();
            payload.problemasMaquina = document.getElementById('mnt-problemas-maquina').value.trim();
            payload.problemasEstocagem = document.getElementById('mnt-problemas-estocagem').value.trim();
        } else {
            payload.itensTabela = JSON.stringify(collectItens(tipoRelatorio, itensContainer));
            payload.pecasDiluidor = JSON.stringify(Array.from(document.querySelectorAll('.mnt-peca-check:checked')).map((el) => el.value));
        }

        if (isEdit) {
            const idx = state.manutencoes.findIndex((item) => String(item.id) === String(m.id));
            const result = await attemptOrQueue('updateManutencao', { id: m.id, ...payload }, { entity: 'manutencao', tempId: m.id });
            if (result && result.status === 'success') {
                if (idx >= 0) { state.manutencoes[idx] = normalizeManutencao(result.manutencao); saveCache('manutencoes', state.manutencoes); }
                showToast('Relatório atualizado.');
                navigateTo('manutencao-detail', { id: m.id });
            } else if (result && result.status === 'queued') {
                showToast('Sem conexão — a atualização será enviada quando a conexão voltar.');
                navigateTo('manutencao-detail', { id: m.id });
            } else {
                showToast((result && result.message) || 'Erro ao salvar. Tente novamente.', true);
                setSaving(false, button);
            }
        } else {
            const tempId = 'temp_' + Date.now();
            const result = await attemptOrQueue('createManutencao', payload, { entity: 'manutencao', tempId });
            if (result && result.status === 'success') {
                showToast('Relatório criado com sucesso.');
                saveCache('manutencoes', null);
                state.manutencoes = [];
                navigateTo('manutencao');
            } else if (result && result.status === 'queued') {
                showToast('Sem conexão — o relatório foi salvo no aparelho e será enviado quando a conexão voltar.');
                navigateTo('manutencao');
            } else {
                showToast((result && result.message) || 'Erro ao criar relatório.', true);
                setSaving(false, button);
            }
        }
    });
}

export async function renderManutencaoCreatePage() {
    await renderManutencaoFormPage(null);
}

export async function getManutencoes() {
    try {
        const result = await callAPI('getManutencoes', { user: state.currentUser });
        if (result.status === 'success') { saveCache('manutencoes', result.manutencoes || []); }
        return result;
    } catch (error) {
        return { status: 'error', message: error.message };
    }
}

export async function getManutencaoById(id) {
    const existing = state.manutencoes.find((item) => String(item.Id || item.id) === String(id));
    if (existing) return { status: 'success', manutencao: existing };
    try {
        return await callAPI('getManutencaoById', { id, user: state.currentUser });
    } catch (error) {
        return { status: 'error', message: error.message };
    }
}
