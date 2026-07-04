import { state } from './app.js';
import { renderLoginPage } from './pages/auth.js';
import { resetNavCache } from './utils/ui.js';
import { showLoginNotification, showRefreshIndicator, hideRefreshIndicator } from './utils/dom.js';
import { normalizeVisit, normalizeProposal } from './utils/format.js';
import { fillDashboard } from './pages/dashboard.js';

export const STORAGE_KEY = 'app-visitas-current-user';

export const API_URL = 'https://script.google.com/macros/s/AKfycbzVDjI_l0qQG7GmUSat1_LJUhSK2nnYli96Groh3b1AdCIlpIL4Hpiga_Foo--IkPf-Kw/exec';

// ── Cache (stale-while-revalidate) ──────────────────────────────

export function _ck(name) { return 'apv_v2_' + name + '_' + (state && state.currentUser ? state.currentUser.email : ''); }

export function saveCache(name, data) { try { localStorage.setItem(_ck(name), JSON.stringify({ ts: Date.now(), d: data })); } catch (e) {} }

export function loadCache(name) { try { const r = localStorage.getItem(_ck(name)); return r ? JSON.parse(r).d : null; } catch (e) { return null; } }

export function clearUserCache() {
    if (!state || !state.currentUser) { return; }
    ['dashboard', 'visits', 'visits_all', 'proposals', 'proposals_all', 'funil', 'funil_all'].forEach(function(n) {
        try { localStorage.removeItem(_ck(n)); } catch (e) {}
        try { localStorage.removeItem(_ck('synct_' + n)); } catch (e) {}
    });
}

// ── Incremental sync (since/serverNow, "modelo AppSheet") ────────────────
// Só usa o timestamp se ele tiver menos de 24h — evita acumular itens
// desatualizados que saíram da janela de "dias" e nunca são removidos por
// um delta (o servidor só informa o que mudou, não o que saiu do filtro).
const SYNC_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function getSyncTimestamp(key) {
    try {
        const raw = localStorage.getItem(_ck('synct_' + key));
        if (!raw) return 0;
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed.ts !== 'number' || typeof parsed.at !== 'number') return 0;
        if (Date.now() - parsed.at > SYNC_MAX_AGE_MS) return 0;
        return parsed.ts;
    } catch (e) { return 0; }
}

export function setSyncTimestamp(key, ts) {
    try { localStorage.setItem(_ck('synct_' + key), JSON.stringify({ ts, at: Date.now() })); } catch (e) {}
}

export function mergeById(existing, incoming, idKey) {
    if (!incoming || incoming.length === 0) return existing || [];
    const map = new Map((existing || []).map((item) => [String(item[idKey]), item]));
    incoming.forEach((item) => map.set(String(item[idKey]), item));
    return Array.from(map.values());
}


export function warmListCaches() {
    if (!state.currentUser) return;
    const prevLoginAt = state._prevLoginAt ? new Date(state._prevLoginAt) : null;
    state._prevLoginAt = null;

    const promises = [
        import('./pages/visits.js').then((m) => m.getVisits()).catch(() => {}),
        import('./pages/proposals.js').then((m) => m.getProposals()).catch(() => {}),
        import('./pages/funil.js').then((m) => m.getFunil()).catch(() => {})
    ];

    if (prevLoginAt) {
        Promise.all(promises).then(() => {
            if (state.currentPage === 'dashboard') { showLoginNotification(prevLoginAt); }
        }).catch(() => {});
    }
}


export const _inflight = new Map();

export const _READ_ACTIONS = new Set(['getVisits','getProposals','getFunil','getDashboardData','getConfigVersion','getFormData','getAdminData','getEmailConfig']);


export async function callAPI(action, payload = {}) {
    if (_READ_ACTIONS.has(action)) {
        const key = action + '|' + (payload.dias ?? '') + '|' + ((payload.user && payload.user.email) || '');
        if (_inflight.has(key)) return _inflight.get(key);
        const p = _callAPIRaw(action, payload).finally(() => _inflight.delete(key));
        _inflight.set(key, p);
        return p;
    }
    return _callAPIRaw(action, payload);
}


export async function _callAPIRaw(action, payload = {}) {
    const response = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action, payload })
    });

    const data = await response.json();
    if (!response.ok) {
        throw new Error(data.message || 'Erro na comunicacao com a API.');
    }
    return data;
}


export async function ensureFormData() {
    // 1. Em memória → instantâneo
    if (state.formData) {
        return { status: 'success', data: state.formData };
    }

    var email = state.currentUser && state.currentUser.email ? state.currentUser.email : '';
    var storageKey = 'apv_fd3_' + email;
    var versionKey = 'apv_fdv_' + email;

    // 2. Carregar do localStorage
    var localData = null;
    var localVersion = null;
    try {
        var raw = localStorage.getItem(storageKey);
        if (raw) localData = JSON.parse(raw);
        localVersion = localStorage.getItem(versionKey);
    } catch(e) {}

    // 3. Tem dados locais → usar IMEDIATAMENTE, verificar versão em background
    if (localData) {
        state.formData = normalizeFormData(localData);
        _verifyFormDataVersionBackground(storageKey, versionKey, localVersion);
        return { status: 'success', data: state.formData };
    }

    // 4. Sem localStorage → primeira vez, buscar do servidor
    return await _fetchAndSaveFormData(storageKey, versionKey, '0');
}


export async function _verifyFormDataVersionBackground(storageKey, versionKey, localVersion) {
    try {
        var vRes = await callAPI('getConfigVersion', { user: state.currentUser });
        var serverVersion = (vRes && vRes.version) ? vRes.version : '0';
        if (localVersion !== serverVersion) {
            await _fetchAndSaveFormData(storageKey, versionKey, serverVersion);
        }
    } catch(e) {}
}


export async function _fetchAndSaveFormData(storageKey, versionKey, serverVersion) {
    try {
        var result = await callAPI('getFormData', { user: state.currentUser });
        if (result.status === 'success') {
            state.formData = normalizeFormData(result.data || {});
            try {
                localStorage.setItem(storageKey, JSON.stringify(result.data || {}));
                if (serverVersion !== '0') { localStorage.setItem(versionKey, serverVersion); }
            } catch(e) {}
        }
        return { status: result.status, data: state.formData, message: result.message };
    } catch(error) {
        return { status: 'error', message: error.message };
    }
}


export async function getDashboardData() {
    const cached = loadCache('dashboard');
    const fresh = callAPI('getDashboardData', { user: state.currentUser })
        .then(function(r) {
            if (r.status === 'success') { saveCache('dashboard', r.data); state.dashboardData = r.data; }
            return r;
        })
        .catch(function(e) { return { status: 'error', message: e.message }; });
    if (cached) {
        state.dashboardData = cached;
        showRefreshIndicator();
        fresh.then(function(r) {
            hideRefreshIndicator();
            if (r.status === 'success' && state.currentPage === 'dashboard') { fillDashboard(document.getElementById('main-content'), r.data, state.currentUser); }
        });
        return { status: 'success', data: cached };
    }
    return fresh;
}


export function buildLocalDashboardData() {
    const recentVisits = (state.visits || []).slice(0, 3).map(normalizeVisit);
    const recentProposals = (state.proposals || []).map(normalizeProposal).filter((p) => p.atrasada).slice(0, 5);
    return {
        weeklyVisits: recentVisits.length,
        openProposals: recentProposals.length,
        overdueProposals: recentProposals.filter((item) => item.atrasada).length,
        recentVisits,
        recentProposals,
        teamWeeklyVisits: recentVisits.length
    };
}


export function normalizeFormData(data) {
    const tiposVisita = Array.isArray(data.tiposVisita)
        ? data.tiposVisita.map((item) => {
            if (typeof item === 'string') {
                return { tipo: item, telefoneDestino: '', mensagemPadrao: '' };
            }
            return {
                tipo: item.tipo || item.Tipo || '',
                telefoneDestino: item.telefoneDestino || item.TelefoneDestino || '',
                mensagemPadrao: item.mensagemPadrao || item.MensagemPadrao || '',
                obrigatorio: !!(item.obrigatorio || item.Obrigatorio)
            };
        })
        : [];

    const clientes = Array.isArray(data.clientes)
        ? data.clientes.map((client, index) => ({
            id: String(client.id || client.ID_Cliente || index + 1),
            nome: client.nome || client['Nome do Cliente'] || '',
            contato: client.contato || client['Contato Padrão'] || client.Contato || '',
            telefone: client.telefone || client.Telefone || '',
            cidade: client.cidade || client.Cidade || '',
            areaAtuacao: client.areaAtuacao || client['Área de Atuação'] || client.AreaAtuacao || '',
            potencialCliente: client.potencialCliente || client['Potencial do Cliente'] || '',
            email: client.email || client['E-mail'] || '',
            vendedores: client.vendedores || client.Vendedores || '',
            gerencia: client.gerencia || client.Gerencia || client['Gerência'] || ''
        }))
        : [];

    return {
        cidades: data.cidades || [],
        areasAtuacao: data.areasAtuacao || [],
        potenciaisCliente: data.potenciaisCliente || [],
        aplicacoes: data.aplicacoes || [],
        equipamentos: data.equipamentos || [],
        tiposVisita,
        clientes,
        veiculos: data.veiculos || ['Particular', 'Empresa']
    };
}


export function logout() {
    resetNavCache();
    clearUserCache();
    if (state.currentUser && state.currentUser.email) {
        try { localStorage.removeItem('apv_fd3_' + state.currentUser.email); } catch(e) {}
        try { localStorage.removeItem('apv_fdv_' + state.currentUser.email); } catch(e) {}
    }
    state.currentUser = null;
    state.formData = null;
    state.currentPage = 'login';
    localStorage.removeItem(STORAGE_KEY);
    renderLoginPage();
}


export function persistUser(user) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(user));
}


export function loadStoredUser() {
    try {
        return JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    } catch (error) {
        return null;
    }
}
