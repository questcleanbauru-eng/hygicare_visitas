// ==================================================
// API para o Aplicativo de Visitas e Propostas
// ==================================================

const SPREADSHEET_ID = '1rW2cl0V-HWNnYWHsRTgtEv9dvR2PEIL0X92eBGAIrzQ';

// ── Server-side cache (CacheService) ─────────────────────────────────────
// Reduces repeated Sheets reads from ~1-3s to ~100ms for warm requests.
// TTL: 180s for lists, 120s for dashboard. Skips cache if payload > 95KB.

function withCache(key, ttlSec, fn) {
  var cache = CacheService.getScriptCache();
  var hit = cache.get(key);
  if (hit !== null) {
    try { return JSON.parse(hit); } catch(e) {}
  }
  var result = fn();
  try {
    var json = JSON.stringify(result);
    if (json.length < 95000) { cache.put(key, json, ttlSec); }
  } catch(e) {}
  return result;
}

function clearUserCaches(email) {
  if (!email) return;
  try {
    CacheService.getScriptCache().removeAll([
      'v_' + email, 'v_' + email + '_3m', 'v_' + email + '_all',
      'p_' + email, 'p_' + email + '_3m', 'p_' + email + '_all',
      'f_' + email, 'f_' + email + '_3m', 'f_' + email + '_all',
      'd_' + email
    ]);
  } catch(e) {}
}

// ── Keep-alive ────────────────────────────────────────────────────────────
// Prevents GAS cold start (2-5s delay). Create a time-based trigger:
//   GAS Editor → Triggers → Add trigger → keepAlive → Time-driven → Every 5 minutes
function keepAlive() {
  SpreadsheetApp.openById(SPREADSHEET_ID).getName();
}

function doPost(e) {
  try {
    const requestData = JSON.parse(e.postData.contents || '{}');
    const action = requestData.action;
    const payload = requestData.payload || {};
    if (action !== 'ping' && action !== 'login' && action !== 'forgotPassword') {
      var rlEmail = (payload.user && payload.user.email) ? String(payload.user.email) : '';
      checkRateLimit(rlEmail);
    }
    const spreadsheet = SpreadsheetApp.openById(SPREADSHEET_ID);

    let response;

    switch (action) {
      case 'login':
        response = handleLogin(spreadsheet, payload);
        break;
      case 'forgotPassword':
        response = handleForgotPassword(spreadsheet, payload);
        break;
      case 'getVisits':
        response = handleGetVisits(spreadsheet, payload);
        break;
      case 'getVisitById':
        response = handleGetVisitById(spreadsheet, payload);
        break;
      case 'getFormData':
        response = handleGetFormData(spreadsheet, payload);
        break;
      case 'createVisit':
        response = handleCreateVisit(spreadsheet, payload);
        break;
      case 'updateVisit':
        response = handleUpdateVisit(spreadsheet, payload);
        break;
      case 'getProposals':
        response = handleGetProposals(spreadsheet, payload);
        break;
      case 'getProposalById':
        response = handleGetProposalById(spreadsheet, payload);
        break;
      case 'createProposal':
        response = handleCreateProposal(spreadsheet, payload);
        break;
      case 'updateProposal':
        response = handleUpdateProposal(spreadsheet, payload);
        break;
      case 'getDashboardData':
        response = handleGetDashboardData(spreadsheet, payload);
        break;
      case 'getAdminData':
        response = handleGetAdminData(spreadsheet, payload);
        break;
      case 'saveUser':
        response = handleSaveUser(spreadsheet, payload);
        break;
      case 'saveNotificationConfig':
        response = handleSaveNotificationConfig(spreadsheet, payload);
        break;
      case 'saveLookupList':
        response = handleSaveLookupList(spreadsheet, payload);
        break;
      case 'getFunil':
        response = handleGetFunil(spreadsheet, payload);
        break;
      case 'debugFunilHeaders':
        response = handleDebugFunilHeaders(spreadsheet, payload);
        break;
      case 'getFunilById':
        response = handleGetFunilById(spreadsheet, payload);
        break;
      case 'createFunil':
        response = handleCreateFunil(spreadsheet, payload);
        break;
      case 'updateFunil':
        response = handleUpdateFunil(spreadsheet, payload);
        break;
      case 'getEmailConfig':
        response = handleGetEmailConfig(spreadsheet, payload);
        break;
      case 'saveEmailConfig':
        response = handleSaveEmailConfig(spreadsheet, payload);
        break;
      case 'getConfigVersion':
        response = handleGetConfigVersion(spreadsheet, payload);
        break;
      case 'ping':
        response = { status: 'ok' };
        break;
      default:
        response = { status: 'error', message: 'Acao desconhecida.' };
    }

    return jsonOutput(response);
  } catch (error) {
    return jsonOutput({ status: 'error', message: error.message });
  }
}

function jsonOutput(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

function handleLogin(spreadsheet, payload) {
  const email = String(payload.email || '').trim().toLowerCase();
  const password = String(payload.password || '').trim();
  if (!email || !password) {
    throw new Error('E-mail e senha sao obrigatorios.');
  }

  const usersSheet = getSheet(spreadsheet, 'Vendedores');
  const rows = getSheetObjects(usersSheet);
  const found = rows.find((row) => String(row.EmailLogin || '').trim().toLowerCase() === email && String(row.Senha || '').trim() === password);

  if (!found) {
    throw new Error('E-mail ou senha invalidos.');
  }

  return {
    status: 'success',
    userData: {
      email: found.EmailLogin,
      name: found.NomeVendedor,
      profile: found.Perfil,
      gerencia: found.Gerencia
    }
  };
}

function handleForgotPassword(spreadsheet, payload) {
  const email = String(payload.email || '').trim().toLowerCase();
  if (!email) {
    throw new Error('Informe um e-mail.');
  }

  const usersSheet = getSheet(spreadsheet, 'Vendedores');
  const rows = getSheetObjects(usersSheet);
  const found = rows.find((row) => String(row.EmailLogin || '').trim().toLowerCase() === email);

  if (!found) {
    return { status: 'success', message: 'Se o e-mail existir, o administrador deve redefinir a senha no cadastro.' };
  }

  return {
    status: 'success',
    message: 'Solicitacao registrada. Entre em contato com o administrador para redefinicao da senha.'
  };
}

function handleGetVisits(spreadsheet, payload) {
  const requestStartedAt = Date.now();
  const user = requireUser(payload.user);
  const dias = typeof payload.dias === 'number' ? payload.dias :
               (typeof payload.meses === 'number' ? payload.meses * 30 : 30);
  const scope = dias === 0 ? 'all' : dias + 'd';
  const cacheKey = dias === 0 ? 'v_' + user.email + '_all' : 'v_' + user.email + '_3m';
  var visits = withCache(cacheKey, 180, function() {
    var all = filterByUser(getSheetObjects(getSheet(spreadsheet, 'Visitas')).map(normalizeVisitRow), user, 'visits');
    if (dias === 0) return all;
    var cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - dias);
    cutoff.setHours(0, 0, 0, 0);
    return all.filter(function(v) {
      var d = parseDate(v['Data da Visita']);
      return d !== null && d >= cutoff;
    });
  });
  const syncReady = hasSyncColumn(spreadsheet, 'Visitas');
  if (syncReady && typeof payload.since === 'number' && payload.since > 0) {
    visits = visits.filter(function(v) { return (v.SyncTimestamp || 0) > payload.since; });
  }
  return syncReady
    ? { status: 'success', visits: visits, scope: scope, serverNow: requestStartedAt }
    : { status: 'success', visits: visits, scope: scope };
}

function handleGetVisitById(spreadsheet, payload) {
  const user = requireUser(payload.user);
  const id = String(payload.id || '').trim();
  const visits = withCache('v_' + user.email, 180, function() {
    return filterByUser(getSheetObjects(getSheet(spreadsheet, 'Visitas')).map(normalizeVisitRow), user, 'visits');
  });
  const found = visits.find(function(v) { return String(v.ID) === id; });
  if (!found) {
    throw new Error('Visita nao encontrada.');
  }
  return { status: 'success', visit: found };
}

function handleGetFormData(spreadsheet, payload) {
  const user = requireUser(payload.user);

  var lookups = withCache('formdata_lookups', 600, function() {
    return {
      cidades: getSingleColumnValues(spreadsheet, 'Cidades', 'Cidade'),
      areasAtuacao: getSingleColumnValues(spreadsheet, 'AreasAtuacao', 'Area'),
      potenciaisCliente: getSingleColumnValues(spreadsheet, 'PotenciaisCliente', 'Potencial'),
      aplicacoes: getSingleColumnValuesSafe(spreadsheet, 'Aplicacoes', 'Aplicacao'),
      equipamentos: getSingleColumnValuesSafe(spreadsheet, 'Equipamentos', 'Equipamento')
    };
  });

  var tiposVisita = withCache('formdata_tipos', 600, function() {
    return getSheetObjects(getSheet(spreadsheet, 'TiposVisita')).map(function(row) {
      return {
        tipo: row.Tipo || '',
        telefoneDestino: row.TelefoneDestino || '',
        mensagemPadrao: row.MensagemPadrao || '',
        obrigatorio: String(row.Obrigatorio || '').trim().toLowerCase() === 'sim'
      };
    });
  });

  var clientes = withCache('formdata_clients_' + user.email, 300, function() {
    return getSheetObjects(getSheet(spreadsheet, 'Clientes'))
      .filter(function(row) { return canAccessClient(row, user); })
      .map(function(row) {
        return {
          ID_Cliente: row.ID_Cliente || '',
          'Nome do Cliente': row['Nome do Cliente'] || '',
          Cidade: row.Cidade || '',
          'Área de Atuação': row['Área de Atuação'] || row['Area de Atuacao'] || '',
          Vendedores: row.Vendedores || '',
          Gerencia: row.Gerencia || row['Gerência'] || '',
          'Contato Padrão': row['Contato Padrão'] || row.Contato || '',
          Telefone: row.Telefone || '',
          'Potencial do Cliente': row['Potencial do Cliente'] || '',
          'E-mail': row['E-mail'] || row.Email || ''
        };
      });
  });

  return {
    status: 'success',
    data: Object.assign({}, lookups, { tiposVisita: tiposVisita, clientes: clientes })
  };
}

function canAccessClient(row, user) {
  const profile = String(user.profile || '').trim().toLowerCase();
  if (profile === 'admin' || profile === 'gerente') {
    return true;
  }

  const sellerName = String(user.name || '').trim().toLowerCase();
  const assignedSellers = String(row.Vendedores || row.Vendedor || '').toLowerCase();
  if (!sellerName || !assignedSellers) {
    return false;
  }

  return assignedSellers
    .split(/[;,|]/)
    .map((item) => item.trim())
    .filter(Boolean)
    .includes(sellerName);
}

function handleCreateVisit(spreadsheet, payload) {
  const user = verifyUser(spreadsheet, payload.user);
  payload.vendedorGerente = user.name;
  payload.gerencia = user.gerencia;

  const tiposVisita = Array.isArray(payload.tiposVisita) && payload.tiposVisita.length
    ? payload.tiposVisita
    : [payload.tipoVisita].filter(Boolean);

  if (!tiposVisita.length) {
    throw new Error('Informe pelo menos um tipo de visita.');
  }

  const result = withLock(function() {
    const visitsSheet = getSheet(spreadsheet, 'Visitas');
    const headers = getHeaders(visitsSheet);
    const existingRows = getSheetObjects(visitsSheet);

    const createdVisits = tiposVisita.slice(0, 3).map(function(tipoVisita, index) {
      const nextId = String(Number(getNextId(existingRows, 'ID')) + index);
      const currentPayload = Object.assign({}, payload, { tipoVisita: tipoVisita });
      visitsSheet.appendRow(buildVisitRow(headers, currentPayload, nextId));
      return buildVisitResponse(currentPayload, nextId);
    });

    return { status: 'success', visit: createdVisits[0], visits: createdVisits };
  });
  clearUserCaches(user.email);
  return result;
}

function handleUpdateVisit(spreadsheet, payload) {
  verifyUser(spreadsheet, payload.user);
  const id = String(payload.id || '').trim();

  const result = withLock(function() {
    const visitsSheet = getSheet(spreadsheet, 'Visitas');
    const headers = getHeaders(visitsSheet);
    const rows = getSheetObjects(visitsSheet);
    const rowIndex = rows.findIndex(function(row) { return String(row.ID || '') === id; });
    if (rowIndex === -1) {
      throw new Error('Visita nao encontrada para atualizacao.');
    }
    visitsSheet.getRange(rowIndex + 2, 1, 1, headers.length).setValues([buildVisitRow(headers, payload, id)]);
    return { status: 'success', visit: buildVisitResponse(payload, id) };
  });
  clearUserCaches(String((payload.user || {}).email || ''));
  return result;
}

function handleGetProposals(spreadsheet, payload) {
  const requestStartedAt = Date.now();
  const user = requireUser(payload.user);
  const dias = typeof payload.dias === 'number' ? payload.dias :
               (typeof payload.meses === 'number' ? payload.meses * 30 : 30);
  const scope = dias === 0 ? 'all' : dias + 'd';
  const cacheKey = dias === 0 ? 'p_' + user.email + '_all' : 'p_' + user.email + '_3m';
  var proposals = withCache(cacheKey, 180, function() {
    var all = filterByUser(getSheetObjects(getSheet(spreadsheet, 'Propostas')).map(normalizeProposalRow), user, 'proposals');
    if (dias === 0) return all;
    var cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - dias);
    cutoff.setHours(0, 0, 0, 0);
    return all.filter(function(p) {
      var d = parseDate(p.Data);
      return d !== null && d >= cutoff;
    });
  });
  const syncReady = hasSyncColumn(spreadsheet, 'Propostas');
  if (syncReady && typeof payload.since === 'number' && payload.since > 0) {
    proposals = proposals.filter(function(p) { return (p.SyncTimestamp || 0) > payload.since; });
  }
  return syncReady
    ? { status: 'success', proposals: proposals, scope: scope, serverNow: requestStartedAt }
    : { status: 'success', proposals: proposals, scope: scope };
}

function handleGetProposalById(spreadsheet, payload) {
  const user = requireUser(payload.user);
  const id = String(payload.id || '').trim();
  const proposals = withCache('p_' + user.email, 180, function() {
    return filterByUser(getSheetObjects(getSheet(spreadsheet, 'Propostas')).map(normalizeProposalRow), user, 'proposals');
  });
  const found = proposals.find(function(p) { return String(p.Id) === id; });
  if (!found) {
    throw new Error('Proposta nao encontrada.');
  }
  return { status: 'success', proposal: found };
}

function handleCreateProposal(spreadsheet, payload) {
  const user = verifyUser(spreadsheet, payload.user);
  if (!payload.cliente) { throw new Error('Cliente e obrigatorio.'); }

  const result = withLock(function() {
    const sheet = getSheet(spreadsheet, 'Propostas');
    const headers = getHeaders(sheet);
    const rows = getSheetObjects(sheet);
    const id = getNextId(rows, 'Id');
    const today = formatDate(new Date());
    const now = formatTime(new Date());

    var dataLimite30 = new Date();
    dataLimite30.setDate(dataLimite30.getDate() + 30);

    const rowData = {
      Id: id,
      Data: today,
      Vendedor: user.name,
      Cliente: payload.cliente,
      Foco: payload.foco || '',
      Produtos: payload.produtos || '',
      Gerencia: user.gerencia,
      Cidade: payload.cidade || '',
      Status: payload.status || 'Enviada',
      'Atualização': today,
      Hora: now,
      'Atualizar/OBS': payload.obs || '',
      'Observação': payload.obs || '',
      'Observacao': payload.obs || '',
      'Data Limite': formatDate(dataLimite30),
      'E-mail': user.email,
      'SyncTimestamp': Date.now()
    };

    sheet.appendRow(headers.map(function(h) { return rowData[h] !== undefined ? rowData[h] : ''; }));
    return { status: 'success', proposal: normalizeProposalRow(rowData) };
  });
  clearUserCaches(user.email);
  return result;
}

function handleUpdateProposal(spreadsheet, payload) {
  verifyUser(spreadsheet, payload.user);
  const id = String(payload.id || '').trim();

  const result = withLock(function() {
    const proposalsSheet = getSheet(spreadsheet, 'Propostas');
    const headers = getHeaders(proposalsSheet);
    const rows = getSheetObjects(proposalsSheet);
    const rowIndex = rows.findIndex(function(row) { return String(row.Id || '') === id; });
    if (rowIndex === -1) {
      throw new Error('Proposta nao encontrada para atualizacao.');
    }
    var dataLimite30 = new Date();
    dataLimite30.setDate(dataLimite30.getDate() + 30);
    const novaDataLimite = formatDate(dataLimite30);

    const current = rows[rowIndex];
    current.Status = payload.status || current.Status;
    current['Atualizar/OBS'] = payload.obs || current['Atualizar/OBS'];
    current['Observação'] = payload.obs || current['Observação'] || '';
    current['Observacao'] = payload.obs || current['Observacao'] || '';
    current['Atualização'] = formatDate(new Date());
    current.Hora = formatTime(new Date());
    current['Data Limite'] = novaDataLimite;
    current.SyncTimestamp = Date.now();
    proposalsSheet.getRange(rowIndex + 2, 1, 1, headers.length).setValues([
      headers.map(function(header) { return current[header] !== undefined ? current[header] : ''; })
    ]);
    return { status: 'success', proposal: current };
  });
  clearUserCaches(String((payload.user || {}).email || ''));
  return result;
}

function handleGetDashboardData(spreadsheet, payload) {
  const user = requireUser(payload.user);
  return withCache('d_' + user.email, 120, function() {
    const visits = withCache('v_' + user.email, 180, function() {
      return filterByUser(getSheetObjects(getSheet(spreadsheet, 'Visitas')).map(normalizeVisitRow), user, 'visits');
    });
    const proposals = withCache('p_' + user.email, 180, function() {
      return filterByUser(getSheetObjects(getSheet(spreadsheet, 'Propostas')).map(normalizeProposalRow), user, 'proposals');
    });

    var funil = [];
    try {
      funil = withCache('f_' + user.email, 180, function() {
        return readFunilRows(spreadsheet, user);
      });
    } catch (e) {}

    var appConfig = withCache('app_config', 600, function() {
      return readEmailConfig(spreadsheet);
    });

    const weeklyVisits = visits.filter(function(v) { return isDateWithinLastDays(v['Data da Visita'], 7); }).length;
    const openProposals = proposals.filter(function(p) { return String(p.Status || '').toUpperCase() === 'AGUARDANDO'; }).length;
    const overdueProposals = proposals.filter(function(p) { return String(p.Status || '').toUpperCase() === 'AGUARDANDO' && daysSinceDate(p['Atualização']) > 30; }).length;
    const funilAtivo = funil.filter(function(f) {
      return String(f.ativo || '').toLowerCase() === 'sim' && !['CONCLUIDO', 'PERDIDO'].includes(String(f.status || '').toUpperCase());
    }).length;
    const overdueFunil = funil.filter(function(f) {
      return String(f.ativo || '').toLowerCase() === 'sim' &&
             !['CONCLUIDO', 'PERDIDO'].includes(String(f.status || '').toUpperCase()) &&
             daysSinceDate(f.atualizacao || f.data) > 30;
    }).length;
    const recentFunil = funil.filter(function(f) { return String(f.ativo || '').toLowerCase() === 'sim'; }).slice(0, 3);

    var profile = String(user.profile || '').trim().toLowerCase();
    return {
      status: 'success',
      data: {
        weeklyVisits: weeklyVisits,
        teamWeeklyVisits: weeklyVisits,
        openProposals: openProposals,
        overdueProposals: overdueProposals,
        funilAtivo: funilAtivo,
        overdueFunil: overdueFunil,
        metaVisitas: parseInt(appConfig.meta_visitas_semana || '0', 10),
        visitsByDay: (function() {
          var today = new Date();
          today.setHours(0, 0, 0, 0);
          var days = [];
          for (var i = 6; i >= 0; i--) {
            var d = new Date(today.getTime() - i * 86400000);
            days.push({ date: d.toISOString().substring(0, 10), count: 0 });
          }
          visits.forEach(function(v) {
            var d = parseDate(v['Data da Visita']);
            if (!d) return;
            d.setHours(0, 0, 0, 0);
            var label = d.toISOString().substring(0, 10);
            var entry = days.find(function(x) { return x.date === label; });
            if (entry) entry.count++;
          });
          return days;
        })(),
        teamData: (function() {
          if (profile === 'vendedor') return null;
          var sevenDaysAgo = new Date();
          sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
          sevenDaysAgo.setHours(0, 0, 0, 0);
          var byVendedor = {};
          visits.forEach(function(v) {
            var d = parseDate(v['Data da Visita']);
            if (!d || d < sevenDaysAgo) return;
            var vendor = String(v['Vendedor/Gerente'] || '').trim();
            if (!vendor) return;
            byVendedor[vendor] = (byVendedor[vendor] || 0) + 1;
          });
          return Object.keys(byVendedor).sort().map(function(v) {
            return { vendedor: v, visitas: byVendedor[v] };
          });
        })(),
        recentVisits: (function() {
          var ago = new Date();
          ago.setDate(ago.getDate() - 7);
          ago.setHours(0, 0, 0, 0);
          return visits.filter(function(v) {
            var d = parseDate(v['Data da Visita']);
            return d && d >= ago;
          }).sort(function(a, b) {
            var da = parseDate(a['Data da Visita']);
            var db = parseDate(b['Data da Visita']);
            return (db ? db.getTime() : 0) - (da ? da.getTime() : 0);
          }).slice(0, 5).map(function(v) {
            return {
              ID: v.ID,
              'Vendedor/Gerente': v['Vendedor/Gerente'],
              'Data da Visita': v['Data da Visita'],
              'Tipo da Visita': v['Tipo da Visita'],
              Cliente: v.Cliente,
              Cidade: v.Cidade
            };
          });
        })(),
        recentProposals: proposals.filter(function(p) {
          return String(p.Status || '').toUpperCase() === 'AGUARDANDO' && daysSinceDate(p['Atualização']) > 30;
        }).sort(function(a, b) {
          return daysSinceDate(b['Atualização']) - daysSinceDate(a['Atualização']);
        }).slice(0, 5).map(function(p) {
          return {
            ID: p.ID,
            Cliente: p.Cliente,
            Status: p.Status,
            Produto: p.Produto,
            'Atualização': p['Atualização'],
            Cidade: p.Cidade,
            Vendedor: p.Vendedor,
            Gerencia: p.Gerencia || p['Gerência'] || ''
          };
        }),
        recentFunil: recentFunil.map(function(f) {
          return {
            id: f.id,
            cliente: f.cliente,
            status: f.status,
            ativo: f.ativo,
            atualizacao: f.atualizacao,
            data: f.data
          };
        }),
        loadDias: parseInt(appConfig.load_dias || '30', 10)
      }
    };
  });
}

function handleGetAdminData(spreadsheet, payload) {
  ensureAdmin(spreadsheet, payload.user);

  return {
    status: 'success',
    data: {
      users: withCache('admin_users', 300, function() {
        return getSheetObjects(getSheet(spreadsheet, 'Vendedores')).map(function(u) {
          return { EmailLogin: u.EmailLogin || '', NomeVendedor: u.NomeVendedor || '', Gerencia: u.Gerencia || '', Perfil: u.Perfil || '' };
        });
      }),
      notifications: withCache('admin_notif', 300, function() {
        return getSheetObjects(getSheet(spreadsheet, 'TiposVisita')).map(function(row) {
          return {
            tipo: row.Tipo || '',
            telefoneDestino: row.TelefoneDestino || '',
            mensagemPadrao: row.MensagemPadrao || '',
            obrigatorio: String(row.Obrigatorio || '').trim().toLowerCase() === 'sim'
          };
        });
      }),
      lookups: withCache('admin_lookups', 600, function() {
        return {
          cidades: getSingleColumnValues(spreadsheet, 'Cidades', 'Cidade'),
          areasAtuacao: getSingleColumnValues(spreadsheet, 'AreasAtuacao', 'Area'),
          potenciaisCliente: getSingleColumnValues(spreadsheet, 'PotenciaisCliente', 'Potencial'),
          aplicacoes: getSingleColumnValuesSafe(spreadsheet, 'Aplicacoes', 'Aplicacao'),
          equipamentos: getSingleColumnValuesSafe(spreadsheet, 'Equipamentos', 'Equipamento')
        };
      })
    }
  };
}

function handleSaveUser(spreadsheet, payload) {
  ensureAdmin(spreadsheet, payload.user);
  const originalEmail = String(payload.originalEmail || '').trim().toLowerCase();

  const result = withLock(function() {
    const sheet = getSheet(spreadsheet, 'Vendedores');
    const headers = getHeaders(sheet);
    const rows = getSheetObjects(sheet);

    if (originalEmail) {
      const rowIndex = rows.findIndex(function(row) {
        return String(row.EmailLogin || '').trim().toLowerCase() === originalEmail;
      });
      if (rowIndex === -1) {
        throw new Error('Usuario nao encontrado para atualizacao.');
      }
      const existingSenha = rows[rowIndex].Senha || '';
      const userRow = {
        EmailLogin: payload.emailLogin,
        NomeVendedor: payload.nomeVendedor,
        Senha: payload.senha || existingSenha,
        Gerencia: payload.gerencia,
        Perfil: payload.perfil
      };
      sheet.getRange(rowIndex + 2, 1, 1, headers.length).setValues([
        headers.map(function(header) { return userRow[header] || ''; })
      ]);
    } else {
      if (!payload.senha) {
        throw new Error('Senha obrigatoria para novo usuario.');
      }
      const userRow = {
        EmailLogin: payload.emailLogin,
        NomeVendedor: payload.nomeVendedor,
        Senha: payload.senha,
        Gerencia: payload.gerencia,
        Perfil: payload.perfil
      };
      sheet.appendRow(headers.map(function(header) { return userRow[header] || ''; }));
    }

    return { status: 'success', message: 'Usuario salvo.' };
  });
  try {
    CacheService.getScriptCache().removeAll([
      'admin_users',
      'user_verify_' + String(payload.emailLogin || '').trim().toLowerCase(),
      'user_verify_' + originalEmail
    ]);
  } catch(e) {}
  return result;
}

function handleSaveNotificationConfig(spreadsheet, payload) {
  ensureAdmin(spreadsheet, payload.user);
  const originalTipo = String(payload.originalTipo || '').trim().toLowerCase();

  const result = withLock(function() {
    const sheet = getSheet(spreadsheet, 'TiposVisita');
    const headers = getHeaders(sheet);
    const rows = getSheetObjects(sheet);
    const rowData = {
      Tipo: payload.tipo,
      TelefoneDestino: payload.telefoneDestino,
      MensagemPadrao: payload.mensagemPadrao,
      Obrigatorio: payload.obrigatorio ? 'Sim' : 'Não'
    };

    if (originalTipo) {
      const rowIndex = rows.findIndex(function(row) {
        return String(row.Tipo || '').trim().toLowerCase() === originalTipo;
      });
      if (rowIndex === -1) {
        throw new Error('Tipo de visita nao encontrado para atualizacao.');
      }
      sheet.getRange(rowIndex + 2, 1, 1, headers.length).setValues([
        headers.map(function(header) { return rowData[header] || ''; })
      ]);
    } else {
      sheet.appendRow(headers.map(function(header) { return rowData[header] || ''; }));
    }

    bumpCacheVersion(spreadsheet);
    return { status: 'success', message: 'Configuracao salva.' };
  });
  try { CacheService.getScriptCache().removeAll(['admin_notif', 'formdata_tipos', 'app_config']); } catch(e) {}
  return result;
}

function handleSaveLookupList(spreadsheet, payload) {
  ensureAdmin(spreadsheet, payload.user);
  const mapping = {
    cidades: { sheet: 'Cidades', header: 'Cidade' },
    areasAtuacao: { sheet: 'AreasAtuacao', header: 'Area' },
    potenciaisCliente: { sheet: 'PotenciaisCliente', header: 'Potencial' },
    aplicacoes: { sheet: 'Aplicacoes', header: 'Aplicacao' },
    equipamentos: { sheet: 'Equipamentos', header: 'Equipamento' }
  };

  const config = mapping[payload.key];
  if (!config) {
    throw new Error('Lista invalida.');
  }

  const sheet = getSheet(spreadsheet, config.sheet);
  sheet.clearContents();
  const values = [[config.header]].concat(
    (payload.values || []).filter(Boolean).map(function(v) { return [v]; })
  );
  sheet.getRange(1, 1, values.length, 1).setValues(values);
  bumpCacheVersion(spreadsheet);
  try { CacheService.getScriptCache().removeAll(['admin_lookups', 'formdata_lookups', 'app_config']); } catch(e) {}
  return { status: 'success', message: 'Lista atualizada.' };
}

function buildVisitRow(headers, payload, id) {
  const map = {
    'ID': id,
    'Prospecção': payload.prospeccao || payload.prospeccao === '' ? payload.prospeccao : payload.prospecção,
    'Prospeccao': payload.prospeccao,
    'Vendedor/Gerente': payload.vendedorGerente,
    'Data da Visita': formatDateFromInput(payload.dataVisita),
    'Horário': payload.horario,
    'Horario': payload.horario,
    'Cliente': payload.cliente,
    'Contato': payload.contato,
    'Cidade': payload.cidade,
    'Área de Atuação': payload.areaAtuacao,
    'Area de Atuacao': payload.areaAtuacao,
    'Potencial do Cliente': payload.potencialCliente,
    'Tipo da Visita': payload.tipoVisita,
    'Gerência': payload.gerencia,
    'Gerencia': payload.gerencia,
    'Qual o Veículo?': payload.veiculo,
    'Qual o Veiculo?': payload.veiculo,
    'Observação': payload.observacao,
    'Observacao': payload.observacao,
    'SyncTimestamp': Date.now()
  };

  return headers.map((header) => map[header] || '');
}

function buildVisitResponse(payload, id) {
  return {
    ID: id,
    'Prospecção': payload.prospeccao,
    'Vendedor/Gerente': payload.vendedorGerente,
    'Data da Visita': formatDateFromInput(payload.dataVisita),
    'Horário': payload.horario,
    'Cliente': payload.cliente,
    'Contato': payload.contato,
    'Cidade': payload.cidade,
    'Área de Atuação': payload.areaAtuacao,
    'Potencial do Cliente': payload.potencialCliente,
    'Tipo da Visita': payload.tipoVisita,
    'Gerência': payload.gerencia,
    'Qual o Veículo?': payload.veiculo,
    'Observação': payload.observacao
  };
}


function filterByUser(items, user, type) {
  var profile  = String(user.profile  || '').trim().toLowerCase();
  var userName = String(user.name     || '').trim().toLowerCase();
  var userGer  = String(user.gerencia || '').trim().toLowerCase();

  if (profile === 'admin') return items;

  if (type === 'visits') {
    if (profile === 'gerente') {
      return items.filter(function(item) {
        return String(item['Gerência'] || item.Gerencia || '').trim().toLowerCase() === userGer;
      });
    }
    return items.filter(function(item) {
      return String(item['Vendedor/Gerente'] || '').trim().toLowerCase() === userName;
    });
  }

  if (type === 'funil') {
    if (profile === 'gerente') {
      return items.filter(function(item) {
        return String(item.gerencia || '').trim().toLowerCase() === userGer;
      });
    }
    return items.filter(function(item) {
      return String(item.vendedor || '').trim().toLowerCase() === userName;
    });
  }

  // proposals (and any other type)
  if (profile === 'gerente') {
    return items.filter(function(item) {
      return String(item.Gerencia || item['Gerência'] || '').trim().toLowerCase() === userGer;
    });
  }
  return items.filter(function(item) {
    return String(item.Vendedor || '').trim().toLowerCase() === userName;
  });
}

function requireUser(user) {
  if (!user || !user.email) {
    throw new Error('Usuario nao autenticado.');
  }
  return user;
}

function verifyUser(spreadsheet, user) {
  if (!user || !user.email) {
    throw new Error('Usuario nao autenticado.');
  }
  var email = String(user.email).trim().toLowerCase();
  var rows = withCache('user_verify_' + email, 300, function() {
    return getSheetObjects(getSheet(spreadsheet, 'Vendedores'));
  });
  var found = rows.find(function(row) {
    return String(row.EmailLogin || '').trim().toLowerCase() === email;
  });
  if (!found) {
    throw new Error('Usuario nao autenticado.');
  }
  return {
    email: found.EmailLogin,
    name: found.NomeVendedor,
    profile: found.Perfil,
    gerencia: found.Gerencia
  };
}

function ensureAdmin(spreadsheet, user) {
  const verified = verifyUser(spreadsheet, user);
  if (String(verified.profile || '').trim().toLowerCase() !== 'admin') {
    throw new Error('Acesso restrito ao administrador.');
  }
  return verified;
}

function checkRateLimit(email) {
  if (!email) return;
  var cache = CacheService.getScriptCache();
  var key = 'rl_' + String(email).replace(/[^a-z0-9@._-]/gi, '').substring(0, 50);
  var count = parseInt(cache.get(key) || '0', 10);
  if (count >= 60) {
    throw new Error('Muitas requisicoes. Aguarde um momento.');
  }
  try { cache.put(key, String(count + 1), 60); } catch(e) {}
}

function withLock(fn) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
  } catch (e) {
    throw new Error('O sistema esta ocupado. Tente novamente em instantes.');
  }
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function getSheet(spreadsheet, name) {
  const sheet = spreadsheet.getSheetByName(name);
  if (!sheet) {
    throw new Error('Aba nao encontrada: ' + name);
  }
  return sheet;
}

function getHeaders(sheet) {
  return sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
}

// Sync incremental (since/serverNow) só é ativado quando a planilha já tem a
// coluna SyncTimestamp — evita devolver listas vazias por engano em abas
// ainda não migradas. Cacheado (600s) para não custar uma leitura extra por request.
function hasSyncColumn(spreadsheet, sheetName) {
  return withCache('hassync_' + sheetName, 600, function() {
    var headers = getHeaders(getSheet(spreadsheet, sheetName));
    return headers.indexOf('SyncTimestamp') > -1;
  });
}

function getSheetObjects(sheet) {
  const values = sheet.getDataRange().getValues();
  if (values.length <= 1) {
    return [];
  }
  const headers = values.shift();
  return values.map((row) => {
    const obj = {};
    headers.forEach((header, index) => {
      obj[header] = row[index];
    });
    return obj;
  });
}

function getSingleColumnValues(spreadsheet, sheetName, header) {
  const rows = getSheetObjects(getSheet(spreadsheet, sheetName));
  return rows.map((row) => row[header]).filter(Boolean);
}

function getSingleColumnValuesSafe(spreadsheet, sheetName, header) {
  try {
    return getSingleColumnValues(spreadsheet, sheetName, header);
  } catch (e) {
    return [];
  }
}

function normalizeVisitRow(row) {
  return {
    ID: String(row.ID || ''),
    'Prospecção': row['Prospecção'] || row['Prospeccao'] || '',
    'Vendedor/Gerente': row['Vendedor/Gerente'] || '',
    'Data da Visita': formatPossibleDate(row['Data da Visita']),
    'Horário': formatPossibleTime(row['Horário'] || row['Horario']),
    'Cliente': row['Cliente'] || '',
    'Contato': row['Contato'] || '',
    'Cidade': row['Cidade'] || '',
    'Área de Atuação': row['Área de Atuação'] || row['Area de Atuacao'] || '',
    'Potencial do Cliente': row['Potencial do Cliente'] || '',
    'Tipo da Visita': row['Tipo da Visita'] || '',
    'Gerência': row['Gerência'] || row['Gerencia'] || '',
    'Qual o Veículo?': row['Qual o Veículo?'] || row['Qual o Veiculo?'] || '',
    'Observação': row['Observação'] || row['Observacao'] || '',
    'SyncTimestamp': Number(row.SyncTimestamp) || 0
  };
}

function normalizeProposalRow(row) {
  return {
    Id: String(row.Id || ''),
    Data: formatPossibleDate(row.Data),
    Vendedor: row.Vendedor || '',
    Cliente: row.Cliente || '',
    Foco: row.Foco || '',
    Produtos: row.Produtos || '',
    Gerencia: row.Gerencia || '',
    Cidade: row.Cidade || '',
    Status: row.Status || '',
    'Atualização': formatPossibleDate(row['Atualização'] || row['Atualizacao']),
    Hora: row.Hora || '',
    'Atualizar/OBS': row['Observação'] || row['Observacao'] || row['Atualizar/OBS'] || '',
    'Data Limite': formatPossibleDate(row['Data Limite']),
    'E-mail': row['E-mail'] || row.Email || '',
    'SyncTimestamp': Number(row.SyncTimestamp) || 0
  };
}

function getNextId(rows, key) {
  const maxId = rows.reduce(function (acc, row) {
    const value = Number(row[key] || 0);
    return value > acc ? value : acc;
  }, 0);
  return String(maxId + 1);
}

function formatPossibleDate(value) {
  if (Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value)) {
    return formatDate(value);
  }
  return value || '';
}

function formatPossibleTime(value) {
  if (Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value)) {
    return formatTime(value);
  }
  return value || '';
}

function formatDate(date) {
  return Utilities.formatDate(date, Session.getScriptTimeZone(), 'dd/MM/yyyy');
}

function formatTime(date) {
  return Utilities.formatDate(date, Session.getScriptTimeZone(), 'HH:mm');
}

function formatDateFromInput(value) {
  if (!value || String(value).indexOf('-') === -1) {
    return value || '';
  }
  const parts = String(value).split('-');
  return [parts[2], parts[1], parts[0]].join('/');
}

function isDateWithinLastDays(value, days) {
  const date = parseDate(value);
  if (!date) {
    return false;
  }
  const diff = new Date().getTime() - date.getTime();
  return diff <= days * 86400000;
}

function daysSinceDate(value) {
  const date = parseDate(value);
  if (!date) {
    return 0;
  }
  return Math.floor((new Date().getTime() - date.getTime()) / 86400000);
}

function parseDate(value) {
  if (Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value)) {
    return value;
  }
  if (!value || String(value).indexOf('/') === -1) {
    return null;
  }
  const parts = String(value).split('/');
  return new Date(Number(parts[2]), Number(parts[1]) - 1, Number(parts[0]));
}

// ==================================================
// Notificacoes por E-mail
// ==================================================

function handleGetEmailConfig(spreadsheet, payload) {
  ensureAdmin(spreadsheet, payload.user);
  return { status: 'success', data: readEmailConfig(spreadsheet) };
}

function handleGetConfigVersion(spreadsheet, payload) {
  requireUser(payload.user);
  var config = withCache('app_config', 600, function() {
    return readEmailConfig(spreadsheet);
  });
  return { status: 'success', version: config.cache_version || '0' };
}

function handleSaveEmailConfig(spreadsheet, payload) {
  ensureAdmin(spreadsheet, payload.user);
  var config = payload.config || {};
  var result = withLock(function() {
    var sheet = getOrCreateConfigSheet(spreadsheet);
    var rows = getSheetObjects(sheet);
    var keys = Object.keys(config);
    var updates = [];
    var inserts = [];
    keys.forEach(function(key) {
      var idx = rows.findIndex(function(row) { return row.Chave === key; });
      if (idx >= 0) {
        updates.push({ rowIndex: idx + 2, value: String(config[key]) });
      } else {
        inserts.push([key, String(config[key])]);
      }
    });
    updates.forEach(function(u) {
      sheet.getRange(u.rowIndex, 2).setValue(u.value);
    });
    if (inserts.length === 1) {
      sheet.appendRow(inserts[0]);
    } else if (inserts.length > 1) {
      sheet.getRange(sheet.getLastRow() + 1, 1, inserts.length, 2).setValues(inserts);
    }
    return { status: 'success', message: 'Configuracoes de e-mail salvas.' };
  });
  try { CacheService.getScriptCache().remove('app_config'); } catch(e) {}
  return result;
}

function readEmailConfig(spreadsheet) {
  const defaults = defaultEmailConfig();
  try {
    const sheet = spreadsheet.getSheetByName('ConfigEmail');
    if (!sheet) { return defaults; }
    const rows = getSheetObjects(sheet);
    rows.forEach(function(row) {
      if (row.Chave && row.Valor !== undefined && String(row.Valor) !== '') {
        defaults[row.Chave] = String(row.Valor);
      }
    });
  } catch (e) {}
  return defaults;
}

function defaultEmailConfig() {
  return {
    load_dias: '30',
    propostas_ativas: 'false',
    propostas_dias: '30',
    propostas_assunto: 'Proposta pendente de atualizacao',
    propostas_corpo: 'Ola {{nome}},\n\nVoce tem {{quantidade}} proposta(s) sem atualizacao ha mais de {{dias}} dias.\n\nAcesse o sistema e atualize o andamento.\n\nAtenciosamente,\nEquipe de Vendas',
    visitas_ativas: 'false',
    visitas_dias: '3',
    visitas_assunto: 'Relatorio de visitas pendente',
    visitas_corpo: 'Ola {{nome}},\n\nNao identificamos registro de visitas seus nos ultimos {{dias}} dias.\n\nPor favor, registre suas visitas no sistema.\n\nAtenciosamente,\nEquipe de Vendas',
    funil_ativas: 'false',
    funil_dias: '30',
    funil_assunto: 'Oportunidade de funil sem atualizacao',
    funil_corpo: 'Ola {{nome}},\n\nVoce tem {{quantidade}} oportunidade(s) no funil sem atualizacao ha mais de {{dias}} dias.\n\nAcesse o sistema e registre o andamento das negociacoes.\n\nAtenciosamente,\nEquipe de Vendas'
  };
}

function getOrCreateConfigSheet(spreadsheet) {
  var sheet = spreadsheet.getSheetByName('ConfigEmail');
  if (!sheet) {
    sheet = spreadsheet.insertSheet('ConfigEmail');
    sheet.appendRow(['Chave', 'Valor']);
  }
  return sheet;
}

function bumpCacheVersion(spreadsheet) {
  try {
    var sheet = getOrCreateConfigSheet(spreadsheet);
    var rows = getSheetObjects(sheet);
    var newVersion = String(Date.now());
    var idx = rows.findIndex(function(r) { return r.Chave === 'cache_version'; });
    if (idx >= 0) {
      sheet.getRange(idx + 2, 2).setValue(newVersion);
    } else {
      sheet.appendRow(['cache_version', newVersion]);
    }
  } catch(e) {
    Logger.log('bumpCacheVersion error: ' + e.message);
  }
}

function enviarEmailsNotificacao() {
  var spreadsheet = SpreadsheetApp.openById(SPREADSHEET_ID);
  var config = readEmailConfig(spreadsheet);
  if (config.propostas_ativas === 'true') {
    enviarEmailsPropostasAtrasadas(spreadsheet, config);
  }
  if (config.visitas_ativas === 'true') {
    enviarEmailsVisitasPendentes(spreadsheet, config);
  }
  if (config.funil_ativas === 'true') {
    try {
      enviarEmailsFunilAtrasados(spreadsheet, config);
    } catch (e) {
      Logger.log('Erro ao enviar emails de funil: ' + e.message);
    }
  }
}

function enviarEmailsPropostasAtrasadas(spreadsheet, config) {
  var dias = Number(config.propostas_dias) || 30;
  var assunto = config.propostas_assunto || 'Proposta pendente de atualizacao';
  var corpoTemplate = config.propostas_corpo || '';
  var proposals = getSheetObjects(getSheet(spreadsheet, 'Propostas')).map(normalizeProposalRow);
  var sellers = getSheetObjects(getSheet(spreadsheet, 'Vendedores'));

  var overdueByEmail = {};
  proposals.forEach(function(p) {
    if (String(p.Status || '').toUpperCase() !== 'AGUARDANDO') { return; }
    if (daysSinceDate(p['Atualização']) <= dias) { return; }
    var sellerRow = sellers.find(function(s) {
      return String(s.NomeVendedor || '').trim() === String(p.Vendedor || '').trim();
    });
    if (!sellerRow || !sellerRow.EmailLogin) { return; }
    var email = String(sellerRow.EmailLogin).trim();
    if (!overdueByEmail[email]) {
      overdueByEmail[email] = { nome: sellerRow.NomeVendedor || email, quantidade: 0 };
    }
    overdueByEmail[email].quantidade += 1;
  });

  Object.keys(overdueByEmail).forEach(function(email) {
    var data = overdueByEmail[email];
    var corpo = corpoTemplate
      .replace(/\{\{nome\}\}/g, data.nome)
      .replace(/\{\{quantidade\}\}/g, String(data.quantidade))
      .replace(/\{\{dias\}\}/g, String(dias));
    try {
      MailApp.sendEmail({ to: email, subject: assunto, body: corpo });
    } catch (e) {
      Logger.log('Erro ao enviar email propostas para ' + email + ': ' + e.message);
    }
  });
}

function enviarEmailsVisitasPendentes(spreadsheet, config) {
  var dias = Number(config.visitas_dias) || 3;
  var assunto = config.visitas_assunto || 'Relatorio de visitas pendente';
  var corpoTemplate = config.visitas_corpo || '';
  var visits = getSheetObjects(getSheet(spreadsheet, 'Visitas')).map(normalizeVisitRow);
  var sellers = getSheetObjects(getSheet(spreadsheet, 'Vendedores'));

  sellers.forEach(function(seller) {
    if (!seller.EmailLogin) { return; }
    var nome = String(seller.NomeVendedor || '').trim();
    var hasRecentVisit = visits.some(function(v) {
      return String(v['Vendedor/Gerente'] || '').trim() === nome &&
             isDateWithinLastDays(v['Data da Visita'], dias);
    });
    if (!hasRecentVisit) {
      var corpo = corpoTemplate
        .replace(/\{\{nome\}\}/g, nome || seller.EmailLogin)
        .replace(/\{\{dias\}\}/g, String(dias));
      try {
        MailApp.sendEmail({ to: String(seller.EmailLogin).trim(), subject: assunto, body: corpo });
      } catch (e) {
        Logger.log('Erro ao enviar email visitas para ' + seller.EmailLogin + ': ' + e.message);
      }
    }
  });
}

// ==================================================
// Funil de Vendas
// ==================================================

function handleDebugFunilHeaders(spreadsheet, payload) {
  requireUser(payload.user);
  const sheet = getSheet(spreadsheet, 'Funil');
  const headers = getHeaders(sheet);
  const rows = getSheetObjects(sheet);
  const firstRaw = rows[0] || {};
  const firstNorm = rows.length > 0 ? normalizeFunilRow(rows[0]) : {};
  // Build the lk index the same way normalizeFunilRow does, for inspection
  var lkDebug = {};
  Object.keys(firstRaw).forEach(function(k) { lkDebug[k.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim()] = k; });
  return { status: 'success', headers: headers, firstRow: firstRaw, firstRowNormalized: firstNorm, lkIndex: lkDebug, rowCount: rows.length };
}

function handleGetFunil(spreadsheet, payload) {
  const requestStartedAt = Date.now();
  const user = requireUser(payload.user);
  const dias = typeof payload.dias === 'number' ? payload.dias :
               (typeof payload.meses === 'number' ? payload.meses * 30 : 30);
  const scope = dias === 0 ? 'all' : dias + 'd';
  const cacheKey = dias === 0 ? 'f_' + user.email + '_all' : 'f_' + user.email + '_3m';
  var rows = withCache(cacheKey, 180, function() {
    return readFunilRows(spreadsheet, user, dias);
  });
  const syncReady = hasSyncColumn(spreadsheet, 'Funil');
  if (syncReady && typeof payload.since === 'number' && payload.since > 0) {
    rows = rows.filter(function(r) { return (r.syncTimestamp || 0) > payload.since; });
  }
  return syncReady
    ? { status: 'success', funil: rows, scope: scope, serverNow: requestStartedAt }
    : { status: 'success', funil: rows, scope: scope };
}

function handleGetFunilById(spreadsheet, payload) {
  var user = requireUser(payload.user);
  var id = String(payload.id || '').trim();
  var rows = withCache('f_' + user.email, 180, function() {
    return readFunilRows(spreadsheet, user);
  });
  var found = rows.find(function(r) { return String(r.id) === id; });
  if (!found) { throw new Error('Registro nao encontrado.'); }
  return { status: 'success', funil: found };
}

// Lê o funil por índice de coluna (evita problemas de acesso por propriedade no GAS)
function readFunilRows(spreadsheet, user, dias) {
  var sheet = getSheet(spreadsheet, 'Funil');
  var data = sheet.getDataRange().getValues();
  if (data.length <= 1) return [];

  var hdrs = data[0].map(function(h) { return String(h).trim().toLowerCase(); });
  function col(names) {
    for (var i = 0; i < names.length; i++) {
      var idx = hdrs.indexOf(names[i].toLowerCase().trim());
      if (idx >= 0) return idx;
    }
    return -1;
  }

  var c = {
    id:    col(['Id', 'ID']),
    data:  col(['Data', 'DATA']),
    ativ:  col(['Ativo', 'ATIVO']),
    stat:  col(['Status', 'STATUS']),
    vend:  col(['Vendedor', 'VENDEDOR']),
    cli:   col(['Cliente', 'CLIENTE']),
    cid:   col(['Cidade', 'CIDADE']),
    foco:  col(['Foco', 'FOCO']),
    atua:  col(['Atuacao', 'ATUACAO']),
    apli:  col(['Aplicacao', 'APLICACAO']),
    equip: col(['Equipamentos', 'EQUIPAMENTOS']),
    ger:   col(['Gerencia', 'GERENCIA']),
    vl:    col(['Vl Mensal', 'VL MENSAL R$', 'Valor Mensal']),
    conc:  col(['Conclusao', 'CONCLUSAO']),
    inf:   col(['Inf Importantes', 'INF IMPORTANTES']),
    com:   col(['Comentarios', 'COMENTARIOS']),
    atualiz: col(['Atualizacao', 'ATUALIZACAO']),
    sync:  col(['SyncTimestamp', 'SYNCTIMESTAMP'])
  };

  function v(row, i) { return i >= 0 ? row[i] : ''; }
  function s(row, i) { return String(v(row, i) || ''); }
  function dt(val) {
    if (!val) return '';
    if (val instanceof Date && !isNaN(val)) return formatDate(val);
    return String(val);
  }

  var rows = data.slice(1).map(function(row) {
    var dataVal   = v(row, c.data);
    var atualizVal = v(row, c.atualiz);
    return {
      id:             s(row, c.id),
      data:           dt(dataVal),
      atualizacao:    dt(atualizVal) || dt(dataVal),
      ativo:          s(row, c.ativ),
      status:         s(row, c.stat),
      vendedor:       s(row, c.vend),
      cliente:        s(row, c.cli),
      cidade:         s(row, c.cid),
      foco:           s(row, c.foco),
      atuacao:        s(row, c.atua),
      aplicacao:      s(row, c.apli),
      equipamentos:   s(row, c.equip),
      gerencia:       s(row, c.ger),
      vlMensal:       s(row, c.vl),
      conclusao:      dt(v(row, c.conc)),
      infImportantes: s(row, c.inf),
      comentarios:    s(row, c.com),
      syncTimestamp:  Number(v(row, c.sync)) || 0
    };
  });

  var filtered = filterByUser(rows, user, 'funil');
  if (!dias || dias === 0) return filtered;
  var cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - dias);
  cutoff.setHours(0, 0, 0, 0);
  return filtered.filter(function(r) {
    var d = parseDate(r.data);
    return d !== null && d >= cutoff;
  });
}

function buildFunilRowData(headers, fields) {
  // Case-insensitive match between sheet headers and field map
  return headers.map(function(h) {
    var lh = h.toLowerCase().trim();
    var match = Object.keys(fields).find(function(k) { return k.toLowerCase().trim() === lh; });
    return match !== undefined ? fields[match] : '';
  });
}

function handleCreateFunil(spreadsheet, payload) {
  const user = verifyUser(spreadsheet, payload.user);
  if (!payload.cliente) { throw new Error('Cliente e obrigatorio.'); }

  const result = withLock(function() {
    const sheet = getSheet(spreadsheet, 'Funil');
    const headers = getHeaders(sheet);
    const rows = getSheetObjects(sheet);
    const id = getNextId(rows, 'Id');
    const today = formatDate(new Date());

    const fields = {
      'Id': id,
      'Data': today,
      'Atualizacao': today,
      'Ativo': 'Sim',
      'Status': payload.status || 'IDENTIFICAR',
      'Vendedor': user.name,
      'Cliente': payload.cliente,
      'Cidade': payload.cidade || '',
      'Foco': payload.foco || '',
      'Atuacao': payload.atuacao || '',
      'Aplicacao': payload.aplicacao || '',
      'Equipamentos': payload.equipamentos || '',
      'Gerencia': user.gerencia,
      'Vl Mensal': payload.vlMensal || '',
      'Conclusao': payload.conclusao ? formatDateFromInput(payload.conclusao) : '',
      'Inf Importantes': payload.infImportantes || '',
      'Comentarios': payload.comentarios || '',
      'SyncTimestamp': Date.now()
    };

    sheet.appendRow(buildFunilRowData(headers, fields));
    return { status: 'success', funil: normalizeFunilRow(fields) };
  });
  clearUserCaches(user.email);
  return result;
}

function handleUpdateFunil(spreadsheet, payload) {
  const user = verifyUser(spreadsheet, payload.user);
  const id = String(payload.id || '').trim();
  const result = withLock(function() {
    const sheet = getSheet(spreadsheet, 'Funil');
    const headers = getHeaders(sheet);
    const rows = getSheetObjects(sheet);
    const rowIndex = rows.findIndex(function(r) { return String(r.Id || r.ID || '') === id; });
    if (rowIndex === -1) { throw new Error('Registro nao encontrado para atualizacao.'); }
    const current = rows[rowIndex];
    // Find the actual key names used in this row (matches sheet headers)
    var statusKey   = Object.keys(current).find(function(k) { return k.toLowerCase() === 'status'; })   || 'Status';
    var vlKey       = Object.keys(current).find(function(k) { return k.toLowerCase().replace(/\s+/g,'') === 'vlmensal' || k.toLowerCase() === 'vl mensal r$'; }) || 'Vl Mensal';
    var conclusaoKey= Object.keys(current).find(function(k) { return k.toLowerCase().replace(/[^a-z]/g,'') === 'conclusao'; }) || 'Conclusao';
    var infKey      = Object.keys(current).find(function(k) { return k.toLowerCase().replace(/\s/g,'') === 'infimportantes'; }) || 'Inf Importantes';
    var comentKey   = Object.keys(current).find(function(k) { return k.toLowerCase().replace(/[^a-z]/g,'') === 'comentarios'; }) || 'Comentarios';
    var atualizKey  = Object.keys(current).find(function(k) { return k.toLowerCase().replace(/[^a-z]/g,'') === 'atualizacao'; }) || 'Atualizacao';
    var syncKey     = Object.keys(current).find(function(k) { return k.toLowerCase().replace(/[^a-z]/g,'') === 'synctimestamp'; }) || 'SyncTimestamp';
    if (payload.status !== undefined)         { current[statusKey]    = payload.status; }
    if (payload.vlMensal !== undefined)       { current[vlKey]        = payload.vlMensal; }
    if (payload.conclusao !== undefined)      { current[conclusaoKey] = payload.conclusao; }
    if (payload.infImportantes !== undefined) { current[infKey]       = payload.infImportantes; }
    if (payload.comentarios !== undefined)    { current[comentKey]    = payload.comentarios; }
    current[atualizKey] = formatDate(new Date());
    current[syncKey] = Date.now();
    sheet.getRange(rowIndex + 2, 1, 1, headers.length).setValues([
      headers.map(function(h) { return current[h] !== undefined ? current[h] : ''; })
    ]);
    return { status: 'success', funil: normalizeFunilRow(current) };
  });
  clearUserCaches(user.email);
  return result;
}

function normalizeFunilRow(row) {
  // JSON roundtrip converte o objeto GAS em um objeto JS puro,
  // garantindo que o acesso por chave funcione normalmente
  var r;
  try { r = JSON.parse(JSON.stringify(row)); } catch (e) { r = row; }

  function toDate(v) {
    if (!v) return '';
    if (Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v)) return formatDate(v);
    if (typeof v === 'string' && v.indexOf('T') > 0) {
      try { var d = new Date(v); if (!isNaN(d)) return formatDate(d); } catch (e2) {}
    }
    return String(v);
  }

  var dataVal    = r['Data']       || r['DATA']       || '';
  var atualizVal = r['Atualizacao']|| r['Atualização']|| r['ATUALIZACAO'] || '';
  return {
    id:             String(r['Id']            || r['ID']            || ''),
    data:           toDate(dataVal),
    atualizacao:    toDate(atualizVal) || toDate(dataVal),
    ativo:          String(r['Ativo']         || r['ATIVO']         || ''),
    status:         String(r['Status']        || r['STATUS']        || ''),
    vendedor:       String(r['Vendedor']      || r['VENDEDOR']      || ''),
    cliente:        String(r['Cliente']       || r['CLIENTE']       || ''),
    cidade:         String(r['Cidade']        || r['CIDADE']        || ''),
    foco:           String(r['Foco']          || r['FOCO']          || ''),
    atuacao:        String(r['Atuacao']       || r['ATUACAO']       || r['Área de Atuação'] || r['Area de Atuacao'] || ''),
    aplicacao:      String(r['Aplicacao']     || r['APLICACAO']     || r['Aplicação']       || ''),
    equipamentos:   String(r['Equipamentos']  || r['EQUIPAMENTOS']  || ''),
    gerencia:       String(r['Gerencia']      || r['GERENCIA']      || r['Gerência']        || ''),
    vlMensal:       String(r['Vl Mensal']     || r['VL MENSAL R$']  || r['Vl Mensal R$']   || r['Valor Mensal'] || ''),
    conclusao:      toDate(r['Conclusao']     || r['CONCLUSAO']     || r['Conclusão']       || ''),
    infImportantes: String(r['Inf Importantes']|| r['INF IMPORTANTES']|| ''),
    comentarios:    String(r['Comentarios']   || r['COMENTARIOS']   || r['Comentários']     || ''),
    syncTimestamp:  Number(r['SyncTimestamp'] || r['SYNCTIMESTAMP'] || 0)
  };
}

function enviarEmailsFunilAtrasados(spreadsheet, config) {
  var dias = Number(config.funil_dias) || 30;
  var assunto = config.funil_assunto || 'Oportunidade de funil sem atualizacao';
  var corpoTemplate = config.funil_corpo || '';
  var rows = getSheetObjects(getSheet(spreadsheet, 'Funil')).map(normalizeFunilRow);
  var sellers = getSheetObjects(getSheet(spreadsheet, 'Vendedores'));

  var atrasadosByEmail = {};
  rows.forEach(function(f) {
    if (String(f.ativo || '').toLowerCase() !== 'sim') { return; }
    if (['CONCLUIDO', 'PERDIDO'].includes(String(f.status || '').toUpperCase())) { return; }
    var dataRef = f.atualizacao || f.data;
    if (daysSinceDate(dataRef) <= dias) { return; }
    var sellerRow = sellers.find(function(s) {
      return String(s.NomeVendedor || '').trim() === String(f.vendedor || '').trim();
    });
    if (!sellerRow || !sellerRow.EmailLogin) { return; }
    var email = String(sellerRow.EmailLogin).trim();
    if (!atrasadosByEmail[email]) {
      atrasadosByEmail[email] = { nome: sellerRow.NomeVendedor || email, quantidade: 0 };
    }
    atrasadosByEmail[email].quantidade += 1;
  });

  Object.keys(atrasadosByEmail).forEach(function(email) {
    var data = atrasadosByEmail[email];
    var corpo = corpoTemplate
      .replace(/\{\{nome\}\}/g, data.nome)
      .replace(/\{\{quantidade\}\}/g, String(data.quantidade))
      .replace(/\{\{dias\}\}/g, String(dias));
    try {
      MailApp.sendEmail({ to: email, subject: assunto, body: corpo });
    } catch (e) {
      Logger.log('Erro ao enviar email funil para ' + email + ': ' + e.message);
    }
  });
}

function criarAbaFunil() {
  var spreadsheet = SpreadsheetApp.openById(SPREADSHEET_ID);

  if (spreadsheet.getSheetByName('Funil')) {
    Logger.log('A aba "Funil" ja existe. Nenhuma alteracao foi feita.');
    return;
  }

  var sheet = spreadsheet.insertSheet('Funil');

  var headers = [
    'Id', 'DATA', 'ATUALIZACAO', 'ATIVO', 'STATUS', 'VENDEDOR', 'CLIENTE',
    'CIDADE', 'FOCO', 'ATUACAO', 'APLICACAO', 'EQUIPAMENTOS', 'GERENCIA',
    'VL MENSAL R$', 'CONCLUSAO', 'INF IMPORTANTES', 'COMENTARIOS'
  ];

  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);

  var headerRange = sheet.getRange(1, 1, 1, headers.length);
  headerRange.setFontWeight('bold');
  headerRange.setBackground('#1a56db');
  headerRange.setFontColor('#ffffff');

  sheet.setFrozenRows(1);

  Logger.log('Aba "Funil" criada com sucesso!');
}
