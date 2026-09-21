import {
    getSheetObjects, getHeaders, getSheetWithHeaders, appendRow, updateRow, deleteRow,
    sheetExists, createSheet, withCache, clearCacheByPrefix
} from '../sheets.js';
import { verifyUser, formatDate, resolveCreateId, hasBroadDataAccess } from '../common.js';
import { ensureCanDelete } from './config.js';
import { logAudit } from '../audit.js';

// Relatório de Atendimento Técnico (modelo Diversey/Professional). Estrutura
// fixa de seções/perguntas — o front monta o formulário; aqui a gente só
// guarda os campos "achatados" + dois blobs JSON (respostas das perguntas
// Sim/Não e a tabela de produtos aferidos, que é editável linha a linha).

const SHEET_NAME = 'RelatoriosTecnicos';
const HEADERS = [
    'Id', 'Data', 'Tecnico', 'Gerencia', 'SyncTimestamp',
    'RelatorioMes', 'DataVisita',
    'CodigoShipTo', 'Cliente', 'Grupo', 'MarketSector', 'Endereco', 'Bairro', 'Cidade', 'Estado',
    'TipoVisita', 'Area',
    'Respostas', 'Comentarios', 'ComentariosTabela', 'EstoqueVerificado',
    'ClienteAvaliador', 'ClienteCargo', 'AvaliacaoAtendimento', 'ClienteObservacoes', 'ClienteEmail',
    'Departamento', 'Gestor', 'ContatoGestor', 'InicioAtendimento', 'FimAtendimento'
];

// Campos texto simples: chave do payload -> header da planilha.
const TEXT_FIELDS = {
    relatorioMes: 'RelatorioMes', dataVisita: 'DataVisita',
    codigoShipTo: 'CodigoShipTo', cliente: 'Cliente', grupo: 'Grupo', marketSector: 'MarketSector',
    endereco: 'Endereco', bairro: 'Bairro', cidade: 'Cidade', estado: 'Estado',
    tipoVisita: 'TipoVisita', area: 'Area',
    comentarios: 'Comentarios', comentariosTabela: 'ComentariosTabela', estoqueVerificado: 'EstoqueVerificado',
    respostas: 'Respostas',
    clienteAvaliador: 'ClienteAvaliador', clienteCargo: 'ClienteCargo', avaliacaoAtendimento: 'AvaliacaoAtendimento',
    clienteObservacoes: 'ClienteObservacoes', clienteEmail: 'ClienteEmail',
    departamento: 'Departamento', gestor: 'Gestor', contatoGestor: 'ContatoGestor',
    inicioAtendimento: 'InicioAtendimento', fimAtendimento: 'FimAtendimento'
};

async function ensureSheet() {
    const exists = await sheetExists(SHEET_NAME);
    if (!exists) {
        await createSheet(SHEET_NAME);
        await appendRow(SHEET_NAME, HEADERS);
        return;
    }
    // Migração leve: garante colunas novas sem tocar nas linhas existentes.
    await withCache('rt_headers_ensured', 600, async () => {
        const headers = await getHeaders(SHEET_NAME);
        const missing = HEADERS.filter((h) => !headers.includes(h));
        if (missing.length) await updateRow(SHEET_NAME, 1, [...headers, ...missing]);
        return true;
    });
}

function findKey(headers, name) {
    const lower = headers.map((h) => String(h).trim().toLowerCase());
    const idx = lower.indexOf(String(name).trim().toLowerCase());
    return idx > -1 ? headers[idx] : null;
}

function filterByOwner(items, user) {
    const profile = String(user.profile || '').trim().toLowerCase();
    if (profile === 'admin') return items;
    if (profile === 'gerente') {
        const g = String(user.gerencia || '').trim().toLowerCase();
        return items.filter((it) => String(it.gerencia || '').trim().toLowerCase() === g);
    }
    const n = String(user.name || '').trim().toLowerCase();
    return items.filter((it) => String(it.tecnico || '').trim().toLowerCase() === n);
}

function rowToObject(row, headers) {
    const get = (h) => {
        const k = findKey(headers, h);
        return k ? String(row[k] ?? '') : '';
    };
    const out = {
        id: get('Id'),
        data: get('Data'),
        tecnico: get('Tecnico'),
        gerencia: get('Gerencia'),
        syncTimestamp: Number(get('SyncTimestamp')) || 0
    };
    for (const [payloadKey, header] of Object.entries(TEXT_FIELDS)) {
        out[payloadKey] = get(header);
    }
    return out;
}

export async function readRows(user) {
    const exists = await sheetExists(SHEET_NAME);
    if (!exists) return [];
    const { headers, rows } = await withCache('rt_sheet_raw', 60, () => getSheetWithHeaders(SHEET_NAME));
    if (!headers.length) return [];
    return filterByOwner(rows.map((r) => rowToObject(r, headers)), user);
}

function buildRowData(headers, fields) {
    return headers.map((h) => {
        const key = Object.keys(fields).find((k) => k.toLowerCase().trim() === h.toLowerCase().trim());
        return key !== undefined ? fields[key] : '';
    });
}

export async function handleGetRelatoriosTecnicos(payload) {
    const user = await verifyUser(payload.user);
    const rows = await withCache('rt_' + user.email, 180, () => readRows(user));
    return { status: 'success', relatorios: rows };
}

export async function handleGetRelatorioTecnicoById(payload) {
    const user = await verifyUser(payload.user);
    const id = String(payload.id || '').trim();
    const rows = await withCache('rt_' + user.email, 180, () => readRows(user));
    const found = rows.find((r) => String(r.id) === id);
    if (!found) throw new Error('Relatório técnico não encontrado.');
    return { status: 'success', relatorio: found };
}

function collectFields(payload) {
    const fields = {};
    for (const [payloadKey, header] of Object.entries(TEXT_FIELDS)) {
        if (payload[payloadKey] !== undefined) fields[header] = String(payload[payloadKey] ?? '');
    }
    return fields;
}

export async function handleCreateRelatorioTecnico(payload) {
    const user = await verifyUser(payload.user);
    if (!payload.cliente) throw new Error('Cliente é obrigatório.');

    await ensureSheet();
    const headers = await getHeaders(SHEET_NAME);
    const id = resolveCreateId(payload);
    if (payload._queueRetry) {
        const dup = (await readRows(user)).find((r) => String(r.id) === String(id));
        if (dup) return { status: 'success', relatorio: dup };
    }

    const fields = {
        Id: id,
        Data: formatDate(new Date()),
        Tecnico: payload.tecnico || user.name,
        Gerencia: user.gerencia || '',
        SyncTimestamp: Date.now(),
        Respostas: payload.respostas || '{}',
        ComentariosTabela: payload.comentariosTabela || '[]',
        ...collectFields(payload)
    };

    await appendRow(SHEET_NAME, buildRowData(headers, fields));
    clearCacheByPrefix(['rt_', 'rt_sheet_raw']);
    await logAudit(user, 'criou', 'relatorio-tecnico', id, payload.cliente);

    // rowToObject já sabe montar esse formato a partir de um objeto
    // keyed pelos headers — reaproveita fields direto, sem reler a aba
    // inteira de novo só pra achar a linha que acabou de ser criada.
    return { status: 'success', relatorio: rowToObject(fields, headers) };
}

export async function handleUpdateRelatorioTecnico(payload) {
    const user = await verifyUser(payload.user);
    const id = String(payload.id || '').trim();

    await ensureSheet();
    const headers = await getHeaders(SHEET_NAME);
    const rows = await getSheetObjects(SHEET_NAME);
    const rowIndex = rows.findIndex((r) => String(r.Id || r.ID || '') === id);
    if (rowIndex === -1) throw new Error('Relatório técnico não encontrado para atualização.');

    const current = rows[rowIndex];
    const kOf = (h) => Object.keys(current).find((k) => k.toLowerCase().trim() === h.toLowerCase().trim()) || h;

    const profile = String(user.profile || '').trim().toLowerCase();
    const isAdmin = profile === 'admin';
    const ownerName = String(current[kOf('Tecnico')] || '').trim().toLowerCase();
    const ownerGer = String(current[kOf('Gerencia')] || '').trim().toLowerCase();
    const owns = isAdmin
        || (profile === 'gerente' && ownerGer === String(user.gerencia || '').trim().toLowerCase())
        || ownerName === String(user.name || '').trim().toLowerCase();
    if (!owns) throw new Error('Você não tem permissão para editar este relatório.');

    const fields = { ...collectFields(payload) };
    if (payload.respostas !== undefined) fields.Respostas = String(payload.respostas || '{}');
    if (payload.comentariosTabela !== undefined) fields.ComentariosTabela = String(payload.comentariosTabela || '[]');
    for (const [h, v] of Object.entries(fields)) current[kOf(h)] = v;
    if (isAdmin && payload.tecnico !== undefined) current[kOf('Tecnico')] = payload.tecnico;
    current[kOf('SyncTimestamp')] = Date.now();

    await updateRow(SHEET_NAME, rowIndex + 2, headers.map((h) => (current[h] !== undefined ? current[h] : '')));
    clearCacheByPrefix(['rt_', 'rt_sheet_raw']);
    await logAudit(user, 'editou', 'relatorio-tecnico', id, current[kOf('Cliente')]);

    // current já está em memória com os campos atualizados — rowToObject
    // monta a resposta a partir dele direto, sem reler a aba inteira.
    return { status: 'success', relatorio: rowToObject(current, headers) };
}

export async function handleDeleteRelatorioTecnico(payload) {
    const user = await ensureCanDelete(payload.user);
    const id = String(payload.id || '').trim();

    await ensureSheet();
    const rows = await getSheetObjects(SHEET_NAME);
    const rowIndex = rows.findIndex((r) => String(r.Id || r.ID || '') === id);
    if (rowIndex === -1) throw new Error('Relatório técnico não encontrado para exclusão.');
    const cliKey = Object.keys(rows[rowIndex]).find((k) => k.toLowerCase() === 'cliente') || 'Cliente';
    const cliente = rows[rowIndex][cliKey] || '';

    if (!payload.force) {
        const { findCampanhaAbertaVinculada } = await import('./campanhas.js');
        const campanha = await findCampanhaAbertaVinculada(user, 'relatoriotecnico', 'relatorioTecnicoId', id);
        if (campanha) {
            return {
                status: 'confirm_required',
                message: `Esse relatório está vinculado à campanha "${campanha.titulo}", que ainda está aberta. Apagar mesmo assim?`
            };
        }
    }

    await deleteRow(SHEET_NAME, rowIndex + 2);
    clearCacheByPrefix(['rt_', 'rt_sheet_raw']);
    await logAudit(user, 'apagou', 'relatorio-tecnico', id, cliente);
    return { status: 'success', message: 'Relatório apagado.' };
}

// ── Modelos do relatório técnico ─────────────────────────────────────────
// Guarda os campos que se repetem por cliente/unidade (dados do cliente,
// área, produtos aferidos, dados do atendimento) pra não redigitar a cada
// visita. Compartilhado entre técnicos, upsert por Cliente+Nome.
const MODELOS_SHEET = 'RelatoriosTecnicosModelos';
const MODELOS_HEADERS = ['Id', 'Cliente', 'Nome', 'Dados', 'AtualizadoPor', 'Gerencia', 'AtualizadoEm'];

async function ensureModelosSheet() {
    const exists = await sheetExists(MODELOS_SHEET);
    if (!exists) {
        await createSheet(MODELOS_SHEET);
        await appendRow(MODELOS_SHEET, MODELOS_HEADERS);
        return;
    }
    // Migração: garante a coluna Gerencia (usada no filtro de visibilidade)
    // sem mexer nas linhas já salvas.
    await withCache('rt_modelos_headers_ensured', 600, async () => {
        const headers = await getHeaders(MODELOS_SHEET);
        const missing = MODELOS_HEADERS.filter((h) => !headers.includes(h));
        if (missing.length) await updateRow(MODELOS_SHEET, 1, [...headers, ...missing]);
        return true;
    });
}

const norm = (v) => String(v || '').trim().toLowerCase();

// Mesma regra de visibilidade usada nos modelos de Manutenção
// (filterModelosByUser em manutencao.js) — admin/tecnico/administrativo vê
// tudo, gerente vê a própria gerência, vendedor só o que ele mesmo salvou.
function filterModelosByUser(rows, user) {
    const profile = String(user.profile || '').trim().toLowerCase();
    if (hasBroadDataAccess(profile)) return rows;
    if (profile === 'gerente') {
        const userGer = norm(user.gerencia);
        return rows.filter((r) => norm(r.Gerencia) === userGer);
    }
    const userName = norm(user.name);
    return rows.filter((r) => norm(r.AtualizadoPor) === userName);
}

export async function handleGetRelatorioTecnicoModelos(payload) {
    const user = await verifyUser(payload.user);
    await ensureModelosSheet();
    const allRows = await withCache('rt_modelos_all', 300, () => getSheetObjects(MODELOS_SHEET));
    const rows = filterModelosByUser(allRows, user);
    return {
        status: 'success',
        modelos: rows.map((r) => ({
            id: String(r.Id || ''),
            cliente: r.Cliente || '',
            nome: r.Nome || r.Cliente || '',
            dados: r.Dados || '{}',
            atualizadoPor: r.AtualizadoPor || '',
            atualizadoEm: r.AtualizadoEm || ''
        }))
    };
}

export async function handleSaveRelatorioTecnicoModelo(payload) {
    const user = await verifyUser(payload.user);
    if (!payload.cliente) throw new Error('Cliente é obrigatório.');

    await ensureModelosSheet();
    const headers = await getHeaders(MODELOS_SHEET);
    const rows = await getSheetObjects(MODELOS_SHEET);
    const nome = String(payload.nome || '').trim() || payload.cliente;
    const rowIndex = payload.id
        ? rows.findIndex((r) => String(r.Id || '') === String(payload.id))
        : rows.findIndex((r) => norm(r.Cliente) === norm(payload.cliente) && norm(r.Nome || r.Cliente) === norm(nome));

    const fields = {
        Id: (rowIndex >= 0 && rows[rowIndex].Id) ? rows[rowIndex].Id : resolveCreateId(payload),
        Cliente: payload.cliente,
        Nome: nome,
        Dados: payload.dados || '{}',
        AtualizadoPor: user.name,
        Gerencia: user.gerencia || '',
        AtualizadoEm: formatDate(new Date())
    };

    if (rowIndex >= 0) {
        await updateRow(MODELOS_SHEET, rowIndex + 2, headers.map((h) => (fields[h] !== undefined ? fields[h] : '')));
    } else {
        await appendRow(MODELOS_SHEET, headers.map((h) => (fields[h] !== undefined ? fields[h] : '')));
    }
    clearCacheByPrefix(['rt_modelos_']);
    return { status: 'success', modelo: { id: String(fields.Id), cliente: fields.Cliente, nome: fields.Nome, dados: fields.Dados } };
}

export async function handleDeleteRelatorioTecnicoModelo(payload) {
    await ensureCanDelete(payload.user);
    const id = String(payload.id || '').trim();
    if (!id) throw new Error('Id do modelo é obrigatório.');

    await ensureModelosSheet();
    const rows = await getSheetObjects(MODELOS_SHEET);
    const rowIndex = rows.findIndex((r) => String(r.Id || '') === id);
    if (rowIndex === -1) throw new Error('Modelo não encontrado.');

    await deleteRow(MODELOS_SHEET, rowIndex + 2);
    clearCacheByPrefix(['rt_modelos_']);
    return { status: 'success', message: 'Modelo apagado.' };
}
