# ADR 0030 — Múltiplos gateways de pagamento, um ativo por tenant

- **Status:** Aceita
- **Data:** 2026-09-04
- **Autores:** Alan + agente IA
- **Substitui:** —
- **Substituída por:** —
- **Relacionada:** [[decisions/0024-ledger-financeiro-com-contrapartida|ADR 0024]], [[decisions/0016-escrita-cliente-mobile-route-handler|ADR 0016]], [[decisions/0022-modelo-controle-acesso-configuravel|ADR 0022]], [[Specs/0014-redesenho-financeiro]], [[PRDs/0005-integracao-mercado-pago]]

## Contexto

A Spec 0014 (migration `20260812233314_gateway_abstraction`) tirou o Mercado Pago do **schema**: `payment_provider_accounts`, `payment_intents` e `gateway_events` carregam `provider` como dado, as credenciais foram para o Vault com formato JSONB livre, e `fn_confirm_gateway_payment` / `fn_reverse_payment` operam sobre o *intent*, sem saber que provedor o gerou.

O comentário da migration prometia: *"somar um segundo gateway é escrever outro arquivo como este e cadastrar a conta — nenhuma migration"*. A promessa vale para o banco. Não valia para a aplicação.

Levantamento feito em 2026-09-04, com os achados reproduzidos contra o banco local:

| # | Achado | Evidência |
|---|---|---|
| G-01 | `authenticated` não tem INSERT/UPDATE em `payment_provider_accounts` — a migration 12 fez `REVOKE ALL` e regrantou só `SELECT` de 6 colunas. O callback OAuth e o `disconnectPaymentAction` escrevem com o cliente SSR (role `authenticated`) | `ERROR: permission denied for table payment_provider_accounts` ao rodar o INSERT sob `SET ROLE authenticated`. **Conectar e desconectar gateway estavam quebrados em runtime**; a suíte E2E não pegava porque monta a conta com `service_role` |
| G-02 | A escolha do provedor está invertida: a rota importa `mercadoPagoProvider` literal e `getOrCreateIntent` busca a conta com `.eq('provider', provider.name)`. O `is_default` do tenant nunca foi lido para decidir nada | `api/charges/[id]/payment-intent/route.ts:81` + `lib/payment/intents.ts:118` |
| G-03 | A interface `PaymentProvider` cobre 1 de 5 operações (só `createIntent`). Onboarding, refresh de credencial, verificação de assinatura e parse de evento estão hardcoded em MP | `lib/payment/mercadopago.ts`, `functions/mercadopago-webhook/index.ts` |
| G-04 | Conectar um segundo provedor falha: o callback grava `is_default: true` incondicionalmente e o INSERT bate no índice único, caindo no ramo genérico `?payment=error&reason=db_error` | `api/auth/mercadopago/callback/route.ts:75` |
| G-05 | `method` é aceito pela rota, propagado por `getOrCreateIntent` e **ignorado** por `createIntent` — pedir `boleto` gerava PIX. A confirmação ainda gravava `method='pix'` por default | `lib/payment/mercadopago-provider.ts:15`, `fn_confirm_gateway_payment(p_method DEFAULT 'pix')` |
| G-06 | `account_email` é gravado pelo callback e nunca lido: sem GRANT para `authenticated` e fora do `select` do repositório. A tela mostra o número da conta MP onde deveria mostrar o e-mail | `packages/data/src/repositories/ledger.ts:598` |
| G-07 | `packages/core/src/{rules,schemas}/payments.ts` são código morto sobre o modelo `billings`, que não existe mais. Pior: contêm uma **segunda** implementação da assinatura de webhook, com manifesto diferente e comparação `===` (não é tempo constante) | Só o próprio `.spec` os importa |
| G-08 | `refreshAccessToken` e `getPayment` existem sem um único chamador. Token MP expira em 180 dias; `createPixCharge` lança `MP_UNAUTHORIZED` no 401 e ninguém trata → 500 genérico | `lib/payment/mercadopago.ts:51,134` |
| G-09 | Nada impede um `is_default` **inativo** — o estado em que a cobrança para de ser gerada e ninguém sabe por quê | `idx_provider_accounts_one_default ... WHERE is_default`, sem `active` |

O requisito de produto: **o tenant configura vários gateways, mas exatamente um gera as cobranças.** O próximo provedor previsto é o **Cora**.

## Decisão

### 1. Vocabulário

Duas colunas de `payment_provider_accounts`, com significados que passam a ser respeitados:

- **`active`** — a conta está conectada e a credencial vale. É o estado "configurado".
- **`is_default`** — **o gateway que gera as cobranças.** No máximo um por tenant, e obrigatoriamente `active`.

Não renomeamos `is_default`: o nome é convencional, já está no repositório, no hook e na UI, e o contrato passa a estar escrito em `COMMENT ON COLUMN`. O que faltava não era o nome — era alguém lendo a coluna.

### 2. O provedor é resolvido pela configuração do tenant, nunca por `import`

Fluxo invertido em relação ao anterior:

```
conta is_default AND active do tenant → account.provider → registry → implementação
```

Nenhum caminho de cobrança nomeia um provedor. `getOrCreateIntent` resolve a conta **antes** de calcular valor: sem gateway eleito, falha barato e explícito.

### 3. Escrita de conta de gateway só por RPC `SECURITY DEFINER`

Corrige G-01 sem regrantar a tabela. `authenticated` continua sem `INSERT`/`UPDATE` — o que é certo, porque a linha guarda o ponteiro para a credencial no Vault. As três operações viram funções com checagem de papel e de tenant, no mesmo padrão de `set_tenant_member_role`:

| Função | O que faz |
|---|---|
| `fn_connect_provider_account` | Upsert da conta **e** gravação do segredo no Vault, na mesma transação. Antes eram duas chamadas: falha no meio deixava conta sem credencial |
| `fn_set_default_provider_account` | Elege o gateway ativo. Rebaixa o anterior e expira os intents pendentes dele |
| `fn_disconnect_provider_account` | `active = false`, `is_default = false`, expira pendentes |

Todas exigem **Owner** do tenant. Escolher quem recebe o dinheiro da empresa é invariante de dinheiro, e invariante de dinheiro mora no banco — o guard da Server Action deixa de ser a única linha de defesa.

**Conectar não elege.** A conta nasce `is_default` apenas se o tenant não tiver outro gateway ativo eleito. Conectar um segundo gateway nunca redireciona o dinheiro em silêncio; a troca é um ato explícito (G-04).

### 4. Contrato do provedor em duas camadas

O que é puro vai para `@gomoto/core`, o que faz I/O fica em `apps/web`:

- **`@gomoto/core/payments`** — o *descriptor*: `id`, `label`, `connectionMode` (`oauth` | `api_key` | `certificate`), `methods`. Sem I/O, então serve a UI web, o app mobile e a validação de entrada.
- **`apps/web/src/lib/payment`** — a interface `PaymentProvider` com I/O (`connect`, `refresh`, `createIntent`) e o registry.

`connectionMode` nasce com três valores porque nem todo gateway é OAuth (Asaas e Pagar.me usam API key). Implementamos agora **apenas o caminho OAuth**: escrever o formulário de API key sem provedor que o use seria tela sem consumidor — o mesmo defeito que produziu G-05, G-06 e G-07.

> **Correção de 2026-09-04, depois de ler a documentação da Cora.** Esta ADR registrou, por suposição, que "o Cora não é OAuth" e o catalogou como `certificate`. Errado: a Cora tem duas modalidades, e a nossa — **Parceria** — é OAuth2 authorization_code puro, sem certificado (`https://api.cora.com.br`). O mTLS pertence à "Integração Direta" (`https://matls-clients.api.cora.com.br`), em que a empresa gerencia a própria conta. O catálogo foi corrigido para `oauth`. Ver [[decisions/0031-integracao-cora-parceria|ADR 0031]].

### 5. O webhook continua sendo uma Edge Function por provedor

Não há abstração honesta sobre "webhook de gateway": cada provedor tem contrato próprio de payload, de assinatura e de vocabulário de status. O que **é** comum e estava duplicado dentro do arquivo do MP — persistir no inbox, resolver a conta, confirmar ou estornar, marcar processado — sai para `functions/_shared/inbox.ts`. O adaptador de cada provedor fica com o que só ele sabe: verificar a assinatura, extrair a referência e normalizar o status para `approved | refunded | ignored`.

Deno não alcança `packages/core` pelo workspace, então esse núcleo vive em `_shared` e não em `@gomoto/core`. É a fronteira real do runtime, não uma duplicação por descuido.

#### Adendo 2026-09-25 — o dono do pagamento sai da cobrança, nunca da conta

O MP era o único provedor que resolvia o tenant pelo `user_id` do IPN (`resolveAccount`, busca em `payment_provider_accounts`). Isso pressupunha **uma conta MP por tenant**, e o banco nunca garantiu isso: o único é `(tenant_id, provider, external_account_id)`. Em produção, a mesma conta `251267991` estava ligada à Go Motos (desconectada) e à WAT Motos. A busca achou duas linhas, o `.maybeSingle()` devolveu erro, o erro foi lido como "conta não existe" e o evento foi marcado como processado: um Pix pago sumiu sem erro e sem rastro no diagnóstico.

Regra, agora igual nos três provedores:

1. `data.id` → `payment_intents.provider_intent_id`. É o intent que diz tenant, cobrança, conta e valor. `resolveAccount` foi **removido**.
2. Sem intent → pagamento que o GoMoto não gerou (maquininha, link avulso). Loga `webhook.foreign_payment` e marca processado. Não há corrida "intent ainda não gravado": o QR só é entregue depois de `fn_open_payment_intent`.
3. A consulta ao MP usa a credencial da conta **do intent**, e o resultado é conferido por `_shared/mercadopago-check.ts` (função pura, testada com `deno test`): `user_id` do IPN, `collector_id` e `external_reference` (= `charge_id`) precisam bater com a conta e a cobrança do intent, e o valor pago com o valor do intent, em centavos. Qualquer divergência → exceção: o evento fica na fila com `processing_error`, visível ao tenant, e nada vai ao razão.

Consequência: **a mesma conta MP em vários tenants passa a ser segura**. Cada pagamento sabe de quem é pelo intent. O dinheiro de todos cai na mesma conta MP, mas isso é uma decisão de negócio, não uma inconsistência do razão.

### 6. O que o intent pede é o que o intent cobra

`method` passa a ser validado contra `descriptor.methods` antes de chegar ao provedor, tem `CHECK` no banco, e `fn_confirm_gateway_payment` **deriva** o método do intent em vez de assumir `pix`. Mata G-05 nos três pontos onde ele sobrevivia.

## Consequências

**Ganhamos**

- Conectar e desconectar gateway voltam a funcionar (G-01).
- Trocar o gateway que cobra é uma escolha do tenant na tela, com invariante no banco (G-02, G-04, G-09).
- Somar o Cora passa a ser: um descriptor em `core`, um arquivo de provider, um adaptador de webhook. Sem migration, sem tocar em `getOrCreateIntent`, sem tocar na UI.
- O segredo continua fora da tabela e fora do dump, com ponto único de leitura.

**Aceitamos**

- Um provedor novo ainda exige uma Edge Function nova. É consequência de o contrato de webhook ser de quem o emite.
- `connectionMode: 'api_key' | 'certificate'` existe no tipo e ainda não tem caminho de UI. Assumido conscientemente: o descriptor precisa do campo para a tela decidir o que renderizar, e o ramo entra junto com o primeiro provedor que o use.
- Refresh de credencial entra na interface (`refresh`), mas continua sem agendador. O 401 do gateway passa a virar mensagem específica ("reconecte a conta") em vez de "falha ao gerar cobrança" — resolver o refresh automático é trabalho separado (G-08 parcial).

**Removemos**

- `packages/core/src/rules/payments.ts`, `packages/core/src/schemas/payments.ts` e seus specs (G-07). Código morto sobre um modelo que não existe, contendo uma validação de assinatura insegura que qualquer um implementando o próximo gateway tomaria por canônica.

## Quando reavaliar

- Se um tenant precisar de **duas contas ativas do mesmo provedor** ao mesmo tempo (ex.: PIX por uma conta, cartão por outra). O modelo de dados aguenta — `UNIQUE (tenant_id, provider, external_account_id)` —, mas `is_default` único por tenant não: viraria default por *método*.
- Se o número de provedores passar de ~4, o registry por objeto literal vira carregamento dinâmico.

---

**Aberto sobre esta fundação:** [[decisions/0033-dinheiro-para-cobranca-cancelada|ADR 0033]] — cancelar cobrança não expira o intent pendente, e a confirmação não olha o status da cobrança. Vale para os três provedores.
