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

// Deriva o Id de criação a partir da idempotencyKey do cliente (formato
// "temp_<timestamp>", o mesmo tempId usado pro estado otimista) quando
// presente — assim uma retentativa da fila offline gera o MESMO Id da
// tentativa original, permitindo detectar duplicata em vez de criar de novo.
export function resolveCreateId(payload) {
    const match = String((payload && payload.idempotencyKey) || '').match(/(\d{10,})/);
    return match ? Number(match[1]) : Date.now();
}

// Cap de tamanho pra campos de texto livre (Observação/Comentários/etc) —
// bem abaixo do limite de célula do Sheets (50.000 caracteres), pra dar um
// erro amigável em vez do usuário só ver a mensagem crua da API do Sheets
// ao colar um texto gigante.
const MAX_FREE_TEXT_LENGTH = 5000;

export function ensureTextLength(value, fieldLabel) {
    if (value && String(value).length > MAX_FREE_TEXT_LENGTH) {
        throw new Error(`${fieldLabel} muito longo (máximo de ${MAX_FREE_TEXT_LENGTH} caracteres).`);
    }
}

export function canAccessClient(row, user) {
    const profile = String(user.profile || '').trim().toLowerCase();
    if (profile === 'admin' || profile === 'gerente') return true;

    const sellerName = String(user.name || '').trim().toLowerCase();
    const assignedSellers = String(row.Vendedores || row.Vendedor || '').toLowerCase();
    if (!sellerName || !assignedSellers) return false;

    return assignedSellers.split(/[;,|]/).map((item) => item.trim()).filter(Boolean).includes(sellerName);
}

// Mesma regra de escopo do filterByUser, mas pra uma linha só — usado nos
// handlers de update/delete pra garantir que o usuário só edita/apaga
// registro que já poderia ver em uma listagem (admin: tudo; gerente: só a
// própria gerência, quando a entidade tem esse campo; vendedor: só o
// próprio nome).
export function userOwnsRow(row, user, type) {
    const profile = String(user.profile || '').trim().toLowerCase();
    if (profile === 'admin') return true;

    const userName = String(user.name || '').trim().toLowerCase();
    const userGer = String(user.gerencia || '').trim().toLowerCase();

    if (type === 'visits') {
        if (profile === 'gerente') {
            return String(row['Gerência'] || row.Gerencia || '').trim().toLowerCase() === userGer;
        }
        return String(row['Vendedor/Gerente'] || '').trim().toLowerCase() === userName;
    }

    if (type === 'funil') {
        if (profile === 'gerente') {
            return String(row.Gerencia || row['Gerência'] || '').trim().toLowerCase() === userGer;
        }
        return String(row.Vendedor || row.vendedor || '').trim().toLowerCase() === userName;
    }

    if (type === 'contratos' || type === 'agendamentos') {
        // Essas duas entidades não têm recorte por gerência — gerente vê tudo.
        if (profile === 'gerente') return true;
        return String(row.Vendedor || row.vendedor || '').trim().toLowerCase() === userName;
    }

    // proposals (e qualquer outro tipo)
    if (profile === 'gerente') {
        return String(row.Gerencia || row['Gerência'] || '').trim().toLowerCase() === userGer;
    }
    return String(row.Vendedor || '').trim().toLowerCase() === userName;
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

// ── Rate limit (best-effort, em memória — não é mais o gargalo real) ────

const _rateLimit = new Map();

export function checkRateLimit(email) {
    if (!email) return;
    const key = String(email).toLowerCase().replace(/[^a-z0-9@._-]/gi, '').substring(0, 50);
    const now = Date.now();
    const entry = _rateLimit.get(key);
    if (!entry || now - entry.windowStart > 60000) {
        _rateLimit.set(key, { count: 1, windowStart: now });
        return;
    }
    if (entry.count >= 60) throw new Error('Muitas requisicoes. Aguarde um momento.');
    entry.count += 1;
}
