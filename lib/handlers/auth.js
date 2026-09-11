import { getSheetObjects, getHeaders, updateCell, updateRow } from '../sheets.js';
import { formatDate, formatTime } from '../common.js';
import { verifyUser, ensureAdmin } from '../common.js';
import { createSession, hashPassword, verifyPassword } from '../security.js';

const PIN_MAX_FAILS = 5;
const PIN_LOCK_MINUTES = 15;
// Senha virou 4 dígitos (mesmo formato do PIN) — sem essa trava ficaria
// mais fácil de forçar por tentativa e erro do que o PIN, que já tinha.
const SENHA_MAX_FAILS = 5;
const SENHA_LOCK_MINUTES = 15;
const SENHA_COLS = ['SenhaFalhas', 'SenhaBloqueioAte'];

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

// Login com PIN também aceita o nome em vez do e-mail (mais rápido de
// digitar no dia a dia) — só pelo PIN, não pela senha, já que o PIN em si
// já é o fator "rápido" e o nome não é garantidamente único. Compara contra
// o "Nome de login" (curto, cadastrado pelo admin) quando existe, e cai pro
// nome completo (NomeVendedor) senão — assim contas antigas sem esse campo
// continuam entrando normalmente.
async function findVendedorRowByNome(nome) {
    const headers = await getHeaders('Vendedores');
    const rows = await getSheetObjects('Vendedores');
    const alvo = String(nome || '').trim().toLowerCase();
    const matches = rows
        .map((row, i) => ({ row, i }))
        .filter(({ row }) => {
            const nomeLogin = String(row.NomeLogin || '').trim().toLowerCase();
            const nomeCompleto = String(row.NomeVendedor || '').trim().toLowerCase();
            return (nomeLogin && nomeLogin === alvo) || nomeCompleto === alvo;
        });
    if (matches.length > 1) return { headers, rows, idx: -1, row: null, ambiguous: true };
    if (matches.length === 1) return { headers, rows, idx: matches[0].i, row: matches[0].row, ambiguous: false };
    return { headers, rows, idx: -1, row: null, ambiguous: false };
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
        gerencia: row.Gerencia,
        // Telas escondidas pra esse usuário (Admin → editar usuário). Vazio =
        // vê tudo, igual sempre foi.
        telasBloqueadas: String(row.TelasBloqueadas || '').split(',').map((s) => s.trim()).filter(Boolean)
    };
    return {
        status: 'success',
        userData,
        accessToken: createSession(userData),
        // Pra o cliente saber que a conta já tem PIN (cadastrado em outro
        // aparelho) e não ficar oferecendo criar de novo.
        hasPin: !!String(row.PinHash || '').trim()
    };
}

export async function handleLogin(payload) {
    const email = normEmail(payload.email);
    const password = String(payload.password || '').trim();
    if (!email || !password) throw new Error('E-mail e senha sao obrigatorios.');

    await ensureColumns('Vendedores', SENHA_COLS);
    const { headers, idx, row } = await findVendedorRow(email);

    // Mensagem genérica (não revela se o e-mail existe) — mesmo padrão do
    // login por PIN.
    if (idx === -1) throw new Error('E-mail ou senha invalidos.');
    if (String(row.Ativo || '').trim().toLowerCase() === 'nao') throw new Error('Conta desativada. Fale com o administrador.');

    const set = makeCellSetter(headers, idx);
    const lockUntil = row.SenhaBloqueioAte ? new Date(row.SenhaBloqueioAte) : null;
    if (lockUntil && !isNaN(lockUntil) && lockUntil > new Date()) {
        const mins = Math.max(1, Math.ceil((lockUntil - new Date()) / 60000));
        throw new Error(`Muitas tentativas erradas. Tente de novo em ${mins} min ou fale com o administrador.`);
    }

    const passwordCheck = verifyPassword(password, row.Senha);
    if (!passwordCheck.valid) {
        const fails = (parseInt(row.SenhaFalhas, 10) || 0) + 1;
        if (fails >= SENHA_MAX_FAILS) {
            const until = new Date(Date.now() + SENHA_LOCK_MINUTES * 60000).toISOString();
            await Promise.all([set('SenhaFalhas', '0'), set('SenhaBloqueioAte', until)]);
            throw new Error(`Muitas tentativas erradas. Bloqueado por ${SENHA_LOCK_MINUTES} minutos.`);
        }
        await set('SenhaFalhas', String(fails));
        throw new Error('E-mail ou senha invalidos.');
    }
    if (row.SenhaFalhas || row.SenhaBloqueioAte) await Promise.all([set('SenhaFalhas', '0'), set('SenhaBloqueioAte', '')]);

    await touchUltimoLogin(headers, idx);

    if (passwordCheck.needsUpgrade) {
        const senhaCol = headers.indexOf('Senha');
        if (senhaCol > -1) await updateCell('Vendedores', idx + 2, senhaCol + 1, hashPassword(password));
    }

    return sessionResponseFor(row);
}

// Login pelo PIN (validado aqui, com bloqueio após PIN_MAX_FAILS erros).
// Identificador pode ser e-mail ou nome — nome só funciona por aqui (login
// com senha continua exigindo e-mail).
export async function handleLoginWithPin(payload) {
    const email = normEmail(payload.email);
    const nome = String(payload.nome || '').trim();
    const pin = String(payload.pin || '').trim();
    if ((!email && !nome) || !validPin(pin)) throw new Error('Informe o e-mail (ou nome) e um PIN de 4 dígitos.');

    const found = email ? await findVendedorRow(email) : await findVendedorRowByNome(nome);
    if (found.ambiguous) throw new Error('Mais de um usuário com esse nome — entre com e-mail e PIN, ou e-mail e senha.');
    const { headers, idx, row } = found;
    // Mensagem genérica pra não revelar se a conta existe.
    if (idx === -1 || !row.PinHash) throw new Error('Nenhum PIN cadastrado. Entre com e-mail e senha.');
    if (String(row.Ativo || '').trim().toLowerCase() === 'nao') throw new Error('Conta desativada. Fale com o administrador.');

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

// Admin cadastra/troca o PIN de qualquer usuário direto no cadastro (sem
// precisar que o próprio usuário faça isso pelo login) — mesma trava de 4
// dígitos do handleSetupPin, mas sem a checagem de PIN fraco: quem está
// escolhendo aqui é o admin, não o dono da conta se autoprotegendo.
//
// Também grava o "Nome de login" (payload.nomeLogin) quando informado —
// esse campo mora no mesmo formulário e no mesmo clique do PIN na tela do
// admin, então salvamos os dois juntos aqui em vez de depender do admin
// clicar em "Salvar" separadamente pra persistir o nome (era exatamente
// isso que fazia o login por nome falhar: PIN salvo, nome não).
export async function handleAdminSetPin(payload) {
    await ensureAdmin(payload.user);
    const target = normEmail(payload.email);
    if (!target) throw new Error('Informe o e-mail do usuário.');
    const pin = String(payload.pin || '').trim();
    if (!validPin(pin)) throw new Error('O PIN precisa ter 4 dígitos.');

    await ensureColumns('Vendedores', [...PIN_COLS, 'NomeLogin']);
    const { headers, idx } = await findVendedorRow(target);
    if (idx === -1) throw new Error('Usuário não encontrado.');

    const set = makeCellSetter(headers, idx);
    const writes = [set('PinHash', hashPassword(pin)), set('PinFalhas', '0'), set('PinBloqueioAte', '')];
    if (payload.nomeLogin !== undefined) writes.push(set('NomeLogin', String(payload.nomeLogin || '').trim()));
    await Promise.all(writes);
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
