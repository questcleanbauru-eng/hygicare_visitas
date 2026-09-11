import { state, navigateTo } from '../app.js';
import { callAPI, ensureFormData } from '../api.js';
import {
    escapeHtml, isAdminOrGerenteUser, datedNoteHeader, withDatedNoteHeader, stripEmptyDatedLine, formatCurrency,
    formatDateFieldValue, normalizeDisplayDateValue
} from '../utils/format.js';
import { showToast, setSaving, skeletonList, addScrollTop, openExternal } from '../utils/dom.js';
import { renderBreadcrumb, ensureStyles } from '../utils/ui.js';

const PROP_STATUS = ['Enviada', 'Em negociacao', 'Ganhamos', 'Perdido'];
const FUNIL_STATUS = ['IDENTIFICAR', 'PROPOSTA', 'NEGOCIAR', 'CONCLUIDO', 'PERDIDO', 'RETOMAR'];

function campanhaLink(id) {
    // ?c=<id> (não /c/<id>): mantém o path na raiz pra os assets relativos
    // do app carregarem quando o link é aberto num navegador limpo.
    return `${window.location.origin}/?c=${id}`;
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
                        <span><strong>${escapeHtml(it.cliente || 'Cliente')}</strong>${it.cidade || it.extra ? `<br><span class="helper-text">${escapeHtml([it.cidade, it.extra].filter(Boolean).join(' · '))}</span>` : ''}</span>
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

// ── Modal "Gerar link de atualização" (chamado das telas Propostas/Funil) ──
// selectedItems: [{ id, cliente, cidade, extra }] — os mesmos itens marcados
// no modal de seleção, só pra montar a mensagem do WhatsApp com os nomes.
export async function openGerarCampanhaModal(tipo, itemIds, selectedItems) {
    if (!itemIds || !itemIds.length) { showToast('Selecione ao menos um cliente.', true); return; }
    ensureStyles('proposals');
    const fd = await ensureFormData().then((r) => r.data).catch(() => null);
    const vendedores = ((fd && fd.vendedores) || []).map((v) => v.nome).filter(Boolean);

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
        const link = campanhaLink(r.id);
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
                .map((it) => `• ${it.cliente || 'Cliente'}${it.cidade ? ' — ' + it.cidade : ''}`)
                .join('\n');
            return [
                `Oi ${primeiroNome}! Preciso que você atualize o status ${tipo === 'funil' ? 'destas oportunidades do Funil' : 'destas propostas'}:`,
                clientesTxt,
                prazoAte ? `\nPrazo: ${prazoAte}` : '',
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
                ${it.respondidoEm ? '<span class="camp-tag-ok">✓ atualizado</span>' : ''}
            </div>
            <p class="helper-text" style="margin:0.15rem 0 0.5rem">${escapeHtml(ctx || '-')}<br>Status atual: <strong>${escapeHtml(it.status || '-')}</strong> · última atualização ${escapeHtml(it.atualizacao || '-')}</p>
            <label style="font-size:0.8rem;font-weight:600">Status</label>
            <div class="qe-status-row camp-status-row" data-idx="${idx}">
                ${statuses.map((s) => `<button type="button" class="qe-status-btn${s === (it.status || '') ? ' is-active' : ''}" data-s="${s}">${s}</button>`).join('')}
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
            const rr = await callAPI('responderCampanhaItem', {
                campanhaId: camp.id, itemId: it.id, status: sel, comentario, motivoPerda, user: state.currentUser
            }).catch((e) => ({ status: 'error', message: e.message }));
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
            } else {
                showToast((rr && rr.message) || 'Não foi possível salvar.', true);
                setSaving(false, btn);
            }
        });
    };

    render(r.itens);
}

// ── Tela do admin: acompanhar campanhas ────────────────────────────────
export async function renderCampanhasPage() {
    ensureStyles('proposals');
    const main = document.getElementById('main-content');
    if (!isAdminOrGerenteUser()) { main.innerHTML = '<p class="error-message">Acesso restrito.</p>'; return; }
    main.innerHTML = skeletonList(4);
    const r = await callAPI('getCampanhas', { user: state.currentUser }).catch(() => null);
    const campanhas = (r && r.status === 'success') ? r.campanhas : [];

    main.innerHTML = `
        ${renderBreadcrumb([{ label: 'Admin', page: 'admin' }, { label: 'Campanhas' }])}
        <div class="page-header"><div>
            <h2>Campanhas de atualização</h2>
            <p class="page-subtitle">${campanhas.length} campanha(s)</p>
        </div></div>
        ${campanhas.length === 0
            ? '<div class="empty-state"><span class="empty-state-icon">🔗</span><p>Nenhuma campanha ainda. Crie uma pela tela de Propostas ou Funil (botão "🔗 Campanha").</p></div>'
            : `<div class="camp-list">${campanhas.map(campanhaRow).join('')}</div>`}
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
    main.querySelectorAll('[data-camp-del]').forEach((el) => el.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm('Apagar esta campanha? O link para de funcionar (o histórico já salvo nas propostas/funil fica).')) return;
        const rr = await callAPI('deleteCampanha', { id: el.dataset.campDel, user: state.currentUser }).catch(() => null);
        if (rr && rr.status === 'success') { showToast('Campanha apagada.'); renderCampanhasPage(); }
        else showToast((rr && rr.message) || 'Não foi possível apagar.', true);
    }));
    addScrollTop();
}

function campanhaRow(c) {
    const pct = c.total ? Math.round(c.respondidos / c.total * 100) : 0;
    return `
    <div class="card camp-admin-row">
        <div class="camp-card-head">
            <strong>${escapeHtml(c.titulo)}</strong>
            <span class="status-pill ${c.status === 'concluida' ? 'funil-status-concluido' : 'funil-status-proposta'}">${c.status === 'concluida' ? 'Concluída' : 'Aberta'}</span>
        </div>
        <p class="helper-text camp-admin-meta">
            ${c.tipo === 'funil' ? 'Funil' : 'Propostas'} · para ${escapeHtml(c.vendedorDestino || '-')}${c.prazoAte ? ` · prazo ${escapeHtml(c.prazoAte)}` : ''}<br>
            ${c.primeiroAcessoEm
                ? `👁️ Acessou em ${escapeHtml(c.primeiroAcessoEm)}${c.ultimoAcessoEm && c.ultimoAcessoEm !== c.primeiroAcessoEm ? ` (última vez ${escapeHtml(c.ultimoAcessoEm)})` : ''}`
                : '⏳ Ainda não abriu o link'}
        </p>
        <div class="camp-progress"><div class="camp-progress-bar" style="width:${pct}%"></div></div>
        <p class="helper-text camp-admin-count">${c.respondidos} de ${c.total} atualizados</p>
        <div class="camp-admin-actions">
            <button type="button" class="mini-button" data-camp-copy="${escapeHtml(c.id)}">Copiar link</button>
            <button type="button" class="mini-button mini-button-whatsapp" data-camp-wa="${escapeHtml(c.id)}">WhatsApp</button>
            <button type="button" class="mini-button mini-button-danger" data-camp-del="${escapeHtml(c.id)}">Apagar</button>
        </div>
    </div>`;
}
