# Despesas da Viagem

PWA para um grupo pequeno registrar despesas de viagem em várias moedas. Os
lançamentos ficam numa planilha Google, o Apps Script faz o papel de backend, e
o app mostra quem deve a quem **em cada moeda**: cada moeda é um livro separado,
sem conversão. Regras completas em [CLAUDE.md](CLAUDE.md).

```
app/    PWA (index.html, manifest, service worker, ícones) — publicado no GitHub Pages
gas/    Apps Script: Code.js (API e planilha) + Calc.js (cálculo puro)
tests/  node --test
```

## Instalação (uma vez por viagem)

1. **Planilha**: crie uma planilha Google vazia e abra *Extensões > Apps Script*.
2. **Código**: com o [clasp](https://github.com/google/clasp) (`npm i -g @google/clasp`, `clasp login`):
   ```bash
   cp gas/.clasp.json.example gas/.clasp.json   # cole o ID do script (Configurações do projeto)
   cd gas && clasp push
   ```
   Sem clasp, dá para criar os arquivos `Code.gs` e `Calc.gs` no editor e colar o conteúdo.
3. **Configurar**: no editor, rode `configurarPlanilha` (autorize o acesso). Ela cria as abas
   `Config`, `Moedas` (BRL, USD, EUR), `Lancamentos` e `Resumo` e gera o token.
   Depois, na aba `Config`, ajuste `nome_viagem` e `participantes` (nomes separados por `;`,
   sem `:`; a ordem define o desempate dos arredondamentos). Ao reabrir a planilha aparece o
   menu **Despesas** (recalcular resumo, mostrar link, gerar novo token).
4. **Publicar a API**: *Implantar > Nova implantação > App da Web*, executar como **eu**,
   acesso **qualquer pessoa**. Copie a URL que termina em `/exec`.
   Ao mudar o código depois: `clasp push && clasp deploy -i <deploymentId>` (mesma URL).
5. **Publicar o app**: em *Settings > Pages* do repositório, escolha *Source: GitHub Actions*.
   O workflow `.github/workflows/pages.yml` roda os testes e publica a pasta `app/` a cada push na `main`.
6. **Link de convite**: envie ao grupo
   ```
   https://<usuario>.github.io/<repo>/#t=<token>&api=<URL /exec codificada>
   ```
   O token está em *Despesas > Mostrar link de convite*. A URL da API pode ir no link
   (`api=`, com `encodeURIComponent`) ou fixa na constante `API_URL` no topo de `app/index.html`.
   O app guarda os dois no aparelho e limpa a URL. No iPhone: *Compartilhar > Adicionar à Tela de Início*.

Nunca coloque o token, o ID da planilha ou o `scriptId` no repositório.

## Desenvolvimento

```bash
node --test tests/*.test.js   # cálculo (Calc.js) e funções puras do cliente
npx serve app                # servir o PWA localmente
```

## Como usar

- **Adicionar rapidamente**: valor (aceita `120,50` e `120.50`), moeda (lembra a última usada),
  descrição; pagador = você e divisão entre todos por padrão.
- **Pago com**: quando a compra saiu de outro saldo (ex.: ¥ 10.000 pagos com US$ 68) ou de
  mais de um (US$ 50 + € 27). Só o desembolso gera dívida.
- **Acerto de contas**: por moeda ou por par. *Registrar pagamento* quita na mesma moeda;
  *Pagar em outra moeda* registra um acerto cruzado com a cotação combinada (preencha dois
  de: valor quitado, valor pago, cotação).
- **Sem internet**: os lançamentos ficam na fila do aparelho ("não sincronizados") e são
  enviados quando a conexão volta.
