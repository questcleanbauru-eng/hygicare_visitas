import { getSheetObjects, getSingleColumnValues, getSingleColumnValuesSafe, withCache } from '../sheets.js';
import { requireUser, canAccessClient } from '../common.js';

export async function handleGetFormData(payload) {
    const user = requireUser(payload.user);

    const lookups = await withCache('formdata_lookups', 600, async () => ({
        cidades: await getSingleColumnValues('Cidades', 'Cidade'),
        areasAtuacao: await getSingleColumnValues('AreasAtuacao', 'Area'),
        potenciaisCliente: await getSingleColumnValues('PotenciaisCliente', 'Potencial'),
        aplicacoes: await getSingleColumnValuesSafe('Aplicacoes', 'Aplicacao'),
        equipamentos: await getSingleColumnValuesSafe('Equipamentos', 'Equipamento')
    }));

    const tiposVisita = await withCache('formdata_tipos', 600, async () =>
        (await getSheetObjects('TiposVisita')).map((row) => ({
            tipo: row.Tipo || '',
            telefoneDestino: row.TelefoneDestino || '',
            mensagemPadrao: row.MensagemPadrao || '',
            obrigatorio: String(row.Obrigatorio || '').trim().toLowerCase() === 'sim'
        })));

    const clientes = await withCache('formdata_clients_' + user.email, 300, async () =>
        (await getSheetObjects('Clientes'))
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
            })));

    return { status: 'success', data: { ...lookups, tiposVisita, clientes } };
}
