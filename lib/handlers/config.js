import { getSheetObjects, appendRow, updateCell, sheetExists, createSheet, withCache, clearCacheKeys } from '../sheets.js';
import { ensureAdmin, verifyUser, filterByUser, isDateWithinLastDays } from '../common.js';

function defaultEmailConfig() {
    return {
        load_dias: '30',
        permitir_apagar_outros: 'false',
        permitir_criar_proposta_funil: 'false',
        permitir_acesso_radar: 'false',
        radar_reserva_meses: '6',
        radar_visita_dias: '7',
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
        funil_corpo: 'Ola {{nome}},\n\nVoce tem {{quantidade}} oportunidade(s) no funil sem atualizacao ha mais de {{dias}} dias.\n\nAcesse o sistema e registre o andamento das negociacoes.\n\nAtenciosamente,\nEquipe de Vendas',
        contratos_ativas: 'false',
        contratos_dias: '30',
        contratos_assunto: 'Contrato proximo do vencimento',
        contratos_corpo: 'Ola {{nome}},\n\nVoce tem {{quantidade}} contrato(s) vencendo nos proximos {{dias}} dias.\n\nAcesse o sistema para providenciar a renovacao.\n\nAtenciosamente,\nEquipe de Vendas',
        agendamentos_ativas: 'false',
        agendamentos_dias: '1',
        agendamentos_assunto: 'Retorno de visita agendado',
        agendamentos_corpo: 'Ola {{nome}},\n\nVoce tem {{quantidade}} retorno(s) de visita agendado(s) para os proximos {{dias}} dia(s).\n\nAcesse o sistema para ver os detalhes.\n\nAtenciosamente,\nEquipe de Vendas',
        manutencao_ativa: 'false',
        manutencao_mensagem: 'Sistema em manutenção. Voltamos em breve.'
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

// Intencionalmente pública (sem verifyUser/ensureAdmin) — precisa ser
// consultável antes do login, pra bloquear quem ainda nem autenticou.
export async function handleGetManutencao() {
    const config = await withCache('app_config', 600, () => readEmailConfig());
    return {
        status: 'success',
        ativa: config.manutencao_ativa === 'true',
        mensagem: config.manutencao_mensagem || 'Sistema em manutenção. Voltamos em breve.'
    };
}

// Admin sempre pode apagar; Gerente/Vendedor so se o admin liberou o toggle
// "permitir_apagar_outros" na tela de admin.
export async function ensureCanDelete(user) {
    const u = await verifyUser(user);
    const profile = String(u.profile || '').trim().toLowerCase();
    if (profile === 'admin') return u;
    const config = await withCache('app_config', 600, () => readEmailConfig());
    if (String(config.permitir_apagar_outros || 'false') === 'true') return u;
    throw new Error('Você não tem permissão para apagar registros.');
}

// Admin sempre pode criar Proposta/Funil; Gerente/Vendedor so se o admin
// liberou o toggle "permitir_criar_proposta_funil". Visita fica sempre livre
// pra todos (nao passa por aqui).
export async function ensureCanCreateProposalFunil(user) {
    const u = await verifyUser(user);
    const profile = String(u.profile || '').trim().toLowerCase();
    if (profile === 'admin') return u;
    const config = await withCache('app_config', 600, () => readEmailConfig());
    if (String(config.permitir_criar_proposta_funil || 'false') === 'true') return u;
    throw new Error('Você não tem permissão para criar novas propostas/oportunidades. Fale com o administrador.');
}

// Admin sempre acessa o Radar; Gerente/Vendedor so se o admin liberou o
// toggle "permitir_acesso_radar". Mesmo padrão de ensureCanCreateProposalFunil.
export async function ensureCanAccessRadar(user) {
    const u = await verifyUser(user);
    const profile = String(u.profile || '').trim().toLowerCase();
    if (profile === 'admin') return u;
    const config = await withCache('app_config', 600, () => readEmailConfig());
    if (String(config.permitir_acesso_radar || 'false') !== 'true') {
        throw new Error('Você não tem acesso ao Radar de Clientes. Fale com o administrador.');
    }
    await ensureRecentVisitActivity(u, config);
    return u;
}

// O Radar é uma ferramenta a mais, não um substituto do trabalho de campo
// já registrado no resto do app — vendedor/gerente só acessa se tiver pelo
// menos 1 visita (qualquer tipo, cliente ativo ou prospecção) registrada
// nos últimos N dias (radar_visita_dias, configurável pelo admin na aba
// Configurações do Radar). Cache curto (60s): rápido o bastante pra não
// bater na planilha a cada clique, curto o bastante pra liberar o acesso
// logo depois de registrar a visita que faltava, sem esperar minutos.
async function ensureRecentVisitActivity(user, config) {
    const dias = parseInt(config.radar_visita_dias || '7', 10) || 7;
    const visits = await withCache('radar_gate_' + user.email, 60, async () =>
        filterByUser(await getSheetObjects('Visitas'), user, 'visits'));
    // Mesmo critério (radar_visita_dias) usado por handleGetDashboardData pra
    // decidir se mostra o item de nav — se divergissem, dava pra ver o item
    // de nav e mesmo assim cair num erro ao abrir o Radar (ou vice-versa).
    const temVisitaRecente = visits.some((v) => isDateWithinLastDays(v['Data da Visita'], dias));
    if (!temVisitaRecente) {
        throw new Error(`Registre uma visita nos últimos ${dias} dias pra acessar o Radar de Clientes.`);
    }
}

export async function handleGetConfigVersion(payload) {
    await verifyUser(payload.user);
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
