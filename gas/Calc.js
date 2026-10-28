/**
 * Calc.js — rateio, saldos por moeda e acerto mínimo.
 *
 * Funções puras, sem APIs do Google: rodam no Apps Script (escopo global)
 * e no Node (testes em tests/calc.test.js).
 *
 * Valores sempre em unidades mínimas inteiras da moeda (centavos, ienes...).
 * Cada moeda é um livro separado: não há conversão entre moedas.
 */

var TIPOS = ['despesa', 'pagamento', 'acerto_cruzado'];
var CATEGORIAS = ['alimentação', 'transporte', 'hospedagem', 'passeios', 'mercado', 'farmácia', 'outros'];
var STATUS = ['confirmado', 'pendente'];
var ORIGENS = ['manual', 'extrato', 'comprovante'];
var MAX_FONTES = 3;
var RE_MOEDA = /^[A-Z]{3}$/;
var RE_DATA = /^(\d{4})-(\d{2})-(\d{2})$/;

// ---------------------------------------------------------------------------
// Parse de campos texto

/** "Ana; Bruno;" -> ["Ana", "Bruno"] */
function parseLista(texto) {
  if (texto === null || texto === undefined) return [];
  return String(texto).split(';').map(function (s) { return s.trim(); }).filter(Boolean);
}

/** Inteiro estritamente positivo (aceita string só com dígitos). */
function ehInteiroPositivo(v) {
  if (typeof v === 'number') return Number.isSafeInteger(v) && v > 0;
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) return ehInteiroPositivo(Number(v.trim()));
  return false;
}

/**
 * "USD:5000;EUR:2700" -> [{moeda:'USD', valor:5000}, {moeda:'EUR', valor:2700}]
 * Vazio -> []. Lança Error com mensagem legível se o formato for inválido.
 */
function parseFontes(texto) {
  var partes = parseLista(texto);
  if (partes.length > MAX_FONTES) {
    throw new Error('fontes: máximo ' + MAX_FONTES + ' fontes por despesa');
  }
  var vistas = {};
  return partes.map(function (parte) {
    var m = parte.split(':');
    if (m.length !== 2) {
      throw new Error('fontes: formato inválido em "' + parte + '" (use MOEDA:valor, ex.: USD:5000)');
    }
    var moeda = m[0].trim().toUpperCase();
    var bruto = m[1].trim();
    if (!RE_MOEDA.test(moeda)) {
      throw new Error('fontes: código de moeda inválido em "' + parte + '"');
    }
    if (!/^-?\d+$/.test(bruto) || !ehInteiroPositivo(bruto)) {
      throw new Error('fontes: em "' + parte + '" o valor deve ser um inteiro maior que zero');
    }
    if (vistas[moeda]) {
      throw new Error('fontes: moeda ' + moeda + ' repetida');
    }
    vistas[moeda] = true;
    return { moeda: moeda, valor: Number(bruto) };
  });
}

function formatarFontes(fontes) {
  return (fontes || []).map(function (f) { return f.moeda + ':' + f.valor; }).join(';');
}

/** "Ana:2;Bruno:1" -> {Ana: 2, Bruno: 1}. Vazio -> {} (divisão igual). */
function parsePesos(texto) {
  var pesos = {};
  parseLista(texto).forEach(function (parte) {
    var m = parte.split(':');
    var nome = (m[0] || '').trim();
    var bruto = (m[1] || '').trim();
    if (m.length !== 2 || !nome) {
      throw new Error('pesos: formato inválido em "' + parte + '" (use Nome:peso, ex.: Ana:2)');
    }
    if (!ehInteiroPositivo(bruto)) {
      throw new Error('pesos: o peso de ' + nome + ' deve ser um inteiro maior que zero');
    }
    if (pesos.hasOwnProperty(nome)) {
      throw new Error('pesos: ' + nome + ' aparece mais de uma vez');
    }
    pesos[nome] = Number(bruto);
  });
  return pesos;
}

function dataValida(texto) {
  var m = RE_DATA.exec(String(texto || ''));
  if (!m) return false;
  var a = Number(m[1]), mes = Number(m[2]), d = Number(m[3]);
  var dt = new Date(Date.UTC(a, mes - 1, d));
  return dt.getUTCFullYear() === a && dt.getUTCMonth() === mes - 1 && dt.getUTCDate() === d;
}

function ehVerdadeiro(v) {
  return v === true || String(v).trim().toUpperCase() === 'TRUE';
}

// ---------------------------------------------------------------------------
// Normalização e validação

/**
 * Converte uma linha crua (da planilha ou do cliente) num objeto com tipos
 * previsíveis. Não valida: valores inválidos são preservados para que
 * validarLancamento possa reportá-los.
 */
function normalizarLancamento(raw) {
  var texto = function (v) { return v === null || v === undefined ? '' : String(v).trim(); };
  var inteiro = function (v) {
    if (typeof v === 'number') return v;
    var t = texto(v);
    if (t === '') return '';
    return /^-?\d+$/.test(t) ? Number(t) : t;
  };
  return {
    id: texto(raw.id),
    tipo: texto(raw.tipo),
    data: texto(raw.data),
    descricao: texto(raw.descricao),
    categoria: texto(raw.categoria),
    moeda: texto(raw.moeda).toUpperCase(),
    valor: inteiro(raw.valor),
    fontes: texto(raw.fontes),
    pagador: texto(raw.pagador),
    participantes: texto(raw.participantes),
    pesos: texto(raw.pesos),
    moeda_paga: texto(raw.moeda_paga).toUpperCase(),
    valor_pago: inteiro(raw.valor_pago),
    status: texto(raw.status),
    origem: texto(raw.origem),
    criado_em: texto(raw.criado_em),
    criado_por: texto(raw.criado_por),
    editado_em: texto(raw.editado_em),
    editado_por: texto(raw.editado_por),
    excluido: ehVerdadeiro(raw.excluido),
  };
}

/**
 * Valida um lançamento. ctx = { participantes: [nomes], moedas: [códigos], categorias: [nomes] }
 * (categorias vazia ou ausente = a lista padrão CATEGORIAS).
 * Retorna a lista de erros legíveis (vazia = válido).
 */
function validarLancamento(raw, ctx) {
  var l = normalizarLancamento(raw);
  var erros = [];
  var nomes = ctx.participantes || [];
  var moedas = ctx.moedas || [];
  var conhecido = function (nome) { return nomes.indexOf(nome) >= 0; };
  var moedaOk = function (campo, codigo) {
    if (!codigo) erros.push(campo + ' é obrigatório');
    else if (moedas.indexOf(codigo) < 0) erros.push('moeda ' + codigo + ' não cadastrada (' + campo + ')');
  };

  if (!l.id) erros.push('id é obrigatório');
  if (TIPOS.indexOf(l.tipo) < 0) erros.push('tipo inválido: "' + l.tipo + '"');
  if (!dataValida(l.data)) erros.push('data inválida: "' + l.data + '" (use AAAA-MM-DD)');
  moedaOk('moeda', l.moeda);
  if (!ehInteiroPositivo(l.valor)) erros.push('valor deve ser um inteiro maior que zero (em unidades mínimas)');
  if (!l.pagador) erros.push('pagador é obrigatório');
  else if (!conhecido(l.pagador)) erros.push('pagador "' + l.pagador + '" não está na lista de participantes');
  if (l.status && STATUS.indexOf(l.status) < 0) erros.push('status inválido: "' + l.status + '"');
  if (!l.status) erros.push('status é obrigatório');
  if (l.origem && ORIGENS.indexOf(l.origem) < 0) erros.push('origem inválida: "' + l.origem + '"');

  var parts = parseLista(l.participantes);

  if (l.tipo === 'despesa') {
    if (!parts.length) erros.push('despesa precisa de pelo menos um participante');
    var vistos = {};
    parts.forEach(function (p) {
      if (!conhecido(p)) erros.push('participante "' + p + '" não está na lista de participantes');
      if (vistos[p]) erros.push('participante "' + p + '" repetido');
      vistos[p] = true;
    });
    var categorias = ctx.categorias && ctx.categorias.length ? ctx.categorias : CATEGORIAS;
    if (l.categoria && categorias.indexOf(l.categoria) < 0) {
      erros.push('categoria inválida: "' + l.categoria + '"');
    }
    try {
      var pesos = parsePesos(l.pesos);
      Object.keys(pesos).forEach(function (nome) {
        if (parts.indexOf(nome) < 0) erros.push('pesos: ' + nome + ' não participa desta despesa');
      });
    } catch (e) {
      erros.push(e.message);
    }
    try {
      parseFontes(l.fontes).forEach(function (f) { moedaOk('fontes', f.moeda); });
    } catch (e) {
      erros.push(e.message);
    }
    if (l.moeda_paga || l.valor_pago !== '') erros.push('moeda_paga/valor_pago só valem para acerto_cruzado');
  } else if (l.tipo === 'pagamento' || l.tipo === 'acerto_cruzado') {
    if (parts.length !== 1) {
      erros.push(l.tipo + ' precisa de exatamente um recebedor em participantes');
    } else {
      if (!conhecido(parts[0])) erros.push('recebedor "' + parts[0] + '" não está na lista de participantes');
      if (parts[0] === l.pagador) erros.push('quem paga e quem recebe não podem ser a mesma pessoa');
    }
    if (l.fontes) erros.push('fontes só vale para despesa');
    if (l.pesos) erros.push('pesos só vale para despesa');
    if (l.tipo === 'acerto_cruzado') {
      moedaOk('moeda_paga', l.moeda_paga);
      if (l.moeda_paga && l.moeda_paga === l.moeda) {
        erros.push('no acerto cruzado a moeda paga deve ser diferente da moeda da dívida');
      }
      if (!ehInteiroPositivo(l.valor_pago)) erros.push('valor_pago deve ser um inteiro maior que zero');
    } else if (l.moeda_paga || l.valor_pago !== '') {
      erros.push('moeda_paga/valor_pago só valem para acerto_cruzado');
    }
  }
  return erros;
}

// ---------------------------------------------------------------------------
// Cálculo

/** Ordena nomes pela ordem de Config; desconhecidos vão ao fim, em ordem alfabética. */
function ordenarNomes(nomes, ordem) {
  return nomes.slice().sort(function (a, b) {
    var ia = ordem.indexOf(a), ib = ordem.indexOf(b);
    if (ia < 0) ia = ordem.length;
    if (ib < 0) ib = ordem.length;
    if (ia !== ib) return ia - ib;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

/**
 * Divide `valor` entre `participantes` conforme `pesos` (ausente = peso 1).
 * A sobra da divisão inteira vai toda para o primeiro dos participantes na
 * ordem fixa `ordem` (a mesma regra do controle financeiro de quem é o primeiro
 * da lista, para os dois lados darem as mesmas partes). A soma das partes é
 * sempre exatamente `valor`.
 */
function ratear(valor, participantes, pesos, ordem) {
  var nomes = ordenarNomes(participantes, ordem || []);
  var peso = function (n) { return pesos && pesos[n] ? pesos[n] : 1; };
  var total = nomes.reduce(function (s, n) { return s + peso(n); }, 0);
  var partes = {};
  var soma = 0;
  nomes.forEach(function (n) {
    var produto = valor * peso(n);
    partes[n] = (produto - (produto % total)) / total; // divisão inteira exata
    soma += partes[n];
  });
  if (nomes.length) partes[nomes[0]] += valor - soma;
  return partes;
}

/**
 * Lançamento -> pernas { tipo, moeda, valor, pagador, participantes, pesos }.
 * Despesa sem fontes: uma perna na moeda da compra. Com fontes: uma perna
 * por fonte (a compra vira só descrição). Pagamento/acerto: uma perna no
 * livro da dívida (moeda_paga é só histórico).
 */
function expandirPernas(l) {
  var base = {
    pagador: l.pagador,
    participantes: parseLista(l.participantes),
    pesos: l.tipo === 'despesa' ? parsePesos(l.pesos) : {},
    tipo: l.tipo,
  };
  var fontes = l.tipo === 'despesa' ? parseFontes(l.fontes) : [];
  if (!fontes.length) fontes = [{ moeda: l.moeda, valor: Number(l.valor) }];
  return fontes.map(function (f) {
    return {
      moeda: f.moeda,
      valor: f.valor,
      pagador: base.pagador,
      participantes: base.participantes.slice(),
      pesos: base.pesos,
      tipo: base.tipo,
    };
  });
}

/**
 * Saldo líquido (pago − devido) por pessoa, separado por moeda.
 * Recebe pernas já expandidas. Positivo = tem a receber.
 */
function saldosDasPernas(pernas, ordem) {
  var saldos = {};
  pernas.forEach(function (p) {
    var s = saldos[p.moeda] || (saldos[p.moeda] = {});
    var somar = function (nome, v) { s[nome] = (s[nome] || 0) + v; };
    somar(p.pagador, p.valor);
    if (p.tipo === 'despesa') {
      var partes = ratear(p.valor, p.participantes, p.pesos, ordem);
      Object.keys(partes).forEach(function (n) { somar(n, -partes[n]); });
    } else {
      somar(p.participantes[0], -p.valor);
    }
  });
  Object.keys(saldos).forEach(function (moeda) {
    var soma = 0;
    Object.keys(saldos[moeda]).forEach(function (n) { soma += saldos[moeda][n]; });
    if (soma !== 0) throw new Error('Invariante violada: saldos em ' + moeda + ' somam ' + soma);
  });
  return saldos;
}

/**
 * Acerto mínimo guloso de um livro: casa repetidamente o maior devedor com o
 * maior credor. Desempate pela ordem dos participantes.
 */
function acertoMinimo(saldos, ordem) {
  var nomes = ordenarNomes(Object.keys(saldos), ordem || []);
  var s = {};
  nomes.forEach(function (n) { s[n] = saldos[n]; });
  var transferencias = [];
  for (;;) {
    var devedor = null, credor = null;
    nomes.forEach(function (n) {
      if (s[n] < 0 && (devedor === null || s[n] < s[devedor])) devedor = n;
      if (s[n] > 0 && (credor === null || s[n] > s[credor])) credor = n;
    });
    if (devedor === null || credor === null) break;
    var v = Math.min(-s[devedor], s[credor]);
    transferencias.push({ de: devedor, para: credor, valor: v });
    s[devedor] += v;
    s[credor] -= v;
  }
  return transferencias;
}

/** Agrupa as transferências de todas as moedas por par de pessoas (só apresentação). */
function agruparPorPar(transferenciasPorMoeda, ordem) {
  var pares = {};
  var lista = [];
  Object.keys(transferenciasPorMoeda).forEach(function (moeda) {
    transferenciasPorMoeda[moeda].forEach(function (t) {
      var chave = t.de + '\u0000' + t.para;
      if (!pares[chave]) {
        pares[chave] = { de: t.de, para: t.para, valores: {} };
        lista.push(pares[chave]);
      }
      pares[chave].valores[moeda] = (pares[chave].valores[moeda] || 0) + t.valor;
    });
  });
  var pos = function (n) { var i = ordem.indexOf(n); return i < 0 ? ordem.length : i; };
  return lista.sort(function (a, b) {
    return (pos(a.de) - pos(b.de)) || (a.de < b.de ? -1 : a.de > b.de ? 1 : 0) ||
      (pos(a.para) - pos(b.para)) || (a.para < b.para ? -1 : a.para > b.para ? 1 : 0);
  });
}

function ordenarMoedas(codigos, ordemMoedas) {
  return ordenarNomes(codigos, ordemMoedas || []);
}

/**
 * Cálculo completo a partir das linhas de Lancamentos.
 * ctx = { participantes: [ordem fixa], moedas: [códigos na ordem cadastrada] }
 */
function calcularEstado(linhas, ctx) {
  var ordem = ctx.participantes || [];
  var invalidos = [];
  var pendentes = 0;
  var pernas = [];
  linhas.forEach(function (raw) {
    var l = normalizarLancamento(raw);
    if (l.excluido) return;
    var erros = validarLancamento(l, ctx);
    if (erros.length) {
      invalidos.push({ id: l.id, erros: erros });
      return;
    }
    if (l.status === 'pendente') pendentes += 1;
    if (l.status !== 'confirmado') return;
    pernas = pernas.concat(expandirPernas(l));
  });

  var brutos = saldosDasPernas(pernas, ordem);
  var moedas = ordenarMoedas(Object.keys(brutos), ctx.moedas);

  var totais = {};
  pernas.forEach(function (p) {
    if (p.tipo === 'despesa') totais[p.moeda] = (totais[p.moeda] || 0) + p.valor;
  });

  var saldosPorMoeda = {};
  var transferenciasPorMoeda = {};
  var totaisPorMoeda = {};
  moedas.forEach(function (moeda) {
    var nomes = ordenarNomes(ordem.concat(Object.keys(brutos[moeda]).filter(function (n) {
      return ordem.indexOf(n) < 0;
    })), ordem);
    var s = {};
    nomes.forEach(function (n) { s[n] = brutos[moeda][n] || 0; });
    saldosPorMoeda[moeda] = s;
    transferenciasPorMoeda[moeda] = acertoMinimo(s, ordem);
    if (totais[moeda]) totaisPorMoeda[moeda] = totais[moeda];
  });

  return {
    saldos_por_moeda: saldosPorMoeda,
    transferencias_por_moeda: transferenciasPorMoeda,
    totais_por_moeda: totaisPorMoeda,
    por_par: agruparPorPar(transferenciasPorMoeda, ordem),
    pendentes: pendentes,
    invalidos: invalidos,
  };
}

if (typeof module !== 'undefined') {
  module.exports = {
    TIPOS: TIPOS,
    CATEGORIAS: CATEGORIAS,
    STATUS: STATUS,
    ORIGENS: ORIGENS,
    parseLista: parseLista,
    parseFontes: parseFontes,
    formatarFontes: formatarFontes,
    parsePesos: parsePesos,
    dataValida: dataValida,
    normalizarLancamento: normalizarLancamento,
    validarLancamento: validarLancamento,
    ordenarNomes: ordenarNomes,
    ratear: ratear,
    expandirPernas: expandirPernas,
    saldosDasPernas: saldosDasPernas,
    acertoMinimo: acertoMinimo,
    agruparPorPar: agruparPorPar,
    calcularEstado: calcularEstado,
  };
}
