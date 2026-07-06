import { getSheetObjects, getHeaders, appendRow, updateRow, withCache, clearCacheKeys } from '../sheets.js';
import { requireUser, verifyUser, filterByUser, getNextId, hasSyncColumn, parseDate, formatDateFromInput } from '../common.js';

export function normalizeVisitRow(row) {
    return {
        ID: String(row.ID || ''),
        'Prospecção': row['Prospecção'] || row['Prospeccao'] || '',
        'Vendedor/Gerente': row['Vendedor/Gerente'] || '',
        'Data da Visita': row['Data da Visita'] || '',
        'Horário': row['Horário'] || row['Horario'] || '',
        'Cliente': row['Cliente'] || '',
        'Contato': row['Contato'] || '',
        'Cidade': row['Cidade'] || '',
        'Área de Atuação': row['Área de Atuação'] || row['Area de Atuacao'] || '',
        'Potencial do Cliente': row['Potencial do Cliente'] || '',
        'Tipo da Visita': row['Tipo da Visita'] || '',
        'Gerência': row['Gerência'] || row['Gerencia'] || '',
        'Qual o Veículo?': row['Qual o Veículo?'] || row['Qual o Veiculo?'] || '',
        'Observação': row['Observação'] || row['Observacao'] || '',
        'SyncTimestamp': Number(row.SyncTimestamp) || 0
    };
}

function buildVisitRow(headers, payload, id) {
    const map = {
        'ID': id,
        'Prospecção': payload.prospeccao,
        'Prospeccao': payload.prospeccao,
        'Vendedor/Gerente': payload.vendedorGerente,
        'Data da Visita': formatDateFromInput(payload.dataVisita),
        'Horário': payload.horario,
        'Horario': payload.horario,
        'Cliente': payload.cliente,
        'Contato': payload.contato,
        'Cidade': payload.cidade,
        'Área de Atuação': payload.areaAtuacao,
        'Area de Atuacao': payload.areaAtuacao,
        'Potencial do Cliente': payload.potencialCliente,
        'Tipo da Visita': payload.tipoVisita,
        'Gerência': payload.gerencia,
        'Gerencia': payload.gerencia,
        'Qual o Veículo?': payload.veiculo,
        'Qual o Veiculo?': payload.veiculo,
        'Observação': payload.observacao,
        'Observacao': payload.observacao,
        'SyncTimestamp': Date.now()
    };
    return headers.map((header) => (map[header] !== undefined && map[header] !== null) ? map[header] : '');
}

function buildVisitResponse(payload, id) {
    return {
        ID: id,
        'Prospecção': payload.prospeccao,
        'Vendedor/Gerente': payload.vendedorGerente,
        'Data da Visita': formatDateFromInput(payload.dataVisita),
        'Horário': payload.horario,
        'Cliente': payload.cliente,
        'Contato': payload.contato,
        'Cidade': payload.cidade,
        'Área de Atuação': payload.areaAtuacao,
        'Potencial do Cliente': payload.potencialCliente,
        'Tipo da Visita': payload.tipoVisita,
        'Gerência': payload.gerencia,
        'Qual o Veículo?': payload.veiculo,
        'Observação': payload.observacao
    };
}

export async function handleGetVisits(payload) {
    const requestStartedAt = Date.now();
    const user = requireUser(payload.user);
    const dias = typeof payload.dias === 'number' ? payload.dias : (typeof payload.meses === 'number' ? payload.meses * 30 : 30);
    const scope = dias === 0 ? 'all' : dias + 'd';
    const cacheKey = dias === 0 ? 'v_' + user.email + '_all' : 'v_' + user.email + '_3m';

    let visits = await withCache(cacheKey, 180, async () => {
        const all = filterByUser((await getSheetObjects('Visitas')).map(normalizeVisitRow), user, 'visits');
        if (dias === 0) return all;
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - dias);
        cutoff.setHours(0, 0, 0, 0);
        return all.filter((v) => { const d = parseDate(v['Data da Visita']); return d !== null && d >= cutoff; });
    });

    const syncReady = await hasSyncColumn('Visitas');
    if (syncReady && typeof payload.since === 'number' && payload.since > 0) {
        visits = visits.filter((v) => (v.SyncTimestamp || 0) > payload.since);
    }
    return syncReady
        ? { status: 'success', visits, scope, serverNow: requestStartedAt }
        : { status: 'success', visits, scope };
}

export async function handleGetVisitById(payload) {
    const user = requireUser(payload.user);
    const id = String(payload.id || '').trim();
    const visits = await withCache('v_' + user.email, 180, async () =>
        filterByUser((await getSheetObjects('Visitas')).map(normalizeVisitRow), user, 'visits'));
    const found = visits.find((v) => String(v.ID) === id);
    if (!found) throw new Error('Visita nao encontrada.');
    return { status: 'success', visit: found };
}

export async function handleCreateVisit(payload) {
    const user = await verifyUser(payload.user);
    payload.vendedorGerente = user.name;
    payload.gerencia = user.gerencia;

    const tiposVisita = Array.isArray(payload.tiposVisita) && payload.tiposVisita.length
        ? payload.tiposVisita
        : [payload.tipoVisita].filter(Boolean);
    if (!tiposVisita.length) throw new Error('Informe pelo menos um tipo de visita.');

    const headers = await getHeaders('Visitas');
    const existingRows = await getSheetObjects('Visitas');

    const createdVisits = [];
    for (const [index, tipoVisita] of tiposVisita.slice(0, 3).entries()) {
        const nextId = String(Number(getNextId(existingRows, 'ID')) + index);
        const currentPayload = { ...payload, tipoVisita };
        await appendRow('Visitas', buildVisitRow(headers, currentPayload, nextId));
        createdVisits.push(buildVisitResponse(currentPayload, nextId));
    }

    clearCacheKeys(['v_' + user.email, 'v_' + user.email + '_3m', 'v_' + user.email + '_all', 'd_' + user.email]);
    return { status: 'success', visit: createdVisits[0], visits: createdVisits };
}

export async function handleUpdateVisit(payload) {
    const user = await verifyUser(payload.user);
    const id = String(payload.id || '').trim();

    const headers = await getHeaders('Visitas');
    const rows = await getSheetObjects('Visitas');
    const rowIndex = rows.findIndex((row) => String(row.ID || '') === id);
    if (rowIndex === -1) throw new Error('Visita nao encontrada para atualizacao.');

    await updateRow('Visitas', rowIndex + 2, buildVisitRow(headers, payload, id));
    clearCacheKeys(['v_' + user.email, 'v_' + user.email + '_3m', 'v_' + user.email + '_all', 'd_' + user.email]);
    return { status: 'success', visit: buildVisitResponse(payload, id) };
}
