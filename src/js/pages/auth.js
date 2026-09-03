import { state, navigateTo } from '../app.js';
import { callAPI, persistUser } from '../api.js';
import { escapeHtml } from '../utils/format.js';
import { setSaving, showToast } from '../utils/dom.js';
import { isPinSupported, hasPinEmail, getPinEmail, setPinEmail, clearPinEmail } from '../utils/pin.js';

// Quando true, renderLoginPage pula a tela de PIN e mostra e-mail+senha
// (link "Entrar com e-mail e senha"). É consumido a cada render.
let _forceFullLogin = false;

// Coluna de marca compartilhada entre a tela de login e a de PIN.
function loginBrandHtml() {
    return `
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
                    <li><span class="lbb-check"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></span>Acompanhe visitas em tempo real</li>
                    <li><span class="lbb-check"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></span>Propostas organizadas e rastreadas</li>
                    <li><span class="lbb-check"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></span>Funil de vendas integrado</li>
                </ul>
            </div>
            <p class="login-brand-foot">Hygicare · Gestão comercial</p>
        </div>`;
}

export function renderLoginPage() {
    // Ensure header and nav are hidden — called both via navigateTo and directly on first load
    const _h = document.querySelector('header');
    const _n = document.getElementById('bottom-nav');
    if (_h) _h.style.display = 'none';
    if (_n) _n.style.display = 'none';

    // Recria o #main-content: se caímos aqui por sessão expirada no meio de um
    // carregamento, o .catch da busca em andamento (dashboard, listas…) ainda
    // vai rodar — a maioria dos callers só re-renderiza se
    // document.getElementById('main-content') for o mesmo nó que capturaram.
    // Trocando o nó, essas guardas falham e ninguém escreve um "erro" por
    // cima da tela de login.
    let mainContent = document.getElementById('main-content');
    if (mainContent) {
        const fresh = mainContent.cloneNode(false);
        mainContent.replaceWith(fresh);
        mainContent = fresh;
    }
    mainContent.style.cssText = 'max-width:none;margin:0;padding:0;overflow:hidden;';

    // Tela de PIN (acesso rápido, por aparelho) — a menos que o usuário tenha
    // pedido "entrar com e-mail e senha".
    if (!_forceFullLogin && isPinSupported() && hasPinEmail()) {
        renderPinUnlockPage(mainContent);
        return;
    }
    _forceFullLogin = false;

    mainContent.innerHTML = `
        <div class="login-split">
            ${loginBrandHtml()}
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
                    <p class="login-help">Problemas para entrar? Fale com o administrador.</p>
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

        const emailValue = document.getElementById('login-email').value.trim();
        const passwordValue = passInput.value;
        try {
            const result = await callAPI('login', {
                email: emailValue,
                password: passwordValue
            });
            if (result.status === 'success') {
                if (String(result.userData.profile || '').trim().toLowerCase() !== 'admin') {
                    const manut = await callAPI('getManutencao', {}).catch(() => null);
                    if (manut?.ativa) {
                        errorText.textContent = manut.mensagem || 'Sistema em manutenção. Voltamos em breve.';
                        errorBox.style.display = 'flex';
                        btn.disabled = false;
                        label.style.display = '';
                        spinner.style.display = 'none';
                        return;
                    }
                }
                state.currentUser = { ...result.userData, accessToken: result.accessToken };
                persistUser(state.currentUser);
                const acctEmail = result.userData.email || emailValue;
                if (result.hasPin) {
                    // A conta já tem PIN (criado em outro aparelho) — só
                    // registra neste pra próxima vez já abrir no teclado de PIN.
                    if (isPinSupported()) setPinEmail(acctEmail);
                } else {
                    await maybeOfferPinSetup(acctEmail);
                }
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


function maskEmailForPin(email) {
    const s = String(email || '');
    const at = s.indexOf('@');
    if (at <= 1) return s;
    return s[0] + '•••' + s.slice(at);
}

const _WEAK_PINS = new Set(['0000', '1111', '2222', '3333', '4444', '5555', '6666', '7777', '8888', '9999', '1234', '2345', '3456', '4567', '5678', '6789', '0123', '4321', '9876', '1212', '1010']);

// Liga 4 caixinhas de 1 dígito: digitou → pula pra próxima; backspace vazio
// → volta; colar preenche tudo. onComplete dispara quando as 4 têm dígito.
function wirePinBoxes(container, onComplete) {
    const boxes = Array.from(container.querySelectorAll('.pin-box'));
    const value = () => boxes.map((b) => b.value).join('');
    const clear = () => { boxes.forEach((b) => { b.value = ''; }); boxes[0].focus(); };
    boxes.forEach((box, i) => {
        box.addEventListener('input', () => {
            box.value = box.value.replace(/\D/g, '').slice(-1);
            if (box.value && i < boxes.length - 1) boxes[i + 1].focus();
            if (value().length === boxes.length) onComplete(value());
        });
        box.addEventListener('keydown', (e) => {
            if (e.key === 'Backspace' && !box.value && i > 0) { boxes[i - 1].focus(); boxes[i - 1].value = ''; e.preventDefault(); }
            if (e.key === 'ArrowLeft' && i > 0) boxes[i - 1].focus();
            if (e.key === 'ArrowRight' && i < boxes.length - 1) boxes[i + 1].focus();
        });
        box.addEventListener('paste', (e) => {
            e.preventDefault();
            const digits = (e.clipboardData || window.clipboardData).getData('text').replace(/\D/g, '').slice(0, boxes.length);
            if (!digits) return;
            boxes.forEach((b, k) => { b.value = digits[k] || ''; });
            (boxes[digits.length] || boxes[boxes.length - 1]).focus();
            if (digits.length === boxes.length) onComplete(digits);
        });
    });
    return { value, clear, focus: () => boxes[0].focus() };
}

const _pinBoxesHtml = (idPrefix) => `
    <div class="pin-boxes" id="${idPrefix}">
        ${[0, 1, 2, 3].map(() => `<input type="password" class="pin-box" inputmode="numeric" autocomplete="off" maxlength="1" pattern="[0-9]*" aria-label="Dígito do PIN">`).join('')}
    </div>`;

// Tela de "Entrar com PIN" — substitui e-mail+senha quando este aparelho já
// escolheu um e-mail pra usar PIN. O PIN é conferido no servidor.
function renderPinUnlockPage(mainContent) {
    _forceFullLogin = false;
    const email = getPinEmail();
    mainContent.innerHTML = `
        <div class="login-split">
            ${loginBrandHtml()}
            <div class="login-form-col">
                <div class="login-mobile-logo">
                    <svg width="52" height="52" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/>
                        <circle cx="12" cy="9" r="2.5"/>
                    </svg>
                    <span class="lml-name">App de Visitas</span>
                    <span class="lml-tag">Acesso rápido</span>
                </div>
                <div class="login-form-card">
                    <div class="pin-lock-badge" aria-hidden="true">
                        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                    </div>
                    <h1 class="login-heading">Digite seu PIN</h1>
                    <p class="login-subheading">${escapeHtml(maskEmailForPin(email))}</p>
                    <form id="pin-form" novalidate>
                        ${_pinBoxesHtml('pin-boxes')}
                        <div id="pin-error-box" class="login-error-msg" style="display:none" role="alert">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                            <span id="pin-error-text"></span>
                        </div>
                        <button type="submit" id="pin-button" class="login-submit-btn">
                            <span id="pin-btn-label">Entrar</span>
                            <span id="pin-btn-spinner" class="login-spinner" style="display:none"></span>
                        </button>
                    </form>
                    <div class="login-forgot-row" style="flex-direction:column;gap:0.35rem;margin-top:1rem;align-items:center">
                        <button type="button" class="login-forgot-link" id="pin-use-password">Entrar com e-mail e senha</button>
                        <button type="button" class="login-forgot-link" id="pin-other-account">Entrar com outra conta</button>
                    </div>
                </div>
            </div>
        </div>
    `;

    const btn = document.getElementById('pin-button');
    const label = document.getElementById('pin-btn-label');
    const spinner = document.getElementById('pin-btn-spinner');
    const errBox = document.getElementById('pin-error-box');
    const errText = document.getElementById('pin-error-text');
    const setBusy = (busy) => {
        btn.disabled = busy;
        label.style.display = busy ? 'none' : '';
        spinner.style.display = busy ? '' : 'none';
    };
    const showErr = (msg) => { errText.textContent = msg; errBox.style.display = 'flex'; };

    let submitting = false;
    const boxes = wirePinBoxes(document.getElementById('pin-boxes'), () => {
        if (!submitting) document.getElementById('pin-form').requestSubmit();
    });
    document.getElementById('pin-boxes').addEventListener('input', () => { errBox.style.display = 'none'; });
    setTimeout(() => boxes.focus(), 60);

    document.getElementById('pin-use-password').addEventListener('click', () => {
        _forceFullLogin = true;
        renderLoginPage();
    });
    document.getElementById('pin-other-account').addEventListener('click', () => {
        clearPinEmail();
        _forceFullLogin = true;
        renderLoginPage();
    });

    document.getElementById('pin-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        if (submitting) return;
        const pin = boxes.value();
        if (!/^\d{4}$/.test(pin)) { showErr('Digite os 4 dígitos do PIN.'); return; }
        submitting = true;
        setBusy(true);
        errBox.style.display = 'none';

        try {
            const result = await callAPI('loginWithPin', { email, pin });
            if (result.status === 'success') {
                if (String(result.userData.profile || '').trim().toLowerCase() !== 'admin') {
                    const manut = await callAPI('getManutencao', {}).catch(() => null);
                    if (manut?.ativa) {
                        showErr(manut.mensagem || 'Sistema em manutenção. Voltamos em breve.');
                        setBusy(false); submitting = false;
                        return;
                    }
                }
                state.currentUser = { ...result.userData, accessToken: result.accessToken };
                persistUser(state.currentUser);
                await navigateTo('dashboard');
                return;
            }
            // Servidor recusou: PIN errado / bloqueado / não cadastrado.
            const msg = result.message || 'Não foi possível entrar com o PIN.';
            setBusy(false); submitting = false;
            boxes.clear();
            showErr(msg);
            if (/n[ãa]o (h[áa]|est[áa]|foi) .*cadastrad|nenhum pin|remov/i.test(msg)) {
                clearPinEmail();
                setTimeout(() => { _forceFullLogin = true; renderLoginPage(); }, 1800);
            }
        } catch (error) {
            setBusy(false); submitting = false;
            showErr('Não foi possível conectar ao servidor.');
        }
    });
}

// Depois de um login completo bem-sucedido: oferece cadastrar um PIN (fica
// no servidor). Resolve sempre (cadastrado ou pulado).
export function maybeOfferPinSetup(email) {
    return new Promise((resolve) => {
        if (!isPinSupported() || !email || (getPinEmail() === String(email).trim().toLowerCase())) { resolve(); return; }
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.innerHTML = `
            <div class="modal-card">
                <div style="font-size:2rem;margin-bottom:0.5rem">🔒</div>
                <h3>Criar um PIN de acesso rápido?</h3>
                <p>Você passa a entrar com um PIN de 4 dígitos em vez de e-mail e senha toda vez. Dá pra remover depois.</p>
                <div class="form-group full-width" style="text-align:left">
                    <label for="pin-new">PIN (4 dígitos)</label>
                    <input type="password" id="pin-new" inputmode="numeric" maxlength="4" autocomplete="off" placeholder="····">
                </div>
                <div class="form-group full-width" style="text-align:left">
                    <label for="pin-new2">Repita o PIN</label>
                    <input type="password" id="pin-new2" inputmode="numeric" maxlength="4" autocomplete="off" placeholder="····">
                </div>
                <div id="pin-setup-err" class="login-error-msg" style="display:none"><span id="pin-setup-err-text"></span></div>
                <button type="button" id="pin-setup-save" class="primary-button">Salvar PIN</button>
                <button type="button" id="pin-setup-skip" class="secondary-button">Agora não</button>
            </div>
        `;
        document.body.appendChild(overlay);
        const done = () => { overlay.remove(); resolve(); };
        const errText = overlay.querySelector('#pin-setup-err-text');
        const errBox = overlay.querySelector('#pin-setup-err');
        const showErr = (m) => { errText.textContent = m; errBox.style.display = 'flex'; };
        overlay.querySelectorAll('#pin-new, #pin-new2').forEach((el) => {
            el.addEventListener('input', () => {
                el.value = el.value.replace(/\D/g, '').slice(0, 4);
                errBox.style.display = 'none';
            });
        });
        overlay.querySelector('#pin-setup-skip').addEventListener('click', done);
        overlay.querySelector('#pin-setup-save').addEventListener('click', async () => {
            const a = overlay.querySelector('#pin-new').value;
            const b = overlay.querySelector('#pin-new2').value;
            if (!/^\d{4}$/.test(a)) { showErr('O PIN precisa ter 4 dígitos.'); return; }
            if (a !== b) { showErr('Os dois PINs não são iguais.'); return; }
            if (_WEAK_PINS.has(a)) { showErr('Esse PIN é fácil demais. Escolha outro.'); return; }
            const saveBtn = overlay.querySelector('#pin-setup-save');
            setSaving(true, saveBtn, 'Salvando...');
            try {
                const r = await callAPI('setupPin', { pin: a });
                if (r && r.status === 'success') {
                    setPinEmail(email);
                    showToast('PIN criado. Da próxima vez, entre só com o PIN.');
                } else {
                    showToast((r && r.message) || 'Não foi possível salvar o PIN.', true);
                    setSaving(false, saveBtn);
                    return;
                }
            } catch (e) {
                showToast('Não foi possível salvar o PIN.', true);
                setSaving(false, saveBtn);
                return;
            }
            done();
        });
    });
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
                        <label for="forgot-email" style="font-size:0.82rem;color:var(--text-muted-strong)">E-mail</label>
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
        setSaving(true, button, 'Enviando...');
        try {
            const result = await callAPI('forgotPassword', { email: document.getElementById('forgot-email').value });
            message.textContent = result.message || 'Solicitacao registrada.';
        } catch (error) {
            message.textContent = 'Nao foi possivel processar a solicitacao.';
        }
        setSaving(false, button);
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
            state.currentUser = { ...result.userData, accessToken: result.accessToken };
            persistUser(state.currentUser);
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

