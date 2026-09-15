import { state, navigateTo } from '../app.js';
import { callAPI, ensureFormData, attemptOrQueue } from '../api.js';
import {
    escapeHtml, isAdminOrGerenteUser, datedNoteHeader, withDatedNoteHeader, stripEmptyDatedLine, selectNoteHint, formatCurrency,
    formatDateFieldValue, normalizeDisplayDateValue, parseDisplayDate, clienteSearchItem, findClienteByNome
} from '../utils/format.js';
import { showToast, setSaving, skeletonList, addScrollTop, openExternal, initializeSearchableInput } from '../utils/dom.js';
import { renderBreadcrumb, ensureStyles } from '../utils/ui.js';

const PROP_STATUS = ['Enviada', 'Em negociacao', 'Ganhamos', 'Perdido'];
const FUNIL_STATUS = ['IDENTIFICAR', 'PROPOSTA', 'NEGOCIAR', 'CONCLUIDO', 'PERDIDO', 'RETOMAR'];

// Modo seleção da lista de campanhas (apagar várias de uma vez) — em nível
// de módulo porque renderCampanhasPage se rechama depois de cada ação
// (apagar, etc.), então precisa sobreviver a esses re-renders.
let campSelectMode = false;
const campSelectedIds = new Set();

// Vencida = já passou do prazo e ainda não terminou — concluída não vence
// mais, mesmo que tenha passado do prazo depois. Compartilhado entre a
// ordenação da lista e o card em si, pra não duplicar o critério.
function campanhaEstaVencida(c) {
    if (c.status === 'concluida' || !c.prazoAte) return false;
    const prazoDate = parseDisplayDate(c.prazoAte);
    if (!prazoDate) return false;
    const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
    return prazoDate < hoje;
}

function campanhaLink(id, loginNome) {
    // ?c=<id> (não /c/<id>): mantém o path na raiz pra os assets relativos
    // do app carregarem quando o link é aberto num navegador limpo.
    // &n=<nome> (opcional): login do vendedor destino já embutido no link,
    // pra tela de login pré-preencher e pedir só o PIN.
    const n = loginNome ? `&n=${encodeURIComponent(loginNome)}` : '';
    return `${window.location.origin}/?c=${id}${n}`;
}

// ── Modal "Selecionar clientes" (aberto pelas telas Propostas/Funil) ────
// items: [{ id, cliente, cidade, extra }]  — normalmente a lista já filtrada.
export function openSelecionarClientesModal(tipo, items) {
    ensureStyles('proposals');
    const list = (items || []).filter((x) => x && x.id);
    if (!list.length) { showToast('Nenhum item na lista pra selecionar.', true); return; }

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
        <div class="modal-card camp-modal" style="text-align:left;max-width:480px">
            <h3 style="margin-top:0">🔗 Campanha de atualização</h3>
            <p class="helper-text" style="margin:-0.3rem 0 0.6rem">Marque os clientes que o vendedor deve atualizar (${tipo === 'funil' ? 'Funil' : 'Propostas'}).</p>
            <input type="text" id="camp-sel-search" class="form-input" placeholder="Filtrar…" style="margin-bottom:0.5rem">
            <label class="camp-sel-row" style="font-weight:700"><input type="checkbox" id="camp-sel-all"> Selecionar todos</label>
            <div id="camp-sel-list" style="max-height:48vh;overflow-y:auto;margin:0.3rem 0 0.6rem">
                ${list.map((it) => `
                    <label class="camp-sel-row" data-txt="${escapeHtml((it.cliente + ' ' + (it.cidade || '')).toLowerCase())}">
                        <input type="checkbox" class="camp-sel-item" value="${escapeHtml(it.id)}">
                        <span><strong>${escapeHtml(it.cliente || 'Cliente')}</strong>${it.funilDiversey ? ' <span class="funil-diversey-tag">⭐ Diversey</span>' : ''}${it.cidade || it.extra ? `<br><span class="helper-text">${escapeHtml([it.cidade, it.extra].filter(Boolean).join(' · '))}</span>` : ''}</span>
                    </label>`).join('')}
            </div>
            <div class="form-actions full-width" style="display:flex;gap:0.5rem">
                <button type="button" class="secondary-button" id="camp-sel-cancel">Cancelar</button>
                <button type="button" class="primary-button" id="camp-sel-next">Continuar</button>
            </div>
        </div>`;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
    overlay.querySelector('#camp-sel-cancel').addEventListener('click', close);

    const rows = () => Array.from(overlay.querySelectorAll('.camp-sel-item'));
    overlay.querySelector('#camp-sel-all').addEventListener('change', (e) => {
        rows().forEach((r) => { if (r.closest('.camp-sel-row').style.display !== 'none') r.checked = e.target.checked; });
    });
    overlay.querySelector('#camp-sel-search').addEventListener('input', (e) => {
        const q = e.target.value.trim().toLowerCase();
        overlay.querySelectorAll('.camp-sel-row[data-txt]').forEach((row) => {
            row.style.display = !q || row.dataset.txt.includes(q) ? '' : 'none';
        });
    });
    overlay.querySelector('#camp-sel-next').addEventListener('click', () => {
        const ids = rows().filter((r) => r.checked).map((r) => r.value);
        if (!ids.length) { showToast('Marque ao menos um cliente.', true); return; }
        const selected = list.filter((it) => ids.includes(String(it.id)));
        close();
        openGerarCampanhaModal(tipo, ids, selected);
    });
}

// ── Modal "Relatório de Visita" (campanha tipo 'visita') ──────────────────
// Diferente das outras: não parte de itens já cadastrados (Proposta/Funil).
// O admin escreve um rascunho do relatório (cliente, cidade...) e o
// vendedor completa/edita tudo antes de confirmar — aí sim vira uma Visita
// de verdade (ver handleResponderCampanhaItem, tipo 'visita').
export async function openGerarCampanhaVisitaModal() {
    ensureStyles('visits');
    const fd = await ensureFormData().then((r) => r.data).catch(() => null);
    const vendedoresRaw = ((fd && fd.vendedores) || []).filter((v) => v.nome);
    const vendedores = vendedoresRaw.map((v) => v.nome);
    const loginNomeByVendedor = new Map(vendedoresRaw.map((v) => [v.nome, v.nomeLogin || v.nome]));
    const clientes = (fd && fd.clientes) || [];
    const cidades = (fd && fd.cidades) || [];
    const areas = (fd && fd.areasAtuacao) || [];
    const tipos = (fd && fd.tiposVisita) || [];

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
        <div class="modal-card camp-modal" style="text-align:left;max-width:480px">
            <h3 style="margin-top:0">📋 Pedir relatório de visita</h3>
            <p class="helper-text" style="margin:-0.3rem 0 0.9rem">Escreva o que já sabe — o vendedor completa e confirma antes de virar uma visita de verdade.</p>
            <div class="form-group full-width">
                <label for="cv-cliente">Cliente</label>
                <div class="searchable-select">
                    <input type="text" id="cv-cliente" placeholder="Busque ou digite o cliente" autocomplete="off">
                    <div class="searchable-select-menu" id="cv-cliente-menu"></div>
                </div>
            </div>
            <div class="form-row-pair">
                <div class="form-group">
                    <label for="cv-cidade">Cidade</label>
                    <div class="searchable-select">
                        <input type="text" id="cv-cidade" placeholder="Cidade" autocomplete="off">
                        <div class="searchable-select-menu" id="cv-cidade-menu"></div>
                    </div>
                </div>
                <div class="form-group">
                    <label for="cv-area">Área de Atuação</label>
                    <div class="searchable-select">
                        <input type="text" id="cv-area" placeholder="Área" autocomplete="off">
                        <div class="searchable-select-menu" id="cv-area-menu"></div>
                    </div>
                </div>
            </div>
            <div class="form-row-pair">
                <div class="form-group">
                    <label for="cv-tipo">Tipo da Visita</label>
                    <select id="cv-tipo">
                        <option value="">—</option>
                        ${tipos.map((t) => `<option value="${escapeHtml(t.tipo)}">${escapeHtml(t.tipo)}</option>`).join('')}
                    </select>
                </div>
                <div class="form-group">
                    <label for="cv-data">Data prevista</label>
                    <input type="date" id="cv-data">
                </div>
            </div>
            <div class="form-group full-width">
                <label for="cv-relatorio">Relatório (ponto de partida pro vendedor)</label>
                <textarea id="cv-relatorio" rows="4" placeholder="Ex.: Visitar pra apresentar a linha de lavanderia, cliente já demonstrou interesse na última ligação..."></textarea>
            </div>
            <div class="form-group full-width">
                <label for="cv-vendedor">Vendedor que vai completar</label>
                <select id="cv-vendedor">
                    <option value="">Escolha o vendedor</option>
                    ${vendedores.map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('')}
                </select>
            </div>
            <div class="form-group full-width">
                <label for="cv-prazo">Prazo pra responder (opcional)</label>
                <input type="date" id="cv-prazo">
            </div>
            <div id="cv-result" hidden style="margin:0.5rem 0 0.75rem"></div>
            <div class="form-actions full-width" style="display:flex;gap:0.5rem">
                <button type="button" class="secondary-button" id="cv-cancel">Fechar</button>
                <button type="button" class="primary-button" id="cv-gerar">Gerar link</button>
            </div>
        </div>`;
    document.body.appendChild(overlay);
    let created = false;
    const close = () => { overlay.remove(); if (created) renderCampanhasPage(); };
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
    overlay.querySelector('#cv-cancel').addEventListener('click', close);

    initializeSearchableInput({ input: overlay.querySelector('#cv-cidade'), menu: overlay.querySelector('#cv-cidade-menu'), items: cidades, allowFreeText: true });
    initializeSearchableInput({ input: overlay.querySelector('#cv-area'), menu: overlay.querySelector('#cv-area-menu'), items: areas, allowFreeText: true });
    initializeSearchableInput({
        input: overlay.querySelector('#cv-cliente'),
        menu: overlay.querySelector('#cv-cliente-menu'),
        items: clientes.map((c) => clienteSearchItem(c)),
        allowFreeText: true,
        onSelect: (value) => {
            const match = findClienteByNome(clientes, value);
            if (!match) return;
            if (match.cidade) overlay.querySelector('#cv-cidade').value = match.cidade;
            if (match.areaAtuacao) overlay.querySelector('#cv-area').value = match.areaAtuacao;
        }
    });

    overlay.querySelector('#cv-gerar').addEventListener('click', async (ev) => {
        const btn = ev.currentTarget;
        const cliente = overlay.querySelector('#cv-cliente').value.trim();
        if (!cliente) { showToast('Informe o cliente.', true); return; }
        const vendedorDestino = overlay.querySelector('#cv-vendedor').value.trim();
        if (!vendedorDestino) { showToast('Escolha o vendedor.', true); return; }
        const cidade = overlay.querySelector('#cv-cidade').value.trim();
        const areaAtuacao = overlay.querySelector('#cv-area').value.trim();
        const tipoVisita = overlay.querySelector('#cv-tipo').value;
        const dataInput = overlay.querySelector('#cv-data').value;
        const data = dataInput ? formatDateFromInputValue(dataInput) : '';
        const relatorio = overlay.querySelector('#cv-relatorio').value.trim();
        const prazoInput = overlay.querySelector('#cv-prazo').value;
        const prazoAte = prazoInput ? formatDateFromInputValue(prazoInput) : '';

        setSaving(true, btn, 'Gerando...');
        const r = await callAPI('criarCampanha', {
            tipo: 'visita',
            titulo: `Relatório — ${cliente}`,
            vendedorDestino,
            prazoAte,
            itensVisita: [{ cliente, cidade, areaAtuacao, tipoVisita, data, relatorio }],
            user: state.currentUser
        }).catch(() => null);
        if (!r || r.status !== 'success') {
            showToast((r && r.message) || 'Não foi possível gerar a campanha.', true);
            setSaving(false, btn);
            return;
        }
        const loginNome = loginNomeByVendedor.get(vendedorDestino) || '';
        const link = campanhaLink(r.id, loginNome);
        const box = overlay.querySelector('#cv-result');
        box.hidden = false;
        box.innerHTML = `
            <p class="helper-text" style="margin:0 0 0.35rem">Link pronto — mande pro ${escapeHtml(vendedorDestino)}${prazoAte ? ` (prazo ${escapeHtml(prazoAte)})` : ''}:</p>
            <input type="text" id="cv-link" readonly value="${escapeHtml(link)}" style="font-size:0.82rem">
            <div style="display:flex;gap:0.5rem;margin-top:0.5rem">
                <button type="button" class="mini-button" id="cv-copy">Copiar</button>
                <button type="button" class="mini-button mini-button-whatsapp" id="cv-wa">WhatsApp</button>
            </div>`;
        btn.remove();
        created = true;
        overlay.querySelector('#cv-cancel').textContent = 'Concluir';
        const buildMsg = () => {
            const primeiroNome = vendedorDestino.split(' ')[0];
            return [
                `Oi ${primeiroNome}! Preciso que você complete um relatório de visita — ${cliente}${cidade ? ' (' + cidade + ')' : ''}:`,
                relatorio ? `\n${relatorio}` : '',
                prazoAte ? `\nPrazo: ${prazoAte}` : '',
                loginNome
                    ? `\nPra entrar, é só abrir o link e informar seu PIN (4 últimos números do seu celular) — seu login já vem preenchido.`
                    : `\nPra entrar: login é seu nome (em minúsculo) e PIN são os 4 últimos números do seu celular.`,
                `\n${link}`
            ].filter(Boolean).join('\n');
        };
        overlay.querySelector('#cv-copy').addEventListener('click', () => {
            navigator.clipboard?.writeText(buildMsg()).then(() => showToast('Mensagem copiada.'));
            overlay.querySelector('#cv-link').select();
        });
        overlay.querySelector('#cv-wa').addEventListener('click', () => {
            openExternal(`https://wa.me/?text=${encodeURIComponent(buildMsg())}`);
        });
        document.dispatchEvent(new CustomEvent('campanha-criada'));
    });
}

function formatDateFromInputValue(isoDate) {
    const d = new Date(`${isoDate}T00:00:00`);
    if (Number.isNaN(d.getTime())) return '';
    return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}

// ── Modal "Gerar link de atualização" (chamado das telas Propostas/Funil) ──
// selectedItems: [{ id, cliente, cidade, extra }] — os mesmos itens marcados
// no modal de seleção, só pra montar a mensagem do WhatsApp com os nomes.
export async function openGerarCampanhaModal(tipo, itemIds, selectedItems) {
    if (!itemIds || !itemIds.length) { showToast('Selecione ao menos um cliente.', true); return; }
    ensureStyles('proposals');
    const fd = await ensureFormData().then((r) => r.data).catch(() => null);
    const vendedoresRaw = ((fd && fd.vendedores) || []).filter((v) => v.nome);
    const vendedores = vendedoresRaw.map((v) => v.nome);
    // Nome de login de cada vendedor (o que ele usa pra entrar com PIN) —
    // pra embutir no link e a tela de login já vir preenchida. Cai pro nome
    // completo quando o vendedor não tem um "nome de login" cadastrado
    // (mesmo fallback que o login por PIN já usa).
    const loginNomeByVendedor = new Map(vendedoresRaw.map((v) => [v.nome, v.nomeLogin || v.nome]));

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
        <div class="modal-card camp-modal" style="text-align:left;max-width:440px">
            <h3 style="margin-top:0">🔗 Gerar link de atualização</h3>
            <p class="helper-text" style="margin:-0.3rem 0 0.9rem">${itemIds.length} ${tipo === 'funil' ? 'oportunidade(s) do Funil' : 'proposta(s)'} selecionada(s).</p>
            <div class="form-group full-width">
                <label for="camp-titulo">Título</label>
                <input type="text" id="camp-titulo" placeholder="Ex.: Atualização de setembro" value="Atualização ${new Date().toLocaleDateString('pt-BR')}">
            </div>
            <div class="form-group full-width">
                <label for="camp-vendedor">Vendedor que vai preencher</label>
                <select id="camp-vendedor">
                    <option value="">Escolha o vendedor</option>
                    ${vendedores.map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('')}
                </select>
            </div>
            <div class="form-group full-width">
                <label for="camp-prazo">Prazo (opcional)</label>
                <div class="date-input-group">
                    <input type="text" id="camp-prazo" placeholder="dd/mm/aaaa" inputmode="numeric" maxlength="10">
                    <button type="button" class="date-picker-button" id="camp-prazo-open" aria-label="Abrir calendário">📅</button>
                    <div class="picker-menu" id="camp-prazo-menu">
                        <input type="date" id="camp-prazo-picker" class="picker-native-input">
                    </div>
                </div>
            </div>
            <div id="camp-result" hidden style="margin:0.5rem 0 0.75rem"></div>
            <div class="form-actions full-width" style="display:flex;gap:0.5rem">
                <button type="button" class="secondary-button" id="camp-cancel">Fechar</button>
                <button type="button" class="primary-button" id="camp-gerar">Gerar link</button>
            </div>
        </div>`;
    document.body.appendChild(overlay);
    const close = () => { overlay.remove(); document.removeEventListener('click', closePrazoMenuOnOutsideClick); };
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
    overlay.querySelector('#camp-cancel').addEventListener('click', close);

    const prazoInput = overlay.querySelector('#camp-prazo');
    const prazoMenu = overlay.querySelector('#camp-prazo-menu');
    const prazoPicker = overlay.querySelector('#camp-prazo-picker');
    const prazoOpenBtn = overlay.querySelector('#camp-prazo-open');
    prazoInput.addEventListener('input', () => { prazoInput.value = formatDateFieldValue(prazoInput.value); });
    prazoInput.addEventListener('blur', () => {
        setTimeout(() => {
            if (!prazoInput.value.trim()) return;
            prazoInput.value = normalizeDisplayDateValue(prazoInput.value) || prazoInput.value;
        }, 150);
    });
    prazoOpenBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const opening = !prazoMenu.classList.contains('visible');
        prazoMenu.classList.remove('visible');
        if (opening) { prazoMenu.classList.add('visible'); prazoPicker.focus(); }
    });
    prazoPicker.addEventListener('change', () => {
        if (!prazoPicker.value) return;
        const d = new Date(`${prazoPicker.value}T00:00:00`);
        if (!Number.isNaN(d.getTime())) {
            prazoInput.value = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
            prazoMenu.classList.remove('visible');
        }
    });
    function closePrazoMenuOnOutsideClick(e) {
        if (!prazoMenu.contains(e.target) && e.target !== prazoOpenBtn) prazoMenu.classList.remove('visible');
    }
    document.addEventListener('click', closePrazoMenuOnOutsideClick);

    overlay.querySelector('#camp-gerar').addEventListener('click', async (ev) => {
        const btn = ev.currentTarget;
        const vendedorDestino = overlay.querySelector('#camp-vendedor').value.trim();
        if (!vendedorDestino) { showToast('Escolha o vendedor.', true); return; }
        const prazoAte = prazoInput.value.trim();
        setSaving(true, btn, 'Gerando...');
        const r = await callAPI('criarCampanha', {
            tipo,
            titulo: overlay.querySelector('#camp-titulo').value.trim(),
            vendedorDestino,
            prazoAte,
            itemIds,
            user: state.currentUser
        }).catch(() => null);
        if (!r || r.status !== 'success') {
            showToast((r && r.message) || 'Não foi possível gerar a campanha.', true);
            setSaving(false, btn);
            return;
        }
        const loginNome = loginNomeByVendedor.get(vendedorDestino) || '';
        const link = campanhaLink(r.id, loginNome);
        const box = overlay.querySelector('#camp-result');
        box.hidden = false;
        box.innerHTML = `
            <p class="helper-text" style="margin:0 0 0.35rem">Link pronto — mande pro ${escapeHtml(vendedorDestino)}${prazoAte ? ` (prazo ${escapeHtml(prazoAte)})` : ''}:</p>
            <input type="text" id="camp-link" readonly value="${escapeHtml(link)}" style="font-size:0.82rem">
            <div style="display:flex;gap:0.5rem;margin-top:0.5rem">
                <button type="button" class="mini-button" id="camp-copy">Copiar</button>
                <button type="button" class="mini-button mini-button-whatsapp" id="camp-wa">WhatsApp</button>
            </div>`;
        btn.remove();
        overlay.querySelector('#camp-cancel').textContent = 'Concluir';
        const buildMsg = () => {
            const primeiroNome = vendedorDestino.split(' ')[0];
            const clientesTxt = (selectedItems || [])
                .map((it) => `• ${it.funilDiversey ? '⭐ ' : ''}${it.cliente || 'Cliente'}${it.cidade ? ' — ' + it.cidade : ''}`)
                .join('\n');
            const temDiversey = tipo === 'funil' && (selectedItems || []).some((it) => it.funilDiversey);
            return [
                `Oi ${primeiroNome}! Preciso que você atualize o status ${tipo === 'funil' ? 'destas oportunidades do Funil' : 'destas propostas'}:`,
                clientesTxt,
                temDiversey ? `\n⭐ = Funil Diversey, acompanhar de perto.` : '',
                prazoAte ? `\nPrazo: ${prazoAte}` : '',
                loginNome
                    ? `\nPra entrar, é só abrir o link e informar seu PIN (4 últimos números do seu celular) — seu login já vem preenchido.`
                    : `\nPra entrar: login é seu nome (em minúsculo) e PIN são os 4 últimos números do seu celular.`,
                `\n${link}`
            ].filter(Boolean).join('\n');
        };
        overlay.querySelector('#camp-copy').addEventListener('click', () => {
            navigator.clipboard?.writeText(buildMsg()).then(() => showToast('Mensagem copiada.'));
            overlay.querySelector('#camp-link').select();
        });
        overlay.querySelector('#camp-wa').addEventListener('click', () => {
            openExternal(`https://wa.me/?text=${encodeURIComponent(buildMsg())}`);
        });
        document.dispatchEvent(new CustomEvent('campanha-criada'));
    });
}

// ── Tela do vendedor: preencher a campanha ─────────────────────────────
export async function renderCampanhaPreencherPage(id) {
    ensureStyles('proposals');
    const main = document.getElementById('main-content');
    main.innerHTML = skeletonList(4);
    const r = await callAPI('getCampanha', { id, user: state.currentUser }).catch((e) => ({ status: 'error', message: e.message }));
    if (!r || r.status !== 'success') {
        main.innerHTML = `<div class="empty-state"><span class="empty-state-icon">🔗</span><p>${escapeHtml((r && r.message) || 'Não foi possível abrir a campanha.')}</p>
            <button type="button" class="btn-add" id="camp-home">Ir para o início</button></div>`;
        document.getElementById('camp-home')?.addEventListener('click', () => navigateTo('dashboard'));
        return;
    }
    const camp = r.campanha;
    if (camp.tipo === 'visita') { return renderCampanhaVisitaPreencher(main, camp, r.itens); }
    const statuses = camp.tipo === 'funil' ? FUNIL_STATUS : PROP_STATUS;
    const primeiroNome = String(camp.vendedorDestino || '').trim().split(' ')[0] || 'tudo bem';

    const renderObrigado = () => {
        main.innerHTML = `
            ${renderBreadcrumb([{ label: 'Início', page: 'dashboard' }, { label: 'Atualização' }])}
            <div class="empty-state">
                <span class="empty-state-icon">✅</span>
                <h2 style="margin:0.4rem 0 0.2rem">Obrigado, ${escapeHtml(primeiroNome)}!</h2>
                <p class="helper-text">Suas atualizações foram enviadas com sucesso.</p>
                <button type="button" class="btn-add" id="camp-done-home">Ir para o início</button>
            </div>
        `;
        document.getElementById('camp-done-home')?.addEventListener('click', () => navigateTo('dashboard'));
        addScrollTop();
    };

    const render = (itens) => {
        const done = itens.filter((i) => i.respondidoEm).length;
        main.innerHTML = `
            ${renderBreadcrumb([{ label: 'Início', page: 'dashboard' }, { label: 'Atualização' }])}
            <div class="page-header"><div>
                <h2>${escapeHtml(camp.titulo || 'Atualização de clientes')}</h2>
                <p class="page-subtitle">Olá, ${escapeHtml(camp.vendedorDestino || primeiroNome)}! ${escapeHtml(camp.criadaPor || 'Seu gestor')} pediu a atualização destes clientes.</p>
                ${camp.prazoAte ? `<p class="page-subtitle" style="color:var(--warning);font-weight:600">Solicitado resposta até ${escapeHtml(camp.prazoAte)}.</p>` : ''}
            </div></div>
            <div class="camp-progress"><div class="camp-progress-bar" style="width:${itens.length ? Math.round(done / itens.length * 100) : 0}%"></div></div>
            <p class="helper-text" style="margin:0.3rem 0 0.9rem">${done} de ${itens.length} atualizados</p>
            <div class="camp-cards">${itens.map((it, idx) => cardHtml(it, idx)).join('')}</div>
        `;
        itens.forEach((it, idx) => wireCard(it, idx, itens));
        addScrollTop();
    };

    const cardHtml = (it, idx) => {
        if (it.ausente) {
            return `<div class="card camp-card camp-card-done"><strong>${escapeHtml(it.cliente || 'Cliente')}</strong><p class="helper-text">Registro não encontrado (pode ter sido apagado).</p></div>`;
        }
        const ctx = camp.tipo === 'funil'
            ? [it.cidade, it.foco, it.atuacao, it.valor ? formatCurrency(it.valor) : ''].filter(Boolean).join(' · ')
            : [it.cidade, it.foco, it.produtos].filter(Boolean).join(' · ');
        return `
        <div class="card camp-card${it.respondidoEm ? ' camp-card-done' : ''}" data-idx="${idx}">
            <div class="camp-card-head">
                <strong>${escapeHtml(it.cliente || 'Cliente')}</strong>
                ${it.funilDiversey ? '<span class="funil-diversey-tag">⭐ Diversey</span>' : ''}
                ${it.respondidoEm ? '<span class="camp-tag-ok">✓ atualizado</span>' : ''}
            </div>
            <p class="helper-text" style="margin:0.15rem 0 0.5rem">${escapeHtml(ctx || '-')}<br>Status atual: <strong>${escapeHtml(it.status || '-')}</strong> · última atualização ${escapeHtml(it.atualizacao || '-')}</p>
            ${it.resumo ? `<details class="detail-resumo camp-resumo"><summary>Ver itens da proposta</summary><p>${escapeHtml(it.resumo).replace(/\s*\/\s*(?=Item\s+\d)/gi, '<br>')}</p></details>` : ''}
            <label style="font-size:0.8rem;font-weight:600">Status</label>
            <div class="qe-status-row camp-status-row" data-idx="${idx}">
                ${statuses.map((s) => `<button type="button" class="qe-status-btn${s === (it.status || '') ? ' is-active' : ''}" data-s="${s}">${s}${s === 'CONCLUIDO' ? '<span class="qe-status-caption">(Ganhamos)</span>' : ''}</button>`).join('')}
            </div>
            ${camp.tipo === 'funil' ? `<div class="camp-motivo" data-idx="${idx}" style="margin-top:0.5rem;display:${it.status === 'PERDIDO' ? '' : 'none'}">
                <label style="font-size:0.8rem;font-weight:600">Motivo da perda</label>
                <input type="text" class="camp-motivo-input" value="${escapeHtml(it.motivoPerda || '')}" placeholder="Ex.: preço, concorrência...">
            </div>` : ''}
            <label style="font-size:0.8rem;font-weight:600;margin-top:0.5rem;display:block">Comentário</label>
            <textarea class="camp-coment" rows="4">${escapeHtml(withDatedNoteHeader(it.comentarios))}</textarea>
            <button type="button" class="primary-button camp-save" data-idx="${idx}" style="margin-top:0.5rem">Salvar este cliente</button>
        </div>`;
    };

    const wireCard = (it, idx, itens) => {
        if (it.ausente) return;
        const card = main.querySelector(`.camp-card[data-idx="${idx}"]`);
        if (!card) return;
        let sel = it.status || statuses[0];
        card.querySelectorAll('.camp-status-row .qe-status-btn').forEach((b) => b.addEventListener('click', () => {
            sel = b.dataset.s;
            card.querySelectorAll('.qe-status-btn').forEach((x) => x.classList.toggle('is-active', x === b));
            const mot = card.querySelector('.camp-motivo');
            if (mot) mot.style.display = sel === 'PERDIDO' ? '' : 'none';
        }));
        card.querySelector('.camp-save').addEventListener('click', async (ev) => {
            const btn = ev.currentTarget;
            const comentario = stripEmptyDatedLine(card.querySelector('.camp-coment').value);
            const motivoPerda = card.querySelector('.camp-motivo-input')?.value.trim() || '';
            if (camp.tipo === 'funil' && sel === 'PERDIDO' && !motivoPerda) { showToast('Informe o motivo da perda.', true); return; }
            setSaving(true, btn, 'Salvando...');
            // attemptOrQueue (não callAPI direto): sem conexão ou com a rede
            // instável — bem comum pra quem preenche isso do celular, em
            // campo — a resposta ficava só na tela e nunca chegava no
            // servidor, sem nenhum aviso claro nem tentativa automática
            // depois. Igual todo outro salvamento do app (Visita/Proposta/
            // Funil), agora fica na fila e reenvia sozinho quando a conexão
            // voltar.
            const rr = await attemptOrQueue('responderCampanhaItem', {
                campanhaId: camp.id, itemId: it.id, status: sel, comentario, motivoPerda, user: state.currentUser
            }, { entity: 'campanha', tempId: it.id }).catch((e) => ({ status: 'error', message: e.message }));
            if (rr && rr.status === 'success') {
                it.respondidoEm = 'agora';
                it.status = sel;
                it.comentarios = comentario;
                if (rr.concluida) {
                    renderObrigado();
                } else {
                    showToast('Salvo.');
                    render(itens);
                }
            } else if (rr && rr.status === 'queued') {
                it.respondidoEm = 'agora';
                it.status = sel;
                it.comentarios = comentario;
                showToast('Sem conexão agora — vai ser enviado sozinho assim que a internet voltar.');
                render(itens);
            } else {
                showToast((rr && rr.message) || 'Não foi possível salvar.', true);
                setSaving(false, btn);
            }
        });
    };

    render(r.itens);
}

// ── Tela do vendedor: completar um relatório de visita ─────────────────
// Diferente do preencher de Proposta/Funil (status + comentário sobre um
// registro que já existe) — aqui o vendedor está editando um rascunho
// (cliente, cidade...) que o admin escreveu, e confirmar CRIA a Visita de
// verdade (ver handleResponderCampanhaItem, tipo 'visita').
async function renderCampanhaVisitaPreencher(main, camp, itens) {
    const primeiroNome = String(camp.vendedorDestino || '').trim().split(' ')[0] || 'tudo bem';
    const fd = await ensureFormData().then((rr) => rr.data).catch(() => null);
    const cidades = (fd && fd.cidades) || [];
    const areas = (fd && fd.areasAtuacao) || [];
    const tipos = (fd && fd.tiposVisita) || [];

    const renderObrigado = () => {
        main.innerHTML = `
            ${renderBreadcrumb([{ label: 'Início', page: 'dashboard' }, { label: 'Relatório de Visita' }])}
            <div class="empty-state">
                <span class="empty-state-icon">✅</span>
                <h2 style="margin:0.4rem 0 0.2rem">Obrigado, ${escapeHtml(primeiroNome)}!</h2>
                <p class="helper-text">A visita foi registrada com sucesso.</p>
                <button type="button" class="btn-add" id="camp-done-home">Ir para o início</button>
            </div>
        `;
        document.getElementById('camp-done-home')?.addEventListener('click', () => navigateTo('dashboard'));
        addScrollTop();
    };

    const render = () => {
        const done = itens.filter((i) => i.respondidoEm).length;
        main.innerHTML = `
            ${renderBreadcrumb([{ label: 'Início', page: 'dashboard' }, { label: 'Relatório de Visita' }])}
            <div class="page-header"><div>
                <h2>${escapeHtml(camp.titulo || 'Relatório de Visita')}</h2>
                <p class="page-subtitle">Olá, ${escapeHtml(camp.vendedorDestino || primeiroNome)}! ${escapeHtml(camp.criadaPor || 'Seu gestor')} pediu esse relatório — confira e complete antes de confirmar.</p>
                ${camp.prazoAte ? `<p class="page-subtitle" style="color:var(--warning);font-weight:600">Solicitado resposta até ${escapeHtml(camp.prazoAte)}.</p>` : ''}
            </div></div>
            <div class="camp-progress"><div class="camp-progress-bar" style="width:${itens.length ? Math.round(done / itens.length * 100) : 0}%"></div></div>
            <p class="helper-text" style="margin:0.3rem 0 0.9rem">${done} de ${itens.length} concluído(s)</p>
            <div class="camp-cards">${itens.map((it, idx) => cardHtml(it, idx)).join('')}</div>
        `;
        itens.forEach((it, idx) => wireCard(it, idx));
        addScrollTop();
    };

    const cardHtml = (it, idx) => {
        if (it.respondidoEm) {
            return `<div class="card camp-card camp-card-done" data-idx="${idx}"><strong>${escapeHtml(it.cliente || 'Cliente')}</strong><span class="camp-tag-ok" style="margin-left:0.4rem">✓ visita registrada</span></div>`;
        }
        return `
        <div class="card camp-card" data-idx="${idx}">
            ${it.relatorio ? `<div class="qe-info" style="margin-bottom:0.7rem"><div><span>Relatório de ${escapeHtml(camp.criadaPor || 'quem pediu')}</span>${escapeHtml(it.relatorio)}</div></div>` : ''}
            <div class="form-group full-width">
                <label>Cliente</label>
                <input type="text" class="cv-f-cliente" value="${escapeHtml(it.cliente || '')}">
            </div>
            <div class="form-row-pair">
                <div class="form-group">
                    <label>Cidade</label>
                    <div class="searchable-select">
                        <input type="text" class="cv-f-cidade" value="${escapeHtml(it.cidade || '')}" autocomplete="off">
                        <div class="searchable-select-menu"></div>
                    </div>
                </div>
                <div class="form-group">
                    <label>Área de Atuação</label>
                    <div class="searchable-select">
                        <input type="text" class="cv-f-area" value="${escapeHtml(it.areaAtuacao || '')}" autocomplete="off">
                        <div class="searchable-select-menu"></div>
                    </div>
                </div>
            </div>
            <div class="form-row-pair">
                <div class="form-group">
                    <label>Tipo da Visita</label>
                    <select class="cv-f-tipo">
                        <option value="">—</option>
                        ${tipos.map((t) => `<option value="${escapeHtml(t.tipo)}"${t.tipo === it.tipoVisita ? ' selected' : ''}>${escapeHtml(t.tipo)}</option>`).join('')}
                    </select>
                </div>
                <div class="form-group">
                    <label>Data da visita</label>
                    <input type="date" class="cv-f-data" value="${escapeHtml(dateBrToInputValue(it.data))}">
                </div>
            </div>
            <div class="form-group full-width">
                <label>Horário</label>
                <input type="time" class="cv-f-horario">
            </div>
            <label style="font-size:0.8rem;font-weight:600">Observação</label>
            <textarea class="camp-coment" rows="5">${escapeHtml(it.relatorio || '')}</textarea>
            <button type="button" class="primary-button camp-save" style="margin-top:0.5rem">Confirmar visita</button>
        </div>`;
    };

    const wireCard = (it, idx) => {
        if (it.respondidoEm) return;
        const card = main.querySelector(`.camp-card[data-idx="${idx}"]`);
        if (!card) return;
        const menus = card.querySelectorAll('.searchable-select-menu');
        initializeSearchableInput({ input: card.querySelector('.cv-f-cidade'), menu: menus[0], items: cidades, allowFreeText: true });
        initializeSearchableInput({ input: card.querySelector('.cv-f-area'), menu: menus[1], items: areas, allowFreeText: true });
        card.querySelector('.camp-save').addEventListener('click', async (ev) => {
            const btn = ev.currentTarget;
            const cliente = card.querySelector('.cv-f-cliente').value.trim();
            const cidade = card.querySelector('.cv-f-cidade').value.trim();
            const areaAtuacao = card.querySelector('.cv-f-area').value.trim();
            const tipoVisita = card.querySelector('.cv-f-tipo').value;
            const dataInput = card.querySelector('.cv-f-data').value;
            const horario = card.querySelector('.cv-f-horario').value;
            const comentario = card.querySelector('.camp-coment').value.trim();
            if (!cliente) { showToast('Informe o cliente.', true); return; }
            if (!cidade) { showToast('Informe a cidade.', true); return; }
            if (!areaAtuacao) { showToast('Informe a área de atuação.', true); return; }
            if (!dataInput) { showToast('Informe a data da visita.', true); return; }
            if (!horario) { showToast('Informe o horário.', true); return; }
            setSaving(true, btn, 'Salvando...');
            const rr = await attemptOrQueue('responderCampanhaItem', {
                campanhaId: camp.id, itemId: it.id, cliente, cidade, areaAtuacao, tipoVisita,
                dataVisita: dateInputToBr(dataInput), horario, comentario, user: state.currentUser
            }, { entity: 'campanha', tempId: it.id }).catch((e) => ({ status: 'error', message: e.message }));
            if (rr && rr.status === 'success') {
                it.respondidoEm = 'agora';
                if (rr.concluida) { renderObrigado(); } else { showToast('Visita registrada.'); render(); }
            } else if (rr && rr.status === 'queued') {
                it.respondidoEm = 'agora';
                showToast('Sem conexão agora — vai ser enviado sozinho assim que a internet voltar.');
                render();
            } else {
                showToast((rr && rr.message) || 'Não foi possível salvar.', true);
                setSaving(false, btn);
            }
        });
    };

    render();
}

function dateBrToInputValue(br) {
    const m = String(br || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    return m ? `${m[3]}-${m[2]}-${m[1]}` : '';
}

function dateInputToBr(iso) {
    const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
}

// ── Tela do admin: acompanhar campanhas ────────────────────────────────
export async function renderCampanhasPage() {
    ensureStyles('proposals');
    const main = document.getElementById('main-content');
    if (!isAdminOrGerenteUser()) { main.innerHTML = '<p class="error-message">Acesso restrito.</p>'; return; }
    main.innerHTML = skeletonList(4);
    const r = await callAPI('getCampanhas', { user: state.currentUser }).catch(() => null);
    const campanhas = (r && r.status === 'success') ? r.campanhas : [];
    // Campanha apagada em outra visita não fica mais na lista — tira do
    // conjunto marcado pra não sobrar id fantasma no contador/toolbar.
    const idsAtuais = new Set(campanhas.map((c) => String(c.id)));
    Array.from(campSelectedIds).forEach((id) => { if (!idsAtuais.has(id)) campSelectedIds.delete(id); });

    main.innerHTML = `
        ${renderBreadcrumb([{ label: 'Admin', page: 'admin' }, { label: 'Campanhas' }])}
        <div class="page-header">
            <div>
                <h2>Campanhas de atualização</h2>
                <p class="page-subtitle">${campanhas.length} campanha(s)</p>
            </div>
            <div class="page-header-actions">
                <button type="button" class="mini-button" id="camp-nova-visita" title="Pedir pra um vendedor completar um relatório de visita">📋 Relatório de Visita</button>
                ${campanhas.length ? `<button type="button" class="mini-button${campSelectMode ? ' is-on' : ''}" id="camp-select-toggle" title="Marcar várias campanhas para apagar de uma vez">☑️ Selecionar</button>` : ''}
            </div>
        </div>
        ${campanhas.length === 0
            ? '<div class="empty-state"><span class="empty-state-icon">🔗</span><p>Nenhuma campanha ainda. Crie uma pela tela de Propostas ou Funil (botão "🔗 Campanha"), ou peça um relatório de visita acima.</p></div>'
            : `${campSelectMode ? `
                <div class="funil-sel-bar" id="camp-sel-bar">
                    <strong id="camp-sel-count">${campSelectedIds.size} selecionada(s)</strong>
                    <button type="button" class="mini-button" id="camp-sel-all">Marcar todas</button>
                    <button type="button" class="mini-button" id="camp-sel-none">Limpar</button>
                    <button type="button" class="mini-button mini-button-danger" id="camp-sel-delete" ${campSelectedIds.size ? '' : 'disabled'}>🗑️ Excluir selecionadas</button>
                </div>` : ''}
              <div class="camp-list">${[...campanhas]
                  .sort((a, b) => (campanhaEstaVencida(b) ? 1 : 0) - (campanhaEstaVencida(a) ? 1 : 0))
                  .map((c) => campanhaRow(c, campSelectMode)).join('')}</div>`}
    `;
    main.querySelectorAll('[data-camp-copy]').forEach((el) => el.addEventListener('click', (e) => {
        e.stopPropagation();
        const link = campanhaLink(el.dataset.campCopy);
        navigator.clipboard?.writeText(link).then(() => showToast('Link copiado.'));
    }));
    main.querySelectorAll('[data-camp-wa]').forEach((el) => el.addEventListener('click', (e) => {
        e.stopPropagation();
        openExternal(`https://wa.me/?text=${encodeURIComponent(campanhaLink(el.dataset.campWa))}`);
    }));
    main.querySelectorAll('[data-camp-details]').forEach((btn) => btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = btn.dataset.campDetails;
        const box = document.getElementById('camp-itens-' + id);
        if (!box) return;
        // Alterna mostrar/esconder — busca os itens só na primeira vez que
        // abre (fica guardado no próprio elemento pra reabrir sem refetch).
        if (!box.hidden) { box.hidden = true; btn.textContent = 'Ver clientes'; return; }
        if (box.dataset.loaded) { box.hidden = false; btn.textContent = 'Ocultar clientes'; return; }
        btn.disabled = true;
        const rr = await callAPI('getCampanha', { id, user: state.currentUser }).catch((err) => ({ status: 'error', message: err.message }));
        btn.disabled = false;
        if (!rr || rr.status !== 'success') {
            showToast((rr && rr.message) || 'Não foi possível carregar os clientes.', true);
            return;
        }
        const itens = rr.itens || [];
        box.innerHTML = itens.map((it) => `
            <div class="camp-admin-item${it.respondidoEm ? ' camp-admin-item-done' : ''}">
                <span>${it.respondidoEm ? '✓' : '⏳'}</span>
                <span class="camp-admin-item-nome">${escapeHtml(it.ausente ? 'Registro não encontrado (pode ter sido apagado)' : (it.cliente || 'Cliente'))}${it.funilDiversey ? ' ⭐' : ''}</span>
                <span class="helper-text">${it.respondidoEm ? `atualizado em ${escapeHtml(it.respondidoEm)}` : 'pendente'}</span>
            </div>`).join('');
        box.dataset.loaded = '1';
        box.hidden = false;
        btn.textContent = 'Ocultar clientes';
    }));
    main.querySelectorAll('[data-camp-del]').forEach((el) => el.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm('Apagar esta campanha? O link para de funcionar (o histórico já salvo nas propostas/funil fica).')) return;
        const rr = await callAPI('deleteCampanha', { id: el.dataset.campDel, user: state.currentUser }).catch(() => null);
        if (rr && rr.status === 'success') { showToast('Campanha apagada.'); renderCampanhasPage(); }
        else showToast((rr && rr.message) || 'Não foi possível apagar.', true);
    }));

    const refreshCampSelBar = () => {
        const count = document.getElementById('camp-sel-count');
        if (count) count.textContent = `${campSelectedIds.size} selecionada(s)`;
        const del = document.getElementById('camp-sel-delete');
        if (del) del.disabled = campSelectedIds.size === 0;
    };
    main.querySelectorAll('[data-camp-select]').forEach((el) => el.addEventListener('change', (e) => {
        const id = String(el.dataset.campSelect);
        if (e.target.checked) campSelectedIds.add(id); else campSelectedIds.delete(id);
        el.closest('.camp-admin-row')?.classList.toggle('is-selected', e.target.checked);
        refreshCampSelBar();
    }));
    document.getElementById('camp-nova-visita')?.addEventListener('click', () => openGerarCampanhaVisitaModal());
    document.getElementById('camp-select-toggle')?.addEventListener('click', () => {
        campSelectMode = !campSelectMode;
        if (!campSelectMode) campSelectedIds.clear();
        renderCampanhasPage();
    });
    document.getElementById('camp-sel-all')?.addEventListener('click', () => {
        campanhas.forEach((c) => campSelectedIds.add(String(c.id)));
        renderCampanhasPage();
    });
    document.getElementById('camp-sel-none')?.addEventListener('click', () => {
        campSelectedIds.clear();
        renderCampanhasPage();
    });
    document.getElementById('camp-sel-delete')?.addEventListener('click', async (e) => {
        const ids = Array.from(campSelectedIds);
        if (!ids.length) return;
        if (!confirm(`Apagar ${ids.length} campanha(s)? Os links param de funcionar (o histórico já salvo nas propostas/funil fica). Essa ação não pode ser desfeita.`)) return;
        const btn = e.currentTarget;
        setSaving(true, btn, 'Apagando...');
        const rr = await callAPI('deleteCampanhaBatch', { ids, user: state.currentUser }).catch((err) => ({ status: 'error', message: err.message }));
        if (rr && rr.status === 'success') {
            const gone = new Set((rr.deleted || ids).map(String));
            gone.forEach((id) => campSelectedIds.delete(id));
            showToast(rr.message || `${gone.size} campanha(s) apagada(s).`);
            renderCampanhasPage();
        } else {
            showToast((rr && rr.message) || 'Não foi possível apagar.', true);
            setSaving(false, btn);
        }
    });
    addScrollTop();
}

function campanhaRow(c, selectMode) {
    const pct = c.total ? Math.round(c.respondidos / c.total * 100) : 0;
    const id = String(c.id);
    const vencida = campanhaEstaVencida(c);
    const statusClass = c.status === 'concluida' ? 'funil-status-concluido' : (vencida ? 'funil-status-perdido' : 'funil-status-proposta');
    const statusLabel = c.status === 'concluida' ? 'Concluída' : (vencida ? '⚠️ Vencida' : 'Aberta');
    return `
    <div class="card camp-admin-row${selectMode && campSelectedIds.has(id) ? ' is-selected' : ''}${vencida ? ' camp-admin-row-vencida' : ''}">
        <div class="camp-card-head">
            <strong>${selectMode ? `<label class="camp-sel-check"><input type="checkbox" data-camp-select="${escapeHtml(id)}" ${campSelectedIds.has(id) ? 'checked' : ''}></label>` : ''}${escapeHtml(c.titulo)}</strong>
            <span class="status-pill ${statusClass}">${statusLabel}</span>
        </div>
        <p class="helper-text camp-admin-meta">
            ${c.tipo === 'funil' ? '📊 Funil' : c.tipo === 'visita' ? '📋 Relatório de Visita' : '📄 Propostas'} · para <strong>${escapeHtml(c.vendedorDestino || '-')}</strong>${c.prazoAte ? ` · prazo <span class="${vencida ? 'camp-prazo-vencido' : ''}">${escapeHtml(c.prazoAte)}</span>` : ''}<br>
            ${c.primeiroAcessoEm
                ? `👁️ Acessou em ${escapeHtml(c.primeiroAcessoEm)}${c.ultimoAcessoEm && c.ultimoAcessoEm !== c.primeiroAcessoEm ? ` (última vez ${escapeHtml(c.ultimoAcessoEm)})` : ''}`
                : '⏳ Ainda não abriu o link'}
        </p>
        <div class="camp-progress"><div class="camp-progress-bar${vencida ? ' camp-progress-bar-vencida' : ''}" style="width:${pct}%"></div></div>
        <p class="helper-text camp-admin-count">${c.respondidos} de ${c.total} atualizados</p>
        <div class="camp-admin-actions">
            <button type="button" class="mini-button" data-camp-details="${escapeHtml(c.id)}">Ver clientes</button>
            <button type="button" class="mini-button" data-camp-copy="${escapeHtml(c.id)}">Copiar link</button>
            <button type="button" class="mini-button mini-button-whatsapp" data-camp-wa="${escapeHtml(c.id)}">WhatsApp</button>
            <button type="button" class="mini-button mini-button-danger" data-camp-del="${escapeHtml(c.id)}">Apagar</button>
        </div>
        <div class="camp-admin-itens" id="camp-itens-${escapeHtml(c.id)}" hidden></div>
    </div>`;
}
