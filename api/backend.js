import { checkRateLimit } from '../lib/common.js';
import { handleLogin, handleForgotPassword } from '../lib/handlers/auth.js';
import { handleGetVisits, handleGetVisitById, handleCreateVisit, handleUpdateVisit, handleDeleteVisit } from '../lib/handlers/visits.js';
import { handleGetProposals, handleGetProposalById, handleCreateProposal, handleUpdateProposal, handleDeleteProposal } from '../lib/handlers/proposals.js';
import {
    handleGetFunil, handleGetFunilById, handleCreateFunil, handleUpdateFunil, handleDeleteFunil, handleDebugFunilHeaders
} from '../lib/handlers/funil.js';
import {
    handleGetContratos, handleGetContratoById, handleCreateContrato, handleUpdateContrato, handleDeleteContrato
} from '../lib/handlers/contratos.js';
import {
    handleGetAgendamentos, handleCreateAgendamento, handleUpdateAgendamento, handleDeleteAgendamento
} from '../lib/handlers/agendamentos.js';
import { handleGetDashboardData } from '../lib/handlers/dashboard.js';
import { handleGetAdminData, handleSaveUser, handleSaveNotificationConfig, handleSaveLookupList } from '../lib/handlers/admin.js';
import { handleGetFormData } from '../lib/handlers/formdata.js';
import { handleGetEmailConfig, handleGetConfigVersion, handleSaveEmailConfig, handleGetManutencao } from '../lib/handlers/config.js';

function parseBody(req) {
    if (!req.body) return {};
    if (typeof req.body === 'string') {
        try { return JSON.parse(req.body); } catch (e) { return {}; }
    }
    return req.body;
}

const HANDLERS = {
    login: handleLogin,
    forgotPassword: handleForgotPassword,
    getVisits: handleGetVisits,
    getVisitById: handleGetVisitById,
    createVisit: handleCreateVisit,
    updateVisit: handleUpdateVisit,
    deleteVisit: handleDeleteVisit,
    getProposals: handleGetProposals,
    getProposalById: handleGetProposalById,
    createProposal: handleCreateProposal,
    updateProposal: handleUpdateProposal,
    deleteProposal: handleDeleteProposal,
    getFunil: handleGetFunil,
    getFunilById: handleGetFunilById,
    createFunil: handleCreateFunil,
    updateFunil: handleUpdateFunil,
    deleteFunil: handleDeleteFunil,
    debugFunilHeaders: handleDebugFunilHeaders,
    getContratos: handleGetContratos,
    getContratoById: handleGetContratoById,
    createContrato: handleCreateContrato,
    updateContrato: handleUpdateContrato,
    deleteContrato: handleDeleteContrato,
    getAgendamentos: handleGetAgendamentos,
    createAgendamento: handleCreateAgendamento,
    updateAgendamento: handleUpdateAgendamento,
    deleteAgendamento: handleDeleteAgendamento,
    getDashboardData: handleGetDashboardData,
    getAdminData: handleGetAdminData,
    saveUser: handleSaveUser,
    saveNotificationConfig: handleSaveNotificationConfig,
    saveLookupList: handleSaveLookupList,
    getFormData: handleGetFormData,
    getEmailConfig: handleGetEmailConfig,
    getConfigVersion: handleGetConfigVersion,
    saveEmailConfig: handleSaveEmailConfig,
    getManutencao: handleGetManutencao,
    ping: async () => ({ status: 'ok' })
};

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        res.status(405).json({ status: 'error', message: 'Method not allowed.' });
        return;
    }

    try {
        const body = parseBody(req);
        const action = body.action;
        const payload = body.payload || {};

        if (action !== 'ping' && action !== 'login' && action !== 'forgotPassword') {
            const rlEmail = (payload.user && payload.user.email) ? String(payload.user.email) : '';
            // Ações sem usuário autenticado (ex.: getManutencao, chamada antes do
            // login) caem pro IP do cliente, senão o rate limit é ignorado de fato
            // (checkRateLimit não faz nada com chave vazia).
            const rlIp = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
            checkRateLimit(rlEmail || 'ip:' + rlIp);
        }

        const fn = HANDLERS[action];
        const response = fn ? await fn(payload) : { status: 'error', message: 'Acao desconhecida.' };

        res.status(200).json(response);
    } catch (error) {
        res.status(200).json({ status: 'error', message: error.message });
    }
}
