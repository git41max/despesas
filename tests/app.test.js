'use strict';

// Testa as funções puras do cliente, que ficam em app/index.html entre
// os marcadores "// <utils>" e "// </utils>".

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'app', 'index.html'), 'utf8');
const trecho = html.split('// <utils>')[1].split('\n').slice(1).join('\n').split('// </utils>')[0];
const U = new Function(trecho + '\nreturn { formatarNumero, parseValor, parseDecimal, calcularPago, calcularQuitado, cotacaoDe, lerFontes, lerPesos, lista, juntarNomes, textoParaQuem };')();

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
