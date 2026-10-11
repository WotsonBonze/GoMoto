# ADR 0037 — Integração Asaas (chave de API)

- **Status:** Aceita (ciclo fechado em produção com sandbox, 2026-10-11)
- **Data:** 2026-10-09
- **Autores:** Alan + agente IA
- **Substitui:** —
- **Substituída por:** —
- **Relacionada:** [[decisions/0030-multiplos-gateways-de-pagamento|ADR 0030]], [[decisions/0031-integracao-cora-parceria|ADR 0031]], [[decisions/0032-integracao-infinitepay-checkout|ADR 0032]], [[decisions/0033-dinheiro-para-cobranca-cancelada|ADR 0033]], [[decisions/0034-auditabilidade-do-caminho-do-dinheiro|ADR 0034]], [[decisions/0038-garantia-do-encargo-em-todos-os-gateways|ADR 0038]]

## Contexto

Quarto gateway, e o primeiro a usar `connectionMode: 'api_key'`, um valor que a ADR 0030 reservou e deixou sem implementação de propósito. Na geração de cobrança o Asaas se parece com o Mercado Pago e com a Cora: entrega um Pix que o GoMoto desenha. Ele diverge em outros quatro pontos:

| | MP / Cora | InfinitePay | **Asaas** |
|---|---|---|---|
| Conexão | OAuth2 | handle público | **chave de API colada pelo tenant** |
| Poder da credencial | escopo da aplicação | nenhum | **cobrança; saque/transferência só se o tenant habilitar na chave** (verificado) |
| Validade | 24h (Cora) / ~180d (MP), com refresh | — | **sem refresh; desabilita com 3 meses sem uso e expira com 6** |
| Pagador | opcional | opcional | **obrigatório: `customer` com CPF/CNPJ criado antes** |
| Webhook | fixo no app (MP) ou no painel (Cora) | URL em cada link | **criado por conta via API (`POST /v3/webhooks`), com `authToken` no header** |
| Escopo do webhook | só o que o GoMoto criou | só o que o GoMoto criou | **TUDO da conta do tenant, incluindo cobranças que o GoMoto não emitiu** |
| Sandbox | homologação | não existe | **existe** (`api-sandbox.asaas.com`, chave `$aact_hmlg_`) |

Fonte: documentação oficial (docs.asaas.com) lida pelo MCP do Asaas e **sondada contra o sandbox em 2026-10-09** (ver "Verificado na API viva"). Os itens ainda marcados com ⚠ só podem ser confirmados com o webhook chegando num endpoint público.

## Verificado na API viva (sandbox, 2026-10-09)

Conta sandbox do Alan, chave `$aact_hmlg_` criada sem permissão de saque, chave Pix EVP cadastrada.

| O quê | Resultado | Consequência |
|---|---|---|
| `GET /wallets` | `{data:[{id: "<uuid>"}]}`, 1 carteira | `external_account_id = walletId` |
| `GET /myAccount/commercialInfo` | nome, `cpfCnpj`, `personType`, e-mail, telefone, endereço | rótulo = nome + documento mascarado; o resto é dado pessoal e não se grava |
| **Valor mínimo** | 0,01 / 1,00 / 4,99 → 400 *"não pode ser menor que R$ 5,00"*; 5,00 → 200 | **`minAmount: 5`** |
| `POST /customers` duas vezes, mesmo CPF | **dois clientes** (`cus_…980`, `cus_…981`) | buscar por `cpfCnpj` **antes** de criar é obrigatório |
| `GET /customers?cpfCnpj=` após `DELETE` de um deles | só devolve o não removido | não precisa filtrar `deleted` |
| CPF inválido | 400 `invalid_object` *"O CPF/CNPJ informado é inválido."* | erro nomeado para o operador corrigir o cadastro |
| `GET /payments/{id}/pixQrCode` | `payload` = **Pix com vencimento (`cobv`)**, `expirationDate` = **vencimento + 12 meses** | confirma o defeito 3b para o Asaas |
| `POST /sandbox/payment/{id}/overdue` + `pixQrCode` | status `OVERDUE`, **QR continua válido até 2027** com o valor original | idem: sem 3b, o Pix vencido seria pago pelo valor velho |
| `POST /sandbox/payment/{id}/confirm` (Pix) | vai **direto para `RECEIVED`**, sem `CONFIRMED` | confirma a doc |
| Cobrança paga | `value: 5`, **`netValue: 4.01`** (tarifa R$ 0,99), `billingType: PIX`, `paymentDate`/`confirmedDate`/`creditDate` **só data** | razão credita `value`; não há horário do pagamento |
| `GET /pix/transactions/{id}` (seria a fonte do horário) | 403 `insufficient_permission` (*"…operações de saque via API"*) | sem permissão de saque, não há horário; aceita-se o instante da confirmação |
| `DELETE /payments/{id}` pendente/vencida | `{deleted: true}`; **repetir também dá 200** | `cancelIntent` idempotente |
| `DELETE` de cobrança paga | 400 `invalid_action` *"Só é possível remover cobranças pendentes ou vencidas."* | `cancelIntent` trata como "já paga", não como falha |
| `POST /webhooks` | 200; `authToken` volta **só na criação**, depois só `hasAuthToken: true` | token não é recuperável; vem do nosso env |
| `POST /webhooks` repetido, mesma URL e eventos | 400 *"Já existe uma configuração para os eventos com os mesmos atributos."* | **reconectar não pode criar outro**: procurar o nosso pela URL e atualizar (`PUT`) |
| `authToken` com repetição | 400 *"O token não pode conter mais de 4 caracteres iguais consecutivos."* | gerar o token e validar essa regra |
| `GET /transfers`, `GET /pix/transactions` | **403 `insufficient_permission`** com a chave sem saque | **sonda de privilégio**: dá para detectar e recusar chave com saque habilitado (decisão 1) |
| `GET /finance/balance` | 200 | não depende de saque |
| Formato inválido / chave sandbox em produção | 401 `invalid_access_token_format` / 401 `invalid_environment` | mensagens distintas na tela |
| `GET /payments/limits` | `daily.limit: 5000` | limite alto o bastante no sandbox; em produção depende da conta |

### Superfície que vamos usar

```
Auth:      header access_token: $aact_prod_... | $aact_hmlg_...   + User-Agent obrigatório
Base:      https://api.asaas.com/v3  |  https://api-sandbox.asaas.com/v3

GET    /wallets                      → { data: [{ id: walletId }] }          identidade da conta
GET    /myAccount/commercialInfo     → nome/razão social, cpfCnpj             rótulo na tela
GET    /customers?cpfCnpj=X          → reaproveita o pagador
POST   /customers                    { name, cpfCnpj, email, notificationDisabled: true }
POST   /payments                     { customer, billingType: 'PIX', value, dueDate, externalReference }
GET    /payments/{id}/pixQrCode      → { encodedImage, payload, expirationDate }
GET    /payments/{id}                → status, value, billingType, paymentDate   reconsulta do webhook
DELETE /payments/{id}                                                          cancelIntent (ADR 0033)
POST   /webhooks                     { url, authToken, sendType, events[], enabled, apiVersion: 3 }
DELETE /webhooks/{id}                                                          ao desconectar
GET    /payments/limits              → limite DIÁRIO de criação de cobranças
```

Webhook: `POST` com `{ id: "evt_...", event: "PAYMENT_RECEIVED", account: {id}, payment: {...} }` e header `asaas-access-token`. **Só `HTTP 200` conta como entrega.** 201/204 também são falha. Depois de 15 falhas seguidas a fila pausa, e o que ficar parado mais de 14 dias é apagado.

## Decisões

### 1. `connectionMode: 'api_key'`, com a sonda antes da gravação

Formulário com campo mascarado (`type="password"`), no mesmo molde do ramo `handle` da 0032. A Server Action:

1. valida o formato (`^\$aact_(prod|hmlg)_`), e o prefixo diz o ambiente;
2. **recusa chave de sandbox em produção** (e o contrário). A base URL é derivada do prefixo e o deploy declara qual aceita (`ASAAS_ENVIRONMENT`). Assim a chave de homologação não fica gravada num tenant real;
3. sonda `GET /wallets` + `GET /myAccount/commercialInfo`. Se falhar, nada é gravado;
4. **recusa chave com permissão de saque**: `GET /transfers` precisa responder 403 `insufficient_permission`. Se responder 200, a tela pede uma chave nova sem "saque via API". Assim o GoMoto nunca guarda credencial capaz de tirar dinheiro da conta da locadora. ⚠ O caso 200 só pode ser sondado com uma segunda chave que tenha saque habilitado;
5. cria o webhook da conta (decisão 4). Se o Asaas recusar por já existir um igual, localiza o nosso pela URL (`GET /webhooks`) e o atualiza com `PUT`. Se a gravação no Vault falhar, desfaz o que criou;
6. grava no Vault `{ api_key, environment, webhook_id }`.

`external_account_id = walletId` e `account_label = CNPJ/razão social`.

**Contrato:** em vez de a action importar `providers/asaas/api` direto, como a de handle faz com a InfinitePay, propõe-se um bloco opcional no `PaymentProvider`, simétrico ao `oauth`:

```ts
apiKey?: { connect(key: string): Promise<ProviderConnection> }
disconnect?(credentials: ProviderCredentials): Promise<void>   // best-effort, nunca bloqueia
```

O registry passa a cobrar coerência entre `connectionMode` e o bloco, como já faz com `oauth`.

### 2. Só Pix na v1. Boleto e cartão ficam de fora

- `methods: ['pix']`. O app mobile e o cockpit já sabem desenhar `emv` + `qr_code_base64` (MP/Cora), então zero UI de cobrança nova.
- **Boleto exige DDL**: `payment_method_type` não tem `boleto` (só `pix, cash, credit_card, debit_card, bank_transfer, other, deposit_retention, credit`). Por isso é escopo separado.
- Cartão / `billingType: UNDEFINED` + `invoiceUrl` (checkout hospedado, igual à InfinitePay) é o próximo passo natural. A fundação aceita `methods: ['pix', 'payment_link']` sem mudança.

Payload gravado: `{ emv: payload, qr_code: payload, qr_code_base64: encodedImage, invoice_url }`. `invoice_url` vai como fallback e não é o caminho principal.

### 3. Emissão: a política de atraso da locadora vai DENTRO do Pix (`cobv`)

**Decidido com o Alan em 2026-10-09, em duas rodadas.** A primeira escolha foi "o GoMoto calcula, o QR é do dia". Ela caiu diante do requisito real, nas palavras dele: *"uma cobrança atrasada não pode ser paga sem cobrar a multa e juros"*. Com o QR do dia, o cliente que guarda o código paga depois sem os juros dos dias seguintes, e nenhum mecanismo verificável impede isso:

- **QR estático com `expirationDate`**: o banco do pagador não vê a validade (`decode` → `expirationDate: null`, `canBePaid: true` depois de expirado). A recusa ficaria por conta do Asaas no recebimento, e o sandbox não executa Pix entre contas (*"não é possível confirmar uma transferência pix nesse ambiente"*), então isso não pode ser provado;
- **apagar a `cobv` à meia-noite**: no sandbox, a cobrança apagada continua `canBePaid: true` no `decode`.

O que é verificável e garantido: **`cobv` com `fine`/`interest`**. Pelo padrão Pix Cobrança do Banco Central, quem calcula o valor na hora de pagar é o **banco do pagador**, a partir do vencimento e das regras embutidas no QR. Verificado: R$ 100, multa 2%, juros 1%/mês, 1 dia de atraso → `decode` mostra `fine: 2, interest: 0.03, totalValue: 102.03`; confirmado o pagamento, `GET /payments` traz `value: 102.03, originalValue: 100, interestValue: 2.03`. Código salvo e pago 30 dias depois paga 30 dias de juros, sem depender de app, agendador ou expiração.

**A política continua sendo a da locadora** (`late_charge_policies`, fixada na cobrança, R-08). O Asaas só a executa. Tradução:

| GoMoto | Asaas | Fidelidade |
|---|---|---|
| `grace_period_days` | `dueDate` = vencimento + carência | ✓ multa e juros começam no mesmo dia que `days_overdue` |
| `fee_type`/`fee_value` (uma vez) | `fine` PERCENTAGE (`fee_value × 100`) / FIXED | ✓ |
| `daily_interest_rate × days_overdue` (simples, sobre o principal) | `interest` mensal = `daily × 30 × 100`, pro rata dia | ✓ verificado: R$ 0,03 em 1 dia sobre R$ 100 a 1%/mês |
| `min_amount` (piso do encargo) | não existe | ✗ o Asaas cobra **menos** que o GoMoto enquanto multa+juros < piso. Nunca mais |
| arredondamento `round2` | juro mensal com **2 casas** (0,987 → 0,99), valor **truncado** | ✗ ±centavos (R$ 0,11 vs 0,1152 num dia sobre R$ 350) |

Dois caminhos de emissão, porque o Asaas recusa vencimento no passado (`invalid_dueDate`: *"Não é permitido data de vencimento inferior a hoje."*):

1. **Ainda dentro do prazo** (hoje ≤ vencimento + carência): `value` = principal em aberto, `dueDate` = vencimento + carência, `fine` e `interest` traduzidos. É o caso normal e permite mandar o Pix antes do vencimento.
2. **Já em atraso**: `value` = `amount_due` de hoje pelo GoMoto (principal + multa + juros até hoje, com o piso), `dueDate` = hoje, **`fine` = 0** (a multa já está dentro, e é uma vez só), `interest` = taxa traduzida. Daí em diante o banco soma os dias seguintes. Desvio conhecido: o juro do Asaas incide sobre o `value`, que já contém o encargo, então há um pouco de juro sobre juro (centavos por mês). Aceito.

**Razão:** o encargo realizado passa a ser o que o Asaas **efetivamente cobrou**, não o estimado na emissão: `accrued_amount` do intent (caminho 2) + `interestValue` da reconsulta. Exige **uma migration**: `fn_confirm_gateway_payment` ganha `p_extra_late_charge NUMERIC DEFAULT 0`, somado ao `v_accrued` antes de `fn_realize_late_charge`. Os outros gateways passam 0, sem mudança de comportamento. O `value` pago é o `p_amount`.

**Telas:** cockpit e app seguem mostrando `calculateAmountDue` (fonte única). A diferença de centavos para o que o banco cobra é aceita; o razão registra o que foi pago.

- `externalReference = "gomoto:<chargeId>"` serve de marca de origem (decisão 5).
- **Pagador:** `GET /customers?cpfCnpj=` → usa o primeiro não removido, senão `POST /customers` com **`notificationDisabled: true`**. Sem isso, o Asaas manda e-mail/SMS de cobrança ao locatário por conta própria, em paralelo ao GoMoto, e pode tarifar a locadora por isso. Não cacheamos o `cus_` (zero DDL); o custo é um GET a mais por intent.
- **O documento hoje sai só de `customers.cpf`** (`intents.ts`). Cliente PJ tem `cpf NULL` e `cnpj` preenchido, então o Asaas recusaria. Correção: `document: cpf ?? cnpj`, que também beneficia a Cora. Cliente sem nenhum dos dois vira um erro nomeado ("cadastre CPF/CNPJ do cliente"), não um 400 genérico.
- `expires_at` = `null` no intent. O `cobv` vale vencimento + 12 meses (verificado) e o valor se atualiza sozinho, então não há motivo para trocar o QR por passar o dia.

### 3b. Tentativa reaproveitada só se ainda representa a dívida (defeito pré-existente)

Achado ao planejar a decisão 3. `getOrCreateIntent` reaproveita a tentativa pendente olhando só `expires_at` (`intents.ts:66`). A Cora e a InfinitePay gravam `expires_at = null`. Resultado: o Pix de uma cobrança vencida gerado no dia 10 é devolvido no dia 15 **com o valor do dia 10**, e a confirmação realiza o `accrued_amount` do dia 10. Os juros dos dias 11–15 somem sem erro nenhum.

Correção na camada comum, com teste unitário. O descritor ganha `accruesLateChargesNatively: boolean` (só o Asaas é `true`):

- **`false`** (MP, Cora, InfinitePay): reaproveita só se `intent.amount === amount_due` de hoje. Divergiu → `fn_expire_payment_intent` + `cancelIntent` best-effort (ADR 0033) + intent novo.
- **`true`** (Asaas): reaproveita enquanto a **base** não mudar (principal em aberto e caminho de emissão). Os dias a mais o próprio Pix soma. Mudou (pagamento parcial, desconto, crédito aplicado) → mesmo descarte.

Isto **não** fecha o buraco do código salvo para MP/Cora/InfinitePay: só impede que o GoMoto *entregue* um código velho. A garantia universal (a cobrança não fecha se o pagamento chega depois do dia do QR, e a diferença fica em aberto) exige levar o cálculo do encargo para SQL: [[decisions/0038-garantia-do-encargo-em-todos-os-gateways|ADR 0038]]. Ajuste barato junto deste PR: o QR do Mercado Pago passa a expirar às 23:59 do fuso do tenant em vez de 24h corridas.

### 4. Webhook: um por conta, token global, criado na conexão

- `POST /v3/webhooks` na conexão, com `url = ASAAS_WEBHOOK_URL`, `authToken = ASAAS_WEBHOOK_TOKEN` (32–255 chars), `sendType: SEQUENTIALLY` e `events`: `PAYMENT_CONFIRMED`, `PAYMENT_RECEIVED`, `PAYMENT_REFUNDED`, `PAYMENT_PARTIALLY_REFUNDED`, `PAYMENT_DELETED`, `ACCESS_TOKEN_DISABLED`, `ACCESS_TOKEN_EXPIRING_SOON`, `ACCESS_TOKEN_EXPIRED`.
- **Token global (env), não por conta.** O token por conta obrigaria a resolver a conta *antes* de autenticar. E a mesma conta Asaas conectada em dois tenants (o caso que derrubou o MP em 2026-09-25) recebe o evento pelos dois webhooks, o que torna o "dono do token" ambíguo. A proteção real não é o token, é a reconsulta (decisão 5), como na InfinitePay.
- **Sequencial:** a ordem importa, porque um estorno processado antes da confirmação viraria no-op e depois creditaria. Responder 200 logo depois de persistir faz a fila só travar quando a gravação no inbox falha, e nesse caso travar é o certo.
- **Sempre `200` depois de persistir**, inclusive para evento ignorado. Qualquer outro código conta para as 15 falhas que pausam a fila.
- Desconectar → `DELETE /webhooks/{id}`, best-effort.

### 5. Processamento: o dono sai do intent, o fato sai da reconsulta

`_shared/asaas.ts`, no padrão `processXEvent(supabase, StoredEvent)` que o replay já usa:

1. `payment.id` → `payment_intents` (`provider='asaas'`). **Sem intent:**
   - `externalReference` começa com `gomoto:` → **lança erro** (é dinheiro nosso sem dono e precisa ficar na fila de replay);
   - caso contrário → `ignored`. O webhook recebe **tudo** da conta do tenant, inclusive cobranças que ele emite fora do GoMoto. Tratar isso como erro encheria a fila de replay de ruído permanente.
2. Credencial da conta do intent → `GET /payments/{id}`. **O status da API decide, o nome do evento é só gatilho:**
   - `CONFIRMED` | `RECEIVED` → `approved`. Os dois eventos chegam para boleto/cartão; `fn_confirm_gateway_payment` já devolve o pagamento existente quando o intent está `paid` (idempotente por intent), então o segundo não credita de novo;
   - `REFUNDED` → `refunded`;
   - `PARTIALLY_REFUNDED` e os chargebacks → `ignored` + `log('warn')`. `fn_reverse_payment` estorna o valor inteiro, então o parcial precisa de operador (risco aceito; com Pix-only, o chargeback de cartão não ocorre);
   - qualquer outro → `ignored`.
3. `amount = value` (bruto), nunca `netValue`: a tarifa do Asaas é despesa da locadora, não desconto do cliente (mesma lógica de `amount` ≠ `paid_amount` na 0032). `method` vem traduzido de `billingType`.
4. `paidAt`: `paymentDate`/`confirmedDate` são **só data** (verificado), e a fonte do horário (`GET /pix/transactions/{id}`) exige permissão de saque, que a decisão 1 proíbe. Regra: se `paymentDate` é hoje no fuso do tenant, usa o instante da confirmação; senão (reprocessamento tardio), `paymentDate` às 12:00 do fuso do tenant. Assim o pagamento não cai no dia errado do razão.
5. `ACCESS_TOKEN_*` → `ignored` + `log('error')`, com o `account.id`. Ver risco 2.

### 6. `cancelIntent` = `DELETE /payments/{id}`

Implementa o contrato opcional da ADR 0033. Falha não bloqueia o cancelamento local. Verificado: repetir o DELETE dá 200, e apagar cobrança já paga dá 400 `invalid_action`. Esse caso é registrado como "já paga no provedor" (o dinheiro vira crédito pela ADR 0033), não como erro.

## Consequências

### Uma migration

`fn_confirm_gateway_payment` ganha `p_extra_late_charge` (decisão 3). De resto, conferido no catálogo: `payment_provider_accounts.provider` aceita `asaas` (CHECK de formato), `received_by_system ~ '^gateway:[a-z][a-z0-9_]{2,31}$'` aceita `gateway:asaas`, e `payment_method_type` cobre `pix`/`credit_card`/`debit_card`. Só boleto exigiria DDL (decisão 2).

### Arquivos

| Onde | O quê |
|---|---|
| `packages/core/src/payments/providers.ts` | descritor `asaas` (`api_key`, `['pix']`, `minAmount: 5`) |
| `apps/web/src/lib/payment/types.ts` + `registry.ts` | blocos `apiKey` / `disconnect`; coerência no registry; 1 linha no `PROVIDER_REGISTRY` |
| `apps/web/src/lib/payment/providers/asaas/{api,index}.ts` + `api.spec.ts` | cliente HTTP, mapeamento de erro (401 → `ProviderAuthError`, limite diário → erro nomeado) |
| `apps/web/src/lib/payment/intents.ts` | `document: cpf ?? cnpj`; reaproveitamento por valor/base (3b); dois caminhos de emissão |
| `packages/core/src/rules/` | função pura `toAsaasLateChargeTerms(policy, balance, today)` → `{value, dueDate, fine, interest}` + teste Vitest (inclui as divergências conhecidas) |
| `supabase/migrations/<ts>_confirm_gateway_encargo_cobrado.sql` | `p_extra_late_charge` em `fn_confirm_gateway_payment` |
| `apps/web/src/lib/payment/providers/mercadopago/api.ts` | expiração às 23:59 local |
| `configuracoes/actions.ts` | `connectGatewayWithApiKeyAction`; desconectar chama `disconnect` |
| `configuracoes/_components/PaymentGatewaySection.tsx` | ramo `api_key` (campo mascarado, ajuda para criar chave dedicada) |
| `supabase/functions/asaas-webhook/index.ts` | HTTP: token em tempo constante → `recordEvent` → 200 → `waitUntil` |
| `supabase/functions/_shared/asaas.ts` + `asaas.test.ts` | `processAsaasEvent` + tradução status/billingType (deno test via `npx deno`, fora da raiz) |
| `supabase/functions/gateway-replay/index.ts` | 1 linha em `PROCESSADORES` |
| `supabase/config.toml` | `[functions.asaas-webhook] verify_jwt = false` |
| Envs | Vercel: `ASAAS_ENVIRONMENT`, `ASAAS_WEBHOOK_URL`, `ASAAS_WEBHOOK_TOKEN`. Edge: `ASAAS_WEBHOOK_TOKEN` |

Mobile: nenhuma mudança esperada (caminho `pix` já existe). Conferir ao vivo.

### Riscos

1. **Poder da chave — risco reduzido pela sonda.** Verificado: por padrão a chave **não** faz saque nem transferência (403 `insufficient_permission`), e o GoMoto passa a recusar chave que faça (decisão 1, passo 4). O que sobra é o poder de criar, apagar e consultar cobranças e de ler dados da conta. Isso fica no Supabase Vault, lido só por `service_role` (ADR 0034), nunca em log. A whitelist de IP continua inviável (IPs dinâmicos da Vercel/Edge). A tela orienta a criar uma chave dedicada "GoMoto", sem saque, com data de expiração.
2. **A chave morre por inatividade.** Ela é desabilitada com 3 meses sem uso e expira com 6. Uma conta conectada mas não eleita para cobrar morre em silêncio. Mitigação: **sondar a chave (`GET /wallets`) ao eleger como default**, `ProviderAuthError` → "reconecte", e os eventos `ACCESS_TOKEN_*` no log.
3. **Limite diário de criação de cobranças** (`/payments/limits`; 5000 no sandbox, em produção depende da conta). Tem que virar um erro nomeado, não "tente novamente".
6. **Política com `min_amount` > 0 e arredondamento:** o Asaas cobra até alguns centavos a menos que o GoMoto calcula, e menos que o piso enquanto multa+juros não o alcançam. O razão registra o que foi cobrado. Se o produto exigir o piso, ele precisa sair da política para o Asaas.
7. **Tarifa por cobrança paga** (R$ 0,99 num Pix de R$ 5,00 no sandbox). O razão registra o bruto; a tarifa não é lançada como despesa nesta v1, igual aos outros gateways.
4. Estorno parcial e chargeback não são automatizados (decisão 5.2).
5. Um cliente do tenant já cadastrado no Asaas com notificações ligadas continua recebendo notificação do Asaas. Não alteramos dado do tenant.

## Achados da implementação (2026-10-10)

Adaptador testado ao vivo contra o sandbox, com o código real (não com script de sondagem):

| Achado | Consequência no código |
|---|---|
| `POST /webhooks` **exige `email`** ("O parâmetro email deve ser informado"); a doc não marca | `ASAAS_WEBHOOK_EMAIL` (operação do GoMoto), com o e-mail da conta como fallback |
| Chave **com** saque → recusada pela sonda; reconexão → **mesmo** `webhook_id` (localizado pela URL e atualizado com `PUT`) | confirma as decisões 1 e 4 |
| Termos gravados: a vencer → `fine 2% PERCENTAGE`, `interest 0.99`; já vencida → `fine 0`, `interest 0.99`; `externalReference gomoto:<chargeId>` | confirma a decisão 3 |
| Desconectar com o webhook reaproveitado entre tenants apagaria o do outro | `disconnect` só remove o webhook se nenhuma outra conta **ativa** (de qualquer tenant, consulta com `service_role`) usa a mesma carteira |
| **Fuso:** `calculateAmountDue` usava a data do servidor (UTC na Vercel); às 22h de Brasília o encargo saía com 1 dia a mais e o vencimento enviado ao Asaas com 1 dia a mais | `getOrCreateIntent` passa `asOf` = hoje no fuso da locadora (`tenants.timezone`, `business-time.ts`) — vale para os 4 gateways |
| **Mercado Pago, idempotência:** `X-Idempotency-Key` era `billing-<chargeId>` — o código novo de outro dia, com valor atualizado, voltaria como o pagamento antigo | chave por (cobrança, valor em centavos, dia) |
| **Mercado Pago, validade:** 24h corridas | fim do dia da locadora, com o piso de 30 min do MP perto da meia-noite |
| **Encargo realizado em dobro** (defeito pré-existente, reproduzido no banco): o intent gravava `accrued.total`; com encargo já realizado, a confirmação o lançava de novo — R$ 102,73 + 2,80 fechando em 105,53 e **aberta em 2,73** | grava `accrued_pending` (ADR 0038, P6) |
| Cliente PJ: o documento só saía de `cpf` | `cpf \|\| cnpj` e razão social como nome; o MP passou a mandar `type: CNPJ` quando é CNPJ |

## Ciclo completo verificado (2026-10-10, banco local + sandbox)

Código real de ponta a ponta — `getOrCreateIntent` → adaptador → Asaas sandbox → pagamento simulado (`/sandbox/payment/{id}/confirm`) → evento entregue à Edge Function `asaas-webhook` LOCAL com o token → reconsulta real em `GET /payments` → `fn_confirm_gateway_payment`:

| Cenário | Resultado |
|---|---|
| A. A vencer, pago em dia | Pix com QR; segunda chamada **reaproveita** o mesmo intent; cobrança fecha em 100,00 |
| B. Emitido no prazo, pago depois do vencimento | Asaas cobra **102,03** (`interestValue 2.03`); razão realiza **encargo 2,03**; cobrança fecha em 0 |
| C. Reentrega do mesmo evento + `PAYMENT_CONFIRMED` com outro id | 1 pagamento só |
| D. Cobrança emitida fora do GoMoto | processada como ignorada, fora da fila de replay |
| E. Marca `gomoto:` sem intent | fica na fila de replay com erro (dinheiro sem dono) |
| Razão | débitos − créditos = 0,00 |
| Porta do webhook | token errado → 401 (`webhook.bad_token`) |

## Ciclo fechado em PRODUÇÃO com o Asaas sandbox (2026-10-11 00:07 UTC)

Deploy do commit `712c16b` (migration, `asaas-webhook`, `gateway-replay`, envs com `ASAAS_ENVIRONMENT=sandbox`). Locadora "teste 01", cobrança #9 de R$ 5,00:

- Vercel: conectar (00:03:22) → ativar (00:03:37) → criar cobrança → gerar Pix (00:04:27), tudo 200, zero `warning`/`error`.
- Asaas: `pay_p9eoqi38ea6bipnu` com multa 2% / juros 0,99% e `externalReference gomoto:159e7a30…`; webhook de produção com `penalizedRequestsCount 0`, `interrupted false`.
- **Entrega real do Asaas:** um único `PAYMENT_RECEIVED` (Pix não manda `CONFIRMED`, confirmado), `POST 200` em 00:07:00, processado em 00:07:03 (`outcome approved`, `attempts 0`, sem erro, `tenant_id` carimbado).
- Razão: pagamento `gateway:asaas`, Pix, R$ 5,00, `gateway_event_id` ligado; débito `caixa_e_bancos` / crédito `contas_a_receber`, soma 0,00; cobrança `paid`, `open_amount 0`.
- **Fuso validado ao vivo:** pago às 21:07 de Brasília = 00:07 UTC do dia seguinte; o Asaas informou `paymentDate 2026-10-10` = hoje da locadora → `paid_at` = instante da confirmação (e não meio-dia).
- `fn_confirm_gateway_payment` em produção com a assinatura nova e `EXECUTE` só para `postgres`/`service_role`.

Não exercitado em produção (só localmente): pagamento depois do vencimento com `p_extra_late_charge`.

## Split de pagamento — possível no modelo atual (registrado para o futuro, 2026-10-11)

**Modelo atual:** cada locadora tem a própria conta Asaas e o GoMoto opera com a chave de API dela. O GoMoto não tem conta no Asaas, não recebe dinheiro e não é parceiro. **Subcontas (o GoMoto como conta raiz) foram descartadas pelo Alan.**

**Pergunta:** dá para o GoMoto receber uma parte de cada cobrança (ex.: a taxa do SaaS) sem mudar esse modelo? **Sim.** Verificado no sandbox com duas contas **independentes**, nenhuma subconta da outra:

- cobrança de R$ 100 criada na conta "locadora", com a chave dela, com `split: [{ walletId: <carteira de outra conta>, percentualValue: 5 }]` → aceita (200);
- pagamento simulado → split `DONE` em ~3 s, `totalValue 4.95` (5% do `netValue` 99,01), e o saldo da carteira de destino subiu exatamente 4,95.

A doc do Asaas descreve o mesmo caso ("João cria a cobrança em sua própria conta… o Split informa o `walletId` de Marcelo"): basta o recebedor ter conta Asaas.

**O que seria preciso para implementar:**

1. **O GoMoto abrir uma conta Asaas própria** (PJ do GoMoto) para ter um `walletId` de recebimento. É a única relação nova com o Asaas, e não envolve subcontas.
2. `createPixCharge` mandar o array `split` na criação (`fixedValue` com 2 casas e/ou `percentualValue` com 4 casas). A carteira do GoMoto viria de env, nunca da locadora.
3. **Razão da locadora:** hoje o GoMoto lança o valor BRUTO em `caixa_e_bancos`. Com split, parte do dinheiro nunca entra na conta da locadora, e o repasse precisa virar uma perna de despesa ("taxa da plataforma"). Senão o caixa do GoMoto diverge do extrato do Asaas.
4. **Webhooks novos:** `PAYMENT_SPLIT_DONE`, `PAYMENT_SPLIT_CANCELLED`, `PAYMENT_SPLIT_DIVERGENCE_BLOCK` / `_FINISHED`.

**Regras do Asaas que afetam o desenho:**

- O split é calculado sobre o **`netValue`** (depois da tarifa do Asaas), não sobre o valor cobrado do cliente. Com o encargo embutido no `cobv`, o percentual também incide sobre multa e juros.
- Estornar a cobrança **estorna o split junto**.
- Split maior que o líquido **bloqueia o valor por 2 dias úteis** para ajuste e, sem correção, cancela o split.
- Remover e restaurar a cobrança **apaga o split** (é preciso reconfigurar).
- A carteira de destino não pode ser a da própria conta que cobra.

**⚠ Não verificado (só em produção):** a doc cita a lista de *"carteiras autorizadas a receber split fora do arranjo"* (`WALLET_REMOVED_FROM_OUTSIDE_ARRANGEMENT_ALLOW_LIST`), sem explicar quem entra nela. Pode haver uma exigência regulatória ou comercial do Asaas para uma carteira receber split de contas que não são subcontas dela. O sandbox não impôs nada. **Confirmar com o Asaas antes de implementar.**

## Trava de ambiente (2026-10-11)

A recusa de chave de outro ambiente acontecia só na **conexão**. Uma conta conectada com chave sandbox continuava gravada depois da virada do deploy para produção, e:

- **gerava Pix de sandbox** para clientes reais (o adaptador usa o ambiente gravado na credencial);
- pior: um Pix de sandbox **pago no sandbox** chegava pelo webhook e quitava uma cobrança real com dinheiro fictício.

Duas travas, com teste:

1. `createIntent` recusa com `GATEWAY_UNAUTHORIZED` ("reconecte com a chave de produção") antes de chamar o Asaas.
2. `processAsaasEvent`: com `ASAAS_ENVIRONMENT` nos secrets da Edge Function, evento de conta de outro ambiente vira `ignored` com o motivo, e `log('error', 'asaas.ambiente_divergente')`. Sem o secret, aceita qualquer ambiente (desenvolvimento local).

## Migração do sandbox para produção

1. **Conta Asaas da locadora:** aprovada, com **chave Pix cadastrada** (sem ela o QR vence às 23:59) e chave de API "GoMoto" **sem saque via API**. **Sem whitelist de IP** (Vercel e Supabase não têm IP fixo).
2. **Vercel:** `ASAAS_ENVIRONMENT=production` e `vercel deploy --prod`.
3. **Supabase:** `supabase secrets set ASAAS_ENVIRONMENT=production` e `supabase functions deploy asaas-webhook` (a trava 2 vem no código novo).
4. **Locadora de teste:** ativar outro gateway e desconectar o Asaas sandbox. Com as travas, esquecer isto não gera mais Pix de sandbox, mas a locadora fica sem cobrar.
5. Conectar a chave `$aact_prod_` e conferir o rótulo e o webhook no painel do Asaas.
6. Pix real de R$ 5,00, conferido pelo webhook e pelo razão.

## Ainda a confirmar (⚠)

1. ~~Entrega feita pelo próprio Asaas~~ — confirmada em produção (acima).
2. ~~Tela de conexão por chave no navegador~~ — usada pelo Alan em produção.
3. Formato do erro de limite diário e de chave desabilitada por inatividade.

## Para ir a produção

- Deploy da migration `20261010231422_confirm_gateway_encargo_cobrado.sql` e da função `asaas-webhook` (`verify_jwt = false` já no `config.toml`).
- Envs: Vercel → `ASAAS_WEBHOOK_URL` (`https://<projeto>.supabase.co/functions/v1/asaas-webhook`), `ASAAS_WEBHOOK_TOKEN`, `ASAAS_WEBHOOK_EMAIL`, opcional `ASAAS_ENVIRONMENT`. Edge Functions → `ASAAS_WEBHOOK_TOKEN` (o MESMO). Divergirem = toda entrega 401 e a fila do Asaas pausa em 15 falhas.
- Primeiro pagamento real de valor baixo (≥ R$ 5,00) para conferir a entrega do Asaas, como foi feito com Cora e InfinitePay.

## Questões para o humano

Todas respondidas em 2026-10-09:

1. **Risco da chave**: aceito. O GoMoto só aceita chave **sem** saque (sonda `GET /transfers` → 403; verificado também o caso 200 com a chave pagadora, que tem saque).
2. **Multa e juros**: Pix-only na v1, com a política da locadora embutida no `cobv` (decisão 3). A primeira escolha ("QR do dia") foi revista porque não garante a cobrança.
3. **Sandbox**: duas contas, chaves em `apps/web/.env.local` (`ASAAS_SANDBOX_API_KEY`, recebedora sem saque; `ASAAS_SANDBOX_PAYER_API_KEY`, pagadora com saque, só para teste e nunca no GoMoto).
4. **Defeito 3b**: corrigir no mesmo PR, mais a expiração do MP à meia-noite. A garantia universal para MP/Cora/InfinitePay fica para uma ADR própria.
