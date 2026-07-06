import { checkRateLimit } from './lib/common.js';
import { handleLogin, handleForgotPassword } from './lib/handlers/auth.js';
import { handleGetVisits, handleGetVisitById, handleCreateVisit, handleUpdateVisit } from './lib/handlers/visits.js';
import { handleGetProposals, handleGetProposalById, handleCreateProposal, handleUpdateProposal } from './lib/handlers/proposals.js';
import {
    handleGetFunil, handleGetFunilById, handleCreateFunil, handleUpdateFunil, handleDebugFunilHeaders
} from './lib/handlers/funil.js';
import { handleGetDashboardData } from './lib/handlers/dashboard.js';
import { handleGetAdminData, handleSaveUser, handleSaveNotificationConfig, handleSaveLookupList } from './lib/handlers/admin.js';
import { handleGetFormData } from './lib/handlers/formdata.js';
import { handleGetEmailConfig, handleGetConfigVersion, handleSaveEmailConfig } from './lib/handlers/config.js';

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
    getProposals: handleGetProposals,
    getProposalById: handleGetProposalById,
    createProposal: handleCreateProposal,
    updateProposal: handleUpdateProposal,
    getFunil: handleGetFunil,
    getFunilById: handleGetFunilById,
    createFunil: handleCreateFunil,
    updateFunil: handleUpdateFunil,
    debugFunilHeaders: handleDebugFunilHeaders,
    getDashboardData: handleGetDashboardData,
    getAdminData: handleGetAdminData,
    saveUser: handleSaveUser,
    saveNotificationConfig: handleSaveNotificationConfig,
    saveLookupList: handleSaveLookupList,
    getFormData: handleGetFormData,
    getEmailConfig: handleGetEmailConfig,
    getConfigVersion: handleGetConfigVersion,
    saveEmailConfig: handleSaveEmailConfig,
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
            checkRateLimit(rlEmail);
        }

        const fn = HANDLERS[action];
        const response = fn ? await fn(payload) : { status: 'error', message: 'Acao desconhecida.' };

        res.status(200).json(response);
    } catch (error) {
        res.status(200).json({ status: 'error', message: error.message });
    }
}
