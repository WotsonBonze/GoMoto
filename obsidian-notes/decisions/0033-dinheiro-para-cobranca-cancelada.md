# ADR 0033 — Dinheiro que entra e ninguém percebe

*(cobrança cancelada, fila de replay e renovação de credencial no webhook)*

- **Status:** 🟢 **Aceita e CONCLUÍDA.** **Questão 1 decidida e implementada em 2026-09-07** — dinheiro de cobrança cancelada vira **crédito do cliente**, e cancelar passa a cancelar no provedor quando ele oferece. **Questão 2 FECHADA** em 2026-09-07 pela [[decisions/0034-auditabilidade-do-caminho-do-dinheiro|ADR 0034]]: a **2a** pelas Fases 3b e 4 (a fila ganhou consumidor), e a **2b** pela renovação de credencial na rota de drenagem — que roda em `apps/web` e portanto *alcança* `resolveCredentials`, coisa que o webhook em Deno nunca pôde. A confirmação sem verificação continua existindo, mas deixa de ser o caminho normal e volta a ser o último recurso que ela sempre deveria ter sido.
- **Escopo:** três buracos de naturezas diferentes, unidos por um sintoma só — dinheiro real que entra e não vira registro correto. Ficaram no mesmo ADR porque a Questão 1 é o buraco contábil e a Questão 2 é o que faria qualquer um deles ser **notado**; separá-los produziria dois documentos que só fazem sentido lidos juntos.
- **Data:** 2026-09-06
- **Autores:** Alan + agente IA
- **Substitui:** —
- **Substituída por:** —
- **Relacionada:** [[decisions/0030-multiplos-gateways-de-pagamento|ADR 0030]], [[decisions/0032-integracao-infinitepay-checkout|ADR 0032]], [[decisions/0024-ledger-financeiro-com-contrapartida|ADR 0024]], [[decisions/0029-cancelar-manutencao-desfaz-o-que-ela-criou|ADR 0029]]

## Contexto

Descoberto em 2026-09-06, ao fechar o ciclo da InfinitePay em produção. **Não é defeito da InfinitePay** — vale para os três gateways e é anterior a ela. O checkout hospedado só tornou visível, porque um link de pagamento é uma URL que alguém pode ter salvo no WhatsApp, enquanto um QR Pix tende a ser usado ou descartado na hora.

### O que acontece hoje

`cancelCharge` (`apps/web/src/lib/financial/charges.ts`) faz três coisas:

1. Recusa se já houver pagamento alocado;
2. Marca `charges.status = 'cancelled'`;
3. **Reverte a emissão no razão** — desfaz o débito em `contas_a_receber` e o crédito em receita.

E **não toca em `payment_intents`**. Verificado: nenhuma migration e nenhum caminho de aplicação expira o intent no cancelamento. O intent segue `pending` e — o que importa — **o código de pagamento continua vivo no provedor**. O link abre. O QR escaneia.

Se alguém pagar, `fn_confirm_gateway_payment` (migration `20260904222939_multi_gateway.sql`) **não pergunta o status da cobrança**. Ela lê `charges` só para pegar `customer_id`, `rental_id` e `charge_number`, cria o pagamento, insere a alocação e lança:

```
débito   caixa_e_bancos      ✅ o dinheiro entrou mesmo
crédito  contas_a_receber    ❌ mas a emissão já tinha sido revertida
```

**Consequência:** `contas_a_receber` daquele cliente fica **negativo**. O razão continua batendo em zero — o dinheiro é real, a partida dobrada está correta —, mas a conta de recebíveis passa a afirmar que a locadora deve ao cliente, em vez de afirmar que recebeu um adiantamento.

## Por que cancelar no provedor não resolve sozinho

O Mercado Pago e a Cora oferecem cancelamento. Verificado em 2026-09-06:

| Gateway | Endpoint | Restrição |
|---|---|---|
| Mercado Pago | `PUT /v1/payments/{id}` → `{"status":"cancelled"}` | só em `pending`, `in_process`, `authorized` |
| Cora | `DELETE /v2/invoices/{id}` → `204` | recusa se já pago (`REC-0006`) |
| InfinitePay | **não existe** | a API tem só `/links` e `/payment_check` |

⚠️ A página da Cora fala em "boleto". Na API v2 deles boleto e Pix são a mesma entidade `invoice` — é o mesmo `POST /v2/invoices` de onde lemos o `pix.emv` —, então o `DELETE` **deve** servir para os dois. **Isso é inferência e precisa ser conferido na homologação.** Nesta família de integrações, toda inferência não verificada ao vivo já saiu errada ao menos uma vez (ver ADR 0031 e 0032).

Cancelar no provedor **reduz a probabilidade** de dinheiro chegar para uma cobrança cancelada. Não elimina o caso, por quatro motivos:

1. **A InfinitePay não tem como.** Um terço dos gateways fica descoberto por definição.
2. **A chamada pode falhar** — rede, credencial expirada, provedor instável.
3. **Existe corrida.** O cliente pode estar com o código aberto e pagar no mesmo segundo do cancelamento.
4. **O Mercado Pago só cancela dentro de uma janela de status.** Fora dela, a resposta é erro.

Ou seja: a pergunta "o que o razão faz quando esse dinheiro chega mesmo assim" continua precisando de resposta, independentemente do cancelamento remoto.

## Questão 1 — ✅ DECIDIDA E IMPLEMENTADA em 2026-09-07

> **Decisão do humano:** cancelar uma cobrança que já gerou cobrança no gateway deve **cancelar no provedor quando essa funcionalidade existe**; e o dinheiro que chegar para uma cobrança cancelada **vira crédito do cliente**.
>
> **Por que crédito.** Cancelar é dizer ao cliente "você não deve isto". O dinheiro que chega depois é dele, não da locadora — a contrapartida certa é a dívida com o cliente, que é o que `creditos_de_clientes` representa. Manter como recebível exigiria uma dívida que foi explicitamente extinta. Recusar nunca foi opção: a ADR 0024 exige que o que entrou seja reconhecido.
>
> **A metade local**, em `fn_confirm_gateway_payment`: com a cobrança `cancelled`, ela cria o pagamento (o dinheiro entrou), **não cria alocação** — alocar era exatamente o que tornava `contas_a_receber` negativo —, cria o `customer_credits` com origem `cancelled_charge` e lança débito `caixa_e_bancos` / crédito `creditos_de_clientes`. O encargo **não** é realizado: ele acompanha uma dívida que deixou de existir.
>
> A ressalva viaja no `payments.notes`, como a da confirmação sem verificação já fazia: *"cobrança #N estava cancelada; valor virou crédito do cliente"*. Quem lê o recebimento entende por que ele não quitou nada.
>
> **A metade remota**, em `cancelChargeIntents`: expira a tentativa aqui e tenta cancelar no provedor. `PaymentProvider.cancelIntent` é **opcional** — a InfinitePay não oferece cancelamento, e um método obrigatório produziria uma implementação que joga fora, indistinguível de uma que funciona.
>
> O cancelamento remoto **nunca bloqueia**. Ele reduz a probabilidade de o dinheiro chegar, jamais a elimina — e é por isso que a metade local existe. Verificado no teste: com a credencial ausente, a chamada ao provedor falha, é engolida, e a tentativa é expirada do mesmo jeito.
>
> ⚠️ **O `DELETE /v2/invoices/{id}` da Cora continua NÃO VERIFICADO ao vivo.** O token de produção estava vencido na hora de sondar, e renovar à mão exige o client secret, que está Sensitive na Vercel. O código está escrito conforme a documentação e marcado como inferência — e o desenho protege contra ela estar errada, porque falha remota não impede nada.
>
> **Escopo:** só `cancelled`. Uma cobrança BAIXADA (`written_off`) que recebe dinheiro é **recuperação de perda** — o cliente devia mesmo, e nós é que desistimos de cobrar. Tratar as duas igual criaria crédito para quem estava em dívida. Fica como caso separado, sem resposta ainda.

O diagnóstico original segue abaixo.

### O conserto local (duas metades)

### Metade mecânica: cancelar expira os intents pendentes

Sem decisão a tomar. É o mesmo movimento que `fn_disconnect_provider_account` já faz ao desconectar uma conta, e que `fn_set_default_provider_account` faz ao trocar o gateway eleito — os dois marcam `payment_intents.status = 'expired'`. Falta o terceiro chamador.

Fecha a porta da nossa tela. Não fecha a do provedor.

### Metade que exige decisão: o que a confirmação faz com esse dinheiro

**Recusar viola a ADR 0024** — dinheiro que entrou tem que ser reconhecido. Então as opções reais são:

| Opção | Lançamento | Consequência |
|---|---|---|
| **A. Crédito do cliente** *(recomendada)* | débito `caixa_e_bancos` / crédito `creditos_de_clientes` | Contabilmente correto: é adiantamento, não quitação. O saldo fica disponível para abater outra cobrança pelo fluxo que já existe. |
| B. Manter recebível | como hoje | `contas_a_receber` negativo, sem significado contábil. |
| C. Recusar e alertar | nenhum | Dinheiro real sem registro. Viola a ADR 0024. |

A **A** é a recomendação, mas muda a política financeira do produto — o dinheiro deixa de quitar aquela cobrança e vira saldo do cliente. **É chamada do humano, não do agente.**

## Questão 2 — a fila de replay não é drenada, e o webhook não sabe renovar credencial

São duas descobertas que parecem separadas e têm o mesmo conserto.

### 2a. Nada consome a fila — ✅ RESOLVIDO em 2026-09-07 (ADR 0034, Fases 3b e 4)

> A Edge Function `gateway-replay` é o consumidor que faltava, acionada pelo botão "Reprocessar" da tela de diagnóstico e por cron diário. Ela chama **o mesmo processador** do webhook — não uma segunda implementação —, porque cada processador lê exclusivamente do payload gravado. O texto abaixo é o diagnóstico original, preservado.


`gateway_events` com `processed_at IS NULL` é a fila de reprocessamento, e `idx_gateway_events_unprocessed` existe para ela. **Nada a consome automaticamente.**

Ficou mais relevante depois da correção da ADR 0032: falha de verificação agora *deve* parar nessa fila em vez de sumir. É a escolha certa — mas hoje ela depende de alguém olhar.

Agravante: o padrão é **responder antes de processar**, então quando o processamento falha o provedor já recebeu `200` e não vai reenviar. A retentativa do provedor não cobre esse caso.

### 2b. O webhook não renova credencial — ✅ RESOLVIDO em 2026-09-07 (ADR 0034)

> **O diagnóstico abaixo estava certo, e a saída apareceu de onde ele não olhou.**
>
> O texto conclui que "o processamento está no runtime errado" e descarta copiar a renovação para o Deno. Ambas as coisas seguem verdadeiras. O que mudou é que a Fase 4 criou uma rota de drenagem **em `apps/web`** — Node, mesmo runtime de `resolveCredentials`. Renovar ali, antes de acionar o replay, não duplica orquestração nenhuma: reusa a que já existe, com margem, reivindicação, lease e rotação.
>
> Renovação por CONTA e não por evento, para não gastar a janela de 3 usos da Cora com dez eventos do mesmo lote. Falha de renovação nunca interrompe a drenagem — refresh token morto é caso de reconectar, não de travar os outros eventos.
>
> Verificado com mock que **recusa o token velho**: mesmo evento, mesmo token, a única diferença sendo a renovação ter rodado — sem ela, `accepted_unverified` com "Confirmado SEM verificação"; com ela, `confirmed` com "Confirmado pelo gateway".
>
> O diagnóstico original fica preservado abaixo.


A renovação vive em `apps/web/src/lib/payment/credentials.ts` (Node, workspace pnpm). As Edge Functions são **Deno** e não alcançam `packages/core` nem `apps/web` — o mesmo motivo pelo qual `_shared/inbox.ts` existe em vez de morar no core. As functions usam `accountCredentials()`, que é leitura pura do Vault.

Consequência concreta, **só na Cora**: token de 24h, renovado apenas quando uma cobrança é gerada. Cobranças emitidas na segunda e pagas na quinta chegam com token vencido — a reconsulta da invoice dá 401 e o evento cai na fila de 2a, que ninguém drena. Mercado Pago (~180 dias) e InfinitePay (handle, não vence) não têm essa exposição.

**Fazer o webhook renovar copiando a orquestração para o Deno é a saída errada.** Seriam duas cópias de margem, reivindicação, lease, release e gravação — decidindo sobre rotação de token, que na Cora tem janela de 3 usos — obrigadas a ficar em sincronia para sempre. É exatamente a duplicação que o `_shared/inbox.ts` foi criado para evitar.

O diagnóstico real: **o processamento está no runtime errado.** A Edge Function tem duas responsabilidades coladas — *receber* (que precisa ser Deno, rápido, na borda) e *processar* (que precisa de credencial, HTTP ao provedor e escrita no razão). A segunda não tem por que estar ali.

### Por que cron de renovação NÃO é a resposta

Descartado, com motivo:

- **Não elimina o caso.** Cron que perde uma janela — deploy, rede, provedor fora — deixa o webhook chegar com token vencido do mesmo jeito. Troca "sempre falha depois de 24h" por "falha às vezes", que é pior de diagnosticar.
- **Custa rotação à toa.** Varrer toda conta conectada a cada N horas multiplica o consumo da janela de 3 usos da Cora, inclusive para tenants que não cobram há semanas. E a Cora encerra a sessão com 60 dias de inatividade de qualquer forma: manter token vivo de conta parada não mantém a conexão viva (ADR 0031).
- **Falha em silêncio.** A renovação preguiçosa quebra na frente de quem está tentando cobrar, com mensagem dizendo "reconecte a conta". Cron que falha às 3h falha para um log.

### DECIDIDO em 2026-09-06: confirmar sem verificar, quando a credencial vencer

**Implementado.** Único ponto deste ADR que saiu do papel.

O humano decidiu assumir o risco: se a camada 2 não puder ser exercida **porque a credencial venceu**, o webhook confia no evento recebido e confirma o pagamento. A alternativa era manter a cobrança aberta com o dinheiro já na conta da locadora, esperando um drenador que ainda não existe.

Quatro travas, porque isto abre mão de uma camada de defesa:

1. **Só credencial recusada** (`401`/`403`). Um `500` ou queda de rede continuam falhando — são transitórios, e confirmar por causa deles seria inventar pagamento a partir de instabilidade. `CoraCredentialError` existe só para separar os dois casos.
2. **Só `invoice.PAID`.** Qualquer outro evento não vira dinheiro.
3. **O valor é NOSSO**, de `payment_intents.amount` — nunca da requisição. Aqui a Cora ajuda: o webhook dela **não tem corpo**, só três headers, então não há valor externo a confiar. Uma notificação forjada não escolhe quanto creditar; no máximo confirma exatamente o que já íamos cobrar.
4. **Fica marcado, em dois lugares.** `payments.notes` recebe *"Confirmado SEM verificação na API da Cora — credencial vencida (ADR 0033)"* — a ressalva viaja junto do dinheiro, no registro que o operador lê. E `gateway_events.processing_error` recebe `CONFIRMADO_SEM_VERIFICACAO`, com `processed_at` preenchido: processado **e** com ressalva.

Para achar todos:

```sql
select id, received_at, tenant_id, payload
from gateway_events
where processing_error like 'CONFIRMADO_SEM_VERIFICACAO%'
order by received_at desc;
```

**Só a Cora.** O Mercado Pago não foi tocado — token de ~180 dias torna o caso quase hipotético, e mexer em webhook antigo sem exposição real é risco sem retorno. A InfinitePay é excluída por construção: não usa token, e o `success: false` dela significa "não consegui responder", que **não** pode virar confirmação — seria ressuscitar o defeito que a ADR 0032 corrigiu, em versão pior.

O que se perde: uma notificação forjada, por quem descubra o segredo do path **e** conheça um `webhook-resource-id` válido, confirma uma cobrança que talvez não tenha sido paga — dentro da janela em que a credencial estiver vencida. O valor é limitado ao da cobrança, e a linha fica marcada.

**Isto é medida de fase, não desenho final.** Cai quando o webhook puder renovar credencial — ou seja, quando o processamento sair do Deno (etapa 2 abaixo).

### CORRIGIDO em 2026-09-06: pagamento sem tentativa correspondente sumia

Terceira aparição da mesma forma, encontrada ao explicar por que o `invoice.DRAFTED` chega antes do nosso `INSERT`.

`applyPayment` fazia isto quando não achava a tentativa:

```ts
if (!intent) { log('warn', 'webhook.intent_not_found', ...); return }
```

O chamador seguia e marcava o evento como **processado**. Ou seja: um pagamento aprovado que não encontrasse a sua tentativa saía da fila sem deixar nada além de uma linha de log — exatamente o que a ADR 0032 corrigiu no `success: false`, e o que a Questão 1 descreve para cobrança cancelada.

Não era hipótese: o próprio código já reconhecia invoices órfãs. O comentário do caminho `23505` em `getOrCreateIntent` diz *"a tentativa criada no provedor fica órfã e expira sozinha"* — a Cora criou a invoice, o nosso INSERT perdeu a corrida do índice único, e a invoice ficou pagável sem dono nenhum do nosso lado.

Agora, `outcome === 'approved'` sem tentativa **levanta exceção**, e a exceção deixa `processed_at IS NULL` com `processing_error`. Estorno e evento ignorado sem tentativa seguem passando: sem tentativa também não há pagamento nosso, então não há o que desfazer.

Corrigido nos três provedores de uma vez, porque mora em `_shared/inbox.ts`. Os webhooks da Cora e da InfinitePay ganharam a mesma trava na resolução do intent, antes da camada 2.

### O conserto, em duas etapas

**Etapa 1 — drenador da fila, em `apps/web`.** Cobre *toda* falha de processamento (token vencido, provedor fora, bug nosso), não só expiração. Rodando em `apps/web` (Vercel Cron → route handler), ele **ganha o `resolveCredentials` de graça**: renovação incluída, zero duplicação para o Deno. Resolve 2a e 2b de uma vez.

**Etapa 2 — mover o processamento para `apps/web`**, deixando a Edge Function como recebedor fino: valida segredo, grava no inbox, responde `200`. Aí o caminho quente também renova e existe uma cópia só de tudo. É bem maior do que parece e não deve ir junto com a etapa 1.

### Lacuna adjacente, registrada aqui para não se perder

Contas do Mercado Pago conectadas **antes** da ADR 0031 não têm `expires_at` gravado na credencial. Sem validade conhecida, `resolveCredentials` devolve o que tem e nunca renova — o código assume isso, e um 401 lá na frente vira "reconecte a conta". Some na primeira reconexão de cada conta; não precisa de migração.

## Ordem sugerida

1. **Metade mecânica da Questão 1** — barata, sem decisão pendente.
2. **Decisão sobre o destino do dinheiro** — é o buraco contábil real.
3. **Etapa 1 da Questão 2** (drenador em `apps/web`), que é o que faz qualquer um dos casos acima ser notado — e de quebra dá renovação de credencial ao reprocessamento.
4. **`cancelIntent?()` no contrato de provedor** — camada de redução de ruído, depois que o buraco estiver fechado.

Sobre o passo 4: o método entra **opcional** no `PaymentProvider`, com `?`, pela mesma razão que `oauth?` é opcional. A InfinitePay não tem como implementar, e o contrato precisa dizer isso em voz alta em vez de deixar um método obrigatório estourando "não implementado" em runtime. Chamadores: cancelar cobrança, desconectar conta e trocar o gateway eleito.

Invertida a ordem, a parte cara fica pronta e o buraco contábil continua aberto.
