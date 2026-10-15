# CLAUDE.md — Despesas da Viagem

## Visão geral

App web (PWA) para um grupo pequeno de amigos registrar despesas de viagem compartilhadas. Os lançamentos ficam numa planilha Google; um Google Apps Script faz o papel de backend; o app calcula e exibe quem deve a quem, em cada moeda.

Problema que o app resolve: hoje o grupo usa uma planilha por moeda e lança tudo à mão. O objetivo é concentrar todas as moedas num só lugar e reduzir o atrito do registro, sem mudar a regra de acerto que o grupo já considera justa. Escopo fechado: cada fase abaixo tem critério de pronto. Não adicionar funcionalidades fora da fase atual sem pedir.

```
PWA (GitHub Pages)  --POST JSON-->  Apps Script (Web App)  --append-->  Google Sheets
        ^                                    |
        +------------ GET saldos ------------+
```

## Regra de negócio central: cada moeda é um livro separado

- Quem pagou uma despesa recebe de volta **na(s) mesma(s) moeda(s) que saíram do seu saldo**. Assim ninguém ganha nem perde com variação cambial.
- A moeda da compra (a do recibo) e a moeda desembolsada podem ser diferentes, e uma compra pode sair de mais de um saldo. Ex.: compra de ¥ 10.000 paga com o saldo em USD; compra de US$ 80 com US$ 50 de saldo em dólar e o restante completado com € 27. O que gera dívida são as **fontes de pagamento** (o desembolso), não a moeda da compra. Ver "Fontes de pagamento".
- Saldos e sugestões de acerto são calculados **independentemente por moeda**. Não existe moeda base, cotação de referência nem conversão automática.
- A única exceção é o **acerto cruzado**: o credor aceita receber numa moeda diferente da dívida (ex.: tem crédito em USD, prefere receber em EUR). Vale a cotação do momento da transferência, combinada entre as duas pessoas e registrada no próprio lançamento. Ver "Acerto cruzado".

## Princípios

- **Uma única fonte da lógica de cálculo**: rateio, saldos e acertos vivem em `gas/Calc.js` (funções puras, testadas). A planilha guarda dados e exibe resultados; não usa fórmulas para o cálculo principal.
- **Dinheiro em unidades mínimas inteiras** (centavos, ou a menor unidade da moeda). Nunca usar float para valores.
- **Lançamentos imutáveis em espírito**: editar = sobrescrever a linha pelo `id`, guardando `editado_em` e `editado_por`; excluir = `excluido = TRUE` (soft delete). Nunca apagar linhas.
- **Idempotência**: o cliente gera o `id` (UUID v4). O servidor ignora um `id` já existente em criação. Isso torna seguro reenviar a fila offline.
- **Frontend simples**: HTML + CSS + JavaScript puro, sem framework e sem build. `index.html` autocontido; `manifest.webmanifest` e `sw.js` à parte apenas porque o PWA exige.
- **Offline-first no registro**: lançar despesa funciona sem rede; vai para uma fila local e sincroniza quando voltar a conexão.

## Estrutura do repositório

```
/app
  index.html            # UI + lógica do cliente (arquivo único)
  manifest.webmanifest
  sw.js                 # cache do app shell
  icons/
/gas
  Code.js               # doGet/doPost, roteamento, validação, I/O na planilha
  Calc.js               # rateio, saldos por moeda, acerto mínimo (puro, sem APIs Google)
  appsscript.json
  .clasp.json           # não commitar scriptId (está no .gitignore; ver .clasp.json.example)
/tests
  calc.test.js          # node --test
  app.test.js           # funções puras do cliente (trecho entre // <utils> e // </utils> do index.html)
/.github/workflows
  pages.yml             # testes + publicação de /app no GitHub Pages
CLAUDE.md
README.md
```

`Calc.js` precisa rodar tanto no Apps Script (sem módulos) quanto no Node para testes. Padrão: declarar funções no escopo global e terminar com
`if (typeof module !== 'undefined') module.exports = { ... };`

## Modelo de dados (planilha)

Uma planilha por viagem. Abas:

**Config** (chave | valor)
- `nome_viagem`, `token` (ver Segurança), `participantes` (nomes separados por `;`, ordem fixa)

**Moedas** (moeda | casas_decimais | simbolo)
- Uma linha por moeda usada na viagem. `casas_decimais` segue a ISO 4217 (BRL/USD/EUR = 2; JPY/CLP = 0). Ex.: `BRL | 2 | R$`, `USD | 2 | US$`, `EUR | 2 | €`.
- Moedas novas podem ser cadastradas pelo app a qualquer momento.

**Lancamentos** — uma linha por lançamento; cabeçalho exato na linha 1:

| coluna | tipo | observação |
|---|---|---|
| id | texto | UUID gerado no cliente. Lançamentos importados de extrato usam `<banco>:<id da transação>` (ex.: `wise:CARD-2295381044`), o que torna a reimportação idempotente |
| tipo | texto | `despesa`, `pagamento` ou `acerto_cruzado` |
| data | AAAA-MM-DD | data da compra ou da transferência |
| descricao | texto | |
| categoria | texto | lista curta e fixa: alimentação, transporte, hospedagem, passeios, mercado, outros (só para `despesa`) |
| moeda | texto | código ISO 4217. `despesa`: moeda da compra (a do recibo). `pagamento`/`acerto_cruzado`: moeda do livro afetado |
| valor | inteiro | em unidades mínimas da `moeda`, sempre positivo |
| fontes | texto | só `despesa`; vazio = pago integralmente na própria `moeda`. Senão, o desembolso real: `USD:5000;EUR:2700` (moeda:valor em unidades mínimas, máximo 3 fontes, sem moeda repetida) |
| pagador | texto | quem pagou a despesa ou quem enviou a transferência |
| participantes | texto | `despesa`: nomes separados por `;`. `pagamento` e `acerto_cruzado`: o recebedor |
| pesos | texto | vazio = divisão igual; senão `Ana:2;Bruno:1` (só para `despesa`; inteiros ≥ 1; participante ausente em `pesos` tem peso 1) |
| moeda_paga | texto | só `acerto_cruzado`: moeda efetivamente transferida |
| valor_pago | inteiro | só `acerto_cruzado`: valor transferido, em unidades mínimas de `moeda_paga` |
| status | texto | `confirmado` ou `pendente` |
| origem | texto | `manual`, `extrato`, `comprovante` |
| criado_em / criado_por | ISO / nome | |
| editado_em / editado_por | ISO / nome | |
| excluido | booleano | |

**Resumo** — reescrita inteira pelo script após cada gravação: total gasto por moeda, saldo líquido por pessoa em cada moeda e transferências sugeridas por moeda. Somente leitura para humanos.

Regra para quem edita a planilha à mão: pode corrigir células de `Lancamentos`, nunca reordenar colunas nem mudar o cabeçalho. O script localiza colunas pelo nome do cabeçalho, não pela posição.

## Fontes de pagamento

Uma despesa tem duas informações distintas: **o que foi comprado** (`moeda` + `valor`, o que está no recibo) e **de onde saiu o dinheiro** (`fontes`).

- `fontes` vazio é o caso comum: a compra saiu do saldo na própria moeda. O livro afetado é o de `moeda`.
- Com `fontes` preenchido, **só as fontes geram dívida**; `moeda`/`valor` da compra viram informação descritiva. Cada fonte é rateada no livro da sua moeda, com os mesmos participantes e pesos da despesa.
- Exemplos:
  - ¥ 10.000 pagos com saldo em dólar: `moeda = JPY`, `valor = 10000`, `fontes = USD:6800`.
  - US$ 80 com US$ 50 em dólar + € 27: `moeda = USD`, `valor = 8000`, `fontes = USD:5000;EUR:2700`. A fonte pode ter a mesma moeda da compra.
  - Compra em dólar no cartão brasileiro, cobrada em reais: `moeda = USD`, `fontes = BRL:<valor da fatura>`.
- Não validar a soma das fontes contra o valor da compra: sem cotações, isso não é verificável. Quando houver uma única fonte em moeda diferente, exibir a cotação implícita (`valor da fonte / valor da compra`) só para conferência.
- A forma texto em uma coluna é deliberada: mantém cada despesa numa única linha (escrita atômica e edição manual simples). O parse fica em `Calc.js`, com teste próprio, e o servidor rejeita formato inválido.

## Acerto cruzado

Exemplo: Bruno deve US$ 50,00 a Ana. Ana prefere receber em euros. Os dois combinam a cotação do momento e Bruno transfere € 46,00.

Registro: `tipo = acerto_cruzado`, `pagador = Bruno`, `participantes = Ana`, `moeda = USD`, `valor = 5000` (quanto da dívida em dólar foi quitado), `moeda_paga = EUR`, `valor_pago = 4600` (o que foi transferido).

Efeito no cálculo: **apenas o livro de `moeda` é afetado**, como se Bruno tivesse pago US$ 50,00 a Ana. O livro de EUR não muda: os euros foram a forma de quitar a dívida em dólar, não uma nova dívida. `moeda_paga` e `valor_pago` existem para histórico e auditoria.

Na interface, o fluxo parte da dívida: escolher a dívida (ex.: "Bruno deve a Ana US$ 50,00"), escolher a moeda em que vai pagar e informar **dois de três** campos — valor quitado, valor pago, cotação. O terceiro é calculado e exibido para conferência. A cotação nunca é gravada: é sempre derivada de `valor_pago / valor`. Quando o cálculo exigir arredondamento, arredondar o valor calculado meio-para-cima na unidade mínima da sua moeda e mostrar o resultado antes de salvar. Se o valor quitado ultrapassar a dívida atual naquela moeda, avisar (inverteria a direção da dívida), mas permitir.

## Regras de cálculo (`Calc.js`)

Entram no cálculo apenas linhas com `status = confirmado` e `excluido = FALSE`.

0. **Expansão em pernas**: cada lançamento vira uma ou mais pernas `{ moeda, valor, pagador, participantes, pesos }`. Despesa sem `fontes` → uma perna com `moeda`/`valor`. Despesa com `fontes` → uma perna por fonte. Pagamento e acerto cruzado → uma perna com `moeda`/`valor`.

Os passos seguintes são executados **separadamente para cada moeda**, sobre as pernas daquela moeda.

1. **Rateio de uma perna de despesa**: divide `valor` entre os participantes conforme os pesos (iguais por padrão). As unidades mínimas que sobram da divisão inteira vão, uma a uma, para os participantes na ordem fixa de `Config.participantes`. A soma das partes deve ser sempre exatamente igual ao valor.
2. **Saldo líquido**: para cada pessoa, `pago − devido`. `pagamento` e `acerto_cruzado` de A para B somam `valor` ao saldo de A e subtraem do de B. A soma dos saldos de cada moeda é sempre zero (asserção obrigatória).
3. **Acerto mínimo**: algoritmo guloso — casa repetidamente o maior devedor com o maior credor até zerar. Desempate determinístico pela ordem dos participantes.
4. **Visão por par**: agrupar as transferências sugeridas de todas as moedas por par de pessoas (ex.: "Bruno → Ana: US$ 45,00 + € 12,30"). É só apresentação; não altera o cálculo.

Não há compensação entre moedas: dever US$ 10 a alguém e ter R$ 50 a receber da mesma pessoa gera duas transferências, não uma. Compensar exige acerto cruzado explícito.

Testes obrigatórios em `tests/calc.test.js`: divisão com resto (ex.: R$ 100,00 por 3), moeda com 0 casas decimais (JPY), pesos, despesa em que o pagador não participa, pagamento simples, acerto cruzado afetando só o livro da dívida, acerto cruzado maior que a dívida, viagem mista (BRL + USD + EUR) com livros independentes, despesa em JPY paga com fonte USD (livro JPY intocado), despesa com duas fontes rateada em dois livros, fonte na mesma moeda da compra, parse de `fontes` válido e inválido (moeda repetida, valor zero, mais de 3 fontes), invariante soma = 0 em cada moeda, lançamentos excluídos e pendentes ignorados, determinismo do resultado.

## API (Apps Script Web App)

Implantação: *Executar como: eu*; *Quem pode acessar: qualquer pessoa*. Toda requisição carrega o token da viagem.

- `GET ?acao=estado&token=...` → `{ participantes, moedas, lancamentos, saldos_por_moeda, transferencias_por_moeda, totais_por_moeda, pendentes }`, mais `nome_viagem`, `por_par`, `invalidos` (linhas da planilha ignoradas por erro, com o motivo) e `atualizado_em`. `lancamentos` não traz os excluídos; `pendentes` é a contagem.
- `POST` corpo JSON `{ acao, token, autor, dados }`, com `acao` em `criar`, `editar`, `excluir`, `confirmar`, `moeda` (cadastrar moeda). `dados` de `excluir` = `{ id }`; de `confirmar` = `{ ids: [...] }`; de `moeda` = `{ moeda, casas_decimais, simbolo }`.

Respostas sempre `{ ok: true, ... }` ou `{ ok: false, erro: "mensagem legível" }`, via `ContentService` com MIME JSON. Erros transitórios (lock ocupado) trazem `temporario: true`, e token errado traz `codigo: "token_invalido"`: o cliente mantém esses itens na fila sem marcá-los como erro.

Detalhes que já causaram problema nesse tipo de stack:
- O cliente deve enviar o POST com `Content-Type: text/plain;charset=utf-8` (e o JSON no corpo) para evitar preflight CORS, que o Apps Script não responde.
- Toda escrita usa `LockService.getScriptLock()` com `waitLock(10000)` para evitar linhas sobrepostas em gravações simultâneas.
- Validar no servidor, não só no cliente: participantes existem, moeda cadastrada, valores inteiros > 0, data válida, pagador na lista, campos de `acerto_cruzado` completos e com `moeda_paga ≠ moeda`, `fontes` bem formado e com todas as moedas cadastradas.
- Ao alterar o código, publicar nova versão **no mesmo deployment** (`clasp deploy -i <deploymentId>`) para a URL `/exec` não mudar. A URL `/dev` exige login e não serve para o app.

## Segurança

Nível adequado para um grupo de amigos, não para dados sensíveis:
- Um token aleatório por viagem em `Config.token` (e espelhado em Script Properties, que é o valor conferido pelo servidor; trocar só pelo menu *Despesas > Gerar novo token*). O link compartilhado é `https://.../#t=<token>`; o app lê o fragmento (que não vai para logs de servidor), guarda localmente e limpa a URL. A URL `/exec` fica na constante `API_URL` de `index.html` ou vai no próprio link como `&api=<url codificada>`.
- Sem login Google. Na primeira abertura a pessoa escolhe o próprio nome na lista de participantes; o nome vai em `criado_por`/`editado_por`.
- Nunca colocar token, ID da planilha ou chaves de API no repositório.
- Nunca commitar extratos bancários, nem reais nem sintéticos (`*.csv` e `*.ofx` estão no `.gitignore`). Os testes do leitor montam no próprio código poucas linhas fictícias, só com as colunas usadas.

## Frontend

Telas: cabeçalho compacto com totais; botão flutuante "+ Nova despesa" (o "Adicionar rapidamente"); lista de lançamentos com filtro de pendentes; bloco "Acerto de contas". "Importar extrato" e "Compartilhar comprovante" entram na interface só quando as fases 2 e 3 forem implementadas (sem botões desabilitados de "em breve").

- **Cabeçalho**: nome da viagem, indicador discreto de sincronização (ponto colorido + texto curto: hora da última atualização, "N na fila", "offline"; tocar atualiza ou abre a fila) e total desembolsado por moeda, somando as pernas (ex.: `R$ 2.480 · US$ 640 · € 95`), nunca um total convertido.
- **Moeda na interface**: uma só forma, o símbolo (`R$`, `US$`, `€`), inclusive nos seletores e cotações (`US$ 1 = ¥ 147,06`). O código ISO aparece só quando dois símbolos cadastrados coincidem (ex.: `kr`).
- **Adicionar rapidamente** é o caminho principal e deve exigir o mínimo de toques: valor (teclado numérico, aceitar `120,50` e `120.50`), moeda (seletor compacto ao lado do valor; padrão = última moeda usada neste aparelho), descrição, pagador (padrão: eu), participantes (padrão: todos), data (padrão: hoje), categoria opcional.
- **"Pago com"**: linha discreta abaixo do valor, mostrando por padrão a própria moeda da compra. Tocar permite trocar a moeda de saída e informar o valor desembolsado, ou "+ completar com outro saldo" para adicionar uma segunda/terceira fonte. O caso comum continua sem nenhum toque extra.
- **Lista de lançamentos**: agrupada por dia. Despesa: título `Descrição – Categoria` e linha `A pagou para todos` / `A pagou para B` / `A pagou para B e C`. Pagamento e acerto cruzado: `A pagou B`. Despesa com fontes exibe compra e desembolso, ex.: `¥ 10.000` com `pago com US$ 68,00` abaixo, ou `US$ 80,00` com `pago com US$ 50,00 + € 27,00`.
- **Acerto de contas**: alternar entre visão por moeda e visão por par (o alternador só aparece quando há dívidas em mais de uma moeda). Texto das transferências: `A deve a B`, com um botão por moeda. Tocar na dívida abre "Registrar pagamento" pré-preenchido; no topo desse formulário, o alternador "Mesma moeda / Outra moeda" troca entre pagamento e acerto cruzado mantendo pessoas, valor e data.
- **Formulários**: data como chips "Hoje / Ontem / Outra data" (o campo de data só aparece em "Outra data"); todo seletor de moeda tem "+ Nova moeda…", que abre o cadastro por cima do formulário e já seleciona a moeda criada; ao abrir um lançamento existente, mostrar quem criou/editou e quando.
- **Excluir** não pede confirmação: o item some da lista, a exclusão espera 5 s na fila (`ate` no item da fila) e o aviso oferece "Desfazer".
- **Pendentes** = lançamentos com `status = pendente` aguardando confirmação. A fila offline é outra coisa: mostrar à parte, como "não sincronizados". O selo "N pendentes" filtra a lista e mostra "Confirmar pendentes" (confirmação em lote, com caixas de seleção). No formulário de um pendente, "Confirmar" salva as edições e confirma.
- **Importar extrato**: no menu. O arquivo é lido só no aparelho; mostra as saídas ainda não lançadas (marcadas por padrão as compras com cartão), as já lançadas (recolhidas) e quantas entradas/conversões foram ignoradas. As marcadas viram pendentes pagas por quem importa, divididas entre os participantes escolhidos; moedas novas do extrato são cadastradas junto.
- Fila offline em `localStorage`; sincronizar no evento `online` e ao abrir o app. Lista de moedas e participantes em cache local.
- Tema escuro como padrão, respeitando `prefers-color-scheme`. Layout pensado para iPhone (safe areas, alvos de toque ≥ 44px).
- Interface em português do Brasil.

## Fases

Trabalhar uma fase por vez. Não iniciar a seguinte sem confirmação.

**Fase 1 — Núcleo** (pronto quando: o grupo consegue lançar despesas em várias moedas, registrar pagamentos e acertos cruzados e ver o acerto pelo celular)
Planilha modelo, `Calc.js` com testes passando, API completa, PWA com "Adicionar rapidamente", lista, acerto de contas por moeda e por par, fontes de pagamento, fluxo de acerto cruzado, cadastro de moeda e fila offline.

**Fase 2 — Importar extrato** (pronto quando: compras do extrato não lançadas viram pendentes e podem ser confirmadas em lote)
Parse de OFX/CSV no próprio navegador; o extrato bruto nunca é enviado ao servidor. Cada linha do extrato é um desembolso, então a comparação é feita contra as **pernas** do mesmo pagador (mesma moeda, valor igual, data ±2 dias), não contra a moeda da compra; só linhas sem correspondência aparecem como candidatas. Para a comparação contam também os lançamentos pendentes e os da fila local, para reimportar não duplicar. O usuário marca as que quer e elas entram como `pendente`, origem `extrato`, com a linha do extrato como fonte. Se o extrato informar moeda e valor originais (comum em contas multimoeda e faturas de cartão), preencher `moeda`/`valor` da compra com eles. Uma compra que saiu de dois saldos aparece em duas linhas do extrato; o app permite juntá-las num só lançamento antes de confirmar.

Formatos:
- **Wise (CSV)** — feito. Cabeçalho com `TransferWise ID`, `Date` (DD-MM-AAAA), `Amount` (com sinal, ponto decimal), `Currency` (moeda do saldo), `Exchange To`/`Exchange To Amount` (moeda e valor da compra quando houve conversão), `Merchant`, `Transaction Type` (`DEBIT`/`CREDIT`) e `Transaction Details Type` (`CARD`, `TRANSFER`, `DEPOSIT`, `CONVERSION`…). Viram candidatas só as saídas (`DEBIT` com valor negativo), exceto `CONVERSION`; `CARD` vem marcada, as demais (ex.: transferência enviada, que pode ser pagamento a alguém do grupo) desmarcadas. `Amount` já inclui a tarifa: é o desembolso.
- **Nubank e Banco do Brasil (OFX)** — a fazer, aproveitando o importador do projeto de finanças pessoais.
- **Nomad** — só exporta PDF; fora de escopo.
- A fazer também: juntar duas linhas do extrato num só lançamento.

**Fase 3 — Comprovante (opcional)** (pronto quando: uma foto de nota gera um lançamento pendente pré-preenchido)
Extração de valor/moeda/data/estabelecimento por uma API de visão chamada pelo Apps Script, com chave em Script Properties. Decidir provedor e custo antes de começar. O resultado sempre entra como `pendente`; nunca confirmar automaticamente.

**Fora de escopo**: múltiplas viagens na mesma planilha, contas de usuário, notificações push, gráficos, busca automática de cotações, total consolidado numa moeda única, compensação automática entre moedas.

## Comandos

```bash
node --test tests/*.test.js        # testes (no Node 22, `node --test tests/` não aceita diretório)
cd gas && clasp push               # envia código ao Apps Script
cd gas && clasp deploy -i <ID>     # publica nova versão na mesma URL
npx serve app                      # servir o PWA localmente
```

## Como trabalhar neste projeto

- Antes de mexer em `Calc.js`, escrever ou ajustar o teste primeiro.
- Mudança no modelo de dados exige atualizar esta seção do CLAUDE.md na mesma alteração.
- Preferir mudanças pequenas e verificáveis; ao final de cada tarefa, dizer o que foi testado e o que precisa de teste manual no celular.
- Na dúvida entre duas abordagens, perguntar em vez de escolher a mais elaborada.
