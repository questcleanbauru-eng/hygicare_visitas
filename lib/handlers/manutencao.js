import {
    getSheetObjects, getHeaders, getSheetWithHeaders, appendRow, updateRow, deleteRow,
    sheetExists, createSheet, withCache, clearCacheByPrefix
} from '../sheets.js';
import { verifyUser, ensureAdmin, formatDate, resolveCreateId, ensureTextLength, isConfigOn } from '../common.js';
import { ensureCanDelete, readEmailConfig } from './config.js';
import { logAudit } from '../audit.js';

const SHEET_NAME = 'Manutencoes';
const HEADERS = [
    'Id', 'Data', 'Tecnico', 'Gerencia', 'Cliente', 'Cidade',
    'ItensTabela', 'Observacao',
    'AssinaturaTecnico', 'AssinaturaCliente', 'PendenteAprovacao', 'SyncTimestamp'
];

async function ensureManutencoesSheet() {
    const exists = await sheetExists(SHEET_NAME);
    if (!exists) {
        await createSheet(SHEET_NAME);
        await appendRow(SHEET_NAME, HEADERS);
    }
}

function findKey(headers, candidates) {
    const lower = headers.map((h) => String(h).trim().toLowerCase());
    for (const c of candidates) {
        const idx = lower.indexOf(c.toLowerCase().trim());
        if (idx > -1) return headers[idx];
    }
    return null;
}

// Mesma regra de Visitas/Propostas/Funil: Gerente vê a própria gerência,
// Vendedor (Técnico) só o que ele mesmo criou.
function filterManutencaoByUser(items, user) {
    const profile = String(user.profile || '').trim().toLowerCase();
    if (profile === 'admin') return items;
    if (profile === 'gerente') {
        const userGer = String(user.gerencia || '').trim().toLowerCase();
        return items.filter((item) => String(item.gerencia || '').trim().toLowerCase() === userGer);
    }
    const userName = String(user.name || '').trim().toLowerCase();
    return items.filter((item) => String(item.tecnico || '').trim().toLowerCase() === userName);
}

export async function readManutencaoRows(user) {
    const exists = await sheetExists(SHEET_NAME);
    if (!exists) return [];
    // Compartilhado (não por-usuário) — mesmo motivo de Funil/Contratos: a
    // leitura da planilha em si fica igual pra todo mundo, só o filtro por
    // dono (abaixo) muda por usuário, e isso é processamento em memória, sem
    // custo de requisição.
    const { headers, rows } = await withCache('manutencao_sheet_raw', 60, () => getSheetWithHeaders(SHEET_NAME));
    if (!headers.length) return [];

    const key = {
        id: findKey(headers, ['Id', 'ID']),
        data: findKey(headers, ['Data', 'DATA']),
        tec: findKey(headers, ['Tecnico', 'TECNICO', 'Técnico']),
        ger: findKey(headers, ['Gerencia', 'GERENCIA', 'Gerência']),
        cli: findKey(headers, ['Cliente', 'CLIENTE']),
        cid: findKey(headers, ['Cidade', 'CIDADE']),
        itens: findKey(headers, ['ItensTabela', 'ITENSTABELA']),
        obs: findKey(headers, ['Observacao', 'OBSERVACAO', 'Observação']),
        assinTec: findKey(headers, ['AssinaturaTecnico', 'ASSINATURATECNICO']),
        assinCli: findKey(headers, ['AssinaturaCliente', 'ASSINATURACLIENTE']),
        pendente: findKey(headers, ['PendenteAprovacao', 'PENDENTEAPROVACAO']),
        sync: findKey(headers, ['SyncTimestamp', 'SYNCTIMESTAMP'])
    };

    const v = (row, k) => (k ? (row[k] ?? '') : '');
    const s = (row, k) => String(v(row, k) || '');

    const parsed = rows.map((row) => ({
        id: s(row, key.id),
        data: s(row, key.data),
        tecnico: s(row, key.tec),
        gerencia: s(row, key.ger),
        cliente: s(row, key.cli),
        cidade: s(row, key.cid),
        itensTabela: s(row, key.itens),
        observacao: s(row, key.obs),
        assinaturaTecnico: s(row, key.assinTec),
        assinaturaCliente: s(row, key.assinCli),
        pendenteAprovacao: s(row, key.pendente),
        syncTimestamp: Number(v(row, key.sync)) || 0
    }));

    return filterManutencaoByUser(parsed, user);
}

function buildManutencaoRowData(headers, fields) {
    return headers.map((h) => {
        const lh = h.toLowerCase().trim();
        const matchKey = Object.keys(fields).find((k) => k.toLowerCase().trim() === lh);
        return matchKey !== undefined ? fields[matchKey] : '';
    });
}

export async function handleGetManutencoes(payload) {
    const user = await verifyUser(payload.user);
    const rows = await withCache('mnt_' + user.email, 180, () => readManutencaoRows(user));
    return { status: 'success', manutencoes: rows };
}

export async function handleGetManutencaoById(payload) {
    const user = await verifyUser(payload.user);
    const id = String(payload.id || '').trim();
    const rows = await withCache('mnt_' + user.email, 180, () => readManutencaoRows(user));
    const found = rows.find((r) => String(r.id) === id);
    if (!found) throw new Error('Relatório de manutenção não encontrado.');
    return { status: 'success', manutencao: found };
}

export async function handleCreateManutencao(payload) {
    const user = await verifyUser(payload.user);
    if (!payload.cliente) throw new Error('Cliente é obrigatório.');
    ensureTextLength(payload.observacao, 'Observação');

    await ensureManutencoesSheet();
    const headers = await getHeaders(SHEET_NAME);
    // ID por timestamp evita colisão entre dois relatórios criados ao mesmo
    // tempo por usuários diferentes (Sheets API não tem escrita atômica).
    const id = resolveCreateId(payload);
    if (payload._queueRetry) {
        const dup = (await readManutencaoRows(user)).find((r) => String(r.id) === String(id));
        if (dup) return { status: 'success', manutencao: dup };
    }

    const fields = {
        'Id': id,
        'Data': formatDate(new Date()),
        'Tecnico': payload.tecnico || user.name,
        'Gerencia': user.gerencia || '',
        'Cliente': payload.cliente,
        'Cidade': payload.cidade || '',
        'ItensTabela': payload.itensTabela || '[]',
        'Observacao': payload.observacao || '',
        'AssinaturaTecnico': payload.assinaturaTecnico || '',
        'AssinaturaCliente': payload.assinaturaCliente || '',
        'PendenteAprovacao': '',
        'SyncTimestamp': Date.now()
    };

    await appendRow(SHEET_NAME, buildManutencaoRowData(headers, fields));
    clearCacheByPrefix(['mnt_', 'manutencao_sheet_raw']);
    await logAudit(user, 'criou', 'manutencao', id, payload.cliente);
    return {
        status: 'success',
        manutencao: {
            id: String(id), data: fields.Data, tecnico: fields.Tecnico, gerencia: fields.Gerencia,
            cliente: fields.Cliente, cidade: fields.Cidade,
            itensTabela: fields.ItensTabela, observacao: fields.Observacao,
            assinaturaTecnico: fields.AssinaturaTecnico, assinaturaCliente: fields.AssinaturaCliente,
            pendenteAprovacao: fields.PendenteAprovacao, syncTimestamp: fields.SyncTimestamp
        }
    };
}

export async function handleUpdateManutencao(payload) {
    const user = await verifyUser(payload.user);
    const id = String(payload.id || '').trim();

    const headers = await getHeaders(SHEET_NAME);
    const rows = await getSheetObjects(SHEET_NAME);
    const rowIndex = rows.findIndex((r) => String(r.Id || r.ID || '') === id);
    if (rowIndex === -1) throw new Error('Relatório de manutenção não encontrado para atualização.');

    const current = rows[rowIndex];
    const findCurrentKey = (candidates) => Object.keys(current).find((k) => candidates.includes(k.toLowerCase().replace(/[^a-z]/g, '')));
    const keyMap = {
        tec: findCurrentKey(['tecnico']) || 'Tecnico',
        ger: findCurrentKey(['gerencia']) || 'Gerencia',
        cli: findCurrentKey(['cliente']) || 'Cliente',
        cid: findCurrentKey(['cidade']) || 'Cidade',
        itens: findCurrentKey(['itenstabela']) || 'ItensTabela',
        obs: findCurrentKey(['observacao']) || 'Observacao',
        assinTec: findCurrentKey(['assinaturatecnico']) || 'AssinaturaTecnico',
        assinCli: findCurrentKey(['assinaturacliente']) || 'AssinaturaCliente',
        pendente: findCurrentKey(['pendenteaprovacao']) || 'PendenteAprovacao',
        sync: findCurrentKey(['synctimestamp']) || 'SyncTimestamp'
    };

    const profile = String(user.profile || '').trim().toLowerCase();
    const isAdmin = profile === 'admin';
    const userName = String(user.name || '').trim().toLowerCase();
    const ownerName = String(current[keyMap.tec] || '').trim().toLowerCase();
    const ownerGer = String(current[keyMap.ger] || '').trim().toLowerCase();
    const userGer = String(user.gerencia || '').trim().toLowerCase();
    const owns = isAdmin || (profile === 'gerente' && ownerGer === userGer) || ownerName === userName;
    if (!owns) throw new Error('Você não tem permissão para editar este relatório.');

    ensureTextLength(payload.observacao, 'Observação');

    // Relatório assinado (as 2 assinaturas preenchidas) trava pra quem não é
    // admin — a menos que o admin tenha ligado o toggle
    // "permitir_editar_manutencao_assinada" nas Configurações; mesmo assim a
    // edição fica marcada como pendente de aprovação. Admin nunca passa por
    // essa trava, igual todo o resto do app.
    const jaAssinado = !!(current[keyMap.assinTec] && current[keyMap.assinCli]);
    let ficaPendente = false;
    if (jaAssinado && !isAdmin) {
        const config = await withCache('app_config', 600, () => readEmailConfig());
        if (!isConfigOn(config.permitir_editar_manutencao_assinada)) {
            throw new Error('Este relatório já foi assinado e só pode ser editado por um administrador.');
        }
        ficaPendente = true;
    }

    if (payload.cliente !== undefined) current[keyMap.cli] = payload.cliente;
    if (payload.cidade !== undefined) current[keyMap.cid] = payload.cidade;
    if (payload.itensTabela !== undefined) current[keyMap.itens] = payload.itensTabela;
    if (payload.observacao !== undefined) current[keyMap.obs] = payload.observacao;
    if (payload.assinaturaTecnico !== undefined) current[keyMap.assinTec] = payload.assinaturaTecnico;
    if (payload.assinaturaCliente !== undefined) current[keyMap.assinCli] = payload.assinaturaCliente;
    // Só Admin pode reatribuir o dono do relatório — mesmo padrão já usado
    // em Contratos/Visitas/Propostas/Funil.
    if (isAdmin && payload.tecnico !== undefined) current[keyMap.tec] = payload.tecnico;
    if (ficaPendente) current[keyMap.pendente] = 'Sim';
    current[keyMap.sync] = Date.now();

    await updateRow(SHEET_NAME, rowIndex + 2, headers.map((h) => (current[h] !== undefined ? current[h] : '')));
    clearCacheByPrefix(['mnt_', 'manutencao_sheet_raw']);
    await logAudit(user, 'editou', 'manutencao', id, current[keyMap.cli]);
    return { status: 'success', manutencao: (await readManutencaoRows(user)).find((r) => String(r.id) === id) };
}

export async function handleApproveManutencao(payload) {
    const user = await ensureAdmin(payload.user);
    const id = String(payload.id || '').trim();

    const headers = await getHeaders(SHEET_NAME);
    const rows = await getSheetObjects(SHEET_NAME);
    const rowIndex = rows.findIndex((r) => String(r.Id || r.ID || '') === id);
    if (rowIndex === -1) throw new Error('Relatório de manutenção não encontrado.');

    const current = rows[rowIndex];
    const pendenteKey = Object.keys(current).find((k) => k.toLowerCase().replace(/[^a-z]/g, '') === 'pendenteaprovacao') || 'PendenteAprovacao';
    current[pendenteKey] = '';
    const cliKeyForApprove = Object.keys(current).find((k) => k.toLowerCase() === 'cliente') || 'Cliente';

    await updateRow(SHEET_NAME, rowIndex + 2, headers.map((h) => (current[h] !== undefined ? current[h] : '')));
    clearCacheByPrefix(['mnt_', 'manutencao_sheet_raw']);
    await logAudit(user, 'aprovou', 'manutencao', id, current[cliKeyForApprove]);
    return { status: 'success', message: 'Relatório aprovado.' };
}

export async function handleDeleteManutencao(payload) {
    const user = await ensureCanDelete(payload.user);
    const id = String(payload.id || '').trim();

    const rows = await getSheetObjects(SHEET_NAME);
    const rowIndex = rows.findIndex((r) => String(r.Id || r.ID || '') === id);
    if (rowIndex === -1) throw new Error('Relatório de manutenção não encontrado para exclusão.');
    const cliKeyForDelete = Object.keys(rows[rowIndex]).find((k) => k.toLowerCase() === 'cliente') || 'Cliente';
    const cliente = rows[rowIndex][cliKeyForDelete] || '';

    await deleteRow(SHEET_NAME, rowIndex + 2);
    clearCacheByPrefix(['mnt_', 'manutencao_sheet_raw']);
    await logAudit(user, 'apagou', 'manutencao', id, cliente);
    return { status: 'success', message: 'Relatório apagado.' };
}

// Modelo por cliente: Equipamento/Produto/Diluição que o técnico já sabe
// que aquele cliente usa, pra não digitar tudo de novo a cada visita — 1
// modelo por cliente (salvar de novo sobrescreve o anterior via upsert por
// nome), compartilhado entre todos os técnicos que atendem esse cliente
// (não é "por dono" como os relatórios).
const MODELOS_SHEET_NAME = 'ManutencaoModelos';
const MODELOS_HEADERS = ['Id', 'Cliente', 'ItensTabela', 'AtualizadoPor', 'AtualizadoEm'];

async function ensureModelosSheet() {
    const exists = await sheetExists(MODELOS_SHEET_NAME);
    if (!exists) {
        await createSheet(MODELOS_SHEET_NAME);
        await appendRow(MODELOS_SHEET_NAME, MODELOS_HEADERS);
    }
}

function normalizeClienteKey(cliente) {
    return String(cliente || '').trim().toLowerCase();
}

export async function handleGetManutencaoModelos(payload) {
    await verifyUser(payload.user);
    await ensureModelosSheet();
    const rows = await withCache('mnt_modelos_all', 300, () => getSheetObjects(MODELOS_SHEET_NAME));
    return {
        status: 'success',
        modelos: rows.map((r) => ({
            id: String(r.Id || ''),
            cliente: r.Cliente || '',
            itensTabela: r.ItensTabela || '[]',
            atualizadoPor: r.AtualizadoPor || '',
            atualizadoEm: r.AtualizadoEm || ''
        }))
    };
}

export async function handleSaveManutencaoModelo(payload) {
    const user = await verifyUser(payload.user);
    if (!payload.cliente) throw new Error('Cliente é obrigatório.');

    await ensureModelosSheet();
    const headers = await getHeaders(MODELOS_SHEET_NAME);
    const rows = await getSheetObjects(MODELOS_SHEET_NAME);
    const key = normalizeClienteKey(payload.cliente);
    const rowIndex = rows.findIndex((r) => normalizeClienteKey(r.Cliente) === key);

    const fields = {
        Id: (rowIndex >= 0 && rows[rowIndex].Id) ? rows[rowIndex].Id : resolveCreateId(payload),
        Cliente: payload.cliente,
        ItensTabela: payload.itensTabela || '[]',
        AtualizadoPor: user.name,
        AtualizadoEm: formatDate(new Date())
    };

    if (rowIndex >= 0) {
        await updateRow(MODELOS_SHEET_NAME, rowIndex + 2, headers.map((h) => (fields[h] !== undefined ? fields[h] : '')));
    } else {
        await appendRow(MODELOS_SHEET_NAME, headers.map((h) => (fields[h] !== undefined ? fields[h] : '')));
    }

    clearCacheByPrefix(['mnt_modelos_']);
    return {
        status: 'success',
        modelo: { id: String(fields.Id), cliente: fields.Cliente, itensTabela: fields.ItensTabela }
    };
}
