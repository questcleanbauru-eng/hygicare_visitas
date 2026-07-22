/**
 * Backfill de geocodificação + enriquecimento por empresa (RadarClientes)
 * via CNPJá.
 *
 * NÃO faz parte do app (não é Node, não builda, não sobe pro Vercel) — é
 * um script do Google Apps Script, roda direto na planilha. Só está aqui
 * no repositório por registro/histórico.
 *
 * Suporta até 5 chaves da CNPJá (ex.: 5 contas grátis diferentes, 50
 * créditos cada) — NÃO usa uma até esgotar pra só então passar pra
 * próxima; gira em rodízio entre todas desde a primeira chamada (ver
 * RATE LIMIT abaixo), passando pra próxima sozinho só quando uma esgota
 * a cota do mês ou está temporariamente de fora por rate limit.
 *
 * Cada chamada já traz nome/endereço/telefone/CNAE — redundante com o
 * que o CSV já importa, então só aproveita o que é novo: geocodificação
 * (Latitude/Longitude), e-mail (Email), porte da empresa (Porte) e
 * capital social (CapitalSocial). Sócios e atividades secundárias ficam
 * de fora de propósito (ver discussão no chat sobre o schema completo).
 *
 * COMO INSTALAR
 * 1. Abra a planilha do App de Visitas no navegador.
 * 2. Extensões → Apps Script.
 * 3. Apague o conteúdo padrão de Code.gs e cole este arquivo inteiro.
 * 4. SÓ NA PRIMEIRA VEZ: rode `configurarChavesApi` (edite as chaves
 *    antes — pode deixar só a 1ª preenchida se só tiver uma conta por
 *    enquanto). As chaves ficam guardadas no PROJETO (Script
 *    Properties), separado do código — atualizar o script depois (ex.:
 *    colar uma versão nova que eu mandar) NUNCA apaga isso. Só precisa
 *    rodar essa função de novo se for trocar ou adicionar uma chave.
 * 5. Rode `testarUmaEmpresa` — confere se a 1ª chave/autenticação estão
 *    certas usando o CNPJ que já apareceu no print que você me mandou
 *    (Banco do Brasil, Manaus — devia devolver lat -3.079897, lng
 *    -60.026557). Se der erro 401/403, o formato do header de
 *    autenticação abaixo (ver montarHeaderAuth_) provavelmente está
 *    errado — confere na "Referência da API" da CNPJá.
 * 6. Na aba Configurações do Radar (dentro do app), ajuste "Limite
 *    mensal de geocodificação" pra 50 × quantas chaves você configurou
 *    (ex.: 250 pra 5 contas grátis) — senão o limite geral para o
 *    processo antes de usar as contas extras.
 * 7. Só depois de validar os passos 5 e 6, rode
 *    `iniciarBackfillGeocodificacao`. Processa em lotes de ~5min (limite
 *    do Apps Script é 6min por execução) e se reagenda sozinho via
 *    trigger até acabar; você pode fechar a aba, não precisa ficar
 *    olhando.
 *
 * COMO FUNCIONA A RETOMADA (por empresa)
 * Cada linha da planilha guarda seu próprio estado na coluna Latitude
 * (Longitude/Email/Porte/CapitalSocial são criadas junto, mas quem
 * decide se já tentou é só a Latitude — os outros 4 vêm da MESMA
 * chamada):
 *   - vazio       → ainda não tentou
 *   - número      → geocodificado com sucesso
 *   - "sem_coordenada" → a CNPJá respondeu mas não tinha coordenada pra
 *     esse endereço (não tenta de novo sozinho — evita gastar crédito à
 *     toa numa empresa que provavelmente vai continuar sem coordenada)
 * Email/Porte/CapitalSocial só são gravados quando vêm preenchidos —
 * pode ficar vazio numa empresa mesmo já processada, se a CNPJá
 * simplesmente não tinha esse dado específico.
 * Erro de rede/API NÃO marca a linha — ela fica vazia e entra de novo na
 * próxima passada. Rodar o backfill de novo mais tarde (ex.: depois de
 * importar CSV novo) só processa quem ainda está vazio.
 *
 * COMO FUNCIONA A ROTAÇÃO DE CHAVES
 * Cada chave tem uma cota mensal própria (CREDITOS_POR_CHAVE, padrão 50)
 * controlada aqui dentro (Script Properties, não na planilha — é detalhe
 * interno, a aba Configurações do Radar só mostra o total combinado). Ao
 * escolher qual chave usar pra próxima empresa, pula quem já bateu a
 * cota. Se uma chave der 3 erros "de verdade" seguidos (ex.: chave
 * inválida — rate limit NÃO conta pra isso, ver abaixo), ela é
 * descartada só pro resto desse lote — as outras continuam normalmente.
 *
 * RATE LIMIT (por chave, visto na prática — não documentado pela CNPJá)
 * ~10 chamadas por 60s antes da CNPJá responder 429. As chamadas giram em
 * rodízio entre as chaves configuradas (não sempre a mesma), e o
 * espaçamento entre elas se ajusta ao número de chaves — com 5 chaves
 * ativas, cada uma recebe só 1 chamada a cada 5, então processa ~5x mais
 * rápido que com 1 chave só, sem violar o limite de nenhuma. Se mesmo
 * assim vier um 429, só ESSA chave fica de fora pelo tempo que a própria
 * CNPJá mandou (ttl) — não descarta ela nem para o script, as outras
 * continuam normalmente.
 *
 * CUSTO
 * O contador interno (Limite mensal de geocodificação, ConfigEmail) soma 1
 * por linha nova processada (sucesso ou sem_coordenada), só como
 * referência pro admin acompanhar — mas o custo REAL por chamada com
 * geocoding=true, segundo a própria CNPJá, pode ser maior que 1 (visto na
 * prática: erro "not enough credits" veio com "required":2). Por isso o
 * script não depende só desse contador pra saber quando uma chave esgotou:
 * confia no sinal direto da resposta da CNPJá (ver "not enough credits" em
 * buscarGeocodificacao_), que reflete o saldo real da conta.
 */

// ===== CONFIGURAÇÃO =====
const SHEET_NAME = 'RadarClientes';
const BATCH_TIME_LIMIT_MS = 5 * 60 * 1000; // folga dentro do limite de 6min do Apps Script
// Base do espaçamento entre chamadas (visto na prática: a CNPJá deixa
// ~10/60s por chave antes de responder 429; 6500ms = ~9,2/60s, com
// folga). O delay REAL usado em processarLote_ divide isso pelo número
// de chaves ativas — com rodízio entre elas, cada chave individual
// continua recebendo uma chamada só a cada ~6500ms, mesmo rodando mais
// rápido no total.
const DELAY_BASE_MS = 6500;
const TRIGGER_HANDLER = 'processarLote_';
const MAX_CHAVES = 5;
const CREDITOS_POR_CHAVE = 50; // cota grátis de cada conta CNPJá — ajuste aqui se alguma virar paga

// A aba Configurações do Radar (dentro do app) lê esses 3 valores da
// ConfigEmail pra mostrar progresso pro admin — o app nunca escreve
// neles, só esse script. "limite" é editável ali; "usado"/"mês" são só
// pra esse script atualizar.
const CONFIG_SHEET_NAME = 'ConfigEmail';
const CONFIG_KEY_LIMITE = 'radar_geocoding_limite_mensal';
const CONFIG_KEY_USADO = 'radar_geocoding_usado_mes';
const CONFIG_KEY_MES = 'radar_geocoding_mes_referencia';

// Formato do header de autenticação — CONFERIR na "Referência da API" da
// CNPJá antes de rodar o backfill de verdade (testarUmaEmpresa serve
// exatamente pra isso). Chute inicial: header "Authorization" com o
// token puro, sem prefixo "Bearer".
function montarHeaderAuth_(chave) {
    return { 'Authorization': chave };
}

// ===== SETUP (só na 1ª vez, ou pra trocar/adicionar chave) =====
// As chaves ficam guardadas no PROJETO (Script Properties), separado do
// código do arquivo — colar uma versão nova do script por cima NUNCA
// apaga isso. Não precisa rodar essa função de novo só porque atualizou
// o script; só se for trocar ou adicionar uma chave de verdade.

const PLACEHOLDER_CHAVE_ = 'COLE_A_CHAVE_DA_CONTA_';

function configurarChavesApi() {
    const chaves = [
        'COLE_A_CHAVE_DA_CONTA_1_AQUI',
        '', // conta 2 — deixe '' se não tiver ainda
        '', // conta 3
        '', // conta 4
        ''  // conta 5
    ];
    const props = PropertiesService.getScriptProperties();
    let salvasNessaChamada = 0;
    chaves.forEach((chave, i) => {
        // Ignora placeholder esquecido e string vazia — rodar essa função
        // sem editar o array (ex.: só porque colou uma versão nova do
        // script) fica um no-op seguro, nunca apaga uma chave já salva.
        if (chave && chave.indexOf(PLACEHOLDER_CHAVE_) !== 0) {
            props.setProperty('CNPJA_API_KEY_' + (i + 1), chave);
            salvasNessaChamada++;
        }
    });
    let totalSalvo = 0;
    for (let i = 1; i <= MAX_CHAVES; i++) {
        if (props.getProperty('CNPJA_API_KEY_' + i)) totalSalvo++;
    }
    Logger.log(salvasNessaChamada + ' chave(s) nova(s)/atualizada(s) nessa chamada — total salvo no ' +
        'projeto agora: ' + totalSalvo + '. Lembre de ajustar "Limite mensal de geocodificação" na aba ' +
        'Configurações do Radar (dentro do app) pra ' + (totalSalvo * CREDITOS_POR_CHAVE) + ' (= ' +
        totalSalvo + ' conta(s) × ' + CREDITOS_POR_CHAVE + ' créditos grátis cada).');
}

function testarUmaEmpresa() {
    const chaves = obterChaves_();
    const resultado = buscarGeocodificacao_('07526557011659', chaves[0].chave); // Banco do Brasil, Manaus — CNPJ do print
    Logger.log(JSON.stringify(resultado));
}

// Diagnóstico em camadas — roda ISSO primeiro quando o erro for genérico
// demais pra saber onde travou (ex.: "Ocorreu um erro desconhecido. Tente
// novamente mais tarde." não diz se o problema é o projeto inteiro, o
// Script Properties, a rede, ou especificamente a CNPJá). Cada etapa loga
// OK ou o erro exato antes de tentar a próxima.
function diagnosticoBasico() {
    Logger.log('Etapa 1/4: script rodando — OK.');

    try {
        const props = PropertiesService.getScriptProperties();
        const chave1 = props.getProperty('CNPJA_API_KEY_1');
        Logger.log('Etapa 2/4: Script Properties OK — CNPJA_API_KEY_1 ' +
            (chave1 ? ('presente, ' + chave1.length + ' caractere(s)') : 'AUSENTE') + '.');
    } catch (e) {
        Logger.log('Etapa 2/4: ERRO ao ler Script Properties — ' + e.message);
        return;
    }

    try {
        const resp = UrlFetchApp.fetch('https://api.cnpja.com', { muteHttpExceptions: true });
        Logger.log('Etapa 3/4: rede externa OK — https://api.cnpja.com respondeu HTTP ' + resp.getResponseCode() + '.');
    } catch (e) {
        Logger.log('Etapa 3/4: ERRO de rede (UrlFetchApp) — ' + e.message);
        return;
    }

    try {
        const chaves = obterChaves_();
        Logger.log('Etapa 4/4: ' + chaves.length + ' chave(s) carregada(s) — testando a primeira...');
        const resultado = buscarGeocodificacao_('07526557011659', chaves[0].chave);
        Logger.log('Etapa 4/4: chamada à CNPJá OK — ' + JSON.stringify(resultado));
    } catch (e) {
        Logger.log('Etapa 4/4: ERRO na chamada à CNPJá — ' + e.message + (e.stack ? ('\n' + e.stack) : ''));
    }
}

// Testa as chaves configuradas de uma vez só (1 chamada cada, contra o
// mesmo CNPJ de teste) e loga OK/ERRO por chave — mostra de cara se
// alguma já está sem crédito ou com problema, sem precisar rodar o
// backfill inteiro pra descobrir.
function testarTodasChaves() {
    const chaves = obterChaves_();
    chaves.forEach((c) => {
        try {
            const resultado = buscarGeocodificacao_('07526557011659', c.chave);
            Logger.log('Chave ' + c.indice + ': OK — ' + JSON.stringify(resultado));
        } catch (e) {
            Logger.log('Chave ' + c.indice + ': ERRO — ' + e.message);
        }
    });
}

function obterChaves_() {
    const props = PropertiesService.getScriptProperties();
    const chaves = [];
    for (let i = 1; i <= MAX_CHAVES; i++) {
        const chave = props.getProperty('CNPJA_API_KEY_' + i);
        if (chave) chaves.push({ indice: i, chave: chave });
    }
    if (!chaves.length) throw new Error('Nenhuma chave configurada — rode configurarChavesApi primeiro.');
    return chaves;
}

// ===== BACKFILL =====

function iniciarBackfillGeocodificacao() {
    garantirColunas_();
    processarLote_();
}

function processarLote_() {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
    if (!sheet) throw new Error('Aba "' + SHEET_NAME + '" não encontrada nesta planilha.');

    const data = sheet.getDataRange().getValues();
    const headers = data[0];
    const idx = mapearColunas_(headers);
    if (idx.cnpj === -1 || idx.latitude === -1 || idx.longitude === -1 || idx.email === -1 || idx.porte === -1 || idx.capitalSocial === -1) {
        throw new Error('Colunas Cnpj/Latitude/Longitude/Email/Porte/CapitalSocial não encontradas — rode garantirColunas_ primeiro (iniciarBackfillGeocodificacao já faz isso).');
    }

    const chaves = obterChaves_();
    const usoChaves = lerUsoPorChave_();
    const cfg = lerConfigUso_();
    let usadoAgora = cfg.usado; // total combinado — é o que a aba Configurações do Radar mostra
    const errosConsecutivosPorChave = {};
    const chavesDescartadasNesteLote = {};
    const chaveIndisponivelAte = {}; // indice -> timestamp (ms) até quando pular essa chave por rate limit

    // Espaçamento entre chamadas divide o "custo" (6500ms, o que já
    // mantém uma chave sozinha com folga dentro de ~10/60s) pelo número
    // de chaves — com rodízio, cada chave individual só recebe 1 a cada
    // N chamadas, então N chaves ativas processam ~N vezes mais rápido
    // sem violar o limite de nenhuma delas.
    const delayEntreChamadasMs = Math.max(800, Math.round(DELAY_BASE_MS / chaves.length));

    let cursorChave = 0;
    // Rodízio, não "sempre a primeira disponível" — antes disso, uma
    // chave em rate limit deixava as outras 3 completamente paradas
    // (visto em produção: só a chave 1 tinha uso, as outras 3 seguiam
    // com os 50 créditos intactos). Pula quem está descartada, esgotada
    // no mês, ou temporariamente de fora por rate limit.
    function escolherChave_() {
        for (let tentativas = 0; tentativas < chaves.length; tentativas++) {
            const c = chaves[cursorChave % chaves.length];
            cursorChave++;
            if (chavesDescartadasNesteLote[c.indice]) continue;
            if ((usoChaves.uso[c.indice] || 0) >= CREDITOS_POR_CHAVE) continue;
            if (chaveIndisponivelAte[c.indice] && chaveIndisponivelAte[c.indice] > Date.now()) continue;
            return c;
        }
        return null;
    }

    const startTime = Date.now();
    let cortadoPeloTempo = false;
    let semChaveDisponivel = false;
    let limiteGeralAtingido = false;
    let processados = 0, comCoordenada = 0, semCoordenada = 0, erros = 0;

    for (let r = 1; r < data.length; r++) {
        const row = data[r];
        const cnpj = String(row[idx.cnpj] || '').replace(/\D/g, '');
        const valorLat = row[idx.latitude];
        const jaProcessado = valorLat !== '' && valorLat !== null;
        if (!cnpj || jaProcessado) continue;

        if (usadoAgora >= cfg.limite) { limiteGeralAtingido = true; break; }
        if (Date.now() - startTime > BATCH_TIME_LIMIT_MS) { cortadoPeloTempo = true; break; }

        const chaveAtiva = escolherChave_();
        if (!chaveAtiva) {
            // Sem nenhuma chave disponível AGORA — mas por dois motivos
            // bem diferentes: esgotadas/descartadas de verdade (permanente
            // até o mês virar) ou só esfriando de rate limit (temporário,
            // libera sozinho em menos de 1 min). Só para o trigger no
            // primeiro caso.
            const semSaidaPermanente = chaves.every((c) =>
                chavesDescartadasNesteLote[c.indice] || (usoChaves.uso[c.indice] || 0) >= CREDITOS_POR_CHAVE);
            if (semSaidaPermanente) {
                semChaveDisponivel = true;
            } else {
                cortadoPeloTempo = true; // deixa o próximo lote (5min) tentar de novo
            }
            break;
        }

        processados++;
        try {
            const resultado = buscarGeocodificacao_(cnpj, chaveAtiva.chave);
            if (resultado.lat !== null && resultado.lng !== null) {
                sheet.getRange(r + 1, idx.latitude + 1).setValue(resultado.lat);
                sheet.getRange(r + 1, idx.longitude + 1).setValue(resultado.lng);
                comCoordenada++;
            } else {
                sheet.getRange(r + 1, idx.latitude + 1).setValue('sem_coordenada');
                semCoordenada++;
            }
            // Mesma chamada já trazia isso — sem custo extra de crédito.
            // Só grava o que veio preenchido (deixa em branco o que a
            // CNPJá não tinha, em vez de sobrescrever com vazio).
            if (resultado.email) sheet.getRange(r + 1, idx.email + 1).setValue(resultado.email);
            if (resultado.porte) sheet.getRange(r + 1, idx.porte + 1).setValue(resultado.porte);
            if (resultado.capitalSocial !== null) sheet.getRange(r + 1, idx.capitalSocial + 1).setValue(resultado.capitalSocial);
            usoChaves.uso[chaveAtiva.indice] = (usoChaves.uso[chaveAtiva.indice] || 0) + 1;
            usadoAgora++; // a chamada foi feita (e respondida) de qualquer jeito, gastou crédito
            errosConsecutivosPorChave[chaveAtiva.indice] = 0;
        } catch (e) {
            if (e.rateLimited) {
                // Não descarta a chave nem dorme o script inteiro — só
                // marca ESSA chave como indisponível pelo tempo que a
                // CNPJá mandou (+ folga) e segue pra próxima linha, que
                // escolherChave_ vai preencher com outra chave (rodízio).
                // Essa linha fica vazia, retentada depois.
                const espera = ((e.ttl || 60) + 3) * 1000;
                chaveIndisponivelAte[chaveAtiva.indice] = Date.now() + espera;
                Logger.log('Rate limit na chave ' + chaveAtiva.indice + ' (linha ' + (r + 1) + ') — só ela fica ' +
                    'de fora por ' + Math.round(espera / 1000) + 's, seguindo com as outras.');
                continue;
            }
            if (e.semCredito) {
                // Sinal direto da CNPJá, mais confiável que nosso contador
                // interno (que assume 1 crédito/chamada, mas o custo real
                // pode ser maior) — marca a chave como esgotada pro resto
                // do mês IMEDIATAMENTE, sem esperar bater CREDITOS_POR_CHAVE.
                usoChaves.uso[chaveAtiva.indice] = CREDITOS_POR_CHAVE;
                Logger.log('Chave ' + chaveAtiva.indice + ' sem créditos (linha ' + (r + 1) + ') — marcada como ' +
                    'esgotada pro resto do mês. ' + e.message);
                continue;
            }
            Logger.log('Erro no CNPJ ' + cnpj + ' (linha ' + (r + 1) + ', chave ' + chaveAtiva.indice + '): ' + e.message);
            erros++;
            errosConsecutivosPorChave[chaveAtiva.indice] = (errosConsecutivosPorChave[chaveAtiva.indice] || 0) + 1;
            // 3 erros seguidos NESSA chave não é ruído de rede, é sinal de
            // que ela esgotou (ou é inválida) — descarta só ela pro resto
            // desse lote e segue com as outras. A linha continua vazia,
            // será retentada (com essa ou outra chave) na próxima passada.
            if (errosConsecutivosPorChave[chaveAtiva.indice] >= 3) {
                chavesDescartadasNesteLote[chaveAtiva.indice] = true;
                Logger.log('Chave ' + chaveAtiva.indice + ' descartada por esse lote (3 erros seguidos).');
            }
        }
        Utilities.sleep(delayEntreChamadasMs);
    }

    salvarUsoPorChave_(usoChaves);
    salvarConfigUso_(cfg, usadoAgora);

    const chavesOk = chaves.length - Object.keys(chavesDescartadasNesteLote).length;
    Logger.log('Lote: ' + processados + ' processados — ' + comCoordenada + ' com coordenada, ' +
        semCoordenada + ' sem coordenada, ' + erros + ' erro(s). Uso total do mês: ' + usadoAgora + '/' +
        cfg.limite + '. Chaves ativas nesse lote: ' + chavesOk + '/' + chaves.length + '.');

    if (limiteGeralAtingido) {
        removerTrigger_();
        Logger.log('PARADO: limite mensal geral (' + cfg.limite + ') atingido. Se configurou mais chaves ' +
            'do que esse número cobre, ajuste "Limite mensal de geocodificação" na aba Configurações do ' +
            'Radar (dentro do app) e rode iniciarBackfillGeocodificacao de novo manualmente — ou espere o ' +
            'mês virar, que reseta sozinho.');
    } else if (semChaveDisponivel) {
        removerTrigger_();
        Logger.log('PARADO: todas as ' + chaves.length + ' chave(s) configurada(s) esgotaram a cota (' +
            CREDITOS_POR_CHAVE + ' cada) ou foram descartadas por erro nesse lote. Volta a valer mais no ' +
            'mês que vem, ou rode iniciarBackfillGeocodificacao manualmente se resolver algo antes disso.');
    } else if (cortadoPeloTempo) {
        garantirTrigger_();
    } else {
        // Passou pela planilha inteira nessa passada sem precisar cortar
        // pelo tempo nem por limite — não sobrou nenhuma linha pendente.
        removerTrigger_();
        Logger.log('Backfill concluído — nenhuma linha pendente restante.');
    }
}

// A mesma chamada já traz nome/endereço/telefone/CNAE etc. — a maior
// parte é redundante com o que o CSV já importa, então só extrai o que é
// realmente novo: geocodificação, e-mail, porte e capital social. Ver
// discussão no chat sobre o schema completo — sócios (`members`) e
// atividades secundárias ficaram de fora de propósito.
function buscarGeocodificacao_(cnpj, chave) {
    const url = 'https://api.cnpja.com/office/' + cnpj + '?geocoding=true';
    const response = UrlFetchApp.fetch(url, {
        method: 'get',
        headers: montarHeaderAuth_(chave),
        muteHttpExceptions: true
    });

    const code = response.getResponseCode();
    if (code === 429) {
        let parsed = null;
        try { parsed = JSON.parse(response.getContentText()); } catch (e) { /* corpo fora do formato esperado */ }

        // A CNPJá usa 429 pra DOIS problemas diferentes, que precisam de
        // tratamento oposto. "not enough credits" (visto na prática: uma
        // chamada com geocoding=true pode custar mais de 1 crédito, ex.
        // "required":2) é PERMANENTE até o mês virar — a conta zerou o
        // saldo de verdade, não adianta esperar. Como o custo real por
        // chamada pode ser >1, nosso contador interno (1 por chamada) pode
        // ficar defasado do saldo real — por isso confiar nesse sinal
        // direto da API é mais seguro que só comparar com
        // CREDITOS_POR_CHAVE. Marcado à parte (erro.semCredito) pra quem
        // chamou tratar diferente de rate limit (que é só temporário).
        if (parsed && parsed.message === 'not enough credits') {
            const erro = new Error('HTTP 429 (sem crédito): ' + response.getContentText().slice(0, 200));
            erro.semCredito = true;
            throw erro;
        }

        // Rate limit "de verdade" (visto na prática: ~10 chamadas/60s por
        // chave) — NÃO é a chave que está ruim ou sem saldo, somos nós
        // indo rápido demais. A própria CNPJá manda quanto falta pro
        // limite liberar de novo (ttl, em segundos) — usa isso em vez de
        // chutar um tempo de espera. Marcado à parte (erro.rateLimited)
        // pra quem chamou saber que é só temporário.
        let ttl = 60;
        if (parsed && typeof parsed.ttl === 'number') ttl = parsed.ttl;
        const erro = new Error('HTTP 429 (rate limit): ' + response.getContentText().slice(0, 200));
        erro.rateLimited = true;
        erro.ttl = ttl;
        throw erro;
    }
    if (code !== 200) {
        throw new Error('HTTP ' + code + ': ' + response.getContentText().slice(0, 200));
    }

    const body = JSON.parse(response.getContentText());
    const lat = body && body.address && body.address.latitude;
    const lng = body && body.address && body.address.longitude;
    const email = (body && body.emails && body.emails[0] && body.emails[0].address) || '';
    const porte = (body && body.company && body.company.size && body.company.size.text) || '';
    const equity = body && body.company && body.company.equity;

    return {
        lat: (typeof lat === 'number') ? lat : null,
        lng: (typeof lng === 'number') ? lng : null,
        email: email,
        porte: porte,
        capitalSocial: (typeof equity === 'number') ? equity : null
    };
}

// ===== USO POR CHAVE (rotação entre contas — Script Properties, interno) =====
// Detalhe de implementação: quanto CADA chave já gastou esse mês, pra
// saber quando pular pra próxima. Diferente do total combinado (que vai
// pra ConfigEmail, visível na aba Configurações do Radar), isso fica só
// aqui — o app não precisa saber qual chave específica fez qual chamada.

function lerUsoPorChave_() {
    const props = PropertiesService.getScriptProperties();
    const mesAtual = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'America/Sao_Paulo', 'yyyy-MM');
    const mesSalvo = props.getProperty('CHAVES_MES_REFERENCIA');
    const uso = {};
    for (let i = 1; i <= MAX_CHAVES; i++) {
        uso[i] = (mesSalvo === mesAtual) ? (Number(props.getProperty('CHAVE_' + i + '_USO')) || 0) : 0;
    }
    return { uso: uso, mesAtual: mesAtual };
}

function salvarUsoPorChave_(usoChaves) {
    const props = PropertiesService.getScriptProperties();
    props.setProperty('CHAVES_MES_REFERENCIA', usoChaves.mesAtual);
    for (let i = 1; i <= MAX_CHAVES; i++) {
        props.setProperty('CHAVE_' + i + '_USO', String(usoChaves.uso[i] || 0));
    }
}

// ===== CONFIG (ConfigEmail) =====
// Mesma aba que a tela admin do app já usa (Chave na coluna A, Valor na
// coluna B). Só lê radar_geocoding_limite_mensal (editável na aba
// Configurações do Radar, dentro do app); lê e escreve
// radar_geocoding_usado_mes + radar_geocoding_mes_referencia — só esse
// script escreve esses 2, o app só mostra.

function lerConfigUso_() {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG_SHEET_NAME);
    const mesAtual = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'America/Sao_Paulo', 'yyyy-MM');
    if (!sheet) {
        Logger.log('Aba "' + CONFIG_SHEET_NAME + '" não encontrada — rodando sem limite mensal configurado (padrão ' + CREDITOS_POR_CHAVE + ').');
        return { sheet: null, limite: CREDITOS_POR_CHAVE, usado: 0, mesAtual: mesAtual, linhaUsado: -1, linhaMes: -1 };
    }

    const data = sheet.getDataRange().getValues();
    let limite = CREDITOS_POR_CHAVE, usado = 0, mesReferencia = '';
    let linhaUsado = -1, linhaMes = -1;
    for (let r = 1; r < data.length; r++) {
        const chave = String(data[r][0] || '').trim();
        if (chave === CONFIG_KEY_LIMITE) limite = Number(data[r][1]) || CREDITOS_POR_CHAVE;
        if (chave === CONFIG_KEY_USADO) { usado = Number(data[r][1]) || 0; linhaUsado = r; }
        if (chave === CONFIG_KEY_MES) {
            // "2026-07" escrito sem forçar texto vira uma DATA de verdade
            // pro Sheets (ele detecta como "01/07/2026") — na leitura,
            // getValues() devolve um objeto Date, não a string original.
            // Tolera os dois formatos aqui; a escrita (salvarConfigUso_)
            // agora força texto com apóstrofo pra isso nem acontecer mais.
            const raw = data[r][1];
            mesReferencia = (raw instanceof Date)
                ? Utilities.formatDate(raw, Session.getScriptTimeZone() || 'America/Sao_Paulo', 'yyyy-MM')
                : String(raw || '');
            linhaMes = r;
        }
    }
    if (mesReferencia !== mesAtual) usado = 0; // virou o mês, zera o contador

    return { sheet: sheet, limite: limite, usado: usado, mesAtual: mesAtual, linhaUsado: linhaUsado, linhaMes: linhaMes };
}

function salvarConfigUso_(cfg, usadoAgora) {
    if (!cfg.sheet) return;
    if (cfg.linhaUsado === -1) {
        cfg.sheet.appendRow([CONFIG_KEY_USADO, String(usadoAgora)]);
    } else {
        cfg.sheet.getRange(cfg.linhaUsado + 1, 2).setValue(String(usadoAgora));
    }
    // Apóstrofo força a célula a ficar como texto puro — sem isso, o
    // Sheets detecta "2026-07" como data e reformata pra "01/07/2026"
    // (um objeto Date de verdade na leitura seguinte), o que quebrava a
    // comparação de mês e zerava o contador em TODA execução (bug real,
    // achado via log de diagnóstico — ver git log).
    const mesTexto = "'" + cfg.mesAtual;
    if (cfg.linhaMes === -1) {
        cfg.sheet.appendRow([CONFIG_KEY_MES, mesTexto]);
    } else {
        cfg.sheet.getRange(cfg.linhaMes + 1, 2).setValue(mesTexto);
    }
}

// ===== COLUNAS E TRIGGER =====

function garantirColunas_() {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
    if (!sheet) throw new Error('Aba "' + SHEET_NAME + '" não encontrada nesta planilha.');
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    const faltando = ['Latitude', 'Longitude', 'Email', 'Porte', 'CapitalSocial'].filter((h) => headers.indexOf(h) === -1);
    if (faltando.length) {
        sheet.getRange(1, headers.length + 1, 1, faltando.length).setValues([faltando]);
    }
}

function mapearColunas_(headers) {
    return {
        cnpj: headers.indexOf('Cnpj'),
        latitude: headers.indexOf('Latitude'),
        longitude: headers.indexOf('Longitude'),
        email: headers.indexOf('Email'),
        porte: headers.indexOf('Porte'),
        capitalSocial: headers.indexOf('CapitalSocial')
    };
}

function garantirTrigger_() {
    const jaExiste = ScriptApp.getProjectTriggers().some((t) => t.getHandlerFunction() === TRIGGER_HANDLER);
    if (!jaExiste) {
        ScriptApp.newTrigger(TRIGGER_HANDLER).timeBased().everyMinutes(5).create();
        Logger.log('Trigger criado — vai continuar sozinho a cada 5min até acabar.');
    }
}

function removerTrigger_() {
    ScriptApp.getProjectTriggers().forEach((t) => {
        if (t.getHandlerFunction() === TRIGGER_HANDLER) ScriptApp.deleteTrigger(t);
    });
}
