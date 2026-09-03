import { state } from '../app.js';
import { callAPI, saveCache, loadCache, ensureFormData } from '../api.js';
import { escapeHtml, titleCase, getInitials, profileClass } from '../utils/format.js';
import { showToast, loadingState, renderSimpleOptions, showRefreshIndicator, hideRefreshIndicator, setSaving, initializeSearchableInput } from '../utils/dom.js';
import { ensureStyles } from '../utils/ui.js';

let activeAdminTab = 'users';

// A API do Sheets pode devolver "TRUE" (maiúsculo) em vez do "true" que o
// app grava, quando a célula vira um tipo booleano de verdade na planilha
// (ex.: editada direto no Sheets) — comparação exata `=== 'true'` sem isso
// mostra o checkbox desmarcado mesmo com o toggle "ligado" na planilha.
function isConfigOn(value) {
    return String(value ?? '').trim().toLowerCase() === 'true';
}

// Override individual das 3 permissões que até aqui só existiam como chave
// global (Configurações > "Apagar registros de outros"/"Criar proposta e
// funil"/"Acesso ao Radar") — vazio = "Padrão" (usa a config global), só
// preenche quando esse usuário específico precisa fugir da regra geral.
function renderPermFieldsHtml(perms) {
    const opt = (current) => renderSimpleOptions(['Padrão', 'Sim', 'Não'], current === 'Sim' ? 'Sim' : current === 'Nao' ? 'Não' : 'Padrão');
    return `
        <div class="uif-field">
            <label>Apagar registros</label>
            <select class="uif-perm-delete">${opt(perms.permDelete)}</select>
        </div>
        <div class="uif-field">
            <label>Criar proposta/funil</label>
            <select class="uif-perm-criar">${opt(perms.permCriarPropostaFunil)}</select>
        </div>
        <div class="uif-field">
            <label>Acesso ao Radar</label>
            <select class="uif-perm-radar">${opt(perms.permAcessoRadar)}</select>
        </div>
    `;
}

function readPermFieldsValue(scope) {
    const map = { 'Padrão': '', 'Sim': 'Sim', 'Não': 'Nao' };
    return {
        permDelete: map[scope.querySelector('.uif-perm-delete').value] ?? '',
        permCriarPropostaFunil: map[scope.querySelector('.uif-perm-criar').value] ?? '',
        permAcessoRadar: map[scope.querySelector('.uif-perm-radar').value] ?? ''
    };
}

// Redimensiona pro maior lado ficar em no máx. maxDim antes de virar
// base64 — a logo é salva numa célula do Sheets (limite de 50.000
// caracteres), e um arquivo exportado de um editor de design facilmente
// vem grande demais pra caber sem isso. SVG passa direto sem rasterizar
// (arquivo vetorial já costuma ser pequeno, e rasterizar perderia a
// nitidez em qualquer tamanho de tela).
async function resizeImageToDataUrl(file, maxDim) {
    if (file.type === 'image/svg+xml') {
        return await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(new Error('Não foi possível ler o arquivo.'));
            reader.readAsDataURL(file);
        });
    }
    const rawDataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('Não foi possível ler o arquivo.'));
        reader.readAsDataURL(file);
    });
    const img = await new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error('Arquivo de imagem inválido.'));
        image.src = rawDataUrl;
    });
    const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.width * scale));
    canvas.height = Math.max(1, Math.round(img.height * scale));
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/png');
}

export async function renderAdminPage() {
    ensureStyles('admin');
    const mainContent = document.getElementById('main-content');

    if (!state.currentUser || (state.currentUser.profile || '').toLowerCase() !== 'admin') {
        mainContent.innerHTML = `<div class="empty-state"><p>Acesso restrito ao administrador.</p></div>`;
        return;
    }

    const cachedData = loadCache('admin_data');
    const cachedEmail = loadCache('admin_email');

    if (cachedData) {
        state.adminData = cachedData;
        fillAdminContent(mainContent, cachedData, cachedEmail || {});
        showRefreshIndicator();
    } else {
        mainContent.innerHTML = `
            <div class="page-header">
                <div><h2>Admin</h2><p class="page-subtitle">Painel administrativo</p></div>
            </div>
            <div id="admin-skeleton">${loadingState('⚙️', 'Carregando painel administrativo...')}</div>
        `;
    }

    const [result, emailResult] = await Promise.all([getAdminData(), getEmailConfig()]);
    if (cachedData) { hideRefreshIndicator(); }

    if (result.status !== 'success') {
        if (!cachedData) {
            mainContent.innerHTML = `<p class="error-message">${escapeHtml(result.message || 'Erro ao carregar a area admin.')}</p>`;
        }
        return;
    }

    state.adminData = result.data;
    saveCache('admin_data', result.data);
    const emailConfig = emailResult.status === 'success' ? emailResult.data : (cachedEmail || {});
    if (emailResult.status === 'success') { saveCache('admin_email', emailResult.data); }

    if (state.currentPage === 'admin' && document.getElementById('main-content') === mainContent) {
        fillAdminContent(mainContent, result.data, emailConfig);
    }
}

function fillAdminContent(mainContent, data, emailConfig) {
    function emailPanel(prefix, label, subtitle, vars, config, diasLabel) {
        const isActive = isConfigOn(config[`${prefix}_ativas`]);
        return `
        <div class="email-notif-panel">
            <div class="email-notif-panel-header">
                <div>
                    <strong style="font-size:0.93rem;font-weight:500">${label}</strong>
                    <p class="helper-text" style="margin:0.2rem 0 0;font-size:0.8rem">${subtitle}</p>
                </div>
                <label class="toggle-switch">
                    <input type="checkbox" id="${prefix}-ativas" ${isActive ? 'checked' : ''} data-email-toggle="${prefix}">
                    <span class="toggle-slider"></span>
                </label>
            </div>
            <div id="${prefix}-fields" class="${isActive ? '' : 'email-panel-disabled'}">
                <div class="form-group">
                    <label for="${prefix}-dias" style="font-size:0.8rem;color:var(--text-muted-strong)">${diasLabel || 'Dias sem atualização'}</label>
                    <input type="number" id="${prefix}-dias" value="${escapeHtml(config[`${prefix}_dias`] || '30')}" min="1" max="365">
                </div>
                <div class="form-group">
                    <label for="${prefix}-assunto" style="font-size:0.8rem;color:var(--text-muted-strong)">Assunto</label>
                    <input type="text" id="${prefix}-assunto" value="${escapeHtml(config[`${prefix}_assunto`] || '')}">
                </div>
                <div class="form-group">
                    <label for="${prefix}-corpo" style="font-size:0.8rem;color:var(--text-muted-strong)">Corpo do e-mail</label>
                    <div style="margin-bottom:0.4rem;display:flex;flex-wrap:wrap;gap:0.2rem">
                        ${vars.map((v) => `<span class="email-var-badge">{{${v}}}</span>`).join('')}
                    </div>
                    <textarea id="${prefix}-corpo" rows="5">${escapeHtml(config[`${prefix}_corpo`] || '')}</textarea>
                </div>
            </div>
            <button type="button" class="secondary-button" data-save-email="${prefix}">Salvar configuração</button>
        </div>`;
    }

    mainContent.innerHTML = `
        <div class="admin-hero">
            <div class="admin-hero-icon">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <circle cx="12" cy="12" r="3"/>
                    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
                </svg>
            </div>
            <div class="admin-hero-text">
                <h2 class="admin-hero-title">Painel Administrativo</h2>
                <p class="admin-hero-sub">Gerencie usuários, notificações e configurações</p>
            </div>
        </div>

        <div class="admin-tabs-bar">
            <button type="button" class="admin-tab${activeAdminTab === 'users' ? ' active' : ''}" data-tab="users">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>
                Usuários
            </button>
            <button type="button" class="admin-tab${activeAdminTab === 'listas' ? ' active' : ''}" data-tab="listas">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
                Listas
            </button>
            <button type="button" class="admin-tab${activeAdminTab === 'config' ? ' active' : ''}" data-tab="config">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
                Configurações
            </button>
            <button type="button" class="admin-tab${activeAdminTab === 'email' ? ' active' : ''}" data-tab="email">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,12 2,6"/></svg>
                E-mail
            </button>
            <button type="button" class="admin-tab${activeAdminTab === 'auditoria' ? ' active' : ''}" data-tab="auditoria">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="15" y2="17"/></svg>
                Auditoria
            </button>
            <button type="button" class="admin-tab${activeAdminTab === 'saude' ? ' active' : ''}" data-tab="saude">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>
                Saúde
            </button>
            <button type="button" class="admin-tab${activeAdminTab === 'importar' ? ' active' : ''}" data-tab="importar">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                Importar
            </button>
        </div>

        <!-- Tab: Usuários -->
        <div class="admin-tab-panel${activeAdminTab === 'users' ? ' active' : ''} card" id="admin-tab-users" style="padding:1rem">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.85rem">
                <span style="font-size:0.82rem;color:var(--text-muted-strong)">${data.users.length} usuário(s)</span>
                <button type="button" class="btn-add" id="btn-new-user" style="padding:0.4rem 0.85rem;font-size:0.82rem">+ Novo Usuário</button>
            </div>
            <div class="admin-user-table-wrap">
                <table class="admin-user-table">
                    <thead><tr>
                        <th>Usuário</th>
                        <th>Cargo</th>
                        <th>Região</th>
                        <th>Último acesso</th>
                        <th>E-mail</th>
                        <th></th>
                    </tr></thead>
                    <tbody>
                        ${data.users.map((user, index) => {
                            const nome = user.nomeVendedor || user.NomeVendedor || user.name || '';
                            const email = user.emailLogin || user.EmailLogin || user.email || '';
                            const perfil = user.perfil || user.Perfil || user.profile || '';
                            const gerencia = user.gerencia || user.Gerencia || '-';
                            const ultimoLogin = user.ultimoLogin || user.UltimoLogin || '';
                            const pc = profileClass(perfil);
                            return `<tr class="admin-user-row row-collapsed">
                                <td data-label=""><div class="user-avatar-cell">
                                    <div class="user-avatar-initials ${pc}">${escapeHtml(getInitials(nome))}</div>
                                    <span>${escapeHtml(titleCase(nome))}</span>
                                    <button type="button" class="row-toggle-btn" data-row-toggle aria-label="Mostrar detalhes de ${escapeHtml(nome)}" aria-expanded="false">
                                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
                                    </button>
                                </div></td>
                                <td data-label="Cargo"><span class="profile-badge ${pc}">${escapeHtml(titleCase(perfil))}</span></td>
                                <td data-label="Região" style="font-size:0.85rem;color:var(--text-muted-strong)">${escapeHtml(gerencia)}</td>
                                <td data-label="Último acesso" style="font-size:0.85rem;color:var(--text-muted-strong)">${escapeHtml(ultimoLogin || '-')}</td>
                                <td data-label="E-mail">
                                    <button type="button" class="admin-icon-btn email-copy-btn" title="${escapeHtml(email)}" aria-label="Copiar e-mail de ${escapeHtml(nome)}" data-email="${escapeHtml(email)}">✉</button>
                                </td>
                                <td data-label="Editar">
                                    <button type="button" class="admin-icon-btn" data-user-index="${index}" title="Editar" aria-label="Editar usuário ${escapeHtml(nome)}">✏️</button>
                                </td>
                            </tr>`;
                        }).join('')}
                    </tbody>
                </table>
            </div>
        </div>

        <!-- Tab: Listas de Apoio -->
        <div class="admin-tab-panel${activeAdminTab === 'listas' ? ' active' : ''} card" id="admin-tab-listas" style="padding:1rem">
            <div class="lookup-grid">
                ${renderLookupEditor('Cidades', 'cidades', data.lookups.cidades)}
                ${renderLookupEditor('Areas de Atuacao', 'areasAtuacao', data.lookups.areasAtuacao)}
                ${renderLookupEditor('Potenciais Cliente', 'potenciaisCliente', data.lookups.potenciaisCliente)}
                ${renderLookupEditor('Aplicacoes', 'aplicacoes', data.lookups.aplicacoes || [])}
                ${renderLookupEditor('Equipamentos', 'equipamentos', data.lookups.equipamentos || [])}
            </div>

            <div class="admin-section" style="margin-top:1.25rem">
                <div class="section-title-row"><h3 class="section-title">⭐ Clientes Principais</h3></div>
                <div class="card" style="padding:1rem">
                    <p class="helper-text" style="text-align:left;margin:0 0 0.75rem">Clientes que devem receber um Relatório de Manutenção todo mês. O app avisa o vendedor responsável (painel no Início + notificação) quando um deles ainda não tem relatório no mês corrente.</p>
                    <div class="searchable-select" style="margin-bottom:0.9rem">
                        <input type="text" id="cp-add-input" class="form-input" placeholder="Buscar cliente pra adicionar..." autocomplete="off">
                        <div class="searchable-select-menu" id="cp-add-menu"></div>
                    </div>
                    <div id="clientes-principais-content"><p class="helper-text">Carregando...</p></div>
                </div>
            </div>
        </div>

        <!-- Tab: Configurações -->
        <div class="admin-tab-panel${activeAdminTab === 'config' ? ' active' : ''}" id="admin-tab-config">
            <div class="admin-section" style="margin-bottom:1.25rem">
                <div class="section-title-row"><h3 class="section-title">Configurações Gerais</h3></div>
                <div class="card" style="padding:1rem">
                    <div class="form-group" style="max-width:280px">
                        <label for="config-load-dias">Período padrão de carregamento</label>
                        <select id="config-load-dias">
                            <option value="15" ${emailConfig.load_dias === '15' ? 'selected' : ''}>15 dias</option>
                            <option value="30" ${!emailConfig.load_dias || emailConfig.load_dias === '30' ? 'selected' : ''}>30 dias</option>
                            <option value="60" ${emailConfig.load_dias === '60' ? 'selected' : ''}>60 dias</option>
                            <option value="90" ${emailConfig.load_dias === '90' ? 'selected' : ''}>90 dias</option>
                        </select>
                        <p style="margin:0.35rem 0 0;font-size:0.8rem;color:var(--text-muted-strong)">Aplica a todas as listas: visitas, propostas, funil</p>
                    </div>
                    <button type="button" id="save-load-dias" class="primary-button" style="margin-top:0.75rem">Salvar</button>
                </div>
            </div>
            <div class="admin-section" style="margin-bottom:1.25rem">
                <div class="section-title-row"><h3 class="section-title">Nova Visita</h3></div>
                <div class="card" style="padding:1rem;display:flex;flex-direction:column;gap:0.85rem">
                    <label style="display:flex;align-items:center;gap:0.6rem;font-size:0.87rem;font-weight:500;cursor:pointer">
                        <input type="checkbox" id="config-visita-multi-tipo" style="width:auto;accent-color:var(--primary)" ${isConfigOn(emailConfig.visita_multi_tipo) ? 'checked' : ''}>
                        Permitir escolher até 3 tipos por visita (cria uma visita separada para cada tipo)
                    </label>
                    <p class="helper-text" style="text-align:left;margin:0">Desligado: cada registro envia só 1 tipo de visita. Ligado: o vendedor pode marcar até 3 tipos de uma vez.</p>
                    <button type="button" id="save-visita-multi-tipo" class="primary-button" style="align-self:flex-start">Salvar</button>
                </div>
            </div>
            <div class="admin-section" style="margin-bottom:1.25rem">
                <div class="section-title-row"><h3 class="section-title">Permissões</h3></div>
                <div class="card" style="padding:1rem;display:flex;flex-direction:column;gap:0.85rem">
                    <label style="display:flex;align-items:center;gap:0.6rem;font-size:0.87rem;font-weight:500;cursor:pointer">
                        <input type="checkbox" id="config-permitir-apagar" style="width:auto;accent-color:var(--primary)" ${isConfigOn(emailConfig.permitir_apagar_outros) ? 'checked' : ''}>
                        Permitir que Gerentes e Vendedores apaguem visitas, propostas e funil
                    </label>
                    <label style="display:flex;align-items:center;gap:0.6rem;font-size:0.87rem;font-weight:500;cursor:pointer">
                        <input type="checkbox" id="config-permitir-criar" style="width:auto;accent-color:var(--primary)" ${isConfigOn(emailConfig.permitir_criar_proposta_funil) ? 'checked' : ''}>
                        Permitir que Gerentes e Vendedores criem novas Propostas e Funil
                    </label>
                    <label style="display:flex;align-items:center;gap:0.6rem;font-size:0.87rem;font-weight:500;cursor:pointer">
                        <input type="checkbox" id="config-permitir-radar" style="width:auto;accent-color:var(--primary)" ${isConfigOn(emailConfig.permitir_acesso_radar) ? 'checked' : ''}>
                        Permitir que Gerentes e Vendedores acessem o Radar de Clientes
                    </label>
                    <label style="display:flex;align-items:center;gap:0.6rem;font-size:0.87rem;font-weight:500;cursor:pointer">
                        <input type="checkbox" id="config-permitir-editar-manutencao" style="width:auto;accent-color:var(--primary)" ${isConfigOn(emailConfig.permitir_editar_manutencao_assinada) ? 'checked' : ''}>
                        Permitir editar Relatório de Manutenção depois de assinado (fica pendente de aprovação)
                    </label>
                    <p class="helper-text" style="text-align:left;margin:0">Admin sempre pode criar/apagar/acessar o Radar e editar qualquer Relatório de Manutenção, mesmo assinado. Nova Visita continua liberada pra todos. As outras opções afetam Proposta, Funil, Radar de Clientes e Relatório de Manutenção.</p>
                    <button type="button" id="save-permissoes" class="primary-button" style="align-self:flex-start">Salvar</button>
                </div>
            </div>
            <div class="admin-section" style="margin-bottom:1.25rem">
                <div class="section-title-row"><h3 class="section-title">Logo da Empresa</h3></div>
                <div class="card" style="padding:1rem;display:flex;flex-direction:column;gap:0.85rem">
                    <p class="helper-text" style="text-align:left;margin:0">Aparece no cabeçalho do Relatório de Manutenção. A imagem é redimensionada automaticamente ao enviar — não precisa mandar já pequena.</p>
                    <div style="display:flex;align-items:center;gap:1rem;flex-wrap:wrap">
                        <div id="logo-empresa-preview" style="width:64px;height:64px;border:1px solid var(--border);border-radius:var(--radius-sm);display:flex;align-items:center;justify-content:center;overflow:hidden;background:#fff;flex-shrink:0">
                            ${emailConfig.logo_empresa ? `<img src="${escapeHtml(emailConfig.logo_empresa)}" alt="Logo atual" style="max-width:100%;max-height:100%;object-fit:contain">` : '<span class="helper-text" style="margin:0;font-size:0.65rem;text-align:center">Sem logo</span>'}
                        </div>
                        <div style="display:flex;flex-direction:column;gap:0.5rem">
                            <input type="file" id="logo-empresa-input" accept="image/*">
                            <div style="display:flex;gap:0.5rem">
                                <button type="button" id="save-logo-empresa" class="primary-button" disabled>Enviar logo</button>
                                <button type="button" id="remove-logo-empresa" class="secondary-button" ${emailConfig.logo_empresa ? '' : 'style="display:none"'}>Remover</button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
            <div class="admin-section" style="margin-bottom:1.25rem">
                <div class="section-title-row"><h3 class="section-title">🔧 Modo Manutenção</h3></div>
                <div class="card" style="padding:1rem;display:flex;flex-direction:column;gap:0.85rem">
                    <p class="helper-text" style="text-align:left;margin:0">Quando ativo, apenas Admins conseguem acessar o app. Os demais usuários veem uma tela de manutenção com a mensagem abaixo.</p>
                    <label style="display:flex;align-items:center;gap:0.6rem;font-size:0.87rem;font-weight:500;cursor:pointer">
                        <input type="checkbox" id="manutencao-ativa" style="width:auto;accent-color:var(--primary)" ${isConfigOn(emailConfig.manutencao_ativa) ? 'checked' : ''}>
                        Ativar modo manutenção
                    </label>
                    <div class="form-group" style="margin:0">
                        <label for="manutencao-mensagem">Mensagem exibida para os usuários</label>
                        <textarea id="manutencao-mensagem" rows="3">${escapeHtml(emailConfig.manutencao_mensagem || '')}</textarea>
                    </div>
                    <button type="button" id="save-manutencao" class="primary-button" style="align-self:flex-start">Salvar</button>
                </div>
            </div>
        </div>

        <!-- Tab: E-mail -->
        <div class="admin-tab-panel${activeAdminTab === 'email' ? ' active' : ''}" id="admin-tab-email">
            <div class="email-warning-card">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#F59E0B" stroke-width="2" stroke-linecap="round" style="flex-shrink:0;margin-top:1px"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                <span>Esta funcionalidade requer um trigger diário configurado no Google Apps Script.</span>
            </div>
            <div class="email-notif-grid">
                ${emailPanel('propostas', 'Propostas sem atualização', 'Avisa vendedores com propostas paradas há X dias', ['nome', 'quantidade', 'dias'], emailConfig)}
                ${emailPanel('visitas', 'Relatório de visitas pendente', 'Avisa vendedores sem visitas registradas em X dias', ['nome', 'dias'], emailConfig)}
                ${emailPanel('funil', 'Funil sem atualização', 'Avisa vendedores com oportunidades ativas paradas há X dias', ['nome', 'quantidade', 'dias'], emailConfig)}
                ${emailPanel('contratos', 'Contratos vencendo', 'Avisa vendedores com contratos vencendo nos próximos X dias', ['nome', 'quantidade', 'dias'], emailConfig, 'Dias de antecedência do vencimento')}
                ${emailPanel('agendamentos', 'Retornos agendados', 'Avisa vendedores com retorno de visita agendado nos próximos X dias', ['nome', 'quantidade', 'dias'], emailConfig, 'Dias de antecedência do retorno')}
            </div>
        </div>

        <!-- Tab: Auditoria -->
        <div class="admin-tab-panel${activeAdminTab === 'auditoria' ? ' active' : ''} card" id="admin-tab-auditoria" style="padding:1rem">
            <div id="auditoria-content"><p class="helper-text">Carregando...</p></div>
        </div>

        <!-- Tab: Saúde -->
        <div class="admin-tab-panel${activeAdminTab === 'saude' ? ' active' : ''} card" id="admin-tab-saude" style="padding:1rem">
            <div id="saude-content"><p class="helper-text">Carregando...</p></div>
        </div>

        <!-- Tab: Importar (migração) -->
        <div class="admin-tab-panel${activeAdminTab === 'importar' ? ' active' : ''}" id="admin-tab-importar">
            <div class="admin-section">
                <div class="section-title-row"><h3 class="section-title">Importar dados (migração)</h3></div>
                <div class="card" style="padding:1rem;display:flex;flex-direction:column;gap:0.85rem">
                    <p class="helper-text" style="text-align:left;margin:0">
                        Sobe os dados exportados do sistema antigo (CSV ou Excel .xlsx), uma aba por vez.
                        ID já cadastrado é pulado (ou atualizado, na base de clientes) — pode reenviar o
                        mesmo arquivo sem duplicar. Só as colunas que o app usa são importadas.
                    </p>
                    <div class="form-group" style="max-width:280px;margin:0">
                        <label for="import-entidade" style="font-size:0.8rem;color:var(--text-muted-strong)">O que importar</label>
                        <select id="import-entidade">
                            <option value="visitas-ativas">Visitas ativas (BASE)</option>
                            <option value="visitas-prospeccao">Visitas — Prospecção</option>
                            <option value="propostas">Propostas</option>
                            <option value="funil">Funil de vendas</option>
                            <option value="clientes">Base de clientes</option>
                        </select>
                    </div>
                    <input type="file" id="import-file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet">
                    <button type="button" id="import-analisar" class="primary-button" style="align-self:flex-start" disabled>Analisar</button>
                    <div id="import-resultado"></div>
                </div>
            </div>
        </div>
    `;

    bindAdminEvents(data);
    if (activeAdminTab === 'auditoria') { loadAuditoriaTab(); }
    if (activeAdminTab === 'saude') { loadSaudeTab(); }
    if (activeAdminTab === 'listas') { loadClientesPrincipaisTab(); }
}


let _saudeData = null;

async function loadSaudeTab() {
    const container = document.getElementById('saude-content');
    if (!container) return;
    if (!_saudeData) {
        try {
            const result = await callAPI('getHealthPanel', { user: state.currentUser });
            _saudeData = result.status === 'success' ? result.data : null;
        } catch (e) { _saudeData = null; }
    }
    if (!_saudeData) {
        container.innerHTML = '<p class="helper-text">Não foi possível carregar o painel de saúde.</p>';
        return;
    }
    const d = _saudeData;
    const geoTem = d.radarGeocodingLimite > 0;
    container.innerHTML = `
        <div class="admin-stats-row" style="margin-bottom:1rem">
            <div class="admin-stat">
                <div class="admin-stat-body">
                    <strong class="admin-stat-num">${d.usuariosAtivos7d}/${d.totalUsuarios}</strong>
                    <span class="admin-stat-lbl">Usuários ativos (7 dias)</span>
                </div>
            </div>
            ${geoTem ? `<div class="admin-stat">
                <div class="admin-stat-body">
                    <strong class="admin-stat-num">${d.radarGeocodingUsado}/${d.radarGeocodingLimite}</strong>
                    <span class="admin-stat-lbl">Cota de geocoding do Radar (mês)</span>
                </div>
            </div>` : ''}
        </div>
        <p class="dash-section-heading">Tamanho das abas</p>
        <div class="admin-user-table-wrap">
            <table class="admin-user-table">
                <thead><tr><th>Aba</th><th>Registros</th></tr></thead>
                <tbody>
                    <tr><td data-label="Aba">Visitas</td><td data-label="Registros">${d.registros.visitas}</td></tr>
                    <tr><td data-label="Aba">Propostas</td><td data-label="Registros">${d.registros.propostas}</td></tr>
                    <tr><td data-label="Aba">Funil</td><td data-label="Registros">${d.registros.funil}</td></tr>
                    <tr><td data-label="Aba">Contratos</td><td data-label="Registros">${d.registros.contratos}</td></tr>
                    <tr><td data-label="Aba">Manutenções</td><td data-label="Registros">${d.registros.manutencoes}</td></tr>
                </tbody>
            </table>
        </div>
    `;
}


const ACAO_ICON = { criou: '✚', editou: '✏️', apagou: '🗑️', aprovou: '✅' };
const ENTIDADE_LABEL = { visita: 'Visita', proposta: 'Proposta', funil: 'Funil', contrato: 'Contrato', manutencao: 'Manutenção', usuario: 'Usuário' };

let _auditoriaEntries = null;

async function loadAuditoriaTab() {
    const container = document.getElementById('auditoria-content');
    if (!container) return;
    if (!_auditoriaEntries) {
        try {
            const result = await callAPI('getAuditoria', { user: state.currentUser });
            _auditoriaEntries = result.status === 'success' ? result.entries : [];
        } catch (e) {
            container.innerHTML = '<p class="helper-text">Não foi possível carregar a auditoria.</p>';
            return;
        }
    }
    renderAuditoriaEntries(container, _auditoriaEntries);
}

function renderAuditoriaEntries(container, entries) {
    if (!entries.length) {
        container.innerHTML = '<p class="helper-text">Nenhum registro de auditoria ainda.</p>';
        return;
    }
    container.innerHTML = `
        <div class="admin-user-table-wrap">
            <table class="admin-user-table">
                <thead><tr><th>Quando</th><th>Quem</th><th>Ação</th><th>Registro</th></tr></thead>
                <tbody>
                    ${entries.map((e) => `<tr>
                        <td data-label="Quando" style="font-size:0.82rem;color:var(--text-muted-strong);white-space:nowrap">${escapeHtml(e.data)} ${escapeHtml(e.hora)}</td>
                        <td data-label="Quem" style="font-size:0.85rem">${escapeHtml(e.usuarioNome || e.usuarioEmail)}</td>
                        <td data-label="Ação" style="font-size:0.85rem">${ACAO_ICON[e.acao] || ''} ${escapeHtml(e.acao)}</td>
                        <td data-label="Registro" style="font-size:0.85rem">${escapeHtml(ENTIDADE_LABEL[e.entidade] || e.entidade)} — ${escapeHtml(e.detalhes || e.entidadeId)}</td>
                    </tr>`).join('')}
                </tbody>
            </table>
        </div>
    `;
}


let _clientesPrincipaisData = null;
let _clientesPrincipaisSearchWired = false;

async function loadClientesPrincipaisTab() {
    const container = document.getElementById('clientes-principais-content');
    if (!container) return;

    // A busca de "adicionar cliente" só precisa ser configurada uma vez —
    // ensureFormData() já cacheia por si só, então não custa nada chamar de
    // novo aqui se a pessoa voltar pra essa aba.
    if (!_clientesPrincipaisSearchWired) {
        _clientesPrincipaisSearchWired = true;
        try {
            const fd = await ensureFormData();
            const clientes = (fd.data && fd.data.clientes) || [];
            const input = document.getElementById('cp-add-input');
            const menu = document.getElementById('cp-add-menu');
            if (input && menu) {
                initializeSearchableInput({
                    input, menu,
                    items: clientes.map((c) => c.nome).filter(Boolean),
                    onSelect: async (nome) => {
                        input.value = '';
                        const result = await callAPI('addClientePrincipal', { cliente: nome, user: state.currentUser });
                        if (result.status === 'success') {
                            showToast(`"${nome}" adicionado aos Clientes Principais.`);
                            _clientesPrincipaisData = null;
                            loadClientesPrincipaisTab();
                        } else {
                            showToast(result.message || 'Não foi possível adicionar.', true);
                        }
                    }
                });
            }
        } catch (e) { /* autocomplete falha silenciosamente — a lista abaixo ainda carrega */ }
    }

    if (!_clientesPrincipaisData) {
        try {
            const result = await callAPI('getClientesPrincipais', { user: state.currentUser });
            _clientesPrincipaisData = result.status === 'success' ? result.clientesPrincipais : [];
        } catch (e) {
            container.innerHTML = '<p class="helper-text">Não foi possível carregar os clientes principais.</p>';
            return;
        }
    }
    renderClientesPrincipaisList(container, _clientesPrincipaisData);
}

function renderClientesPrincipaisList(container, list) {
    if (!list.length) {
        container.innerHTML = '<p class="helper-text">Nenhum cliente principal cadastrado ainda.</p>';
        return;
    }
    container.innerHTML = list.map((c) => `
        <div class="cp-row" data-id="${escapeHtml(c.id)}">
            <div class="cp-row-info">
                <strong>${escapeHtml(c.cliente)}</strong>
                <span class="helper-text">${c.vendedores ? escapeHtml(c.vendedores) + ' · ' : ''}${c.emDia ? `relatório em dia (${escapeHtml(c.ultimoRelatorioEm)})` : 'sem relatório este mês'}</span>
            </div>
            <div class="cp-row-actions">
                <span class="status-pill ${c.emDia ? 'status-concluido' : 'status-aguardando'}">${c.emDia ? '✅ Em dia' : '⚠️ Pendente'}</span>
                <button type="button" class="mini-button mini-button-danger cp-remove-btn" data-id="${escapeHtml(c.id)}" aria-label="Remover" title="Remover">🗑</button>
            </div>
        </div>
    `).join('');
    container.querySelectorAll('.cp-remove-btn').forEach((btn) => {
        btn.addEventListener('click', async () => {
            const id = btn.dataset.id;
            const item = _clientesPrincipaisData.find((c) => c.id === id);
            if (!confirm(`Remover "${item ? item.cliente : ''}" da lista de Clientes Principais?`)) return;
            const result = await callAPI('removeClientePrincipal', { id, user: state.currentUser });
            if (result.status === 'success') {
                _clientesPrincipaisData = _clientesPrincipaisData.filter((c) => c.id !== id);
                renderClientesPrincipaisList(container, _clientesPrincipaisData);
                showToast('Removido dos Clientes Principais.');
            } else {
                showToast(result.message || 'Não foi possível remover.', true);
            }
        });
    });
}


export function bindAdminEvents(data) {
    // Tabs
    document.querySelectorAll('.admin-tab').forEach((tab) => {
        tab.addEventListener('click', () => {
            activeAdminTab = tab.dataset.tab;
            document.querySelectorAll('.admin-tab').forEach((t) => t.classList.remove('active'));
            document.querySelectorAll('.admin-tab-panel').forEach((p) => p.classList.remove('active'));
            tab.classList.add('active');
            const panel = document.getElementById(`admin-tab-${tab.dataset.tab}`);
            if (panel) { panel.classList.add('active'); }
            if (tab.dataset.tab === 'auditoria') { loadAuditoriaTab(); }
            if (tab.dataset.tab === 'saude') { loadSaudeTab(); }
            if (tab.dataset.tab === 'listas') { loadClientesPrincipaisTab(); }
        });
    });

    document.getElementById('btn-new-user').addEventListener('click', () => {
        if (document.querySelector('.uif-modal-overlay')) {
            document.querySelector('.uif-modal-overlay .uif-nome').focus();
            return;
        }
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay uif-modal-overlay';
        overlay.innerHTML = `
            <div class="modal-card modal-card-wide uif-modal">
                <div class="uif-header">
                    <div class="user-avatar-initials" style="background:#e2e8f0;color:#64748b;font-size:1rem">+</div>
                    <span class="uif-title">Novo Usuário</span>
                </div>
                <div class="uif-grid">
                    <div class="uif-field">
                        <label>Nome</label>
                        <input type="text" class="uif-nome" placeholder="Nome completo">
                    </div>
                    <div class="uif-field">
                        <label>E-mail</label>
                        <input type="email" class="uif-email" placeholder="email@empresa.com">
                    </div>
                    <div class="uif-field">
                        <label>Senha <span class="uif-req">*</span></label>
                        <input type="password" class="uif-senha" placeholder="••••••••" autocomplete="new-password">
                    </div>
                    <div class="uif-field">
                        <label>Região</label>
                        <input type="text" class="uif-gerencia" placeholder="Região">
                    </div>
                    <div class="uif-field">
                        <label>Cargo</label>
                        <select class="uif-perfil">${renderSimpleOptions(['Vendedor', 'Gerente', 'Admin'], '')}</select>
                    </div>
                    <div class="uif-field">
                        <label>Meta mensal (visitas)</label>
                        <input type="number" class="uif-meta" min="0" placeholder="Ex.: 40">
                    </div>
                    ${renderPermFieldsHtml({})}
                </div>
                <div class="uif-actions">
                    <button type="button" class="uif-cancel">Cancelar</button>
                    <button type="button" class="uif-save">Criar Usuário</button>
                </div>
            </div>`;
        document.body.appendChild(overlay);
        const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
        const onKey = (e) => { if (e.key === 'Escape') close(); };
        document.addEventListener('keydown', onKey);
        overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
        overlay.querySelector('.uif-nome').focus();

        overlay.querySelector('.uif-cancel').addEventListener('click', close);
        overlay.querySelector('.uif-save').addEventListener('click', async () => {
            const senha = overlay.querySelector('.uif-senha').value.trim();
            if (!senha) { showToast('Informe a senha para o novo usuário.', true); return; }
            if (senha.length < 6) { showToast('A senha precisa ter pelo menos 6 caracteres.', true); return; }
            const saveBtn = overlay.querySelector('.uif-save');
            setSaving(true, saveBtn, 'Criando...');
            const result = await saveUser({
                originalEmail: '',
                emailLogin: overlay.querySelector('.uif-email').value.trim(),
                nomeVendedor: overlay.querySelector('.uif-nome').value.trim(),
                senha,
                gerencia: overlay.querySelector('.uif-gerencia').value.trim(),
                perfil: overlay.querySelector('.uif-perfil').value,
                metaVisitasMes: overlay.querySelector('.uif-meta').value.trim(),
                ...readPermFieldsValue(overlay)
            });
            if (result.status === 'success') {
                showToast('Usuário criado.');
                close();
                renderAdminPage();
            } else {
                showToast(result.message || 'Não foi possível criar.', true);
                setSaving(false, saveBtn);
            }
        });
    });

    document.querySelectorAll('[data-user-index]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const user = state.adminData.users[Number(btn.dataset.userIndex)];
            const row = btn.closest('tr');
            const email = user.emailLogin || user.EmailLogin || user.email || '';
            const nome = user.nomeVendedor || user.NomeVendedor || user.name || '';
            const perfil = user.perfil || user.Perfil || user.profile || '';
            const gerencia = (user.gerencia || user.Gerencia || '') === '-' ? '' : (user.gerencia || user.Gerencia || '');
            const metaVisitasMes = user.metaVisitasMes || user.MetaVisitasMes || '';
            const perms = {
                permDelete: user.permDelete || user.PermDelete || '',
                permCriarPropostaFunil: user.permCriarPropostaFunil || user.PermCriarPropostaFunil || '',
                permAcessoRadar: user.permAcessoRadar || user.PermAcessoRadar || ''
            };
            const pc = profileClass(perfil);

            row.innerHTML = `<td colspan="5" class="uif-cell">
                <div class="uif-header">
                    <div class="user-avatar-initials ${pc}">${escapeHtml(getInitials(nome))}</div>
                    <span class="uif-title">${escapeHtml(titleCase(nome))}</span>
                </div>
                <div class="uif-grid">
                    <div class="uif-field">
                        <label>Nome</label>
                        <input type="text" class="uif-nome" value="${escapeHtml(nome)}" placeholder="Nome completo">
                    </div>
                    <div class="uif-field">
                        <label>E-mail</label>
                        <input type="email" class="uif-email" value="${escapeHtml(email)}" placeholder="E-mail">
                    </div>
                    <div class="uif-field">
                        <label>Senha <span class="uif-hint">(em branco = manter)</span></label>
                        <input type="password" class="uif-senha" placeholder="••••••••" autocomplete="new-password">
                    </div>
                    <div class="uif-field">
                        <label>Região</label>
                        <input type="text" class="uif-gerencia" value="${escapeHtml(gerencia)}" placeholder="Região">
                    </div>
                    <div class="uif-field">
                        <label>Cargo</label>
                        <select class="uif-perfil">${renderSimpleOptions(['Vendedor', 'Gerente', 'Admin'], perfil)}</select>
                    </div>
                    <div class="uif-field">
                        <label>Meta mensal (visitas)</label>
                        <input type="number" class="uif-meta" min="0" value="${escapeHtml(String(metaVisitasMes))}" placeholder="Ex.: 40">
                    </div>
                    ${renderPermFieldsHtml(perms)}
                </div>
                <div class="uif-pin-row">
                    <span>PIN de acesso rápido: <strong>${user.hasPin ? 'ativo' : 'não cadastrado'}</strong></span>
                    ${user.hasPin ? '<button type="button" class="mini-button uif-pin-remove">Remover PIN</button>' : ''}
                </div>
                <div class="uif-actions">
                    <button type="button" class="uif-cancel">Cancelar</button>
                    <button type="button" class="uif-save">Salvar</button>
                </div>
            </td>`;

            row.querySelector('.uif-cancel').addEventListener('click', () => renderAdminPage());
            row.querySelector('.uif-pin-remove')?.addEventListener('click', async (ev) => {
                const b = ev.currentTarget;
                b.disabled = true;
                const r = await callAPI('removePin', { email }).catch(() => null);
                if (r && r.status === 'success') {
                    showToast('PIN removido.');
                    renderAdminPage();
                } else {
                    showToast((r && r.message) || 'Não foi possível remover o PIN.', true);
                    b.disabled = false;
                }
            });
            row.querySelector('.uif-save').addEventListener('click', async () => {
                const senhaEdit = row.querySelector('.uif-senha').value.trim();
                if (senhaEdit && senhaEdit.length < 6) { showToast('A senha precisa ter pelo menos 6 caracteres.', true); return; }
                const saveBtn = row.querySelector('.uif-save');
                setSaving(true, saveBtn, 'Salvando...');
                const result = await saveUser({
                    originalEmail: email,
                    emailLogin: row.querySelector('.uif-email').value.trim(),
                    nomeVendedor: row.querySelector('.uif-nome').value.trim(),
                    senha: senhaEdit,
                    gerencia: row.querySelector('.uif-gerencia').value.trim(),
                    perfil: row.querySelector('.uif-perfil').value,
                    metaVisitasMes: row.querySelector('.uif-meta').value.trim(),
                    ...readPermFieldsValue(row)
                });
                if (result.status === 'success') {
                    showToast('Usuário salvo.');
                    renderAdminPage();
                } else {
                    showToast(result.message || 'Não foi possível salvar.', true);
                    setSaving(false, saveBtn);
                }
            });
        });
    });

    document.querySelectorAll('.email-copy-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            navigator.clipboard?.writeText(btn.dataset.email).then(() => showToast('E-mail copiado.'));
        });
    });

    document.querySelectorAll('[data-row-toggle]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const row = btn.closest('.admin-user-row');
            const collapsed = row.classList.toggle('row-collapsed');
            btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
        });
    });

    // Email toggle — enable/disable fields
    document.querySelectorAll('[data-email-toggle]').forEach((toggle) => {
        const prefix = toggle.dataset.emailToggle;
        const fields = document.getElementById(`${prefix}-fields`);
        toggle.addEventListener('change', () => {
            if (fields) { fields.classList.toggle('email-panel-disabled', !toggle.checked); }
        });
    });

    // Lookup save buttons
    document.querySelectorAll('[data-lookup-key]').forEach((button) => {
        button.addEventListener('click', async () => {
            const key = button.dataset.lookupKey;
            const textarea = document.getElementById(`lookup-${key}`);
            const values = textarea.value.split('\n').map((item) => item.trim()).filter(Boolean);
            const result = await saveLookupList({ key, values });
            if (result.status === 'success') { showToast(`Lista ${key} atualizada.`); await renderAdminPage(); }
            else { showToast(result.message || 'Não foi possível salvar.', true); }
        });
    });

    // Configurações gerais: período de carregamento
    document.getElementById('save-load-dias')?.addEventListener('click', async () => {
        const dias = parseInt(document.getElementById('config-load-dias').value, 10);
        const result = await saveEmailConfig({ load_dias: String(dias) });
        if (result.status === 'success') {
            showToast('Configuração salva.');
            state.loadDias = dias;
            saveCache('visits', null);
            saveCache('proposals', null);
            saveCache('funil', null);
        } else {
            showToast(result.message || 'Não foi possível salvar.', true);
        }
    });

    document.getElementById('save-visita-multi-tipo')?.addEventListener('click', async () => {
        const ligado = document.getElementById('config-visita-multi-tipo').checked;
        const result = await saveEmailConfig({ visita_multi_tipo: ligado ? 'true' : 'false' });
        if (result.status === 'success') {
            showToast('Configuração salva.');
            if (state.formData) { state.formData.multiTipoVisita = ligado; }
        } else {
            showToast(result.message || 'Não foi possível salvar.', true);
        }
    });

    // Permissões (Gerente/Vendedor): apagar registros, criar Proposta/Funil, acessar Radar, editar Manutenção assinada
    document.getElementById('save-permissoes')?.addEventListener('click', async () => {
        const permitirApagar = document.getElementById('config-permitir-apagar').checked;
        const permitirCriar = document.getElementById('config-permitir-criar').checked;
        const permitirRadar = document.getElementById('config-permitir-radar').checked;
        const permitirEditarManutencao = document.getElementById('config-permitir-editar-manutencao').checked;
        const result = await saveEmailConfig({
            permitir_apagar_outros: permitirApagar ? 'true' : 'false',
            permitir_criar_proposta_funil: permitirCriar ? 'true' : 'false',
            permitir_acesso_radar: permitirRadar ? 'true' : 'false',
            permitir_editar_manutencao_assinada: permitirEditarManutencao ? 'true' : 'false'
        });
        if (result.status === 'success') {
            showToast('Configuração salva.');
            saveCache('dashboard', null);
        } else {
            showToast(result.message || 'Não foi possível salvar.', true);
        }
    });

    // Logo da empresa
    {
        const logoInput = document.getElementById('logo-empresa-input');
        const logoSaveBtn = document.getElementById('save-logo-empresa');
        const logoPreview = document.getElementById('logo-empresa-preview');
        let pendingLogoDataUrl = null;

        logoInput?.addEventListener('change', async () => {
            pendingLogoDataUrl = null;
            if (logoSaveBtn) logoSaveBtn.disabled = true;
            const file = logoInput.files && logoInput.files[0];
            if (!file) return;
            try {
                const dataUrl = await resizeImageToDataUrl(file, 220);
                // Margem sob o limite de 50.000 caracteres da célula do
                // Sheets (data:image/...;base64, + o resto da linha já
                // consome uma parte).
                if (dataUrl.length > 45000) {
                    showToast('Imagem grande demais mesmo redimensionada. Tente um arquivo mais simples (PNG/SVG).', true);
                    logoInput.value = '';
                    return;
                }
                pendingLogoDataUrl = dataUrl;
                if (logoSaveBtn) logoSaveBtn.disabled = false;
                if (logoPreview) logoPreview.innerHTML = `<img src="${dataUrl}" alt="Prévia da logo" style="max-width:100%;max-height:100%;object-fit:contain">`;
            } catch (e) {
                showToast(e.message || 'Não foi possível ler essa imagem.', true);
            }
        });

        logoSaveBtn?.addEventListener('click', async () => {
            if (!pendingLogoDataUrl) return;
            setSaving(true, logoSaveBtn, 'Enviando...');
            const result = await saveEmailConfig({ logo_empresa: pendingLogoDataUrl });
            if (result.status === 'success') {
                showToast('Logo salva.');
                await renderAdminPage();
            } else {
                showToast(result.message || 'Não foi possível salvar a logo.', true);
                setSaving(false, logoSaveBtn);
            }
        });

        document.getElementById('remove-logo-empresa')?.addEventListener('click', async (event) => {
            if (!confirm('Remover a logo da empresa?')) return;
            const btn = event.currentTarget;
            setSaving(true, btn, 'Removendo...');
            const result = await saveEmailConfig({ logo_empresa: '' });
            if (result.status === 'success') {
                showToast('Logo removida.');
                await renderAdminPage();
            } else {
                showToast(result.message || 'Não foi possível remover a logo.', true);
                setSaving(false, btn);
            }
        });
    }

    // Modo Manutenção
    document.getElementById('save-manutencao')?.addEventListener('click', async () => {
        const btn = document.getElementById('save-manutencao');
        setSaving(true, btn, 'Salvando...');
        const result = await saveEmailConfig({
            manutencao_ativa: document.getElementById('manutencao-ativa').checked ? 'true' : 'false',
            manutencao_mensagem: document.getElementById('manutencao-mensagem').value.trim()
        });
        if (result.status === 'success') { showToast('Modo manutenção salvo.'); setSaving(false, btn); }
        else { showToast(result.message || 'Não foi possível salvar.', true); setSaving(false, btn); }
    });

    // Email save buttons
    document.querySelectorAll('[data-save-email]').forEach((button) => {
        button.addEventListener('click', async () => {
            const prefix = button.dataset.saveEmail;
            const config = {};
            config[`${prefix}_ativas`] = document.getElementById(`${prefix}-ativas`).checked ? 'true' : 'false';
            config[`${prefix}_dias`] = document.getElementById(`${prefix}-dias`).value.trim();
            config[`${prefix}_assunto`] = document.getElementById(`${prefix}-assunto`).value.trim();
            config[`${prefix}_corpo`] = document.getElementById(`${prefix}-corpo`).value;
            const result = await saveEmailConfig(config);
            if (result.status === 'success') { showToast('Configuração de e-mail salva.'); }
            else { showToast(result.message || 'Não foi possível salvar.', true); }
        });
    });

    bindImportarTab();
}

// Importação da base antiga (Visitas / Propostas). Fluxo em 2 passos:
// "Analisar" (dryRun no servidor) devolve o resumo + os vendedores do
// arquivo que não bateram com o cadastro; a tela monta um de-para (select
// por nome) e "Confirmar importação" reenvia o mesmo CSV (já no navegador,
// sem novo upload) com o mapa preenchido.
const IMPORT_ENTIDADES = {
    'visitas-ativas': { action: 'importVisitasLegacy', extra: { tipo: 'ativas' }, label: 'visita' },
    'visitas-prospeccao': { action: 'importVisitasLegacy', extra: { tipo: 'prospeccao' }, label: 'visita' },
    'propostas': { action: 'importPropostasLegacy', extra: {}, label: 'proposta' },
    'funil': { action: 'importFunilLegacy', extra: {}, label: 'registro' },
    'clientes': { action: 'importClientesLegacy', extra: {}, label: 'cliente' }
};

function bindImportarTab() {
    const entidadeSel = document.getElementById('import-entidade');
    const fileInput = document.getElementById('import-file');
    const analisarBtn = document.getElementById('import-analisar');
    const resultado = document.getElementById('import-resultado');
    if (!entidadeSel || !fileInput || !analisarBtn || !resultado) return;

    // Guarda o conteúdo do arquivo já no formato que o servidor espera:
    // { csvText } pra CSV, { xlsxBase64 } pra Excel. Assim o "Confirmar"
    // reenvia sem precisar reler o arquivo.
    let fileData = null;
    const cfg = () => IMPORT_ENTIDADES[entidadeSel.value] || IMPORT_ENTIDADES['visitas-ativas'];

    entidadeSel.addEventListener('change', () => { resultado.innerHTML = ''; });

    fileInput.addEventListener('change', () => {
        resultado.innerHTML = '';
        fileData = null;
        analisarBtn.disabled = true;
        const file = fileInput.files && fileInput.files[0];
        if (!file) return;
        // .xls (Excel 97-2003, binário) é outro formato — o leitor só entende
        // .xlsx e .csv. Avisa na hora em vez de deixar "Analisando..." travado.
        if (/\.xls$/i.test(file.name) || /\.(xlsb|xlsm|ods)$/i.test(file.name)) {
            resultado.innerHTML = `<p class="error-message">Formato <strong>${escapeHtml(file.name.split('.').pop().toUpperCase())}</strong> não suportado. No Excel, use <strong>Salvar Como → "Pasta de Trabalho do Excel (*.xlsx)"</strong> ou <strong>"CSV UTF-8"</strong> e envie esse arquivo.</p>`;
            fileInput.value = '';
            return;
        }
        const isXlsx = /\.xlsx$/i.test(file.name) ||
            file.type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
        const reader = new FileReader();
        reader.onload = () => {
            if (isXlsx) {
                fileData = { xlsxBase64: arrayBufferToBase64(reader.result) };
                analisarBtn.disabled = false;
            } else {
                const text = String(reader.result || '');
                fileData = { csvText: text };
                analisarBtn.disabled = !text.trim();
            }
        };
        reader.onerror = () => {
            fileData = null;
            analisarBtn.disabled = true;
            resultado.innerHTML = `<p class="error-message">Não foi possível ler o arquivo.</p>`;
        };
        if (isXlsx) reader.readAsArrayBuffer(file);
        else reader.readAsText(file, 'UTF-8');
    });

    analisarBtn.addEventListener('click', async () => {
        if (!fileData) return;
        const { action, extra } = cfg();
        setSaving(true, analisarBtn, 'Analisando...');
        resultado.innerHTML = '';
        const res = await callAPI(action, { user: state.currentUser, ...extra, ...fileData, dryRun: true });
        setSaving(false, analisarBtn);
        if (res.status !== 'success') {
            resultado.innerHTML = `<p class="error-message">${escapeHtml(res.message || 'Erro ao analisar o arquivo.')}</p>`;
            return;
        }
        renderImportAnalise(res);
    });

    function renderImportAnalise(res) {
        const label = cfg().label;
        const r = res.resumo || {};
        const naoRec = res.vendedoresNaoReconhecidos || [];
        const semVend = res.clientesSemVendedor || [];
        const optionsHtml = [
            '<option value="__IGNORAR__">— deixar sem vendedor —</option>',
            '<option value="__DESCARTAR__">— desconsiderar (não importar) —</option>'
        ]
            .concat((res.vendedoresApp || []).map((n) => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`))
            .join('');

        const cm = res.colunasMapeadas || {};
        const cmRows = Object.keys(cm).map((k) => `
            <tr>
                <td style="padding:0.15rem 0.6rem 0.15rem 0;color:var(--text-muted-strong)">${escapeHtml(k)}</td>
                <td style="padding:0.15rem 0">${cm[k]
                    ? escapeHtml(cm[k])
                    : '<span style="color:var(--danger)">não encontrada</span>'}</td>
            </tr>`).join('');

        resultado.innerHTML = `
            <div class="card" style="padding:0.9rem;margin-top:0.85rem;background:var(--bg)">
                <p style="margin:0 0 0.3rem"><strong>${r.novas || 0}</strong> ${label}(s) novo(s)</p>
                ${r.atualizadas ? `<p style="margin:0 0 0.3rem"><strong>${r.atualizadas}</strong> ${label}(s) a atualizar</p>` : ''}
                ${r.puladas ? `<p style="margin:0 0 0.3rem"><strong>${r.puladas}</strong> já existente(s) — serão puladas</p>` : ''}
                ${r.descartadas ? `<p style="margin:0 0 0.3rem"><strong>${r.descartadas}</strong> linha(s) desconsiderada(s) na sua escolha de vendedor</p>` : ''}
                <p style="margin:0">${r.ignoradas || 0} linha(s) sem identificação — ignoradas</p>
            </div>
            ${cmRows ? `
                <div class="card" style="padding:0.9rem;margin-top:0.75rem">
                    <p class="helper-text" style="text-align:left;margin:0 0 0.5rem">Colunas reconhecidas no arquivo:</p>
                    <table style="font-size:0.82rem;border-collapse:collapse"><tbody>${cmRows}</tbody></table>
                    <p class="helper-text" style="text-align:left;margin:0.5rem 0 0">
                        Alguma "não encontrada" que deveria existir? Me passa o nome exato dessa coluna no seu arquivo.
                    </p>
                </div>
            ` : ''}
            ${naoRec.length ? `
                <div class="card" style="padding:0.9rem;margin-top:0.75rem">
                    <p class="helper-text" style="text-align:left;margin:0 0 0.7rem">
                        ${naoRec.length} vendedor(es) do arquivo não bateram com o cadastro. Diga quem é cada um
                        (fica salvo pro próximo import):
                    </p>
                    <div class="import-vend-map">
                        ${naoRec.map((v) => `
                            <div class="import-vend-row">
                                <span class="import-vend-name">${escapeHtml(v.nome)}<em>${v.linhas} linha(s)</em></span>
                                <select data-de="${escapeHtml(v.nome)}">${optionsHtml}</select>
                            </div>
                        `).join('')}
                    </div>
                </div>
            ` : ''}
            ${semVend.length ? `
                <div class="card" style="padding:0.9rem;margin-top:0.75rem">
                    <p class="helper-text" style="text-align:left;margin:0 0 0.7rem">
                        ${semVend.length} cliente(s) sem vendedor no arquivo. Escolha o vendedor de cada um
                        (as linhas herdam a gerência desse vendedor):
                    </p>
                    <div class="import-vend-map">
                        ${semVend.map((c) => `
                            <div class="import-vend-row">
                                <span class="import-vend-name">${escapeHtml(c.cliente)}<em>${c.linhas} linha(s)</em></span>
                                <select data-cli="${escapeHtml(c.cliente)}">${optionsHtml}</select>
                            </div>
                        `).join('')}
                    </div>
                </div>
            ` : ''}
            <button type="button" id="import-confirmar" class="primary-button" style="margin-top:0.85rem">
                Confirmar importação
            </button>
        `;
        document.getElementById('import-confirmar').addEventListener('click', confirmarImport);
    }

    async function confirmarImport() {
        const btn = document.getElementById('import-confirmar');
        const { action, extra, label } = cfg();
        const vendedorMap = {};
        const clienteVendedorMap = {};
        resultado.querySelectorAll('.import-vend-row select').forEach((sel) => {
            if (sel.dataset.de !== undefined) vendedorMap[sel.dataset.de] = sel.value;
            if (sel.dataset.cli !== undefined) clienteVendedorMap[sel.dataset.cli] = sel.value;
        });
        setSaving(true, btn, 'Importando...');
        const res = await callAPI(action, { user: state.currentUser, ...extra, ...fileData, dryRun: false, vendedorMap, clienteVendedorMap });
        setSaving(false, btn);
        if (res.status !== 'success') {
            resultado.insertAdjacentHTML('beforeend', `<p class="error-message">${escapeHtml(res.message || 'Erro ao importar.')}</p>`);
            return;
        }
        const r = res.resumo || {};
        resultado.innerHTML = `
            <div class="card" style="padding:0.9rem;margin-top:0.85rem;background:var(--bg)">
                <p style="margin:0 0 0.3rem">✅ <strong>${r.novas || 0}</strong> ${label}(s) novo(s)${r.atualizadas ? ` · <strong>${r.atualizadas}</strong> atualizado(s)` : ''}</p>
                <p style="margin:0">${r.puladas || 0} pulada(s) · ${r.descartadas || 0} desconsiderada(s) · ${r.ignoradas || 0} ignorada(s)</p>
            </div>
        `;
        showToast('Importação concluída.');
        fileInput.value = '';
        fileData = null;
        analisarBtn.disabled = true;
    }
}

// ArrayBuffer → base64, em blocos pra não estourar a pilha com
// String.fromCharCode em arquivo grande.
function arrayBufferToBase64(ab) {
    const bytes = new Uint8Array(ab);
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
}


export async function getAdminData() {
    try {
        return await callAPI('getAdminData', { user: state.currentUser });
    } catch (error) {
        return { status: 'error', message: error.message };
    }
}


export async function saveUser(payload) {
    try {
        return await callAPI('saveUser', { ...payload, user: state.currentUser });
    } catch (error) {
        return { status: 'error', message: error.message };
    }
}


export async function saveLookupList(payload) {
    try {
        state.formData = null;
        const result = await callAPI('saveLookupList', { ...payload, user: state.currentUser });
        if (result && result.status === 'success') {
            const _email = (state.currentUser && state.currentUser.email) || '';
            try { localStorage.removeItem('apv_fd3_' + _email); } catch(e) {}
            try { localStorage.removeItem('apv_fdv_' + _email); } catch(e) {}
        }
        return result;
    } catch (error) {
        return { status: 'error', message: error.message };
    }
}


export async function getEmailConfig() {
    try {
        return await callAPI('getEmailConfig', { user: state.currentUser });
    } catch (error) {
        return { status: 'error', message: error.message };
    }
}


export async function saveEmailConfig(config) {
    try {
        return await callAPI('saveEmailConfig', { config, user: state.currentUser });
    } catch (error) {
        return { status: 'error', message: error.message };
    }
}


export function renderLookupEditor(title, key, values = []) {
    return `
        <div class="lookup-editor">
            <label for="lookup-${key}">${escapeHtml(title)}</label>
            <textarea id="lookup-${key}" rows="6">${escapeHtml((values || []).join('\n'))}</textarea>
            <button type="button" class="secondary-button" data-lookup-key="${key}">Salvar lista</button>
        </div>
    `;
}
