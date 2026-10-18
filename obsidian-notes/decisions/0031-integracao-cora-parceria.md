# ADR 0031 — Integração Cora, modalidade Parceria

- **Status:** Aceita
- **Data:** 2026-09-04
- **Autores:** Alan + agente IA
- **Substitui:** —
- **Substituída por:** —
- **Relacionada:** [[decisions/0030-multiplos-gateways-de-pagamento|ADR 0030]], [[decisions/0024-ledger-financeiro-com-contrapartida|ADR 0024]]

## Contexto

A ADR 0030 deixou a fundação multi-gateway pronta e nomeou a Cora como o próximo provedor. A documentação (`developers.cora.com.br`) contradiz a suposição registrada lá: a Cora tem **duas modalidades**, e a nossa é OAuth puro.

| | Integração Direta | **Parceria Cora** ← nossa |
|---|---|---|
| Base | `matls-clients.api.cora.com.br` | `api.cora.com.br` |
| Auth | mTLS + `client_credentials` | **OAuth2 authorization_code** |
| Para quê | gerenciar a própria conta | ERPs cujos clientes autorizam o app |

O fluxo encaixa no contrato `PaymentProvider.oauth` sem peça nova. Quatro diferenças em relação ao Mercado Pago, porém, não são cosméticas:

| | Mercado Pago | Cora |
|---|---|---|
| `access_token` | ~180 dias | **24 horas** |
| `refresh_token` | existe, sem uso | **obrigatório e rotativo** — novo a cada renovação, o anterior vale 3 usos; sessão morre com 60 dias de inatividade |
| Valores | decimal (`350.00`) | **centavos inteiros** (`35000`) |
| Pix | `qr_code` + `qr_code_base64` | **só `pix.emv`** |
| Webhook | corpo JSON assinado (HMAC `x-signature`) | **sem corpo e sem assinatura** — só os headers `webhook-event-id`, `webhook-event-type`, `webhook-resource-id` |

## Decisões

### 1. A notificação da Cora não é fonte de verdade — é um aviso

A Cora não assina o webhook e não oferece campo de segredo no cadastro do endpoint (`POST /endpoints/` aceita apenas `url`, `resource`, `trigger`). Quem descobrir a URL consegue emitir `invoice.paid`.

Três camadas, todas necessárias — nenhuma delas suficiente sozinha:

1. **Segredo no path da URL.** `.../cora-webhook/<CORA_WEBHOOK_SECRET>`. É o único lugar onde cabe um segredo, já que não há header de autenticação. Comparado em tempo constante.
2. **Reconsultar a invoice na API da Cora** com o token daquele tenant, e acreditar no que a API responde — nunca no que a requisição afirmou. Vale o mesmo que o MP faz, mas ali era prudência e aqui é a defesa principal.
3. **Resolver o tenant pelo NOSSO registro.** `webhook-resource-id` é procurado em `payment_intents.provider_intent_id`; a conta e o tenant saem de lá. Nada que veio de fora escolhe de quem é o dinheiro.

`gateway_events.signature_valid` fica **`false` permanentemente** para a Cora. É honesto e é o ponto: a coluna diz o que aconteceu, e um provedor que não assina não pode produzir um registro que afirme verificação.

### 1-bis. O webhook é cadastrado uma vez, para a aplicação inteira

`POST /endpoints/` aceita **token `client_credentials`**, que na modalidade Parceria sai com o mesmo `Authorization: Basic` do resto — **sem certificado**. Verificado: `GET /endpoints` e `POST /endpoints/` respondem com esse token.

Isso significa **um cadastro para todos os tenants**, não um por conta conectada. Consequências que valem a pena:

- conectar uma conta Cora não precisa registrar webhook nenhum — nada a mais no fluxo de conexão, nada a desfazer na desconexão
- locadora nova passa a receber notificação sem nenhum passo extra
- a URL secreta é uma só, e rotacioná-la é um `DELETE` mais um `POST`

O `POST /endpoints/` fica fora do fluxo da aplicação: é operação de infraestrutura, feita uma vez por ambiente, como configurar um webhook em painel.

### 1-ter. A Cora dá 2 segundos para responder

O cadastro devolve `connectionTimeout: 1000, readTimeout: 2000`. Processar um evento envolve reconsultar a invoice na API da Cora — sozinho isso pode estourar o prazo.

Por isso a Edge Function **responde antes de processar**, com `EdgeRuntime.waitUntil`. Seguro porque o evento já está no inbox: se o processamento morrer, a linha fica com `processed_at IS NULL` e `idx_gateway_events_unprocessed` é a fila de reprocessamento.

O mesmo defeito estava no webhook do Mercado Pago, onde o comentário afirmava esse comportamento havia meses e o `await` fazia o contrário. Corrigido nos dois.

### 2. Renovação de credencial com posse declarada no banco

24 horas de validade tornam o refresh obrigatório — sem ele, toda cobrança a partir do segundo dia falha. E o refresh token da Cora é **rotativo**: renovar devolve um novo, o anterior sobrevive a no máximo 3 usos.

Duas requisições concorrentes que encontrem o token vencido renovariam as duas, queimando a janela de rotação. Por isso a renovação é **reivindicada** antes de acontecer: `fn_claim_credential_refresh` marca a posse sob `FOR UPDATE`, com lease de tempo. Quem perde a corrida segue com a credencial atual — que ainda vale, porque a renovação dispara com **margem** (10 minutos antes de vencer), não no vencimento.

O lease existe porque a chamada HTTP pode morrer no meio: posse sem prazo de validade é integração travada até alguém mexer no banco.

Isso corrige o G-08 da ADR 0030 também para o Mercado Pago, onde o `refresh` existia sem chamador.

### 3. Centavos moram dentro do adaptador

O sistema inteiro fala em reais decimais. A Cora fala em centavos inteiros. A conversão acontece **só** em `providers/cora/api.ts`, nas duas direções. Nenhum valor em centavos atravessa a fronteira do adaptador — errar isso é cobrar cem vezes o devido, e o defeito seria invisível em teste com valor redondo.

### 4. O EMV é o campo canônico do Pix

A Cora devolve apenas `pix.emv` (o código copia-e-cola). O app renderizava `qr_code_base64` como imagem, campo que só o Mercado Pago tem.

O app passa a **gerar o QR a partir do EMV**. O Mercado Pago também devolve o EMV (em `qr_code`), então os dois convergem num campo só, `payload.emv`, e a tela do cliente deixa de conhecer o formato de um provedor específico. `qr_code_base64` continua sendo gravado quando o provedor o oferece, mas nada depende dele.

## Consequências

**Aceitamos**

- A URL do webhook da Cora é um segredo. Vazá-la (log, print, ticket de suporte) exige rotação — trocar `CORA_WEBHOOK_SECRET` e recadastrar o endpoint na Cora.
- Renovação é preguiçosa (na hora de cobrar), não agendada. Uma conta parada 60 dias perde a sessão e exige reconexão — comportamento da Cora, não nosso. A tela mostra a conta como conectada até a primeira falha; melhorar isso é trabalho separado.
- Só `pix` no catálogo da Cora por ora. `boleto` é suportado pela API e exige `payment_method_type` novo no banco mais tela — entra quando for pedido.

**Escopo pedido**

Apenas `invoice`. A Cora oferece `account`, `payment` e `transfer`; pedir acesso a extrato, saldo ou iniciação de pagamento da conta do cliente sem precisar seria coletar poder que não usamos.

## Verificado em homologação (2026-09-05)

Fluxo completo exercitado contra `api.stage.cora.com.br` com o Cliente A de teste.

| Ponto | Resultado |
|---|---|
| **`state`** | **Volta.** `state=PROVA-DE-STATE-123` chegou no retorno junto do `code`. A defesa de CSRF está de pé — era a maior incógnita |
| `redirect_uri` | A Cora **já tem** `https://gomotos-web.vercel.app*` registrado. `https://gomotos-web.vercel.app/api/auth/gateway/cora/callback` é aceito. `localhost`/`127.0.0.1` **não** — falta pedir |
| HTTP Basic no `/oauth/token` | Correto. Com Basic válido e código inválido o erro é `invalid_grant: Code not valid`; com secret errado, `unauthorized_client` |
| `expires_in` | 86400 (24h), como a doc diz |
| Refresh | Funciona, e o `refresh_token` **muda a cada renovação** — a rotação é real, não teórica. O `business_id` sobrevive |
| Emissão de Pix | `POST /v2/invoices` com `payment_forms: ['PIX']` → 200, `pix.emv` presente |
| Centavos | R$ 350,10 enviado como `35010`; a invoice voltou com `total_amount: 35010`. Conversão confirmada ponta a ponta |
| Reconsulta da invoice | `GET /v2/invoices/{id}` devolve `status` e `total_paid` — é a camada 2 do webhook |

### Três defeitos que só apareceram contra a API viva

**1. `sub` não identifica a conta.** Vale `app-1sZTHkFlwIp774snsVEuGG` — o NOSSO client_id, idêntico para todo tenant que autorizar. Quem identifica a conta é **`business_id`**; `cnpj` e `person_id` também vêm nos claims. Usar `sub` faria toda locadora compartilhar o mesmo `external_account_id`, e a reconexão de uma sobrescreveria a linha da outra.

**2. `Idempotency-Key` precisa ser UUID.** `charge-<uuid>` é recusado com *"The Idempotency-Key|x-idempotency-id header must be a valid UUID"*. O Mercado Pago aceita string livre; a Cora não. Passou a ser UUID novo por tentativa — a proteção contra cobrar duas vezes é o índice único parcial de `payment_intents`, que é mais forte, e chave fixa por cobrança quebraria a reemissão legítima depois de uma troca de gateway.

**3. Sem `payment_forms: ['PIX']` não vem `pix.emv`.** A invoice é criada, com status `OPEN`, e sem código Pix nenhum — cobrança que o cliente não consegue pagar. O provider passou a falhar explicitamente quando o EMV não vem, em vez de gravar uma tentativa pendente inútil.

Como consequência do achado 1, `account_email` virou **`account_label`**: o nome estava preso ao primeiro provedor, e o que a Cora oferece para o usuário reconhecer a conta é o CNPJ, não um e-mail.

### O que ainda falta pedir à Cora

1. Liberar `http://localhost:3000/*` como `redirect_uri` — sem isso o round trip não fecha em desenvolvimento local (em produção já fecha).
2. Cadastrar o endpoint de webhook: `POST /endpoints/` com `resource: invoice`, `trigger: *` e a URL com o segredo no path.
3. Rotacionar o client secret de homologação, que trafegou por canal de conversa.

## Ciclo de vida da invoice, observado em produção (2026-09-06)

Uma cobrança gerada dispara **três** webhooks, porque o endpoint está cadastrado com `trigger: '*'`:

```
16:09:26.0   nós → POST /v2/invoices
16:09:27.29  Cora → invoice.DRAFTED    ← chega ANTES do nosso INSERT
16:09:28.30  nós → INSERT payment_intents
16:09:28.54  Cora → invoice.CREATED    (API já responde status OPEN, com emv)
16:11:57.26  Cora → invoice.PAID
```

**O `DRAFTED` corre contra o nosso próprio INSERT — e ganha.** A Cora notifica no instante em que recebe o POST, enquanto ainda estamos esperando a resposta e desenhando o PNG do QR a partir do `emv`. A ordem "criar no provedor, depois registrar" é a certa (não dá para gravar um `provider_intent_id` que ainda não existe, e uma linha provisória envenenaria o índice único de um pendente por dívida), então a corrida é estrutural, não um defeito.

A diferença entre `DRAFTED` e `CREATED` **não está documentada** em nada que eu tenha encontrado — a página de webhooks dá 404. A leitura pela linha do tempo é "o registro existe" versus "está registrada e pagável". Inferência, não fato.

Consequência que virou código: `DRAFTED` e `CREATED` nunca movimentam dinheiro e agora são descartados **antes** da consulta ao banco e da ida à API. Sem esse corte, cada cobrança gerada custava uma reconsulta completa à Cora só para ouvir `OPEN (total_paid=0)` — às vezes duas, dependendo de quem ganhasse a corrida.

O filtro é **denylist** de propósito: evento novo que a Cora venha a criar passa e é processado. Uma lista de permitidos o descartaria em silêncio.

Pendente: a Cora aceita assinar um trigger específico em vez de `*`. Cadastrar só o que movimenta dinheiro cortaria os dois eventos na origem, em vez de descartá-los aqui.
