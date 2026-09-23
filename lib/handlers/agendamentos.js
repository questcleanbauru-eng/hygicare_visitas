import { getSheetObjects, getHeaders, getSheetWithHeaders, appendRow, updateRow, deleteRow, sheetExists, createSheet, withCache, clearCacheByPrefix } from '../sheets.js';
import { verifyUser, formatDate, formatDateFromInput, userOwnsRow, ensureTextLength } from '../common.js';
import { ensureCanDelete } from './config.js';

const SHEET_NAME = 'Agendamentos';
const HEADERS = ['Id', 'Vendedor', 'Cliente', 'Cidade', 'DataAgendada', 'Observacao', 'Status', 'VisitaOrigemId', 'Data', 'CampanhaOrigemId'];

async function ensureAgendamentosSheet() {
    const exists = await sheetExists(SHEET_NAME);
    if (!exists) {
        await createSheet(SHEET_NAME);
        await appendRow(SHEET_NAME, HEADERS);
        return;
    }
    // Migração leve: garante coluna nova (CampanhaOrigemId) sem tocar nas linhas.
    await withCache('ag_headers_ensured', 600, async () => {
        const headers = await getHeaders(SHEET_NAME);
        const missing = HEADERS.filter((h) => !headers.includes(h));
        if (missing.length) await updateRow(SHEET_NAME, 1, [...headers, ...missing]);
        return true;
    });
}

function findKey(headers, candidates) {
    const lower = headers.map((h) => String(h).trim().toLowerCase());
    for (const c of candidates) {
        const idx = lower.indexOf(c.toLowerCase().trim());
        if (idx > -1) return headers[idx];
    }
    return null;
}

// Sem coluna Gerência (igual Contratos) — Gerente enxerga tudo, Vendedor só o próprio.
function filterAgendamentosByUser(items, user) {
    const profile = String(user.profile || '').trim().toLowerCase();
    if (profile === 'admin' || profile === 'gerente') return items;
    const userName = String(user.name || '').trim().toLowerCase();
    return items.filter((item) => String(item.vendedor || '').trim().toLowerCase() === userName);
}

export async function readAgendamentoRows(user) {
    const exists = await sheetExists(SHEET_NAME);
    if (!exists) return [];
    // Compartilhado (não por-usuário) — mesmo motivo do Funil: quem chama
    // isso (dashboard) envolvia a função inteira num cache por-email, e a
    // leitura da planilha em si nunca era compartilhada entre vendedores.
    const { headers, rows } = await withCache('agendamentos_sheet_raw', 60, () => getSheetWithHeaders(SHEET_NAME));
    if (!headers.length) return [];

    const key = {
        id: findKey(headers, ['Id', 'ID']),
        vend: findKey(headers, ['Vendedor', 'VENDEDOR']),
        cli: findKey(headers, ['Cliente', 'CLIENTE']),
        cid: findKey(headers, ['Cidade', 'CIDADE']),
        dataAg: findKey(headers, ['DataAgendada', 'DATAAGENDADA', 'Data Agendada']),
        obs: findKey(headers, ['Observacao', 'OBSERVACAO', 'Observação']),
        status: findKey(headers, ['Status', 'STATUS']),
        origem: findKey(headers, ['VisitaOrigemId', 'VISITAORIGEMID']),
        data: findKey(headers, ['Data', 'DATA']),
        campOrigem: findKey(headers, ['CampanhaOrigemId', 'CAMPANHAORIGEMID'])
    };

    const v = (row, k) => (k ? (row[k] ?? '') : '');
    const s = (row, k) => String(v(row, k) || '');

    const parsed = rows.map((row) => ({
        id: s(row, key.id),
        vendedor: s(row, key.vend),
        cliente: s(row, key.cli),
        cidade: s(row, key.cid),
        dataAgendada: s(row, key.dataAg),
        observacao: s(row, key.obs),
        status: s(row, key.status) || 'Pendente',
        visitaOrigemId: s(row, key.origem),
        data: s(row, key.data),
        campanhaOrigemId: s(row, key.campOrigem)
    }));

    return filterAgendamentosByUser(parsed, user);
}

function buildAgendamentoRowData(headers, fields) {
    return headers.map((h) => {
        const lh = h.toLowerCase().trim();
        const matchKey = Object.keys(fields).find((k) => k.toLowerCase().trim() === lh);
        return matchKey !== undefined ? fields[matchKey] : '';
    });
}

export async function handleGetAgendamentos(payload) {
    const user = await verifyUser(payload.user);
    const rows = await withCache('ag_' + user.email, 120, () => readAgendamentoRows(user));
    return { status: 'success', agendamentos: rows };
}

// Criação "crua" (data já em dd/mm/aaaa, sem payload de usuário) — usada
// tanto pelo handler normal (abaixo) quanto por outros handlers que
// precisam gerar um agendamento automaticamente pra alguém que não é
// necessariamente quem está chamando (ex.: campanha criada com prazo —
// ver campanhas.js). Nunca lança erro: agendamento automático é um
// "extra" que não pode derrubar o fluxo principal de quem chamou.
export async function createAgendamentoInterno({ vendedor, cliente, cidade, dataAgendadaFormatada, observacao, visitaOrigemId, campanhaOrigemId }) {
    try {
        if (!vendedor || !cliente || !dataAgendadaFormatada) return null;
        await ensureAgendamentosSheet();
        const headers = await getHeaders(SHEET_NAME);
        const id = Date.now();
        const fields = {
            'Id': id,
            'Vendedor': vendedor,
            'Cliente': cliente,
            'Cidade': cidade || '',
            'DataAgendada': dataAgendadaFormatada,
            'Observacao': observacao || '',
            'Status': 'Pendente',
            'VisitaOrigemId': visitaOrigemId || '',
            'CampanhaOrigemId': campanhaOrigemId || '',
            'Data': formatDate(new Date())
        };
        await appendRow(SHEET_NAME, buildAgendamentoRowData(headers, fields));
        clearCacheByPrefix(['ag_', 'd_', 'agendamentos_sheet_raw']);
        return { id: String(id), ...fields };
    } catch (e) {
        return null;
    }
}

// Encerra (best-effort) os agendamentos gerados por prazo de uma campanha
// específica — usado quando o admin/gerente encerra a campanha na mão
// (ver handleEncerrarCampanha em campanhas.js), pra o compromisso sumir
// da Agenda junto, em vez de ficar "Pendente" apontando pra um link que
// já não funciona mais. Nunca lança erro: é um efeito colateral, não pode
// travar o encerramento da campanha em si.
export async function closeAgendamentosByCampanha(campanhaOrigemId, novoStatus) {
    try {
        if (!campanhaOrigemId) return;
        const exists = await sheetExists(SHEET_NAME);
        if (!exists) return;
        const headers = await getHeaders(SHEET_NAME);
        const campoKey = findKey(headers, ['CampanhaOrigemId']) || 'CampanhaOrigemId';
        const statusKey = findKey(headers, ['Status']) || 'Status';
        const rows = await getSheetObjects(SHEET_NAME);
        const writes = [];
        rows.forEach((row, idx) => {
            if (String(row[campoKey] || '') !== String(campanhaOrigemId)) return;
            if (String(row[statusKey] || '').trim().toLowerCase() !== 'pendente') return;
            row[statusKey] = novoStatus;
            writes.push(updateRow(SHEET_NAME, idx + 2, headers.map((h) => (row[h] !== undefined ? row[h] : ''))));
        });
        if (writes.length) {
            await Promise.all(writes);
            clearCacheByPrefix(['ag_', 'd_', 'agendamentos_sheet_raw']);
        }
    } catch (e) { /* best-effort */ }
}

// Move (best-effort) o agendamento gerado pelo prazo de uma campanha
// específica pra nova data — usado quando o admin/gerente prorroga o prazo
// (ver handleUpdateCampanhaPrazo em campanhas.js), pra Agenda não continuar
// mostrando o compromisso na data antiga/vencida. Nunca lança erro: efeito
// colateral, não pode travar a alteração do prazo em si.
export async function updateAgendamentosDataByCampanha(campanhaOrigemId, novaData) {
    try {
        if (!campanhaOrigemId || !novaData) return;
        const exists = await sheetExists(SHEET_NAME);
        if (!exists) return;
        const headers = await getHeaders(SHEET_NAME);
        const campoKey = findKey(headers, ['CampanhaOrigemId']) || 'CampanhaOrigemId';
        const statusKey = findKey(headers, ['Status']) || 'Status';
        const dataKey = findKey(headers, ['DataAgendada']) || 'DataAgendada';
        const rows = await getSheetObjects(SHEET_NAME);
        const writes = [];
        rows.forEach((row, idx) => {
            if (String(row[campoKey] || '') !== String(campanhaOrigemId)) return;
            if (String(row[statusKey] || '').trim().toLowerCase() !== 'pendente') return;
            row[dataKey] = novaData;
            writes.push(updateRow(SHEET_NAME, idx + 2, headers.map((h) => (row[h] !== undefined ? row[h] : ''))));
        });
        if (writes.length) {
            await Promise.all(writes);
            clearCacheByPrefix(['ag_', 'd_', 'agendamentos_sheet_raw']);
        }
    } catch (e) { /* best-effort */ }
}

export async function handleCreateAgendamento(payload) {
    const user = await verifyUser(payload.user);
    if (!payload.cliente) throw new Error('Cliente é obrigatório.');
    if (!payload.dataAgendada) throw new Error('Data do agendamento é obrigatória.');
    ensureTextLength(payload.observacao, 'Observação');

    await ensureAgendamentosSheet();
    const headers = await getHeaders(SHEET_NAME);
    // ID por timestamp evita colisão entre dois agendamentos criados ao
    // mesmo tempo por usuários diferentes (Sheets API não tem escrita atômica).
    const id = Date.now();

    const fields = {
        'Id': id,
        'Vendedor': user.name,
        'Cliente': payload.cliente,
        'Cidade': payload.cidade || '',
        'DataAgendada': formatDateFromInput(payload.dataAgendada),
        'Observacao': payload.observacao || '',
        'Status': 'Pendente',
        'VisitaOrigemId': payload.visitaOrigemId || '',
        'Data': formatDate(new Date())
    };

    await appendRow(SHEET_NAME, buildAgendamentoRowData(headers, fields));
    clearCacheByPrefix(['ag_', 'd_', 'agendamentos_sheet_raw']);
    return {
        status: 'success',
        agendamento: {
            id: String(id), vendedor: fields.Vendedor, cliente: fields.Cliente, cidade: fields.Cidade,
            dataAgendada: fields.DataAgendada, observacao: fields.Observacao, status: fields.Status,
            visitaOrigemId: fields.VisitaOrigemId, data: fields.Data
        }
    };
}

export async function handleUpdateAgendamento(payload) {
    const user = await verifyUser(payload.user);
    const id = String(payload.id || '').trim();

    const headers = await getHeaders(SHEET_NAME);
    const rows = await getSheetObjects(SHEET_NAME);
    const rowIndex = rows.findIndex((r) => String(r.Id || r.ID || '') === id);
    if (rowIndex === -1) throw new Error('Agendamento não encontrado para atualização.');

    const current = rows[rowIndex];
    const findCurrentKey = (candidates) => Object.keys(current).find((k) => candidates.includes(k.toLowerCase().replace(/[^a-z]/g, '')));
    const keyMap = {
        status: findCurrentKey(['status']) || 'Status',
        dataAg: findCurrentKey(['dataagendada']) || 'DataAgendada',
        obs: findCurrentKey(['observacao']) || 'Observacao',
        vend: findCurrentKey(['vendedor']) || 'Vendedor'
    };
    if (!userOwnsRow({ Vendedor: current[keyMap.vend] }, user, 'agendamentos')) {
        throw new Error('Você não tem permissão para editar este agendamento.');
    }
    ensureTextLength(payload.observacao, 'Observação');

    if (payload.status !== undefined) current[keyMap.status] = payload.status;
    if (payload.dataAgendada !== undefined) current[keyMap.dataAg] = formatDateFromInput(payload.dataAgendada);
    if (payload.observacao !== undefined) current[keyMap.obs] = payload.observacao;

    await updateRow(SHEET_NAME, rowIndex + 2, headers.map((h) => (current[h] !== undefined ? current[h] : '')));
    clearCacheByPrefix(['ag_', 'd_', 'agendamentos_sheet_raw']);
    // Monta a resposta com o que já está em memória (current, já com os
    // campos atualizados aplicados acima) em vez de reler a aba inteira de
    // novo — mesmo formato que readAgendamentoRows produziria.
    const s = (k) => String((current[k] ?? '') || '');
    const cliKey = findCurrentKey(['cliente']) || 'Cliente';
    const cidKey = findCurrentKey(['cidade']) || 'Cidade';
    const origemKey = findCurrentKey(['visitaorigemid']) || 'VisitaOrigemId';
    const dataKey = findCurrentKey(['data']) || 'Data';
    const campOrigemKey = findCurrentKey(['campanhaorigemid']) || 'CampanhaOrigemId';
    return {
        status: 'success',
        agendamento: {
            id, vendedor: s(keyMap.vend), cliente: s(cliKey), cidade: s(cidKey),
            dataAgendada: s(keyMap.dataAg), observacao: s(keyMap.obs), status: s(keyMap.status) || 'Pendente',
            visitaOrigemId: s(origemKey), data: s(dataKey), campanhaOrigemId: s(campOrigemKey)
        }
    };
}

export async function handleDeleteAgendamento(payload) {
    const user = await ensureCanDelete(payload.user);
    const id = String(payload.id || '').trim();

    const rows = await getSheetObjects(SHEET_NAME);
    const rowIndex = rows.findIndex((r) => String(r.Id || r.ID || '') === id);
    if (rowIndex === -1) throw new Error('Agendamento não encontrado para exclusão.');

    await deleteRow(SHEET_NAME, rowIndex + 2);
    clearCacheByPrefix(['ag_', 'd_', 'agendamentos_sheet_raw']);
    return { status: 'success', message: 'Agendamento apagado.' };
}
