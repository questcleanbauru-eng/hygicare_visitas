import { getSheetObjects, getHeaders, appendRow, updateRow, deleteRow, withCache, clearCacheByPrefix } from '../sheets.js';
import { verifyUser, filterByUser, hasSyncColumn, parseDate, formatDateFromInput, userOwnsRow, resolveCreateId, ensureTextLength } from '../common.js';
import { ensureCanDelete } from './config.js';

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

function validateRequiredVisitFields(payload) {
    if (!payload.dataVisita) throw new Error('Data da visita é obrigatória.');
    if (!payload.horario) throw new Error('Horário é obrigatório.');
    if (!payload.cliente) throw new Error('Cliente é obrigatório.');
    if (!payload.cidade) throw new Error('Cidade é obrigatória.');
    if (!payload.areaAtuacao) throw new Error('Área de atuação é obrigatória.');
    ensureTextLength(payload.observacao, 'Observação');
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
    const user = await verifyUser(payload.user);
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
    const user = await verifyUser(payload.user);
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
    validateRequiredVisitFields(payload);

    const headers = await getHeaders('Visitas');

    // ID por timestamp (em vez de "maior ID existente + 1") evita duas visitas
    // criadas ao mesmo tempo por usuários diferentes colidirem no mesmo ID —
    // não há como travar a escrita de forma atômica via API do Sheets.
    const baseId = resolveCreateId(payload);
    const tiposToCreate = tiposVisita.slice(0, 3);
    if (payload._queueRetry) {
        const existing = await getSheetObjects('Visitas');
        const dupIds = tiposToCreate.map((_, index) => String(baseId + index))
            .filter((candidateId) => existing.some((r) => String(r.ID || '') === candidateId));
        if (dupIds.length) {
            const createdVisits = dupIds.map((dupId) => normalizeVisitRow(existing.find((r) => String(r.ID || '') === dupId)));
            return { status: 'success', visit: createdVisits[0], visits: createdVisits };
        }
    }
    const createdVisits = [];
    for (const [index, tipoVisita] of tiposToCreate.entries()) {
        const nextId = String(baseId + index);
        const currentPayload = { ...payload, tipoVisita };
        await appendRow('Visitas', buildVisitRow(headers, currentPayload, nextId));
        createdVisits.push(buildVisitResponse(currentPayload, nextId));
    }

    clearCacheByPrefix(['v_', 'vp_raw', 'd_']);
    return { status: 'success', visit: createdVisits[0], visits: createdVisits };
}

export async function handleUpdateVisit(payload) {
    const user = await verifyUser(payload.user);
    const id = String(payload.id || '').trim();

    const headers = await getHeaders('Visitas');
    const rows = await getSheetObjects('Visitas');
    const rowIndex = rows.findIndex((row) => String(row.ID || '') === id);
    if (rowIndex === -1) throw new Error('Visita nao encontrada para atualizacao.');
    const current = rows[rowIndex];
    if (!userOwnsRow(current, user, 'visits')) {
        throw new Error('Você não tem permissão para editar esta visita.');
    }

    const isAdmin = String(user.profile || '').trim().toLowerCase() === 'admin';
    // Só Admin pode reatribuir o dono da visita — vendedor/gerente mandando
    // um payload manipulado não consegue mudar isso, mesmo que a tela nunca
    // exponha esse campo pra eles.
    const finalPayload = isAdmin ? payload : {
        ...payload,
        vendedorGerente: current['Vendedor/Gerente'],
        gerencia: current['Gerência'] || current['Gerencia']
    };
    validateRequiredVisitFields(finalPayload);

    await updateRow('Visitas', rowIndex + 2, buildVisitRow(headers, finalPayload, id));
    clearCacheByPrefix(['v_', 'vp_raw', 'd_']);
    return { status: 'success', visit: buildVisitResponse(finalPayload, id) };
}

export async function handleDeleteVisit(payload) {
    const user = await ensureCanDelete(payload.user);
    const id = String(payload.id || '').trim();

    const rows = await getSheetObjects('Visitas');
    const rowIndex = rows.findIndex((row) => String(row.ID || '') === id);
    if (rowIndex === -1) throw new Error('Visita nao encontrada para exclusao.');

    await deleteRow('Visitas', rowIndex + 2);
    clearCacheByPrefix(['v_', 'vp_raw', 'd_']);
    return { status: 'success', message: 'Visita apagada.' };
}
