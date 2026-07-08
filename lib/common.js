import { getSheetObjects, getHeaders, withCache } from './sheets.js';

// Sync incremental (since/serverNow) só é ativado quando a planilha já tem a
// coluna SyncTimestamp — evita devolver listas vazias por engano em abas
// ainda não migradas.
export async function hasSyncColumn(sheetName) {
    return withCache('hassync_' + sheetName, 600, async () => {
        const headers = await getHeaders(sheetName);
        return headers.indexOf('SyncTimestamp') > -1;
    });
}

const TIMEZONE = 'America/Sao_Paulo';

// ── Datas/horas (Brasil) ───────────────────────────────────────────────
// A API REST do Sheets devolve os valores já formatados como exibidos na
// planilha (FORMATTED_VALUE, o default), então datas/horas chegam como
// string "dd/MM/yyyy"/"HH:mm[:ss]" igual ao que o app já espera — sem
// precisar detectar/objeto Date como no Apps Script.

export function formatDate(date) {
    return date.toLocaleDateString('pt-BR', { timeZone: TIMEZONE });
}

export function formatTime(date) {
    return date.toLocaleTimeString('pt-BR', { timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit' });
}

export function formatPossibleDate(value) { return value || ''; }
export function formatPossibleTime(value) { return value || ''; }

export function formatDateFromInput(value) {
    if (!value || String(value).indexOf('-') === -1) return value || '';
    const parts = String(value).split('-');
    return [parts[2], parts[1], parts[0]].join('/');
}

export function parseDate(value) {
    if (!value || String(value).indexOf('/') === -1) return null;
    const parts = String(value).split('/');
    const d = new Date(Number(parts[2]), Number(parts[1]) - 1, Number(parts[0]));
    return isNaN(d) ? null : d;
}

export function isDateWithinLastDays(value, days) {
    const date = parseDate(value);
    if (!date) return false;
    return (Date.now() - date.getTime()) <= days * 86400000;
}

export function daysSinceDate(value) {
    const date = parseDate(value);
    if (!date) return 0;
    return Math.floor((Date.now() - date.getTime()) / 86400000);
}

// ── Usuário / permissões ─────────────────────────────────────────────────

export function requireUser(user) {
    if (!user || !user.email) throw new Error('Usuario nao autenticado.');
    return user;
}

export async function verifyUser(user) {
    if (!user || !user.email) throw new Error('Usuario nao autenticado.');
    const email = String(user.email).trim().toLowerCase();
    const rows = await withCache('user_verify_' + email, 300, () => getSheetObjects('Vendedores'));
    const found = rows.find((row) => String(row.EmailLogin || '').trim().toLowerCase() === email);
    if (!found) throw new Error('Usuario nao autenticado.');
    return { email: found.EmailLogin, name: found.NomeVendedor, profile: found.Perfil, gerencia: found.Gerencia };
}

export async function ensureAdmin(user) {
    const verified = await verifyUser(user);
    if (String(verified.profile || '').trim().toLowerCase() !== 'admin') {
        throw new Error('Acesso restrito ao administrador.');
    }
    return verified;
}

export function canAccessClient(row, user) {
    const profile = String(user.profile || '').trim().toLowerCase();
    if (profile === 'admin' || profile === 'gerente') return true;

    const sellerName = String(user.name || '').trim().toLowerCase();
    const assignedSellers = String(row.Vendedores || row.Vendedor || '').toLowerCase();
    if (!sellerName || !assignedSellers) return false;

    return assignedSellers.split(/[;,|]/).map((item) => item.trim()).filter(Boolean).includes(sellerName);
}

export function filterByUser(items, user, type) {
    const profile = String(user.profile || '').trim().toLowerCase();
    const userName = String(user.name || '').trim().toLowerCase();
    const userGer = String(user.gerencia || '').trim().toLowerCase();

    if (profile === 'admin') return items;

    if (type === 'visits') {
        if (profile === 'gerente') {
            return items.filter((item) => String(item['Gerência'] || item.Gerencia || '').trim().toLowerCase() === userGer);
        }
        return items.filter((item) => String(item['Vendedor/Gerente'] || '').trim().toLowerCase() === userName);
    }

    if (type === 'funil') {
        if (profile === 'gerente') {
            return items.filter((item) => String(item.gerencia || '').trim().toLowerCase() === userGer);
        }
        return items.filter((item) => String(item.vendedor || '').trim().toLowerCase() === userName);
    }

    // proposals (e qualquer outro tipo)
    if (profile === 'gerente') {
        return items.filter((item) => String(item.Gerencia || item['Gerência'] || '').trim().toLowerCase() === userGer);
    }
    return items.filter((item) => String(item.Vendedor || '').trim().toLowerCase() === userName);
}

export function getNextId(rows, key) {
    const maxId = rows.reduce((acc, row) => {
        const value = Number(row[key] || 0);
        return value > acc ? value : acc;
    }, 0);
    return String(maxId + 1);
}

// ── Rate limit (best-effort, em memória — não é mais o gargalo real) ────

const _rateLimit = new Map();

export function checkRateLimit(email) {
    if (!email) return;
    const key = String(email).replace(/[^a-z0-9@._-]/gi, '').substring(0, 50);
    const now = Date.now();
    const entry = _rateLimit.get(key);
    if (!entry || now - entry.windowStart > 60000) {
        _rateLimit.set(key, { count: 1, windowStart: now });
        return;
    }
    if (entry.count >= 60) throw new Error('Muitas requisicoes. Aguarde um momento.');
    entry.count += 1;
}
