import {
    batchGetSheetObjects, getSheetObjects, getSheetWithHeaders, getHeaders, appendRow, updateRow,
    clearAndWriteColumn, sheetExists, withCache, clearCacheKeys
} from '../sheets.js';
import { ensureAdmin, parseDate } from '../common.js';
import { bumpCacheVersion, readEmailConfig } from './config.js';
import { hashPassword } from '../security.js';
import { logAudit } from '../audit.js';

const ADMIN_SHEETS = ['Vendedores', 'TiposVisita', 'Cidades', 'AreasAtuacao', 'PotenciaisCliente', 'Aplicacoes', 'Equipamentos'];

export async function handleGetAdminData(payload) {
    await ensureAdmin(payload.user);

    // Uma unica chamada batchGet pra todas as abas, em vez de uma chamada
    // separada por aba (mesma causa do 429 de quota vista no getFormData).
    const sheets = await withCache('admin_all', 300, () => batchGetSheetObjects(ADMIN_SHEETS));

    const users = sheets.Vendedores.map((u) => ({
        EmailLogin: u.EmailLogin || '', NomeVendedor: u.NomeVendedor || '', Gerencia: u.Gerencia || '',
        Perfil: u.Perfil || '', UltimoLogin: u.UltimoLogin || '', MetaVisitasMes: u.MetaVisitasMes || '',
        PermDelete: u.PermDelete || '', PermCriarPropostaFunil: u.PermCriarPropostaFunil || '', PermAcessoRadar: u.PermAcessoRadar || '',
        hasPin: !!String(u.PinHash || '').trim()
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
        equipamentos: sheets.Equipamentos.map((r) => r.Equipamento).filter(Boolean)
    };

    return { status: 'success', data: { users, notifications, lookups } };
}

const MIN_PASSWORD_LENGTH = 6;

function ensurePasswordStrength(senha) {
    if (String(senha || '').length < MIN_PASSWORD_LENGTH) {
        throw new Error(`A senha precisa ter pelo menos ${MIN_PASSWORD_LENGTH} caracteres.`);
    }
}

const VENDEDORES_EXTRA_COLUMNS = ['MetaVisitasMes', 'PermDelete', 'PermCriarPropostaFunil', 'PermAcessoRadar'];

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
    const originalEmail = String(payload.originalEmail || '').trim().toLowerCase();

    await ensureVendedoresExtraColumns();
    const headers = await getHeaders('Vendedores');
    const rows = await getSheetObjects('Vendedores');
    let auditAction = 'editou';
    const metaVisitasMes = payload.metaVisitasMes !== undefined && payload.metaVisitasMes !== ''
        ? Number(payload.metaVisitasMes) : undefined;

    if (originalEmail) {
        const rowIndex = rows.findIndex((row) => String(row.EmailLogin || '').trim().toLowerCase() === originalEmail);
        if (rowIndex === -1) throw new Error('Usuario nao encontrado para atualizacao.');
        if (payload.senha) ensurePasswordStrength(payload.senha);
        const existingSenha = rows[rowIndex].Senha || '';
        const userRow = {
            EmailLogin: payload.emailLogin, NomeVendedor: payload.nomeVendedor,
            Senha: payload.senha ? hashPassword(payload.senha) : existingSenha, Gerencia: payload.gerencia, Perfil: payload.perfil,
            MetaVisitasMes: metaVisitasMes !== undefined ? metaVisitasMes : (rows[rowIndex].MetaVisitasMes || ''),
            PermDelete: payload.permDelete !== undefined ? normalizePermOverride(payload.permDelete) : (rows[rowIndex].PermDelete || ''),
            PermCriarPropostaFunil: payload.permCriarPropostaFunil !== undefined ? normalizePermOverride(payload.permCriarPropostaFunil) : (rows[rowIndex].PermCriarPropostaFunil || ''),
            PermAcessoRadar: payload.permAcessoRadar !== undefined ? normalizePermOverride(payload.permAcessoRadar) : (rows[rowIndex].PermAcessoRadar || '')
        };
        await updateRow('Vendedores', rowIndex + 2, headers.map((h) => userRow[h] || ''));
    } else {
        if (!payload.senha) throw new Error('Senha obrigatoria para novo usuario.');
        ensurePasswordStrength(payload.senha);
        auditAction = 'criou';
        const userRow = {
            EmailLogin: payload.emailLogin, NomeVendedor: payload.nomeVendedor,
            Senha: hashPassword(payload.senha), Gerencia: payload.gerencia, Perfil: payload.perfil,
            MetaVisitasMes: metaVisitasMes !== undefined ? metaVisitasMes : '',
            PermDelete: normalizePermOverride(payload.permDelete),
            PermCriarPropostaFunil: normalizePermOverride(payload.permCriarPropostaFunil),
            PermAcessoRadar: normalizePermOverride(payload.permAcessoRadar)
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

export async function handleSaveLookupList(payload) {
    await ensureAdmin(payload.user);
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
