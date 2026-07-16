import { batchGetSheetObjects, withCache } from '../sheets.js';
import { verifyUser, filterByUser, parseDate, isDateWithinLastDays, daysSinceDate } from '../common.js';
import { normalizeVisitRow } from './visits.js';
import { normalizeProposalRow } from './proposals.js';
import { readFunilRows } from './funil.js';
import { readEmailConfig } from './config.js';

export async function handleGetDashboardData(payload) {
    const user = await verifyUser(payload.user);
    return withCache('d_' + user.email, 120, async () => {
        // Visitas + Propostas numa unica chamada batchGet em vez de 2 separadas
        // (buscada só se algum dos dois caches abaixo estiver frio).
        const getVpRaw = () => withCache('vp_raw', 60, () => batchGetSheetObjects(['Visitas', 'Propostas']));
        const visits = await withCache('v_' + user.email, 180, async () =>
            filterByUser((await getVpRaw()).Visitas.map(normalizeVisitRow), user, 'visits'));
        const proposals = await withCache('p_' + user.email, 180, async () =>
            filterByUser((await getVpRaw()).Propostas.map(normalizeProposalRow), user, 'proposals'));

        let funil = [];
        try {
            funil = await withCache('f_' + user.email, 180, () => readFunilRows(user));
        } catch (e) { /* aba Funil pode não existir ainda */ }

        const appConfig = await withCache('app_config', 600, () => readEmailConfig());

        const weeklyVisits = visits.filter((v) => isDateWithinLastDays(v['Data da Visita'], 7)).length;
        const openProposals = proposals.filter((p) => String(p.Status || '').toUpperCase() === 'AGUARDANDO').length;
        const overdueProposals = proposals.filter((p) =>
            String(p.Status || '').toUpperCase() === 'AGUARDANDO' && daysSinceDate(p['Atualização']) > 30).length;
        const funilAtivo = funil.filter((f) =>
            String(f.ativo || '').toLowerCase() === 'sim' && !['CONCLUIDO', 'PERDIDO'].includes(String(f.status || '').toUpperCase())).length;
        const overdueFunil = funil.filter((f) =>
            String(f.ativo || '').toLowerCase() === 'sim' &&
            !['CONCLUIDO', 'PERDIDO'].includes(String(f.status || '').toUpperCase()) &&
            daysSinceDate(f.atualizacao || f.data) > 30).length;
        const recentFunil = funil.filter((f) => String(f.ativo || '').toLowerCase() === 'sim').slice(0, 3);

        const profile = String(user.profile || '').trim().toLowerCase();

        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const visitsByDay = [];
        for (let i = 6; i >= 0; i--) {
            const d = new Date(today.getTime() - i * 86400000);
            visitsByDay.push({ date: d.toISOString().substring(0, 10), count: 0 });
        }
        visits.forEach((v) => {
            const d = parseDate(v['Data da Visita']);
            if (!d) return;
            d.setHours(0, 0, 0, 0);
            const label = d.toISOString().substring(0, 10);
            const entry = visitsByDay.find((x) => x.date === label);
            if (entry) entry.count++;
        });

        let teamData = null;
        if (profile !== 'vendedor') {
            const sevenDaysAgo = new Date();
            sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
            sevenDaysAgo.setHours(0, 0, 0, 0);
            const byVendedor = {};
            visits.forEach((v) => {
                const d = parseDate(v['Data da Visita']);
                if (!d || d < sevenDaysAgo) return;
                const vendor = String(v['Vendedor/Gerente'] || '').trim();
                if (!vendor) return;
                byVendedor[vendor] = (byVendedor[vendor] || 0) + 1;
            });
            teamData = Object.keys(byVendedor).sort().map((v) => ({ vendedor: v, visitas: byVendedor[v] }));
        }

        const ago = new Date();
        ago.setDate(ago.getDate() - 7);
        ago.setHours(0, 0, 0, 0);
        const recentVisits = visits.filter((v) => { const d = parseDate(v['Data da Visita']); return d && d >= ago; })
            .sort((a, b) => {
                const da = parseDate(a['Data da Visita']);
                const db = parseDate(b['Data da Visita']);
                return (db ? db.getTime() : 0) - (da ? da.getTime() : 0);
            })
            .slice(0, 5)
            .map((v) => ({
                ID: v.ID, 'Vendedor/Gerente': v['Vendedor/Gerente'], 'Data da Visita': v['Data da Visita'],
                'Tipo da Visita': v['Tipo da Visita'], Cliente: v.Cliente, Cidade: v.Cidade
            }));

        const recentProposals = proposals
            .filter((p) => String(p.Status || '').toUpperCase() === 'AGUARDANDO' && daysSinceDate(p['Atualização']) > 30)
            .sort((a, b) => daysSinceDate(b['Atualização']) - daysSinceDate(a['Atualização']))
            .slice(0, 5)
            .map((p) => ({
                ID: p.ID, Cliente: p.Cliente, Status: p.Status, Produto: p.Produto,
                'Atualização': p['Atualização'], Cidade: p.Cidade, Vendedor: p.Vendedor,
                Gerencia: p.Gerencia || p['Gerência'] || ''
            }));

        return {
            status: 'success',
            data: {
                weeklyVisits, teamWeeklyVisits: weeklyVisits, openProposals, overdueProposals,
                funilAtivo, overdueFunil,
                metaVisitas: parseInt(appConfig.meta_visitas_semana || '0', 10),
                visitsByDay, teamData, recentVisits, recentProposals,
                recentFunil: recentFunil.map((f) => ({
                    id: f.id, cliente: f.cliente, status: f.status, ativo: f.ativo, atualizacao: f.atualizacao, data: f.data
                })),
                loadDias: parseInt(appConfig.load_dias || '30', 10),
                canDelete: profile === 'admin' || String(appConfig.permitir_apagar_outros || 'false') === 'true',
                canCreateProposalFunil: profile === 'admin' || String(appConfig.permitir_criar_proposta_funil || 'false') === 'true'
            }
        };
    });
}
