import {
    batchGetSheetObjects, getSheetObjects, getSheetWithHeaders, getHeaders, appendRow, updateRow,
    updateCell, deleteRow, clearAndWriteColumn, clearAndWriteTable, sheetExists, withCache, clearCacheKeys
} from '../sheets.js';
import { ensureAdmin, parseDate, resolveCreateId } from '../common.js';
import { bumpCacheVersion, readEmailConfig } from './config.js';
import { hashPassword } from '../security.js';
import { logAudit } from '../audit.js';

const ADMIN_SHEETS = ['Vendedores', 'TiposVisita', 'Cidades', 'AreasAtuacao', 'PotenciaisCliente', 'Aplicacoes', 'Equipamentos'];

export async function handleGetAdminData(payload) {
    await ensureAdmin(payload.user);

    // Garante que todo vendedor tem Id antes de montar a lista que a tela
    // de usuários usa pra identificar cada linha — sem isso a tela nunca
    // teria Id pra mandar de volta nas ações (editar, PIN, ativar, excluir).
    await ensureVendedorIds();

    // Uma unica chamada batchGet pra todas as abas, em vez de uma chamada
    // separada por aba (mesma causa do 429 de quota vista no getFormData).
    const sheets = await withCache('admin_all', 300, () => batchGetSheetObjects(ADMIN_SHEETS));

    const users = sheets.Vendedores.map((u) => ({
        Id: u.Id || '', EmailLogin: u.EmailLogin || '', NomeVendedor: u.NomeVendedor || '', NomeLogin: u.NomeLogin || '', Gerencia: u.Gerencia || '',
        Perfil: u.Perfil || '', UltimoLogin: u.UltimoLogin || '', MetaVisitasMes: u.MetaVisitasMes || '',
        PermDelete: u.PermDelete || '', PermCriarPropostaFunil: u.PermCriarPropostaFunil || '', PermAcessoRadar: u.PermAcessoRadar || '',
        PermVerTodasVisitas: u.PermVerTodasVisitas || '',
        hasPin: !!String(u.PinHash || '').trim(),
        // Vazio/qualquer coisa = ativo; só 'Nao' desativa (sem migração).
        ativo: String(u.Ativo || '').trim().toLowerCase() !== 'nao',
        telasBloqueadas: String(u.TelasBloqueadas || '').split(',').map((s) => s.trim()).filter(Boolean)
    }));

    const notifications = sheets.TiposVisita.map((row) => ({
        tipo: row.Tipo || '', telefoneDestino: row.TelefoneDestino || '',
        mensagemPadrao: row.MensagemPadrao || '',
        obrigatorio: String(row.Obrigatorio || '').trim().toLowerCase() === 'sim'
    }));

    const lookups = {
        cidades: sheets.Cidades.map((r) => r.Cidade).filter(Boolean),
        areasAtuacao: sheets.AreasAtuacao.map((r) => r.Area).filter(Boolean),
        potenciaisCliente: sheets.PotenciaisCliente.map((r) => r.Potencial).filter(Boolean),
        aplicacoes: sheets.Aplicacoes.map((r) => r.Aplicacao).filter(Boolean),
        equipamentos: sheets.Equipamentos.map((r) => r.Equipamento).filter(Boolean),
        tiposVisita: sheets.TiposVisita.map((r) => r.Tipo).filter(Boolean)
    };

    return { status: 'success', data: { users, notifications, lookups } };
}

function ensurePasswordStrength(senha) {
    if (!/^\d{4}$/.test(String(senha || ''))) {
        throw new Error('A senha precisa ter exatamente 4 números.');
    }
}

const VENDEDORES_EXTRA_COLUMNS = ['Id', 'MetaVisitasMes', 'PermDelete', 'PermCriarPropostaFunil', 'PermAcessoRadar', 'PermVerTodasVisitas', 'TelasBloqueadas', 'Ativo', 'NomeLogin'];

// Telas que o admin pode esconder por usuário (fora daqui: Início nunca
// bloqueia — é a home; Radar/Admin já têm seus próprios controles).
const PAGINAS_CONTROLAVEIS = ['visits', 'calendar', 'proposals', 'funil', 'contratos', 'manutencao', 'report'];

// Aceita array (["visits","funil"]) ou string "visits,funil" vinda do
// cliente; filtra qualquer valor que não seja uma tela controlável de
// verdade, pra um payload manipulado não conseguir gravar lixo na planilha.
function normalizeTelasBloqueadas(value) {
    const arr = Array.isArray(value) ? value : String(value || '').split(',');
    const clean = arr.map((s) => String(s || '').trim()).filter((s) => PAGINAS_CONTROLAVEIS.includes(s));
    return Array.from(new Set(clean)).join(',');
}

async function ensureVendedoresExtraColumns() {
    await withCache('vendedores_extra_ensured', 600, async () => {
        const headers = await getHeaders('Vendedores');
        const missing = VENDEDORES_EXTRA_COLUMNS.filter((h) => !headers.includes(h));
        if (missing.length) {
            await updateRow('Vendedores', 1, [...headers, ...missing]);
        }
        return true;
    });
}

// A planilha nasceu sem Id — vendedor sempre foi identificado só pelo
// e-mail, que também é editável no mesmo formulário. Isso significa que
// editar/apagar/trocar o PIN de um usuário dependia do e-mail bater
// exatamente, e duas linhas com e-mail igual (import malfeito, etc.)
// ficariam impossíveis de diferenciar. Backfill é lazy — roda toda vez que
// a tela de usuários carrega, mas não escreve nada se já não houver linha
// sem Id (idempotente, custo real só na primeira vez).
async function ensureVendedorIds() {
    await ensureVendedoresExtraColumns();
    const headers = await getHeaders('Vendedores');
    const idCol = headers.indexOf('Id');
    if (idCol === -1) return;
    const rows = await getSheetObjects('Vendedores');
    const missingRowIndexes = [];
    rows.forEach((r, i) => { if (!String(r.Id || '').trim()) missingRowIndexes.push(i); });
    if (!missingRowIndexes.length) return;
    const base = Date.now();
    await Promise.all(missingRowIndexes.map((rowIndex, offset) => updateCell('Vendedores', rowIndex + 2, idCol + 1, String(base + offset))));
}

// '' = sem override (usa a config global); 'Sim'/'Nao' = override explicito
// pra esse usuario. Qualquer outro valor recebido (payload manipulado) vira ''.
function normalizePermOverride(value) {
    const v = String(value || '').trim().toLowerCase();
    if (v === 'sim') return 'Sim';
    if (v === 'nao' || v === 'não') return 'Nao';
    return '';
}

export async function handleSaveUser(payload) {
    const admin = await ensureAdmin(payload.user);
    const id = String(payload.id || '').trim();
    const originalEmail = String(payload.originalEmail || '').trim().toLowerCase();

    await ensureVendedoresExtraColumns();
    const headers = await getHeaders('Vendedores');
    const rows = await getSheetObjects('Vendedores');
    let auditAction = 'editou';
    const metaVisitasMes = payload.metaVisitasMes !== undefined && payload.metaVisitasMes !== ''
        ? Number(payload.metaVisitasMes) : undefined;

    if (id || originalEmail) {
        // Prioriza o Id (estável, não muda se o e-mail for editado no mesmo
        // salvamento) — cai pro e-mail original só se não vier Id (payload
        // de uma sessão antiga que ainda não recarregou a tela).
        const rowIndex = id
            ? rows.findIndex((row) => String(row.Id || '').trim() === id)
            : rows.findIndex((row) => String(row.EmailLogin || '').trim().toLowerCase() === originalEmail);
        if (rowIndex === -1) throw new Error('Usuario nao encontrado para atualizacao.');
        if (payload.senha) ensurePasswordStrength(payload.senha);
        const existingSenha = rows[rowIndex].Senha || '';
        // Parte de rows[rowIndex] (a linha inteira como já está na planilha)
        // em vez de um objeto novo só com os campos deste form — senão
        // updateRow reescreve a linha toda e qualquer coluna que este
        // handler não conhece (PinHash, PinFalhas, PinBloqueioAte,
        // UltimoLogin...) ia pra "" no processo. Foi exatamente isso que
        // apagava o PIN sempre que o admin salvava qualquer outra edição
        // do usuário depois de cadastrar o PIN.
        const userRow = {
            ...rows[rowIndex],
            EmailLogin: payload.emailLogin, NomeVendedor: payload.nomeVendedor,
            NomeLogin: payload.nomeLogin !== undefined ? payload.nomeLogin.trim() : (rows[rowIndex].NomeLogin || ''),
            Senha: payload.senha ? hashPassword(payload.senha) : existingSenha, Gerencia: payload.gerencia, Perfil: payload.perfil,
            MetaVisitasMes: metaVisitasMes !== undefined ? metaVisitasMes : (rows[rowIndex].MetaVisitasMes || ''),
            PermDelete: payload.permDelete !== undefined ? normalizePermOverride(payload.permDelete) : (rows[rowIndex].PermDelete || ''),
            PermCriarPropostaFunil: payload.permCriarPropostaFunil !== undefined ? normalizePermOverride(payload.permCriarPropostaFunil) : (rows[rowIndex].PermCriarPropostaFunil || ''),
            PermAcessoRadar: payload.permAcessoRadar !== undefined ? normalizePermOverride(payload.permAcessoRadar) : (rows[rowIndex].PermAcessoRadar || ''),
            PermVerTodasVisitas: payload.permVerTodasVisitas !== undefined ? normalizePermOverride(payload.permVerTodasVisitas) : (rows[rowIndex].PermVerTodasVisitas || ''),
            TelasBloqueadas: payload.telasBloqueadas !== undefined ? normalizeTelasBloqueadas(payload.telasBloqueadas) : (rows[rowIndex].TelasBloqueadas || ''),
            Ativo: rows[rowIndex].Ativo || ''
        };
        await updateRow('Vendedores', rowIndex + 2, headers.map((h) => userRow[h] || ''));
    } else {
        if (!payload.senha) throw new Error('Senha obrigatoria para novo usuario.');
        ensurePasswordStrength(payload.senha);
        auditAction = 'criou';
        const userRow = {
            Id: String(resolveCreateId(payload)),
            EmailLogin: payload.emailLogin, NomeVendedor: payload.nomeVendedor,
            NomeLogin: (payload.nomeLogin || '').trim(),
            Senha: hashPassword(payload.senha), Gerencia: payload.gerencia, Perfil: payload.perfil,
            MetaVisitasMes: metaVisitasMes !== undefined ? metaVisitasMes : '',
            PermDelete: normalizePermOverride(payload.permDelete),
            PermCriarPropostaFunil: normalizePermOverride(payload.permCriarPropostaFunil),
            PermAcessoRadar: normalizePermOverride(payload.permAcessoRadar),
            PermVerTodasVisitas: normalizePermOverride(payload.permVerTodasVisitas),
            TelasBloqueadas: normalizeTelasBloqueadas(payload.telasBloqueadas),
            Ativo: 'Sim'
        };
        await appendRow('Vendedores', headers.map((h) => userRow[h] || ''));
    }

    clearCacheKeys([
        'admin_all',
        'user_verify_' + String(payload.emailLogin || '').trim().toLowerCase(),
        'user_verify_' + originalEmail
    ]);
    await logAudit(admin, auditAction, 'usuario', payload.emailLogin, payload.nomeVendedor);
    return { status: 'success', message: 'Usuario salvo.' };
}

// Abas onde um vendedor deixa rastro — se ele aparecer em qualquer uma,
// a conta não pode ser EXCLUÍDA (só desativada), pra não órfãos no histórico.
const HISTORY_SHEETS = ['Visitas', 'Propostas', 'Funil', 'Contratos', 'Manutencoes', 'RelatoriosTecnicos', 'Agendamentos'];

function rowMentionsUser(row, nome, email) {
    for (const k of Object.keys(row)) {
        const v = String(row[k] ?? '').trim().toLowerCase();
        if (!v) continue;
        if (nome && v === nome) return true;
        if (email && v === email) return true;
    }
    return false;
}

async function userHistorySheet(nome, email) {
    const n = String(nome || '').trim().toLowerCase();
    const e = String(email || '').trim().toLowerCase();
    if (!n && !e) return null;
    for (const sheet of HISTORY_SHEETS) {
        try {
            if (!(await sheetExists(sheet))) continue;
            const rows = await getSheetObjects(sheet);
            if (rows.some((r) => rowMentionsUser(r, n, e))) return sheet;
        } catch (err) { /* aba problemática não bloqueia */ }
    }
    return null;
}

// Localiza a linha do vendedor. Prioriza o Id (estável, não muda se o
// e-mail for editado depois e não colide se duas linhas tiverem o mesmo
// e-mail por engano) — cai pro e-mail só quando não vem Id nenhum (payload
// de uma aba/sessão antiga que ainda não recarregou a tela de usuários).
async function findUserRow({ id, email }) {
    await ensureVendedoresExtraColumns();
    const headers = await getHeaders('Vendedores');
    const rows = await getSheetObjects('Vendedores');
    const targetId = String(id || '').trim();
    const rowIndex = targetId
        ? rows.findIndex((r) => String(r.Id || '').trim() === targetId)
        : rows.findIndex((r) => String(r.EmailLogin || '').trim().toLowerCase() === email);
    return { headers, rows, rowIndex };
}

// Ativar/desativar um usuário. Desativado = não loga mais (verificado no
// login e no verifyUser), mas todos os registros dele continuam intactos.
export async function handleSetUserAtivo(payload) {
    const admin = await ensureAdmin(payload.user);
    const id = String(payload.id || '').trim();
    const email = String(payload.emailLogin || payload.originalEmail || '').trim().toLowerCase();
    if (!id && !email) throw new Error('Informe o usuário.');
    if (email && email === String(admin.email || '').trim().toLowerCase()) throw new Error('Você não pode desativar a própria conta.');

    const { headers, rows, rowIndex } = await findUserRow({ id, email });
    if (rowIndex === -1) throw new Error('Usuário não encontrado.');
    if (String(rows[rowIndex].EmailLogin || '').trim().toLowerCase() === String(admin.email || '').trim().toLowerCase()) {
        throw new Error('Você não pode desativar a própria conta.');
    }

    const ativo = String(payload.ativo || '').trim().toLowerCase() === 'nao' ? 'Nao' : 'Sim';
    const col = headers.indexOf('Ativo');
    if (col < 0) throw new Error('Coluna "Ativo" não encontrada na planilha.');
    await updateCell('Vendedores', rowIndex + 2, col + 1, ativo);

    clearCacheKeys(['admin_all', 'user_verify_' + String(rows[rowIndex].EmailLogin || '').trim().toLowerCase()]);
    await logAudit(admin, ativo === 'Nao' ? 'desativou' : 'reativou', 'usuario', rows[rowIndex].EmailLogin, rows[rowIndex].NomeVendedor);
    return { status: 'success', message: ativo === 'Nao' ? 'Usuário desativado.' : 'Usuário reativado.', ativo: ativo === 'Sim' };
}

// Exclui um usuário DE VEZ — bloqueado se ele tiver histórico (nesse caso o
// admin deve desativar). Nunca deixa excluir a própria conta.
export async function handleDeleteUser(payload) {
    const admin = await ensureAdmin(payload.user);
    const id = String(payload.id || '').trim();
    const email = String(payload.emailLogin || payload.originalEmail || '').trim().toLowerCase();
    if (!id && !email) throw new Error('Informe o usuário.');

    const { rowIndex, rows } = await findUserRow({ id, email });
    if (rowIndex === -1) throw new Error('Usuário não encontrado.');
    const alvo = rows[rowIndex];
    if (String(alvo.EmailLogin || '').trim().toLowerCase() === String(admin.email || '').trim().toLowerCase()) {
        throw new Error('Você não pode excluir a própria conta.');
    }

    const sheetComHistorico = await userHistorySheet(alvo.NomeVendedor, alvo.EmailLogin);
    if (sheetComHistorico) {
        return {
            status: 'error',
            code: 'HAS_HISTORY',
            historySheet: sheetComHistorico,
            message: `Esse usuário tem registros em "${sheetComHistorico}". Desative a conta em vez de excluir, pra não perder o histórico.`
        };
    }

    await deleteRow('Vendedores', rowIndex + 2);
    clearCacheKeys(['admin_all', 'user_verify_' + String(alvo.EmailLogin || '').trim().toLowerCase()]);
    await logAudit(admin, 'excluiu', 'usuario', alvo.EmailLogin, alvo.NomeVendedor);
    return { status: 'success', message: 'Usuário excluído.' };
}

export async function handleSaveNotificationConfig(payload) {
    await ensureAdmin(payload.user);
    const originalTipo = String(payload.originalTipo || '').trim().toLowerCase();

    const headers = await getHeaders('TiposVisita');
    const rows = await getSheetObjects('TiposVisita');
    const rowData = {
        Tipo: payload.tipo, TelefoneDestino: payload.telefoneDestino,
        MensagemPadrao: payload.mensagemPadrao, Obrigatorio: payload.obrigatorio ? 'Sim' : 'Não'
    };

    if (originalTipo) {
        const rowIndex = rows.findIndex((row) => String(row.Tipo || '').trim().toLowerCase() === originalTipo);
        if (rowIndex === -1) throw new Error('Tipo de visita nao encontrado para atualizacao.');
        await updateRow('TiposVisita', rowIndex + 2, headers.map((h) => rowData[h] || ''));
    } else {
        await appendRow('TiposVisita', headers.map((h) => rowData[h] || ''));
    }

    await bumpCacheVersion();
    clearCacheKeys(['admin_all', 'formdata_all', 'app_config']);
    return { status: 'success', message: 'Configuracao salva.' };
}

// Força todo mundo a rebuscar cidades/áreas/clientes/etc — pra quando o
// admin edita a planilha (ex.: aba Clientes) direto no Google Sheets, sem
// passar pelo app. Nesse caso nada aqui dentro chama bumpCacheVersion()
// sozinho, e o formData que cada vendedor já tem salvo no aparelho nunca
// percebe a mudança sem esse empurrão manual.
export async function handleForceRefreshData(payload) {
    await ensureAdmin(payload.user);
    await bumpCacheVersion();
    clearCacheKeys(['admin_all', 'formdata_all', 'app_config']);
    return { status: 'success', message: 'Atualização forçada — os dados vão ser rebuscados no próximo acesso de cada usuário.' };
}

export async function handleSaveLookupList(payload) {
    await ensureAdmin(payload.user);

    // TiposVisita não é uma lista de valor único — cada linha também guarda
    // TelefoneDestino/MensagemPadrao/Obrigatorio (roteamento de WhatsApp por
    // tipo). Reescrever só a coluna "Tipo" (como clearAndWriteColumn faz)
    // apagaria essas outras colunas pra toda a aba — por isso um caminho
    // separado que preserva o que já existe pra cada tipo mantido.
    if (payload.key === 'tiposVisita') {
        const nomes = (payload.values || []).map((v) => String(v || '').trim()).filter(Boolean);
        const existentes = await getSheetObjects('TiposVisita');
        const porNome = new Map(existentes.map((r) => [String(r.Tipo || '').trim().toLowerCase(), r]));
        const rows = nomes.map((nome) => {
            const prev = porNome.get(nome.toLowerCase());
            return [nome, prev?.TelefoneDestino || '', prev?.MensagemPadrao || '', prev?.Obrigatorio || ''];
        });
        await clearAndWriteTable('TiposVisita', ['Tipo', 'TelefoneDestino', 'MensagemPadrao', 'Obrigatorio'], rows);
        await bumpCacheVersion();
        clearCacheKeys(['admin_all', 'formdata_all', 'app_config']);
        return { status: 'success', message: 'Lista atualizada.' };
    }

    const mapping = {
        cidades: { sheet: 'Cidades', header: 'Cidade' },
        areasAtuacao: { sheet: 'AreasAtuacao', header: 'Area' },
        potenciaisCliente: { sheet: 'PotenciaisCliente', header: 'Potencial' },
        aplicacoes: { sheet: 'Aplicacoes', header: 'Aplicacao' },
        equipamentos: { sheet: 'Equipamentos', header: 'Equipamento' }
    };

    const config = mapping[payload.key];
    if (!config) throw new Error('Lista invalida.');

    await clearAndWriteColumn(config.sheet, config.header, payload.values || []);
    await bumpCacheVersion();
    clearCacheKeys(['admin_all', 'formdata_all', 'app_config']);
    return { status: 'success', message: 'Lista atualizada.' };
}

// Painel de saúde: dá pro admin ver de relance se o app tá "vivo" sem
// precisar abrir a planilha — usuários ativos recentemente, cota do
// geocoding do Radar, e tamanho de cada aba. As chaves de cache batem
// propositalmente com as que cada handler já usa (visitas_sheet_raw etc.) —
// se a aba já tiver sido lida há pouco por outra tela, aqui é cache-hit
// (sem custo extra de API), senão é só mais uma leitura normal.
async function countSheetSafe(sheetName, cacheKey) {
    try {
        if (!(await sheetExists(sheetName))) return 0;
        const { rows } = await withCache(cacheKey, 60, () => getSheetWithHeaders(sheetName));
        return rows.length;
    } catch (e) { return 0; }
}

export async function handleGetHealthPanel(payload) {
    await ensureAdmin(payload.user);

    const [config, vendedoresRaw] = await Promise.all([
        withCache('app_config', 600, () => readEmailConfig()),
        withCache('user_verify_all', 300, () => getSheetObjects('Vendedores'))
    ]);

    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    sevenDaysAgo.setHours(0, 0, 0, 0);
    const activeUsers = vendedoresRaw.filter((u) => {
        const d = parseDate(String(u.UltimoLogin || '').split(' ')[0]);
        return d && d >= sevenDaysAgo;
    }).length;

    const [visitas, propostas, funil, contratos, manutencoes] = await Promise.all([
        countSheetSafe('Visitas', 'visitas_sheet_raw'),
        countSheetSafe('Propostas', 'propostas_sheet_raw'),
        countSheetSafe('Funil', 'funil_sheet_raw'),
        countSheetSafe('Contratos', 'contratos_sheet_raw'),
        countSheetSafe('Manutencoes', 'manutencao_sheet_raw')
    ]);

    return {
        status: 'success',
        data: {
            totalUsuarios: vendedoresRaw.length,
            usuariosAtivos7d: activeUsers,
            radarGeocodingUsado: parseInt(config.radar_geocoding_usado_mes || '0', 10),
            radarGeocodingLimite: parseInt(config.radar_geocoding_limite_mensal || '0', 10),
            registros: { visitas, propostas, funil, contratos, manutencoes }
        }
    };
}
