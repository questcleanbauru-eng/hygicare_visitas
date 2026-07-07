import { state } from '../app.js';
import { callAPI, saveCache, loadCache } from '../api.js';
import { escapeHtml, titleCase, getInitials, profileClass } from '../utils/format.js';
import { showToast, loadingState, renderSimpleOptions, showRefreshIndicator, hideRefreshIndicator } from '../utils/dom.js';
import { ensureStyles } from '../utils/ui.js';

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
    function emailPanel(prefix, label, subtitle, vars, config) {
        const isActive = config[`${prefix}_ativas`] === 'true';
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
                    <label for="${prefix}-dias" style="font-size:0.8rem;color:var(--text-muted-strong)">Dias sem atualização</label>
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

        <div class="admin-stats-row">
            <div class="admin-stat">
                <div class="admin-stat-icon ast-blue">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
                </div>
                <div class="admin-stat-body">
                    <strong class="admin-stat-num">${data.users.length}</strong>
                    <span class="admin-stat-lbl">Usuários</span>
                </div>
            </div>
            <div class="admin-stat">
                <div class="admin-stat-icon ast-green">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                </div>
                <div class="admin-stat-body">
                    <strong class="admin-stat-num">${data.notifications.length}</strong>
                    <span class="admin-stat-lbl">WhatsApp</span>
                </div>
            </div>
            <div class="admin-stat">
                <div class="admin-stat-icon ast-purple">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
                </div>
                <div class="admin-stat-body">
                    <strong class="admin-stat-num">${Object.keys(data.lookups).length}</strong>
                    <span class="admin-stat-lbl">Listas</span>
                </div>
            </div>
        </div>

        <div class="admin-tabs-bar">
            <button type="button" class="admin-tab active" data-tab="users">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>
                Usuários
            </button>
            <button type="button" class="admin-tab" data-tab="whatsapp">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                WhatsApp
            </button>
            <button type="button" class="admin-tab" data-tab="listas">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
                Listas
            </button>
            <button type="button" class="admin-tab" data-tab="email">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,12 2,6"/></svg>
                E-mail
            </button>
        </div>

        <!-- Tab: Usuários -->
        <div class="admin-tab-panel active card" id="admin-tab-users" style="padding:1rem">
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
                            return `<tr>
                                <td data-label=""><div class="user-avatar-cell">
                                    <div class="user-avatar-initials ${pc}">${escapeHtml(getInitials(nome))}</div>
                                    <span>${escapeHtml(titleCase(nome))}</span>
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

        <!-- Tab: WhatsApp -->
        <div class="admin-tab-panel card" id="admin-tab-whatsapp" style="padding:1rem">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.85rem">
                <span style="font-size:0.82rem;color:var(--text-muted-strong)">${data.notifications.length} fluxo(s)</span>
                <button type="button" class="btn-add" id="btn-new-notif" style="padding:0.4rem 0.85rem;font-size:0.82rem">+ Novo Fluxo</button>
            </div>
            <div class="admin-notif-table-wrap">
                <table class="admin-notif-table">
                    <thead><tr>
                        <th>Nome do Fluxo</th>
                        <th>Obrigatório</th>
                    </tr></thead>
                    <tbody>
                        ${data.notifications.map((item, index) => `
                        <tr class="admin-notif-row" data-notification-index="${index}">
                            <td>${escapeHtml(titleCase(item.tipo || '-'))}</td>
                            <td>
                                <label class="toggle-switch" onclick="event.stopPropagation()">
                                    <input type="checkbox" ${item.obrigatorio ? 'checked' : ''} data-notif-toggle="${index}">
                                    <span class="toggle-slider"></span>
                                </label>
                            </td>
                        </tr>`).join('')}
                    </tbody>
                </table>
            </div>
        </div>

        <!-- Tab: Listas de Apoio -->
        <div class="admin-tab-panel card" id="admin-tab-listas" style="padding:1rem">
            <div class="lookup-grid">
                ${renderLookupEditor('Cidades', 'cidades', data.lookups.cidades)}
                ${renderLookupEditor('Areas de Atuacao', 'areasAtuacao', data.lookups.areasAtuacao)}
                ${renderLookupEditor('Potenciais Cliente', 'potenciaisCliente', data.lookups.potenciaisCliente)}
                ${renderLookupEditor('Aplicacoes', 'aplicacoes', data.lookups.aplicacoes || [])}
                ${renderLookupEditor('Equipamentos', 'equipamentos', data.lookups.equipamentos || [])}
            </div>
        </div>

        <!-- Tab: E-mail -->
        <div class="admin-tab-panel" id="admin-tab-email">
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
                <div class="section-title-row"><h3 class="section-title">Permissões</h3></div>
                <div class="card" style="padding:1rem;display:flex;flex-direction:column;gap:0.85rem">
                    <label style="display:flex;align-items:center;gap:0.6rem;font-size:0.87rem;font-weight:500;cursor:pointer">
                        <input type="checkbox" id="config-permitir-apagar" style="width:auto;accent-color:var(--primary)" ${emailConfig.permitir_apagar_outros === 'true' ? 'checked' : ''}>
                        Permitir que Gerentes e Vendedores apaguem visitas, propostas e funil
                    </label>
                    <label style="display:flex;align-items:center;gap:0.6rem;font-size:0.87rem;font-weight:500;cursor:pointer">
                        <input type="checkbox" id="config-permitir-criar" style="width:auto;accent-color:var(--primary)" ${emailConfig.permitir_criar_proposta_funil === 'true' ? 'checked' : ''}>
                        Permitir que Gerentes e Vendedores criem novas Propostas e Funil
                    </label>
                    <p class="helper-text" style="text-align:left;margin:0">Admin sempre pode criar/apagar. Nova Visita continua liberada pra todos. Isso só afeta a criação de Proposta e Funil.</p>
                    <button type="button" id="save-permissoes" class="primary-button" style="align-self:flex-start">Salvar</button>
                </div>
            </div>
            <div class="email-warning-card">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#F59E0B" stroke-width="2" stroke-linecap="round" style="flex-shrink:0;margin-top:1px"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                <span>Esta funcionalidade requer um trigger diário configurado no Google Apps Script.</span>
            </div>
            <div class="email-notif-grid">
                ${emailPanel('propostas', 'Propostas sem atualização', 'Avisa vendedores com propostas paradas há X dias', ['nome', 'quantidade', 'dias'], emailConfig)}
                ${emailPanel('visitas', 'Relatório de visitas pendente', 'Avisa vendedores sem visitas registradas em X dias', ['nome', 'dias'], emailConfig)}
                ${emailPanel('funil', 'Funil sem atualização', 'Avisa vendedores com oportunidades ativas paradas há X dias', ['nome', 'quantidade', 'dias'], emailConfig)}
            </div>
        </div>

        <!-- Drawer overlay + drawer -->
        <div class="admin-drawer-overlay" id="admin-drawer-overlay"></div>
        <div class="admin-drawer" id="admin-drawer">
            <div class="admin-drawer-header">
                <h3 id="admin-drawer-title"></h3>
                <button type="button" class="admin-drawer-close" id="admin-drawer-close" aria-label="Fechar">✕</button>
            </div>
            <div class="admin-drawer-body" id="admin-drawer-body"></div>
            <div class="admin-drawer-footer" id="admin-drawer-footer"></div>
        </div>
    `;

    bindAdminEvents(data);
}


export function bindAdminEvents(data) {
    // Tabs
    document.querySelectorAll('.admin-tab').forEach((tab) => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.admin-tab').forEach((t) => t.classList.remove('active'));
            document.querySelectorAll('.admin-tab-panel').forEach((p) => p.classList.remove('active'));
            tab.classList.add('active');
            const panel = document.getElementById(`admin-tab-${tab.dataset.tab}`);
            if (panel) { panel.classList.add('active'); }
        });
    });

    // Drawer helpers
    const overlay = document.getElementById('admin-drawer-overlay');
    const drawer = document.getElementById('admin-drawer');
    const drawerTitle = document.getElementById('admin-drawer-title');
    const drawerBody = document.getElementById('admin-drawer-body');
    const drawerFooter = document.getElementById('admin-drawer-footer');

    const openDrawer = (title, bodyHtml, footerHtml) => {
        drawerTitle.textContent = title;
        drawerBody.innerHTML = bodyHtml;
        drawerFooter.innerHTML = footerHtml;
        overlay.classList.add('open');
        drawer.classList.add('open');
    };

    const closeDrawer = () => {
        overlay.classList.remove('open');
        drawer.classList.remove('open');
    };

    document.getElementById('admin-drawer-close').addEventListener('click', closeDrawer);
    overlay.addEventListener('click', closeDrawer);

    document.getElementById('btn-new-user').addEventListener('click', () => {
        if (document.getElementById('uif-new-row')) {
            document.getElementById('uif-new-row').querySelector('.uif-nome').focus();
            return;
        }
        const tbody = document.querySelector('.admin-user-table tbody');
        const tr = document.createElement('tr');
        tr.id = 'uif-new-row';
        tr.innerHTML = `<td colspan="5" class="uif-cell uif-cell-new">
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
            </div>
            <div class="uif-actions">
                <button type="button" class="uif-cancel">Cancelar</button>
                <button type="button" class="uif-save">Criar Usuário</button>
            </div>
        </td>`;
        tbody.appendChild(tr);
        tr.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        tr.querySelector('.uif-nome').focus();

        tr.querySelector('.uif-cancel').addEventListener('click', () => tr.remove());
        tr.querySelector('.uif-save').addEventListener('click', async () => {
            const senha = tr.querySelector('.uif-senha').value.trim();
            if (!senha) { showToast('Informe a senha para o novo usuário.', true); return; }
            const saveBtn = tr.querySelector('.uif-save');
            saveBtn.disabled = true;
            saveBtn.textContent = 'Criando...';
            const result = await saveUser({
                originalEmail: '',
                emailLogin: tr.querySelector('.uif-email').value.trim(),
                nomeVendedor: tr.querySelector('.uif-nome').value.trim(),
                senha,
                gerencia: tr.querySelector('.uif-gerencia').value.trim(),
                perfil: tr.querySelector('.uif-perfil').value
            });
            if (result.status === 'success') {
                showToast('Usuário criado.');
                renderAdminPage();
            } else {
                showToast(result.message || 'Não foi possível criar.', true);
                saveBtn.disabled = false;
                saveBtn.textContent = 'Criar Usuário';
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
                </div>
                <div class="uif-actions">
                    <button type="button" class="uif-cancel">Cancelar</button>
                    <button type="button" class="uif-save">Salvar</button>
                </div>
            </td>`;

            row.querySelector('.uif-cancel').addEventListener('click', () => renderAdminPage());
            row.querySelector('.uif-save').addEventListener('click', async () => {
                const saveBtn = row.querySelector('.uif-save');
                saveBtn.disabled = true;
                saveBtn.textContent = 'Salvando...';
                const result = await saveUser({
                    originalEmail: email,
                    emailLogin: row.querySelector('.uif-email').value.trim(),
                    nomeVendedor: row.querySelector('.uif-nome').value.trim(),
                    senha: row.querySelector('.uif-senha').value.trim(),
                    gerencia: row.querySelector('.uif-gerencia').value.trim(),
                    perfil: row.querySelector('.uif-perfil').value
                });
                if (result.status === 'success') {
                    showToast('Usuário salvo.');
                    renderAdminPage();
                } else {
                    showToast(result.message || 'Não foi possível salvar.', true);
                    saveBtn.disabled = false;
                    saveBtn.textContent = 'Salvar';
                }
            });
        });
    });

    document.querySelectorAll('.email-copy-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            navigator.clipboard?.writeText(btn.dataset.email).then(() => showToast('E-mail copiado.'));
        });
    });

    // Notification drawer
    const notifDrawerBody = (item) => `
        <input type="hidden" id="notification-original-tipo" value="${escapeHtml(item ? (item.tipo || '') : '')}">
        <div class="form-group">
            <label for="notification-type">Tipo da Visita</label>
            <input type="text" id="notification-type" value="${escapeHtml(item ? (item.tipo || '') : '')}" placeholder="Ex: Preventiva" required>
        </div>
        <div class="form-group">
            <label for="notification-message">Mensagem padrão</label>
            <p class="helper-text" style="margin:0.2rem 0 0.4rem;font-size:0.78rem">Variáveis: {{cliente}}, {{tipoVisita}}, {{observacao}}, {{vendedor}}, {{cidade}}, {{data}}</p>
            <textarea id="notification-message" rows="4" required>${escapeHtml(item ? (item.mensagemPadrao || '') : '')}</textarea>
        </div>
        <label style="display:flex;align-items:center;gap:0.6rem;font-size:0.87rem;font-weight:500;cursor:pointer;margin-top:0.25rem">
            <input type="checkbox" id="notification-obrigatorio" style="width:auto;accent-color:var(--primary)" ${item && item.obrigatorio ? 'checked' : ''}>
            Compartilhamento obrigatório
        </label>
    `;

    const openNotifDrawer = (item) => {
        openDrawer(
            item ? `Editar — ${titleCase(item.tipo || '')}` : 'Novo Fluxo',
            notifDrawerBody(item),
            `<button type="button" class="secondary-button" id="drawer-cancel-notif">Cancelar</button>
             <button type="button" id="drawer-save-notif" style="flex:1">Salvar</button>`
        );
        document.getElementById('drawer-cancel-notif').addEventListener('click', closeDrawer);
        document.getElementById('drawer-save-notif').addEventListener('click', async () => {
            const btn = document.getElementById('drawer-save-notif');
            btn.disabled = true; btn.textContent = 'Salvando...';
            const result = await saveNotificationConfig({
                originalTipo: document.getElementById('notification-original-tipo').value.trim(),
                tipo: document.getElementById('notification-type').value.trim(),
                mensagemPadrao: document.getElementById('notification-message').value.trim(),
                obrigatorio: document.getElementById('notification-obrigatorio').checked
            });
            if (result.status === 'success') { showToast('Configuração salva.'); closeDrawer(); await renderAdminPage(); }
            else { showToast(result.message || 'Não foi possível salvar.', true); btn.disabled = false; btn.textContent = 'Salvar'; }
        });
    };

    document.getElementById('btn-new-notif').addEventListener('click', () => openNotifDrawer(null));

    document.querySelectorAll('.admin-notif-row').forEach((row) => {
        row.addEventListener('click', (e) => {
            if (e.target.closest('[data-notif-toggle]') || e.target.type === 'checkbox') { return; }
            const item = state.adminData.notifications[Number(row.dataset.notificationIndex)];
            openNotifDrawer(item);
        });
    });

    // Notif toggle (obrigatorio quick-toggle)
    document.querySelectorAll('[data-notif-toggle]').forEach((chk) => {
        chk.addEventListener('change', async () => {
            const index = Number(chk.dataset.notifToggle);
            const item = state.adminData.notifications[index];
            await saveNotificationConfig({
                originalTipo: item.tipo || '',
                tipo: item.tipo || '',
                mensagemPadrao: item.mensagemPadrao || '',
                obrigatorio: chk.checked
            });
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

    // Permissões (Gerente/Vendedor): apagar registros e criar Proposta/Funil
    document.getElementById('save-permissoes')?.addEventListener('click', async () => {
        const permitirApagar = document.getElementById('config-permitir-apagar').checked;
        const permitirCriar = document.getElementById('config-permitir-criar').checked;
        const result = await saveEmailConfig({
            permitir_apagar_outros: permitirApagar ? 'true' : 'false',
            permitir_criar_proposta_funil: permitirCriar ? 'true' : 'false'
        });
        if (result.status === 'success') {
            showToast('Configuração salva.');
            saveCache('dashboard', null);
        } else {
            showToast(result.message || 'Não foi possível salvar.', true);
        }
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


export async function saveNotificationConfig(payload) {
    try {
        const result = await callAPI('saveNotificationConfig', { ...payload, user: state.currentUser });
        if (result && result.status === 'success') {
            state.formData = null;
            const _email = (state.currentUser && state.currentUser.email) || '';
            try { localStorage.removeItem('apv_fd3_' + _email); } catch(e) {}
            try { localStorage.removeItem('apv_fdv_' + _email); } catch(e) {}
        }
        return result;
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
