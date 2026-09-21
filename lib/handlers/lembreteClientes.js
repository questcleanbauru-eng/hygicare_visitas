import { getSheetObjects, withCache } from '../sheets.js';
import { verifyUser } from '../common.js';
import { sendPushToVendedor } from './push.js';

// Lembrete diário pro admin revisar/atualizar a Base de Clientes do app
// (Admin → Listas) — aviso simples e incondicional (diferente do resumo
// diário/lembrete de agendamento, que só avisam quando há algo
// relevante pra contar): todo dia, pro(s) admin(s) ativo(s), sempre.
export async function resolveAdminsAtivos() {
    const rows = await withCache('vendedores_all_lembrete_clientes', 60, () => getSheetObjects('Vendedores'));
    return rows.filter((r) =>
        String(r.Perfil || '').trim().toLowerCase() === 'admin' &&
        String(r.Ativo || '').trim().toLowerCase() !== 'nao'
    );
}

// Botão "Testar agora" (Admin → Configurações) — manda só pro admin que
// clicou, sem esperar o horário programado.
export async function handleTestLembreteClientes(payload) {
    const user = await verifyUser(payload.user);
    if (String(user.profile || '').trim().toLowerCase() !== 'admin') {
        throw new Error('Só administradores podem testar esse lembrete.');
    }
    await sendPushToVendedor(user.email, {
        title: '📋 Lembrete diário',
        body: 'Hora de revisar/atualizar a base de Clientes.',
        page: 'admin', tag: 'lembrete-clientes-teste', tipo: 'aviso'
    });
    return { status: 'success', message: 'Notificação de teste enviada — confira o sininho no app.' };
}
