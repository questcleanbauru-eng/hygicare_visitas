import { getSheetObjects, getHeaders, getSheetWithHeaders, appendRow, updateRow, deleteRow, withCache, clearCacheKeys } from '../sheets.js';
import { verifyUser, formatDate, formatDateFromInput } from '../common.js';
import { ensureCanDelete, ensureCanCreateProposalFunil } from './config.js';

function findKey(headers, candidates) {
    const lower = headers.map((h) => String(h).trim().toLowerCase());
    for (const c of candidates) {
        const idx = lower.indexOf(c.toLowerCase().trim());
        if (idx > -1) return headers[idx];
    }
    return null;
}

// Contratos não tem coluna Gerência (ao contrário de Visitas/Propostas/Funil),
// então Gerente enxerga tudo igual Admin — só Vendedor fica restrito ao próprio nome.
function filterContratosByUser(items, user) {
    const profile = String(user.profile || '').trim().toLowerCase();
    if (profile === 'admin' || profile === 'gerente') return items;
    const userName = String(user.name || '').trim().toLowerCase();
    return items.filter((item) => String(item.vendedor || '').trim().toLowerCase() === userName);
}

export async function readContratoRows(user) {
    const { headers, rows } = await getSheetWithHeaders('Contratos');
    if (!headers.length) return [];

    const key = {
        id: findKey(headers, ['Id', 'ID']),
        ativo: findKey(headers, ['Ativo', 'ATIVO']),
        data: findKey(headers, ['Data', 'DATA']),
        vend: findKey(headers, ['Vendedor', 'VENDEDOR']),
        cli: findKey(headers, ['Cliente', 'CLIENTE']),
        cid: findKey(headers, ['Cidade', 'CIDADE']),
        assin: findKey(headers, ['Assinado', 'ASSINADO']),
        inicio: findKey(headers, ['Inicio', 'INICIO', 'Início']),
        fim: findKey(headers, ['Fim', 'FIM']),
        anexo: findKey(headers, ['Anexo', 'ANEXO']),
        aviso: findKey(headers, ['EnviarAviso', 'ENVIARAVISO', 'Enviar Aviso']),
        obs: findKey(headers, ['Obs', 'OBS'])
    };

    const v = (row, k) => (k ? (row[k] ?? '') : '');
    const s = (row, k) => String(v(row, k) || '');

    const parsed = rows.map((row) => ({
        id: s(row, key.id),
        ativo: s(row, key.ativo) || 'Sim',
        data: s(row, key.data),
        vendedor: s(row, key.vend),
        cliente: s(row, key.cli),
        cidade: s(row, key.cid),
        assinado: s(row, key.assin),
        inicio: s(row, key.inicio),
        fim: s(row, key.fim),
        anexo: s(row, key.anexo),
        enviarAviso: s(row, key.aviso) || 'Sim',
        obs: s(row, key.obs)
    }));

    return filterContratosByUser(parsed, user);
}

function buildContratoRowData(headers, fields) {
    return headers.map((h) => {
        const lh = h.toLowerCase().trim();
        const matchKey = Object.keys(fields).find((k) => k.toLowerCase().trim() === lh);
        return matchKey !== undefined ? fields[matchKey] : '';
    });
}

export async function handleGetContratos(payload) {
    const user = await verifyUser(payload.user);
    const rows = await withCache('ct_' + user.email, 180, () => readContratoRows(user));
    return { status: 'success', contratos: rows };
}

export async function handleGetContratoById(payload) {
    const user = await verifyUser(payload.user);
    const id = String(payload.id || '').trim();
    const rows = await withCache('ct_' + user.email, 180, () => readContratoRows(user));
    const found = rows.find((r) => String(r.id) === id);
    if (!found) throw new Error('Contrato não encontrado.');
    return { status: 'success', contrato: found };
}

export async function handleCreateContrato(payload) {
    const user = await ensureCanCreateProposalFunil(payload.user);
    if (!payload.cliente) throw new Error('Cliente é obrigatório.');

    const headers = await getHeaders('Contratos');
    // ID por timestamp evita colisão entre dois contratos criados ao mesmo
    // tempo por usuários diferentes (Sheets API não tem escrita atômica).
    const id = Date.now();

    const fields = {
        'Id': id,
        'Ativo': payload.ativo || 'Sim',
        'Data': formatDate(new Date()),
        'Vendedor': payload.vendedor || user.name,
        'Cliente': payload.cliente,
        'Cidade': payload.cidade || '',
        'Assinado': payload.assinado || 'Nao',
        'Inicio': payload.inicio ? formatDateFromInput(payload.inicio) : '',
        'Fim': payload.fim ? formatDateFromInput(payload.fim) : '',
        'Anexo': payload.anexo || '',
        'EnviarAviso': payload.enviarAviso || 'Sim',
        'Obs': payload.obs || ''
    };

    await appendRow('Contratos', buildContratoRowData(headers, fields));
    clearCacheKeys(['ct_' + user.email]);
    return {
        status: 'success',
        contrato: {
            id: String(id), ativo: fields.Ativo, data: fields.Data, vendedor: fields.Vendedor,
            cliente: fields.Cliente, cidade: fields.Cidade, assinado: fields.Assinado,
            inicio: fields.Inicio, fim: fields.Fim, anexo: fields.Anexo,
            enviarAviso: fields.EnviarAviso, obs: fields.Obs
        }
    };
}

export async function handleUpdateContrato(payload) {
    const user = await verifyUser(payload.user);
    const id = String(payload.id || '').trim();

    const headers = await getHeaders('Contratos');
    const rows = await getSheetObjects('Contratos');
    const rowIndex = rows.findIndex((r) => String(r.Id || r.ID || '') === id);
    if (rowIndex === -1) throw new Error('Contrato não encontrado para atualização.');

    const current = rows[rowIndex];
    const findCurrentKey = (candidates) => Object.keys(current).find((k) => candidates.includes(k.toLowerCase().replace(/[^a-z]/g, '')));
    const keyMap = {
        ativo: findCurrentKey(['ativo']) || 'Ativo',
        vend: findCurrentKey(['vendedor']) || 'Vendedor',
        cli: findCurrentKey(['cliente']) || 'Cliente',
        cid: findCurrentKey(['cidade']) || 'Cidade',
        assin: findCurrentKey(['assinado']) || 'Assinado',
        inicio: findCurrentKey(['inicio']) || 'Inicio',
        fim: findCurrentKey(['fim']) || 'Fim',
        anexo: findCurrentKey(['anexo']) || 'Anexo',
        aviso: findCurrentKey(['enviaraviso']) || 'EnviarAviso',
        obs: findCurrentKey(['obs']) || 'Obs'
    };

    if (payload.ativo !== undefined) current[keyMap.ativo] = payload.ativo;
    if (payload.vendedor !== undefined) current[keyMap.vend] = payload.vendedor;
    if (payload.cliente !== undefined) current[keyMap.cli] = payload.cliente;
    if (payload.cidade !== undefined) current[keyMap.cid] = payload.cidade;
    if (payload.assinado !== undefined) current[keyMap.assin] = payload.assinado;
    if (payload.inicio !== undefined) current[keyMap.inicio] = payload.inicio ? formatDateFromInput(payload.inicio) : '';
    if (payload.fim !== undefined) current[keyMap.fim] = payload.fim ? formatDateFromInput(payload.fim) : '';
    if (payload.enviarAviso !== undefined) current[keyMap.aviso] = payload.enviarAviso;
    if (payload.obs !== undefined) current[keyMap.obs] = payload.obs;
    if (payload.anexo !== undefined) current[keyMap.anexo] = payload.anexo;

    await updateRow('Contratos', rowIndex + 2, headers.map((h) => (current[h] !== undefined ? current[h] : '')));
    clearCacheKeys(['ct_' + user.email]);
    return { status: 'success', contrato: (await readContratoRows(user)).find((r) => String(r.id) === id) };
}

export async function handleDeleteContrato(payload) {
    const user = await ensureCanDelete(payload.user);
    const id = String(payload.id || '').trim();

    const rows = await getSheetObjects('Contratos');
    const rowIndex = rows.findIndex((r) => String(r.Id || r.ID || '') === id);
    if (rowIndex === -1) throw new Error('Contrato não encontrado para exclusão.');

    await deleteRow('Contratos', rowIndex + 2);
    clearCacheKeys(['ct_' + user.email]);
    return { status: 'success', message: 'Contrato apagado.' };
}
