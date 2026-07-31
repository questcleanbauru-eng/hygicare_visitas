import { state } from './app.js';
import { renderLoginPage } from './pages/auth.js';
import { resetNavCache, renderNavigation } from './utils/ui.js';
import { showLoginNotification, showRefreshIndicator, hideRefreshIndicator, showToast, updatePendingSyncBanner } from './utils/dom.js';
import { normalizeVisit, normalizeProposal } from './utils/format.js';
import { fillDashboard } from './pages/dashboard.js';
import { enqueueWrite, getQueuedItems, removeQueuedItem, getQueueCount } from './utils/offlineQueue.js';

export const STORAGE_KEY = 'app-visitas-current-user';

// Vercel serverless function (mesma origem, sem o redirecionamento do Apps
// Script) — substitui a antiga URL do Google Apps Script.
export const API_URL = '/api/backend';

// ── Cache (stale-while-revalidate) ──────────────────────────────

export function _ck(name) { return 'apv_v2_' + name + '_' + (state && state.currentUser ? state.currentUser.email : ''); }

export function saveCache(name, data) { try { localStorage.setItem(_ck(name), JSON.stringify({ ts: Date.now(), d: data })); } catch (e) {} }

export function loadCache(name) { try { const r = localStorage.getItem(_ck(name)); return r ? JSON.parse(r).d : null; } catch (e) { return null; } }

export function clearUserCache() {
    if (!state || !state.currentUser) { return; }
    ['dashboard', 'visits', 'visits_all', 'proposals', 'proposals_all', 'funil', 'funil_all', 'admin_data', 'admin_email'].forEach(function(n) {
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

export const _READ_ACTIONS = new Set(['getVisits','getProposals','getFunil','getDashboardData','getConfigVersion','getFormData','getAdminData','getEmailConfig','getContratos','getAgendamentos']);


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


// Sem isso, uma requisição travada (backend/rede) nunca resolvia nem
// rejeitava — fetch não tem timeout próprio, então ficava pendurada
// indefinidamente. Uma tela sem try/catch em volta do callAPI (visto na
// prática: abas de relatório do Radar) ficava presa em "Carregando..."
// pra sempre, sem nunca chegar no erro. 30s dá folga pra operação legítima
// mais pesada do app (import de CSV grande) sem deixar travar pra sempre.
const API_TIMEOUT_MS = 30000;

export async function _callAPIRaw(action, payload = {}) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
    let response;
    try {
        response = await fetch(API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify({ action, payload }),
            signal: controller.signal
        });
    } catch (e) {
        if (e.name === 'AbortError') throw new Error('A operação demorou demais e foi cancelada. Tente novamente.');
        throw e;
    } finally {
        clearTimeout(timeoutId);
    }

    const data = await response.json();
    if (!response.ok) {
        throw new Error(data.message || 'Erro na comunicacao com a API.');
    }
    return data;
}


// ── Fila offline de escrita ──────────────────────────────────────
// Se a chamada falha por falta de conexao (offline ou fetch rejeitado), o
// registro entra numa fila local (IndexedDB) em vez de ser descartado, e e
// reenviado automaticamente quando a conexao volta. Erros de negocio (ex.:
// validacao) NAO entram na fila — so falha de rede/conectividade.
export async function attemptOrQueue(action, payload, meta) {
    // Ações de criação levam uma idempotencyKey (derivada do tempId
    // otimista, já único por tentativa) — se a escrita for bem-sucedida no
    // servidor mas a resposta se perder (timeout, cold start), a retentativa
    // da fila reenvia a MESMA chave, permitindo ao servidor detectar que já
    // foi processada em vez de duplicar a linha.
    const finalPayload = (action.startsWith('create') && !payload.idempotencyKey && meta && meta.tempId)
        ? { ...payload, idempotencyKey: String(meta.tempId) }
        : payload;
    if (!navigator.onLine) {
        await enqueueWrite(action, finalPayload, meta);
        refreshPendingSyncBanner();
        return { status: 'queued' };
    }
    try {
        return await callAPI(action, finalPayload);
    } catch (error) {
        await enqueueWrite(action, finalPayload, meta);
        refreshPendingSyncBanner();
        return { status: 'queued' };
    }
}


let _flushing = false;

export async function flushOfflineQueue() {
    if (_flushing || !navigator.onLine) return;
    _flushing = true;
    try {
        const items = await getQueuedItems();
        let synced = 0;
        for (const item of items) {
            let result;
            // Marca explicitamente como retentativa — só nesse caso o servidor
            // paga o custo extra de checar duplicata pela idempotencyKey.
            const retryPayload = item.payload && item.payload.idempotencyKey
                ? { ...item.payload, _queueRetry: true }
                : item.payload;
            try {
                result = await _callAPIRaw(item.action, retryPayload);
            } catch (error) {
                break; // ainda sem conexao/servidor fora — tenta de novo mais tarde
            }
            await removeQueuedItem(item.id);
            if (result && result.status === 'success') {
                synced++;
                reconcileQueuedItem(item, result);
            } else {
                showToast(`Não foi possível sincronizar um registro pendente: ${(result && result.message) || 'erro desconhecido'}`, true);
            }
        }
        if (synced > 0) { showToast(`${synced} registro(s) pendente(s) sincronizado(s).`); }
    } catch (error) {
        // fila indisponivel (IndexedDB bloqueado/privado) — silencioso, tenta de novo depois
    } finally {
        _flushing = false;
        refreshPendingSyncBanner();
    }
}


function reconcileQueuedItem(item, result) {
    const meta = item.meta || {};
    if (!meta.entity || !meta.tempId) return;

    if (meta.entity === 'visits') {
        const real = normalizeVisit(result.visit || (result.visits && result.visits[0]) || item.payload);
        state.visits = (state.visits || []).map((v) => v.id === meta.tempId ? real : v);
        saveCache('visits', state.visits);
    } else if (meta.entity === 'proposals') {
        const real = normalizeProposal(result.proposal || item.payload);
        state.proposals = (state.proposals || []).map((p) => p.id === meta.tempId ? real : p);
        saveCache('proposals', state.proposals);
    } else if (meta.entity === 'funil') {
        const real = result.funil || item.payload;
        state.funil = (state.funil || []).map((f) => f.id === meta.tempId ? real : f);
        saveCache('funil', state.funil);
    }

    if (state.currentPage === meta.entity) { navigateToCurrentPage(); }
}


function navigateToCurrentPage() {
    // true = _fromPop: re-renderiza a pagina atual sem empilhar historico nem
    // disparar o aviso de "alteracoes nao salvas" (isso e so um refresh em
    // segundo plano apos sincronizar a fila).
    import('./app.js').then((m) => m.navigateTo(state.currentPage, {}, true)).catch(() => {});
}


export async function refreshPendingSyncBanner() {
    const count = await getQueueCount();
    updatePendingSyncBanner(count);
}


export function initOfflineQueueSync() {
    window.addEventListener('online', flushOfflineQueue);
    setInterval(flushOfflineQueue, 30000);
    refreshPendingSyncBanner();
    flushOfflineQueue();
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


// O item de nav "Radar" só existe depois que allNavItems é montado em
// renderNavigation() — e isso acontece uma vez só (síncrono, logo após o
// login), ANTES desse fetch assíncrono resolver. Sem isso, canAccessRadar
// muda em state mas o nav já foi construído sem o item e nunca mais atualiza.
function setCanAccessRadar(value) {
    if (state.canAccessRadar === value) return;
    state.canAccessRadar = value;
    resetNavCache();
    renderNavigation();
}

export async function getDashboardData() {
    const cached = loadCache('dashboard');
    const fresh = callAPI('getDashboardData', { user: state.currentUser })
        .then(function(r) {
            if (r.status === 'success') {
                saveCache('dashboard', r.data);
                state.dashboardData = r.data;
                state.canDelete = !!r.data.canDelete;
                state.canCreateProposalFunil = !!r.data.canCreateProposalFunil;
                setCanAccessRadar(!!r.data.canAccessRadar);
            }
            return r;
        })
        .catch(function(e) { return { status: 'error', message: e.message }; });
    if (cached) {
        state.dashboardData = cached;
        state.canDelete = !!cached.canDelete;
        state.canCreateProposalFunil = !!cached.canCreateProposalFunil;
        setCanAccessRadar(!!cached.canAccessRadar);
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
