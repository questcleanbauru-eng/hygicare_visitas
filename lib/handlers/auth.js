import { getSheetObjects, getHeaders, updateCell, updateRow } from '../sheets.js';
import { formatDate, formatTime } from '../common.js';
import { verifyUser, ensureAdmin } from '../common.js';
import { createSession, hashPassword, verifyPassword } from '../security.js';

const PIN_MAX_FAILS = 5;
const PIN_LOCK_MINUTES = 15;

function normEmail(value) {
    return String(value || '').trim().toLowerCase();
}

function validPin(value) {
    return /^\d{4}$/.test(String(value || '').trim());
}

// Garante que as colunas existem na aba (append no cabeçalho).
async function ensureColumns(sheet, cols) {
    const headers = await getHeaders(sheet);
    const missing = cols.filter((h) => !headers.includes(h));
    if (missing.length) await updateRow(sheet, 1, [...headers, ...missing]);
}

const PIN_COLS = ['PinHash', 'PinFalhas', 'PinBloqueioAte'];

async function findVendedorRow(email) {
    const headers = await getHeaders('Vendedores');
    const rows = await getSheetObjects('Vendedores');
    const idx = rows.findIndex((row) => normEmail(row.EmailLogin) === normEmail(email));
    return { headers, rows, idx, row: idx > -1 ? rows[idx] : null };
}

function makeCellSetter(headers, rowIndexZeroBased) {
    return (label, value) => {
        const col = headers.indexOf(label);
        if (col > -1) return updateCell('Vendedores', rowIndexZeroBased + 2, col + 1, String(value));
        return Promise.resolve();
    };
}

async function touchUltimoLogin(headers, rowIndexZeroBased) {
    const col = headers.indexOf('UltimoLogin');
    if (col < 0) return;
    try {
        const now = new Date();
        await updateCell('Vendedores', rowIndexZeroBased + 2, col + 1, `${formatDate(now)} ${formatTime(now)}`);
    } catch (e) { /* não fatal */ }
}

function sessionResponseFor(row) {
    const userData = {
        email: row.EmailLogin,
        name: row.NomeVendedor,
        profile: row.Perfil,
        gerencia: row.Gerencia
    };
    return { status: 'success', userData, accessToken: createSession(userData) };
}

export async function handleLogin(payload) {
    const email = normEmail(payload.email);
    const password = String(payload.password || '').trim();
    if (!email || !password) throw new Error('E-mail e senha sao obrigatorios.');

    const { headers, idx, row } = await findVendedorRow(email);

    if (idx === -1) throw new Error('E-mail ou senha invalidos.');
    const passwordCheck = verifyPassword(password, row.Senha);
    if (!passwordCheck.valid) throw new Error('E-mail ou senha invalidos.');

    await touchUltimoLogin(headers, idx);

    if (passwordCheck.needsUpgrade) {
        const senhaCol = headers.indexOf('Senha');
        if (senhaCol > -1) await updateCell('Vendedores', idx + 2, senhaCol + 1, hashPassword(password));
    }

    return sessionResponseFor(row);
}

// Login pelo PIN (validado aqui, com bloqueio após PIN_MAX_FAILS erros).
export async function handleLoginWithPin(payload) {
    const email = normEmail(payload.email);
    const pin = String(payload.pin || '').trim();
    if (!email || !validPin(pin)) throw new Error('Informe o e-mail e um PIN de 4 dígitos.');

    const { headers, idx, row } = await findVendedorRow(email);
    // Mensagem genérica pra não revelar se o e-mail existe.
    if (idx === -1 || !row.PinHash) throw new Error('Nenhum PIN cadastrado para este e-mail. Entre com e-mail e senha.');

    const set = makeCellSetter(headers, idx);

    const lockUntil = row.PinBloqueioAte ? new Date(row.PinBloqueioAte) : null;
    if (lockUntil && !isNaN(lockUntil) && lockUntil > new Date()) {
        const mins = Math.max(1, Math.ceil((lockUntil - new Date()) / 60000));
        throw new Error(`PIN bloqueado por tentativas erradas. Tente de novo em ${mins} min ou entre com e-mail e senha.`);
    }

    const check = verifyPassword(pin, row.PinHash);
    if (check.valid) {
        await Promise.all([set('PinFalhas', '0'), set('PinBloqueioAte', '')]);
        await touchUltimoLogin(headers, idx);
        return sessionResponseFor(row);
    }

    const fails = (parseInt(row.PinFalhas, 10) || 0) + 1;
    if (fails >= PIN_MAX_FAILS) {
        const until = new Date(Date.now() + PIN_LOCK_MINUTES * 60000).toISOString();
        await Promise.all([set('PinFalhas', '0'), set('PinBloqueioAte', until)]);
        throw new Error(`PIN incorreto. Bloqueado por ${PIN_LOCK_MINUTES} minutos — entre com e-mail e senha.`);
    }
    await set('PinFalhas', String(fails));
    throw new Error(`PIN incorreto. ${PIN_MAX_FAILS - fails} tentativa(s) antes de bloquear.`);
}

// Cadastra/troca o PIN do próprio usuário (sessão já validada no dispatcher).
export async function handleSetupPin(payload) {
    const user = await verifyUser(payload.user);
    const pin = String(payload.pin || '').trim();
    if (!validPin(pin)) throw new Error('O PIN precisa ter 4 dígitos.');

    await ensureColumns('Vendedores', PIN_COLS);
    const { headers, idx } = await findVendedorRow(user.email);
    if (idx === -1) throw new Error('Usuário não encontrado.');

    const set = makeCellSetter(headers, idx);
    await set('PinHash', hashPassword(pin));
    await Promise.all([set('PinFalhas', '0'), set('PinBloqueioAte', '')]);
    return { status: 'success', message: 'PIN salvo.' };
}

// Remove o PIN. Sem `email` = o próprio; com `email` diferente = só admin.
export async function handleRemovePin(payload) {
    const user = await verifyUser(payload.user);
    const target = normEmail(payload.email || user.email);
    if (target !== normEmail(user.email)) {
        await ensureAdmin(payload.user);
    }

    await ensureColumns('Vendedores', PIN_COLS);
    const { headers, idx } = await findVendedorRow(target);
    if (idx === -1) throw new Error('Usuário não encontrado.');

    const set = makeCellSetter(headers, idx);
    await Promise.all([set('PinHash', ''), set('PinFalhas', '0'), set('PinBloqueioAte', '')]);
    return { status: 'success', message: 'PIN removido.' };
}

export async function handleForgotPassword(payload) {
    const email = normEmail(payload.email);
    if (!email) throw new Error('Informe um e-mail.');

    const rows = await getSheetObjects('Vendedores');
    const found = rows.find((row) => normEmail(row.EmailLogin) === email);

    if (!found) {
        return { status: 'success', message: 'Se o e-mail existir, o administrador deve redefinir a senha no cadastro.' };
    }
    return { status: 'success', message: 'Solicitacao registrada. Entre em contato com o administrador para redefinicao da senha.' };
}
