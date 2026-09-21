import { getSheetObjects, withCache } from '../sheets.js';
import { verifyUser, parseDate, formatDate, isConfigOn } from '../common.js';
import { sendPushToVendedor } from './push.js';
import { saveConfigValue } from './config.js';

// Lembrete pro admin revisar/atualizar a Base de Clientes do app
// (Admin → Listas) — aviso simples, sem depender de nenhum dado
// (diferente do resumo diário/lembrete de agendamento). Roda dentro do
// cron-resumo.js (chamado todo dia), mas só manda de fato a cada
// INTERVALO_DIAS — guarda a data do último envio direto na config
// (ConfigEmail), sem precisar de coluna/aba nova.
const INTERVALO_DIAS = 30;

export async function resolveAdminsAtivos() {
    const rows = await withCache('vendedores_all_lembrete_clientes', 60, () => getSheetObjects('Vendedores'));
    return rows.filter((r) =>
        String(r.Perfil || '').trim().toLowerCase() === 'admin' &&
        String(r.Ativo || '').trim().toLowerCase() !== 'nao'
    );
}

function diasDesdeUltimoEnvio(config) {
    const d = parseDate(config.lembrete_clientes_ultimo_envio);
    if (!d) return Infinity; // nunca enviado — manda na primeira chance
    return Math.floor((Date.now() - d.getTime()) / 86400000);
}

// Chamado todo dia (de dentro de api/cron-resumo.js) — decide sozinho se
// hoje já completou os INTERVALO_DIAS desde o último envio.
export async function runLembreteClientesDiario(config) {
    if (!isConfigOn(config.lembrete_atualizar_clientes_ativo)) return 0;
    if (diasDesdeUltimoEnvio(config) < INTERVALO_DIAS) return 0;

    const admins = await resolveAdminsAtivos();
    const hoje = new Date().toISOString().slice(0, 10);
    let enviados = 0;
    for (const a of admins) {
        if (!a.EmailLogin) continue;
        await sendPushToVendedor(a.EmailLogin, {
            title: '📋 Lembrete',
            body: 'Hora de revisar/atualizar a base de Clientes.',
            page: 'admin', tag: 'lembrete-clientes-' + hoje, tipo: 'aviso'
        });
        enviados++;
    }
    // Só grava a data se realmente mandou pra alguém — senão (ex.: nenhum
    // admin ativo cadastrado) ficaria "enviado" sem ter enviado nada,
    // adiando o próximo lembrete real por engano.
    if (enviados > 0) {
        await saveConfigValue('lembrete_clientes_ultimo_envio', formatDate(new Date()));
    }
    return enviados;
}

// Botão "Testar agora" (Admin → Configurações) — manda só pro admin que
// clicou, sem esperar os 30 dias, e SEM contar como envio real (não
// atualiza a data do último envio — senão empurraria o próximo lembrete
// de verdade pra mais 30 dias à toa, só por causa de um teste).
export async function handleTestLembreteClientes(payload) {
    const user = await verifyUser(payload.user);
    if (String(user.profile || '').trim().toLowerCase() !== 'admin') {
        throw new Error('Só administradores podem testar esse lembrete.');
    }
    await sendPushToVendedor(user.email, {
        title: '📋 Lembrete [Teste]',
        body: 'Hora de revisar/atualizar a base de Clientes.',
        page: 'admin', tag: 'lembrete-clientes-teste', tipo: 'aviso'
    });
    return { status: 'success', message: 'Notificação de teste enviada — confira o sininho no app.' };
}
