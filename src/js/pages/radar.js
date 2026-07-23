import { state, navigateTo } from '../app.js';
import { callAPI } from '../api.js';
import { escapeHtml, parseDisplayDate, formatDateForDisplay } from '../utils/format.js';
import { initializeSearchableInput, showToast, loadingState, setSaving } from '../utils/dom.js';
import { ensureStyles } from '../utils/ui.js';
import { BRAZIL_MAP_SIZE, BRAZIL_OUTLINE_PATH, BRAZIL_STATE_PATHS, projectLatLng } from '../data/brazilOutline.js';
import L from 'leaflet';
import 'leaflet.markercluster';

// Chave client-side da MapTiler (conta gratuita do usuário, sem cartão —
// 100k carregamentos/mês grátis). Não é segredo de servidor: chave de mapa
// como essa é sempre exposta no bundle do navegador (mesmo padrão de
// Google Maps/Mapbox) — a proteção de verdade é restringir por domínio no
// painel da MapTiler, não esconder a chave.
const MAPTILER_KEY = 'VtkcETe0JVg8xihIDpTt';

const STATUS_HEX = {
    buscado: '#166534',
    ja_atendido: '#1d4ed8',
    recusado: '#991b1b',
    prospeccao_agendada: '#b45309'
};

const STATUS_LABELS = {
    buscado: 'Nunca contatado',
    ja_atendido: 'Já é cliente',
    recusado: 'Recusou',
    prospeccao_agendada: 'Prospecção agendada'
};

const STATUS_CLASSES = {
    buscado: 'status-pill radar-status-buscado',
    ja_atendido: 'status-pill radar-status-atendido',
    recusado: 'status-pill radar-status-recusado',
    prospeccao_agendada: 'status-pill radar-status-agendada'
};

// Prioriza quem nunca foi contatado — é literalmente o objetivo do Radar.
// Usado pra ordenar a lista (renderClienteCards) e pra escolher a cor de
// um cluster de pins no mapa por empresa (status "mais prioritário" entre
// os que estão no mesmo ponto).
const STATUS_PRIORITY = { buscado: 0, prospeccao_agendada: 1, recusado: 2, ja_atendido: 3 };

// Chips do filtro de status (aba Buscar) — gerados a partir de
// STATUS_LABELS/STATUS_CLASSES pra não duplicar rótulo/cor em mais um
// lugar. "Todos" não tem status (data-status vazio limpa o filtro).
const STATUS_FILTER_CHIPS_HTML = ['<button type="button" class="radar-status-chip active" data-status="">Todos</button>']
    .concat(Object.entries(STATUS_LABELS).map(([value, label]) => {
        const cls = (STATUS_CLASSES[value] || '').replace('status-pill', '').trim();
        return `<button type="button" class="radar-status-chip ${cls}" data-status="${value}">${escapeHtml(label)}</button>`;
    }))
    .join('');

// Desativado a pedido do usuário (layout não convenceu mesmo depois de
// corrigir tamanho de pin e filtrar pra cidade escolhida — ver commits
// anteriores). Código do mapa continua intacto abaixo, só não é chamado;
// pra reativar, basta voltar isso pra `true`.
const RADAR_MAP_ENABLED = false;

// Desativado de novo (temporário) — achamos CNPJ com zero à esquerda
// perdido fazendo a geocodificação consultar a empresa ERRADA na CNPJá
// (endereço/pin de outra empresa qualquer). Corrigido o código (ver
// corrigirCnpjsComZeroPerdido no .gs), mas os dados JÁ geocodificados
// errado ainda precisam ser resetados e reprocessados antes do mapa
// voltar a ser confiável. Reativar assim que os dados estiverem limpos.
const RADAR_EMPRESA_MAP_ENABLED = false;

let activeRadarTab = 'buscar';

// Lista da cidade atualmente carregada — vive só neste módulo (não em
// `state`), já que o Radar não segue o padrão "carrega tudo" do resto do
// app (é filtrado por cidade no servidor), então não faz sentido tratar
// como uma lista global igual state.visits/state.proposals.
let currentClientes = [];
let currentCidade = null; // { cidade, uf, lat, lng } selecionado na aba Buscar
let mapApi = null; // API do mapa (ver renderCidadeMapa) — atualiza pins/zoom a partir daqui e de renderRadarResults
let empresaMapInstance = null; // instância Leaflet do mapa por empresa (ver renderEmpresaMapa) — precisa de .remove() explícito antes de recriar

// Aba Histórico: por padrão mostra a mesma cidade selecionada na aba
// Buscar (mesma trava de segurança de escala da seção 4 do plano) — só
// busca todas as cidades sob um clique explícito.
let historicoClientes = [];
let historicoScopeAll = false;
let historicoLoaded = false;

// Abas Acessos/Panorama (relatórios) — mesmo padrão de carregar 1 vez só,
// na primeira vez que a aba é aberta.
let acessosLoaded = false;
let panoramaLoaded = false;

function cidadeLabel(c) {
    return c.uf ? `${c.cidade} - ${c.uf}` : c.cidade;
}

// Data mais recente de DataBusca entre as empresas — devolve a própria
// string já formatada (DD/MM/AAAA, como vem do backend), não precisa
// reformatar a partir do Date, só usa ele pra achar a maior data.
function maisRecenteDataBusca(clientes) {
    let melhorTexto = null, melhorData = null;
    clientes.forEach((c) => {
        const d = parseDisplayDate(c.dataBusca);
        if (d && (!melhorData || d > melhorData)) { melhorData = d; melhorTexto = c.dataBusca; }
    });
    return melhorTexto;
}

// Reserva de 6 meses (ver handleUpdateRadarClienteStatus no backend): quem
// agendou prospecção primeiro trava a empresa pros outros vendedores. Fato
// puro (não depende de quem está olhando) — usado pra MOSTRAR quem está
// com a empresa reservada, inclusive pro admin (que ignora a trava, mas
// ainda quer saber quem está trabalhando o quê).
function reservaAtiva(cliente) {
    if (!cliente.reservadoPorEmail) return false;
    const ate = parseDisplayDate(cliente.reservadoAte);
    if (!ate) return false;
    return ate >= new Date(new Date().setHours(0, 0, 0, 0));
}

// Deve bloquear os botões de ação PRA ESSE usuário — reserva ativa E de
// outra pessoa (admin ignora a trava, mesmo padrão do backend).
function reservaAtivaDeOutro(cliente) {
    if (!reservaAtiva(cliente)) return false;
    const isAdmin = String(state.currentUser?.profile || '').trim().toLowerCase() === 'admin';
    return !isAdmin && cliente.reservadoPorEmail !== state.currentUser?.email;
}

export async function renderRadarPage() {
    ensureStyles('radar');
    const mainContent = document.getElementById('main-content');

    // O item de nav aparece pra qualquer um com o toggle do admin ligado —
    // a exigência de visita recente (ensureCanAccessRadar, backend) só é
    // checada de fato aqui, na hora de abrir a tela. Sem isso, o vendedor
    // via "Radar" sumir do menu sem nenhuma explicação; agora ele entra e
    // a própria tela informa o motivo (ex.: falta registrar visita).
    const acessoCheck = await callAPI('getRadarCidadesDisponiveis', { user: state.currentUser });
    if (acessoCheck.status === 'success') {
        // Fire-and-forget — não atrasa a tela, e uma falha aqui (rede, etc.)
        // não deveria impedir o vendedor de usar o Radar.
        callAPI('registrarAcessoRadar', { user: state.currentUser });
    }
    if (acessoCheck.status !== 'success') {
        mainContent.innerHTML = `
            <div class="page-header">
                <div><h2>Radar de Clientes</h2><p class="page-subtitle">Encontre empresas por cidade pra prospectar</p></div>
            </div>
            <div class="empty-state">
                <span class="empty-state-icon">🔒</span>
                <p>${escapeHtml(acessoCheck.message || 'Você não tem acesso ao Radar de Clientes no momento.')}</p>
            </div>
        `;
        return;
    }

    const isAdmin = String(state.currentUser?.profile || '').trim().toLowerCase() === 'admin';
    mainContent.innerHTML = `
        <div class="page-header">
            <div><h2>Radar de Clientes</h2><p class="page-subtitle">Encontre empresas por cidade pra prospectar</p></div>
            <button type="button" class="btn-add no-print" id="radar-download-pdf">📄 Baixar PDF</button>
        </div>
        <div class="radar-tabs-bar">
            <button type="button" class="radar-tab${activeRadarTab === 'buscar' ? ' active' : ''}" data-tab="buscar">Buscar</button>
            <button type="button" class="radar-tab${activeRadarTab === 'historico' ? ' active' : ''}" data-tab="historico">Histórico</button>
            <button type="button" class="radar-tab${activeRadarTab === 'acessos' ? ' active' : ''}" data-tab="acessos">Acessos</button>
            <button type="button" class="radar-tab${activeRadarTab === 'panorama' ? ' active' : ''}" data-tab="panorama">Panorama</button>
            ${isAdmin ? `<button type="button" class="radar-tab${activeRadarTab === 'importar' ? ' active' : ''}" data-tab="importar">Importar CSV</button>` : ''}
            ${isAdmin ? `<button type="button" class="radar-tab${activeRadarTab === 'config' ? ' active' : ''}" data-tab="config">Configurações</button>` : ''}
        </div>
        <div class="radar-tab-panel${activeRadarTab === 'buscar' ? ' active' : ''}" id="radar-tab-buscar">
            <div id="radar-reservas-expirando-wrap"></div>
            ${RADAR_MAP_ENABLED ? '<div id="radar-map-wrap"></div>' : ''}
            <div class="card radar-search-card">
                <div class="form-group">
                    <label for="radar-cidade">Cidade</label>
                    <div class="searchable-select">
                        <input type="text" id="radar-cidade" placeholder="Escolha uma cidade liberada" autocomplete="off">
                        <div class="searchable-select-menu" id="radar-cidade-menu"></div>
                    </div>
                    <p class="field-helper-text" id="radar-dados-info" style="display:none"></p>
                </div>
                <div class="form-group" id="radar-segmento-group" style="display:none">
                    <label for="radar-segmento">Segmento</label>
                    <select id="radar-segmento">
                        <option value="">Todos os segmentos</option>
                    </select>
                </div>
                <div class="form-group" id="radar-status-filtro-group" style="display:none">
                    <label>Status</label>
                    <div class="radar-status-chips" id="radar-status-chips" role="group" aria-label="Filtrar por status">${STATUS_FILTER_CHIPS_HTML}</div>
                </div>
                <div class="form-group" id="radar-limpar-group" style="display:none">
                    <button type="button" class="mini-button" id="radar-limpar-filtros">Limpar filtros</button>
                </div>
            </div>
            ${RADAR_EMPRESA_MAP_ENABLED ? '<div id="radar-empresa-map-wrap"></div>' : ''}
            <div id="radar-results"></div>
        </div>
        <div class="radar-tab-panel${activeRadarTab === 'historico' ? ' active' : ''}" id="radar-tab-historico">
            <div class="card radar-search-card">
                <div class="form-group">
                    <label for="radar-historico-status">Status</label>
                    <select id="radar-historico-status">
                        <option value="todos">Todos</option>
                        <option value="buscado">Nunca contatado</option>
                        <option value="ja_atendido">Já é cliente</option>
                        <option value="recusado">Recusou</option>
                        <option value="prospeccao_agendada">Prospecção agendada</option>
                    </select>
                </div>
                <p class="field-helper-text" id="radar-historico-scope-label"></p>
                <button type="button" class="mini-button" id="radar-historico-scope-btn" style="display:none">Ver todas as cidades</button>
            </div>
            <div id="radar-historico-results"></div>
            ${isAdmin ? `
                <div class="card" style="margin-top:1rem">
                    <h3 style="margin-top:0">Solicitações de cidade pendentes</h3>
                    <div id="radar-solicitacoes-list"><p class="page-subtitle">Carregando...</p></div>
                </div>
            ` : ''}
        </div>
        <div class="radar-tab-panel${activeRadarTab === 'acessos' ? ' active' : ''}" id="radar-tab-acessos">
            <div id="radar-acessos-results"><p class="page-subtitle">Carregando...</p></div>
        </div>
        <div class="radar-tab-panel${activeRadarTab === 'panorama' ? ' active' : ''}" id="radar-tab-panorama">
            <div id="radar-panorama-results"><p class="page-subtitle">Carregando...</p></div>
        </div>
        ${isAdmin ? `
            <div class="radar-tab-panel${activeRadarTab === 'importar' ? ' active' : ''}" id="radar-tab-importar">
                <div class="card">
                    <h3 style="margin-top:0">Importar base do Radar (CSV)</h3>
                    <p class="helper-text" style="text-align:left">
                        Sobe o CSV exportado do programa de consulta de CNPJ. Empresa nova entra
                        como "nunca contatada"; empresa já cadastrada (mesmo CNPJ) só atualiza os
                        dados informativos — o status dado pelo vendedor nunca é sobrescrito.
                        Cidade nova é liberada automaticamente pra todo mundo.
                    </p>
                    <div class="form-group full-width">
                        <label for="radar-import-file">Arquivo CSV</label>
                        <input type="file" id="radar-import-file" accept=".csv,text/csv">
                    </div>
                    <div class="form-actions">
                        <button type="button" class="primary-button" id="radar-import-btn" disabled>Importar</button>
                    </div>
                    <div id="radar-import-summary" style="margin-top:1rem"></div>
                </div>
            </div>
        ` : ''}
        ${isAdmin ? `
            <div class="radar-tab-panel${activeRadarTab === 'config' ? ' active' : ''}" id="radar-tab-config">
                <div class="card">
                    <h3 style="margin-top:0">Regras do Radar</h3>
                    <div class="form-group full-width">
                        <label for="radar-cfg-reserva-meses">Duração da reserva (meses)</label>
                        <input type="number" id="radar-cfg-reserva-meses" min="1" max="24">
                        <p class="field-helper-text">
                            Quando um vendedor clica em "Agendar prospecção", a empresa fica reservada
                            só pra ele por esse tempo — nenhum outro vendedor consegue agir nela até a
                            reserva expirar ou ele concluir (marcar "já é atendido" ou "recusou").
                        </p>
                    </div>
                    <div class="form-group full-width">
                        <label for="radar-cfg-visita-dias">Dias sem visita registrada pra perder acesso</label>
                        <input type="number" id="radar-cfg-visita-dias" min="1" max="90">
                        <p class="field-helper-text">
                            Vendedor e gerente só acessam o Radar se tiverem registrado pelo menos 1
                            visita (cliente ativo ou prospecção, qualquer tipo) dentro desse prazo. Sem
                            isso, o Radar não deveria virar substituto do trabalho de campo já registrado
                            no resto do app. Admin sempre acessa, sem essa exigência.
                        </p>
                    </div>
                    <div class="form-group full-width">
                        <label for="radar-cfg-geo-limite">Limite mensal de geocodificação (créditos)</label>
                        <input type="number" id="radar-cfg-geo-limite" min="1" max="100000">
                        <p class="field-helper-text">
                            Quem geocodifica é o script à parte (fora do app, direto na planilha) — esse
                            número é só o limite que ele respeita sozinho antes de parar por esse mês.
                        </p>
                    </div>
                    <div class="form-actions">
                        <button type="button" class="primary-button" id="radar-cfg-salvar">Salvar</button>
                    </div>
                </div>
                <div class="card" id="radar-cfg-geo-status">
                    <h3 style="margin-top:0">Geocodificação por empresa</h3>
                    <p class="page-subtitle" id="radar-cfg-geo-resumo">Carregando...</p>
                </div>
            </div>
        ` : ''}
    `;

    document.getElementById('radar-download-pdf').addEventListener('click', () => window.print());

    document.querySelectorAll('.radar-tab').forEach((tab) => {
        tab.addEventListener('click', () => {
            activeRadarTab = tab.dataset.tab;
            document.querySelectorAll('.radar-tab').forEach((t) => t.classList.remove('active'));
            document.querySelectorAll('.radar-tab-panel').forEach((p) => p.classList.remove('active'));
            tab.classList.add('active');
            document.getElementById(`radar-tab-${tab.dataset.tab}`)?.classList.add('active');
            if (tab.dataset.tab === 'historico' && !historicoLoaded) {
                historicoLoaded = true;
                loadHistorico();
                if (isAdmin) { loadSolicitacoes(); }
            }
            if (tab.dataset.tab === 'acessos' && !acessosLoaded) {
                acessosLoaded = true;
                loadAcessos();
            }
            if (tab.dataset.tab === 'panorama' && !panoramaLoaded) {
                panoramaLoaded = true;
                loadPanorama();
            }
        });
    });

    if (isAdmin) { bindImportTab(); bindConfigTab(); }

    await renderBuscarTab();

    if (activeRadarTab === 'historico') {
        historicoLoaded = true;
        await loadHistorico();
        if (isAdmin) { await loadSolicitacoes(); }
    } else if (activeRadarTab === 'acessos') {
        acessosLoaded = true;
        await loadAcessos();
    } else if (activeRadarTab === 'panorama') {
        panoramaLoaded = true;
        await loadPanorama();
    }
}

function bindImportTab() {
    const fileInput = document.getElementById('radar-import-file');
    const importBtn = document.getElementById('radar-import-btn');
    const summaryEl = document.getElementById('radar-import-summary');
    let selectedFile = null;

    fileInput.addEventListener('change', () => {
        selectedFile = fileInput.files && fileInput.files[0] ? fileInput.files[0] : null;
        importBtn.disabled = !selectedFile;
        summaryEl.innerHTML = '';
    });

    importBtn.addEventListener('click', () => {
        if (!selectedFile) return;
        setSaving(true, importBtn, 'Importando...');
        summaryEl.innerHTML = '';
        const reader = new FileReader();
        reader.onload = async () => {
            const csvText = String(reader.result || '');
            const result = await callAPI('importRadarClientesCsv', { user: state.currentUser, csvText });
            setSaving(false, importBtn);
            if (result.status !== 'success') {
                summaryEl.innerHTML = `<p class="error-message">${escapeHtml(result.message || 'Erro ao importar o CSV.')}</p>`;
                return;
            }
            summaryEl.innerHTML = `
                <div class="card" style="background:var(--bg-alt, #f8fafc)">
                    <p style="margin:0 0 0.4rem"><strong>${result.novas}</strong> empresa(s) nova(s)</p>
                    <p style="margin:0 0 0.4rem"><strong>${result.atualizadas}</strong> empresa(s) atualizada(s)</p>
                    ${result.cidadesAdicionadas ? `<p style="margin:0 0 0.4rem"><strong>${result.cidadesAdicionadas}</strong> cidade(s) nova(s) liberada(s)</p>` : ''}
                    ${result.solicitacoesAtendidas ? `<p style="margin:0 0 0.4rem"><strong>${result.solicitacoesAtendidas}</strong> solicitação(ões) de cidade atendida(s)</p>` : ''}
                    ${result.ignoradas ? `<p style="margin:0 0 0.4rem">${result.ignoradas} linha(s) ignorada(s) (sem CNPJ, Cliente ou Cidade)</p>` : ''}
                    ${result.duplicadasNoArquivo ? `<p style="margin:0">${result.duplicadasNoArquivo} linha(s) duplicada(s) dentro do próprio arquivo</p>` : ''}
                </div>
            `;
            showToast('Importação concluída.');
            fileInput.value = '';
            selectedFile = null;
            importBtn.disabled = true;
            historicoLoaded = false;
        };
        reader.onerror = () => {
            setSaving(false, importBtn);
            summaryEl.innerHTML = `<p class="error-message">Não foi possível ler o arquivo.</p>`;
        };
        reader.readAsText(selectedFile, 'UTF-8');
    });
}

function bindConfigTab() {
    const reservaInput = document.getElementById('radar-cfg-reserva-meses');
    const visitaInput = document.getElementById('radar-cfg-visita-dias');
    const limiteInput = document.getElementById('radar-cfg-geo-limite');
    const geoResumoEl = document.getElementById('radar-cfg-geo-resumo');
    const saveBtn = document.getElementById('radar-cfg-salvar');

    callAPI('getEmailConfig', { user: state.currentUser }).then((result) => {
        if (result.status !== 'success') return;
        reservaInput.value = result.data.radar_reserva_meses || '6';
        visitaInput.value = result.data.radar_visita_dias || '7';
        limiteInput.value = result.data.radar_geocoding_limite_mensal || '50';
        renderGeoResumo(result.data, geoResumoEl);
    });

    saveBtn.addEventListener('click', async () => {
        const reservaMeses = Number(reservaInput.value);
        const visitaDias = Number(visitaInput.value);
        const limiteMensal = Number(limiteInput.value);
        if (!reservaMeses || reservaMeses < 1) { showToast('Informe uma duração de reserva válida.', true); return; }
        if (!visitaDias || visitaDias < 1) { showToast('Informe um número de dias válido.', true); return; }
        if (!limiteMensal || limiteMensal < 1) { showToast('Informe um limite de geocodificação válido.', true); return; }
        setSaving(true, saveBtn, 'Salvando...');
        const result = await callAPI('saveEmailConfig', {
            user: state.currentUser,
            config: {
                radar_reserva_meses: String(reservaMeses),
                radar_visita_dias: String(visitaDias),
                radar_geocoding_limite_mensal: String(limiteMensal)
            }
        });
        setSaving(false, saveBtn);
        if (result.status === 'success') {
            showToast('Configurações do Radar salvas.');
        } else {
            showToast(result.message || 'Não foi possível salvar.', true);
        }
    });
}

// Só leitura — quem escreve radar_geocoding_usado_mes/mes_referencia é o
// script à parte (scripts/radar-geocoding-backfill.gs), nunca o app. Se a
// referência de mês salva não bate com o mês atual, o script ainda não
// rodou desse mês — mostra 0 em vez do número (já zerado) do mês passado.
async function renderGeoResumo(configData, el) {
    const mesAtual = new Date().toISOString().slice(0, 7);
    const usado = configData.radar_geocoding_mes_referencia === mesAtual
        ? (configData.radar_geocoding_usado_mes || '0') : '0';
    const limite = configData.radar_geocoding_limite_mensal || '50';

    const result = await callAPI('getRadarClientes', { user: state.currentUser, scope: 'all' });
    if (result.status !== 'success') {
        el.textContent = `Créditos usados este mês: ${usado} de ${limite}.`;
        return;
    }
    const clientes = result.clientes || [];
    let comCoordenada = 0, semCoordenada = 0, pendente = 0;
    clientes.forEach((c) => {
        if (c.latitude === 'sem_coordenada') semCoordenada++;
        else if (c.latitude) comCoordenada++;
        else pendente++;
    });
    el.innerHTML = `Créditos usados este mês: <strong>${escapeHtml(usado)} de ${escapeHtml(limite)}</strong>.<br>` +
        `${clientes.length} empresa(s) no total — ${comCoordenada} geocodificada(s), ` +
        `${semCoordenada} sem coordenada disponível, ${pendente} ainda pendente(s).`;
}

// Aviso de renovação — reservas do PRÓPRIO usuário vencendo em até 7 dias
// (ver handleGetRadarReservasExpirando). Roda em paralelo com o resto da
// aba Buscar (não bloqueia o carregamento das cidades), sem culpa: é 1
// chamada leve, o backend já filtra pra só as poucas linhas que interessam.
async function renderReservasExpirando() {
    const wrap = document.getElementById('radar-reservas-expirando-wrap');
    if (!wrap) return;
    // Sem try/catch, uma falha de rede/timeout (não "erro de negócio", que
    // já vem como {status:'error'} normal) derrubava a função sem nunca
    // atualizar o wrap — nesse caso específico ficava só vazio (sem
    // mensagem), mas o mesmo problema deixava outras telas do Radar presas
    // em "Carregando..." pra sempre (ver loadAcessos/loadPanorama).
    let result;
    try {
        result = await callAPI('getRadarReservasExpirando', { user: state.currentUser });
    } catch (e) {
        wrap.innerHTML = '';
        return;
    }
    const clientes = result.status === 'success' ? (result.clientes || []) : [];
    if (!clientes.length) {
        wrap.innerHTML = '';
        return;
    }
    wrap.innerHTML = `
        <div class="radar-reserva-aviso">
            <strong>${clientes.length === 1 ? 'Uma reserva sua vence' : `${clientes.length} reservas suas vencem`} em até 7 dias:</strong>
            <div class="radar-reservas-expirando-list">
                ${clientes.map((c) => `
                    <div class="radar-reserva-expirando-item">
                        <span>${escapeHtml(c.nomeFantasia || c.nome || 'Empresa')} — vence em ${escapeHtml(c.reservadoAte)}</span>
                        <button type="button" class="mini-button" data-renovar-id="${escapeHtml(c.id)}">Renovar</button>
                    </div>
                `).join('')}
            </div>
        </div>
    `;
    wrap.querySelectorAll('[data-renovar-id]').forEach((btn) => {
        btn.addEventListener('click', async () => {
            setSaving(true, btn, 'Renovando...');
            const renovarResult = await callAPI('renovarReservaRadarCliente', { user: state.currentUser, id: btn.dataset.renovarId });
            if (renovarResult.status === 'success') {
                showToast('Reserva renovada.');
                renderReservasExpirando();
                rerenderRadarList();
            } else {
                showToast(renovarResult.message || 'Não foi possível renovar.', true);
                setSaving(false, btn);
            }
        });
    });
}

async function renderBuscarTab() {
    renderReservasExpirando();
    const resultsEl = document.getElementById('radar-results');
    resultsEl.innerHTML = loadingState('📡', 'Carregando cidades liberadas...');

    const cidadesResult = await callAPI('getRadarCidadesDisponiveis', { user: state.currentUser });
    if (cidadesResult.status !== 'success') {
        resultsEl.innerHTML = `<p class="error-message">${escapeHtml(cidadesResult.message || 'Não foi possível carregar as cidades.')}</p>`;
        return;
    }
    const cidades = cidadesResult.cidades || [];

    if (cidades.length === 0) {
        resultsEl.innerHTML = `
            <div class="empty-state">
                <span class="empty-state-icon">📍</span>
                <p>Nenhuma cidade liberada ainda.</p>
                <button type="button" class="btn-add" id="radar-solicitar-cidade-btn">Solicitar cidade</button>
            </div>
        `;
        document.getElementById('radar-solicitar-cidade-btn')?.addEventListener('click', () => openSolicitarCidadeModal());
        return;
    }

    resultsEl.innerHTML = `<div class="empty-state"><span class="empty-state-icon">🔍</span><p>Escolha uma cidade acima pra ver as empresas.</p></div>`;

    const cidadeInput = document.getElementById('radar-cidade');
    const cidadeMenu = document.getElementById('radar-cidade-menu');
    const dadosInfoEl = document.getElementById('radar-dados-info');
    const segmentoGroup = document.getElementById('radar-segmento-group');
    const segmentoInput = document.getElementById('radar-segmento');
    const statusFiltroGroup = document.getElementById('radar-status-filtro-group');
    const statusChips = document.getElementById('radar-status-chips');
    const limparGroup = document.getElementById('radar-limpar-group');
    const limparBtn = document.getElementById('radar-limpar-filtros');

    const selectCidade = async (match) => {
        cidadeInput.value = cidadeLabel(match);
        resultsEl.innerHTML = loadingState('📡', 'Buscando empresas...');
        const result = await callAPI('getRadarClientes', { user: state.currentUser, cidade: match.cidade, uf: match.uf });
        if (result.status !== 'success') {
            resultsEl.innerHTML = `<p class="error-message">${escapeHtml(result.message || 'Erro ao buscar empresas.')}</p>`;
            return;
        }
        currentClientes = result.clientes || [];
        currentCidade = { cidade: match.cidade, uf: match.uf, lat: match.lat, lng: match.lng };
        segmentoGroup.style.display = '';
        statusFiltroGroup.style.display = '';
        limparGroup.style.display = '';
        // Data mais recente entre as empresas da cidade — dá pra ter noção
        // de quão desatualizada a base pode estar (importação é periódica,
        // não em tempo real).
        const maisRecente = maisRecenteDataBusca(currentClientes);
        if (maisRecente) {
            dadosInfoEl.textContent = `Dados consultados em ${maisRecente}`;
            dadosInfoEl.style.display = '';
        } else {
            dadosInfoEl.style.display = 'none';
        }
        populateSegmentoOptions(segmentoInput);
        renderRadarResults(resultsEl);
        updateHistoricoScopeLabel();
        mapApi?.selectCityOnMap(match);
    };

    initializeSearchableInput({
        input: cidadeInput,
        menu: cidadeMenu,
        items: cidades.map(cidadeLabel),
        onSelect: (value) => {
            const match = cidades.find((c) => cidadeLabel(c) === value);
            if (match) selectCidade(match);
        }
    });

    segmentoInput.addEventListener('change', () => renderRadarResults(resultsEl));

    statusChips.querySelectorAll('.radar-status-chip').forEach((btn) => {
        btn.addEventListener('click', () => {
            statusChips.querySelectorAll('.radar-status-chip').forEach((b) => b.classList.toggle('active', b === btn));
            renderRadarResults(resultsEl);
        });
    });

    // Depois de escolher uma cidade não tinha como voltar a ver todas as
    // cidades liberadas no mapa sem recarregar a aba — "Limpar filtros"
    // desfaz a seleção de cidade (e os filtros de segmento/status junto).
    limparBtn.addEventListener('click', () => {
        currentCidade = null;
        currentClientes = [];
        cidadeInput.value = '';
        segmentoInput.value = '';
        statusChips.querySelectorAll('.radar-status-chip').forEach((b) => b.classList.toggle('active', b.dataset.status === ''));
        segmentoGroup.style.display = 'none';
        statusFiltroGroup.style.display = 'none';
        limparGroup.style.display = 'none';
        dadosInfoEl.style.display = 'none';
        resultsEl.innerHTML = `<div class="empty-state"><span class="empty-state-icon">🔍</span><p>Escolha uma cidade acima pra ver as empresas.</p></div>`;
        if (empresaMapInstance) { empresaMapInstance.remove(); empresaMapInstance = null; }
        document.getElementById('radar-empresa-map-wrap').innerHTML = '';
        mapApi?.clearFiltro();
    });

    mapApi = RADAR_MAP_ENABLED ? renderCidadeMapa(cidades, selectCidade) : null;
}

// Dropdown com um resumo de verdade (valores que realmente existem nessa
// cidade) em vez de campo livre — o vendedor via a lista em vez de ter que
// adivinhar o que digitar. Cai pro CNAE quando Segmento vier vazio (dado
// importado antes dessa coluna existir no CSV).
function populateSegmentoOptions(segmentoSelect) {
    const valores = new Set();
    currentClientes.forEach((c) => {
        const v = String(c.segmento || c.cnaeDescricao || '').trim();
        if (v) valores.add(v);
    });
    const ordenados = Array.from(valores).sort((a, b) => a.localeCompare(b, 'pt-BR'));
    segmentoSelect.innerHTML = '<option value="">Todos os segmentos</option>' +
        ordenados.map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('');
}

const MAP_ZOOM_MIN = 1;
const MAP_ZOOM_MAX = 10;

// Mapa esquemático (contorno estático + pins) por cima da lista de
// cidades — só entram cidades com Lat/Lng resolvida (ver seção 6 do
// plano); quem não tem coordenada continua acessível pelo campo de busca
// acima, que não muda nada com ou sem mapa. Arrastar (mouse/touch) e zoom
// (scroll, pinça de 2 dedos, botões +/-) via transform num <g> interno —
// o path/pins em si nunca mudam, só a transformação aplicada por cima.
function renderCidadeMapa(cidades, onSelect) {
    const wrap = document.getElementById('radar-map-wrap');
    if (!wrap) return;
    const comCoordenada = cidades.filter((c) => c.lat !== null && c.lng !== null && !Number.isNaN(c.lat) && !Number.isNaN(c.lng));
    if (comCoordenada.length === 0) { wrap.innerHTML = ''; return; }

    const pins = comCoordenada.map((c) => {
        const { x, y } = projectLatLng(c.lat, c.lng);
        return `<circle class="radar-map-pin" cx="${x}" cy="${y}" r="5" data-cidade="${escapeHtml(c.cidade)}" data-uf="${escapeHtml(c.uf)}"><title>${escapeHtml(cidadeLabel(c))}</title></circle>`;
    }).join('');
    const estados = BRAZIL_STATE_PATHS.map((s) =>
        `<path d="${s.d}" class="radar-map-state${currentCidade && currentCidade.uf === s.sigla ? ' active' : ''}" data-uf="${s.sigla}"><title>${s.sigla}</title></path>`
    ).join('');

    wrap.innerHTML = `
        <div class="card radar-map-card">
            <div class="radar-map-viewport">
                <svg viewBox="0 0 ${BRAZIL_MAP_SIZE} ${BRAZIL_MAP_SIZE}" class="radar-map-svg" id="radar-map-svg" role="img" aria-label="Mapa com as cidades liberadas do Radar — arraste pra mover, use scroll ou pinça pra dar zoom">
                    <g id="radar-map-group">
                        <path d="${BRAZIL_OUTLINE_PATH}" class="radar-map-outline"></path>
                        ${estados}
                        ${pins}
                    </g>
                </svg>
                <div class="radar-map-toolbar">
                    <button type="button" class="radar-map-zoom-btn" id="radar-map-zoom-in" aria-label="Aumentar zoom">+</button>
                    <button type="button" class="radar-map-zoom-btn" id="radar-map-zoom-out" aria-label="Diminuir zoom">−</button>
                    <button type="button" class="radar-map-zoom-btn" id="radar-map-zoom-reset" aria-label="Redefinir zoom">⟲</button>
                </div>
            </div>
        </div>
    `;

    wrap.querySelectorAll('.radar-map-pin').forEach((pin) => {
        pin.addEventListener('click', () => {
            if (mapDragged) return; // arrastar não deve também selecionar a cidade
            const match = comCoordenada.find((c) => c.cidade === pin.dataset.cidade && c.uf === pin.dataset.uf);
            if (match) onSelect(match);
        });
    });

    const svg = document.getElementById('radar-map-svg');
    const group = document.getElementById('radar-map-group');
    let scale = 1, tx = 0, ty = 0;
    let mapDragged = false;

    function applyTransform() {
        group.setAttribute('transform', `translate(${tx},${ty}) scale(${scale})`);
    }
    applyTransform();

    // Raio do pin fica dentro do <g> transformado, então escala junto com o
    // zoom (vector-effect="non-scaling-stroke" só protege o contorno, não o
    // raio) — sem isso, o zoom automático da cidade (7x) deixava o pin 7x
    // maior na tela. Chamado sempre que `scale` muda por interação do
    // usuário, pra manter o pin do mesmo tamanho em qualquer zoom.
    function refreshPinRadii() {
        document.querySelectorAll('.radar-map-pin').forEach((pin) => {
            pin.setAttribute('r', (5 / scale).toFixed(2));
        });
    }

    function clampPan(nextScale, nextTx, nextTy) {
        const slack = BRAZIL_MAP_SIZE * 0.4;
        const min = (1 - nextScale) * BRAZIL_MAP_SIZE - slack;
        const max = slack;
        return { tx: Math.min(max, Math.max(min, nextTx)), ty: Math.min(max, Math.max(min, nextTy)) };
    }

    function toSvgPoint(clientX, clientY) {
        const pt = svg.createSVGPoint();
        pt.x = clientX;
        pt.y = clientY;
        const ctm = svg.getScreenCTM();
        if (!ctm) return { x: 0, y: 0 };
        const p = pt.matrixTransform(ctm.inverse());
        return { x: p.x, y: p.y };
    }

    function zoomAt(svgPoint, nextScaleRaw) {
        const nextScale = Math.min(MAP_ZOOM_MAX, Math.max(MAP_ZOOM_MIN, nextScaleRaw));
        // Ponto do desenho (espaço interno do <g>, antes do transform) que
        // está embaixo do cursor/centro do gesto — precisa continuar embaixo
        // dele depois do zoom, senão o mapa "pula".
        const localX = (svgPoint.x - tx) / scale;
        const localY = (svgPoint.y - ty) / scale;
        const nextTx = svgPoint.x - localX * nextScale;
        const nextTy = svgPoint.y - localY * nextScale;
        scale = nextScale;
        ({ tx, ty } = clampPan(scale, nextTx, nextTy));
        applyTransform();
        refreshPinRadii();
    }

    svg.addEventListener('wheel', (e) => {
        e.preventDefault();
        const factor = e.deltaY < 0 ? 1.2 : 1 / 1.2;
        zoomAt(toSvgPoint(e.clientX, e.clientY), scale * factor);
    }, { passive: false });

    document.getElementById('radar-map-zoom-in').addEventListener('click', () => {
        zoomAt(toSvgPoint(...svgCenterClient()), scale * 1.4);
    });
    document.getElementById('radar-map-zoom-out').addEventListener('click', () => {
        zoomAt(toSvgPoint(...svgCenterClient()), scale / 1.4);
    });
    document.getElementById('radar-map-zoom-reset').addEventListener('click', () => {
        scale = 1; tx = 0; ty = 0;
        applyTransform();
        refreshPinRadii();
    });

    function svgCenterClient() {
        const rect = svg.getBoundingClientRect();
        return [rect.left + rect.width / 2, rect.top + rect.height / 2];
    }

    // Arrastar com mouse/caneta/1 dedo; pinça com 2 dedos pra zoom — tudo
    // via Pointer Events (unifica mouse e touch num só conjunto de handlers).
    const activePointers = new Map(); // pointerId -> {x, y} (client)
    let dragStart = null; // { svgX, svgY, tx, ty }
    let pinch = null; // { startDist, startScale, midSvg }

    function pointerDistance() {
        const pts = Array.from(activePointers.values());
        return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    }

    svg.addEventListener('pointerdown', (e) => {
        svg.setPointerCapture(e.pointerId);
        activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        mapDragged = false;
        if (activePointers.size === 2) {
            dragStart = null;
            const pts = Array.from(activePointers.values());
            const midClient = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
            pinch = { startDist: pointerDistance(), startScale: scale, midSvg: toSvgPoint(midClient.x, midClient.y) };
        } else {
            const p = toSvgPoint(e.clientX, e.clientY);
            dragStart = { svgX: p.x, svgY: p.y, tx, ty };
        }
    });

    svg.addEventListener('pointermove', (e) => {
        if (!activePointers.has(e.pointerId)) return;
        activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

        if (activePointers.size === 2 && pinch) {
            const factor = pointerDistance() / pinch.startDist;
            zoomAt(pinch.midSvg, pinch.startScale * factor);
            return;
        }
        if (dragStart) {
            const p = toSvgPoint(e.clientX, e.clientY);
            const dx = p.x - dragStart.svgX;
            const dy = p.y - dragStart.svgY;
            if (Math.hypot(dx, dy) > 2) mapDragged = true;
            ({ tx, ty } = clampPan(scale, dragStart.tx + dx, dragStart.ty + dy));
            applyTransform();
        }
    });

    const endPointer = (e) => {
        activePointers.delete(e.pointerId);
        if (activePointers.size < 2) pinch = null;
        if (activePointers.size === 0) {
            dragStart = null;
            // Só some a flag depois do 'click' (que o navegador dispara logo
            // após o pointerup) já ter checado — senão o clique some junto.
            setTimeout(() => { mapDragged = false; }, 0);
        }
    };
    svg.addEventListener('pointerup', endPointer);
    svg.addEventListener('pointercancel', endPointer);

    return {
        // Ao selecionar uma cidade: some com os outros pinos (depois de
        // escolher, as outras cidades liberadas só competem visualmente com
        // a que importa agora) e centraliza + amplia o mapa nela — sem
        // isso, todas as cidades ficavam visíveis e o mapa no zoom do
        // Brasil inteiro, com o pino escolhido minúsculo.
        selectCityOnMap(cidadeMatch) {
            document.querySelectorAll('.radar-map-pin').forEach((pin) => {
                const isMatch = pin.dataset.cidade === cidadeMatch.cidade && pin.dataset.uf === cidadeMatch.uf;
                pin.classList.toggle('active', isMatch);
                pin.classList.toggle('radar-map-pin-hidden', !isMatch);
            });
            document.querySelectorAll('.radar-map-state').forEach((s) => {
                s.classList.toggle('active', s.dataset.uf === cidadeMatch.uf);
            });
            if (cidadeMatch.lat === null || cidadeMatch.lng === null) return;
            const p = projectLatLng(cidadeMatch.lat, cidadeMatch.lng);
            scale = Math.min(MAP_ZOOM_MAX, Math.max(MAP_ZOOM_MIN, 7));
            ({ tx, ty } = clampPan(scale, BRAZIL_MAP_SIZE / 2 - p.x * scale, BRAZIL_MAP_SIZE / 2 - p.y * scale));
            applyTransform();
            refreshPinRadii();
        },

        // "Limpar filtros" (Buscar tab) — desfaz o filtro acima: todos os
        // pinos de volta, zoom resetado.
        clearFiltro() {
            document.querySelectorAll('.radar-map-pin').forEach((pin) => {
                pin.classList.remove('active', 'radar-map-pin-hidden');
            });
            document.querySelectorAll('.radar-map-state').forEach((s) => s.classList.remove('active'));
            scale = 1; tx = 0; ty = 0;
            applyTransform();
            refreshPinRadii();
        }
    };
}

function renderRadarResults(resultsEl) {
    const segmento = document.getElementById('radar-segmento')?.value.trim().toLowerCase() || '';
    const statusFiltro = document.querySelector('#radar-status-chips .radar-status-chip.active')?.dataset.status || '';

    const porSegmento = segmento
        ? currentClientes.filter((c) =>
            String(c.cnaeDescricao || '').toLowerCase().includes(segmento) ||
            String(c.segmento || '').toLowerCase().includes(segmento) ||
            String(c.cnaeCodigo || '').toLowerCase().includes(segmento))
        : currentClientes;
    // O resumo por status usa o total ANTES do filtro de status (senão só
    // mostraria 100% de um status só) — o filtro de status só afasta a
    // lista de cards abaixo, sem mudar o resumo.
    const filtered = statusFiltro ? porSegmento.filter((c) => c.status === statusFiltro) : porSegmento;

    if (RADAR_EMPRESA_MAP_ENABLED) renderEmpresaMapa(filtered, () => renderRadarResults(resultsEl));

    renderClienteCards(filtered, resultsEl, {
        emptyMessage: 'Nenhuma empresa encontrada.',
        onUpdated: () => renderRadarResults(resultsEl),
        resumoHtml: buildStatusResumo(porSegmento)
    });
}

// Mapa de verdade (Leaflet + tiles da MapTiler) com pins reais por empresa
// — Latitude/Longitude vêm do backfill de geocodificação via CNPJá (ver
// scripts/radar-geocoding-backfill.gs). Só entra empresa com coordenada
// resolvida ("sem_coordenada" e vazio ficam de fora). Cria/destrói a
// instância inteira a cada chamada (troca de cidade, filtro de
// status/segmento) — é simples e evita estado preso de uma instância
// Leaflet presa a um container recriado.
function renderEmpresaMapa(clientes, onUpdated) {
    const wrap = document.getElementById('radar-empresa-map-wrap');
    if (!wrap) return;

    if (empresaMapInstance) {
        empresaMapInstance.remove();
        empresaMapInstance = null;
    }

    // Empresa sem coordenada própria ainda (backfill não chegou nela, ou a
    // CNPJá não tinha o dado) cai na coordenada da CIDADE escolhida em vez
    // de sumir do mapa — aproximado (todo mundo nessa situação cai no
    // mesmo pino, o cluster já resolve isso visualmente), mas melhor que
    // não aparecer. Só funciona se a cidade em si tiver Lat/Lng resolvida
    // (RadarCidadesDisponiveis); senão essas empresas continuam de fora,
    // igual antes.
    const cidadeLat = parseFloat(currentCidade?.lat);
    const cidadeLng = parseFloat(currentCidade?.lng);
    const temCidadeCoord = Number.isFinite(cidadeLat) && Number.isFinite(cidadeLng);

    const pontos = clientes.map((c) => {
        const lat = parseFloat(c.latitude), lng = parseFloat(c.longitude);
        if (Number.isFinite(lat) && Number.isFinite(lng)) return { c, lat, lng, aproximado: false };
        if (temCidadeCoord) return { c, lat: cidadeLat, lng: cidadeLng, aproximado: true };
        return null;
    }).filter(Boolean);

    if (pontos.length === 0) {
        wrap.innerHTML = '';
        return;
    }

    const comCoordenada = pontos.filter((p) => !p.aproximado).length;
    const porCidade = pontos.length - comCoordenada;
    const caption = `${comCoordenada} empresa(s) com localização exata` +
        (porCidade ? ` · ${porCidade} aproximada(s) pela cidade` : '');

    wrap.innerHTML = `
        <div class="card radar-empresa-map-card">
            <div class="radar-empresa-map-leaflet" id="radar-empresa-map-leaflet"></div>
            <p class="field-helper-text radar-empresa-map-caption">${caption}</p>
        </div>
    `;

    const map = L.map('radar-empresa-map-leaflet', { attributionControl: true });
    empresaMapInstance = map;

    L.tileLayer(`https://api.maptiler.com/maps/streets-v2/{z}/{x}/{y}.png?key=${MAPTILER_KEY}`, {
        tileSize: 512,
        zoomOffset: -1,
        maxZoom: 19,
        attribution: '© <a href="https://www.maptiler.com/copyright/" target="_blank">MapTiler</a> © <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap contributors</a>'
    }).addTo(map);

    const clusterGroup = L.markerClusterGroup({
        maxClusterRadius: 50,
        iconCreateFunction: (cluster) => {
            const markers = cluster.getAllChildMarkers();
            // Cor "mais prioritária" entre as empresas do cluster (não é
            // maioria estatística) — 1 buscado + 4 já_atendido continua
            // verde, porque o que importa pro vendedor é "tem oportunidade
            // aqui?", não qual status é mais comum no ponto.
            let best = markers[0].options.radarStatus;
            let bestPriority = STATUS_PRIORITY[best] ?? 9;
            markers.forEach((m) => {
                const pr = STATUS_PRIORITY[m.options.radarStatus] ?? 9;
                if (pr < bestPriority) { bestPriority = pr; best = m.options.radarStatus; }
            });
            return L.divIcon({
                html: `<div class="radar-leaflet-cluster" style="background:${STATUS_HEX[best] || STATUS_HEX.buscado}">${cluster.getChildCount()}</div>`,
                className: '',
                iconSize: L.point(34, 34)
            });
        }
    });

    pontos.forEach(({ c, lat, lng, aproximado }) => {
        // Pin aproximado (coordenada da cidade, não da empresa) fica mais
        // translúscido e com borda tracejada — sinal visual de "não confia
        // nesse ponto pra achar o endereço exato", sem precisar de um
        // segundo texto explicando (o tooltip completa isso no hover).
        const marker = L.circleMarker([lat, lng], {
            radius: aproximado ? 7 : 8,
            fillColor: STATUS_HEX[c.status] || STATUS_HEX.buscado,
            color: aproximado ? 'rgba(255,255,255,0.65)' : '#fff',
            weight: 2,
            fillOpacity: aproximado ? 0.55 : 1,
            dashArray: aproximado ? '2,2' : null,
            radarStatus: c.status
        });
        const nome = escapeHtml(c.nomeFantasia || c.nome || 'Empresa');
        marker.bindTooltip(aproximado ? `${nome} (localização aproximada da cidade)` : nome);
        marker.on('click', () => openRadarDetailCard(c, onUpdated));
        clusterGroup.addLayer(marker);
    });

    map.addLayer(clusterGroup);
    // maxZoom evita esticar demais quando sobra 1 empresa só (fitBounds num
    // ponto único zoom pra rua/quintal, bem mais perto do que faz sentido).
    map.fitBounds(clusterGroup.getBounds(), { padding: [24, 24], maxZoom: 16 });
    map.invalidateSize();
}

// Contagem por status pra dar noção de oportunidade num olhar só (esse é
// literalmente o objetivo do Radar — priorizar quem nunca foi contatado).
function buildStatusResumo(list) {
    if (!list.length) return '';
    const counts = { buscado: 0, ja_atendido: 0, recusado: 0, prospeccao_agendada: 0 };
    list.forEach((c) => { counts[c.status] = (counts[c.status] || 0) + 1; });
    return `<p class="page-subtitle radar-status-resumo" style="margin-bottom:0.5rem">` +
        `${list.length} empresa(s) — ${counts.buscado} nunca contatada(s) · ${counts.ja_atendido} já cliente(s) · ` +
        `${counts.recusado} recusaram · ${counts.prospeccao_agendada} agendada(s)</p>`;
}

function rerenderRadarList() {
    const el = document.getElementById('radar-results');
    if (el) renderRadarResults(el);
}

// Compartilhado entre a aba Buscar e a aba Histórico — mesmo card
// (.proposal-card com status-pill), mesma ordenação por prioridade de
// contato, só muda a lista de entrada e o callback de refresh pós-ação.
function renderClienteCards(list, resultsEl, { emptyMessage, onUpdated, resumoHtml = '' }) {
    if (list.length === 0) {
        resultsEl.innerHTML = `${resumoHtml}<div class="empty-state"><span class="empty-state-icon">🔍</span><p>${escapeHtml(emptyMessage)}</p></div>`;
        return;
    }

    const sorted = [...list].sort((a, b) => (STATUS_PRIORITY[a.status] ?? 9) - (STATUS_PRIORITY[b.status] ?? 9));

    resultsEl.innerHTML = `
        ${resumoHtml || `<p class="page-subtitle" style="margin-bottom:0.5rem">${list.length} empresa(s)</p>`}
        <div class="visits-list">${sorted.map((c) => `
            <button type="button" class="radar-cliente-card${reservaAtiva(c) ? ' radar-cliente-card-reservado' : ''}" data-radar-id="${escapeHtml(c.id)}">
                <div class="radar-cliente-header">
                    <strong>${escapeHtml(c.nomeFantasia || c.nome || 'Empresa')}</strong>
                    <span class="${STATUS_CLASSES[c.status] || 'status-pill'}">${escapeHtml(STATUS_LABELS[c.status] || c.status)}</span>
                </div>
                ${c.nomeFantasia && c.nome && c.nomeFantasia !== c.nome ? `<div class="radar-cliente-meta"><span>${escapeHtml(c.nome)}</span></div>` : ''}
                <div class="radar-cliente-meta">
                    ${c.telefone ? `<span>📞 ${escapeHtml(c.telefone)}</span>` : ''}
                    <span>${escapeHtml(cidadeLabel(c))}</span>
                </div>
                ${c.status === 'recusado' && c.statusRetornoPrevisto
                    ? `<div class="radar-cliente-meta"><span>Retornar em: ${escapeHtml(c.statusRetornoPrevisto)}</span></div>`
                    : ''}
                ${c.status === 'recusado' && c.statusPor
                    ? `<div class="radar-cliente-meta"><span>Recusado por ${escapeHtml(c.statusPor)}${c.statusData ? ' em ' + escapeHtml(c.statusData) : ''}</span></div>`
                    : ''}
                ${c.status === 'ja_atendido' && c.statusPor
                    ? `<div class="radar-cliente-meta"><span>Marcado como cliente por ${escapeHtml(c.statusPor)}${c.statusData ? ' em ' + escapeHtml(c.statusData) : ''}</span></div>`
                    : ''}
                ${reservaAtiva(c)
                    ? `<div class="radar-cliente-meta radar-reserva-tag"><span>🔒 Reservado por ${escapeHtml(c.reservadoPor)} até ${escapeHtml(c.reservadoAte)}</span></div>`
                    : ''}
            </button>
        `).join('')}</div>
    `;

    resultsEl.querySelectorAll('[data-radar-id]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const cliente = list.find((c) => String(c.id) === btn.dataset.radarId);
            if (cliente) openRadarDetailCard(cliente, onUpdated);
        });
    });
}

function updateHistoricoScopeLabel() {
    const label = document.getElementById('radar-historico-scope-label');
    const btn = document.getElementById('radar-historico-scope-btn');
    if (!label || !btn) return;
    if (historicoScopeAll) {
        label.textContent = 'Mostrando empresas de todas as cidades.';
        btn.style.display = 'none';
    } else if (currentCidade) {
        label.textContent = `Mostrando empresas de ${cidadeLabel(currentCidade)}.`;
        btn.style.display = '';
    } else {
        label.textContent = 'Escolha uma cidade na aba Buscar, ou veja todas as cidades.';
        btn.style.display = '';
    }
}

async function loadHistorico() {
    updateHistoricoScopeLabel();
    const statusSelect = document.getElementById('radar-historico-status');
    statusSelect?.addEventListener('change', () => renderHistoricoResults());
    document.getElementById('radar-historico-scope-btn')?.addEventListener('click', async () => {
        historicoScopeAll = true;
        updateHistoricoScopeLabel();
        const resultsEl = document.getElementById('radar-historico-results');
        resultsEl.innerHTML = loadingState('📡', 'Carregando todas as cidades...');
        const result = await callAPI('getRadarClientes', { user: state.currentUser, scope: 'all' });
        if (result.status !== 'success') {
            resultsEl.innerHTML = `<p class="error-message">${escapeHtml(result.message || 'Erro ao buscar empresas.')}</p>`;
            return;
        }
        historicoClientes = result.clientes || [];
        renderHistoricoResults();
    });
    renderHistoricoResults();
}

function renderHistoricoResults() {
    const resultsEl = document.getElementById('radar-historico-results');
    if (!resultsEl) return;
    const source = historicoScopeAll ? historicoClientes : currentClientes;

    if (!historicoScopeAll && !currentCidade) {
        resultsEl.innerHTML = `<div class="empty-state"><span class="empty-state-icon">🕘</span><p>Nenhuma cidade selecionada ainda.</p></div>`;
        return;
    }

    const status = document.getElementById('radar-historico-status')?.value || 'todos';
    const filtered = status === 'todos' ? source : source.filter((c) => c.status === status);

    renderClienteCards(filtered, resultsEl, {
        emptyMessage: 'Nenhuma empresa encontrada.',
        onUpdated: () => renderHistoricoResults()
    });
}

async function loadSolicitacoes() {
    const listEl = document.getElementById('radar-solicitacoes-list');
    if (!listEl) return;
    const result = await callAPI('getRadarSolicitacoesCidade', { user: state.currentUser });
    if (result.status !== 'success') {
        listEl.innerHTML = `<p class="error-message">${escapeHtml(result.message || 'Erro ao carregar solicitações.')}</p>`;
        return;
    }
    const solicitacoes = result.solicitacoes || [];
    if (solicitacoes.length === 0) {
        listEl.innerHTML = `<p class="page-subtitle">Nenhuma solicitação pendente.</p>`;
        return;
    }
    listEl.innerHTML = `
        <div class="visits-list">${solicitacoes.map((s) => `
            <div class="proposal-card" style="cursor:default">
                <div class="visit-card-header">
                    <strong>${escapeHtml(s.uf ? `${s.cidadeSolicitada} - ${s.uf}` : s.cidadeSolicitada)}</strong>
                    ${s.urgente ? '<span class="status-pill radar-status-recusado">Urgente</span>' : ''}
                </div>
                <div class="proposal-meta">
                    <span>Solicitado por ${escapeHtml(s.solicitadoPor || '-')}</span>
                    <span>${escapeHtml(s.dataSolicitacao || '-')}</span>
                </div>
            </div>
        `).join('')}</div>
    `;
}

// Bloco D1 — quem está usando o Radar (1 linha por usuário, ver
// handleRegistrarAcessoRadar/handleGetRadarAcessos). Filtrado por perfil
// já vem pronto do backend (vendedor só a própria linha, gerente a
// equipe, admin tudo).
async function loadAcessos() {
    const el = document.getElementById('radar-acessos-results');
    if (!el) return;
    // Sem try/catch, uma falha de rede/timeout deixava a tela presa em
    // "Carregando..." pra sempre — o erro nunca chegava a substituir o
    // placeholder inicial do template.
    let result;
    try {
        result = await callAPI('getRadarAcessos', { user: state.currentUser });
    } catch (e) {
        el.innerHTML = `<p class="error-message">Erro ao carregar acessos: ${escapeHtml(e.message || 'falha de conexão')}.</p>`;
        return;
    }
    if (result.status !== 'success') {
        el.innerHTML = `<p class="error-message">${escapeHtml(result.message || 'Erro ao carregar acessos.')}</p>`;
        return;
    }
    const acessos = result.acessos || [];
    if (acessos.length === 0) {
        el.innerHTML = `<div class="empty-state"><span class="empty-state-icon">📋</span><p>Nenhum acesso registrado ainda.</p></div>`;
        return;
    }
    const totalAcessosSoma = acessos.reduce((sum, a) => sum + (a.totalAcessos || 0), 0);
    el.innerHTML = `
        <div class="radar-print-header">
            <h2>Acessos — Radar de Clientes</h2>
            <p>Gerado por ${escapeHtml(state.currentUser?.name || '')} em ${new Date().toLocaleDateString('pt-BR')}</p>
        </div>
        <div class="report-section">
            <h3>👥 Quem usa o Radar</h3>
            <div class="report-kpi-row">
                <div class="report-kpi"><strong>${acessos.length}</strong><span>Usuário(s)</span></div>
                <div class="report-kpi"><strong>${totalAcessosSoma}</strong><span>Acessos no total</span></div>
            </div>
        </div>
        <div class="visits-list">${acessos.map((a) => `
            <div class="proposal-card" style="cursor:default">
                <div class="visit-card-header">
                    <strong>${escapeHtml(a.nome || a.email)}</strong>
                    <span class="status-pill">${a.totalAcessos} acesso(s)</span>
                </div>
                <div class="proposal-meta">
                    <span>${escapeHtml(a.gerencia || '-')}</span>
                    <span>Último: ${escapeHtml(a.ultimoAcesso || '-')}</span>
                </div>
            </div>
        `).join('')}</div>
    `;
}

// Bloco D2 — retrato da base (total, quebra por status/segmento — igual
// pra todo mundo) + quem está reservado com o quê agora (filtrado por
// perfil, ver handleGetRadarPanorama).
async function loadPanorama() {
    const el = document.getElementById('radar-panorama-results');
    if (!el) return;
    let result;
    try {
        result = await callAPI('getRadarPanorama', { user: state.currentUser });
    } catch (e) {
        el.innerHTML = `<p class="error-message">Erro ao carregar o panorama: ${escapeHtml(e.message || 'falha de conexão')}.</p>`;
        return;
    }
    if (result.status !== 'success') {
        el.innerHTML = `<p class="error-message">${escapeHtml(result.message || 'Erro ao carregar o panorama.')}</p>`;
        return;
    }
    const totalEmpresas = result.totalEmpresas || 0;
    const porStatus = result.porStatus || {};
    const segmentos = result.segmentos || [];
    const totalTrabalhando = result.totalTrabalhando || 0;
    const reservas = result.reservas || [];

    el.innerHTML = `
        <div class="radar-print-header">
            <h2>Panorama — Radar de Clientes</h2>
            <p>Gerado por ${escapeHtml(state.currentUser?.name || '')} em ${new Date().toLocaleDateString('pt-BR')}</p>
        </div>
        <div class="report-section">
            <h3>📊 Base de empresas</h3>
            <div class="report-kpi-row">
                <div class="report-kpi"><strong>${totalEmpresas}</strong><span>Empresas na base</span></div>
                <div class="report-kpi${totalTrabalhando ? ' report-kpi-alert' : ''}"><strong>${totalTrabalhando}</strong><span>Em prospecção agora</span></div>
            </div>
            <p class="report-subtitle">Por status</p>
            <div class="report-bar-list">
                ${Object.entries(STATUS_LABELS).map(([value, label]) =>
                    reportBar(label, porStatus[value] || 0, totalEmpresas, STATUS_HEX[value])
                ).join('')}
            </div>
        </div>
        <div class="report-section">
            <h3>🏷️ Segmentos${segmentos.length ? ` (top ${segmentos.length})` : ''}</h3>
            ${segmentos.length ? `
                <div class="report-bar-list">${segmentos.map((s) => reportBar(s.segmento, s.total, totalEmpresas)).join('')}</div>
            ` : `<p class="page-subtitle">Sem dados de segmento ainda.</p>`}
        </div>
        <div class="report-section">
            <h3>🔒 Quem está trabalhando agora</h3>
            <div class="report-kpi-row">
                <div class="report-kpi"><strong>${reservas.length}</strong><span>Reserva(s) ativa(s)</span></div>
            </div>
            ${reservas.length ? `
                <div class="visits-list">${reservas.map((r) => `
                    <div class="proposal-card" style="cursor:default">
                        <div class="visit-card-header">
                            <strong>${escapeHtml(r.nome || 'Empresa')}</strong>
                            <span class="${STATUS_CLASSES[r.status] || 'status-pill'}">${escapeHtml(STATUS_LABELS[r.status] || r.status)}</span>
                        </div>
                        <div class="proposal-meta">
                            <span>${escapeHtml(r.reservadoPor || '-')}</span>
                            <span>${escapeHtml(cidadeLabel(r))} · até ${escapeHtml(r.reservadoAte || '-')}</span>
                        </div>
                    </div>
                `).join('')}</div>
            ` : `<p class="page-subtitle">Nenhuma reserva ativa no momento.</p>`}
        </div>
    `;
}

// Mesma fórmula/estrutura de reportBar (report.js) — duplicada de
// propósito em vez de importada: são páginas sem relação nenhuma, uma
// dependência cruzada só pra uma função de 3 linhas não compensa. Cor
// opcional (sem ela, cai no azul padrão de --primary via .report-bar-fill).
function reportBar(label, value, total, color) {
    const pct = total ? Math.round((value / total) * 100) : 0;
    return `
        <div class="report-bar-row">
            <span class="report-bar-label">${escapeHtml(label)}</span>
            <div class="report-bar-track"><div class="report-bar-fill" style="width:${pct}%${color ? ';background:' + color : ''}"></div></div>
            <span class="report-bar-value">${value}</span>
        </div>
    `;
}

// Junta Endereco/Numero/Complemento/Bairro/Cep (colunas separadas na
// planilha, fiel ao CSV) numa única linha legível pro card de detalhe.
function formatEndereco(c) {
    const parts = [];
    if (c.endereco) parts.push(c.numero ? `${c.endereco}, ${c.numero}` : c.endereco);
    if (c.complemento) parts.push(c.complemento);
    if (c.bairro) parts.push(c.bairro);
    if (c.cep) parts.push(`CEP ${c.cep}`);
    return parts.join(' - ');
}

// Porte/CapitalSocial vêm da CNPJá (ver scripts/radar-geocoding-backfill.gs)
// — nem sempre presentes (empresa pode já ter sido geocodificada antes
// desses 2 campos existirem, ou a CNPJá pode não ter o dado).
function formatPorteCapital(c) {
    const parts = [];
    if (c.porte) parts.push(c.porte);
    const capital = Number(c.capitalSocial);
    if (c.capitalSocial && !Number.isNaN(capital)) {
        parts.push('Capital social: ' + capital.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 }));
    }
    return parts.join(' · ');
}

// XX.XXX.XXX/XXXX-XX — só formatação visual pro card; o valor salvo
// continua só dígitos (é a chave de dedup da importação de CSV). 13
// dígitos (em vez de 14) é sinal de zero à esquerda comido — mesmo tipo de
// bug já visto nessa sessão (Sheets convertendo a célula pra número em vez
// de manter texto); reconstrói o zero antes de formatar.
function formatCnpj(cnpj) {
    let d = String(cnpj || '').replace(/\D/g, '');
    // Sheets pode ter comido mais de 1 zero à esquerda (visto na prática:
    // um CNPJ apareceu com só 12 dígitos, não 13) — completa com zero até
    // 14 em vez de tratar só o caso de faltar exatamente 1.
    if (d.length > 0 && d.length < 14) d = d.padStart(14, '0');
    if (d.length !== 14) return cnpj || '';
    return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12, 14)}`;
}

// Link direto pro Google Maps a partir do endereço já formatado — esquema
// de URL público do Google (não precisa de chave de API), abre o app no
// celular (se instalado) ou maps.google.com no navegador.
function googleMapsUrl(endereco) {
    return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(endereco);
}

// CNPJ "ATIVA" é o normal, sem destaque — qualquer outra coisa (BAIXADA,
// INAPTA, SUSPENSA, NULA) é sinal de alerta pro vendedor não perder tempo
// prospectando uma empresa que talvez nem exista mais.
function situacaoAlerta(situacao) {
    const s = String(situacao || '').trim().toUpperCase();
    return s !== '' && s !== 'ATIVA';
}

function openRadarDetailCard(cliente, onUpdated) {
    const refresh = onUpdated || rerenderRadarList;
    const endereco = formatEndereco(cliente);
    const bloqueada = reservaAtivaDeOutro(cliente);
    const temReserva = reservaAtiva(cliente);
    const porteCapital = formatPorteCapital(cliente);
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
        <div class="modal-card" style="text-align:left;position:relative">
            <button type="button" class="radar-modal-close" id="radar-btn-fechar" aria-label="Fechar">×</button>
            <h3 style="margin-top:0;padding-right:1.5rem">${escapeHtml(cliente.nomeFantasia || cliente.nome || 'Empresa')}</h3>
            ${cliente.nomeFantasia && cliente.nome && cliente.nomeFantasia !== cliente.nome
                ? `<p class="helper-text" style="margin:0 0 0.5rem;text-align:left">${escapeHtml(cliente.nome)}</p>` : ''}
            ${cliente.cnpj ? `<p class="helper-text" style="text-align:left;margin:0 0 0.25rem">${escapeHtml(formatCnpj(cliente.cnpj))}</p>` : ''}
            ${cliente.situacaoCadastral ? `<p class="helper-text" style="text-align:left;margin:0 0 0.25rem${situacaoAlerta(cliente.situacaoCadastral) ? ';color:#b91c1c;font-weight:600' : ''}">${escapeHtml(cliente.situacaoCadastral)}</p>` : ''}
            <p class="helper-text" style="text-align:left;margin:0 0 0.25rem">${escapeHtml(cidadeLabel(cliente))}</p>
            <p class="helper-text" style="text-align:left;margin:0 0 0.25rem">${escapeHtml(cliente.cnaeDescricao || '-')}${cliente.cnaeCodigo ? ` (${escapeHtml(cliente.cnaeCodigo)})` : ''}</p>
            ${cliente.segmento ? `<p class="helper-text" style="text-align:left;margin:0 0 0.25rem">${escapeHtml(cliente.segmento)}</p>` : ''}
            ${porteCapital ? `<p class="helper-text" style="text-align:left;margin:0 0 0.25rem">${escapeHtml(porteCapital)}</p>` : ''}
            ${cliente.dataAbertura ? `<p class="helper-text" style="text-align:left;margin:0 0 0.25rem">Aberta em ${escapeHtml(cliente.dataAbertura)}</p>` : ''}
            ${endereco ? `<p class="helper-text" style="text-align:left;margin:0 0 0.25rem">📍 <a href="${googleMapsUrl(endereco)}" target="_blank" rel="noopener">${escapeHtml(endereco)}</a></p>` : ''}
            ${cliente.telefone ? `<p class="helper-text" style="text-align:left;margin:0 0 0.25rem">📞 <a href="tel:${escapeHtml(cliente.telefone.replace(/\D/g, ''))}">${escapeHtml(cliente.telefone)}</a></p>` : ''}
            ${cliente.email ? `<p class="helper-text" style="text-align:left;margin:0 0 0.25rem">✉️ <a href="mailto:${escapeHtml(cliente.email)}">${escapeHtml(cliente.email)}</a></p>` : ''}
            ${cliente.dataBusca ? `<p class="helper-text" style="text-align:left;margin:0 0 0.85rem;font-size:0.78rem;opacity:0.8">Dados consultados em ${escapeHtml(cliente.dataBusca)}</p>` : ''}
            <span class="${STATUS_CLASSES[cliente.status] || 'status-pill'}" style="margin-bottom:1rem;display:inline-block">${escapeHtml(STATUS_LABELS[cliente.status] || cliente.status)}</span>
            ${cliente.status === 'recusado' && cliente.statusPor
                ? `<p class="helper-text" style="text-align:left;margin:0 0 0.5rem">Recusado por ${escapeHtml(cliente.statusPor)}${cliente.statusData ? ' em ' + escapeHtml(cliente.statusData) : ''}</p>` : ''}
            ${cliente.status === 'recusado' && cliente.statusMotivo
                ? `<p class="helper-text" style="text-align:left;margin:0 0 0.5rem">Motivo: ${escapeHtml(cliente.statusMotivo)}</p>` : ''}
            ${cliente.status === 'recusado' && cliente.statusRetornoPrevisto
                ? `<p class="helper-text" style="text-align:left;margin:0 0 0.5rem">Retornar em: ${escapeHtml(cliente.statusRetornoPrevisto)}</p>` : ''}
            ${cliente.status === 'ja_atendido' && cliente.statusPor
                ? `<p class="helper-text" style="text-align:left;margin:0 0 0.5rem">Marcado como cliente por ${escapeHtml(cliente.statusPor)}${cliente.statusData ? ' em ' + escapeHtml(cliente.statusData) : ''}</p>` : ''}
            ${temReserva
                ? `<p class="radar-reserva-aviso">🔒 Reservado por ${escapeHtml(cliente.reservadoPor)} até ${escapeHtml(cliente.reservadoAte)}${bloqueada ? ` — só ${escapeHtml(cliente.reservadoPor)} pode agir nessa empresa até lá.` : '.'}</p>`
                : ''}
            <div class="form-actions" style="flex-direction:row;gap:0.5rem;margin-top:0.5rem">
                <button type="button" class="primary-button${bloqueada ? ' radar-action-disabled' : ''}" style="width:auto;flex:1;margin-top:0" id="radar-btn-atendido" ${bloqueada ? 'disabled' : ''}>Já é atendido</button>
                <button type="button" class="mini-button-danger${bloqueada ? ' radar-action-disabled' : ''}" style="width:auto;flex:1;margin-top:0;padding:0.7rem;border-radius:var(--radius-sm);background:#fef2f2;color:#b91c1c;border:1.5px solid #fecaca" id="radar-btn-recusou" ${bloqueada ? 'disabled' : ''}>Recusou</button>
            </div>
            <div class="form-actions" style="flex-direction:column;gap:0.5rem;margin-top:0.5rem">
                <button type="button" class="secondary-button${bloqueada ? ' radar-action-disabled' : ''}" id="radar-btn-agendar" ${bloqueada ? 'disabled' : ''}>Agendar prospecção</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    overlay.querySelector('#radar-btn-fechar').addEventListener('click', close);

    overlay.querySelector('#radar-btn-atendido').addEventListener('click', async () => {
        const btn = overlay.querySelector('#radar-btn-atendido');
        setSaving(true, btn, 'Salvando...');
        const result = await callAPI('updateRadarClienteStatus', { user: state.currentUser, id: cliente.id, status: 'ja_atendido' });
        if (result.status === 'success') {
            cliente.status = 'ja_atendido';
            cliente.statusPor = state.currentUser.name;
            cliente.statusData = formatDateForDisplay(new Date());
            showToast('Marcado como já atendido.');
            close();
            refresh();
        } else {
            showToast(result.message || 'Não foi possível atualizar.', true);
            setSaving(false, btn);
        }
    });

    overlay.querySelector('#radar-btn-recusou').addEventListener('click', () => {
        close();
        openRecusarModal(cliente, refresh);
    });

    overlay.querySelector('#radar-btn-agendar').addEventListener('click', () => {
        close();
        // Razão social identifica a empresa de verdade — Nome Fantasia às
        // vezes é só o nome do local (ex.: agências de banco cujo "Nome
        // Fantasia" é literalmente a cidade, tipo "MARILIA (SP)"), o que
        // deixa o campo Cliente da visita parecendo o nome de uma cidade
        // em vez de uma empresa.
        navigateTo('visit-new', {
            prefill: { Cliente: cliente.nome || cliente.nomeFantasia, Cidade: cliente.cidade },
            radarClienteId: cliente.id
        });
    });
}

function openRecusarModal(cliente, refresh) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
        <div class="modal-card" style="text-align:left">
            <h3 style="margin-top:0">Recusou / não quer</h3>
            <p class="helper-text" style="text-align:left">${escapeHtml(cliente.nomeFantasia || cliente.nome || '')}</p>
            <div class="form-group full-width">
                <label for="radar-motivo">Motivo (opcional)</label>
                <textarea id="radar-motivo" rows="3" placeholder="Ex: já tem fornecedor, não teve interesse..."></textarea>
            </div>
            <div class="form-group full-width">
                <label for="radar-retorno">Retornar em (opcional)</label>
                <input type="date" id="radar-retorno">
                <div style="display:flex;gap:0.4rem;margin-top:0.4rem">
                    <button type="button" class="mini-button" data-shortcut="3">+3 meses</button>
                    <button type="button" class="mini-button" data-shortcut="6">+6 meses</button>
                </div>
            </div>
            <div class="form-actions">
                <button type="button" class="secondary-button" id="radar-recusar-cancelar">Cancelar</button>
                <button type="button" class="primary-button" id="radar-recusar-salvar">Salvar</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    overlay.querySelector('#radar-recusar-cancelar').addEventListener('click', close);
    overlay.querySelectorAll('[data-shortcut]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const months = Number(btn.dataset.shortcut);
            const d = new Date();
            d.setMonth(d.getMonth() + months);
            document.getElementById('radar-retorno').value = d.toISOString().slice(0, 10);
        });
    });

    overlay.querySelector('#radar-recusar-salvar').addEventListener('click', async () => {
        const btn = overlay.querySelector('#radar-recusar-salvar');
        setSaving(true, btn, 'Salvando...');
        const motivo = document.getElementById('radar-motivo').value.trim();
        const retorno = document.getElementById('radar-retorno').value;
        const result = await callAPI('updateRadarClienteStatus', {
            user: state.currentUser, id: cliente.id, status: 'recusado', motivo, retornoPrevisto: retorno || undefined
        });
        if (result.status === 'success') {
            cliente.status = 'recusado';
            cliente.statusPor = state.currentUser.name;
            cliente.statusData = formatDateForDisplay(new Date());
            showToast('Marcado como recusado.');
            close();
            refresh();
        } else {
            showToast(result.message || 'Não foi possível atualizar.', true);
            setSaving(false, btn);
        }
    });
}

function openSolicitarCidadeModal() {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
        <div class="modal-card" style="text-align:left">
            <h3 style="margin-top:0">Solicitar cidade</h3>
            <div class="form-group full-width">
                <label for="radar-sol-cidade">Cidade *</label>
                <input type="text" id="radar-sol-cidade" placeholder="Nome da cidade">
            </div>
            <div class="form-group full-width">
                <label for="radar-sol-uf">UF</label>
                <input type="text" id="radar-sol-uf" placeholder="Ex: SP" maxlength="2" style="text-transform:uppercase">
            </div>
            <label style="display:flex;align-items:center;gap:0.5rem;font-size:0.87rem;cursor:pointer;margin-bottom:0.5rem">
                <input type="checkbox" id="radar-sol-urgente" style="width:auto">
                Urgente
            </label>
            <div class="form-actions">
                <button type="button" class="secondary-button" id="radar-sol-cancelar">Cancelar</button>
                <button type="button" class="primary-button" id="radar-sol-salvar">Enviar</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    overlay.querySelector('#radar-sol-cancelar').addEventListener('click', close);
    overlay.querySelector('#radar-sol-salvar').addEventListener('click', async () => {
        const btn = overlay.querySelector('#radar-sol-salvar');
        const cidade = document.getElementById('radar-sol-cidade').value.trim();
        if (!cidade) { showToast('Informe a cidade.', true); return; }
        setSaving(true, btn, 'Enviando...');
        const uf = document.getElementById('radar-sol-uf').value.trim();
        const urgente = document.getElementById('radar-sol-urgente').checked;
        const result = await callAPI('createRadarSolicitacaoCidade', { user: state.currentUser, cidade, uf, urgente });
        if (result.status === 'success') {
            showToast('Solicitação enviada.');
            close();
        } else {
            showToast(result.message || 'Não foi possível enviar a solicitação.', true);
            setSaving(false, btn);
        }
    });
}
