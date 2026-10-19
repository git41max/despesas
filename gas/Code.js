/**
 * Code.js — Web App do Apps Script: roteamento, validação e I/O na planilha.
 * Toda a lógica de cálculo está em Calc.js (mesmo escopo global).
 *
 * GET  ?acao=estado&token=...
 * POST {acao, token, autor, dados}  (Content-Type: text/plain para evitar preflight)
 */

var ABA_CONFIG = 'Config';
var ABA_MOEDAS = 'Moedas';
var ABA_LANCAMENTOS = 'Lancamentos';
var ABA_RESUMO = 'Resumo';

var COLUNAS = [
  'id', 'tipo', 'data', 'descricao', 'categoria', 'moeda', 'valor', 'fontes', 'pagador',
  'participantes', 'pesos', 'moeda_paga', 'valor_pago', 'status', 'origem',
  'criado_em', 'criado_por', 'editado_em', 'editado_por', 'excluido',
];
var COLUNAS_NUMERICAS = ['valor', 'valor_pago'];
// Campos que o cliente pode definir ao criar/editar.
var CAMPOS_DADOS = [
  'tipo', 'data', 'descricao', 'categoria', 'moeda', 'valor', 'fontes', 'pagador',
  'participantes', 'pesos', 'moeda_paga', 'valor_pago', 'status', 'origem',
];

// ---------------------------------------------------------------------------
// Entrada HTTP

function doGet(e) {
  return executar(function () {
    var p = (e && e.parameter) || {};
    verificarToken(p.token);
    if (p.acao === 'estado') return montarEstado(planilha());
    throw erroUsuario('ação desconhecida: ' + p.acao);
  });
}

function doPost(e) {
  return executar(function () {
    var corpo;
    try {
      corpo = JSON.parse((e && e.postData && e.postData.contents) || '');
    } catch (err) {
      throw erroUsuario('corpo da requisição não é JSON válido');
    }
    verificarToken(corpo.token);
    var ss = planilha();
    var config = lerConfig(ss);
    var autor = String(corpo.autor || '').trim();
    if (config.participantes.indexOf(autor) < 0) {
      throw erroUsuario('autor "' + autor + '" não está na lista de participantes');
    }
    var dados = corpo.dados || {};
    var acoes = {
      criar: criar,
      editar: editar,
      excluir: excluir,
      confirmar: confirmar,
      moeda: cadastrarMoeda,
    };
    var fn = acoes[corpo.acao];
    if (!fn) throw erroUsuario('ação desconhecida: ' + corpo.acao);

    var lock = LockService.getScriptLock();
    try {
      lock.waitLock(10000);
    } catch (err) {
      var ocupado = erroUsuario('servidor ocupado, tente de novo em instantes');
      ocupado.temporario = true;
      throw ocupado;
    }
    try {
      var resultado = fn(ss, config, autor, dados);
      SpreadsheetApp.flush();
      atualizarResumo(ss);
      return resultado;
    } finally {
      lock.releaseLock();
    }
  });
}

function executar(fn) {
  var resposta;
  try {
    resposta = fn();
    resposta.ok = true;
  } catch (err) {
    resposta = { ok: false, erro: err.usuario ? err.message : 'erro interno: ' + err.message };
    if (err.temporario) resposta.temporario = true;
    if (err.codigo) resposta.codigo = err.codigo;
    if (!err.usuario) console.error(err && err.stack ? err.stack : err);
  }
  return ContentService.createTextOutput(JSON.stringify(resposta))
    .setMimeType(ContentService.MimeType.JSON);
}

function erroUsuario(msg) {
  var e = new Error(msg);
  e.usuario = true;
  return e;
}

function verificarToken(token) {
  var esperado = PropertiesService.getScriptProperties().getProperty('TOKEN');
  if (!esperado) {
    var e = erroUsuario('token não configurado no servidor (rode configurarPlanilha)');
    e.codigo = 'token_invalido';
    throw e;
  }
  if (!token || String(token) !== esperado) {
    var inv = erroUsuario('token inválido: abra de novo o link da viagem');
    inv.codigo = 'token_invalido';
    throw inv;
  }
}

// ---------------------------------------------------------------------------
// Leitura da planilha

function planilha() {
  var id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
}

function aba(ss, nome) {
  var sh = ss.getSheetByName(nome);
  if (!sh) throw erroUsuario('aba "' + nome + '" não encontrada (rode configurarPlanilha)');
  return sh;
}

/** Aba Config como { chave: valor }, sem interpretar. */
function lerConfigBruta(ss) {
  var valores = aba(ss, ABA_CONFIG).getDataRange().getValues();
  var cfg = {};
  valores.forEach(function (linha) {
    var chave = String(linha[0] || '').trim();
    if (chave) cfg[chave] = linha[1];
  });
  return cfg;
}

function lerConfig(ss) {
  var cfg = lerConfigBruta(ss);
  return {
    nome_viagem: String(cfg.nome_viagem || '').trim(),
    participantes: parseLista(cfg.participantes),
    categorias: parseLista(cfg.categorias), // opcional; vazia = lista padrão (CATEGORIAS)
  };
}

function lerMoedas(ss) {
  var valores = aba(ss, ABA_MOEDAS).getDataRange().getValues();
  var cab = valores.shift().map(function (h) { return String(h).trim(); });
  var iM = cab.indexOf('moeda'), iC = cab.indexOf('casas_decimais'), iS = cab.indexOf('simbolo');
  if (iM < 0 || iC < 0 || iS < 0) throw erroUsuario('aba Moedas precisa das colunas moeda, casas_decimais, simbolo');
  return valores
    .filter(function (l) { return String(l[iM]).trim(); })
    .map(function (l) {
      var moeda = String(l[iM]).trim().toUpperCase();
      return {
        moeda: moeda,
        casas_decimais: Number(l[iC]) || 0,
        simbolo: String(l[iS] || '').trim() || moeda,
      };
    });
}

/** Lê Lancamentos localizando colunas pelo nome do cabeçalho. */
function lerLancamentos(ss) {
  var sh = aba(ss, ABA_LANCAMENTOS);
  var valores = sh.getDataRange().getValues();
  var cab = (valores.shift() || []).map(function (h) { return String(h).trim(); });
  COLUNAS.forEach(function (c) {
    if (cab.indexOf(c) < 0) throw erroUsuario('coluna "' + c + '" não encontrada em Lancamentos');
  });
  var fuso = ss.getSpreadsheetTimeZone();
  var linhas = [];
  var linhaPorId = {};
  valores.forEach(function (vals, i) {
    var obj = {};
    cab.forEach(function (c, j) {
      if (!c) return;
      var v = vals[j];
      if (v instanceof Date) {
        v = c === 'data'
          ? Utilities.formatDate(v, fuso, 'yyyy-MM-dd')
          : Utilities.formatDate(v, fuso, "yyyy-MM-dd'T'HH:mm:ssXXX");
      }
      obj[c] = v;
    });
    var id = String(obj.id || '').trim();
    if (!id && !String(obj.tipo || '').trim()) return; // linha vazia
    linhas.push(obj);
    if (id) linhaPorId[id] = i + 2; // +1 cabeçalho, +1 base 1
  });
  return { aba: sh, cabecalho: cab, linhas: linhas, linhaPorId: linhaPorId };
}

function contexto(config, moedas) {
  return {
    participantes: config.participantes,
    moedas: moedas.map(function (m) { return m.moeda; }),
    categorias: config.categorias,
  };
}

function montarEstado(ss) {
  var config = lerConfig(ss);
  var moedas = lerMoedas(ss);
  var lanc = lerLancamentos(ss);
  var calc = calcularEstado(lanc.linhas, contexto(config, moedas));
  var lancamentos = lanc.linhas
    .map(normalizarLancamento)
    .filter(function (l) { return !l.excluido; });
  return {
    nome_viagem: config.nome_viagem,
    participantes: config.participantes,
    categorias: config.categorias.length ? config.categorias : CATEGORIAS,
    moedas: moedas,
    lancamentos: lancamentos,
    saldos_por_moeda: calc.saldos_por_moeda,
    transferencias_por_moeda: calc.transferencias_por_moeda,
    totais_por_moeda: calc.totais_por_moeda,
    por_par: calc.por_par,
    pendentes: calc.pendentes,
    invalidos: calc.invalidos,
    atualizado_em: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Escrita

/** Copia só os campos permitidos, aceitando listas como array. */
function limparDados(dados) {
  var l = {};
  CAMPOS_DADOS.forEach(function (c) {
    var v = dados[c];
    if (Array.isArray(v)) v = v.join(';');
    l[c] = v === undefined || v === null ? '' : v;
  });
  l = normalizarLancamento(l);
  if (!l.status) l.status = 'confirmado';
  if (!l.origem) l.origem = 'manual';
  return l;
}

function validarOuFalhar(l, config, ss) {
  var erros = validarLancamento(l, contexto(config, lerMoedas(ss)));
  if (erros.length) throw erroUsuario(erros.join('; '));
}

/** Grava `obj` na linha `numLinha`; colunas extras da planilha mantêm o valor de `base`. */
function escreverLinha(lanc, numLinha, obj, base) {
  var linha = lanc.cabecalho.map(function (c) {
    if (c && obj.hasOwnProperty(c)) return obj[c];
    return base && base[c] !== undefined ? base[c] : '';
  });
  lanc.aba.getRange(numLinha, 1, 1, linha.length).setValues([linha]);
}

function criar(ss, config, autor, dados) {
  var id = String(dados.id || '').trim();
  if (!id) throw erroUsuario('id é obrigatório');
  var lanc = lerLancamentos(ss);
  if (lanc.linhaPorId[id]) return { id: id, duplicado: true }; // idempotência
  var l = limparDados(dados);
  l.id = id;
  validarOuFalhar(l, config, ss);
  l.criado_em = new Date().toISOString();
  l.criado_por = autor;
  l.editado_em = '';
  l.editado_por = '';
  l.excluido = false;
  escreverLinha(lanc, lanc.aba.getLastRow() + 1, l);
  return { id: id };
}

function obterExistente(lanc, id) {
  id = String(id || '').trim();
  var num = lanc.linhaPorId[id];
  if (!num) throw erroUsuario('lançamento ' + id + ' não encontrado');
  var bruto = lanc.linhas.filter(function (x) { return String(x.id).trim() === id; })[0];
  return { num: num, bruto: bruto, atual: normalizarLancamento(bruto) };
}

function editar(ss, config, autor, dados) {
  var lanc = lerLancamentos(ss);
  var ex = obterExistente(lanc, dados.id);
  var l = limparDados(dados);
  l.id = ex.atual.id;
  if (!dados.status) l.status = ex.atual.status || 'confirmado';
  if (!dados.origem) l.origem = ex.atual.origem || 'manual';
  validarOuFalhar(l, config, ss);
  l.criado_em = ex.atual.criado_em;
  l.criado_por = ex.atual.criado_por;
  l.editado_em = new Date().toISOString();
  l.editado_por = autor;
  l.excluido = ex.atual.excluido;
  escreverLinha(lanc, ex.num, l, ex.bruto);
  return { id: l.id };
}

function excluir(ss, config, autor, dados) {
  var lanc = lerLancamentos(ss);
  var ex = obterExistente(lanc, dados.id);
  var l = ex.atual;
  if (l.excluido) return { id: l.id };
  l.excluido = true;
  l.editado_em = new Date().toISOString();
  l.editado_por = autor;
  escreverLinha(lanc, ex.num, l, ex.bruto);
  return { id: l.id };
}

function confirmar(ss, config, autor, dados) {
  var ids = Array.isArray(dados.ids) ? dados.ids : [dados.id];
  var lanc = lerLancamentos(ss);
  var ctx = contexto(config, lerMoedas(ss));
  var erros = [];
  var confirmados = [];
  ids.forEach(function (id) {
    var ex = obterExistente(lanc, id);
    var l = ex.atual;
    if (l.excluido || l.status === 'confirmado') return;
    l.status = 'confirmado';
    var e = validarLancamento(l, ctx);
    if (e.length) {
      erros.push(l.id + ': ' + e.join('; '));
      return;
    }
    l.editado_em = new Date().toISOString();
    l.editado_por = autor;
    escreverLinha(lanc, ex.num, l, ex.bruto);
    confirmados.push(l.id);
  });
  if (erros.length && !confirmados.length) throw erroUsuario(erros.join(' | '));
  return { confirmados: confirmados, erros: erros };
}

function cadastrarMoeda(ss, config, autor, dados) {
  var moeda = String(dados.moeda || '').trim().toUpperCase();
  var casas = Number(dados.casas_decimais);
  var simbolo = String(dados.simbolo || '').trim() || moeda;
  if (!/^[A-Z]{3}$/.test(moeda)) throw erroUsuario('código de moeda inválido (use 3 letras ISO 4217, ex.: USD)');
  if (!Number.isInteger(casas) || casas < 0 || casas > 4) throw erroUsuario('casas decimais deve ser de 0 a 4');
  var existentes = lerMoedas(ss);
  if (existentes.some(function (m) { return m.moeda === moeda; })) return { moeda: moeda, existente: true };
  aba(ss, ABA_MOEDAS).appendRow([moeda, casas, simbolo]);
  return { moeda: moeda };
}

// ---------------------------------------------------------------------------
// Resumo (somente leitura para humanos)

function atualizarResumo(ss) {
  var est = montarEstado(ss);
  var casas = {};
  est.moedas.forEach(function (m) { casas[m.moeda] = m.casas_decimais; });
  var dec = function (moeda, v) { return v / Math.pow(10, casas[moeda] || 0); };
  var formato = function (moeda) {
    var c = casas[moeda] || 0;
    return c ? '#,##0.' + new Array(c + 1).join('0') : '#,##0';
  };
  var moedasUsadas = Object.keys(est.saldos_por_moeda);

  var linhas = [];
  var formatos = []; // [linha, coluna, formato]
  var titulos = [];
  var push = function (vals) { linhas.push(vals); return linhas.length; };

  titulos.push(push(['Resumo — ' + (est.nome_viagem || 'viagem')]));
  push(['Atualizado em ' + Utilities.formatDate(new Date(), ss.getSpreadsheetTimeZone(), 'dd/MM/yyyy HH:mm') +
    '. Esta aba é reescrita pelo script; não edite.']);
  push(['']);

  titulos.push(push(['Total desembolsado por moeda']));
  push(['Moeda', 'Total']);
  Object.keys(est.totais_por_moeda).forEach(function (m) {
    var n = push([m, dec(m, est.totais_por_moeda[m])]);
    formatos.push([n, 2, formato(m)]);
  });
  push(['']);

  titulos.push(push(['Saldo líquido por pessoa (positivo = tem a receber)']));
  push(['Pessoa'].concat(moedasUsadas));
  est.participantes.forEach(function (p) {
    var n = push([p].concat(moedasUsadas.map(function (m) {
      return dec(m, est.saldos_por_moeda[m][p] || 0);
    })));
    moedasUsadas.forEach(function (m, j) { formatos.push([n, j + 2, formato(m)]); });
  });
  push(['']);

  titulos.push(push(['Transferências sugeridas']));
  push(['Moeda', 'De', 'Para', 'Valor']);
  moedasUsadas.forEach(function (m) {
    est.transferencias_por_moeda[m].forEach(function (t) {
      var n = push([m, t.de, t.para, dec(m, t.valor)]);
      formatos.push([n, 4, formato(m)]);
    });
  });
  if (est.pendentes) {
    push(['']);
    push([est.pendentes + ' lançamento(s) pendente(s) não entram no cálculo.']);
  }
  if (est.invalidos.length) {
    push(['']);
    titulos.push(push(['Linhas ignoradas por erro em Lancamentos']));
    est.invalidos.forEach(function (x) { push([x.id || '(sem id)', x.erros.join('; ')]); });
  }

  var largura = linhas.reduce(function (w, l) { return Math.max(w, l.length); }, 1);
  var matriz = linhas.map(function (l) {
    var c = l.slice();
    while (c.length < largura) c.push('');
    return c;
  });
  var sh = ss.getSheetByName(ABA_RESUMO) || ss.insertSheet(ABA_RESUMO);
  sh.clear();
  sh.getRange(1, 1, matriz.length, largura).setValues(matriz);
  formatos.forEach(function (f) { sh.getRange(f[0], f[1]).setNumberFormat(f[2]); });
  titulos.forEach(function (n) { sh.getRange(n, 1).setFontWeight('bold'); });
}

// ---------------------------------------------------------------------------
// Configuração (rodar pelo editor do Apps Script ou pelo menu da planilha)

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Despesas')
    .addItem('Configurar planilha', 'configurarPlanilha')
    .addItem('Recalcular resumo', 'recalcularResumo')
    .addItem('Mostrar link de convite', 'mostrarToken')
    .addItem('Gerar novo token', 'gerarNovoToken')
    .addToUi();
}

/**
 * Cria as abas que faltam com cabeçalho e formatos, e gera o token se ainda
 * não existir. Pode ser rodada de novo sem perder dados.
 */
function configurarPlanilha() {
  var ss = planilha();

  var cfg = ss.getSheetByName(ABA_CONFIG);
  if (!cfg) {
    cfg = ss.insertSheet(ABA_CONFIG);
    cfg.getRange(1, 1, 5, 2).setValues([
      ['chave', 'valor'],
      ['nome_viagem', 'Minha viagem'],
      ['token', ''],
      ['participantes', 'Ana;Bruno;Carla'],
      ['url_app', ''],
    ]);
    cfg.getRange('A:B').setNumberFormat('@');
    cfg.setFrozenRows(1);
  }

  var moe = ss.getSheetByName(ABA_MOEDAS);
  if (!moe) {
    moe = ss.insertSheet(ABA_MOEDAS);
    moe.getRange(1, 1, 4, 3).setValues([
      ['moeda', 'casas_decimais', 'simbolo'],
      ['BRL', 2, 'R$'],
      ['USD', 2, 'US$'],
      ['EUR', 2, '€'],
    ]);
    moe.setFrozenRows(1);
  }

  var lan = ss.getSheetByName(ABA_LANCAMENTOS);
  if (!lan) {
    lan = ss.insertSheet(ABA_LANCAMENTOS);
    lan.getRange(1, 1, 1, COLUNAS.length).setValues([COLUNAS]).setFontWeight('bold');
    lan.setFrozenRows(1);
    // Texto puro em tudo, para o Sheets não converter datas e "USD:5000";
    // números só nas colunas de valor.
    lan.getRange(2, 1, lan.getMaxRows() - 1, COLUNAS.length).setNumberFormat('@');
    COLUNAS_NUMERICAS.forEach(function (c) {
      var j = COLUNAS.indexOf(c) + 1;
      lan.getRange(2, j, lan.getMaxRows() - 1, 1).setNumberFormat('0');
    });
  }

  if (!ss.getSheetByName(ABA_RESUMO)) ss.insertSheet(ABA_RESUMO);

  if (!PropertiesService.getScriptProperties().getProperty('TOKEN')) gerarNovoToken();
  atualizarResumo(ss);
}

/** Grava chave | valor na aba Config, na linha da chave ou numa nova no fim. */
function gravarConfig(ss, chave, valor) {
  var sh = aba(ss, ABA_CONFIG);
  var valores = sh.getDataRange().getValues();
  var linha = -1;
  valores.forEach(function (l, i) { if (String(l[0]).trim() === chave) linha = i + 1; });
  if (linha < 0) linha = sh.getLastRow() + 1;
  sh.getRange(linha, 1, 1, 2).setNumberFormat('@').setValues([[chave, valor]]);
}

/** Gera token novo e grava em Config e nas Script Properties (o link antigo deixa de valer). */
function gerarNovoToken() {
  var token = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  PropertiesService.getScriptProperties().setProperty('TOKEN', token);
  gravarConfig(planilha(), 'token', token);
  console.log('Novo token gerado. Para o link: Despesas > Mostrar link de convite.');
  return token;
}

// ---------------------------------------------------------------------------
// Link de convite

function urlApiValida(url) {
  return /^https:\/\/script\.google\.com\/\S+\/exec$/.test(String(url || '').trim());
}

function urlAppValida(url) {
  return /^https?:\/\/[^\s#]+$/.test(String(url || '').trim().split('#')[0]);
}

/** <app>#t=<token>&api=<URL /exec codificada>, o formato lido pelo app. */
function montarLinkConvite(urlApp, token, urlApi) {
  var base = String(urlApp).trim().split('#')[0];
  if (!/\/$/.test(base) && !/\.html?$/.test(base)) base += '/';
  return base + '#t=' + encodeURIComponent(token) + '&api=' + encodeURIComponent(String(urlApi).trim());
}

/**
 * URL /exec da implantação: a de Config.url_api ('' se faltar; o menu pergunta).
 * Não usa ScriptApp.getService().getUrl(): numa planilha (Casa, 10/2026) ela devolveu
 * uma URL /exec de formato válido que não era de nenhuma implantação (404), e o link
 * de convite saiu errado sem aviso.
 */
function urlDaApi(cfg) {
  var salva = String(cfg.url_api || '').trim();
  return urlApiValida(salva) ? salva : '';
}

function perguntar(ui, titulo, texto) {
  var r = ui.prompt(titulo, texto, ui.ButtonSet.OK_CANCEL);
  return r.getSelectedButton() === ui.Button.OK ? r.getResponseText().trim() : '';
}

/** Menu Despesas > Mostrar link de convite: monta o link completo, perguntando o que faltar. */
function mostrarToken() {
  var ui = SpreadsheetApp.getUi();
  var ss = planilha();
  var token = PropertiesService.getScriptProperties().getProperty('TOKEN') || gerarNovoToken();
  var cfg = lerConfigBruta(ss);

  var urlApp = String(cfg.url_app || '').trim();
  if (!urlAppValida(urlApp)) {
    urlApp = perguntar(ui, 'Endereço do app',
      'Cole o endereço do app no GitHub Pages (ex.: https://usuario.github.io/despesas/). Fica salvo em Config.url_app.');
    if (!urlApp) return;
    if (!urlAppValida(urlApp)) return ui.alert('Endereço do app', 'O endereço precisa começar com https://.', ui.ButtonSet.OK);
    gravarConfig(ss, 'url_app', urlApp);
  }

  var urlApi = urlDaApi(cfg);
  if (!urlApi) {
    urlApi = perguntar(ui, 'Endereço da API',
      'Em Implantar > Gerenciar implantações, copie a URL do App da Web (termina em /exec) e cole aqui. Fica salva em Config.url_api (para trocar, edite ou apague a linha url_api).');
    if (!urlApi) return;
    if (!urlApiValida(urlApi)) {
      return ui.alert('Endereço da API', 'A URL precisa começar com https://script.google.com/ e terminar em /exec.', ui.ButtonSet.OK);
    }
    gravarConfig(ss, 'url_api', urlApi);
  }

  ui.showModalDialog(dialogoLink(montarLinkConvite(urlApp, token, urlApi)), 'Link de convite');
}

function dialogoLink(link) {
  var esc = link.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  return HtmlService.createHtmlOutput(
    '<div style="font-family:sans-serif;font-size:14px">' +
    '<p>Envie este link ao grupo. Quem abrir no celular entra direto na viagem.</p>' +
    '<textarea id="l" readonly rows="5" style="width:100%;box-sizing:border-box;font-size:13px">' + esc + '</textarea>' +
    '<p><button id="b" style="font-size:15px;padding:8px 16px">Copiar</button> <span id="s"></span></p></div>' +
    '<script>' +
    'var l = document.getElementById("l");' +
    'function sel() { l.focus(); l.select(); l.setSelectionRange(0, l.value.length); }' +
    'sel();' +
    'document.getElementById("b").onclick = function () {' +
    '  sel(); var ok = false; try { ok = document.execCommand("copy"); } catch (e) {}' +
    '  document.getElementById("s").textContent = ok ? "Copiado." : "Selecione o texto e copie.";' +
    '};' +
    '</script>'
  ).setWidth(460).setHeight(260);
}

function recalcularResumo() {
  atualizarResumo(planilha());
}
