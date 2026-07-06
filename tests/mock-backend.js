// Intercepts every call to the Google Apps Script endpoint with canned
// responses, so smoke tests don't depend on the real (slow) backend.
export const MOCK_USER = { email: 'test@example.com', name: 'Teste Usuario', profile: 'Admin', gerencia: 'Bauru' };

const DEFAULT_RESPONSES = {
    ping: () => ({ status: 'ok' }),
    login: () => ({ status: 'success', userData: MOCK_USER }),
    getDashboardData: () => ({
        status: 'success',
        data: {
            weeklyVisits: 3, openProposals: 5, overdueProposals: 2, funilAtivo: 4, overdueFunil: 1,
            visitsByDay: [], recentVisits: [], recentProposals: [], recentFunil: []
        }
    }),
    getVisits: () => ({ status: 'success', visits: [], scope: '10d' }),
    getProposals: () => ({ status: 'success', proposals: [], scope: '10d' }),
    getFunil: () => ({ status: 'success', funil: [], scope: '10d' }),
    getFormData: () => ({
        status: 'success',
        data: { cidades: [], areasAtuacao: [], potenciaisCliente: [], aplicacoes: [], equipamentos: [], tiposVisita: [], clientes: [], veiculos: [] }
    }),
    getConfigVersion: () => ({ status: 'success', version: '1' }),
    getAdminData: () => ({
        status: 'success',
        data: {
            users: [{ nomeVendedor: 'Teste Usuario', emailLogin: 'test@example.com', perfil: 'Admin', gerencia: 'Bauru', ultimoLogin: '' }],
            notifications: [],
            lookups: { cidades: [], areasAtuacao: [], potenciaisCliente: [], aplicacoes: [], equipamentos: [] }
        }
    }),
    getEmailConfig: () => ({ status: 'success', data: {} })
};

export async function mockBackend(page, overrides = {}) {
    const responses = { ...DEFAULT_RESPONSES, ...overrides };
    await page.route('**/macros/s/**', async (route) => {
        const body = JSON.parse(route.request().postData() || '{}');
        const handler = responses[body.action];
        const resp = handler ? handler(body.payload || {}) : { status: 'error', message: 'unmocked action: ' + body.action };
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(resp) });
    });
}

export async function login(page) {
    await page.goto('/');
    await page.fill('#login-email', MOCK_USER.email);
    await page.fill('#login-password', 'x');
    await page.click('#login-button');
    await page.waitForSelector('#bottom-nav .nav-btn', { timeout: 5000 });
}
