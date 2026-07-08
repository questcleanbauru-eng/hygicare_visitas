import {
    batchGetSheetObjects, getSheetObjects, getHeaders, appendRow, updateRow,
    clearAndWriteColumn, withCache, clearCacheKeys
} from '../sheets.js';
import { ensureAdmin } from '../common.js';
import { bumpCacheVersion } from './config.js';

const ADMIN_SHEETS = ['Vendedores', 'TiposVisita', 'Cidades', 'AreasAtuacao', 'PotenciaisCliente', 'Aplicacoes', 'Equipamentos'];

export async function handleGetAdminData(payload) {
    await ensureAdmin(payload.user);

    // Uma unica chamada batchGet pras 7 abas, em vez de 7 chamadas separadas
    // (mesma causa do 429 de quota vista no getFormData).
    const sheets = await withCache('admin_all', 300, () => batchGetSheetObjects(ADMIN_SHEETS));

    const users = sheets.Vendedores.map((u) => ({
        EmailLogin: u.EmailLogin || '', NomeVendedor: u.NomeVendedor || '', Gerencia: u.Gerencia || '',
        Perfil: u.Perfil || '', UltimoLogin: u.UltimoLogin || ''
    }));

    const notifications = sheets.TiposVisita.map((row) => ({
        tipo: row.Tipo || '', telefoneDestino: row.TelefoneDestino || '',
        mensagemPadrao: row.MensagemPadrao || '',
        obrigatorio: String(row.Obrigatorio || '').trim().toLowerCase() === 'sim'
    }));

    const lookups = {
        cidades: sheets.Cidades.map((r) => r.Cidade).filter(Boolean),
        areasAtuacao: sheets.AreasAtuacao.map((r) => r.Area).filter(Boolean),
        potenciaisCliente: sheets.PotenciaisCliente.map((r) => r.Potencial).filter(Boolean),
        aplicacoes: sheets.Aplicacoes.map((r) => r.Aplicacao).filter(Boolean),
        equipamentos: sheets.Equipamentos.map((r) => r.Equipamento).filter(Boolean)
    };

    return { status: 'success', data: { users, notifications, lookups } };
}

export async function handleSaveUser(payload) {
    await ensureAdmin(payload.user);
    const originalEmail = String(payload.originalEmail || '').trim().toLowerCase();

    const headers = await getHeaders('Vendedores');
    const rows = await getSheetObjects('Vendedores');

    if (originalEmail) {
        const rowIndex = rows.findIndex((row) => String(row.EmailLogin || '').trim().toLowerCase() === originalEmail);
        if (rowIndex === -1) throw new Error('Usuario nao encontrado para atualizacao.');
        const existingSenha = rows[rowIndex].Senha || '';
        const userRow = {
            EmailLogin: payload.emailLogin, NomeVendedor: payload.nomeVendedor,
            Senha: payload.senha || existingSenha, Gerencia: payload.gerencia, Perfil: payload.perfil
        };
        await updateRow('Vendedores', rowIndex + 2, headers.map((h) => userRow[h] || ''));
    } else {
        if (!payload.senha) throw new Error('Senha obrigatoria para novo usuario.');
        const userRow = {
            EmailLogin: payload.emailLogin, NomeVendedor: payload.nomeVendedor,
            Senha: payload.senha, Gerencia: payload.gerencia, Perfil: payload.perfil
        };
        await appendRow('Vendedores', headers.map((h) => userRow[h] || ''));
    }

    clearCacheKeys([
        'admin_all',
        'user_verify_' + String(payload.emailLogin || '').trim().toLowerCase(),
        'user_verify_' + originalEmail
    ]);
    return { status: 'success', message: 'Usuario salvo.' };
}

export async function handleSaveNotificationConfig(payload) {
    await ensureAdmin(payload.user);
    const originalTipo = String(payload.originalTipo || '').trim().toLowerCase();

    const headers = await getHeaders('TiposVisita');
    const rows = await getSheetObjects('TiposVisita');
    const rowData = {
        Tipo: payload.tipo, TelefoneDestino: payload.telefoneDestino,
        MensagemPadrao: payload.mensagemPadrao, Obrigatorio: payload.obrigatorio ? 'Sim' : 'Não'
    };

    if (originalTipo) {
        const rowIndex = rows.findIndex((row) => String(row.Tipo || '').trim().toLowerCase() === originalTipo);
        if (rowIndex === -1) throw new Error('Tipo de visita nao encontrado para atualizacao.');
        await updateRow('TiposVisita', rowIndex + 2, headers.map((h) => rowData[h] || ''));
    } else {
        await appendRow('TiposVisita', headers.map((h) => rowData[h] || ''));
    }

    await bumpCacheVersion();
    clearCacheKeys(['admin_all', 'formdata_all', 'app_config']);
    return { status: 'success', message: 'Configuracao salva.' };
}

export async function handleSaveLookupList(payload) {
    await ensureAdmin(payload.user);
    const mapping = {
        cidades: { sheet: 'Cidades', header: 'Cidade' },
        areasAtuacao: { sheet: 'AreasAtuacao', header: 'Area' },
        potenciaisCliente: { sheet: 'PotenciaisCliente', header: 'Potencial' },
        aplicacoes: { sheet: 'Aplicacoes', header: 'Aplicacao' },
        equipamentos: { sheet: 'Equipamentos', header: 'Equipamento' }
    };

    const config = mapping[payload.key];
    if (!config) throw new Error('Lista invalida.');

    await clearAndWriteColumn(config.sheet, config.header, payload.values || []);
    await bumpCacheVersion();
    clearCacheKeys(['admin_all', 'formdata_all', 'app_config']);
    return { status: 'success', message: 'Lista atualizada.' };
}
