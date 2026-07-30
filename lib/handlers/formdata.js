import { batchGetSheetObjects, withCache } from '../sheets.js';
import { verifyUser, canAccessClient } from '../common.js';
import { MANUTENCAO_LISTS, ensureManutencaoListSheets } from './manutencao.js';
import { readEmailConfig } from './config.js';

const FORM_SHEETS = [
    'Cidades', 'AreasAtuacao', 'PotenciaisCliente', 'Aplicacoes', 'Equipamentos', 'TiposVisita', 'Clientes',
    ...Object.values(MANUTENCAO_LISTS).map((l) => l.sheet)
];

export async function handleGetFormData(payload) {
    const user = await verifyUser(payload.user);
    await ensureManutencaoListSheets();

    // Uma unica chamada batchGet pra todas as abas, em vez de uma chamada
    // separada por aba — essa era a causa do erro 429 (quota de leitura) ao
    // abrir o formulario.
    const sheets = await withCache('formdata_all', 300, () => batchGetSheetObjects(FORM_SHEETS));

    const cidades = sheets.Cidades.map((r) => r.Cidade).filter(Boolean);
    const areasAtuacao = sheets.AreasAtuacao.map((r) => r.Area).filter(Boolean);
    const potenciaisCliente = sheets.PotenciaisCliente.map((r) => r.Potencial).filter(Boolean);
    const aplicacoes = sheets.Aplicacoes.map((r) => r.Aplicacao).filter(Boolean);
    const equipamentos = sheets.Equipamentos.map((r) => r.Equipamento).filter(Boolean);
    const manutencaoListas = Object.fromEntries(Object.entries(MANUTENCAO_LISTS).map(([key, cfg]) =>
        [key, (sheets[cfg.sheet] || []).map((r) => r[cfg.header]).filter(Boolean)]));
    const emailConfig = await withCache('app_config', 600, () => readEmailConfig());
    const manutencaoLabels = {
        afericao_vazao: emailConfig.manutencao_label_afericao_vazao || 'Aferição de Vazão',
        calibracao_manutencao: emailConfig.manutencao_label_calibracao_manutencao || 'Calibração/Manutenção',
        atendimento_lavanderia: emailConfig.manutencao_label_atendimento_lavanderia || 'Atendimento ao Cliente — Lavanderia'
    };

    const tiposVisita = sheets.TiposVisita.map((row) => ({
        tipo: row.Tipo || '',
        telefoneDestino: row.TelefoneDestino || '',
        mensagemPadrao: row.MensagemPadrao || '',
        obrigatorio: String(row.Obrigatorio || '').trim().toLowerCase() === 'sim'
    }));

    const clientes = sheets.Clientes
        .filter((row) => canAccessClient(row, user))
        .map((row) => ({
            ID_Cliente: row.ID_Cliente || '',
            'Nome do Cliente': row['Nome do Cliente'] || '',
            Cidade: row.Cidade || '',
            'Área de Atuação': row['Área de Atuação'] || row['Area de Atuacao'] || '',
            Vendedores: row.Vendedores || '',
            Gerencia: row.Gerencia || row['Gerência'] || '',
            'Contato Padrão': row['Contato Padrão'] || row.Contato || '',
            Telefone: row.Telefone || '',
            'Potencial do Cliente': row['Potencial do Cliente'] || '',
            'E-mail': row['E-mail'] || row.Email || ''
        }));

    return {
        status: 'success',
        data: { cidades, areasAtuacao, potenciaisCliente, aplicacoes, equipamentos, tiposVisita, clientes, manutencaoListas, manutencaoLabels }
    };
}
