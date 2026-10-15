'use strict';

// Funções puras de gas/Code.js (o resto depende das APIs do Apps Script).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const codigo = fs.readFileSync(path.join(__dirname, '..', 'gas', 'Code.js'), 'utf8');
const G = new Function(codigo + '\nreturn { montarLinkConvite, urlApiValida, urlAppValida };')();

const API = 'https://script.google.com/macros/s/AKfy-abc_123/exec';

test('montarLinkConvite gera o link que o app entende', () => {
  const link = G.montarLinkConvite('https://fulano.github.io/despesas/', 'tok123', API);
  assert.equal(link, 'https://fulano.github.io/despesas/#t=tok123&api=' + encodeURIComponent(API));
  const p = new URLSearchParams(link.split('#')[1]);
  assert.equal(p.get('t'), 'tok123');
  assert.equal(p.get('api'), API);
});

test('montarLinkConvite completa a barra final e descarta fragmento antigo', () => {
  assert.ok(G.montarLinkConvite(' https://fulano.github.io/despesas ', 't', API).startsWith('https://fulano.github.io/despesas/#t=t&'));
  assert.ok(G.montarLinkConvite('https://fulano.github.io/despesas/#t=velho', 't', API).startsWith('https://fulano.github.io/despesas/#t=t&'));
  assert.ok(G.montarLinkConvite('https://x.dev/app/index.html', 't', API).startsWith('https://x.dev/app/index.html#t=t&'));
});

test('urlApiValida aceita só a URL /exec do Apps Script', () => {
  assert.equal(G.urlApiValida(API), true);
  assert.equal(G.urlApiValida('https://script.google.com/a/macros/empresa.com/s/AKfy/exec'), true);
  assert.equal(G.urlApiValida('https://script.google.com/macros/s/AKfy/dev'), false);
  assert.equal(G.urlApiValida('http://script.google.com/macros/s/AKfy/exec'), false);
  assert.equal(G.urlApiValida('https://exemplo.com/exec'), false);
  assert.equal(G.urlApiValida(''), false);
  assert.equal(G.urlApiValida(null), false);
});

test('urlAppValida exige endereço http(s)', () => {
  assert.equal(G.urlAppValida('https://fulano.github.io/despesas/'), true);
  assert.equal(G.urlAppValida('fulano.github.io/despesas'), false);
  assert.equal(G.urlAppValida(''), false);
});
