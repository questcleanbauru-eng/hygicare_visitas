// Resumo diário (do dia anterior) por WhatsApp — dois tipos de destinatário:
// 1. Gerentes: resumo igual ao que já existe no Início/e-mail, mas escopado
//    só pro próprio time (ver computeResumoDiario com filtro).
// 2. Quem está em whatsapp_resumo_manutencao_emails (Admin > Configurações):
//    resumo de toda visita Open/Close Manutenção do dia anterior, empresa
//    inteira (pedido específico: admin acompanhar manutenção sem precisar
//    abrir o app).
// Puxado sob demanda pelo robô local (mesmo esquema de api/pendencias-
// whatsapp.js — não é Vercel Cron, reaproveita o mesmo secret).
import { getSheetObjects, withCache } from '../lib/sheets.js';
import { isConfigOn } from '../lib/common.js';
import { computeResumoDiario } from '../lib/handlers/resumo.js';
import { readEmailConfig } from '../lib/handlers/config.js';

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
        if (isConfigOn(config.whatsapp_resumo_pausado)) {
            res.status(200).json({ status: 'success', pausado: true, gerentes: [], manutencao: [] });
            return;
        }

        const vendedores = await withCache('vendedores_all_wa', 60, () => getSheetObjects('Vendedores'));
        const ativos = vendedores.filter((v) => String(v.Ativo || '').trim().toLowerCase() !== 'nao');

        // ── Resumo por gerência, um por gerente com WhatsApp cadastrado ───
        const gerentes = ativos.filter((v) => String(v.Perfil || '').trim().toLowerCase() === 'gerente' && String(v.TelefoneWhatsapp || '').trim());
        const gerentesResumo = [];
        for (const g of gerentes) {
            const gerencia = String(g.Gerencia || '').trim();
            if (!gerencia) continue; // sem gerência cadastrada, não dá pra saber o time
            const vendedoresDoTime = new Set(
                ativos.filter((v) => String(v.Gerencia || '').trim() === gerencia).map((v) => String(v.NomeVendedor || '').trim())
            );
            const resumo = await computeResumoDiario(null, { vendedores: vendedoresDoTime, gerencia });
            const hasAny = resumo.visitas.total || resumo.agendamentos.vencidosTotal || resumo.agendamentos.proximosTotal || resumo.relatorios.total;
            if (!hasAny) continue; // dia parado pro time dele — não manda resumo vazio
            gerentesResumo.push({
                nome: String(g.NomeVendedor || '').trim(),
                telefone: String(g.TelefoneWhatsapp || '').trim(),
                email: String(g.EmailLogin || '').trim(),
                resumo
            });
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

        res.status(200).json({ status: 'success', pausado: false, gerentes: gerentesResumo, manutencao: manutencaoResumo });
    } catch (error) {
        console.error('resumo-whatsapp:', error);
        res.status(200).json({ status: 'error', message: error.message });
    }
}
