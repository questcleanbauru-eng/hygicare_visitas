import { batchGetSheetObjects, withCache } from '../sheets.js';
import { requireUser, canAccessClient } from '../common.js';

const FORM_SHEETS = ['Cidades', 'AreasAtuacao', 'PotenciaisCliente', 'Aplicacoes', 'Equipamentos', 'TiposVisita', 'Clientes'];

export async function handleGetFormData(payload) {
    const user = requireUser(payload.user);

    // Uma unica chamada batchGet pras 7 abas, em vez de 7 chamadas separadas —
    // essa era a causa do erro 429 (quota de leitura) ao abrir o formulario.
    const sheets = await withCache('formdata_all', 300, () => batchGetSheetObjects(FORM_SHEETS));

    const cidades = sheets.Cidades.map((r) => r.Cidade).filter(Boolean);
    const areasAtuacao = sheets.AreasAtuacao.map((r) => r.Area).filter(Boolean);
    const potenciaisCliente = sheets.PotenciaisCliente.map((r) => r.Potencial).filter(Boolean);
    const aplicacoes = sheets.Aplicacoes.map((r) => r.Aplicacao).filter(Boolean);
    const equipamentos = sheets.Equipamentos.map((r) => r.Equipamento).filter(Boolean);

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

    return { status: 'success', data: { cidades, areasAtuacao, potenciaisCliente, aplicacoes, equipamentos, tiposVisita, clientes } };
}
