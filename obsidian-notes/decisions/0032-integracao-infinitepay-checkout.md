# ADR 0032 — Integração InfinitePay, API de Checkout

- **Status:** Aceita
- **Data:** 2026-09-05
- **Autores:** Alan + agente IA
- **Substitui:** —
- **Substituída por:** —
- **Relacionada:** [[decisions/0030-multiplos-gateways-de-pagamento|ADR 0030]], [[decisions/0031-integracao-cora-parceria|ADR 0031]], [[decisions/0024-ledger-financeiro-com-contrapartida|ADR 0024]]

## Contexto

Terceiro gateway. O Mercado Pago e a Cora são variações do mesmo tema: OAuth2, credencial secreta, e um **código Pix** que o GoMoto desenha dentro do próprio produto. A InfinitePay diverge em três eixos ao mesmo tempo, e é isso que exige um ADR em vez de uma linha no registry.

| | Mercado Pago / Cora | InfinitePay |
|---|---|---|
| Conexão | OAuth2 (redireciona, autoriza, volta) | **handle digitado** — a InfiniteTag, pública |
| Credencial | token secreto, com validade e renovação | **nenhuma** — o handle viaja no corpo |
| O que gera | código Pix (`emv` / `qr_code`) | **URL de checkout hospedado** |
| Quem escolhe o meio | nós, na criação | **o cliente**, na página deles |
| Webhook | assinado (MP) ou sem corpo (Cora) | **sem assinatura, com corpo que afirma tudo** |
| Ambiente de teste | homologação | **não existe** |

A documentação (`infinitepay.io/checkout-documentacao`) omite a resposta de sucesso do `POST /links` e marca como opcionais campos que não são, então tudo abaixo foi **sondado contra a API viva** — a maior parte em 2026-09-05, antes de escrever o adaptador, e o resto em 2026-09-06, contra o primeiro pagamento real.

### Superfície real

```
POST /links          { handle, items:[{quantity, price /*centavos*/, description}],
                       order_nsu?, webhook_url?, customer?, address? }
                  →  { "url": "https://checkout.infinitepay.io/<handle>?lenc=..." }

POST /payment_check  { handle, order_nsu, transaction_nsu, slug }   ← os QUATRO obrigatórios
                  →  { success, paid, amount, paid_amount, installments, capture_method }
                     success=false → não consegui responder ≠ paid=false → não foi pago

webhook (POST na webhook_url do link, quando aprovado)
                     { invoice_slug, amount, paid_amount, installments, capture_method,
                       transaction_nsu, order_nsu, receipt_url, items }
```

## Verificado na API viva

Seis achados, todos com consequência em código:

**1. A resposta de `/links` é `{"url": "..."}` e nada mais.** Sem slug, sem id de fatura, sem nome do comerciante. O `invoice_slug` deles só passa a existir quando o webhook chega — tarde demais para identificar a tentativa. Por isso **`provider_intent_id` guarda o nosso `order_nsu`**, um UUID que o adaptador gera. É a única amarra possível, e ser um UUID importa: é o que o webhook usa para achar o dono do dinheiro.

**2. O piso é R$ 1,00, e a mensagem de erro engana.** A recusa vem como `422 {"errors":{"items":["Total price must be greater than 1"]}}` — número em **reais** numa mensagem sobre um campo em **centavos**, então ela se lê como "mais que um centavo". Conferido: 50 e 99 são recusados, 100 passa. (E "greater than" na verdade é "a partir de".) Vive em `descriptor.minAmount`, barrado antes de gastar a chamada.

**3. `payment_check` exige os QUATRO campos, e `success: false` não quer dizer "não pago".** Sondado contra um pagamento real de R$ 1,00:

| Consulta | Resposta |
|---|---|
| `handle` + `order_nsu` | `{"success": false}` |
| `handle` + `slug` | `{"success": false}` |
| `handle` + `transaction_nsu` | `{"success": false}` |
| os quatro, consistentes | `{"success": true, "paid": true, "amount": 100, "capture_method": "pix"}` |
| `order_nsu` **alheio** + transaction/slug reais | `{"success": true, "paid": false, "amount": 0}` |
| `slug` inexistente | `{"success": false}` |
| `handle` de outra conta | `404 Not found` |

Duas leituras, e as duas viraram código:

- A API **cruza** os quatro campos em vez de buscar por um. `success: false` significa "não consegui responder" — parâmetros insuficientes ou inconsistentes. `paid: false` com `success: true` é que significa "não foi pago". Tratar os dois como negativa é o que engoliu o primeiro pagamento real (ver Consequências).
- A resposta é **ancorada no `order_nsu`**: com um pedido que não é daquele pagamento, a resposta é `paid: false` mesmo com transação e slug reais. É isso que torna seguro repassar os dois campos que chegam de fora.

**4. Handle inexistente e Checkout Externo desligado dão o MESMO erro.** `404 external_checkout_not_enabled`, com um `redirect_url` para o painel deles. A mensagem ao operador precisa carregar as duas leituras — tratar como "digitou errado" mandaria conferir um handle correto.

**5. `paid_amount` ≠ `amount`.** No exemplo da própria doc, 1500 e 1510. O excedente são os juros de parcelamento que o **comprador** paga à InfinitePay, não à locadora. Creditar `paid_amount` quitaria a cobrança acima do devido e deixaria o saldo negativo.

**6. Não existe carimbo de liquidação.** Nem o webhook nem o `payment_check` trazem a hora do pagamento.

## Decisões

### 1. `connectionMode: 'handle'` — não `api_key`

A distinção é de segurança, não de vocabulário. Uma chave é segredo: quem a tem, age pela conta. Um handle é público — qualquer pessoa pode criar links para qualquer comerciante com o Checkout Externo ligado.

O risco, portanto, muda de lado: **não é vazamento, é digitação**. Um handle errado manda o aluguel para a conta de um estranho, em silêncio e para sempre. Chamar isso de `api_key` faria a tela mascarar o campo como senha e dar ao operador a impressão exatamente errada sobre o que está em jogo.

### 2. O handle é sondado antes de virar linha no banco

A única prova disponível de que um handle cobra é tentar criar um link. `payment_check` não serve (achado 3). Então a conexão cria um link de verificação de R$ 1,00 e só grava a conta se a API aceitar.

Isso **não prova posse** — nada na API prova — mas mata os dois erros que de fato acontecem (handle inexistente, Checkout Externo desligado) enquanto o operador ainda está olhando para o campo, em vez de na primeira cobrança de um cliente real. Depois de gravar, a tela mostra o link e pede conferência, com o desfazer no mesmo modal.

Custo: um link não pago fica na conta do comerciante a cada conexão.

### 3. O método default vem do gateway eleito

`api/charges/[id]/payment-intent/route.ts` e a action do cockpit escreviam `method: 'pix'` fixo. Funcionava porque os dois gateways existentes geravam Pix; com a InfinitePay eleita, a cobrança morreria em *"InfinitePay não gera cobrança por pix"* — o produto acusando a locadora de pedir algo que ela nunca pediu.

`getOrCreateIntent` passa a cair em `provider.descriptor.methods[0]`, resolvido **depois** de saber qual conta o tenant elegeu. Nenhum chamador nomeia meio de pagamento.

### 4. `payment_link` é o meio, e o payload tem vocabulário próprio

O intent nasce como `payment_link` e o payload grava **`checkout_url`**, deliberadamente fora do vocabulário do Pix. Gravar a URL em `emv` ou `qr_code` faria `ensureQrImage` desenhar o QR de uma URL e o app do cliente exibi-lo como código Pix — um código que o banco não lê.

### 5. O meio REAL só se sabe na confirmação

`payment_link` não é meio de pagamento; é a superfície. Quem escolhe Pix ou cartão é o cliente, na página deles, e isso só volta como `capture_method` no webhook.

`fn_confirm_gateway_payment` já previa isto — tem `p_method DEFAULT NULL` e o comentário *"para o caso de o gateway informar o meio real (ex.: link de pagamento quitado no cartão)"*. Faltava a fiação: `NormalizedPayment` ganhou `method` e `applyPayment` passa `p_method`. MP e Cora seguem mandando `null` e continuam derivando do intent.

### 6. Webhook: três camadas, e a segunda é ancorada no nosso `order_nsu`

Mesma estrutura da ADR 0031, com uma diferença importante. A InfinitePay não assina **e** o corpo afirma o pagamento inteiro — valor, meio, transação. Aceitar essa afirmação deixaria qualquer um que descubra a URL quitar cobrança alheia.

1. **Segredo no path**, comparado em tempo constante. Sem ele configurado, a função recusa tudo.
2. **Reconsulta em `payment_check`**, com os quatro campos — dois deles vindos do corpo do webhook. A primeira versão mandava só o que era nosso, por precaução, e por isso **nunca conseguia confirmar**. Repassar `transaction_nsu` e `invoice_slug` é seguro porque a API os cruza e ancora a resposta no nosso `order_nsu` (achado 3): parear uma transação real e alheia com um pedido nosso devolve `paid: false`.
3. **Tenant resolvido pelo nosso registro** — `order_nsu` procurado em `payment_intents`.

`signature_valid` fica `false` para sempre.

**A retentativa deles é invertida:** `200` é "entregue", **`400` é "reenviar"** — o oposto da convenção. Por isso a falha de persistência responde 400, não 500.

O valor da API é conferido contra o do intent e a divergência **é registrada, não recusada**: dinheiro que entrou tem que ser reconhecido (ADR 0024), mas alguém precisa olhar.

### 7. A URL do webhook viaja em cada link

Diferente da Cora, cadastrada uma vez no painel deles: aqui `webhook_url` vai no corpo de cada `POST /links`, então `apps/web` conhece a URL com o segredo. Mesmo arranjo que o Mercado Pago já usa.

**Ausente, a criação FALHA.** Um link sem retorno é pior que link nenhum: o cliente paga, o dinheiro entra na conta da locadora e a cobrança fica aberta para sempre, porque nada avisa o GoMoto.

### 8. O Vault guarda o handle mesmo ele não sendo segredo

Deliberado. Manter um único caminho de credencial (`fn_provider_credentials`, no web e na Edge Function) vale mais que economizar uma ida ao Vault. A coluna `external_account_id` continua sendo a identidade que o webhook procura.

## Consequências

### Zero migrations

A fundação da ADR 0030 absorveu o provedor sem uma linha de DDL:

| | |
|---|---|
| `payment_intents.method` | o CHECK já aceita `payment_link` |
| `fn_confirm_gateway_payment` | já tem `p_method DEFAULT NULL` |
| `payment_method_type` | já tem `pix` e `credit_card` |
| `payment_provider_accounts.provider` | CHECK é regex de formato |
| `fn_connect_provider_account` | genérica, serve conexão por formulário |
| `resolveCredentials` | sem refresh e sem validade, devolve como está |

### Riscos aceitos

- **Posse do handle não é verificável.** A sonda pega digitação errada, não má-fé.
- **Chargeback de cartão é silencioso.** O cliente pode pagar em 12x e contestar semanas depois; a InfinitePay não documenta webhook de reversão. `fn_reverse_payment` existe e nada o chamará por este caminho — só conciliação manual. Pix no MP e na Cora não voltava; este risco é novo.
- **O razão grava quando confirmou, não quando pagou** (achado 6).
- **Sem sandbox.** Todo teste é dinheiro real. Pix é taxa zero, o que torna o teste barato, não gratuito.

### O defeito que o primeiro pagamento real revelou

O ciclo foi testado em produção com R$ 1,00 por Pix. O webhook chegou íntegro e em menos de um segundo, com `amount: 100`, `capture_method: "pix"` e o `order_nsu` certo — e **a cobrança continuou aberta**.

Duas causas, uma dentro da outra:

1. A reconsulta mandava só `handle` + `order_nsu`. A API exige os quatro (achado 3) e respondeu `success: false`.
2. `success: false` era traduzido para `outcome: 'ignored'`, que o inbox trata como "nada a fazer". O evento foi marcado como **processado**, saiu da fila de replay, e não sobrou nem erro nem sintoma — só uma cobrança aberta que ninguém sabia por que não fechou.

O segundo é o mais grave, e é o que este ADR quer que fique registrado: **"não consegui verificar" foi codificado como "não foi pago"**. A correção separa os dois — `success: false` agora levanta exceção, e exceção deixa o evento com `processed_at IS NULL`, que é exatamente para isso que a fila existe.

O primeiro seria pego por qualquer teste ao vivo. O segundo teria escondido o primeiro para sempre.

## O que somar um gateway custou desta vez

Nenhum arquivo fora de `providers/infinitepay/` precisou saber que a InfinitePay existe, exceto: uma linha no registry, o descritor no catálogo, o ramo `handle` da tela de configurações e o ramo `payment_link` da tela de cobrança. As duas correções transversais — método default e `p_method` no inbox — eram defeitos latentes da ADR 0030, não custo deste provedor.

## Em aberto, saindo daqui

**Telefone e endereço — resolvido em 2026-10-18.** Clientes reclamavam de preencher telefone, e-mail e endereço no checkout a cada pagamento. O cliente já está identificado (login por CPF, cobrança ligada ao cadastro), então o GoMoto passou a enviar o que tem:

- `CreateIntentParams.customer` ganhou `phone` e `address`, **opcionais e lidos só pela InfinitePay**. Os outros adaptadores geram o Pix aqui e os ignoram; o contrato documenta isso para nenhum passar a depender deles sem revisão.
- `toInfinitePayPhone` (em `providers/infinitepay/api.ts`) converte o `phone` livre para E.164 e **omite** o que não reconhece: sem telefone o checkout só pergunta, com telefone recusado o link inteiro falha.
- `toInfinitePayAddress` mapeia para `cep` (só dígitos), `street`, `number`, `neighborhood` e `complement`. A API não tem cidade nem estado. Vai **tudo ou nada**: endereço pela metade travaria campo em branco, como o `name: null`.
- A ficha do cliente avisa a locadora quando falta dado, só com a InfinitePay eleita, usando as mesmas duas funções. Completar o cadastro é responsabilidade da locadora; o cliente não edita o próprio cadastro pelo app.

A objeção anterior ao endereço ("dado pessoal circulando à toa") não se sustentava: o checkout pede o endereço de qualquer forma, ao mesmo destinatário. Enviar não aumenta a exposição, só poupa o cliente.

Continua fora do nosso alcance: a API **não tem campo de CPF**, e a doc diz que os dados chegam "preenchidos", sem garantir que o formulário seja pulado. O que a página ainda pede precisa ser conferido uma vez com um pagamento real de R$ 1,00, já que não há sandbox.

Fechar este ciclo revelou um defeito que **não é da InfinitePay** e vale para os três gateways: cancelar uma cobrança não expira o intent pendente, o código de pagamento continua vivo no provedor, e dinheiro que chegue depois deixa `contas_a_receber` negativo. Registrado em [[decisions/0033-dinheiro-para-cobranca-cancelada|ADR 0033]], junto com a ausência de um consumidor para a fila de replay.
