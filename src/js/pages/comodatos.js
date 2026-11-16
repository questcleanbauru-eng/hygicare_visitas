import { state, navigateTo } from '../app.js';
import { callAPI, attemptOrQueue, ensureFormData } from '../api.js';
import { escapeHtml, clienteSearchItem, findClienteByNome } from '../utils/format.js';
import { showToast, setSaving, loadingState, initializeSearchableInput, openExternal } from '../utils/dom.js';
import { ensureStyles } from '../utils/ui.js';

// Comodato de Equipamento — ver lib/handlers/comodatos.js pro desenho
// completo. Três telas nesse arquivo:
//   renderComodatoPreencherPage  — o Kadu registra a semana (link que o
//                                  admin manda, via lembrete de sistema)
//   renderComodatosAdminPage     — o admin acompanha, marca retirada e
//                                  gera o contrato/recibo
//   renderComodatoConferenciaPage — o Kadu confirma, periodicamente, o que
//                                  ainda está ativo

function novoBloco() {
    return { cliente: '', cidade: '', areaAtuacao: '', dataInstalacao: '', observacao: '', equipamentos: [{ nome: '', quantidade: 1 }] };
}

// ── Tela do Kadu: registrar a semana ────────────────────────────────────
export async function renderComodatoPreencherPage() {
    ensureStyles('comodatos');
    const mainContent = document.getElementById('main-content');
    mainContent.innerHTML = loadingState('🔧', 'Carregando...');

    const fdResult = await ensureFormData().catch(() => null);
    if (!fdResult || fdResult.status !== 'success') {
        mainContent.innerHTML = '<p class="error-message">Não foi possível carregar os dados do formulário.</p>';
        return;
    }
    const fd = fdResult.data;
    const clientes = fd.clientes || [];
    const equipamentos = fd.equipamentos || [];

    const blocos = [novoBloco()];

    function render() {
        mainContent.innerHTML = `
            <div class="page-header">
                <div>
                    <h2>🔧 Comodato de Equipamento</h2>
                    <p class="page-subtitle">Quais clientes receberam equipamento em comodato essa semana?</p>
                </div>
            </div>
            <div id="comodato-blocos">
                ${blocos.map((b, idx) => blocoHtml(b, idx, clientes.length)).join('')}
            </div>
            <button type="button" class="secondary-button" id="comodato-add-cliente" style="width:100%;margin:0.75rem 0;border-style:dashed">+ Adicionar outro cliente</button>
            <div class="form-actions">
                <button type="button" class="primary-button" id="comodato-enviar" style="width:100%">Enviar respostas</button>
            </div>
        `;
        blocos.forEach((b, idx) => wireBloco(b, idx));
        document.getElementById('comodato-add-cliente').addEventListener('click', () => { blocos.push(novoBloco()); render(); });
        document.getElementById('comodato-enviar').addEventListener('click', (e) => enviar(e.currentTarget));
    }

    function blocoHtml(b, idx) {
        return `
        <div class="card comodato-cliente-card" data-bloco="${idx}">
            <div class="comodato-cliente-head">
                <span class="section-label" style="margin:0">Cliente ${idx + 1}</span>
                ${blocos.length > 1 ? `<button type="button" class="text-link comodato-remove-cliente" data-idx="${idx}">🗑️ Remover</button>` : ''}
            </div>
            <div class="form-group">
                <label for="com-cliente-${idx}">Cliente</label>
                <div class="searchable-select">
                    <input type="text" id="com-cliente-${idx}" value="${escapeHtml(b.cliente)}" placeholder="Pesquise o cliente" autocomplete="off">
                    <div class="searchable-select-menu" id="com-cliente-${idx}-menu"></div>
                </div>
            </div>
            <div class="comodato-equip-list">
                <label>Equipamentos</label>
                ${b.equipamentos.map((eq, ei) => `
                    <div class="comodato-equip-row">
                        <div class="searchable-select comodato-equip-select">
                            <input type="text" class="comodato-equip-nome" id="com-equip-${idx}-${ei}" value="${escapeHtml(eq.nome)}" placeholder="Equipamento" autocomplete="off">
                            <div class="searchable-select-menu" id="com-equip-${idx}-${ei}-menu"></div>
                        </div>
                        <div class="comodato-qty-stepper">
                            <button type="button" class="comodato-qty-minus" data-ei="${ei}" aria-label="Diminuir quantidade">−</button>
                            <span class="comodato-qty-value">${eq.quantidade}</span>
                            <button type="button" class="comodato-qty-plus" data-ei="${ei}" aria-label="Aumentar quantidade">+</button>
                        </div>
                        ${b.equipamentos.length > 1 ? `<button type="button" class="comodato-remove-equip" data-ei="${ei}" aria-label="Remover equipamento">🗑️</button>` : '<span class="comodato-equip-spacer"></span>'}
                    </div>`).join('')}
                <button type="button" class="text-link comodato-add-equip">+ Adicionar equipamento</button>
            </div>
            <div class="form-group">
                <label for="com-data-${idx}">Data da instalação</label>
                <input type="date" id="com-data-${idx}" value="${escapeHtml(b.dataInstalacao)}">
            </div>
            <div class="form-group">
                <label for="com-obs-${idx}">Observação (opcional)</label>
                <textarea id="com-obs-${idx}" rows="2" placeholder="Algo importante sobre esse comodato?">${escapeHtml(b.observacao)}</textarea>
            </div>
        </div>`;
    }

    function wireBloco(b, idx) {
        const card = mainContent.querySelector(`.comodato-cliente-card[data-bloco="${idx}"]`);
        if (!card) return;

        initializeSearchableInput({
            input: card.querySelector(`#com-cliente-${idx}`),
            menu: card.querySelector(`#com-cliente-${idx}-menu`),
            items: clientes.map((c) => clienteSearchItem(c)),
            allowFreeText: true,
            onSelect: (value) => {
                b.cliente = value;
                const match = findClienteByNome(clientes, value);
                if (match) { b.cidade = match.cidade || ''; b.areaAtuacao = match.areaAtuacao || ''; }
            }
        });
        card.querySelector(`#com-cliente-${idx}`).addEventListener('input', (e) => { b.cliente = e.target.value; });

        b.equipamentos.forEach((eq, ei) => {
            initializeSearchableInput({
                input: card.querySelector(`#com-equip-${idx}-${ei}`),
                menu: card.querySelector(`#com-equip-${idx}-${ei}-menu`),
                items: equipamentos.map((n) => ({ value: n, label: n })),
                allowFreeText: true,
                onSelect: (value) => { eq.nome = value; }
            });
            card.querySelector(`#com-equip-${idx}-${ei}`).addEventListener('input', (e) => { eq.nome = e.target.value; });
        });

        card.querySelector(`#com-data-${idx}`).addEventListener('input', (e) => { b.dataInstalacao = e.target.value; });
        card.querySelector(`#com-obs-${idx}`).addEventListener('input', (e) => { b.observacao = e.target.value; });

        card.querySelector('.comodato-remove-cliente')?.addEventListener('click', () => {
            blocos.splice(idx, 1);
            render();
        });
        card.querySelectorAll('.comodato-qty-minus').forEach((btn) => btn.addEventListener('click', () => {
            const ei = Number(btn.dataset.ei);
            b.equipamentos[ei].quantidade = Math.max(1, b.equipamentos[ei].quantidade - 1);
            render();
        }));
        card.querySelectorAll('.comodato-qty-plus').forEach((btn) => btn.addEventListener('click', () => {
            const ei = Number(btn.dataset.ei);
            b.equipamentos[ei].quantidade += 1;
            render();
        }));
        card.querySelectorAll('.comodato-remove-equip').forEach((btn) => btn.addEventListener('click', () => {
            const ei = Number(btn.dataset.ei);
            b.equipamentos.splice(ei, 1);
            render();
        }));
        card.querySelector('.comodato-add-equip').addEventListener('click', () => {
            b.equipamentos.push({ nome: '', quantidade: 1 });
            render();
        });
    }

    async function enviar(btn) {
        for (const b of blocos) {
            if (!b.cliente.trim()) { showToast('Informe o cliente em cada bloco.', true); return; }
            if (!b.dataInstalacao) { showToast('Informe a data da instalação.', true); return; }
            const equipValidos = b.equipamentos.filter((e) => e.nome.trim());
            if (!equipValidos.length) { showToast(`Informe ao menos um equipamento para ${b.cliente}.`, true); return; }
        }
        setSaving(true, btn, 'Enviando...');
        const payload = {
            user: state.currentUser,
            clientes: blocos.map((b) => ({
                cliente: b.cliente.trim(), cidade: b.cidade, areaAtuacao: b.areaAtuacao,
                dataInstalacao: b.dataInstalacao, observacao: b.observacao.trim(),
                equipamentos: b.equipamentos.filter((e) => e.nome.trim()).map((e) => ({ nome: e.nome.trim(), quantidade: e.quantidade }))
            }))
        };
        try {
            const res = await attemptOrQueue('createComodatoLote', payload, { entity: 'comodatos', tempId: 'temp_' + Date.now() });
            setSaving(false, btn);
            if (res.status === 'queued') {
                showToast('Sem conexão — será enviado assim que voltar.');
                navigateTo('dashboard');
                return;
            }
            if (res.status !== 'success') { showToast(res.message || 'Erro ao enviar.', true); return; }
            showToast('Comodato registrado!');
            navigateTo('dashboard');
        } catch (e) {
            setSaving(false, btn);
            showToast(e.message || 'Erro ao enviar.', true);
        }
    }

    render();
}

// ── Painel admin ─────────────────────────────────────────────────────────
function agruparComodatos(comodatos) {
    const grupos = new Map();
    comodatos.forEach((c) => {
        const key = `${c.loteId}__${c.cliente}`;
        if (!grupos.has(key)) {
            grupos.set(key, {
                loteId: c.loteId, cliente: c.cliente, cidade: c.cidade, vendedor: c.vendedor,
                dataInstalacao: c.dataInstalacao, dataRetirada: c.dataRetirada, observacao: c.observacao,
                visitaId: c.visitaId, contratoUrl: c.contratoUrl, status: c.status, itens: []
            });
        }
        const g = grupos.get(key);
        g.itens.push(c);
        // Se algum item do grupo ainda está ativo, o grupo aparece como ativo.
        if (c.status === 'Ativo') g.status = 'Ativo';
    });
    return Array.from(grupos.values()).sort((a, b) => Number(b.loteId) - Number(a.loteId));
}

let comodatoStatusFilter = 'ativos';

export async function renderComodatosAdminPage() {
    ensureStyles('comodatos');
    const mainContent = document.getElementById('main-content');
    mainContent.innerHTML = loadingState('🔧', 'Carregando comodatos...');

    const [res, lembretesRes] = await Promise.all([
        callAPI('getComodatos', { user: state.currentUser }).catch((e) => ({ status: 'error', message: e.message })),
        callAPI('getLembretesAdmin', { user: state.currentUser }).catch(() => ({ status: 'error', lembretes: [] }))
    ]);
    if (res.status !== 'success') {
        mainContent.innerHTML = `<p class="error-message">${escapeHtml(res.message || 'Erro ao carregar.')}</p>`;
        return;
    }
    state.comodatos = res.comodatos || [];
    state.comodatoLembretesStatus = lembretesStatusFromLista(lembretesRes.lembretes || []);
    fillComodatosAdmin(mainContent);
}

// Mapeia os lembretes de sistema já ativos (Pendente) pela Origem — usado
// só pra mostrar "já está ativo" nos botões em vez de deixar sempre no
// mesmo "Ativar", sem dar nenhum sinal visual de que o clique funcionou.
function lembretesStatusFromLista(lembretes) {
    const porOrigem = {};
    (lembretes || []).forEach((l) => {
        if (l.origem && l.status === 'Pendente') porOrigem[l.origem] = l;
    });
    return porOrigem;
}

function fillComodatosAdmin(mainContent) {
    const grupos = agruparComodatos(state.comodatos || []);
    const ativos = grupos.filter((g) => g.status === 'Ativo');
    const retirados = grupos.filter((g) => g.status !== 'Ativo');
    const totalEquipamentosAtivos = (state.comodatos || []).filter((c) => c.status === 'Ativo').reduce((sum, c) => sum + (c.quantidade || 1), 0);
    const clientesAtivos = new Set(ativos.map((g) => g.cliente)).size;

    const visiveis = comodatoStatusFilter === 'ativos' ? ativos : comodatoStatusFilter === 'retirados' ? retirados : grupos;

    mainContent.innerHTML = `
        <div class="page-header">
            <div>
                <h2>🔧 Comodatos de Equipamento</h2>
                <p class="page-subtitle">Cada envio do Kadu gera um relatório de visita pro cliente.</p>
            </div>
        </div>
        <div class="comodato-lembretes-row">
            <button type="button" class="primary-button" id="comodato-enviar-link">📋 Enviar link pro Kadu</button>
            <button type="button" class="secondary-button" id="comodato-enviar-conferencia-link">🔍 Enviar conferência</button>
        </div>
        <div class="comodato-lembretes-row">
            ${lembreteStatusBotaoHtml('comodato-semanal', 'comodato-ativar-semanal', '🔔 Ativar lembrete semanal', 'Lembrete semanal ativo')}
            ${lembreteStatusBotaoHtml('comodato-conferencia', 'comodato-ativar-conferencia', '🔔 Ativar conferência mensal', 'Conferência mensal ativa')}
        </div>
        <div class="comodato-stats-row">
            <div class="comodato-stat-tile"><span class="comodato-stat-label">Equipamentos ativos</span><span class="comodato-stat-value">${totalEquipamentosAtivos}</span></div>
            <div class="comodato-stat-tile"><span class="comodato-stat-label">Clientes atendidos</span><span class="comodato-stat-value">${clientesAtivos}</span></div>
        </div>
        <div class="pill-row">
            <button type="button" class="mini-button${comodatoStatusFilter === 'ativos' ? ' is-on' : ''}" data-filtro="ativos">Ativos</button>
            <button type="button" class="mini-button${comodatoStatusFilter === 'todos' ? ' is-on' : ''}" data-filtro="todos">Todos</button>
            <button type="button" class="mini-button${comodatoStatusFilter === 'retirados' ? ' is-on' : ''}" data-filtro="retirados">Retirados</button>
        </div>
        <div id="comodato-lista">
            ${visiveis.length ? visiveis.map((g) => grupoCardHtml(g)).join('') : '<div class="empty-state"><span class="empty-state-icon">🔧</span><p>Nenhum comodato por aqui.</p></div>'}
        </div>
    `;

    mainContent.querySelectorAll('[data-filtro]').forEach((btn) => btn.addEventListener('click', () => {
        comodatoStatusFilter = btn.dataset.filtro;
        fillComodatosAdmin(mainContent);
    }));
    document.getElementById('comodato-ativar-semanal')?.addEventListener('click', (e) => ativarLembreteSistema(mainContent, e.currentTarget, 'comodato-semanal'));
    document.getElementById('comodato-ativar-conferencia')?.addEventListener('click', (e) => ativarLembreteSistema(mainContent, e.currentTarget, 'comodato-conferencia'));
    document.getElementById('comodato-enviar-link').addEventListener('click', () => enviarLinkWhatsapp('comodato-preencher', 'Por gentileza, registra o comodato de equipamento dessa semana.'));
    document.getElementById('comodato-enviar-conferencia-link').addEventListener('click', () => enviarLinkWhatsapp('comodato-conferencia', 'Por gentileza, confirma quais equipamentos ainda estão com o cliente.'));

    mainContent.querySelectorAll('[data-obs-grupo]').forEach((btn) => btn.addEventListener('click', () => {
        const g = grupos.find((x) => x.loteId + '__' + x.cliente === btn.dataset.obsGrupo);
        if (g) showObservacaoPopup(g);
    }));
    mainContent.querySelectorAll('[data-retirar-grupo]').forEach((btn) => btn.addEventListener('click', () => marcarRetirado(btn, grupos)));
    mainContent.querySelectorAll('[data-contrato-grupo]').forEach((btn) => btn.addEventListener('click', () => {
        const g = grupos.find((x) => x.loteId + '__' + x.cliente === btn.dataset.contratoGrupo);
        if (g) abrirModalContrato(g);
    }));
    mainContent.querySelectorAll('[data-visita-grupo]').forEach((btn) => btn.addEventListener('click', () => navigateTo('visit-detail', { id: btn.dataset.visitaGrupo })));
}

// Link direto na própria tela de Comodatos — não precisa passar pelos
// Lembretes só pra mandar o link pro Kadu (ver também o botão equivalente
// no card do lembrete de sistema, lembretes.js).
function enviarLinkWhatsapp(page, texto) {
    const link = `${window.location.origin}/?goto=${page}`;
    openExternal(`https://wa.me/?text=${encodeURIComponent(texto + '\n' + link)}`);
}

// Mostra o botão "Ativar..." OU, se já tem um lembrete de sistema Pendente
// com essa Origem, uma etiqueta fixa "já ativo" — sem isso o clique em
// "Ativar" parecia não fazer nada (só um toast passageiro, nenhum sinal
// que ficasse na tela).
function lembreteStatusBotaoHtml(origem, id, labelAtivar, labelAtivo) {
    const l = (state.comodatoLembretesStatus || {})[origem];
    if (l) return `<span class="comodato-lembrete-ativo-tag">✅ ${escapeHtml(labelAtivo)} — próximo em ${escapeHtml(l.dataAlvo)}</span>`;
    return `<button type="button" class="secondary-button" id="${id}">${labelAtivar}</button>`;
}

async function ativarLembreteSistema(mainContent, btn, tipo) {
    setSaving(true, btn, 'Ativando...');
    try {
        const res = await callAPI('criarLembreteSistemaComodato', { user: state.currentUser, tipo });
        if (res.status !== 'success') { setSaving(false, btn); showToast(res.message || 'Erro.', true); return; }
        state.comodatoLembretesStatus = state.comodatoLembretesStatus || {};
        state.comodatoLembretesStatus[tipo] = res.lembrete;
        showToast(res.jaExistia ? `Já estava ativo (próximo em ${res.lembrete.dataAlvo}).` : `Ativado! Próximo em ${res.lembrete.dataAlvo}.`);
        fillComodatosAdmin(mainContent);
    } catch (e) {
        setSaving(false, btn);
        showToast(e.message || 'Erro.', true);
    }
}

function grupoCardHtml(g) {
    const chips = g.itens.map((it) => `<span class="comodato-item-chip">${escapeHtml(it.equipamento)} ×${it.quantidade}</span>`).join('');
    const isAtivo = g.status === 'Ativo';
    const key = `${g.loteId}__${g.cliente}`;
    return `
        <div class="card comodato-grupo-card">
            <div class="comodato-grupo-top">
                <span class="comodato-avatar">${escapeHtml((g.cliente || '?').slice(0, 2).toUpperCase())}</span>
                <div class="comodato-grupo-info">
                    <span class="item-name">${escapeHtml(g.cliente)}</span>
                    <span class="item-meta">${isAtivo ? 'Instalado em' : 'Retirado em'} ${escapeHtml(isAtivo ? g.dataInstalacao : (g.dataRetirada || g.dataInstalacao))} · ${escapeHtml(g.vendedor || '-')}</span>
                </div>
                <span class="status-tag ${isAtivo ? 'pedido' : 'erro'}">${isAtivo ? 'Ativo' : 'Retirado'}</span>
            </div>
            <div class="comodato-grupo-itens">
                ${chips}
                ${g.observacao ? `<button type="button" class="text-link" data-obs-grupo="${escapeHtml(key)}">🗒️ Observação</button>` : ''}
                ${g.visitaId ? `<button type="button" class="text-link" data-visita-grupo="${escapeHtml(g.visitaId)}">📋 Ver visita</button>` : ''}
                ${g.contratoUrl ? `<a class="text-link" href="${escapeHtml(g.contratoUrl)}" target="_blank" rel="noopener">📄 Ver contrato</a>` : `<button type="button" class="text-link" data-contrato-grupo="${escapeHtml(key)}">📄 Gerar contrato</button>`}
                ${isAtivo ? `<button type="button" class="text-link" data-retirar-grupo="${escapeHtml(key)}">📦 Marcar retirado</button>` : ''}
            </div>
        </div>`;
}

function showObservacaoPopup(g) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
        <div class="modal-card newag-modal" style="max-width:360px">
            <div class="newag-modal-header">
                <span class="newag-modal-header-icon" aria-hidden="true">🗒️</span>
                <h3>Observação</h3>
                <button type="button" class="newag-modal-close" id="com-obs-close" aria-label="Fechar">✕</button>
            </div>
            <div class="newag-modal-body">
                <p class="helper-text" style="text-align:left;margin:0 0 0.6rem;font-weight:600">${escapeHtml(g.cliente)}</p>
                <p class="helper-text" style="text-align:left;margin:0;white-space:pre-wrap">${escapeHtml(g.observacao)}</p>
            </div>
        </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector('#com-obs-close').addEventListener('click', () => overlay.remove());
}

async function marcarRetirado(btn, grupos) {
    const key = btn.dataset.retirarGrupo;
    const g = grupos.find((x) => x.loteId + '__' + x.cliente === key);
    if (!g) return;
    if (!confirm(`Marcar todo o equipamento de "${g.cliente}" como retirado?`)) return;
    setSaving(true, btn, 'Marcando...');
    try {
        const res = await callAPI('marcarComodatoRetirado', { user: state.currentUser, ids: g.itens.map((it) => it.id) });
        setSaving(false, btn);
        if (res.status !== 'success') { showToast(res.message || 'Erro.', true); return; }
        showToast('Marcado como retirado.');
        renderComodatosAdminPage();
    } catch (e) {
        setSaving(false, btn);
        showToast(e.message || 'Erro.', true);
    }
}

function abrirModalContrato(g) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
        <div class="modal-card newag-modal" style="max-width:420px">
            <div class="newag-modal-header">
                <span class="newag-modal-header-icon" aria-hidden="true">📄</span>
                <h3>Gerar contrato</h3>
                <button type="button" class="newag-modal-close" id="com-contrato-close" aria-label="Fechar">✕</button>
            </div>
            <div class="newag-modal-body">
                <p class="helper-text" style="text-align:left;margin:0 0 0.6rem;font-weight:600">${escapeHtml(g.cliente)}</p>
                <div class="form-row-pair">
                    <div class="form-group">
                        <label for="ct-empresa">Empresa</label>
                        <select id="ct-empresa">
                            <option value="hygicare">Hygicare</option>
                            <option value="quest">Quest Clean</option>
                        </select>
                    </div>
                    <div class="form-group">
                        <label for="ct-modelo">Modelo</label>
                        <select id="ct-modelo">
                            <option value="elaborado">Contrato completo</option>
                            <option value="simples">Recibo simples</option>
                        </select>
                    </div>
                </div>
                <div class="form-group">
                    <label for="ct-assinatura">Assinatura</label>
                    <select id="ct-assinatura">
                        <option value="externa">Fora do app (impresso/assinado depois)</option>
                        <option value="app">Dentro do app</option>
                    </select>
                </div>
                <p class="section-label" style="margin:0.6rem 0 0.3rem">Dados do cliente (pro contrato)</p>
                <div class="form-group"><label for="ct-cnpj">CNPJ</label><input type="text" id="ct-cnpj" placeholder="00.000.000/0000-00"></div>
                <div class="form-group"><label for="ct-endereco">Endereço</label><input type="text" id="ct-endereco" placeholder="Rua, número"></div>
                <div class="form-row-pair">
                    <div class="form-group"><label for="ct-bairro">Bairro</label><input type="text" id="ct-bairro"></div>
                    <div class="form-group"><label for="ct-cidade">Cidade</label><input type="text" id="ct-cidade" value="${escapeHtml(g.cidade || '')}"></div>
                </div>
                <div class="form-row-pair">
                    <div class="form-group"><label for="ct-estado">Estado</label><input type="text" id="ct-estado"></div>
                    <div class="form-group"><label for="ct-cep">CEP</label><input type="text" id="ct-cep"></div>
                </div>
                <div id="ct-result" hidden style="margin:0.5rem 0"></div>
                <div class="form-actions full-width" style="display:flex;gap:0.5rem">
                    <button type="button" class="secondary-button" id="ct-cancel">Fechar</button>
                    <button type="button" class="primary-button" id="ct-gerar">Gerar</button>
                </div>
            </div>
        </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector('#com-contrato-close').addEventListener('click', () => overlay.remove());
    overlay.querySelector('#ct-cancel').addEventListener('click', () => overlay.remove());
    overlay.querySelector('#ct-gerar').addEventListener('click', async (ev) => {
        const btn = ev.currentTarget;
        setSaving(true, btn, 'Gerando...');
        try {
            const res = await callAPI('gerarContratoComodato', {
                user: state.currentUser, loteId: g.loteId, cliente: g.cliente,
                empresa: overlay.querySelector('#ct-empresa').value,
                modelo: overlay.querySelector('#ct-modelo').value,
                assinatura: overlay.querySelector('#ct-assinatura').value,
                clienteOverrides: {
                    cnpj: overlay.querySelector('#ct-cnpj').value.trim(),
                    endereco: overlay.querySelector('#ct-endereco').value.trim(),
                    bairro: overlay.querySelector('#ct-bairro').value.trim(),
                    cidade: overlay.querySelector('#ct-cidade').value.trim(),
                    estado: overlay.querySelector('#ct-estado').value.trim(),
                    cep: overlay.querySelector('#ct-cep').value.trim()
                }
            });
            setSaving(false, btn);
            if (res.status !== 'success') { showToast(res.message || 'Erro ao gerar.', true); return; }
            const result = overlay.querySelector('#ct-result');
            result.hidden = false;
            result.innerHTML = `<a class="primary-button" href="${escapeHtml(res.url)}" target="_blank" rel="noopener" style="display:block;text-align:center;text-decoration:none">Abrir contrato gerado →</a>`;
            showToast('Contrato gerado!');
            renderComodatosAdminPage();
        } catch (e) {
            setSaving(false, btn);
            showToast(e.message || 'Erro ao gerar.', true);
        }
    });
}

// ── Tela do Kadu: conferência periódica ─────────────────────────────────
export async function renderComodatoConferenciaPage() {
    ensureStyles('comodatos');
    const mainContent = document.getElementById('main-content');
    mainContent.innerHTML = loadingState('🔍', 'Carregando...');

    const res = await callAPI('getComodatos', { user: state.currentUser }).catch((e) => ({ status: 'error', message: e.message }));
    if (res.status !== 'success') {
        mainContent.innerHTML = `<p class="error-message">${escapeHtml(res.message || 'Erro ao carregar.')}</p>`;
        return;
    }
    const minhaConta = String(state.currentUser.name || '').trim().toLowerCase();
    const ativos = (res.comodatos || []).filter((c) => c.status === 'Ativo' && String(c.vendedor || '').trim().toLowerCase() === minhaConta);
    const respostas = new Map();

    function render() {
        mainContent.innerHTML = `
            <div class="page-header">
                <div>
                    <h2>🔍 Conferência de Comodato</h2>
                    <p class="page-subtitle">Esse equipamento ainda está com o cliente?</p>
                </div>
            </div>
            ${ativos.length === 0 ? `
                <div class="empty-state"><span class="empty-state-icon">🔧</span><p>Nenhum comodato ativo no seu nome.</p></div>
            ` : `
                <div id="conf-lista">
                    ${ativos.map((c) => `
                        <div class="card comodato-conf-card" data-conf-id="${escapeHtml(c.id)}">
                            <span class="item-name">${escapeHtml(c.cliente)}</span>
                            <span class="item-meta">${escapeHtml(c.equipamento)} ×${c.quantidade}</span>
                            <div class="comodato-conf-actions">
                                <button type="button" class="comodato-conf-btn ${respostas.get(c.id) === 'confirmado' ? 'is-active-ok' : ''}" data-status="confirmado">✅ Ainda está lá</button>
                                <button type="button" class="comodato-conf-btn ${respostas.get(c.id) === 'nao_encontrado' ? 'is-active-no' : ''}" data-status="nao_encontrado">❌ Não está mais</button>
                            </div>
                        </div>`).join('')}
                </div>
                <div class="form-actions">
                    <button type="button" class="primary-button" id="conf-enviar" style="width:100%">Enviar respostas</button>
                </div>
            `}
        `;
        mainContent.querySelectorAll('.comodato-conf-card').forEach((card) => {
            const id = card.dataset.confId;
            card.querySelectorAll('.comodato-conf-btn').forEach((btn) => btn.addEventListener('click', () => {
                respostas.set(id, btn.dataset.status);
                render();
            }));
        });
        document.getElementById('conf-enviar')?.addEventListener('click', (e) => enviarConferencia(e.currentTarget));
    }

    async function enviarConferencia(btn) {
        const lista = Array.from(respostas.entries()).map(([id, status]) => ({ id, status }));
        if (!lista.length) { showToast('Responda pelo menos um item.', true); return; }
        setSaving(true, btn, 'Enviando...');
        try {
            const r = await callAPI('registrarConferenciaComodato', { user: state.currentUser, respostas: lista });
            setSaving(false, btn);
            if (r.status !== 'success') { showToast(r.message || 'Erro.', true); return; }
            showToast('Obrigado! Conferência registrada.');
            navigateTo('dashboard');
        } catch (e) {
            setSaving(false, btn);
            showToast(e.message || 'Erro.', true);
        }
    }

    render();
}
