import { state } from '../app.js';
import { callAPI, saveCache, loadCache, ensureFormData } from '../api.js';
import { escapeHtml, resolveNotifyOptions, multiCheckFilterFieldHtml } from '../utils/format.js';
import { showToast, setSaving, loadingState, addScrollTop, wireMultiCheckFilter } from '../utils/dom.js';
import { initPullToRefresh, ensureStyles } from '../utils/ui.js';

// "Lembretes administrativos" — pedido explícito do Bruno: usar o robô de
// WhatsApp como agenda/lembrete pra cobrar o time administrativo de algo
// (ex.: "comprar tal coisa todo mês", "mandar nota fiscal"), sem misturar
// isso com Agendamentos (que é retorno de visita a cliente, entra nos
// relatórios/contagens de vendedor). Só admin cria; quem está marcado como
// destinatário vê e pode concluir/cancelar o que é dele. Lista simples (sem
// filtros/busca — volume baixo por natureza) com um modal de criação.

function statusLabel(l) {
    if (l.status === 'Concluido') return 'Concluído';
    if (l.status === 'Cancelado') return 'Cancelado';
    if (l.status === 'Encerrado') return 'Encerrado';
    const d = parseDisplayDateLocal(l.dataAlvo);
    if (d) {
        const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
        if (d < hoje) return 'Atrasado';
        if (d.getTime() === hoje.getTime()) return 'Hoje';
    }
    return 'Pendente';
}

function statusClass(l) {
    if (l.status === 'Concluido') return 'pedido';
    if (l.status === 'Cancelado' || l.status === 'Encerrado') return 'erro';
    const label = statusLabel(l);
    if (label === 'Atrasado') return 'erro';
    if (label === 'Hoje') return 'apresentacao';
    return 'preventiva';
}

// Rótulo curto da frequência, pro badge do card — "" quando não repete
// (card fica sem badge nenhum).
const RECORRENCIA_LABELS = { diaria: 'Diária', semanal: 'Semanal', mensal: 'Mensal', anual: 'Anual' };
function recorrenciaBadgeHtml(l) {
    if (!l.recorrencia || l.recorrencia === 'nenhuma') return '';
    let texto = RECORRENCIA_LABELS[l.recorrencia];
    if (!texto && l.recorrencia === 'personalizada') {
        const cfg = l.recorrenciaConfig || {};
        texto = cfg.intervalo ? `A cada ${cfg.intervalo} ${cfg.unidade || 'dias'}` : 'Personalizada';
    }
    if (!texto) texto = l.recorrencia;
    return `<span class="status-tag preventiva" title="Repete">🔁 ${escapeHtml(texto)}</span>`;
}

function terminoBadgeHtml(l) {
    if (l.terminoTipo === 'data' && l.terminoData) {
        return `<span class="status-tag pedido" title="Encerra sozinho nessa data">⏹️ Até ${escapeHtml(l.terminoData)}</span>`;
    }
    if (l.terminoTipo === 'ocorrencias' && l.terminoOcorrencias) {
        return `<span class="status-tag pedido" title="Para depois dessa quantidade de vezes">⏹️ ${l.ocorrenciaNumero || 1}/${l.terminoOcorrencias}x</span>`;
    }
    return '';
}

function parseDisplayDateLocal(value) {
    if (!value || String(value).indexOf('/') === -1) return null;
    const [d, m, y] = String(value).split('/');
    const date = new Date(Number(y), Number(m) - 1, Number(d));
    date.setHours(0, 0, 0, 0);
    return isNaN(date) ? null : date;
}

export async function getLembretesAdmin() {
    try {
        const r = await callAPI('getLembretesAdmin', { user: state.currentUser });
        if (r.status === 'success') { saveCache('lembretesAdmin', r.lembretes || []); }
        return r;
    } catch (error) {
        return { status: 'error', message: error.message };
    }
}

export async function renderLembretesPage() {
    ensureStyles('visits');
    const mainContent = document.getElementById('main-content');
    const cached = loadCache('lembretesAdmin');
    if (cached) {
        state.lembretesAdmin = cached;
        fillLembretesContent(mainContent, state.lembretesAdmin);
        addScrollTop();
        initPullToRefresh(async () => { await refreshLembretes(); });
        getLembretesAdmin().then((r) => {
            if (r.status === 'success' && state.currentPage === 'lembretes') {
                state.lembretesAdmin = r.lembretes || [];
                fillLembretesContent(document.getElementById('main-content'), state.lembretesAdmin);
            }
        });
        return;
    }
    mainContent.innerHTML = loadingState('📌', 'Carregando lembretes...');
    const result = await getLembretesAdmin();
    if (result.status !== 'success') {
        mainContent.innerHTML = `<p class="error-message">${escapeHtml(result.message || 'Erro ao carregar lembretes.')}</p>`;
        return;
    }
    state.lembretesAdmin = result.lembretes || [];
    fillLembretesContent(mainContent, state.lembretesAdmin);
    addScrollTop();
    initPullToRefresh(async () => { await refreshLembretes(); });
}

async function refreshLembretes() {
    const r = await getLembretesAdmin();
    if (r.status === 'success' && state.currentPage === 'lembretes') {
        state.lembretesAdmin = r.lembretes || [];
        const el = document.getElementById('main-content');
        if (el) fillLembretesContent(el, state.lembretesAdmin);
    }
}

function lembreteCardHtml(l, { isAdmin, podeAgir }) {
    const acoes = [];
    if (podeAgir && l.status === 'Pendente') {
        acoes.push(`<button type="button" class="text-link" data-lembrete-concluir="${escapeHtml(l.id)}">✅ Concluir</button>`);
        acoes.push(`<button type="button" class="text-link" data-lembrete-cancelar="${escapeHtml(l.id)}">Cancelar</button>`);
    }
    if (isAdmin) {
        acoes.push(`<button type="button" class="text-link" data-lembrete-apagar="${escapeHtml(l.id)}">🗑️ Apagar</button>`);
    }
    return `
        <div class="card" data-lembrete-id="${escapeHtml(l.id)}" style="margin-bottom:0.5rem">
            <div class="item-top">
                <span class="item-name">${escapeHtml(l.texto || '-')}</span>
                <span class="status-tag ${statusClass(l)}">${statusLabel(l)}</span>
            </div>
            <div class="item-meta">${escapeHtml(['📅 ' + (l.dataAlvo || '-'), '👤 ' + (l.destinatarios || []).join(', ')].filter(Boolean).join(' · '))} ${recorrenciaBadgeHtml(l)} ${terminoBadgeHtml(l)}</div>
            ${acoes.length ? `<div style="display:flex;gap:0.9rem;margin-top:0.5rem;flex-wrap:wrap">${acoes.join('')}</div>` : ''}
        </div>`;
}

function fillLembretesContent(mainContent, lembretes) {
    const isAdmin = String(state.currentUser?.profile || '').trim().toLowerCase() === 'admin';
    const userName = String(state.currentUser?.name || '').trim().toLowerCase();
    const podeAgirEm = (l) => isAdmin || (l.destinatarios || []).some((d) => String(d).trim().toLowerCase() === userName);

    const pendentes = [...lembretes]
        .filter((l) => l.status === 'Pendente')
        .sort((a, b) => (parseDisplayDateLocal(a.dataAlvo)?.getTime() || 0) - (parseDisplayDateLocal(b.dataAlvo)?.getTime() || 0));
    const historico = [...lembretes]
        .filter((l) => l.status !== 'Pendente')
        .sort((a, b) => (parseDisplayDateLocal(b.dataAlvo)?.getTime() || 0) - (parseDisplayDateLocal(a.dataAlvo)?.getTime() || 0));

    mainContent.innerHTML = `
        <div class="page-header">
            <div>
                <h2>Lembretes</h2>
                <p class="page-subtitle">Avisos recorrentes pro time administrativo, via WhatsApp</p>
            </div>
            ${isAdmin ? '<button class="primary-btn" id="btn-new-lembrete" type="button">+ Novo Lembrete</button>' : ''}
        </div>
        ${pendentes.length === 0 && historico.length === 0 ? `
            <div class="empty-state">
                <span class="empty-state-icon">📌</span>
                <p>Nenhum lembrete ${isAdmin ? 'criado' : 'atribuído a você'} ainda.</p>
            </div>
        ` : `
            <p class="section-label">Pendentes</p>
            ${pendentes.length
                ? pendentes.map((l) => lembreteCardHtml(l, { isAdmin, podeAgir: podeAgirEm(l) })).join('')
                : '<p class="helper-text" style="text-align:center;padding:0.5rem 0">Nenhum lembrete pendente.</p>'}
            ${historico.length ? `
                <p style="margin:0.75rem 0 0.4rem">
                    <span class="text-link" role="button" tabindex="0" id="lembretes-historico-toggle">👁️ Mostrar histórico (${historico.length})</span>
                </p>
                <div id="lembretes-historico" hidden>
                    ${historico.map((l) => lembreteCardHtml(l, { isAdmin, podeAgir: false })).join('')}
                </div>
            ` : ''}
        `}
    `;

    document.getElementById('btn-new-lembrete')?.addEventListener('click', () => openCreateLembreteModal());

    document.getElementById('lembretes-historico-toggle')?.addEventListener('click', () => {
        const el = document.getElementById('lembretes-historico');
        const toggle = document.getElementById('lembretes-historico-toggle');
        el.hidden = !el.hidden;
        toggle.textContent = el.hidden ? `👁️ Mostrar histórico (${historico.length})` : '🙈 Ocultar histórico';
    });

    mainContent.querySelectorAll('[data-lembrete-concluir]').forEach((btn) => {
        btn.addEventListener('click', () => atualizarStatusLembrete(btn.dataset.lembreteConcluir, 'Concluido', btn));
    });
    mainContent.querySelectorAll('[data-lembrete-cancelar]').forEach((btn) => {
        btn.addEventListener('click', () => {
            if (!confirm('Cancelar este lembrete? Se ele repete, a série para aqui (não gera a próxima ocorrência).')) return;
            atualizarStatusLembrete(btn.dataset.lembreteCancelar, 'Cancelado', btn);
        });
    });
    mainContent.querySelectorAll('[data-lembrete-apagar]').forEach((btn) => {
        btn.addEventListener('click', async () => {
            if (!confirm('Apagar este lembrete? Essa ação não pode ser desfeita.')) return;
            setSaving(true, btn, '');
            const r = await callAPI('deleteLembreteAdmin', { id: btn.dataset.lembreteApagar, user: state.currentUser }).catch((e) => ({ status: 'error', message: e.message }));
            if (r && r.status === 'success') {
                state.lembretesAdmin = (state.lembretesAdmin || []).filter((x) => String(x.id) !== String(btn.dataset.lembreteApagar));
                saveCache('lembretesAdmin', state.lembretesAdmin);
                showToast('Lembrete apagado.');
                fillLembretesContent(mainContent, state.lembretesAdmin);
            } else {
                showToast((r && r.message) || 'Não foi possível apagar.', true);
                setSaving(false, btn);
            }
        });
    });
}

async function atualizarStatusLembrete(id, status, btn) {
    setSaving(true, btn, '');
    const r = await callAPI('updateLembreteAdmin', { id, status, user: state.currentUser }).catch((e) => ({ status: 'error', message: e.message }));
    if (r && r.status === 'success') {
        const idx = (state.lembretesAdmin || []).findIndex((x) => String(x.id) === String(id));
        if (idx >= 0) state.lembretesAdmin[idx] = r.lembrete;
        if (r.proximo) state.lembretesAdmin.push(r.proximo);
        saveCache('lembretesAdmin', state.lembretesAdmin);
        showToast(status === 'Concluido'
            ? (r.proximo ? 'Lembrete concluído — próxima ocorrência já agendada.' : 'Lembrete concluído.')
            : 'Lembrete cancelado.');
        const mainContent = document.getElementById('main-content');
        if (mainContent) fillLembretesContent(mainContent, state.lembretesAdmin);
    } else {
        showToast((r && r.message) || 'Não foi possível salvar.', true);
        setSaving(false, btn);
    }
}

async function openCreateLembreteModal() {
    const formDataResult = await ensureFormData();
    const vendedoresAll = (formDataResult.data && formDataResult.data.vendedores) || [];
    const notifyOptions = resolveNotifyOptions(vendedoresAll, state.currentUser);

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    const defaultDate = new Date();
    defaultDate.setDate(defaultDate.getDate() + 1);
    overlay.innerHTML = `
        <div class="modal-card newag-modal">
            <div class="newag-modal-header">
                <span class="newag-modal-header-icon" aria-hidden="true">📌</span>
                <h3>Novo lembrete</h3>
                <button type="button" class="newag-modal-close" id="lembrete-close" aria-label="Fechar">✕</button>
            </div>
            <div class="newag-modal-body">
                <div class="form-group full-width">
                    <label for="lembrete-texto">Lembrete *</label>
                    <textarea id="lembrete-texto" rows="2" placeholder="Ex.: Comprar etiquetas, Enviar nota fiscal da Unimed"></textarea>
                </div>
                <div class="form-group full-width">
                    <label for="lembrete-data">Data *</label>
                    <input type="date" id="lembrete-data" value="${defaultDate.toISOString().slice(0, 10)}">
                </div>
                <div class="form-group full-width">
                    <label for="lembrete-frequencia">Frequência</label>
                    <select id="lembrete-frequencia">
                        <option value="nenhuma">Não repete</option>
                        <option value="diaria">Diária</option>
                        <option value="semanal">Semanal</option>
                        <option value="mensal">Mensal (mesmo dia da data acima)</option>
                        <option value="anual">Anual (mesmo dia/mês da data acima)</option>
                        <option value="personalizada">Personalizada</option>
                    </select>
                </div>
                <div class="form-group full-width" id="lembrete-freq-diaria" hidden>
                    <label class="newag-repetir-row">
                        <input type="checkbox" id="lembrete-dias-uteis" style="width:auto;min-height:0">
                        Só em dias úteis (pula sábado/domingo)
                    </label>
                </div>
                <div class="form-group full-width" id="lembrete-freq-semanal" hidden>
                    <label>Em quais dias da semana</label>
                    <div class="radio-group" style="flex-wrap:wrap">
                        ${['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'].map((d, i) => `
                            <label class="radio-pill"><input type="checkbox" class="lembrete-dia-semana" value="${i}"><span>${d}</span></label>
                        `).join('')}
                    </div>
                </div>
                <div class="form-group full-width" id="lembrete-freq-personalizada" hidden>
                    <label for="lembrete-intervalo">A cada</label>
                    <div style="display:flex;gap:0.5rem;align-items:center">
                        <input type="number" id="lembrete-intervalo" min="1" value="1" style="max-width:90px">
                        <select id="lembrete-unidade">
                            <option value="dias">dias</option>
                            <option value="semanas">semanas</option>
                            <option value="meses">meses</option>
                        </select>
                    </div>
                </div>
                <div class="form-group full-width" id="lembrete-freq-fds" hidden>
                    <label for="lembrete-ajuste-fds">Se a próxima cair num fim de semana</label>
                    <select id="lembrete-ajuste-fds">
                        <option value="manter">Manter mesmo assim</option>
                        <option value="adiar">Adiar pro próximo dia útil</option>
                        <option value="antecipar">Antecipar pro dia útil anterior</option>
                    </select>
                </div>
                <div class="form-group full-width" id="lembrete-freq-help" hidden>
                    <p class="helper-text" style="text-align:left;margin:0">Ao concluir, a próxima ocorrência já é criada sozinha — cancelar em vez de concluir encerra a série.</p>
                </div>
                <div class="form-group full-width">
                    <label>Termina</label>
                    <div class="radio-group" style="flex-wrap:wrap">
                        <label class="radio-pill"><input type="radio" name="lembrete-termino" value="nunca" checked><span>Nunca</span></label>
                        <label class="radio-pill"><input type="radio" name="lembrete-termino" value="data"><span>Numa data</span></label>
                        <label class="radio-pill" id="lembrete-termino-ocorrencias-opt" hidden><input type="radio" name="lembrete-termino" value="ocorrencias"><span>Depois de X vezes</span></label>
                    </div>
                    <p class="helper-text" style="text-align:left;margin:0.2rem 0 0">"Numa data" encerra o lembrete sozinho quando chegar o dia — sem precisar Concluir/Cancelar na mão.</p>
                </div>
                <div class="form-group full-width" id="lembrete-termino-data-group" hidden>
                    <label for="lembrete-termino-data">Até quando</label>
                    <input type="date" id="lembrete-termino-data">
                </div>
                <div class="form-group full-width" id="lembrete-termino-ocorrencias-group" hidden>
                    <label for="lembrete-termino-ocorrencias">Depois de quantas vezes</label>
                    <input type="number" id="lembrete-termino-ocorrencias" min="1" value="3">
                </div>
                ${multiCheckFilterFieldHtml('Destinatário(s) *', 'lembrete-destinatarios')}
            </div>
            <div class="newag-modal-footer">
                <button type="button" class="secondary-button" id="lembrete-cancel">Cancelar</button>
                <button type="button" class="primary-button" id="lembrete-save">Salvar lembrete</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);

    wireMultiCheckFilter({
        triggerId: 'lembrete-destinatarios-trigger', inputId: 'lembrete-destinatarios', menuId: 'lembrete-destinatarios-menu',
        options: notifyOptions, emptyLabel: 'Escolha...'
    });

    const close = () => overlay.remove();
    overlay.querySelector('#lembrete-close').addEventListener('click', close);
    overlay.querySelector('#lembrete-cancel').addEventListener('click', close);

    // Mostra só os campos que fazem sentido pra frequência escolhida — e
    // "depois de X vezes" só existe fazendo sentido pra quem repete (um
    // lembrete que não repete não tem "quantas vezes").
    const atualizarVisibilidadeFrequencia = () => {
        const freq = overlay.querySelector('#lembrete-frequencia').value;
        overlay.querySelector('#lembrete-freq-diaria').hidden = freq !== 'diaria';
        overlay.querySelector('#lembrete-freq-semanal').hidden = freq !== 'semanal';
        overlay.querySelector('#lembrete-freq-personalizada').hidden = freq !== 'personalizada';
        overlay.querySelector('#lembrete-freq-fds').hidden = (freq === 'nenhuma' || freq === 'diaria');
        overlay.querySelector('#lembrete-freq-help').hidden = freq === 'nenhuma';
        const ocorrenciasOpt = overlay.querySelector('#lembrete-termino-ocorrencias-opt');
        ocorrenciasOpt.hidden = freq === 'nenhuma';
        if (freq === 'nenhuma' && overlay.querySelector('input[name="lembrete-termino"][value="ocorrencias"]').checked) {
            overlay.querySelector('input[name="lembrete-termino"][value="nunca"]').checked = true;
            atualizarVisibilidadeTermino();
        }
    };
    const atualizarVisibilidadeTermino = () => {
        const tipo = overlay.querySelector('input[name="lembrete-termino"]:checked')?.value || 'nunca';
        overlay.querySelector('#lembrete-termino-data-group').hidden = tipo !== 'data';
        overlay.querySelector('#lembrete-termino-ocorrencias-group').hidden = tipo !== 'ocorrencias';
    };
    overlay.querySelector('#lembrete-frequencia').addEventListener('change', atualizarVisibilidadeFrequencia);
    overlay.querySelectorAll('input[name="lembrete-termino"]').forEach((el) => el.addEventListener('change', atualizarVisibilidadeTermino));

    overlay.querySelector('#lembrete-save').addEventListener('click', async () => {
        const btn = overlay.querySelector('#lembrete-save');
        const texto = overlay.querySelector('#lembrete-texto').value.trim();
        const dataVal = overlay.querySelector('#lembrete-data').value;
        const destinatariosVal = (overlay.querySelector('#lembrete-destinatarios').value || '').split(',').filter(Boolean);
        if (!texto) { showToast('Escreva o lembrete.', true); return; }
        if (!dataVal) { showToast('Informe a data.', true); return; }
        if (!destinatariosVal.length) { showToast('Escolha quem deve receber.', true); return; }

        const recorrencia = overlay.querySelector('#lembrete-frequencia').value;
        const recorrenciaConfig = {};
        if (recorrencia === 'diaria') {
            recorrenciaConfig.apenasUteis = overlay.querySelector('#lembrete-dias-uteis').checked;
        } else if (recorrencia === 'semanal') {
            recorrenciaConfig.dias = Array.from(overlay.querySelectorAll('.lembrete-dia-semana:checked')).map((el) => Number(el.value));
            if (!recorrenciaConfig.dias.length) { showToast('Escolha pelo menos um dia da semana.', true); return; }
        } else if (recorrencia === 'personalizada') {
            recorrenciaConfig.intervalo = Number(overlay.querySelector('#lembrete-intervalo').value) || 1;
            recorrenciaConfig.unidade = overlay.querySelector('#lembrete-unidade').value;
        }
        if (recorrencia !== 'nenhuma') {
            recorrenciaConfig.ajusteFimDeSemana = overlay.querySelector('#lembrete-ajuste-fds').value;
        }

        const terminoTipo = overlay.querySelector('input[name="lembrete-termino"]:checked')?.value || 'nunca';
        let terminoData = '';
        let terminoOcorrencias;
        if (terminoTipo === 'data') {
            terminoData = overlay.querySelector('#lembrete-termino-data').value;
            if (!terminoData) { showToast('Informe até quando.', true); return; }
        } else if (terminoTipo === 'ocorrencias') {
            terminoOcorrencias = Number(overlay.querySelector('#lembrete-termino-ocorrencias').value);
            if (!terminoOcorrencias) { showToast('Informe depois de quantas vezes parar.', true); return; }
        }

        setSaving(true, btn, 'Salvando...');
        const r = await callAPI('createLembreteAdmin', {
            texto, dataAlvo: dataVal, destinatarios: destinatariosVal,
            recorrencia, recorrenciaConfig,
            terminoTipo, terminoData, terminoOcorrencias,
            user: state.currentUser
        }).catch((e) => ({ status: 'error', message: e.message }));
        if (r && r.status === 'success') {
            state.lembretesAdmin = [r.lembrete, ...(state.lembretesAdmin || [])];
            saveCache('lembretesAdmin', state.lembretesAdmin);
            showToast('Lembrete criado.');
            close();
            const mainContent = document.getElementById('main-content');
            if (mainContent) fillLembretesContent(mainContent, state.lembretesAdmin);
        } else {
            showToast((r && r.message) || 'Não foi possível salvar.', true);
            setSaving(false, btn);
        }
    });
}
