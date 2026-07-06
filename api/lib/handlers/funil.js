import { getSheetObjects, getHeaders, appendRow, updateRow, withCache, clearCacheKeys } from '../sheets.js';
import { requireUser, verifyUser, filterByUser, getNextId, hasSyncColumn, parseDate, formatDate, formatDateFromInput } from '../common.js';

function findKey(headers, candidates) {
    const lower = headers.map((h) => String(h).trim().toLowerCase());
    for (const c of candidates) {
        const idx = lower.indexOf(c.toLowerCase().trim());
        if (idx > -1) return headers[idx];
    }
    return null;
}

// Lê o funil resolvendo os nomes de coluna reais uma vez (evita depender de
// grafias diferentes entre "Atualizacao"/"ATUALIZACAO"/etc.). Exportado
// porque o dashboard também precisa (sem filtro de dias).
export async function readFunilRows(user, dias) {
    const headers = await getHeaders('Funil');
    const rows = await getSheetObjects('Funil');
    if (!headers.length) return [];

    const key = {
        id: findKey(headers, ['Id', 'ID']),
        data: findKey(headers, ['Data', 'DATA']),
        ativ: findKey(headers, ['Ativo', 'ATIVO']),
        stat: findKey(headers, ['Status', 'STATUS']),
        vend: findKey(headers, ['Vendedor', 'VENDEDOR']),
        cli: findKey(headers, ['Cliente', 'CLIENTE']),
        cid: findKey(headers, ['Cidade', 'CIDADE']),
        foco: findKey(headers, ['Foco', 'FOCO']),
        atua: findKey(headers, ['Atuacao', 'ATUACAO']),
        apli: findKey(headers, ['Aplicacao', 'APLICACAO']),
        equip: findKey(headers, ['Equipamentos', 'EQUIPAMENTOS']),
        ger: findKey(headers, ['Gerencia', 'GERENCIA']),
        vl: findKey(headers, ['Vl Mensal', 'VL MENSAL R$', 'Valor Mensal']),
        conc: findKey(headers, ['Conclusao', 'CONCLUSAO']),
        inf: findKey(headers, ['Inf Importantes', 'INF IMPORTANTES']),
        com: findKey(headers, ['Comentarios', 'COMENTARIOS']),
        atualiz: findKey(headers, ['Atualizacao', 'ATUALIZACAO']),
        sync: findKey(headers, ['SyncTimestamp', 'SYNCTIMESTAMP'])
    };

    const v = (row, k) => (k ? (row[k] ?? '') : '');
    const s = (row, k) => String(v(row, k) || '');

    const parsed = rows.map((row) => {
        const dataVal = v(row, key.data);
        const atualizVal = v(row, key.atualiz);
        return {
            id: s(row, key.id),
            data: String(dataVal || ''),
            atualizacao: String(atualizVal || dataVal || ''),
            ativo: s(row, key.ativ),
            status: s(row, key.stat),
            vendedor: s(row, key.vend),
            cliente: s(row, key.cli),
            cidade: s(row, key.cid),
            foco: s(row, key.foco),
            atuacao: s(row, key.atua),
            aplicacao: s(row, key.apli),
            equipamentos: s(row, key.equip),
            gerencia: s(row, key.ger),
            vlMensal: s(row, key.vl),
            conclusao: String(v(row, key.conc) || ''),
            infImportantes: s(row, key.inf),
            comentarios: s(row, key.com),
            syncTimestamp: Number(v(row, key.sync)) || 0
        };
    });

    const filtered = filterByUser(parsed, user, 'funil');
    if (!dias || dias === 0) return filtered;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - dias);
    cutoff.setHours(0, 0, 0, 0);
    return filtered.filter((r) => { const d = parseDate(r.data); return d !== null && d >= cutoff; });
}

function buildFunilRowData(headers, fields) {
    return headers.map((h) => {
        const lh = h.toLowerCase().trim();
        const matchKey = Object.keys(fields).find((k) => k.toLowerCase().trim() === lh);
        return matchKey !== undefined ? fields[matchKey] : '';
    });
}

export function normalizeFunilRow(row) {
    const dataVal = row['Data'] || row['DATA'] || '';
    const atualizVal = row['Atualizacao'] || row['Atualização'] || row['ATUALIZACAO'] || '';
    return {
        id: String(row['Id'] || row['ID'] || ''),
        data: String(dataVal || ''),
        atualizacao: String(atualizVal || dataVal || ''),
        ativo: String(row['Ativo'] || row['ATIVO'] || ''),
        status: String(row['Status'] || row['STATUS'] || ''),
        vendedor: String(row['Vendedor'] || row['VENDEDOR'] || ''),
        cliente: String(row['Cliente'] || row['CLIENTE'] || ''),
        cidade: String(row['Cidade'] || row['CIDADE'] || ''),
        foco: String(row['Foco'] || row['FOCO'] || ''),
        atuacao: String(row['Atuacao'] || row['ATUACAO'] || row['Área de Atuação'] || row['Area de Atuacao'] || ''),
        aplicacao: String(row['Aplicacao'] || row['APLICACAO'] || row['Aplicação'] || ''),
        equipamentos: String(row['Equipamentos'] || row['EQUIPAMENTOS'] || ''),
        gerencia: String(row['Gerencia'] || row['GERENCIA'] || row['Gerência'] || ''),
        vlMensal: String(row['Vl Mensal'] || row['VL MENSAL R$'] || row['Vl Mensal R$'] || row['Valor Mensal'] || ''),
        conclusao: String(row['Conclusao'] || row['CONCLUSAO'] || row['Conclusão'] || ''),
        infImportantes: String(row['Inf Importantes'] || row['INF IMPORTANTES'] || ''),
        comentarios: String(row['Comentarios'] || row['COMENTARIOS'] || row['Comentários'] || ''),
        syncTimestamp: Number(row['SyncTimestamp'] || row['SYNCTIMESTAMP'] || 0)
    };
}

export async function handleGetFunil(payload) {
    const requestStartedAt = Date.now();
    const user = requireUser(payload.user);
    const dias = typeof payload.dias === 'number' ? payload.dias : (typeof payload.meses === 'number' ? payload.meses * 30 : 30);
    const scope = dias === 0 ? 'all' : dias + 'd';
    const cacheKey = dias === 0 ? 'f_' + user.email + '_all' : 'f_' + user.email + '_3m';

    let rows = await withCache(cacheKey, 180, () => readFunilRows(user, dias));

    const syncReady = await hasSyncColumn('Funil');
    if (syncReady && typeof payload.since === 'number' && payload.since > 0) {
        rows = rows.filter((r) => (r.syncTimestamp || 0) > payload.since);
    }
    return syncReady
        ? { status: 'success', funil: rows, scope, serverNow: requestStartedAt }
        : { status: 'success', funil: rows, scope };
}

export async function handleGetFunilById(payload) {
    const user = requireUser(payload.user);
    const id = String(payload.id || '').trim();
    const rows = await withCache('f_' + user.email, 180, () => readFunilRows(user));
    const found = rows.find((r) => String(r.id) === id);
    if (!found) throw new Error('Registro nao encontrado.');
    return { status: 'success', funil: found };
}

export async function handleCreateFunil(payload) {
    const user = await verifyUser(payload.user);
    if (!payload.cliente) throw new Error('Cliente e obrigatorio.');

    const headers = await getHeaders('Funil');
    const rows = await getSheetObjects('Funil');
    const id = getNextId(rows, 'Id');
    const today = formatDate(new Date());

    const fields = {
        'Id': id,
        'Data': today,
        'Atualizacao': today,
        'Ativo': 'Sim',
        'Status': payload.status || 'IDENTIFICAR',
        'Vendedor': user.name,
        'Cliente': payload.cliente,
        'Cidade': payload.cidade || '',
        'Foco': payload.foco || '',
        'Atuacao': payload.atuacao || '',
        'Aplicacao': payload.aplicacao || '',
        'Equipamentos': payload.equipamentos || '',
        'Gerencia': user.gerencia,
        'Vl Mensal': payload.vlMensal || '',
        'Conclusao': payload.conclusao ? formatDateFromInput(payload.conclusao) : '',
        'Inf Importantes': payload.infImportantes || '',
        'Comentarios': payload.comentarios || '',
        'SyncTimestamp': Date.now()
    };

    await appendRow('Funil', buildFunilRowData(headers, fields));
    clearCacheKeys(['f_' + user.email, 'f_' + user.email + '_3m', 'f_' + user.email + '_all', 'd_' + user.email]);
    return { status: 'success', funil: normalizeFunilRow(fields) };
}

export async function handleUpdateFunil(payload) {
    const user = await verifyUser(payload.user);
    const id = String(payload.id || '').trim();

    const headers = await getHeaders('Funil');
    const rows = await getSheetObjects('Funil');
    const rowIndex = rows.findIndex((r) => String(r.Id || r.ID || '') === id);
    if (rowIndex === -1) throw new Error('Registro nao encontrado para atualizacao.');

    const current = rows[rowIndex];
    const statusKey = Object.keys(current).find((k) => k.toLowerCase() === 'status') || 'Status';
    const vlKey = Object.keys(current).find((k) => k.toLowerCase().replace(/\s+/g, '') === 'vlmensal' || k.toLowerCase() === 'vl mensal r$') || 'Vl Mensal';
    const conclusaoKey = Object.keys(current).find((k) => k.toLowerCase().replace(/[^a-z]/g, '') === 'conclusao') || 'Conclusao';
    const infKey = Object.keys(current).find((k) => k.toLowerCase().replace(/\s/g, '') === 'infimportantes') || 'Inf Importantes';
    const comentKey = Object.keys(current).find((k) => k.toLowerCase().replace(/[^a-z]/g, '') === 'comentarios') || 'Comentarios';
    const atualizKey = Object.keys(current).find((k) => k.toLowerCase().replace(/[^a-z]/g, '') === 'atualizacao') || 'Atualizacao';
    const syncKey = Object.keys(current).find((k) => k.toLowerCase().replace(/[^a-z]/g, '') === 'synctimestamp') || 'SyncTimestamp';

    if (payload.status !== undefined) current[statusKey] = payload.status;
    if (payload.vlMensal !== undefined) current[vlKey] = payload.vlMensal;
    if (payload.conclusao !== undefined) current[conclusaoKey] = payload.conclusao;
    if (payload.infImportantes !== undefined) current[infKey] = payload.infImportantes;
    if (payload.comentarios !== undefined) current[comentKey] = payload.comentarios;
    current[atualizKey] = formatDate(new Date());
    current[syncKey] = Date.now();

    await updateRow('Funil', rowIndex + 2, headers.map((h) => (current[h] !== undefined ? current[h] : '')));
    clearCacheKeys(['f_' + user.email, 'f_' + user.email + '_3m', 'f_' + user.email + '_all', 'd_' + user.email]);
    return { status: 'success', funil: normalizeFunilRow(current) };
}

export async function handleDebugFunilHeaders(payload) {
    requireUser(payload.user);
    const headers = await getHeaders('Funil');
    const rows = await getSheetObjects('Funil');
    const firstRaw = rows[0] || {};
    const firstNorm = rows.length > 0 ? normalizeFunilRow(rows[0]) : {};
    const lkDebug = {};
    Object.keys(firstRaw).forEach((k) => { lkDebug[k.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim()] = k; });
    return { status: 'success', headers, firstRow: firstRaw, firstRowNormalized: firstNorm, lkIndex: lkDebug, rowCount: rows.length };
}
