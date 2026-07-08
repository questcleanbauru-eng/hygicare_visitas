import { getSheetObjects, getHeaders, updateCell } from '../sheets.js';
import { formatDate, formatTime } from '../common.js';

export async function handleLogin(payload) {
    const email = String(payload.email || '').trim().toLowerCase();
    const password = String(payload.password || '').trim();
    if (!email || !password) throw new Error('E-mail e senha sao obrigatorios.');

    const headers = await getHeaders('Vendedores');
    const rows = await getSheetObjects('Vendedores');
    const rowIndex = rows.findIndex((row) =>
        String(row.EmailLogin || '').trim().toLowerCase() === email && String(row.Senha || '').trim() === password);

    if (rowIndex === -1) throw new Error('E-mail ou senha invalidos.');
    const found = rows[rowIndex];

    // Best-effort: sem lock (não é dado crítico) pra não competir com escritas de negócio.
    const ultimoLoginCol = headers.indexOf('UltimoLogin');
    if (ultimoLoginCol > -1) {
        try {
            const now = new Date();
            await updateCell('Vendedores', rowIndex + 2, ultimoLoginCol + 1, `${formatDate(now)} ${formatTime(now)}`);
        } catch (e) { /* não fatal */ }
    }

    return {
        status: 'success',
        userData: { email: found.EmailLogin, name: found.NomeVendedor, profile: found.Perfil, gerencia: found.Gerencia }
    };
}

export async function handleForgotPassword(payload) {
    const email = String(payload.email || '').trim().toLowerCase();
    if (!email) throw new Error('Informe um e-mail.');

    const rows = await getSheetObjects('Vendedores');
    const found = rows.find((row) => String(row.EmailLogin || '').trim().toLowerCase() === email);

    if (!found) {
        return { status: 'success', message: 'Se o e-mail existir, o administrador deve redefinir a senha no cadastro.' };
    }
    return { status: 'success', message: 'Solicitacao registrada. Entre em contato com o administrador para redefinicao da senha.' };
}
