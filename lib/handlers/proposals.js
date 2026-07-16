import { getSheetObjects, getHeaders, appendRow, updateRow, deleteRow, withCache, clearCacheKeys } from '../sheets.js';
import { verifyUser, filterByUser, hasSyncColumn, parseDate, formatDate, formatTime } from '../common.js';
import { ensureCanDelete, ensureCanCreateProposalFunil } from './config.js';

export function normalizeProposalRow(row) {
    return {
        Id: String(row.Id || ''),
        Data: row.Data || '',
        Vendedor: row.Vendedor || '',
        Cliente: row.Cliente || '',
        Foco: row.Foco || '',
        Produtos: row.Produtos || '',
        Gerencia: row.Gerencia || '',
        Cidade: row.Cidade || '',
        Status: row.Status || '',
        'Atualização': row['Atualização'] || row['Atualizacao'] || '',
        Hora: row.Hora || '',
        'Atualizar/OBS': row['Observação'] || row['Observacao'] || row['Atualizar/OBS'] || '',
        'Data Limite': row['Data Limite'] || '',
        'E-mail': row['E-mail'] || row.Email || '',
        'SyncTimestamp': Number(row.SyncTimestamp) || 0
    };
}

export async function handleGetProposals(payload) {
    const requestStartedAt = Date.now();
    const user = await verifyUser(payload.user);
    const dias = typeof payload.dias === 'number' ? payload.dias : (typeof payload.meses === 'number' ? payload.meses * 30 : 30);
    const scope = dias === 0 ? 'all' : dias + 'd';
    const cacheKey = dias === 0 ? 'p_' + user.email + '_all' : 'p_' + user.email + '_3m';

    let proposals = await withCache(cacheKey, 180, async () => {
        const all = filterByUser((await getSheetObjects('Propostas')).map(normalizeProposalRow), user, 'proposals');
        if (dias === 0) return all;
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - dias);
        cutoff.setHours(0, 0, 0, 0);
        return all.filter((p) => { const d = parseDate(p.Data); return d !== null && d >= cutoff; });
    });

    const syncReady = await hasSyncColumn('Propostas');
    if (syncReady && typeof payload.since === 'number' && payload.since > 0) {
        proposals = proposals.filter((p) => (p.SyncTimestamp || 0) > payload.since);
    }
    return syncReady
        ? { status: 'success', proposals, scope, serverNow: requestStartedAt }
        : { status: 'success', proposals, scope };
}

export async function handleGetProposalById(payload) {
    const user = await verifyUser(payload.user);
    const id = String(payload.id || '').trim();
    const proposals = await withCache('p_' + user.email, 180, async () =>
        filterByUser((await getSheetObjects('Propostas')).map(normalizeProposalRow), user, 'proposals'));
    const found = proposals.find((p) => String(p.Id) === id);
    if (!found) throw new Error('Proposta nao encontrada.');
    return { status: 'success', proposal: found };
}

export async function handleCreateProposal(payload) {
    const user = await ensureCanCreateProposalFunil(payload.user);
    if (!payload.cliente) throw new Error('Cliente e obrigatorio.');

    const headers = await getHeaders('Propostas');
    // ID por timestamp evita colisão entre duas propostas criadas ao mesmo
    // tempo por usuários diferentes (Sheets API não tem escrita atômica).
    const id = Date.now();
    const now = new Date();
    const today = formatDate(now);

    const dataLimite30 = new Date();
    dataLimite30.setDate(dataLimite30.getDate() + 30);

    const rowData = {
        Id: id,
        Data: today,
        Vendedor: user.name,
        Cliente: payload.cliente,
        Foco: payload.foco || '',
        Produtos: payload.produtos || '',
        Gerencia: user.gerencia,
        Cidade: payload.cidade || '',
        Status: payload.status || 'Enviada',
        'Atualização': today,
        Hora: formatTime(now),
        'Atualizar/OBS': payload.obs || '',
        'Observação': payload.obs || '',
        'Observacao': payload.obs || '',
        'Data Limite': formatDate(dataLimite30),
        'E-mail': user.email,
        'SyncTimestamp': Date.now()
    };

    await appendRow('Propostas', headers.map((h) => (rowData[h] !== undefined ? rowData[h] : '')));
    clearCacheKeys(['p_' + user.email, 'p_' + user.email + '_3m', 'p_' + user.email + '_all', 'd_' + user.email]);
    return { status: 'success', proposal: normalizeProposalRow(rowData) };
}

export async function handleUpdateProposal(payload) {
    const user = await verifyUser(payload.user);
    const id = String(payload.id || '').trim();

    const headers = await getHeaders('Propostas');
    const rows = await getSheetObjects('Propostas');
    const rowIndex = rows.findIndex((row) => String(row.Id || '') === id);
    if (rowIndex === -1) throw new Error('Proposta nao encontrada para atualizacao.');

    const dataLimite30 = new Date();
    dataLimite30.setDate(dataLimite30.getDate() + 30);
    const now = new Date();

    const current = rows[rowIndex];
    current.Status = payload.status || current.Status;
    current['Atualizar/OBS'] = payload.obs || current['Atualizar/OBS'];
    current['Observação'] = payload.obs || current['Observação'] || '';
    current['Observacao'] = payload.obs || current['Observacao'] || '';
    current['Atualização'] = formatDate(now);
    current.Hora = formatTime(now);
    current['Data Limite'] = formatDate(dataLimite30);
    current.SyncTimestamp = Date.now();

    await updateRow('Propostas', rowIndex + 2, headers.map((h) => (current[h] !== undefined ? current[h] : '')));
    clearCacheKeys(['p_' + user.email, 'p_' + user.email + '_3m', 'p_' + user.email + '_all', 'd_' + user.email]);
    return { status: 'success', proposal: current };
}

export async function handleDeleteProposal(payload) {
    const user = await ensureCanDelete(payload.user);
    const id = String(payload.id || '').trim();

    const rows = await getSheetObjects('Propostas');
    const rowIndex = rows.findIndex((row) => String(row.Id || '') === id);
    if (rowIndex === -1) throw new Error('Proposta nao encontrada para exclusao.');

    await deleteRow('Propostas', rowIndex + 2);
    clearCacheKeys(['p_' + user.email, 'p_' + user.email + '_3m', 'p_' + user.email + '_all', 'd_' + user.email]);
    return { status: 'success', message: 'Proposta apagada.' };
}
