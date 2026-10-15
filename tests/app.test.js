'use strict';

// Testa as funções puras do cliente, que ficam em app/index.html entre
// os marcadores "// <utils>" e "// </utils>".

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'app', 'index.html'), 'utf8');
const trecho = html.split('// <utils>')[1].split('\n').slice(1).join('\n').split('// </utils>')[0];
const U = new Function(trecho + '\nreturn { formatarNumero, parseValor, parseDecimal, calcularPago, calcularQuitado, cotacaoDe, lerFontes, lerPesos, lista, juntarNomes, textoParaQuem, lerCSV, decimalPonto, dataDMA, lerExtratoWise, pernasDesembolso, casarExtrato };')();

test('parseValor aceita vírgula e ponto como decimal', () => {
  assert.equal(U.parseValor('120,50', 2), 12050);
  assert.equal(U.parseValor('120.50', 2), 12050);
  assert.equal(U.parseValor('120,5', 2), 12050);
  assert.equal(U.parseValor('120', 2), 12000);
  assert.equal(U.parseValor(' 0,01 ', 2), 1);
  assert.equal(U.parseValor(',5', 2), 50);
  assert.equal(U.parseValor('', 2), null);
});

test('parseValor entende separador de milhar', () => {
  assert.equal(U.parseValor('1.234,56', 2), 123456);
  assert.equal(U.parseValor('1,234.56', 2), 123456);
  assert.equal(U.parseValor('1.234.567', 2), 123456700);
  assert.equal(U.parseValor('10.000', 0), 10000);
  assert.equal(U.parseValor('10.000', 2), 1000000);
  assert.equal(U.parseValor('10000', 0), 10000);
});

test('parseValor rejeita entradas inválidas', () => {
  assert.equal(U.parseValor('12,345', 0), 12345); // 3 dígitos após o separador = milhar
  assert.throws(() => U.parseValor('1,5', 0), /centavos/);
  assert.throws(() => U.parseValor('1,5055', 2), /casas/);
  assert.equal(U.parseValor('1,505', 2), 150500); // ambíguo: lido como milhar
  assert.equal(U.parseValor('1,505', 3), 1505);
  assert.throws(() => U.parseValor('abc', 2), /inválido/);
  assert.throws(() => U.parseValor('-5', 2), /inválido/);
  assert.throws(() => U.parseValor('1.23.4', 2), /inválido/);
  assert.throws(() => U.parseValor('.', 2), /inválido/);
});

test('formatarNumero no padrão brasileiro', () => {
  assert.equal(U.formatarNumero(123456, 2), '1.234,56');
  assert.equal(U.formatarNumero(5, 2), '0,05');
  assert.equal(U.formatarNumero(-1000, 2), '−10,00');
  assert.equal(U.formatarNumero(10000, 0), '10.000');
  assert.equal(U.formatarNumero(248049, 2, { semDecimais: true }), '2.480');
  assert.equal(U.formatarNumero(248050, 2, { semDecimais: true }), '2.481');
  assert.equal(U.formatarNumero(123456, 2, { semMilhar: true }), '1234,56');
});

test('acerto cruzado: valor pago a partir de quitado e cotação (meio-para-cima)', () => {
  // US$ 50,00 a 0,92 EUR/USD = € 46,00
  assert.equal(U.calcularPago(5000, U.parseDecimal('0,92'), 2, 2), 4600);
  // US$ 33,33 a 0,925 = 30,83025 -> € 30,83
  assert.equal(U.calcularPago(3333, U.parseDecimal('0.925'), 2, 2), 3083);
  // US$ 10,10 a 0,925 = 9,3425 -> € 9,34 ; US$ 0,10 a 0,925 = 0,0925 -> 0,09
  assert.equal(U.calcularPago(10, U.parseDecimal('0,925'), 2, 2), 9);
  // exatamente meio: US$ 0,01 a 0,5 = 0,005 -> 0,01
  assert.equal(U.calcularPago(1, U.parseDecimal('0,5'), 2, 2), 1);
  // US$ 50,00 a 149,5 JPY/USD = ¥ 7.475
  assert.equal(U.calcularPago(5000, U.parseDecimal('149,5'), 2, 0), 7475);
});

test('acerto cruzado: valor quitado a partir de pago e cotação', () => {
  assert.equal(U.calcularQuitado(4600, U.parseDecimal('0,92'), 2, 2), 5000);
  // ¥ 7.500 a 150 JPY/USD = US$ 50,00
  assert.equal(U.calcularQuitado(7500, U.parseDecimal('150'), 2, 0), 5000);
  // € 10,00 a 0,93 = 10,7526... -> US$ 10,75
  assert.equal(U.calcularQuitado(1000, U.parseDecimal('0,93'), 2, 2), 1075);
});

test('acerto cruzado: cotação derivada de quitado e pago', () => {
  assert.equal(U.cotacaoDe(5000, 4600, 2, 2), '0,92');
  assert.equal(U.cotacaoDe(5000, 7500, 2, 0), '150');
  // compra de ¥ 10.000 paga com US$ 68,00
  assert.equal(U.cotacaoDe(10000, 6800, 0, 2), '0,0068');
  assert.equal(U.cotacaoDe(6800, 10000, 2, 0), '147,0588');
});

test('parseDecimal', () => {
  assert.equal(U.parseDecimal(''), null);
  assert.deepEqual(U.parseDecimal('0,92'), { n: 92n, escala: 2 });
  assert.deepEqual(U.parseDecimal('150'), { n: 150n, escala: 0 });
  assert.throws(() => U.parseDecimal('0'), /maior que zero/);
  assert.throws(() => U.parseDecimal('1,2,3'), /inválida/);
});

test('leitura de fontes e pesos para exibição', () => {
  assert.deepEqual(U.lerFontes('USD:5000;EUR:2700'), [{ moeda: 'USD', valor: 5000 }, { moeda: 'EUR', valor: 2700 }]);
  assert.deepEqual(U.lerFontes(''), []);
  assert.deepEqual(U.lerPesos('Ana:2;Bruno:1'), { Ana: 2, Bruno: 1 });
  assert.deepEqual(U.lista('Ana; Bruno;'), ['Ana', 'Bruno']);
});

test('juntarNomes usa vírgulas e "e" no último', () => {
  assert.equal(U.juntarNomes([]), '');
  assert.equal(U.juntarNomes(['Ana']), 'Ana');
  assert.equal(U.juntarNomes(['Ana', 'Bruno']), 'Ana e Bruno');
  assert.equal(U.juntarNomes(['Ana', 'Bruno', 'Carla']), 'Ana, Bruno e Carla');
});

test('textoParaQuem descreve os participantes da despesa', () => {
  const todos = ['Ana', 'Bruno', 'Carla'];
  assert.equal(U.textoParaQuem('Ana', ['Ana', 'Bruno', 'Carla'], todos, ''), 'todos');
  assert.equal(U.textoParaQuem('Ana', ['Carla', 'Ana', 'Bruno'], todos, ''), 'todos');
  assert.equal(U.textoParaQuem('Ana', ['Carla'], todos, ''), 'Carla');
  assert.equal(U.textoParaQuem('Carla', ['Ana', 'Bruno'], todos, ''), 'Ana e Bruno');
  assert.equal(U.textoParaQuem('Ana', ['Ana'], todos, ''), 'si');
  assert.equal(U.textoParaQuem('Ana', ['Ana', 'Bruno', 'Carla'], todos, 'Ana:2;Bruno:1;Carla:1'), 'todos (Ana ×2)');
  assert.equal(U.textoParaQuem('Ana', ['Ana', 'Bruno'], todos, 'Ana:2;Bruno:3'), 'Ana e Bruno (Ana ×2, Bruno ×3)');
  // Viagem de uma pessoa só: não chamar de "todos".
  assert.equal(U.textoParaQuem('Ana', ['Ana'], ['Ana'], ''), 'si');
});

// ---------------------------------------------------------------------------
// Importar extrato (Fase 2)

const CASAS = { BRL: 2, USD: 2, EUR: 2, JPY: 0, VND: 0 };
const casasDe = (m) => (m in CASAS ? CASAS[m] : 2);
// Nenhum extrato (real ou sintético) fica no repositório: o CSV é montado aqui com linhas fictícias,
// só com as colunas que o leitor usa.
const COLUNAS_WISE = ['TransferWise ID', 'Date', 'Amount', 'Currency', 'Description', 'Exchange To',
  'Merchant', 'Exchange To Amount', 'Transaction Type', 'Transaction Details Type'];
function csvWise(linhas) {
  const q = (v) => (/[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v);
  return [COLUNAS_WISE.map((c) => '"' + c + '"').join(',')]
    .concat(linhas.map((l) => COLUNAS_WISE.map((c) => q(String(l[c] == null ? '' : l[c]))).join(','))).join('\n');
}
const cartao = (id, data, valor, merchant, para, paraValor) => ({
  'TransferWise ID': id, Date: data, Amount: valor, Currency: 'USD', Merchant: merchant,
  'Exchange To': para || '', 'Exchange To Amount': paraValor || '', 'Transaction Type': 'DEBIT', 'Transaction Details Type': 'CARD',
});
const wiseCsv = csvWise([
  cartao('CARD-9', '08-03-2025', '-2.95', 'Loja A', 'VND', '75000'),
  cartao('CARD-8', '08-03-2025', '-0.87', 'Loja B', 'VND', '22000'),
  cartao('CARD-7', '08-03-2025', '-0.87', 'Loja C', 'VND', '22000'),
  cartao('CARD-6', '07-03-2025', '-12.50', 'Museu D'),
  Object.assign(cartao('CARD-5', '07-03-2025', '3.27', 'Loja A'), { 'Transaction Type': 'CREDIT' }), // estorno
  { 'TransferWise ID': 'TRANSFER-4', Date: '07-03-2025', Amount: '-40.00', Currency: 'USD',
    Description: 'Enviou dinheiro para Pessoa X com a referência "x"', 'Transaction Type': 'DEBIT', 'Transaction Details Type': 'TRANSFER' },
  { 'TransferWise ID': 'BALANCE-3', Date: '06-03-2025', Amount: '-100.00', Currency: 'USD', 'Exchange To': 'EUR',
    'Exchange To Amount': '92.00', 'Transaction Type': 'DEBIT', 'Transaction Details Type': 'CONVERSION' },
  { 'TransferWise ID': 'TRANSFER-2', Date: '06-03-2025', Amount: '600.00', Currency: 'USD',
    'Transaction Type': 'CREDIT', 'Transaction Details Type': 'DEPOSIT' },
  cartao('CARD-1', '06-03-2025', '-8.78', 'Restaurante E', 'VND', '222480'),
]);

test('lerCSV lida com aspas, aspas escapadas, BOM e CRLF', () => {
  assert.deepEqual(U.lerCSV('﻿a,"b,c","d ""e"""\r\n1,,3\r\n'), [['a', 'b,c', 'd "e"'], ['1', '', '3']]);
  assert.deepEqual(U.lerCSV('x,y\n\n"1\n2",3'), [['x', 'y'], ['1\n2', '3']]);
});

test('decimalPonto converte para unidades mínimas', () => {
  assert.equal(U.decimalPonto('-2.95', 2), 295);
  assert.equal(U.decimalPonto('600.00', 2), 60000);
  assert.equal(U.decimalPonto('75000', 0), 75000);
  assert.equal(U.decimalPonto('75000.00', 0), 75000);
  assert.equal(U.decimalPonto('1.005', 2), 101); // meio-para-cima
  assert.equal(U.decimalPonto('1.004', 2), 100);
  assert.equal(U.decimalPonto('', 2), null);
  assert.equal(U.decimalPonto('1,50', 2), null);
});

test('dataDMA converte DD-MM-AAAA', () => {
  assert.equal(U.dataDMA('08-03-2025'), '2025-03-08');
  assert.equal(U.dataDMA('2025-03-08'), '');
});

test('lerExtratoWise: só saídas; compra em outra moeda vira compra + fonte', () => {
  const r = U.lerExtratoWise(wiseCsv, casasDe);
  assert.equal(r.origem, 'Wise');
  // estorno (CREDIT), depósito (CREDIT) e conversão entre saldos ficam de fora
  assert.equal(r.ignoradas, 3);
  assert.deepEqual(r.saidas.map((s) => s.ref), [
    'wise:CARD-9', 'wise:CARD-8', 'wise:CARD-7', 'wise:CARD-6', 'wise:TRANSFER-4', 'wise:CARD-1',
  ]);
  const vnd = r.saidas[0];
  assert.deepEqual(
    { data: vnd.data, descricao: vnd.descricao, moeda: vnd.moeda, valor: vnd.valor, moedaSaldo: vnd.moedaSaldo, valorSaldo: vnd.valorSaldo, sugerida: vnd.sugerida },
    { data: '2025-03-08', descricao: 'Loja A', moeda: 'VND', valor: 75000, moedaSaldo: 'USD', valorSaldo: 295, sugerida: true });
  const usd = r.saidas[3];
  assert.deepEqual([usd.moeda, usd.valor, usd.moedaSaldo, usd.valorSaldo], ['USD', 1250, 'USD', 1250]);
  // transferência enviada aparece, mas desmarcada (pode ser pagamento a alguém do grupo)
  const transf = r.saidas[4];
  assert.equal(transf.sugerida, false);
  assert.equal(transf.descricao, 'Enviou dinheiro para Pessoa X com a referência "x"');
});

test('lerExtratoWise rejeita arquivo de outro formato', () => {
  assert.throws(() => U.lerExtratoWise('Data,Valor\n01/01/2025,10', casasDe), /Wise/);
  assert.throws(() => U.lerExtratoWise('', casasDe), /vazio/);
});

test('pernasDesembolso: fontes, compra, pagamento e o que foi transferido no acerto', () => {
  const ls = [
    { id: 'a', tipo: 'despesa', pagador: 'Ana', moeda: 'JPY', valor: 10000, fontes: 'USD:6800', data: '2025-03-01' },
    { id: 'b', tipo: 'despesa', pagador: 'Ana', moeda: 'USD', valor: 8000, fontes: 'USD:5000;EUR:2700', data: '2025-03-02' },
    { id: 'c', tipo: 'despesa', pagador: 'Ana', moeda: 'BRL', valor: 1000, fontes: '', data: '2025-03-03' },
    { id: 'd', tipo: 'pagamento', pagador: 'Ana', moeda: 'USD', valor: 500, data: '2025-03-04' },
    { id: 'e', tipo: 'acerto_cruzado', pagador: 'Ana', moeda: 'USD', valor: 5000, moeda_paga: 'EUR', valor_pago: 4600, data: '2025-03-05' },
    { id: 'f', tipo: 'despesa', pagador: 'Bruno', moeda: 'USD', valor: 999, fontes: '', data: '2025-03-05' },
  ];
  assert.deepEqual(U.pernasDesembolso(ls, 'Ana').map((p) => [p.id, p.moeda, p.valor]), [
    ['a', 'USD', 6800], ['b', 'USD', 5000], ['b', 'EUR', 2700], ['c', 'BRL', 1000], ['d', 'USD', 500], ['e', 'EUR', 4600],
  ]);
});

test('casarExtrato: mesma moeda e valor do desembolso, ±2 dias, um para um', () => {
  const saidas = U.lerExtratoWise(wiseCsv, casasDe).saidas;
  const pernas = [
    { id: 'm1', moeda: 'USD', valor: 87, data: '2025-03-07' },  // casa com uma das duas de 0,87
    { id: 'm2', moeda: 'USD', valor: 878, data: '2025-03-09' }, // 3 dias de distância: não casa
    { id: 'm3', moeda: 'VND', valor: 75000, data: '2025-03-08' }, // moeda da compra, não do desembolso: não casa
    { id: 'wise:CARD-6', moeda: 'USD', valor: 1250, data: '2025-03-07' }, // importado antes
  ];
  assert.deepEqual(U.casarExtrato(saidas, pernas), [null, 'm1', null, 'wise:CARD-6', null, null]);
});

test('casarExtrato prefere o mesmo id e depois a data mais próxima', () => {
  const saidas = [{ ref: 'wise:X', data: '2025-03-10', moedaSaldo: 'USD', valorSaldo: 100 }];
  assert.deepEqual(U.casarExtrato(saidas, [
    { id: 'longe', moeda: 'USD', valor: 100, data: '2025-03-12' },
    { id: 'perto', moeda: 'USD', valor: 100, data: '2025-03-09' },
  ]), ['perto']);
  assert.deepEqual(U.casarExtrato(saidas, [
    { id: 'perto', moeda: 'USD', valor: 100, data: '2025-03-10' },
    { id: 'wise:X', moeda: 'USD', valor: 100, data: '2025-03-10' },
  ]), ['wise:X']);
});
