import { getSheetObjects, getHeaders, appendRow, updateRow, deleteRow, deleteRows, withCache, clearCacheByPrefix } from '../sheets.js';
import { verifyUser, filterByUser, hasSyncColumn, parseDate, formatDate, formatTime, formatDateFromInput, userOwnsRow, resolveCreateId, ensureTextLength } from '../common.js';
import { ensureCanDelete, ensureCanCreateProposalFunil } from './config.js';
import { logAudit } from '../audit.js';

// Mesmo padrão de ensureFunilAtualizacaoColumn (lib/handlers/funil.js): cria
// a(s) coluna(s) na planilha se ainda não existirem, em vez de exigir que o
// admin mexa na planilha na mão. FunilVinculado é o vínculo Proposta <->
// Funil; NaoDuplicado marca "não é duplicado de verdade" pra sumir com o
// aviso ⚠️ Duplicado (cliente+foco iguais, mas é outro produto/negociação).
async function ensurePropostasExtraColumns() {
    await withCache('propostas_headers_ensured', 600, async () => {
        const headers = await getHeaders('Propostas');
        const missing = ['FunilVinculado', 'NaoDuplicado'].filter((h) => !headers.includes(h));
        if (missing.length) await updateRow('Propostas', 1, [...headers, ...missing]);
        return true;
    });
}

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
        Resumo: row.Resumo || '',
        FunilVinculado: row.FunilVinculado || '',
        NaoDuplicado: row.NaoDuplicado || '',
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
        // Leitura crua compartilhada (não por-usuário) — mesmo motivo de Visitas.
        const rawProposals = await withCache('propostas_sheet_raw', 60, () => getSheetObjects('Propostas'));
        const all = filterByUser(rawProposals.map(normalizeProposalRow), user, 'proposals');
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
        filterByUser((await withCache('propostas_sheet_raw', 60, () => getSheetObjects('Propostas'))).map(normalizeProposalRow), user, 'proposals'));
    const found = proposals.find((p) => String(p.Id) === id);
    if (!found) throw new Error('Proposta nao encontrada.');
    return { status: 'success', proposal: found };
}

export async function handleCreateProposal(payload) {
    const user = await ensureCanCreateProposalFunil(payload.user);
    if (!payload.cliente) throw new Error('Cliente e obrigatorio.');
    ensureTextLength(payload.obs, 'Observação');

    const headers = await getHeaders('Propostas');
    // ID por timestamp evita colisão entre duas propostas criadas ao mesmo
    // tempo por usuários diferentes (Sheets API não tem escrita atômica).
    const id = resolveCreateId(payload);
    if (payload._queueRetry) {
        const existing = await getSheetObjects('Propostas');
        const dup = existing.find((r) => String(r.Id || '') === String(id));
        if (dup) return { status: 'success', proposal: normalizeProposalRow(dup) };
    }
    const now = new Date();
    const today = formatDate(now);

    const dataLimite30 = new Date();
    dataLimite30.setDate(dataLimite30.getDate() + 30);

    // Admin pode lançar a Proposta em nome de outro vendedor (igual à Nova
    // Visita e ao Novo Funil) — mantém o nome escolhido e puxa a gerência
    // dele da aba Vendedores; qualquer outro perfil continua travado no
    // próprio nome.
    const isAdmin = String(user.profile || '').trim().toLowerCase() === 'admin';
    const escolhido = String(payload.vendedor || '').trim();
    let vendedorFinal = user.name;
    let gerenciaFinal = user.gerencia;
    if (isAdmin && escolhido && escolhido.toLowerCase() !== String(user.name || '').trim().toLowerCase()) {
        const vendedores = await withCache('vendedores_all', 300, () => getSheetObjects('Vendedores'));
        const match = vendedores.find((v) => String(v.NomeVendedor || '').trim().toLowerCase() === escolhido.toLowerCase());
        vendedorFinal = match ? match.NomeVendedor : escolhido;
        gerenciaFinal = match ? (match.Gerencia || user.gerencia) : user.gerencia;
    }

    const rowData = {
        Id: id,
        Data: today,
        Vendedor: vendedorFinal,
        Cliente: payload.cliente,
        Foco: payload.foco || '',
        Produtos: payload.produtos || '',
        Gerencia: gerenciaFinal,
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
    clearCacheByPrefix(['p_', 'vp_raw', 'd_', 'propostas_sheet_raw']);
    await logAudit(user, 'criou', 'proposta', id, payload.cliente);
    return { status: 'success', proposal: normalizeProposalRow(rowData) };
}

export async function handleUpdateProposal(payload) {
    const user = await verifyUser(payload.user);
    const id = String(payload.id || '').trim();

    if (payload.funilVinculado !== undefined) await ensurePropostasExtraColumns();
    const headers = await getHeaders('Propostas');
    const rows = await getSheetObjects('Propostas');
    const rowIndex = rows.findIndex((row) => String(row.Id || '') === id);
    if (rowIndex === -1) throw new Error('Proposta nao encontrada para atualizacao.');
    if (!userOwnsRow(rows[rowIndex], user, 'proposals')) {
        throw new Error('Você não tem permissão para editar esta proposta.');
    }
    ensureTextLength(payload.obs, 'Observação');

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
    // Admin pode editar todos os campos da proposta (mesmo padrão já usado em
    // Visitas para Vendedor/Gerente) — checado no servidor via user.profile,
    // não confiando em flag vinda do cliente.
    if (String(user.profile || '').trim().toLowerCase() === 'admin') {
        current.Cliente = payload.cliente || current.Cliente;
        current.Cidade = payload.cidade || current.Cidade;
        current.Vendedor = payload.vendedor || current.Vendedor;
        current.Gerencia = payload.gerencia || current.Gerencia;
        current.Foco = payload.foco || current.Foco;
        current.Produtos = payload.produtos || current.Produtos;
        current.Data = payload.data ? formatDateFromInput(payload.data) : current.Data;
        current['Data Limite'] = payload.dataLimite ? formatDateFromInput(payload.dataLimite) : formatDate(dataLimite30);
        current['E-mail'] = payload.email || current['E-mail'];
    } else {
        current['Data Limite'] = formatDate(dataLimite30);
    }
    current.SyncTimestamp = Date.now();
    // Vínculo com Funil (ver handleUpdateFunil/PropostaVinculada) — string
    // vazia é "desvincular", decisão explícita, por isso checa undefined.
    if (payload.funilVinculado !== undefined) current.FunilVinculado = payload.funilVinculado;

    await updateRow('Propostas', rowIndex + 2, headers.map((h) => (current[h] !== undefined ? current[h] : '')));
    clearCacheByPrefix(['p_', 'vp_raw', 'd_', 'propostas_sheet_raw']);
    await logAudit(user, 'editou', 'proposta', id, current.Cliente);
    return { status: 'success', proposal: current };
}

// Marca "não é duplicado de verdade" — a detecção de ⚠️ Duplicado (cliente
// + foco iguais) é só uma heurística no front, sem distinguir "mesmo
// negócio repetido por engano" de "outro produto/negociação legítima pro
// mesmo cliente+foco". Isso dá pro usuário dispensar o aviso caso a caso,
// sem mexer em Status/Atualização/Hora (ação isolada, não é uma edição de
// verdade da proposta).
export async function handleMarkPropostaNaoDuplicado(payload) {
    const user = await verifyUser(payload.user);
    const id = String(payload.id || '').trim();
    await ensurePropostasExtraColumns();
    const headers = await getHeaders('Propostas');
    const rows = await getSheetObjects('Propostas');
    const rowIndex = rows.findIndex((row) => String(row.Id || '') === id);
    if (rowIndex === -1) throw new Error('Proposta não encontrada.');
    if (!userOwnsRow(rows[rowIndex], user, 'proposals')) {
        throw new Error('Você não tem permissão para editar esta proposta.');
    }
    const current = rows[rowIndex];
    current.NaoDuplicado = payload.naoDuplicado ? 'Sim' : '';
    await updateRow('Propostas', rowIndex + 2, headers.map((h) => (current[h] !== undefined ? current[h] : '')));
    clearCacheByPrefix(['p_', 'vp_raw', 'd_', 'propostas_sheet_raw']);
    return { status: 'success' };
}

export async function handleDeleteProposal(payload) {
    const user = await ensureCanDelete(payload.user);
    const id = String(payload.id || '').trim();

    const rows = await getSheetObjects('Propostas');
    const rowIndex = rows.findIndex((row) => String(row.Id || '') === id);
    if (rowIndex === -1) throw new Error('Proposta nao encontrada para exclusao.');
    const cliente = rows[rowIndex].Cliente || '';

    await deleteRow('Propostas', rowIndex + 2);
    clearCacheByPrefix(['p_', 'vp_raw', 'd_', 'propostas_sheet_raw']);
    await logAudit(user, 'apagou', 'proposta', id, cliente);
    return { status: 'success', message: 'Proposta apagada.' };
}

// Apaga várias de uma vez (limpar duplicados de reimportação, principalmente).
// Lê a aba uma vez, resolve todas as linhas e manda um único batchUpdate —
// apagar uma por uma em paralelo embaralharia os índices (cada delete desloca
// as linhas de baixo), e em série gastaria 3 chamadas por registro.
export async function handleDeleteProposalBatch(payload) {
    const user = await ensureCanDelete(payload.user);
    const ids = new Set((payload.ids || []).map((x) => String(x || '').trim()).filter(Boolean));
    if (!ids.size) throw new Error('Nenhum registro selecionado.');
    if (ids.size > 200) throw new Error('Selecione no máximo 200 registros por vez.');

    const rows = await getSheetObjects('Propostas');
    const targets = [];
    rows.forEach((r, i) => {
        const id = String(r.Id || '');
        if (!ids.has(id)) return;
        targets.push({ id, rowNumber: i + 2, cliente: r.Cliente || '' });
    });
    if (!targets.length) throw new Error('Nenhum dos registros foi encontrado (já apagados?).');

    await deleteRows('Propostas', targets.map((t) => t.rowNumber));
    clearCacheByPrefix(['p_', 'vp_raw', 'd_', 'propostas_sheet_raw']);
    for (const t of targets) await logAudit(user, 'apagou', 'proposta', t.id, t.cliente);
    return { status: 'success', deleted: targets.map((t) => t.id), message: `${targets.length} registro(s) apagado(s).` };
}
