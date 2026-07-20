import {
    getSheetObjects, getHeaders, getSheetWithHeaders, appendRow, updateRow,
    sheetExists, createSheet, withCache, clearCacheByPrefix
} from '../sheets.js';
import { ensureAdmin, formatDate, formatDateFromInput, ensureTextLength } from '../common.js';
import { ensureCanAccessRadar } from './config.js';

const CLIENTES_SHEET = 'RadarClientes';
const CLIENTES_HEADERS = [
    'Id', 'Cnpj', 'Nome', 'NomeFantasia', 'Cidade', 'Uf', 'CnaeCodigo', 'CnaeDescricao',
    'SituacaoCadastral', 'DataBusca', 'Status', 'StatusData', 'StatusMotivo',
    'StatusRetornoPrevisto', 'VisitaOrigemId'
];

const CIDADES_SHEET = 'RadarCidadesDisponiveis';
const CIDADES_HEADERS = ['Cidade', 'Uf', 'LiberadaEm', 'Lat', 'Lng'];

const SOLICITACOES_SHEET = 'RadarSolicitacoesCidade';
const SOLICITACOES_HEADERS = ['Id', 'CidadeSolicitada', 'Uf', 'SolicitadoPor', 'DataSolicitacao', 'Urgente', 'Status'];

const VALID_STATUSES = ['buscado', 'ja_atendido', 'recusado', 'prospeccao_agendada'];

async function ensureSheet(name, headers) {
    const exists = await sheetExists(name);
    if (!exists) {
        await createSheet(name);
        await appendRow(name, headers);
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

// CNPJ só-dígitos como chave de dedup — a planilha real já vem assim, mas
// normalizo mesmo assim caso uma futura exportação venha formatada
// ("12.345.678/0001-90").
export function normalizeCnpj(value) {
    return String(value || '').replace(/\D/g, '');
}

// ── Cidades disponíveis ──────────────────────────────────────────────────

export async function readCidadesRows() {
    const exists = await sheetExists(CIDADES_SHEET);
    if (!exists) return [];
    const { headers, rows } = await getSheetWithHeaders(CIDADES_SHEET);
    if (!headers.length) return [];

    const key = {
        cidade: findKey(headers, ['Cidade']),
        uf: findKey(headers, ['Uf', 'UF']),
        liberada: findKey(headers, ['LiberadaEm']),
        lat: findKey(headers, ['Lat']),
        lng: findKey(headers, ['Lng'])
    };
    const v = (row, k) => (k ? (row[k] ?? '') : '');
    const s = (row, k) => String(v(row, k) || '');

    return rows.map((row) => ({
        cidade: s(row, key.cidade),
        uf: s(row, key.uf),
        liberadaEm: s(row, key.liberada),
        lat: v(row, key.lat) !== '' ? Number(v(row, key.lat)) : null,
        lng: v(row, key.lng) !== '' ? Number(v(row, key.lng)) : null
    }));
}

export async function handleGetRadarCidadesDisponiveis(payload) {
    await ensureCanAccessRadar(payload.user);
    const rows = await withCache('radar_cidades', 300, () => readCidadesRows());
    return { status: 'success', cidades: rows };
}

// ── Clientes ─────────────────────────────────────────────────────────────

export async function readRadarClienteRows() {
    const exists = await sheetExists(CLIENTES_SHEET);
    if (!exists) return [];
    const { headers, rows } = await getSheetWithHeaders(CLIENTES_SHEET);
    if (!headers.length) return [];

    const key = {
        id: findKey(headers, ['Id']),
        cnpj: findKey(headers, ['Cnpj', 'CNPJ']),
        nome: findKey(headers, ['Nome']),
        nomeFantasia: findKey(headers, ['NomeFantasia']),
        cidade: findKey(headers, ['Cidade']),
        uf: findKey(headers, ['Uf', 'UF']),
        cnaeCodigo: findKey(headers, ['CnaeCodigo']),
        cnaeDescricao: findKey(headers, ['CnaeDescricao']),
        situacao: findKey(headers, ['SituacaoCadastral']),
        dataBusca: findKey(headers, ['DataBusca']),
        status: findKey(headers, ['Status']),
        statusData: findKey(headers, ['StatusData']),
        statusMotivo: findKey(headers, ['StatusMotivo']),
        statusRetorno: findKey(headers, ['StatusRetornoPrevisto']),
        visitaOrigemId: findKey(headers, ['VisitaOrigemId'])
    };
    const v = (row, k) => (k ? (row[k] ?? '') : '');
    const s = (row, k) => String(v(row, k) || '');

    return rows.map((row) => ({
        id: s(row, key.id),
        cnpj: s(row, key.cnpj),
        nome: s(row, key.nome),
        nomeFantasia: s(row, key.nomeFantasia),
        cidade: s(row, key.cidade),
        uf: s(row, key.uf),
        cnaeCodigo: s(row, key.cnaeCodigo),
        cnaeDescricao: s(row, key.cnaeDescricao),
        situacaoCadastral: s(row, key.situacao),
        dataBusca: s(row, key.dataBusca),
        status: s(row, key.status) || 'buscado',
        statusData: s(row, key.statusData),
        statusMotivo: s(row, key.statusMotivo),
        statusRetornoPrevisto: s(row, key.statusRetorno),
        visitaOrigemId: s(row, key.visitaOrigemId)
    }));
}

export async function handleGetRadarClientes(payload) {
    await ensureCanAccessRadar(payload.user);
    // Cache único (não por-usuário) — a base do Radar não é dado pessoal de
    // ninguém, todo mundo com acesso vê a mesma coisa.
    const all = await withCache('radar_clientes_all', 90, () => readRadarClienteRows());

    if (payload.scope === 'all') {
        return { status: 'success', clientes: all };
    }

    const cidade = String(payload.cidade || '').trim().toLowerCase();
    if (!cidade) throw new Error('Selecione uma cidade.');
    const uf = String(payload.uf || '').trim().toLowerCase();
    const filtered = all.filter((c) =>
        c.cidade.trim().toLowerCase() === cidade && (!uf || c.uf.trim().toLowerCase() === uf));
    return { status: 'success', clientes: filtered };
}

// Cobre os 3 botões do card de detalhe ("já atendido", "recusou", e o flip
// pós-visita de "agendar prospecção") — um único endpoint, só muda o status
// enviado e quais campos extras vêm junto.
export async function handleUpdateRadarClienteStatus(payload) {
    await ensureCanAccessRadar(payload.user);
    const id = String(payload.id || '').trim();
    const status = String(payload.status || '').trim();
    if (!VALID_STATUSES.includes(status)) throw new Error('Status inválido.');
    ensureTextLength(payload.motivo, 'Motivo');

    const headers = await getHeaders(CLIENTES_SHEET);
    const rows = await getSheetObjects(CLIENTES_SHEET);
    const rowIndex = rows.findIndex((r) => String(r.Id || '') === id);
    if (rowIndex === -1) throw new Error('Empresa não encontrada no Radar.');

    const current = rows[rowIndex];
    const findCurrentKey = (candidates) => Object.keys(current).find((k) => candidates.includes(k.toLowerCase().replace(/[^a-z]/g, '')));
    const keyMap = {
        status: findCurrentKey(['status']) || 'Status',
        statusData: findCurrentKey(['statusdata']) || 'StatusData',
        statusMotivo: findCurrentKey(['statusmotivo']) || 'StatusMotivo',
        statusRetorno: findCurrentKey(['statusretornoprevisto']) || 'StatusRetornoPrevisto',
        visitaOrigemId: findCurrentKey(['visitaorigemid']) || 'VisitaOrigemId'
    };

    current[keyMap.status] = status;
    current[keyMap.statusData] = formatDate(new Date());
    current[keyMap.statusMotivo] = status === 'recusado' ? (payload.motivo || '') : '';
    current[keyMap.statusRetorno] = (status === 'recusado' && payload.retornoPrevisto)
        ? formatDateFromInput(payload.retornoPrevisto) : '';
    if (payload.visitaOrigemId) current[keyMap.visitaOrigemId] = String(payload.visitaOrigemId);

    await updateRow(CLIENTES_SHEET, rowIndex + 2, headers.map((h) => (current[h] !== undefined ? current[h] : '')));
    clearCacheByPrefix(['radar_clientes']);
    return { status: 'success' };
}

// ── Solicitações de cidade ───────────────────────────────────────────────

export async function handleCreateRadarSolicitacaoCidade(payload) {
    const user = await ensureCanAccessRadar(payload.user);
    const cidade = String(payload.cidade || '').trim();
    if (!cidade) throw new Error('Informe a cidade.');

    await ensureSheet(SOLICITACOES_SHEET, SOLICITACOES_HEADERS);
    const headers = await getHeaders(SOLICITACOES_SHEET);
    const id = Date.now();
    const fields = {
        'Id': id,
        'CidadeSolicitada': cidade,
        'Uf': String(payload.uf || '').trim(),
        'SolicitadoPor': user.name,
        'DataSolicitacao': formatDate(new Date()),
        'Urgente': payload.urgente ? 'Sim' : 'Nao',
        'Status': 'pendente'
    };
    await appendRow(SOLICITACOES_SHEET, headers.map((h) => (fields[h] !== undefined ? fields[h] : '')));
    clearCacheByPrefix(['radar_solicitacoes']);
    return { status: 'success' };
}

export async function handleGetRadarSolicitacoesCidade(payload) {
    await ensureAdmin(payload.user);
    const rows = await withCache('radar_solicitacoes', 120, async () => {
        const exists = await sheetExists(SOLICITACOES_SHEET);
        if (!exists) return [];
        const { headers, rows } = await getSheetWithHeaders(SOLICITACOES_SHEET);
        if (!headers.length) return [];
        const key = {
            id: findKey(headers, ['Id']),
            cidade: findKey(headers, ['CidadeSolicitada']),
            uf: findKey(headers, ['Uf', 'UF']),
            solicitadoPor: findKey(headers, ['SolicitadoPor']),
            data: findKey(headers, ['DataSolicitacao']),
            urgente: findKey(headers, ['Urgente']),
            status: findKey(headers, ['Status'])
        };
        const v = (row, k) => (k ? (row[k] ?? '') : '');
        const s = (row, k) => String(v(row, k) || '');
        return rows.map((row) => ({
            id: s(row, key.id),
            cidade: s(row, key.cidade),
            uf: s(row, key.uf),
            solicitadoPor: s(row, key.solicitadoPor),
            dataSolicitacao: s(row, key.data),
            urgente: s(row, key.urgente).toLowerCase() === 'sim',
            status: s(row, key.status) || 'pendente'
        }));
    });
    return { status: 'success', solicitacoes: rows.filter((r) => r.status === 'pendente') };
}
