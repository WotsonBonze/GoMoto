# ADR 0038 — Garantia de multa e juros em todos os gateways

- **Status:** Proposta
- **Data:** 2026-10-09
- **Autores:** Alan + agente IA
- **Substitui:** —
- **Substituída por:** —
- **Relacionada:** [[decisions/0024-ledger-financeiro-com-contrapartida|ADR 0024]], [[decisions/0028-encargo-e-grandeza-corrente-nao-divida-nova|ADR 0028]], [[decisions/0030-multiplos-gateways-de-pagamento|ADR 0030]], [[decisions/0031-integracao-cora-parceria|ADR 0031]], [[decisions/0032-integracao-infinitepay-checkout|ADR 0032]], [[decisions/0033-dinheiro-para-cobranca-cancelada|ADR 0033]], [[decisions/0037-integracao-asaas|ADR 0037]]

## O requisito

Nas palavras do Alan (2026-10-09): *"uma cobrança atrasada não pode ser paga sem cobrar a multa e juros"*, com preferência explícita por soluções em que a cobrança do encargo seja **garantida**, não apenas provável.

"Garantida" aqui significa: um código de pagamento que o cliente **guardou** (print, copia-e-cola, link salvo) e usa dias depois, sem abrir o app, ainda assim paga multa e juros até o dia do pagamento — **ou** não consegue pagar.

## Como cada gateway gera a cobrança hoje

A geração é **sob demanda**: nada é emitido no provedor quando a cobrança nasce. O código só é criado quando alguém pede, por dois caminhos:

- app do cliente → `POST /api/charges/[id]/payment-intent` (`route.ts`);
- cockpit → action em `cobrancas/[id]/actions.ts`.

Os dois chamam `getOrCreateIntent` (`apps/web/src/lib/payment/intents.ts`), que:

1. reaproveita a tentativa `pending` se `expires_at` ainda não passou (**só isso é conferido**, ver P1);
2. senão, calcula `amount_due = calculateAmountDue(saldo, política fixada na cobrança)`: principal + multa + juros **até hoje** (`@gomoto/core`, ADR 0028);
3. cria o intent no gateway eleito com esse valor e grava `payment_intents.amount` e `accrued_amount` (o encargo embutido);
4. na confirmação, `fn_confirm_gateway_payment` realiza **exatamente** o `accrued_amount` gravado, não recalcula (`20260820204953_gateway_realiza_encargo.sql`: *"recalcular no momento da confirmação daria outro número e o pagamento deixaria de fechar"*).

Ou seja: o valor do encargo é **congelado no instante em que o código é gerado**. Tudo abaixo é consequência disso.

| Gateway | O que gera | Vencimento / validade | Encargo dentro do código | Quem impõe a validade |
|---|---|---|---|---|
| **Mercado Pago** | Pix dinâmico (QR + copia-e-cola) | `date_of_expiration` = **agora + 24h** (`mercadopago/api.ts:139`) | não, valor fixo | MP (QR dinâmico: o banco do pagador consulta o status) |
| **Cora** | invoice com Pix (`emv`) | `due_date` = hoje (`cora/index.ts`), validade do Pix **desconhecida**; `expires_at` gravado `null` | não, valor fixo; `payment_terms` só com `due_date` | ? (não sondado) |
| **InfinitePay** | link de checkout hospedado | **sem validade**, a API não oferece; `expires_at null` | não, valor fixo | ninguém |
| **Asaas** (ADR 0037) | Pix com vencimento (`cobv`) | vencimento + **12 meses** (verificado) | **sim**: `fine`/`interest` traduzidos da política; o banco do pagador calcula | padrão Pix Cobrança (BACEN) |

## Os problemas

### P1 — O GoMoto entrega código velho (todos os gateways)

`getOrCreateIntent` reaproveita a tentativa olhando só `expires_at` (`intents.ts:66`). Com `expires_at = null` (Cora, InfinitePay), o Pix de uma cobrança vencida gerado no dia 10 é devolvido no dia 15 com o valor do dia 10, e a confirmação realiza o encargo do dia 10. Os juros dos dias 11–15 somem sem erro, alerta ou registro.

**Corrigido no PR do Asaas (ADR 0037, decisão 3b)**: reaproveitar só se o intent ainda representa a dívida de hoje; senão expira, cancela no provedor (best-effort) e gera outro.

### P2 — O código guardado pelo cliente continua pagável com o valor velho

P1 corrigido impede o GoMoto de *entregar* um código velho, mas não impede o cliente de *usar* o código que já tem. É o buraco do requisito.

| Gateway | Janela em que o código salvo paga sem o encargo novo | Gravidade |
|---|---|---|
| Mercado Pago | até 24h depois de gerado → no máximo ~1 dia de juros (e a multa, se o código foi gerado antes do vencimento e pago depois) | baixa |
| Cora | desconhecida: o Pix da invoice pode valer depois do `due_date` | **a verificar** |
| InfinitePay | **ilimitada**: o link não expira e a API não cancela | **alta** |
| Asaas | nenhuma: o `cobv` soma multa e juros na hora de pagar | resolvido (ADR 0037) |

Caso agravante: um código gerado **antes do vencimento** (sem multa) e pago depois dele quita a cobrança **sem multa nenhuma**, não só sem alguns dias de juros.

### P3 — A confirmação não sabe que o pagamento chegou tarde

`fn_confirm_gateway_payment` aloca o valor pago e realiza o `accrued_amount` do intent. Ela não compara a data do pagamento com a data em que o código foi gerado. Um pagamento que chega dias depois fecha a cobrança como se tivesse chegado no dia da geração. É a mesma raiz de P2, vista do lado do razão.

### P4 — Divergências de cálculo quando o provedor calcula (Asaas)

Aceitas na ADR 0037: o juro mensal tem 2 casas e o valor é truncado (±centavos); `min_amount` (piso do encargo) não existe no Asaas; para uma cobrança já vencida há um pequeno juro sobre o encargo embutido. Em todas, o provedor cobra **igual ou menos**, nunca mais.

### P6 — Encargo realizado em dobro quando já havia encargo realizado (todos os gateways) — CORRIGIDO

`getOrCreateIntent` gravava `accrued_amount = accrued.total`, e `fn_realize_late_charge` lança o valor inteiro como item novo. Com encargo já realizado (pagamento parcial ou estorno, o cenário da ADR 0028), a confirmação o lançava de novo. Reproduzido no banco: cobrança de R$ 100 com 2,73 realizado, pagamento de 102,80 → total 105,53, **aberta em 2,73**. Corrigido no PR do Asaas: o intent grava `accrued_pending`.

### P5 — Sem estorno parcial e sem chargeback automatizados

Fora do escopo deste ADR, registrado para não se perder: InfinitePay (cartão) não tem webhook de reversão; Asaas `PAYMENT_PARTIALLY_REFUNDED` vai para o operador.

## Estratégias possíveis

| # | Estratégia | Garante? | Onde funciona | Custo |
|---|---|---|---|---|
| E1 | **Encargo embutido no código** (o banco do pagador calcula) | **sim**, pelo padrão Pix Cobrança | Asaas (verificado); Cora **talvez** (`payment_terms` pode aceitar multa/juros — a sondar) | traduzir a política; divergências P4; razão registra o encargo cobrado |
| E2 | **Validade curta imposta pelo provedor** (código morre à meia-noite) | sim, se o provedor recusa de fato | MP (`date_of_expiration`, QR dinâmico); Asaas QR estático (não verificável no sandbox) | o cliente gera um código novo por dia |
| E3 | **Cancelar no provedor quando o valor muda** (`cancelIntent`) | não: corrida com o cliente pagando, e o provedor pode nem oferecer | MP, Cora, Asaas; **não** InfinitePay | já existe (ADR 0033), usado por P1 |
| E4 | **Garantia no razão: a cobrança não fecha se o pagamento chega tarde** | **sim, para qualquer gateway**: o dinheiro entra, a diferença de encargo fica em aberto como dívida | todos, inclusive InfinitePay | levar o cálculo do encargo para SQL (hoje só existe em `@gomoto/core`), com teste de paridade TS × SQL |

E4 não impede o pagamento a menor, mas impede que ele **quite** a dívida: a cobrança continua aberta com o encargo restante, e o próximo código já sai com ele. Para um gateway sem validade (InfinitePay) é a única garantia possível.

## Recomendação

Defesa em camadas, por gateway:

| Gateway | Camada principal | Complemento |
|---|---|---|
| Asaas | E1 (ADR 0037) | — |
| Mercado Pago | E2: expirar às **23:59 do fuso do tenant** em vez de 24h corridas — **feito** no PR do Asaas, junto da chave de idempotência por (cobrança, valor, dia) | E4 |
| Cora | sondar se `payment_terms` aceita multa/juros no Pix → E1; senão E2/E3 | E4 |
| InfinitePay | **E4**: não há outra | — |

Ordem de execução:

1. **PR do Asaas (ADR 0037):** E1 no Asaas, P1 corrigido para todos, E2 no Mercado Pago.
2. **Este ADR, quando aprovado:** E4. Função SQL de encargo espelhando `calculateAccruedCharges`, teste de paridade com a função TS sobre uma tabela de casos, e `fn_confirm_gateway_payment` passando a apurar o encargo pela **data do pagamento**, não pela da geração. Com o encargo excedente em aberto, a cobrança não fecha.
3. Sondar a Cora (homologação) para E1.

## Questões em aberto

1. E4 duplica a regra do encargo em TS e SQL. Alternativa: mover o cálculo **só** para SQL e o TS passar a lê-lo. É mais fiel à memória *"invariante mora no banco"*, porém maior. Qual?
2. Pagamento tardio sob E4 deixa resíduo pequeno (centavos a poucos reais). Vale um valor mínimo de resíduo abaixo do qual o encargo é perdoado, para não gerar cobrança de R$ 0,12?
3. InfinitePay: com E4 o cliente pode pagar o link velho e continuar devendo. A tela do link deve avisar que ele vale só para hoje?
