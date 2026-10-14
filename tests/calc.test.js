'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Calc = require('../gas/Calc.js');

const ORDEM = ['Ana', 'Bruno', 'Carla'];
const MOEDAS = ['BRL', 'USD', 'EUR', 'JPY'];
const CTX = { participantes: ORDEM, moedas: MOEDAS };

let seq = 0;
function despesa(campos) {
  seq += 1;
  return Object.assign({
    id: 'd' + seq,
    tipo: 'despesa',
    data: '2026-10-01',
    descricao: 'teste',
    categoria: '',
    moeda: 'BRL',
    valor: 0,
    fontes: '',
    pagador: 'Ana',
    participantes: 'Ana;Bruno;Carla',
    pesos: '',
    moeda_paga: '',
    valor_pago: '',
    status: 'confirmado',
    origem: 'manual',
    excluido: false,
  }, campos);
}

function pagamento(campos) {
  return despesa(Object.assign({ tipo: 'pagamento', participantes: 'Ana', pagador: 'Bruno' }, campos));
}

function acertoCruzado(campos) {
  return despesa(Object.assign({ tipo: 'acerto_cruzado', participantes: 'Ana', pagador: 'Bruno' }, campos));
}

function somaDe(obj) {
  return Object.keys(obj).reduce((s, k) => s + obj[k], 0);
}

// ---------------------------------------------------------------------------
// Rateio

test('divisão com resto: R$ 100,00 por 3 vai a sobra para o primeiro da ordem', () => {
  const partes = Calc.ratear(10000, ['Carla', 'Bruno', 'Ana'], null, ORDEM);
  assert.deepEqual(partes, { Ana: 3334, Bruno: 3333, Carla: 3333 });
  assert.equal(somaDe(partes), 10000);
});

test('divisão com resto maior que 1 distribui uma unidade por pessoa na ordem', () => {
  const partes = Calc.ratear(11, ORDEM, null, ORDEM);
  assert.deepEqual(partes, { Ana: 4, Bruno: 4, Carla: 3 });
});

test('rateio com pesos', () => {
  const partes = Calc.ratear(10000, ['Ana', 'Bruno'], { Ana: 2, Bruno: 1 }, ORDEM);
  // 6666,66 e 3333,33 -> pisos 6666 e 3333, sobra 1 para Ana (primeira da ordem)
  assert.deepEqual(partes, { Ana: 6667, Bruno: 3333 });
});

test('pesos parciais: quem não aparece em pesos tem peso 1', () => {
  const partes = Calc.ratear(400, ORDEM, { Ana: 2 }, ORDEM);
  assert.deepEqual(partes, { Ana: 200, Bruno: 100, Carla: 100 });
});

test('rateio preserva a soma em muitos casos', () => {
  for (let valor = 1; valor < 500; valor += 7) {
    for (const pesos of [null, { Ana: 3, Bruno: 2, Carla: 5 }, { Bruno: 7 }]) {
      assert.equal(somaDe(Calc.ratear(valor, ORDEM, pesos, ORDEM)), valor);
    }
  }
});

// ---------------------------------------------------------------------------
// Saldos

test('moeda com 0 casas decimais (JPY): ¥ 1.000 por 3', () => {
  const r = Calc.calcularEstado([despesa({ moeda: 'JPY', valor: 1000 })], CTX);
  // 333 para cada, sobra ¥ 1 vai para Ana (primeira da ordem), que pagou
  assert.deepEqual(r.saldos_por_moeda.JPY, { Ana: 666, Bruno: -333, Carla: -333 });
  assert.deepEqual(r.transferencias_por_moeda.JPY, [
    { de: 'Bruno', para: 'Ana', valor: 333 },
    { de: 'Carla', para: 'Ana', valor: 333 },
  ]);
});

test('despesa com pesos', () => {
  const r = Calc.calcularEstado([
    despesa({ valor: 9000, pagador: 'Carla', pesos: 'Ana:2;Bruno:1' }),
  ], CTX);
  // pesos Ana 2, Bruno 1, Carla 1 -> 4500, 2250, 2250
  assert.deepEqual(r.saldos_por_moeda.BRL, { Ana: -4500, Bruno: -2250, Carla: 6750 });
});

test('despesa em que o pagador não participa', () => {
  const r = Calc.calcularEstado([
    despesa({ valor: 5000, pagador: 'Carla', participantes: 'Ana;Bruno' }),
  ], CTX);
  assert.deepEqual(r.saldos_por_moeda.BRL, { Ana: -2500, Bruno: -2500, Carla: 5000 });
});

test('pagamento simples zera a dívida', () => {
  const r = Calc.calcularEstado([
    despesa({ moeda: 'USD', valor: 10000, participantes: 'Ana;Bruno' }),
    pagamento({ moeda: 'USD', valor: 5000 }),
  ], CTX);
  assert.deepEqual(r.saldos_por_moeda.USD, { Ana: 0, Bruno: 0, Carla: 0 });
  assert.deepEqual(r.transferencias_por_moeda.USD, []);
});

test('acerto cruzado afeta só o livro da dívida', () => {
  const r = Calc.calcularEstado([
    despesa({ moeda: 'USD', valor: 10000, participantes: 'Ana;Bruno' }),
    despesa({ moeda: 'EUR', valor: 3000, pagador: 'Carla', participantes: 'Ana;Bruno;Carla' }),
    acertoCruzado({ moeda: 'USD', valor: 5000, moeda_paga: 'EUR', valor_pago: 4600 }),
  ], CTX);
  assert.deepEqual(r.saldos_por_moeda.USD, { Ana: 0, Bruno: 0, Carla: 0 });
  assert.deepEqual(r.saldos_por_moeda.EUR, { Ana: -1000, Bruno: -1000, Carla: 2000 });
  // EUR só aparece por causa da despesa, não do acerto
  assert.equal(r.totais_por_moeda.EUR, 3000);
});

test('acerto cruzado maior que a dívida inverte a direção', () => {
  const r = Calc.calcularEstado([
    despesa({ moeda: 'USD', valor: 10000, participantes: 'Ana;Bruno' }),
    acertoCruzado({ moeda: 'USD', valor: 6000, moeda_paga: 'EUR', valor_pago: 5500 }),
  ], CTX);
  assert.deepEqual(r.saldos_por_moeda.USD, { Ana: -1000, Bruno: 1000, Carla: 0 });
  assert.deepEqual(r.transferencias_por_moeda.USD, [{ de: 'Ana', para: 'Bruno', valor: 1000 }]);
  assert.equal(r.saldos_por_moeda.EUR, undefined);
});

test('viagem mista (BRL + USD + EUR) com livros independentes', () => {
  const r = Calc.calcularEstado([
    despesa({ moeda: 'BRL', valor: 30000, pagador: 'Ana' }),
    despesa({ moeda: 'USD', valor: 9000, pagador: 'Bruno' }),
    despesa({ moeda: 'EUR', valor: 6000, pagador: 'Carla', participantes: 'Ana;Carla' }),
  ], CTX);
  assert.deepEqual(r.saldos_por_moeda.BRL, { Ana: 20000, Bruno: -10000, Carla: -10000 });
  assert.deepEqual(r.saldos_por_moeda.USD, { Ana: -3000, Bruno: 6000, Carla: -3000 });
  assert.deepEqual(r.saldos_por_moeda.EUR, { Ana: -3000, Bruno: 0, Carla: 3000 });
  assert.deepEqual(r.totais_por_moeda, { BRL: 30000, USD: 9000, EUR: 6000 });
  // sem compensação entre moedas: Ana deve US$ 30 a Bruno e Bruno deve R$ 100 a Ana
  assert.deepEqual(r.transferencias_por_moeda.BRL, [
    { de: 'Bruno', para: 'Ana', valor: 10000 },
    { de: 'Carla', para: 'Ana', valor: 10000 },
  ]);
  assert.deepEqual(r.transferencias_por_moeda.USD, [
    { de: 'Ana', para: 'Bruno', valor: 3000 },
    { de: 'Carla', para: 'Bruno', valor: 3000 },
  ]);
  assert.deepEqual(r.transferencias_por_moeda.EUR, [{ de: 'Ana', para: 'Carla', valor: 3000 }]);
  // visão por par agrupa sem compensar
  assert.deepEqual(r.por_par, [
    { de: 'Ana', para: 'Bruno', valores: { USD: 3000 } },
    { de: 'Ana', para: 'Carla', valores: { EUR: 3000 } },
    { de: 'Bruno', para: 'Ana', valores: { BRL: 10000 } },
    { de: 'Carla', para: 'Ana', valores: { BRL: 10000 } },
    { de: 'Carla', para: 'Bruno', valores: { USD: 3000 } },
  ]);
});

test('visão por par junta várias moedas do mesmo par', () => {
  const r = Calc.calcularEstado([
    despesa({ moeda: 'USD', valor: 9000, participantes: 'Ana;Bruno' }),
    despesa({ moeda: 'EUR', valor: 2460, participantes: 'Ana;Bruno' }),
  ], CTX);
  assert.deepEqual(r.por_par, [{ de: 'Bruno', para: 'Ana', valores: { USD: 4500, EUR: 1230 } }]);
});

// ---------------------------------------------------------------------------
// Fontes de pagamento

test('despesa em JPY paga com fonte USD deixa o livro JPY intocado', () => {
  const r = Calc.calcularEstado([
    despesa({ moeda: 'JPY', valor: 10000, fontes: 'USD:6800', pagador: 'Ana', participantes: 'Ana;Bruno' }),
  ], CTX);
  assert.equal(r.saldos_por_moeda.JPY, undefined);
  assert.equal(r.totais_por_moeda.JPY, undefined);
  assert.deepEqual(r.saldos_por_moeda.USD, { Ana: 3400, Bruno: -3400, Carla: 0 });
  assert.equal(r.totais_por_moeda.USD, 6800);
});

test('despesa com duas fontes é rateada em dois livros', () => {
  const r = Calc.calcularEstado([
    despesa({ moeda: 'USD', valor: 8000, fontes: 'USD:5000;EUR:2700', pagador: 'Bruno' }),
  ], CTX);
  // US$ 50,00 / 3 = 16,67 + 16,67 + 16,66
  assert.deepEqual(r.saldos_por_moeda.USD, { Ana: -1667, Bruno: 3333, Carla: -1666 });
  assert.deepEqual(r.saldos_por_moeda.EUR, { Ana: -900, Bruno: 1800, Carla: -900 });
  assert.deepEqual(r.totais_por_moeda, { USD: 5000, EUR: 2700 });
});

test('fonte na mesma moeda da compra usa o valor da fonte, não o da compra', () => {
  const pernas = Calc.expandirPernas(Calc.normalizarLancamento(
    despesa({ moeda: 'USD', valor: 8000, fontes: 'USD:7500', participantes: 'Ana;Bruno', pesos: 'Ana:2' })
  ));
  assert.deepEqual(pernas, [
    { moeda: 'USD', valor: 7500, pagador: 'Ana', participantes: ['Ana', 'Bruno'], pesos: { Ana: 2 }, tipo: 'despesa' },
  ]);
});

test('parse de fontes válido', () => {
  assert.deepEqual(Calc.parseFontes(''), []);
  assert.deepEqual(Calc.parseFontes(null), []);
  assert.deepEqual(Calc.parseFontes('USD:6800'), [{ moeda: 'USD', valor: 6800 }]);
  assert.deepEqual(Calc.parseFontes(' usd : 5000 ; EUR:2700 ;'), [
    { moeda: 'USD', valor: 5000 },
    { moeda: 'EUR', valor: 2700 },
  ]);
  assert.equal(Calc.formatarFontes([{ moeda: 'USD', valor: 5000 }, { moeda: 'EUR', valor: 2700 }]), 'USD:5000;EUR:2700');
});

test('parse de fontes inválido', () => {
  assert.throws(() => Calc.parseFontes('USD:5000;USD:100'), /repetida/);
  assert.throws(() => Calc.parseFontes('USD:0'), /maior que zero/);
  assert.throws(() => Calc.parseFontes('USD:-5'), /inteiro/);
  assert.throws(() => Calc.parseFontes('USD:50.5'), /inteiro/);
  assert.throws(() => Calc.parseFontes('USD:1;EUR:1;BRL:1;JPY:1'), /máximo 3/);
  assert.throws(() => Calc.parseFontes('USD'), /formato/);
  assert.throws(() => Calc.parseFontes('DOLAR:100'), /código/);
});

// ---------------------------------------------------------------------------
// Validação

test('validação aceita lançamentos corretos', () => {
  assert.deepEqual(Calc.validarLancamento(despesa({ valor: 100 }), CTX), []);
  assert.deepEqual(Calc.validarLancamento(despesa({ valor: 100, fontes: 'USD:20;EUR:10', categoria: 'mercado' }), CTX), []);
  assert.deepEqual(Calc.validarLancamento(pagamento({ valor: 100 }), CTX), []);
  assert.deepEqual(Calc.validarLancamento(acertoCruzado({ moeda: 'USD', valor: 100, moeda_paga: 'EUR', valor_pago: 90 }), CTX), []);
});

test('validação rejeita lançamentos inválidos', () => {
  const erros = (l) => Calc.validarLancamento(l, CTX).join(' | ');
  assert.match(erros(despesa({ valor: 0 })), /valor/);
  assert.match(erros(despesa({ valor: 10.5 })), /valor/);
  assert.match(erros(despesa({ valor: 100, moeda: 'GBP' })), /GBP/);
  assert.match(erros(despesa({ valor: 100, pagador: 'Zé' })), /Zé/);
  assert.match(erros(despesa({ valor: 100, participantes: 'Ana;Zé' })), /Zé/);
  assert.match(erros(despesa({ valor: 100, participantes: '' })), /participante/);
  assert.match(erros(despesa({ valor: 100, data: '2026-02-30' })), /data/);
  assert.match(erros(despesa({ valor: 100, fontes: 'GBP:100' })), /GBP/);
  assert.match(erros(despesa({ valor: 100, fontes: 'USD:1;USD:2' })), /repetida/);
  assert.match(erros(despesa({ valor: 100, pesos: 'Carla:2', participantes: 'Ana;Bruno' })), /Carla/);
  assert.match(erros(despesa({ valor: 100, categoria: 'luxo' })), /categoria/);
  assert.match(erros(despesa({ valor: 100, tipo: 'presente' })), /tipo/);
  assert.match(erros(pagamento({ valor: 100, participantes: 'Bruno' })), /mesma pessoa/);
  assert.match(erros(pagamento({ valor: 100, participantes: 'Ana;Carla' })), /um recebedor/);
  assert.match(erros(acertoCruzado({ moeda: 'USD', valor: 100, moeda_paga: 'USD', valor_pago: 90 })), /diferente/);
  assert.match(erros(acertoCruzado({ moeda: 'USD', valor: 100, moeda_paga: '', valor_pago: '' })), /moeda_paga/);
  assert.match(erros(acertoCruzado({ moeda: 'USD', valor: 100, moeda_paga: 'EUR', valor_pago: 0 })), /valor_pago/);
});

test('lançamento inválido na planilha é ignorado e reportado', () => {
  const r = Calc.calcularEstado([
    despesa({ id: 'ok', valor: 300 }),
    despesa({ id: 'ruim', valor: 'abc' }),
  ], CTX);
  assert.deepEqual(r.saldos_por_moeda.BRL, { Ana: 200, Bruno: -100, Carla: -100 });
  assert.equal(r.invalidos.length, 1);
  assert.equal(r.invalidos[0].id, 'ruim');
});

// ---------------------------------------------------------------------------
// Invariantes e filtros

test('invariante: soma dos saldos é zero em cada moeda', () => {
  const lancs = [];
  const nomes = ORDEM;
  let x = 7;
  const rnd = (n) => { x = (x * 1103515245 + 12345) % 2147483648; return x % n; };
  for (let i = 0; i < 200; i++) {
    const moeda = MOEDAS[rnd(MOEDAS.length)];
    const pagador = nomes[rnd(3)];
    const tipo = rnd(5);
    if (tipo === 0) {
      const outro = nomes[(nomes.indexOf(pagador) + 1 + rnd(2)) % 3];
      lancs.push(pagamento({ moeda, valor: 1 + rnd(10000), pagador, participantes: outro }));
    } else {
      const parts = nomes.filter(() => rnd(3) > 0);
      if (!parts.length) parts.push(pagador);
      const fontes = rnd(3) === 0 ? 'EUR:' + (1 + rnd(5000)) + ';USD:' + (1 + rnd(5000)) : '';
      lancs.push(despesa({ moeda, valor: 1 + rnd(100000), pagador, participantes: parts.join(';'),
        pesos: rnd(4) === 0 ? parts[0] + ':3' : '', fontes }));
    }
  }
  const r = Calc.calcularEstado(lancs, CTX);
  assert.equal(r.invalidos.length, 0);
  for (const moeda of Object.keys(r.saldos_por_moeda)) {
    assert.equal(somaDe(r.saldos_por_moeda[moeda]), 0, moeda);
    // aplicar as transferências sugeridas zera todos os saldos
    const s = Object.assign({}, r.saldos_por_moeda[moeda]);
    for (const t of r.transferencias_por_moeda[moeda]) {
      assert.ok(t.valor > 0);
      s[t.de] += t.valor;
      s[t.para] -= t.valor;
    }
    assert.ok(Object.values(s).every((v) => v === 0), moeda);
    assert.ok(r.transferencias_por_moeda[moeda].length <= nomes.length - 1);
  }
});

test('lançamentos excluídos e pendentes são ignorados', () => {
  const r = Calc.calcularEstado([
    despesa({ valor: 300 }),
    despesa({ valor: 999999, excluido: true }),
    despesa({ valor: 999999, excluido: 'TRUE' }),
    despesa({ valor: 999999, status: 'pendente' }),
    despesa({ moeda: 'USD', valor: 999999, status: 'pendente' }),
  ], CTX);
  assert.deepEqual(r.saldos_por_moeda, { BRL: { Ana: 200, Bruno: -100, Carla: -100 } });
  assert.deepEqual(r.totais_por_moeda, { BRL: 300 });
  assert.equal(r.pendentes, 2);
});

test('determinismo: mesma entrada em qualquer ordem gera o mesmo resultado', () => {
  const lancs = [
    despesa({ moeda: 'USD', valor: 12000, pagador: 'Ana' }),
    despesa({ moeda: 'USD', valor: 3000, pagador: 'Bruno', participantes: 'Bruno;Carla' }),
    despesa({ moeda: 'EUR', valor: 999, pagador: 'Carla' }),
    pagamento({ moeda: 'USD', valor: 1000, pagador: 'Carla', participantes: 'Ana' }),
  ];
  const a = Calc.calcularEstado(lancs, CTX);
  const b = Calc.calcularEstado(lancs.slice().reverse(), CTX);
  const c = Calc.calcularEstado([lancs[2], lancs[0], lancs[3], lancs[1]], CTX);
  assert.deepEqual(a, b);
  assert.deepEqual(a, c);
  assert.deepEqual(JSON.stringify(a), JSON.stringify(b));
});

test('acerto mínimo desempata pela ordem dos participantes', () => {
  const t = Calc.acertoMinimo({ Carla: 100, Bruno: -100, Ana: 100, Davi: -100 }, ['Ana', 'Bruno', 'Carla', 'Davi']);
  assert.deepEqual(t, [
    { de: 'Bruno', para: 'Ana', valor: 100 },
    { de: 'Davi', para: 'Carla', valor: 100 },
  ]);
});

test('acerto mínimo casa maior devedor com maior credor', () => {
  const t = Calc.acertoMinimo({ Ana: 500, Bruno: -100, Carla: -400 }, ORDEM);
  assert.deepEqual(t, [
    { de: 'Carla', para: 'Ana', valor: 400 },
    { de: 'Bruno', para: 'Ana', valor: 100 },
  ]);
});

test('ordem das moedas segue a lista cadastrada', () => {
  const r = Calc.calcularEstado([
    despesa({ moeda: 'EUR', valor: 300 }),
    despesa({ moeda: 'BRL', valor: 300 }),
  ], CTX);
  assert.deepEqual(Object.keys(r.saldos_por_moeda), ['BRL', 'EUR']);
});
