// Resumo por WhatsApp — dois tipos de destinatário, frequências diferentes:
// 1. Gerentes: resumo SEMANAL (só às segundas) do próprio time, somando os
//    7 dias anteriores — ver computeResumoDiario com filtro+diasRange:7.
// 2. Quem está em whatsapp_resumo_manutencao_emails (Admin > Configurações):
//    resumo de toda visita Open/Close Manutenção do dia anterior, empresa
//    inteira (pedido específico: admin acompanhar manutenção sem precisar
//    abrir o app).
// Puxado sob demanda pelo robô local (mesmo esquema de api/pendencias-
// whatsapp.js — não é Vercel Cron, reaproveita o mesmo secret).
import { getSheetObjects, withCache } from '../lib/sheets.js';
import { isConfigOn, parseDate } from '../lib/common.js';
import { computeResumoDiario, nowInSaoPaulo } from '../lib/handlers/resumo.js';
import { readEmailConfig } from '../lib/handlers/config.js';

function startOfDay(d) {
    const c = new Date(d);
    c.setHours(0, 0, 0, 0);
    return c;
}

// Visitas do mês corrente até hoje por vendedor — pra comparar com a meta
// cadastrada (Vendedores.MetaVisitasMes); é um acumulado vivo do mês, não
// fechado como o resto do resumo (que agora é sempre sobre a semana
// anterior, ver computeResumoDiario com diasRange).
function contarVisitasPorVendedor(visitasRaw, desde, ate) {
    const porVendedor = {};
    visitasRaw.forEach((v) => {
        const d = parseDate(v['Data da Visita']);
        if (!d || d < desde || d >= ate) return;
        const nome = String(v['Vendedor/Gerente'] || '').trim();
        if (!nome) return;
        porVendedor[nome] = (porVendedor[nome] || 0) + 1;
    });
    return porVendedor;
}

export default async function handler(req, res) {
    if (req.method !== 'GET') {
        res.status(405).json({ status: 'error', message: 'Method not allowed.' });
        return;
    }
    const secret = process.env.WHATSAPP_PENDENCIAS_SECRET;
    if (!secret) {
        res.status(500).json({ status: 'error', message: 'WHATSAPP_PENDENCIAS_SECRET não configurado.' });
        return;
    }
    const auth = String(req.headers.authorization || '');
    if (auth !== `Bearer ${secret}`) {
        res.status(401).json({ status: 'error', message: 'Não autorizado.' });
        return;
    }

    try {
        const config = await readEmailConfig();
        const schedule = { hora: config.whatsapp_hora_resumo || '07:30', diasSemana: String(config.whatsapp_dias_semana || '1,2,3,4,5').split(',').map((d) => Number(d.trim())).filter((d) => !Number.isNaN(d)) };
        // Mesmo critério configurável usado no aviso de pendência por
        // WhatsApp (Propostas/Funil parado) — reaproveitado aqui pro resumo
        // do gerente trazer os dois também, não só Agendamentos.
        const DIAS_PARADO = Number(config.whatsapp_dias_parado) || 30;
        if (isConfigOn(config.whatsapp_resumo_pausado)) {
            res.status(200).json({ status: 'success', pausado: true, schedule, gerentes: [], manutencao: [] });
            return;
        }

        const vendedores = await withCache('vendedores_all_wa', 60, () => getSheetObjects('Vendedores'));
        const ativos = vendedores.filter((v) => String(v.Ativo || '').trim().toLowerCase() !== 'nao');
        const visitasRaw = await withCache('visitas_sheet_raw', 60, () => getSheetObjects('Visitas'));

        // Meta mensal: mês corrente, do dia 1 até hoje (não "ontem" — a
        // meta é um acumulado vivo do mês, diferente do resto do resumo
        // que é sempre sobre um dia já fechado).
        const hoje = startOfDay(nowInSaoPaulo());
        const inicioMes = new Date(hoje.getFullYear(), hoje.getMonth(), 1);
        const amanha = new Date(hoje); amanha.setDate(amanha.getDate() + 1);
        const visitasMesPorVendedor = contarVisitasPorVendedor(visitasRaw, inicioMes, amanha);

        // Resumo do gerente só sai às segundas (ver bloco abaixo).
        const ehSegunda = hoje.getDay() === 1;

        // ── Resumo por gerência, um por gerente com WhatsApp cadastrado ───
        // Virou SEMANAL (pedido explícito: diário incomodava) — só roda às
        // segundas, junto com o ranking semanal que já só existia nesse dia;
        // Visitas/Relatórios agora somam os 7 dias anteriores (diasRange),
        // não só "ontem" (que a maior parte da semana ficaria vazio/sem
        // sentido num envio semanal). Manutenção (abaixo) NÃO muda — continua
        // diária, é outro público (pedido era só "resumo pros gerentes").
        const gerentes = ativos.filter((v) => String(v.Perfil || '').trim().toLowerCase() === 'gerente' && String(v.TelefoneWhatsapp || '').trim());
        const gerentesResumo = [];
        if (ehSegunda) {
            for (const g of gerentes) {
                const gerencia = String(g.Gerencia || '').trim();
                if (!gerencia) continue; // sem gerência cadastrada, não dá pra saber o time
                const vendedoresDoTimeArr = ativos.filter((v) => String(v.Gerencia || '').trim() === gerencia);
                const vendedoresDoTime = new Set(vendedoresDoTimeArr.map((v) => String(v.NomeVendedor || '').trim()));
                const resumo = await computeResumoDiario(null, { vendedores: vendedoresDoTime, gerencia, diasParado: DIAS_PARADO, diasRange: 7 });

                // Meta mensal de cada vendedor do time (só quem tem meta > 0
                // cadastrada aparece) — junta com a contagem de visitas do mês.
                const metas = vendedoresDoTimeArr
                    .map((v) => ({ nome: String(v.NomeVendedor || '').trim(), meta: Number(v.MetaVisitasMes) || 0 }))
                    .filter((v) => v.meta > 0)
                    .map((v) => ({ ...v, feitas: visitasMesPorVendedor[v.nome] || 0 }));

                const hasAny = resumo.visitas.total || resumo.agendamentos.vencidosTotal || resumo.agendamentos.proximosTotal || resumo.relatorios.total || resumo.propostasParadas.total || resumo.funilParado.total || metas.length;
                if (!hasAny) continue; // semana parada pro time dele — não manda resumo vazio
                gerentesResumo.push({
                    nome: String(g.NomeVendedor || '').trim(),
                    telefone: String(g.TelefoneWhatsapp || '').trim(),
                    email: String(g.EmailLogin || '').trim(),
                    resumo,
                    metas
                });
            }
        }

        // ── Resumo de manutenção (Open/Close), empresa inteira ────────────
        const emailsManutencao = String(config.whatsapp_resumo_manutencao_emails || '')
            .split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
        let manutencaoResumo = [];
        if (emailsManutencao.length) {
            const resumoGeral = await computeResumoDiario();
            if (resumoGeral.visitas.manutencao.length) {
                const destinatarios = ativos.filter((v) => emailsManutencao.includes(String(v.EmailLogin || '').trim().toLowerCase()) && String(v.TelefoneWhatsapp || '').trim());
                manutencaoResumo = destinatarios.map((v) => ({
                    nome: String(v.NomeVendedor || '').trim(),
                    telefone: String(v.TelefoneWhatsapp || '').trim(),
                    email: String(v.EmailLogin || '').trim(),
                    dataResumo: resumoGeral.dataResumo,
                    manutencao: resumoGeral.visitas.manutencao
                }));
            }
        }

        res.status(200).json({ status: 'success', pausado: false, schedule, gerentes: gerentesResumo, manutencao: manutencaoResumo });
    } catch (error) {
        console.error('resumo-whatsapp:', error);
        res.status(200).json({ status: 'error', message: error.message });
    }
}
