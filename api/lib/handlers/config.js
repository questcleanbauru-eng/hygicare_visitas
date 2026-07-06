import { getSheetObjects, appendRow, updateCell, sheetExists, createSheet, withCache, clearCacheKeys } from '../sheets.js';
import { requireUser, ensureAdmin } from '../common.js';

function defaultEmailConfig() {
    return {
        load_dias: '30',
        propostas_ativas: 'false',
        propostas_dias: '30',
        propostas_assunto: 'Proposta pendente de atualizacao',
        propostas_corpo: 'Ola {{nome}},\n\nVoce tem {{quantidade}} proposta(s) sem atualizacao ha mais de {{dias}} dias.\n\nAcesse o sistema e atualize o andamento.\n\nAtenciosamente,\nEquipe de Vendas',
        visitas_ativas: 'false',
        visitas_dias: '3',
        visitas_assunto: 'Relatorio de visitas pendente',
        visitas_corpo: 'Ola {{nome}},\n\nNao identificamos registro de visitas seus nos ultimos {{dias}} dias.\n\nPor favor, registre suas visitas no sistema.\n\nAtenciosamente,\nEquipe de Vendas',
        funil_ativas: 'false',
        funil_dias: '30',
        funil_assunto: 'Oportunidade de funil sem atualizacao',
        funil_corpo: 'Ola {{nome}},\n\nVoce tem {{quantidade}} oportunidade(s) no funil sem atualizacao ha mais de {{dias}} dias.\n\nAcesse o sistema e registre o andamento das negociacoes.\n\nAtenciosamente,\nEquipe de Vendas'
    };
}

async function ensureConfigSheet() {
    const exists = await sheetExists('ConfigEmail');
    if (!exists) {
        await createSheet('ConfigEmail');
        await appendRow('ConfigEmail', ['Chave', 'Valor']);
    }
}

export async function readEmailConfig() {
    const defaults = defaultEmailConfig();
    try {
        const exists = await sheetExists('ConfigEmail');
        if (!exists) return defaults;
        const rows = await getSheetObjects('ConfigEmail');
        rows.forEach((row) => {
            if (row.Chave && row.Valor !== undefined && String(row.Valor) !== '') {
                defaults[row.Chave] = String(row.Valor);
            }
        });
    } catch (e) { /* mantém defaults */ }
    return defaults;
}

// Usado por admin.js depois de salvar listas/notificações, pra invalidar o
// cache de formData no cliente (ele compara essa versão com a que já tem).
export async function bumpCacheVersion() {
    try {
        await ensureConfigSheet();
        const rows = await getSheetObjects('ConfigEmail');
        const newVersion = String(Date.now());
        const idx = rows.findIndex((r) => r.Chave === 'cache_version');
        if (idx >= 0) await updateCell('ConfigEmail', idx + 2, 2, newVersion);
        else await appendRow('ConfigEmail', ['cache_version', newVersion]);
    } catch (e) { /* não fatal */ }
}

export async function handleGetEmailConfig(payload) {
    await ensureAdmin(payload.user);
    return { status: 'success', data: await readEmailConfig() };
}

export async function handleGetConfigVersion(payload) {
    requireUser(payload.user);
    const config = await withCache('app_config', 600, () => readEmailConfig());
    return { status: 'success', version: config.cache_version || '0' };
}

export async function handleSaveEmailConfig(payload) {
    await ensureAdmin(payload.user);
    const config = payload.config || {};
    await ensureConfigSheet();
    const rows = await getSheetObjects('ConfigEmail');

    for (const key of Object.keys(config)) {
        const idx = rows.findIndex((row) => row.Chave === key);
        if (idx >= 0) await updateCell('ConfigEmail', idx + 2, 2, String(config[key]));
        else await appendRow('ConfigEmail', [key, String(config[key])]);
    }

    clearCacheKeys(['app_config']);
    return { status: 'success', message: 'Configuracoes de e-mail salvas.' };
}
