import { state, navigateTo } from '../app.js';
import { callAPI, persistUser } from '../api.js';
import { escapeHtml } from '../utils/format.js';

export function renderLoginPage() {
    // Ensure header and nav are hidden — called both via navigateTo and directly on first load
    const _h = document.querySelector('header');
    const _n = document.getElementById('bottom-nav');
    if (_h) _h.style.display = 'none';
    if (_n) _n.style.display = 'none';

    const mainContent = document.getElementById('main-content');
    mainContent.style.cssText = 'max-width:none;margin:0;padding:0;overflow:hidden;';

    mainContent.innerHTML = `
        <div class="login-split">
            <div class="login-brand" aria-hidden="true">
                <div class="login-brand-inner">
                    <div class="login-brand-logo">
                        <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.92)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/>
                            <circle cx="12" cy="9" r="2.5"/>
                        </svg>
                        <span class="login-brand-name">App de Visitas</span>
                    </div>
                    <p class="login-brand-tagline">Gerencie visitas e propostas com eficiência</p>
                    <ul class="login-brand-benefits">
                        <li>✓ Acompanhe visitas em tempo real</li>
                        <li>✓ Propostas organizadas e rastreadas</li>
                        <li>✓ Funil de vendas integrado</li>
                    </ul>
                </div>
            </div>
            <div class="login-form-col">
                <div class="login-mobile-logo">
                    <svg width="52" height="52" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/>
                        <circle cx="12" cy="9" r="2.5"/>
                    </svg>
                    <span class="lml-name">App de Visitas</span>
                    <span class="lml-tag">Gerencie visitas e propostas</span>
                </div>
                <div class="login-form-card">
                    <h1 class="login-heading">Bem-vindo de volta</h1>
                    <p class="login-subheading">Entre com sua conta</p>
                    <form id="login-form" novalidate>
                        <div class="login-field">
                            <span class="login-field-icon">
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,12 2,6"/></svg>
                            </span>
                            <input type="email" id="login-email" autocomplete="email" required placeholder=" ">
                            <label for="login-email" class="login-field-label">E-mail</label>
                        </div>
                        <div class="login-field">
                            <span class="login-field-icon">
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                            </span>
                            <input type="password" id="login-password" autocomplete="current-password" required placeholder=" ">
                            <label for="login-password" class="login-field-label">Senha</label>
                            <button type="button" class="login-eye-btn" id="login-eye" aria-label="Mostrar senha" tabindex="-1">
                                <svg id="eye-show" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                                <svg id="eye-hide" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" style="display:none"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                            </button>
                        </div>
                        <div id="login-error-box" style="display:none" class="login-error-msg" role="alert">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                            <span id="login-error-text"></span>
                        </div>
                        <div class="login-forgot-row">
                            <button type="button" class="login-forgot-link" id="forgot-password">Esqueci minha senha</button>
                        </div>
                        <button type="submit" id="login-button" class="login-submit-btn">
                            <span id="login-btn-label">Entrar</span>
                            <span id="login-btn-spinner" class="login-spinner" style="display:none"></span>
                        </button>
                    </form>
                </div>
            </div>
        </div>
    `;

    const passInput = document.getElementById('login-password');
    document.getElementById('login-eye').addEventListener('click', () => {
        const show = passInput.type === 'password';
        passInput.type = show ? 'text' : 'password';
        document.getElementById('eye-show').style.display = show ? 'none' : '';
        document.getElementById('eye-hide').style.display = show ? '' : 'none';
    });

    [document.getElementById('login-email'), passInput].forEach((el) => {
        el.addEventListener('focus', () => {
            setTimeout(() => el.scrollIntoView({ behavior: 'smooth', block: 'center' }), 300);
        });
    });

    document.getElementById('login-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        const btn = document.getElementById('login-button');
        const label = document.getElementById('login-btn-label');
        const spinner = document.getElementById('login-btn-spinner');
        const errorBox = document.getElementById('login-error-box');
        const errorText = document.getElementById('login-error-text');

        btn.disabled = true;
        label.style.display = 'none';
        spinner.style.display = '';
        errorBox.style.display = 'none';

        try {
            const result = await callAPI('login', {
                email: document.getElementById('login-email').value,
                password: passInput.value
            });
            if (result.status === 'success') {
                state.currentUser = result.userData;
                persistUser(result.userData);
                await navigateTo('dashboard');
                return;
            }
            errorText.textContent = result.message || 'Credenciais inválidas.';
            errorBox.style.display = 'flex';
        } catch (error) {
            errorText.textContent = 'Não foi possível conectar ao servidor.';
            errorBox.style.display = 'flex';
        }

        btn.disabled = false;
        label.style.display = '';
        spinner.style.display = 'none';
    });

    document.getElementById('forgot-password').addEventListener('click', () => navigateTo('forgot-password'));
}


export function renderForgotPasswordPage() {
    const _h = document.querySelector('header');
    const _n = document.getElementById('bottom-nav');
    if (_h) _h.style.display = 'none';
    if (_n) _n.style.display = 'none';

    const mainContent = document.getElementById('main-content');
    mainContent.style.cssText = 'max-width:none;margin:0;padding:0;overflow:hidden;';
    mainContent.innerHTML = `
        <div class="login-form-col" style="min-height:100vh">
            <div class="login-mobile-logo">
                <svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#2563EB" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/><circle cx="12" cy="9" r="2.5"/></svg>
                <span style="font-size:1.05rem;font-weight:700;color:#1E3A8A;margin-left:0.4rem">App de Visitas</span>
            </div>
            <div class="login-form-card">
                <h1 class="login-heading" style="font-size:1.35rem">Recuperar Senha</h1>
                <p class="login-subheading">Informe seu e-mail cadastrado</p>
                <form id="forgot-form">
                    <div class="form-group">
                        <label for="forgot-email" style="font-size:0.82rem;color:var(--text-muted)">E-mail</label>
                        <input type="email" id="forgot-email" placeholder="seuemail@empresa.com" required>
                    </div>
                    <button type="submit" id="forgot-button" class="login-submit-btn">Solicitar</button>
                    <p id="forgot-message" class="helper-text" style="text-align:center;margin-top:0.75rem"></p>
                </form>
                <button type="button" class="login-forgot-link" id="back-login" style="display:block;text-align:center;margin-top:1rem;width:100%">← Voltar para login</button>
            </div>
        </div>
    `;

    document.getElementById('forgot-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        const button = document.getElementById('forgot-button');
        const message = document.getElementById('forgot-message');
        button.disabled = true;
        button.textContent = 'Enviando...';
        try {
            const result = await callAPI('forgotPassword', { email: document.getElementById('forgot-email').value });
            message.textContent = result.message || 'Solicitacao registrada.';
        } catch (error) {
            message.textContent = 'Nao foi possivel processar a solicitacao.';
        }
        button.disabled = false;
        button.textContent = 'Solicitar';
    });

    document.getElementById('back-login').addEventListener('click', () => navigateTo('login'));
}


export function showWelcomeSplash(user) {
    return new Promise(function(resolve) {
        const name = (user.name || '').split(' ')[0];
        const initial = name ? name[0].toUpperCase() : '?';
        const splash = document.createElement('div');
        splash.className = 'welcome-splash';
        splash.innerHTML = `
            <div class="welcome-splash-inner">
                <div class="welcome-splash-avatar">${escapeHtml(initial)}</div>
                <h2 class="welcome-splash-title">Bem-vindo, ${escapeHtml(name)}!</h2>
                <p class="welcome-splash-sub">App de Visitas</p>
                <div class="welcome-splash-bar">
                    <div class="welcome-splash-progress"></div>
                </div>
            </div>
        `;
        document.body.appendChild(splash);
        setTimeout(function() {
            splash.style.transition = 'opacity 0.3s ease';
            splash.style.opacity = '0';
            setTimeout(function() { splash.remove(); resolve(); }, 300);
        }, 1200);
    });
}


export async function performLogin(email, password) {
    const errorEl = document.getElementById('error-message');
    errorEl.textContent = '';

    try {
        state._prevLoginAt = localStorage.getItem('lastLoginAt');
        const result = await callAPI('login', { email, password });
        if (result.status === 'success') {
            const prevLogin = localStorage.getItem('lastLoginAt');
            const isFirstToday = !prevLogin || new Date(prevLogin).toDateString() !== new Date().toDateString();
            localStorage.setItem('lastLoginAt', new Date().toISOString());
            state.currentUser = result.userData;
            persistUser(result.userData);
            if (isFirstToday) {
                await showWelcomeSplash(result.userData);
            }
            await navigateTo('dashboard');
            return;
        }
        errorEl.textContent = result.message;
    } catch (error) {
        errorEl.textContent = 'Nao foi possivel conectar ao servidor. Verifique sua internet.';
    }
}
