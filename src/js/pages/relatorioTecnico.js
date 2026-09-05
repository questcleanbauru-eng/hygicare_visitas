import { state, navigateTo } from '../app.js';
import { callAPI, saveCache, loadCache, ensureFormData, attemptOrQueue } from '../api.js';
import { escapeHtml, isAdminOrGerenteUser, titleCase } from '../utils/format.js';
import {
    debounce, initializeSearchableInput, showToast, skeletonList, skeletonDetail,
    addScrollTop, setSaving, openExternal
} from '../utils/dom.js';
import { renderBreadcrumb, ensureStyles } from '../utils/ui.js';

// ── Estrutura fixa do modelo (Diversey / Professional) ───────────────────
const SECOES = [
    {
        titulo: 'Produtos Químicos',
        perguntas: [
            'Está utilizando todo o mix de produtos químicos aprovados?',
            'As dosagens de cada produto são as adequadas?',
            'Estão usando da forma adequada?'
        ]
    },
    {
        titulo: 'Equipamentos',
        perguntas: [
            'Funcionam corretamente?',
            'Encontram-se limpos?',
            'Existe algum vazamento?'
        ]
    },
    {
        titulo: 'Aparência da unidade',
        perguntas: [
            'Os Wallcharts (etiquetas, quadros de aviso etc.), fichas de segurança e de segurança de material (MSDS) apropriados estão colocados em locais visíveis?'
        ]
    },
    {
        titulo: 'Resultados dos Processos',
        perguntas: [
            'A limpeza e desinfecção está sendo realizada de maneira correta?'
        ]
    }
];
const SIM_NAO_NA = ['Sim', 'Não', 'N/A'];
const TIPO_VISITA_OPCOES = ['Pós-venda', 'Implantação', 'Treinamento', 'Auditoria', 'Outros'];
const AVALIACAO_OPCOES = ['Totalmente Satisfeito', 'Satisfeito', 'Neutro', 'Insatisfeito', 'Totalmente Insatisfeito'];

const qKey = (si, qi) => `s${si}_q${qi}`;

function ensureRtStyles() {
    ensureStyles('relatorio-tecnico');
    ensureStyles('proposals');
    ensureStyles('visits');
}

function safeJson(value, fallback) {
    // Já pode vir desserializado (ex.: reeditar um relatório já normalizado).
    if (value && typeof value === 'object') return value;
    try {
        const v = JSON.parse(value);
        return (v && typeof v === 'object') ? v : fallback;
    } catch (e) { return fallback; }
}

function normalize(item) {
    const m = item || {};
    const pick = (a, b) => m[a] ?? m[b] ?? '';
    return {
        id: String(m.id || m.Id || ''),
        data: pick('data', 'Data'),
        tecnico: pick('tecnico', 'Tecnico'),
        gerencia: pick('gerencia', 'Gerencia'),
        relatorioMes: pick('relatorioMes', 'RelatorioMes'),
        dataVisita: pick('dataVisita', 'DataVisita'),
        codigoShipTo: pick('codigoShipTo', 'CodigoShipTo'),
        cliente: pick('cliente', 'Cliente'),
        grupo: pick('grupo', 'Grupo'),
        marketSector: pick('marketSector', 'MarketSector'),
        endereco: pick('endereco', 'Endereco'),
        bairro: pick('bairro', 'Bairro'),
        cidade: pick('cidade', 'Cidade'),
        estado: pick('estado', 'Estado'),
        tipoVisita: pick('tipoVisita', 'TipoVisita'),
        area: pick('area', 'Area'),
        respostas: safeJson(pick('respostas', 'Respostas') || '{}', {}),
        comentarios: pick('comentarios', 'Comentarios'),
        comentariosTabela: (() => { const v = safeJson(pick('comentariosTabela', 'ComentariosTabela') || '[]', []); return Array.isArray(v) ? v : []; })(),
        estoqueVerificado: pick('estoqueVerificado', 'EstoqueVerificado'),
        clienteAvaliador: pick('clienteAvaliador', 'ClienteAvaliador'),
        clienteCargo: pick('clienteCargo', 'ClienteCargo'),
        avaliacaoAtendimento: pick('avaliacaoAtendimento', 'AvaliacaoAtendimento'),
        clienteObservacoes: pick('clienteObservacoes', 'ClienteObservacoes'),
        clienteEmail: pick('clienteEmail', 'ClienteEmail'),
        departamento: pick('departamento', 'Departamento'),
        gestor: pick('gestor', 'Gestor'),
        contatoGestor: pick('contatoGestor', 'ContatoGestor'),
        inicioAtendimento: pick('inicioAtendimento', 'InicioAtendimento'),
        fimAtendimento: pick('fimAtendimento', 'FimAtendimento'),
        _pending: !!m._pending
    };
}

// ── Lista ───────────────────────────────────────────────────────────────
export async function renderRelatorioTecnicoPage() {
    ensureRtStyles();
    const mainContent = document.getElementById('main-content');

    const cached = loadCache('relatoriosTecnicos');
    if (cached) {
        state.relatoriosTecnicos = cached;
        fillList(mainContent, cached);
    } else {
        mainContent.innerHTML = skeletonList();
    }

    try {
        const r = await callAPI('getRelatoriosTecnicos', { user: state.currentUser });
        if (r.status === 'success') {
            state.relatoriosTecnicos = r.relatorios || [];
            saveCache('relatoriosTecnicos', state.relatoriosTecnicos);
            const el = document.getElementById('main-content');
            if (el) fillList(el, state.relatoriosTecnicos);
        } else if (!cached) {
            mainContent.innerHTML = `<p class="error-message">${escapeHtml(r.message || 'Não foi possível carregar.')}</p>`;
        }
    } catch (e) {
        if (!cached) mainContent.innerHTML = `<p class="error-message">Não foi possível carregar os relatórios.</p>`;
    }
}

function fillList(mainContent, list) {
    const normalized = (list || []).map(normalize);
    const headerHtml = `
        <div class="page-header">
            <div><h2>Atendimento Técnico</h2><p class="page-subtitle">${normalized.length} relatório(s)</p></div>
            <div class="header-actions-group">
                <button type="button" class="mini-button" id="rt-goto-manutencao">🔧 Manutenção</button>
                <button type="button" class="mini-button" id="rt-modelos">📋 Modelos</button>
                <button type="button" class="btn-add" id="rt-new">+ Novo Relatório</button>
            </div>
        </div>`;

    if (!normalized.length) {
        mainContent.innerHTML = `${headerHtml}
            <div class="empty-state">
                <span class="empty-state-icon">📋</span>
                <p>Nenhum relatório de atendimento técnico ainda.</p>
                <button type="button" class="btn-add" id="rt-new2">+ Novo Relatório</button>
            </div>`;
        document.getElementById('rt-new')?.addEventListener('click', () => navigateTo('relatorio-tecnico-new'));
        document.getElementById('rt-new2')?.addEventListener('click', () => navigateTo('relatorio-tecnico-new'));
        document.getElementById('rt-goto-manutencao')?.addEventListener('click', () => navigateTo('manutencao'));
        document.getElementById('rt-modelos')?.addEventListener('click', openRelatorioTecnicoModelosModal);
        return;
    }

    mainContent.innerHTML = `${headerHtml}
        <div class="search-bar-wrapper">
            <div class="search-bar-input-group">
                <span class="search-bar-icon">🔍</span>
                <input type="text" id="rt-search" placeholder="Buscar cliente, cidade ou técnico..." class="form-input">
            </div>
        </div>
        <div id="rt-list"></div>`;

    const listEl = document.getElementById('rt-list');
    const render = () => {
        const term = (document.getElementById('rt-search').value || '').trim().toLowerCase();
        const filtered = normalized.filter((m) => !term
            || [m.cliente, m.cidade, m.tecnico, m.relatorioMes].some((v) => String(v).toLowerCase().includes(term)));
        if (!filtered.length) { listEl.innerHTML = `<p class="empty-state" style="padding:1.5rem">Nada encontrado.</p>`; return; }
        listEl.innerHTML = filtered.map((m) => `
            <button type="button" class="proposal-card" data-id="${escapeHtml(m.id)}">
                <div class="visit-card-header">
                    <strong>${escapeHtml(m.cliente || 'Cliente não informado')}</strong>
                    <div style="display:flex;align-items:center;gap:0.3rem">
                        ${m._pending ? '<span class="pending-badge">⏳ Pendente</span>' : ''}
                        <span class="card-quick-edit-btn" role="button" tabindex="0" title="Excluir relatório" aria-label="Excluir relatório" data-rt-delete="${escapeHtml(m.id)}">🗑️</span>
                    </div>
                </div>
                <div class="proposal-meta">
                    <span>${escapeHtml([m.cidade, m.estado].filter(Boolean).join('/') || '-')}</span>
                    <span>${escapeHtml(m.relatorioMes || m.data || '')}</span>
                    <span>${escapeHtml(m.tipoVisita || '')}</span>
                    ${isAdminOrGerenteUser() && m.tecnico ? `<span>👤 ${escapeHtml(titleCase(m.tecnico))}</span>` : ''}
                </div>
            </button>`).join('');
        listEl.querySelectorAll('.proposal-card').forEach((btn) => {
            btn.addEventListener('click', () => navigateTo('relatorio-tecnico-detail', { id: btn.dataset.id }));
        });
        listEl.querySelectorAll('[data-rt-delete]').forEach((el) => {
            el.addEventListener('click', async (e) => {
                e.stopPropagation();
                const id = el.dataset.rtDelete;
                const item = normalized.find((x) => String(x.id) === id);
                if (!confirm(`Apagar o relatório de "${item?.cliente || 'cliente'}"? Não dá pra desfazer.`)) return;
                const r = await callAPI('deleteRelatorioTecnico', { id, user: state.currentUser }).catch(() => null);
                if (r && r.status === 'success') {
                    state.relatoriosTecnicos = (state.relatoriosTecnicos || []).filter((x) => String(x.id || x.Id) !== id);
                    saveCache('relatoriosTecnicos', state.relatoriosTecnicos);
                    showToast('Relatório apagado.');
                    fillList(mainContent, state.relatoriosTecnicos);
                } else {
                    showToast((r && r.message) || 'Não foi possível apagar.', true);
                }
            });
        });
    };
    render();
    document.getElementById('rt-search').addEventListener('input', debounce(render, 200));
    document.getElementById('rt-new').addEventListener('click', () => navigateTo('relatorio-tecnico-new'));
    document.getElementById('rt-goto-manutencao').addEventListener('click', () => navigateTo('manutencao'));
    document.getElementById('rt-modelos').addEventListener('click', openRelatorioTecnicoModelosModal);
    addScrollTop();
}

// ── Detalhe + PDF + compartilhar ────────────────────────────────────────
export async function getRelatorioTecnicoById(id) {
    const local = (state.relatoriosTecnicos || []).find((m) => String(m.id || m.Id) === String(id));
    if (local && !local._pending) return { status: 'success', relatorio: local };
    if (local && local._pending) return { status: 'success', relatorio: local };
    return await callAPI('getRelatorioTecnicoById', { id, user: state.currentUser });
}

function respRow(label, value) {
    return `<div class="rt-row"><div class="rt-row-label">${escapeHtml(label)}</div><div class="rt-row-value">${escapeHtml(value || '—')}</div></div>`;
}

function reportHtml(m, logoEmpresa) {
    const secoesHtml = SECOES.map((sec, si) => `
        <div class="rt-band">${escapeHtml(sec.titulo)}</div>
        ${sec.perguntas.map((p, qi) => respRow(p, m.respostas[qKey(si, qi)])).join('')}
    `).join('');

    const tabela = m.comentariosTabela.length ? `
        <table class="rt-table">
            <thead><tr><th>Produto</th><th>Diluição referência</th><th>Ideal</th><th>Realizada</th></tr></thead>
            <tbody>${m.comentariosTabela.map((r) => `<tr>
                <td>${escapeHtml(r.produto || '')}</td>
                <td>${escapeHtml(r.diluicao || '')}</td>
                <td>${escapeHtml(r.ideal || '')}</td>
                <td>${escapeHtml(r.realizada || '')}</td>
            </tr>`).join('')}</tbody>
        </table>` : '';

    return `
    <div class="rt-report">
        <div class="rt-header">
            ${logoEmpresa ? `<img class="rt-logo" src="${escapeHtml(logoEmpresa)}" alt="Logo da empresa">` : ''}
            <div class="rt-title">RELATÓRIO DE ATENDIMENTO TÉCNICO — PROFESSIONAL</div>
        </div>

        ${respRow('Relatório', m.relatorioMes)}
        ${respRow('Data da Visita', m.dataVisita)}

        <div class="rt-band">DADOS DO CLIENTE</div>
        ${respRow('Código (Ship To)', m.codigoShipTo)}
        ${respRow('Cliente', m.cliente)}
        ${respRow('Grupo', m.grupo)}
        ${respRow('Market Sector', m.marketSector)}
        ${respRow('Endereço', m.endereco)}
        ${respRow('Bairro', m.bairro)}
        ${respRow('Cidade', m.cidade)}
        ${respRow('Estado', m.estado)}

        ${respRow('Tipo de Visita', m.tipoVisita)}
        ${respRow('Área', m.area)}

        ${secoesHtml}

        <div class="rt-band">COMENTÁRIOS</div>
        <div class="rt-freetext">${escapeHtml(m.comentarios || '—').replace(/\n/g, '<br>')}</div>
        ${tabela}

        <div class="rt-band">ESTOQUE</div>
        ${respRow('O estoque de produtos foi verificado?', m.estoqueVerificado)}

        <div class="rt-band">AVALIAÇÃO DO CLIENTE</div>
        ${respRow('Nome e Sobrenome do Cliente', m.clienteAvaliador)}
        ${respRow('Cargo do Cliente', m.clienteCargo)}
        ${respRow('Avaliação do Atendimento', m.avaliacaoAtendimento)}
        ${respRow('Observações do Cliente', m.clienteObservacoes)}
        ${respRow('E-mail do Cliente', m.clienteEmail)}
        <div class="rt-row"><div class="rt-row-label">Assinatura do Cliente</div><div class="rt-row-value rt-sign-line">&nbsp;</div></div>

        <div class="rt-band">ATENDIMENTO REALIZADO POR</div>
        ${respRow('Atendido por', m.tecnico ? titleCase(m.tecnico) : '')}
        ${respRow('Departamento', m.departamento)}
        ${respRow('Gestor', m.gestor)}
        ${respRow('Contato do Gestor', m.contatoGestor)}
        ${respRow('Início do Atendimento', m.inicioAtendimento)}
        ${respRow('Fim do Atendimento', m.fimAtendimento)}
    </div>`;
}

export async function renderRelatorioTecnicoDetailPage(id) {
    ensureRtStyles();
    const mainContent = document.getElementById('main-content');
    mainContent.innerHTML = skeletonDetail();

    const result = await getRelatorioTecnicoById(id).catch(() => null);
    if (!result || result.status !== 'success') {
        mainContent.innerHTML = `<p class="error-message">Relatório não encontrado.</p>`;
        return;
    }
    const m = normalize(result.relatorio);
    state.currentRelatorioTecnico = m;
    const fd = await ensureFormData().catch(() => null);
    const logoEmpresa = (fd && fd.data && fd.data.logoEmpresa) || '';

    mainContent.innerHTML = `
        ${renderBreadcrumb([{ label: 'Manutenção', page: 'manutencao' }, { label: 'Atendimento Técnico', page: 'relatorio-tecnico' }, { label: m.cliente || 'Relatório' }])}
        <div class="page-header compact-header no-print">
            <div><h2>${escapeHtml(m.cliente || 'Relatório técnico')}</h2>
                <p class="page-subtitle">${escapeHtml([m.cidade, m.relatorioMes].filter(Boolean).join(' · '))}</p></div>
            <div class="header-actions-group">
                <button type="button" class="mini-button" id="rt-edit">✏️ Editar</button>
                <button type="button" class="mini-button" id="rt-print">📄 PDF</button>
                <button type="button" class="mini-button" id="rt-share">📤 Compartilhar</button>
                <button type="button" class="mini-button danger" id="rt-delete">🗑️</button>
            </div>
        </div>
        ${reportHtml(m, logoEmpresa)}
    `;

    document.getElementById('rt-edit').addEventListener('click', () => navigateTo('relatorio-tecnico-edit', { relatorio: m }));
    document.getElementById('rt-print').addEventListener('click', () => {
        const sanitize = (s) => String(s || '').replace(/[\\/:*?"<>|]/g, '-').trim();
        const original = document.title;
        document.title = `Relatorio Atendimento Tecnico - ${sanitize(m.cliente)} - ${sanitize(m.relatorioMes || m.data)}`;
        const restore = () => { document.title = original; window.removeEventListener('afterprint', restore); };
        window.addEventListener('afterprint', restore);
        window.print();
        setTimeout(restore, 3000);
    });
    document.getElementById('rt-share').addEventListener('click', () => shareRelatorio(m));
    document.getElementById('rt-delete').addEventListener('click', async (ev) => {
        if (!confirm(`Apagar o relatório de "${m.cliente || 'cliente'}"? Não dá pra desfazer.`)) return;
        setSaving(true, ev.currentTarget, 'Apagando...');
        const r = await callAPI('deleteRelatorioTecnico', { id: m.id, user: state.currentUser }).catch(() => null);
        if (r && r.status === 'success') {
            state.relatoriosTecnicos = (state.relatoriosTecnicos || []).filter((x) => String(x.id || x.Id) !== String(m.id));
            saveCache('relatoriosTecnicos', state.relatoriosTecnicos);
            showToast('Relatório apagado.');
            navigateTo('relatorio-tecnico');
        } else {
            showToast((r && r.message) || 'Não foi possível apagar.', true);
            setSaving(false, ev.currentTarget);
        }
    });
    addScrollTop();
}

async function shareRelatorio(m) {
    const linhas = [
        `*Relatório de Atendimento Técnico*`,
        `Cliente: ${m.cliente || '-'}`,
        `Cidade: ${[m.cidade, m.estado].filter(Boolean).join('/') || '-'}`,
        `Relatório: ${m.relatorioMes || '-'}  |  Data da visita: ${m.dataVisita || '-'}`,
        `Tipo de visita: ${m.tipoVisita || '-'}`,
        `Técnico: ${m.tecnico ? titleCase(m.tecnico) : '-'}`,
        m.comentarios ? `\nComentários:\n${m.comentarios}` : ''
    ].filter(Boolean).join('\n');
    // Compartilhamento nativo (abre o "compartilhar com..." do aparelho:
    // e-mail, WhatsApp etc.). O PDF em si o usuário anexa a partir do
    // "Salvar como PDF" (botão PDF ao lado).
    if (navigator.share) {
        try {
            await navigator.share({ title: `Relatório — ${m.cliente || ''}`, text: linhas });
            return;
        } catch (e) { if (e && e.name === 'AbortError') return; }
    }
    openExternal(`https://wa.me/?text=${encodeURIComponent(linhas)}`);
}

// ── Formulário (novo / editar) ─────────────────────────────────────────
export function renderRelatorioTecnicoCreatePage(options) {
    return renderRelatorioTecnicoFormPage(null, options);
}

function chips(name, options, selected) {
    return `<div class="rt-chips" data-chips="${name}">
        ${options.map((o) => `<button type="button" class="radio-pill${o === selected ? ' is-checked' : ''}" data-val="${escapeHtml(o)}">${escapeHtml(o)}</button>`).join('')}
        <input type="hidden" name="${name}" value="${escapeHtml(selected || '')}">
    </div>`;
}

function field(label, id, value, opts = {}) {
    const type = opts.type || 'text';
    if (type === 'textarea') {
        return `<div class="form-group"><label for="${id}">${escapeHtml(label)}</label>
            <textarea id="${id}" rows="${opts.rows || 3}" placeholder="${escapeHtml(opts.placeholder || '')}">${escapeHtml(value || '')}</textarea></div>`;
    }
    return `<div class="form-group"><label for="${id}">${escapeHtml(label)}</label>
        <input type="${type}" id="${id}" value="${escapeHtml(value || '')}" placeholder="${escapeHtml(opts.placeholder || '')}" ${opts.inputmode ? `inputmode="${opts.inputmode}"` : ''}></div>`;
}

function tabelaRowHtml(r = {}) {
    return `<div class="rt-tab-row" data-tab-row>
        <input type="text" class="rt-tab-produto" placeholder="Produto" value="${escapeHtml(r.produto || '')}">
        <input type="text" class="rt-tab-diluicao" placeholder="Diluição ref." value="${escapeHtml(r.diluicao || '')}">
        <input type="text" class="rt-tab-ideal" placeholder="Ideal" value="${escapeHtml(r.ideal || '')}">
        <input type="text" class="rt-tab-realizada" placeholder="Realizada" value="${escapeHtml(r.realizada || '')}">
        <button type="button" class="rt-tab-del" aria-label="Remover linha">✕</button>
    </div>`;
}

export async function renderRelatorioTecnicoFormPage(record, options) {
    ensureRtStyles();
    const mainContent = document.getElementById('main-content');
    mainContent.innerHTML = skeletonDetail();

    const isEdit = !!record;
    const m = normalize(record || {});
    const fd = await ensureFormData();
    const clientes = (fd && fd.data && fd.data.clientes) || [];

    if (!isEdit && options && options.prefillModelo) {
        const d = safeJson(options.prefillModelo, {});
        Object.assign(m, d);
        m.comentariosTabela = Array.isArray(d.comentariosTabela) ? d.comentariosTabela : m.comentariosTabela;
    }
    if (!isEdit && !m.relatorioMes) {
        m.relatorioMes = new Date().toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' }).toUpperCase();
    }

    const breadcrumbHtml = renderBreadcrumb([
        { label: 'Manutenção', page: 'manutencao' },
        { label: 'Atendimento Técnico', page: 'relatorio-tecnico' },
        { label: isEdit ? 'Editar' : 'Novo' }
    ]);

    const secoesForm = SECOES.map((sec, si) => `
        <div class="rt-section-title">${escapeHtml(sec.titulo)}</div>
        ${sec.perguntas.map((p, qi) => `
            <div class="form-group">
                <label>${escapeHtml(p)}</label>
                ${chips(qKey(si, qi), SIM_NAO_NA, m.respostas[qKey(si, qi)] || '')}
            </div>`).join('')}
    `).join('');

    mainContent.innerHTML = `
        ${breadcrumbHtml}
        <div class="page-header compact-header">
            <div><h2>${isEdit ? 'Editar' : 'Novo'} relatório técnico</h2></div>
        </div>
        <form id="rt-form" class="form-layout form-layout-stack">
            ${field('Relatório (mês)', 'rt-relatorioMes', m.relatorioMes, { placeholder: 'AGOSTO 2026' })}
            ${field('Data da Visita', 'rt-dataVisita', m.dataVisita, { placeholder: 'ex.: 20' })}

            <div class="rt-section-title">Dados do cliente</div>
            ${field('Código (Ship To)', 'rt-codigoShipTo', m.codigoShipTo)}
            <div class="form-group">
                <label for="rt-cliente">Cliente</label>
                <div class="searchable-select">
                    <input type="text" id="rt-cliente" value="${escapeHtml(m.cliente)}" placeholder="Nome do cliente" autocomplete="off">
                    <div class="searchable-select-menu" id="rt-cliente-menu"></div>
                </div>
            </div>
            ${field('Grupo', 'rt-grupo', m.grupo)}
            ${field('Market Sector', 'rt-marketSector', m.marketSector)}
            ${field('Endereço', 'rt-endereco', m.endereco)}
            ${field('Bairro', 'rt-bairro', m.bairro)}
            ${field('Cidade', 'rt-cidade', m.cidade)}
            ${field('Estado', 'rt-estado', m.estado, { placeholder: 'SP' })}

            <div class="form-group">
                <label>Tipo de Visita</label>
                ${chips('tipoVisita', TIPO_VISITA_OPCOES, m.tipoVisita || '')}
            </div>
            ${field('Área (setor)', 'rt-area', m.area, { placeholder: 'ex.: DMLs' })}

            ${secoesForm}

            <div class="rt-section-title">Comentários</div>
            ${field('Comentários', 'rt-comentarios', m.comentarios, { type: 'textarea', rows: 4, placeholder: 'Observações gerais da visita' })}
            <div class="form-group">
                <label>Produtos aferidos (adicione ou remova linhas)</label>
                <div id="rt-tabela">${(m.comentariosTabela.length ? m.comentariosTabela : [{}]).map(tabelaRowHtml).join('')}</div>
                <button type="button" class="mini-button" id="rt-tab-add">+ Adicionar linha</button>
            </div>

            <div class="rt-section-title">Estoque</div>
            <div class="form-group">
                <label>O estoque de produtos foi verificado?</label>
                ${chips('estoqueVerificado', SIM_NAO_NA, m.estoqueVerificado || '')}
            </div>

            <div class="rt-section-title">Avaliação do cliente</div>
            ${field('Nome e sobrenome do cliente', 'rt-clienteAvaliador', m.clienteAvaliador)}
            ${field('Cargo do cliente', 'rt-clienteCargo', m.clienteCargo)}
            <div class="form-group">
                <label>Avaliação do atendimento</label>
                ${chips('avaliacaoAtendimento', AVALIACAO_OPCOES, m.avaliacaoAtendimento || '')}
            </div>
            ${field('Observações do cliente', 'rt-clienteObservacoes', m.clienteObservacoes, { type: 'textarea', rows: 2 })}
            ${field('E-mail do cliente', 'rt-clienteEmail', m.clienteEmail, { type: 'email', inputmode: 'email' })}

            <div class="rt-section-title">Atendimento realizado por</div>
            ${field('Departamento', 'rt-departamento', m.departamento || 'SETOR TÉCNICO E COMERCIAL')}
            ${field('Gestor', 'rt-gestor', m.gestor)}
            ${field('Contato do gestor', 'rt-contatoGestor', m.contatoGestor, { type: 'email', inputmode: 'email' })}
            ${field('Início do atendimento', 'rt-inicioAtendimento', m.inicioAtendimento, { placeholder: 'dd/mm/aaaa hh:mm' })}
            ${field('Fim do atendimento', 'rt-fimAtendimento', m.fimAtendimento, { placeholder: 'dd/mm/aaaa hh:mm' })}

            <div class="form-actions full-width">
                <button type="button" class="secondary-button" id="rt-cancel">Cancelar</button>
                <button type="button" class="secondary-button" id="rt-save-modelo">💾 Salvar como modelo</button>
                <button type="submit" id="rt-submit">${isEdit ? 'Salvar' : 'Criar relatório'}</button>
            </div>
        </form>
    `;

    // chips
    mainContent.querySelectorAll('[data-chips]').forEach((wrap) => {
        const hidden = wrap.querySelector('input[type="hidden"]');
        wrap.querySelectorAll('.radio-pill').forEach((btn) => {
            btn.addEventListener('click', () => {
                const already = btn.classList.contains('is-checked');
                wrap.querySelectorAll('.radio-pill').forEach((b) => b.classList.remove('is-checked'));
                if (!already) { btn.classList.add('is-checked'); hidden.value = btn.dataset.val; }
                else { hidden.value = ''; }
            });
        });
    });

    // cliente picker
    initializeSearchableInput({
        input: document.getElementById('rt-cliente'),
        menu: document.getElementById('rt-cliente-menu'),
        items: clientes.map((c) => c['Nome do Cliente'] || c.nome).filter(Boolean),
        onSelect: (value) => {
            const c = clientes.find((x) => (x['Nome do Cliente'] || x.nome) === value);
            if (!c) return;
            if (c.Cidade && !document.getElementById('rt-cidade').value) document.getElementById('rt-cidade').value = c.Cidade;
        }
    });

    // tabela produtos aferidos
    const tabela = document.getElementById('rt-tabela');
    document.getElementById('rt-tab-add').addEventListener('click', () => {
        tabela.insertAdjacentHTML('beforeend', tabelaRowHtml());
    });
    tabela.addEventListener('click', (e) => {
        if (e.target.classList.contains('rt-tab-del')) {
            e.target.closest('[data-tab-row]').remove();
            if (!tabela.querySelector('[data-tab-row]')) tabela.insertAdjacentHTML('beforeend', tabelaRowHtml());
        }
    });

    const collect = () => {
        const g = (id) => (document.getElementById(id)?.value || '').trim();
        const respostas = {};
        SECOES.forEach((sec, si) => sec.perguntas.forEach((_, qi) => {
            const k = qKey(si, qi);
            const v = mainContent.querySelector(`input[name="${k}"]`)?.value || '';
            if (v) respostas[k] = v;
        }));
        const comentariosTabela = Array.from(tabela.querySelectorAll('[data-tab-row]')).map((row) => ({
            produto: row.querySelector('.rt-tab-produto').value.trim(),
            diluicao: row.querySelector('.rt-tab-diluicao').value.trim(),
            ideal: row.querySelector('.rt-tab-ideal').value.trim(),
            realizada: row.querySelector('.rt-tab-realizada').value.trim()
        })).filter((r) => r.produto || r.diluicao || r.ideal || r.realizada);
        return {
            relatorioMes: g('rt-relatorioMes'), dataVisita: g('rt-dataVisita'),
            codigoShipTo: g('rt-codigoShipTo'), cliente: g('rt-cliente'), grupo: g('rt-grupo'),
            marketSector: g('rt-marketSector'), endereco: g('rt-endereco'), bairro: g('rt-bairro'),
            cidade: g('rt-cidade'), estado: g('rt-estado'),
            tipoVisita: mainContent.querySelector('input[name="tipoVisita"]').value,
            area: g('rt-area'),
            respostas: JSON.stringify(respostas),
            comentarios: g('rt-comentarios'),
            comentariosTabela: JSON.stringify(comentariosTabela),
            estoqueVerificado: mainContent.querySelector('input[name="estoqueVerificado"]').value,
            clienteAvaliador: g('rt-clienteAvaliador'), clienteCargo: g('rt-clienteCargo'),
            avaliacaoAtendimento: mainContent.querySelector('input[name="avaliacaoAtendimento"]').value,
            clienteObservacoes: g('rt-clienteObservacoes'), clienteEmail: g('rt-clienteEmail'),
            departamento: g('rt-departamento'), gestor: g('rt-gestor'), contatoGestor: g('rt-contatoGestor'),
            inicioAtendimento: g('rt-inicioAtendimento'), fimAtendimento: g('rt-fimAtendimento')
        };
    };

    document.getElementById('rt-cancel').addEventListener('click', () => {
        navigateTo(isEdit ? 'relatorio-tecnico-detail' : 'relatorio-tecnico', isEdit ? { id: m.id } : undefined);
    });

    document.getElementById('rt-save-modelo').addEventListener('click', () => openSaveModeloModal(collect()));

    document.getElementById('rt-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        const payload = collect();
        if (!payload.cliente) { showToast('Informe o cliente.', true); return; }
        const btn = document.getElementById('rt-submit');
        setSaving(true, btn, isEdit ? 'Salvando...' : 'Criando...');

        if (isEdit) {
            const idx = (state.relatoriosTecnicos || []).findIndex((x) => String(x.id || x.Id) === String(m.id));
            const r = await attemptOrQueue('updateRelatorioTecnico', { id: m.id, ...payload }, { entity: 'relatorioTecnico', tempId: m.id });
            if (r && (r.status === 'success' || r.status === 'queued')) {
                if (r.relatorio && idx >= 0) { state.relatoriosTecnicos[idx] = r.relatorio; saveCache('relatoriosTecnicos', state.relatoriosTecnicos); }
                showToast(r.status === 'queued' ? 'Sem conexão — salvo e será enviado depois.' : 'Relatório salvo.');
                navigateTo('relatorio-tecnico-detail', { id: m.id });
            } else {
                showToast((r && r.message) || 'Não foi possível salvar.', true);
                setSaving(false, btn);
            }
            return;
        }

        const tempId = 'temp_' + Date.now();
        const r = await attemptOrQueue('createRelatorioTecnico', payload, { entity: 'relatorioTecnico', tempId });
        if (r && (r.status === 'success' || r.status === 'queued')) {
            state.relatoriosTecnicos = [];
            saveCache('relatoriosTecnicos', null);
            showToast(r.status === 'queued' ? 'Sem conexão — salvo e será enviado depois.' : 'Relatório criado.');
            navigateTo('relatorio-tecnico');
        } else {
            showToast((r && r.message) || 'Não foi possível criar.', true);
            setSaving(false, btn);
        }
    });
}

// ── Modelos ────────────────────────────────────────────────────────────
function modeloDadosFromPayload(p) {
    // Só os campos que se repetem por cliente/unidade — nada de datas,
    // comentários da visita ou avaliação do cliente.
    return JSON.stringify({
        codigoShipTo: p.codigoShipTo, grupo: p.grupo, marketSector: p.marketSector,
        endereco: p.endereco, bairro: p.bairro, cidade: p.cidade, estado: p.estado,
        tipoVisita: p.tipoVisita, area: p.area,
        comentariosTabela: JSON.parse(p.comentariosTabela || '[]'),
        departamento: p.departamento, gestor: p.gestor, contatoGestor: p.contatoGestor,
        clienteEmail: p.clienteEmail
    });
}

function openSaveModeloModal(payload) {
    if (!payload.cliente) { showToast('Informe o cliente antes de salvar o modelo.', true); return; }
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
        <div class="modal-card">
            <div style="font-size:2rem;margin-bottom:0.5rem">💾</div>
            <h3>Salvar como modelo</h3>
            <p>Guarda os dados do cliente, área, produtos aferidos e dados do atendimento pra reusar nas próximas visitas.</p>
            <div class="form-group full-width" style="text-align:left">
                <label for="rt-modelo-nome">Nome do modelo</label>
                <input type="text" id="rt-modelo-nome" value="${escapeHtml(payload.cliente)}" placeholder="ex.: HOSPITAL UNIMED — DMLs">
            </div>
            <button type="button" id="rt-modelo-save" class="primary-button">Salvar modelo</button>
            <button type="button" id="rt-modelo-cancel" class="secondary-button">Cancelar</button>
        </div>`;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.querySelector('#rt-modelo-cancel').addEventListener('click', close);
    overlay.querySelector('#rt-modelo-save').addEventListener('click', async () => {
        const nome = overlay.querySelector('#rt-modelo-nome').value.trim() || payload.cliente;
        const btn = overlay.querySelector('#rt-modelo-save');
        setSaving(true, btn, 'Salvando...');
        const r = await callAPI('saveRelatorioTecnicoModelo', {
            user: state.currentUser, cliente: payload.cliente, nome, dados: modeloDadosFromPayload(payload)
        }).catch(() => null);
        if (r && r.status === 'success') { showToast('Modelo salvo.'); close(); }
        else { showToast((r && r.message) || 'Não foi possível salvar o modelo.', true); setSaving(false, btn); }
    });
}

export async function openRelatorioTecnicoModelosModal() {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `<div class="modal-card"><h3>Modelos</h3><p>Carregando...</p></div>`;
    document.body.appendChild(overlay);
    const card = overlay.querySelector('.modal-card');
    const close = () => overlay.remove();
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });

    const r = await callAPI('getRelatorioTecnicoModelos', { user: state.currentUser }).catch(() => null);
    const modelos = (r && r.status === 'success') ? r.modelos : [];
    card.innerHTML = `
        <h3>Modelos de relatório técnico</h3>
        ${modelos.length ? `<div class="rt-modelo-list">${modelos.map((mo) => `
            <div class="rt-modelo-item">
                <div><strong>${escapeHtml(mo.nome)}</strong><span>${escapeHtml(mo.cliente)}</span></div>
                <div class="rt-modelo-actions">
                    <button type="button" class="mini-button" data-use="${escapeHtml(mo.dados)}" data-cli="${escapeHtml(mo.cliente)}">Usar</button>
                    <button type="button" class="mini-button danger" data-del="${escapeHtml(mo.id)}">✕</button>
                </div>
            </div>`).join('')}</div>` : '<p>Nenhum modelo salvo ainda. Crie um pelo botão "Salvar como modelo" no formulário.</p>'}
        <button type="button" class="secondary-button" id="rt-modelos-close">Fechar</button>`;
    card.querySelector('#rt-modelos-close').addEventListener('click', close);
    card.querySelectorAll('[data-use]').forEach((btn) => btn.addEventListener('click', () => {
        const dados = JSON.parse(btn.dataset.use || '{}');
        dados.cliente = btn.dataset.cli;
        close();
        navigateTo('relatorio-tecnico-new', { prefillModelo: JSON.stringify(dados) });
    }));
    card.querySelectorAll('[data-del]').forEach((btn) => btn.addEventListener('click', async () => {
        if (!confirm('Apagar este modelo?')) return;
        const rr = await callAPI('deleteRelatorioTecnicoModelo', { user: state.currentUser, id: btn.dataset.del }).catch(() => null);
        if (rr && rr.status === 'success') { showToast('Modelo apagado.'); close(); openRelatorioTecnicoModelosModal(); }
        else showToast((rr && rr.message) || 'Não foi possível apagar.', true);
    }));
}
