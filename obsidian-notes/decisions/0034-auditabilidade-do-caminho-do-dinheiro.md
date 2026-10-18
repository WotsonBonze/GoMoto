# ADR 0034 — Auditabilidade e superfície de escrita do caminho do dinheiro

*(por que este dinheiro entrou, quem mandou, e quem consegue mexer)*

- **Status:** 🟢 **Aceita e CONCLUÍDA** — Fases 1, 2, 2b, 2c, 3, 3b, 4 e 5 implementadas.
- **Fecha a Questão 2 da [[decisions/0033-dinheiro-para-cobranca-cancelada|ADR 0033]]:** a fila de replay ganhou consumidor.
- **🔴 Contém DOIS achados CRÍTICOS com correção que precisa chegar em produção:** *Problema 3* (razão aberto para `anon`) e *Problema 4* (**escalação de privilégio para administrador da plataforma, ao alcance de qualquer usuário logado**). Os dois foram encontrados **verificando o banco**, não lendo as migrations — o segundo só apareceu porque a verificação da correção do primeiro não bateu.
- **Escopo:** o caminho inteiro do dinheiro de gateway — das três Edge Functions até o razão —, olhado por duas perguntas que nenhum ADR anterior fez: **"dá para reconstruir o que aconteceu?"** e **"quem consegue escrever aqui?"**
- **Data:** 2026-09-06
- **Autores:** Alan + agente IA
- **Substitui:** —
- **Substituída por:** —
- **Relacionada:** [[decisions/0024-ledger-financeiro-com-contrapartida|ADR 0024]], [[decisions/0030-multiplos-gateways-de-pagamento|ADR 0030]], [[decisions/0031-integracao-cora-parceria|ADR 0031]], [[decisions/0032-integracao-infinitepay-checkout|ADR 0032]], [[decisions/0033-dinheiro-para-cobranca-cancelada|ADR 0033]]

---

## Contexto

As ADRs 0030 a 0033 construíram a fundação multi-gateway e fecharam três ciclos em produção. Cada uma respondeu "o dinheiro entra certo?". Nenhuma respondeu as duas perguntas que só aparecem quando algo dá errado:

1. **Auditoria** — apareceu um valor na conta da locadora. Por quê, e quem mandou?
2. **Segurança** — quem, dentro da empresa, consegue escrever nessas tabelas?

A revisão de 2026-09-06 encontrou uma base sólida e duas lacunas de natureza diferente. Vale separar, porque a primeira é ausência de dado e a segunda é permissão concedida a mais.

### O que já estava de pé

Nada disto muda nesta ADR. Está aqui para delimitar o que **não** é o problema:

| Garantia | Onde |
|---|---|
| Razão imutável e balanceado, imposto pelo banco | `trg_entries_balanced`, `trg_ftx_immutable` |
| Idempotência como propriedade do banco | `UNIQUE (provider, provider_event_id)` |
| O corpo do webhook nunca vira dinheiro — a API do provedor decide | os três adapters |
| Tenant resolvido pelo **nosso** registro, nunca pela requisição | `payment_intents.provider_intent_id` |
| Confirmação atômica | `fn_confirm_gateway_payment` |
| Alocação imutável; pagamento imutável em valor, método, data e cliente | `trg_payment_allocations_immutable`, `fn_protect_payment` |
| Eleger o gateway que recebe é ato de **owner** | `fn_assert_gateway_owner` |
| `signature_valid` nunca afirma verificação que não houve | `_shared/signature.ts` |

O desenho estava certo. Faltava conseguir **contar a história depois** — e alguns `GRANT` contradiziam o resto.

---

## Problema 1 — a trilha quebra no salto que mais importa

A pergunta de auditoria não é "o razão fecha?". O razão sempre fecha: a partida dobrada é imposta por trigger. A pergunta é:

> **Apareceu R$ 1.240,00 na conta desta locadora em 12/09. Por quê, e quem mandou?**

O caminho existente ia até certo ponto:

```
financial_entries → financial_transactions (source_id) → payments
                                                            ↓ payment_intent_id
                                                       payment_intents
                                                            ↓ provider_intent_id
                                           ??? gateway_events  ← o salto que não existia
```

O último salto **não era dado**. Era uma busca montada na hora, diferente para cada gateway:

| Provedor | Como se achava o evento |
|---|---|
| Cora | `payload->>'webhook_resource_id'` |
| InfinitePay | `payload->>'order_nsu'` |
| Mercado Pago | `payload->'data'->>'id'` |

Isso não é rastreabilidade — é arqueologia, e depende de alguém que conheça os três formatos estar disponível na hora do incidente.

E no fim da corrente, três marcas de origem ficavam vazias:

- `financial_transactions.created_by` → **NULL** em toda confirmação de gateway
- `payments.received_by` → **NULL** (a coluna existe, e o caminho **manual** a preenche)
- `audit_logs` → **nenhuma linha**

**O único recebimento que ninguém digitou era também o único sem qualquer marca de origem.**

### 1.1 `audit_logs` nunca via dinheiro

`apps/web/src/lib/audit.ts` declarava `payment_confirmed` e `token_refreshed` no vocabulário de ações. **Nenhum dos dois tinha um único escritor.** É a forma exata do padrão já registrado em [[feedback_validated_then_discarded|"validado e descartado"]]: um vocabulário que ninguém escreve.

A causa é estrutural e não é descuido: a confirmação roda em **Deno**, com `service_role`, e `logAction` vive em `apps/web`. É o mesmo motivo de `_shared/inbox.ts` existir.

**Consequência:** a trilha do tenant registrava "conectou gateway" e "gerou Pix", e nunca "recebeu dinheiro" nem "estornou".

### 1.2 A fila de replay era invisível justamente para quem agiria

`gateway_events.tenant_id` só era preenchido no `markProcessed`. A RLS da tabela é `tenant_id IN (SELECT get_user_tenants())`.

**Evento que falhou tinha `tenant_id` NULL e era invisível para todos, exceto `service_role`.** As linhas que representam "dinheiro sem dono a investigar" — exatamente as que a ADR 0033 tornou possíveis ao trocar o silêncio por exceção — eram as únicas que ninguém conseguia ver.

### 1.3 `processing_error` carregava dois significados

O prefixo `CONFIRMADO_SEM_VERIFICACAO:` (ADR 0033) dividia a coluna com falhas reais, distinguido só por `processed_at` estar preenchido e por um texto livre. "Aceito com ressalva" é **estado do negócio**, não mensagem de erro: achar todos dependia de um `LIKE`.

### 1.4 A reconciliação existia só como teste

`apps/web/tests/reconciliacao.spec.ts` faz a pergunta certa — *"existe documento que não virou lançamento?"* — e varre o banco inteiro. Mas roda em CI, contra o banco de teste. **Produção não tem equivalente.**

---

## Problema 2 — permissões concedidas além do necessário

Todos os quatro achados exigem um **membro autenticado do tenant**. Não são acessíveis anonimamente.

Isso não os torna teóricos. O "insider" aqui é o operador ou o *viewer* da locadora — precisamente quem um controle financeiro existe para limitar. E o alcance é o navegador: o PostgREST expõe tudo isto com a anon key mais o JWT do usuário, sem passar por nenhuma linha do nosso código.

> **O princípio que faltava:** quem decide o que é alcançável é o `GRANT`, não o chamador. Uma Server Action rodar no servidor não protege nada se a RPC que ela chama também atende o navegador com o mesmo papel.

### 2.1 🔴 A credencial do gateway saía para qualquer membro, inclusive `viewer`

`fn_provider_credentials` tinha `GRANT EXECUTE ... TO authenticated` e conferia apenas **pertencimento ao tenant**. O `account_id` é legível pelos grants de coluna da tabela. Um `POST /rest/v1/rpc/fn_provider_credentials` devolvia `access_token` e `refresh_token` da Cora ou do Mercado Pago em texto puro.

O contraste dizia tudo: **conectar e eleger** gateway exigiam `owner`, via `fn_assert_gateway_owner`. **Ler o token** exigia só estar na empresa.

O comentário em `cobrancas/[id]/actions.ts` justificava a escolha: *"tudo que `getOrCreateIntent` toca é alcançável por `authenticated` sob RLS... contornar a RLS aqui seria trocar uma garantia do banco por uma comparação escrita à mão."*

O raciocínio está certo **para linhas** — e errado para um segredo do Vault. A RLS decide *quais linhas* um papel enxerga; ela não tem gradação de papel dentro do tenant. Um segredo que movimenta dinheiro não é uma linha do tenant: é uma capacidade.

### 2.2 🔴 `reversed_at` desfazia um recebimento sem tocar no razão

`GRANT ALL ON TABLE payments TO authenticated`. `fn_protect_payment` blindava valor, método, data e cliente — **e não `reversed_at`**.

```sql
UPDATE payments SET reversed_at = now(), reversal_reason = 'x' WHERE id = '...';
```

`charge_balances` filtra as alocações por `p.reversed_at IS NULL`. A cobrança **reabre**, o cliente volta a dever, e o razão continua mostrando o dinheiro em `caixa_e_bancos`. Razão e recebíveis passam a discordar permanentemente, sem transação de estorno, sem `reversed_by` e sem `audit_logs`.

Era o caminho mais curto entre um membro qualquer e uma divergência contábil que ninguém detecta.

### 2.3 🟠 O razão aceitava `INSERT` direto

`GRANT SELECT, INSERT ON financial_transactions, financial_entries TO authenticated` — enquanto `post_financial_transaction` é `SECURITY DEFINER`.

**O grant era desnecessário desde sempre.** Com ele, um membro postava lançamentos balanceados forjados, escolhendo `created_by`, `event_type` e `source_module`. O trigger só exige que a transação some zero; a exigência de duas pernas mora na RPC, que o `INSERT` direto contorna.

### 2.4 🟠 `payment_intents` era escrita direta do navegador

`GRANT ALL` mais policy `FOR ALL`. Qualquer membro podia `UPDATE` ou `DELETE` intents do próprio tenant. Apagar um intent zera `payments.payment_intent_id` (`ON DELETE SET NULL`) e **corta a ligação entre o recebimento e a tentativa que o originou** — exatamente o histórico que o `ON DELETE RESTRICT` em `provider_account_id` foi criado para preservar.

### 2.5 Adjacente: nenhum teste olha para dentro do tenant

A suíte de isolamento (`tenant-isolation-financeiro.spec.ts`) é inteira **tenant 1 vs. tenant 2**, e é boa nisso. Nenhum teste pergunta o que um `viewer` consegue fazer **dentro da própria empresa** — e é aí que estavam os quatro achados acima.

---

## Problema 3 — o razão estava aberto para `anon` 🔴

**Este achado não estava na análise.** Ele apareceu ao *verificar* a Fase 2 contra o banco em vez de confiar na leitura das migrations — e é mais grave do que tudo que a análise havia encontrado, porque não exige nem estar logado.

Reproduzido ao vivo, com a chave anônima e nada mais:

```
POST /rest/v1/rpc/post_financial_transaction
apikey: <anon key — a que viaja no bundle do navegador de toda página publicada>
{ "p_tenant_id": "<qualquer empresa>",
  "p_transaction": {...},
  "p_entries": [ débito 999999, crédito 999999 ] }

→ HTTP 200
→ lançamento de R$ 999.999,00 criado no razão daquela empresa
```

Sem login. Sem pertencer à empresa. Em tenant escolhido a dedo.

### A causa

`20260627230859_grant_authenticated_role.sql` resolveu um problema real — o role `postgres` local não concedia `SELECT/INSERT/UPDATE/DELETE` e o projeto quebrava depois de `db:reset` — com um instrumento largo demais:

```sql
GRANT ALL ON ALL TABLES   IN SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL ROUTINES IN SCHEMA public TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES ... GRANT ALL ON TABLES   TO anon, ...;
ALTER DEFAULT PRIVILEGES ... GRANT ALL ON ROUTINES TO anon, ...;
```

O `ALTER DEFAULT PRIVILEGES` é o que torna isto insidioso: **toda tabela e toda função criada depois nasce concedida a `anon`.** Cada `GRANT` cuidadoso escrito nas migrations seguintes estava concedendo o que já estava concedido, e cada `REVOKE ... FROM PUBLIC` não tocava em `anon` — `anon` é um role nomeado e não faz parte de `PUBLIC`.

Medido no banco antes da correção: **67 das 71 rotinas de `public` executáveis por `anon`, 37 delas `SECURITY DEFINER`** — ou seja, ignorando RLS.

### Por que só uma era explorável

Quase todas as funções de dinheiro conferem o tenant por dentro com `get_user_tenants()`, e para `anon` esse conjunto é **vazio** — então levantam exceção mesmo estando concedidas. A RLS cobriu as tabelas pelo mesmo motivo: as políticas são `TO authenticated`.

`post_financial_transaction` era a exceção: `SECURITY DEFINER`, recebe `p_tenant_id` **como parâmetro** e nunca perguntou quem estava chamando. A checagem de tenant morava em cada chamador; a função que efetivamente escreve no razão não tinha nenhuma.

> A lição não é "faltou uma checagem". É que **a defesa inteira dependia de um acidente feliz** — o fato de as outras funções precisarem consultar `get_user_tenants()` por outro motivo. Onde esse acidente não valeu, não havia nada.

### Fase 2b — correção ✅ implementada

Duas camadas, porque uma só já falhou aqui:

1. **`post_financial_transaction` exige papel e tenant.** Lista de **permitidos**, não de proibidos: `service_role` (webhook), `none` (conexão direta — `pg_cron` da emissão diária e migrations; verificado que o GUC `role` vale `'none'` nesse contexto) e `authenticated` **apenas no razão da própria empresa**. Quem não está nomeado não escreve. Um `IF role = 'anon' THEN recusa` fecharia o buraco de hoje e deixaria aberto o de amanhã.
2. **O grant sai de `anon`** nas 21 funções do domínio de dinheiro, e o `ALTER DEFAULT PRIVILEGES` deixa de conceder a `anon` daqui para a frente — este é o conserto da causa.

### Ressalva registrada — ✅ resolvida pela Fase 2c

A Fase 2b fechou o **domínio de dinheiro** e o default futuro, e deixou registrado que `anon` continuava com `EXECUTE` em funções de outros domínios (`add_to_queue`, `create_rental_with_schedule`, `check_user_email_conflict`, `list_platform_admins`, as de fila). O passo ficou em aberto porque varrer exigia saber o que os fluxos anteriores ao login legitimamente chamam.

**Esse levantamento foi feito e a varredura aconteceu na Fase 2c** (ver Problema 4): nenhuma RPC de `public` é chamada antes do login, e `anon` saiu do schema inteiro. `add_to_queue`, que gravava com HTTP 200 para o anônimo, foi um dos casos reais fechados ali.

---

## Problema 4 — a guarda que NULL desliga 🔴

Encontrado ao conferir se a Fase 2b tinha de fato fechado o que dizia ter fechado. **Não tinha** — e o caminho que faltava levou a algo pior.

### 4.1 Existiam DOIS caminhos até o `anon`, e a Fase 2b fechou um

A Fase 2b revogou `anon` de 21 funções de dinheiro e reportou isso. Ao reconferir, várias continuavam alcançáveis:

| Caminho | Origem | Fechado na 2b? |
|---|---|---|
| `GRANT ... TO anon` direto | `ALTER DEFAULT PRIVILEGES` de 2026-06-27 | ✅ |
| `EXECUTE` para **`PUBLIC`** | default do próprio PostgreSQL no `CREATE FUNCTION` | ❌ |

`anon` é membro de `PUBLIC`. No ACL isso aparece como `=X/postgres` — grantee vazio. `fn_pay_payable` tinha; `fn_provider_credentials`, que fez `REVOKE ALL ... FROM PUBLIC` na própria migration, não tinha — e por isso estava de fato fechada.

> É a mesma lição pela terceira vez: **`REVOKE ... FROM PUBLIC` e `REVOKE ... FROM anon` são coisas diferentes**, e precisar dos dois não é redundância.

### 4.2 Escalação de privilégio para administrador da plataforma

As três funções de administração da plataforma (de 2026-06-15) guardavam assim:

```sql
IF get_platform_role() <> 'owner' THEN
    RAISE EXCEPTION 'apenas owners podem ...' USING ERRCODE='42501';
END IF;
```

`get_platform_role()` é `SELECT role FROM platform_admins WHERE user_id = auth.uid()`. Para quem **não** é admin da plataforma — todo usuário normal, e o anônimo — devolve **NULL**.

E `NULL <> 'owner'` não é `TRUE`: é **NULL**. `IF NULL THEN` não executa.

**A guarda inteira era pulada exatamente para quem ela existe para barrar.**

Reproduzido ao vivo com um `operator` comum de tenant (`get_platform_role()` = NULL, `is_platform_admin()` = false):

```sql
SELECT add_platform_admin_by_email('outra-conta-minha@...', 'owner');
→ sucesso. A conta virou platform_admin OWNER.
```

Platform admin owner enxerga **todos os tenants**. Qualquer funcionário de qualquer locadora criava uma segunda conta e se promovia a administrador da plataforma inteira. Não exige nada exótico — basta ter login.

### O que segurou os outros caminhos foi acidente

- `remove_platform_admin` parou em *"a plataforma precisa de pelo menos um owner"* — regra de negócio, que só vale enquanto houver **um único** owner. Com dois, qualquer usuário remove qualquer um.
- Para o `anon`, `add_platform_admin_by_email` abortou no `platform_audit_logs.actor_id NOT NULL`, porque `auth.uid()` é NULL. **A trilha de auditoria defendeu por efeito colateral** — o `INSERT` em `platform_admins` já tinha sido aceito.

Duas defesas acidentais em dois achados diferentes. É o padrão que esta ADR existe para eliminar.

### Fase 2c — correção ✅ implementada

1. **`IS DISTINCT FROM`** nas três funções — o operador NULL-safe que o resto do schema já usa (`fn_provider_credentials`, `fn_assert_gateway_owner`). Somado no caminho: `SET search_path` nas três, que não tinham.
2. **`REVOKE EXECUTE ON ALL ROUTINES IN SCHEMA public FROM PUBLIC, anon`** — fecha o segundo caminho, para todos os domínios de uma vez, e não só para dinheiro.
3. **`ALTER DEFAULT PRIVILEGES ... REVOKE EXECUTE ON ROUTINES FROM PUBLIC`** — sem isto a próxima função nasce com `EXECUTE` para `PUBLIC` e o buraco se reabre sozinho, que é como este chegou até aqui.
4. **A migration se autoverifica**: falha se sobrar qualquer rotina alcançável por `anon`, ou se `authenticated` perder acesso a uma função crítica. Uma migration de permissão que não confere o resultado é uma intenção, não uma garantia — e a 2b provou isso ao revogar 21 e fechar menos que 21.

Verificado antes de revogar: **nenhuma** rotina depende do grant de `PUBLIC` para `authenticated` ou `service_role` (os dois têm grant explícito em todas), e **nenhuma** RPC de `public` é chamada antes do login. Verificado depois: `anon` recebe 42501 em tudo, usuário comum é barrado nas três funções de plataforma, e o **owner legítimo continua administrando** — guarda que barra todo mundo não serve.

---

## Decisão

### Princípios

1. **O elo causal é dado, não inferência.** Todo dinheiro que entra por gateway aponta para o evento que o causou, por coluna com FK — não por busca em JSONB.
2. **Nenhum registro afirma o que não aconteceu.** Se ninguém verificou, o registro diz isso em coluna própria (extensão do princípio de `signature_valid`, ADR 0030).
3. **Papel de sistema não se disfarça de pessoa.** A confirmação de gateway não inventa um `auth.users`; ela se identifica como `gateway:<provedor>` em campo próprio.
4. **O `GRANT` é a fronteira.** Capacidade que movimenta dinheiro não é concedida a `authenticated` porque a aplicação "só chama pelo caminho certo".
5. **A invariante que só existe em teste não protege produção.** Varredura de reconciliação vira view consultável.
6. **Grant se verifica no banco, nunca por leitura de migration.** As migrations diziam `GRANT SELECT ON gateway_events TO authenticated`; o banco tinha `INSERT, UPDATE, DELETE` também, vindos de um default de três meses antes. Toda afirmação sobre permissão neste ADR foi conferida com `has_function_privilege` e `information_schema`, e as recusas foram reproduzidas por HTTP.

### Fase 1 — o elo que faltava ✅ implementada

1. `payments.gateway_event_id` e `financial_transactions.source_event_id`, com FK para `gateway_events`. `fn_confirm_gateway_payment` recebe `p_gateway_event_id`; `applyPayment` passa o `eventId` que já tem em mãos.
2. `payments.received_by_system TEXT` — `'gateway:cora'`, `'gateway:mercadopago'`, `'gateway:infinitepay'`. Coluna própria em vez de um `auth.users` fictício, pelo Princípio 3.
3. `tenant_id` resolvido no `markFailed`, não só no `markProcessed`: sem isso a fila de replay continua invisível para quem agiria.
4. `gateway_events.accepted_without_verification BOOLEAN`, separado de `processing_error`.

### Fase 2 — fechar as portas ✅ implementada

| Achado | Correção | Custo |
|---|---|---|
| 2.3 Razão aceita `INSERT` | `REVOKE INSERT` | nenhum — a RPC é `SECURITY DEFINER` |
| 2.2 `reversed_at` livre | trava em `fn_protect_payment` | nenhum — `fn_reverse_payment` é `SECURITY DEFINER` |
| 2.1 Credencial para qualquer membro | `REVOKE EXECUTE FROM authenticated`; leitura passa pelo cliente admin | ajuste em `getOrCreateIntent` |
| 2.4 `payment_intents` escrevível | `REVOKE INSERT, UPDATE, DELETE`; escrita por RPC | ajuste em `getOrCreateIntent` |

### Fase 3 — tornar visível ✅ implementada (exceto o dreno)

5. **View `gateway_event_audit`** ✅ — evento → pagamento → cobrança → transação, com `signature_valid`, `accepted_without_verification` e o tempo de processamento. A classificação em cinco situações mora na view, não na tela: `confirmed`, `accepted_unverified`, `processed_no_money`, `pending`, `failed`.

   A ordem da classificação é decisão, não detalhe: **`accepted_unverified` ganha de `confirmed`**. Um recebimento aceito sem verificação é processado *e* precisa de olho humano; se `confirmed` viesse antes, a ressalva que a ADR 0033 decidiu registrar sumiria justamente da tela feita para mostrá-la.

6. **View `financial_reconciliation`** ✅ — uma linha por problema, vazio é saudável. As quatro verificações do `reconciliacao.spec.ts` mais duas novas: `payment_without_allocation` e `paid_intent_without_payment`, que são as formas de a corrente do gateway quebrar sem violar invariante nenhuma do banco.

   Provada por injeção: cada anomalia foi criada de propósito e a view a acusou. "Zero problemas" numa view que não detecta nada seria o pior resultado possível — é a mesma armadilha de vacuidade que o spec original já nomeava.

7. **Tela Configurações → Integrações → Diagnóstico** ✅ *parcial* — Owner/Admin, sub-rota no padrão de `configuracoes/usuarios`. Resumo, tabela de eventos com filtro "precisam de atenção", erros crus fora da tabela (espremê-los numa célula truncaria justamente o que explica a falha), e a reconciliação.

   O botão de reprocessar saiu na **Fase 3b**, logo abaixo.

### Fase 3b — o dreno da fila ✅ implementada

`idx_gateway_events_unprocessed` sempre foi chamado de "fila de replay" e **nunca teve consumidor**. Como respondemos `200` antes de processar, o provedor considera a entrega concluída e nunca reenvia: um evento que falha depois disso fica parado para sempre. Esta fase é o consumidor.

**A decisão que define o desenho: o dreno não reimplementa nada.** Reprocessar é reconsultar o provedor e aplicar ao razão — exatamente o que o webhook faz. Uma segunda implementação divergiria da primeira no primeiro ajuste, e a divergência apareceria como dinheiro confirmado de dois jeitos diferentes.

Então os processadores saíram dos arquivos de webhook para `_shared/cora.ts`, `_shared/mercadopago.ts` e `_shared/infinitepay.ts`, e **os dois caminhos chamam a mesma função**. O que tornou isso possível sem duplicar nada: cada processador lê exclusivamente do **payload gravado** (`StoredEvent`). Na entrega original o payload acabou de ser montado; no replay ele vem do banco. Mesmos campos, mesma função — o replay não pode drifar do webhook porque não é outro código.

É na InfinitePay que a propriedade mais se paga: `payment_check` exige quatro campos, e dois deles (`transaction_nsu`, `invoice_slug`) só existem no corpo que ela mandou. Guardar o corpo inteiro no inbox — decisão da Spec 0014, tomada por auditoria — é o que torna o reprocessamento possível anos depois.

Os arquivos de webhook ficaram só com HTTP: segredo, assinatura, gravar no inbox, responder.

**`gateway-replay`** (`verify_jwt = true`, ao contrário dos webhooks — aqui não há provedor externo a acomodar) recebe um `event_id`, recusa o que já foi processado (`409`), despacha por provedor e devolve o erro novo quando falha, deixando o evento na fila. Quem chama é a Server Action do cockpit, com `service_role`, **depois** de conferir papel (Owner/Admin) e de ler o evento com o cliente do usuário sob RLS — se não é do tenant dele, a consulta não devolve nada e não há o que comparar à mão.

**Defeito encontrado ao testar:** `markFailed` gravava `attempts: 1` **fixo**. Com uma entrega só ninguém notava — a primeira falha é mesmo a primeira. Com o dreno virou defeito visível: reprocessar dez vezes deixava o contador em 1, e um evento que falha sempre seria retentado indefinidamente sem deixar sinal. Agora conta.

**Verificação.** A suíte E2E **não executa** as funções Deno, então o refactor foi validado à mão com `supabase functions serve` e um mock da API da Cora servido como função na mesma rede: evento de ciclo de vida (processa e limpa o erro), evento órfão (falha e volta para a fila), contador subindo 1→2→3, `already_processed` e `event_not_found`, e o ciclo com dinheiro — evento parado → `confirmed`, R$ 250,00, `pix`, `gateway:cora`, `paid_at` vindo do `finalized_at` do provedor, cobrança fechada e razão somando zero.

**O clique não tem teste automatizado**, e isso está dito no spec: ele depende de `supabase functions serve` estar de pé, e um teste assim viraria intermitente. O spec cobre que o botão aparece só em `failed`/`pending` — nunca em "aceito sem conferir", que já virou dinheiro e se resolve olhando o extrato, não reprocessando.

### Fase 4 — vigilância ativa ✅ implementada

8. **Drenagem automática** — `GET /api/cron/drain-gateway-events`, cron da Vercel **diário** (`0 10 * * *` = 07:00 em Brasília).

   A cadência não é escolha de desenho: **o plano Hobby da Vercel só aceita cron diário.** A hora foi escolhida para o operador encontrar o quadro já drenado ao começar o dia.

   Isso muda o papel de cada peça. Com drenagem diária, o **botão "Reprocessar" da tela deixa de ser conveniência e passa a ser o caminho normal** para qualquer coisa urgente; o cron é a rede que pega o que ninguém viu. E `MAX_TENTATIVAS = 5` passa a significar cinco *dias* até desistir.

   Se um dia isso apertar, há duas saídas sem trocar de plano: `pg_cron` + `pg_net` chamando a rota (custa guardar o `CRON_SECRET` no Vault do banco — capacidade estreita, não a chave mestra), ou um agendador externo batendo na mesma URL. Nenhuma das duas foi feita, porque a diária mais o botão cobrem o caso real.

   **Por que na aplicação e não no `pg_cron`.** A emissão de cobranças roda no banco porque ela *é* SQL — `fn_run_billing_emission` não sai do Postgres. Drenar a fila é o contrário: uma chamada HTTP a uma Edge Function que por sua vez chama a API do provedor. Fazer isso do banco exigiria `pg_net` (está instalado) e, com ele, **guardar uma credencial de chamada dentro do banco**. Na aplicação não entra segredo novo: usa o `CRON_SECRET` que a emissão manual já usa, e a chave de serviço já vive no ambiente.

   A rota não decide nada sobre dinheiro. Ela escolhe **quais** eventos tentar e chama a mesma função que o botão da tela chama — que chama o mesmo processador do webhook.

   Três critérios de seleção, cada um por um motivo:
   - `attempts < 5` — falha que persiste cinco vezes não é instabilidade; é caso que precisa de decisão humana. Continuar tentando gasta chamada na API do provedor e esconde o problema numa contagem que ninguém lê.
   - `received_at < now() - 2 min` — o webhook responde antes de processar e segue trabalhando em `waitUntil`. Um evento recém-chegado pode estar sendo processado **agora**; drená-lo em paralelo faria duas verificações concorrentes do mesmo pagamento. A confirmação é idempotente, então não duplicaria dinheiro — mas gastaria duas chamadas e criaria uma corrida que não precisa existir.
   - lote de 50 — dimensionado para a cadência diária: precisa caber um dia inteiro de falhas, senão o excedente espera mais 24 horas.

   `unreachable` **interrompe o lote**: se a função está fora, insistir com o resto só produz o mesmo erro dezenas de vezes e some com o sinal no meio do log.

   **Env:** `CRON_SECRET` foi criado em produção como *Sensitive* (não existia — o que também significa que o disparo manual da emissão de cobranças estava morto lá, respondendo 500). A Vercel injeta esse valor no header `Authorization` das invocações de cron automaticamente, então a rota se autentica sozinha.

9. **Alerta** — no log estruturado, que é o canal que existe hoje. Três perguntas que ninguém mais faz sozinho: eventos que esgotaram as tentativas (`drain.needs_human`), confirmados sem verificação nas últimas 24h (`drain.accepted_unverified`, ADR 0033) e divergências na reconciliação (`drain.reconciliation`).

   **Não foi criado canal de notificação.** Seria infraestrutura nova, e escolher destinatário no lugar do humano seria decidir por ele. O que existe é: o log estruturado para quem observa a plataforma, e a tela de diagnóstico para quem opera a locadora.

#### Defeito encontrado ao testar: `fetch` cacheado

A rota relatava `ainda_falhando: 2` **sem ter chamado a função uma única vez**. O contador de tentativas não subia e nenhum `replay.start` aparecia no log da Edge Function, enquanto a resposta HTTP dizia que o trabalho tinha acontecido.

Causa: o Next serve a resposta anterior do cache de dados. Faltava `cache: 'no-store'`.

O efeito era pior do que "não drena": **a drenagem se declarava saudável enquanto não fazia nada**, e o botão da tela tinha o mesmo defeito — um segundo clique no mesmo evento não faria nada, em silêncio. É a forma exata do problema que esta ADR existe para eliminar, aparecendo dentro da própria correção.

Reprocessar é efeito colateral, nunca leitura: a mesma chamada com a mesma entrada tem que ir de novo.

**Verificação.** Com as funções servidas localmente e um mock da API da Cora: evento com dinheiro drenado (cobrança fechada, razão somando zero), órfão continuando a falhar com o contador subindo 1→2→3→4→5, evento esgotado deixando de ser selecionado, evento recém-chegado excluído pela idade e incluído na passada seguinte, e `precisam_de_humano` subindo conforme os casos esgotavam. O 401 sem `CRON_SECRET` tem teste automatizado; o caminho feliz não, porque dependeria de `supabase functions serve` estar de pé.

### Fase 5 — trilha confiável ✅ implementada

**A trilha do dinheiro passa a ser escrita pelo BANCO**, não pela aplicação. `payment_confirmed` e `token_refreshed` estavam no vocabulário de `lib/audit.ts` desde sempre e nunca tiveram um único escritor — e a causa não era descuido: a confirmação roda em Deno com `service_role`, e `logAction` vive em `apps/web`. **Nenhuma disciplina de código alcança um caminho que não passa pela aplicação.**

10. **`audit_logs` aceita quem não é gente.** `user_id` deixa de ser `NOT NULL` e entra `actor_system` (`gateway:<provedor>` ou `system:<origem>`), com CHECK de **exatamente um autor**. A saída não foi um `auth.users` de sistema: usuário fictício apareceria em listas de membros e em todo relatório por pessoa — mesmo princípio de `payments.received_by_system` na Fase 1.

11. **Trigger em `payments`** grava `payment_confirmed` no INSERT e `payment_reversed` na transição de `reversed_at`, na **mesma transação**. Isso alcança os três caminhos — webhook, recebimento manual e abatimento por crédito — sem que nenhum precise lembrar de chamar nada. E torna a trilha impossível de perder: se o registro falhar, o pagamento não acontece.

    A identidade é derivada na ordem em que a resposta é mais específica: `received_by` (a pessoa que registrou), `auth.uid()` (quem estava logado), `received_by_system` (o gateway). Quando há marca de gateway, ela ganha — foi ele que recebeu, mesmo que alguém estivesse logado quando o webhook chegou.

    O elo causal da Fase 1 viaja no `new_data`: dá para ir da trilha ao webhook sem sair dela.

12. **`token_refreshed`** passa a ser gravado em `fn_store_provider_credentials`, o ponto único por onde toda credencial nova passa. A renovação é silenciosa por desenho, e é por isso que precisa de rastro: quando uma conexão morre, a pergunta é *"quando foi a última renovação bem-sucedida?"*, e ela não tinha resposta. **A credencial nunca entra na trilha** — registra-se que houve renovação, quando, e de qual conta.

13. **A trilha vira imutável de verdade.** As policies eram SELECT/INSERT apenas (RNF-005), mas RLS é contornada por `SECURITY DEFINER` — e a trilha do dinheiro passou a ser escrita exatamente assim. Agora um trigger recusa UPDATE e DELETE **inclusive para `service_role`**, como já acontece no razão. O teste que antes *limpava* a linha de fixture passou a **exigir que a limpeza falhe**.

14. **`logAction` para de engolir a própria falha.** Havia um defeito não notado: **o erro do INSERT nunca era conferido** — uma gravação recusada pela RLS ou por constraint passava sem deixar nada, nem no log. Agora distingue três desfechos (`no_session`, `no_tenant`, `write_failed`) e devolve resultado, para que o chamador *possa* saber. A maioria segue ignorando com razão: perder o registro de "editou um veículo" não justifica desfazer a edição. Para dinheiro a pergunta não se coloca — aquela trilha é do banco.

15. Teste E2E de **privilégio intra-tenant** — ✅ entregue em `apps/web/tests/privilegio.spec.ts`. Falta a leva por PAPEL (o que um `viewer` consegue que um `owner` deveria poder), que exige fixtures de usuário com papéis distintos; fica registrada como pendência, não como parte desta ADR.

---

## Auditoria do primeiro ciclo completo em produção (2026-09-07)

Cobrança #6, R$ 100,00, Cora em homologação. Pagamento de teste disparado por `POST /v2/invoices/pay`.

| O que a ADR construiu | O que a produção mostrou |
|---|---|
| Denylist de ciclo de vida (Fase 3b) | `INVOICE.DRAFTED` e `INVOICE.CREATED` cortados em **47ms e 42ms**, sem tocar o banco nem a API da Cora |
| Confirmação verificada | `invoice.PAID` → `confirmed` em **1,104s** |
| Elo causal (Fase 1) | `payments.gateway_event_id` e `financial_transactions.source_event_id` apontando para o evento — a corrente fecha por FK |
| Origem sem disfarce (Fase 1) | `received_by_system = gateway:cora`, `received_by` nulo |
| Trilha do tenant (Fase 5) | `payment_confirmed` com `actor_system = gateway:cora`, carregando o elo — **a linha que não existia antes de hoje** |
| Reconciliação (Fase 3) | 0 divergências |
| Fila de replay (Fase 3b/4) | 0 eventos não processados |
| Razão | débito `caixa_e_bancos` / crédito `contas_a_receber`, soma **0,00**; cobrança `paid`, saldo 0,00 |

### Segundo ciclo (#7, R$ 50,00) e o que ele revelou

`DRAFTED` 54ms, `CREATED` 41ms, `PAID` confirmado em **1,482s**. Razão fechando em zero, reconciliação 0, fila 0.

A tela mostrou 6 eventos como "Processado, sem elo". Fui verificar **cada um**, que é o ponto de ter a tela. Quatro eram legado benigno. **Dois eram do Mercado Pago, `live_mode: true`, sem tentativa correspondente** — a forma exata do defeito que a ADR 0033 descreve. Perguntei ao provedor:

```
177501360328 → cancelled / expired, R$ 5,00,  date_approved: null
177505599156 → cancelled / expired, R$ 10,00, date_approved: null
```

Pix gerados e nunca pagos. **Nenhum dinheiro perdido** — o webhook classificou como `ignored` e não criou pagamento, comportamento correto.

Mas eles ficariam ali para sempre. E **todo Pix que expira gera um evento desses**: em operação real, com cobranças vencendo todo dia, a tela acumularia ruído permanente até ninguém mais lê-la. Dois eventos hoje é anedota; a taxa de crescimento é que era o problema.

A causa: `applyPayment` **conhecia** o desfecho (`approved | refunded | ignored`), usava para decidir, e jogava fora. A forma "validado e descartado" outra vez, dentro da própria ADR que existe para eliminá-la.

`gateway_events.outcome` passa a guardar o que o provedor respondeu, gravado **antes** de qualquer decisão — inclusive antes do `return` do caso `ignored`, que é justamente o que precisava ficar registrado. A view ganhou dois rótulos: `processed_ignored` ("Não pago") e `refunded` ("Estornado") — este último porque o evento de estorno não tem pagamento ligado a si (o pagamento aponta para o evento que o CONFIRMOU), e sem a linha ele cairia em "sem elo" e o estorno sumiria da tela.

Verificado com as funções servidas localmente e o mock devolvendo `PAID` ou `OPEN` conforme o id: `approved` → `confirmed` com R$ 50,00; `ignored` → `processed_ignored` sem pagamento.

Detalhe de Postgres que custou uma tentativa: `CREATE OR REPLACE VIEW` só aceita **apendar** colunas. `outcome` no meio da lista renomeia as seguintes e o banco recusa com *"cannot change name of view column"*.

### E um defeito que a própria auditoria encontrou

A tela classificava como **"Sem efeito"** todo evento processado sem pagamento ligado. Para ciclo de vida isso é verdade. Para os pagamentos ANTERIORES à Fase 1 é mentira: eles não têm `gateway_event_id` porque a coluna não existia, e a tela passou a afirmar "sem efeito" sobre confirmações reais — R$ 1,00 da InfinitePay e R$ 10,00 da Cora.

**Uma tela de diagnóstico que afirma "sem efeito" sobre dinheiro que entrou é pior que não ter tela: ela convence quem olha de que não há nada ali.**

Corrigido com `processed_unlinked` ("Processado, sem elo"), discriminado pelo `tenant_id` do evento — ciclo de vida é descartado antes de resolver tenant, então tenant nulo significa mesmo "não virou dinheiro".

**O passado não foi reescrito.** `payments.gateway_event_id` é imutável por `fn_protect_payment`, e isso inclui não inventar origem para registro que nasceu sem ela. O elo daqueles dois pagamentos é reconstruível por arqueologia no payload — que é exatamente a arqueologia que esta ADR existe para nunca mais ser necessária dali para a frente.

---

## Consequências

**Ganho.** "Por que este dinheiro entrou?" passa a ser um `JOIN`, não uma investigação. A confirmação sem verificação da ADR 0033 vira consulta booleana em vez de `LIKE` em texto livre. Quatro capacidades que não deveriam estar ao alcance do navegador saem de lá — e o razão deixa de aceitar escrita de quem não está logado.

**Verificação.** Nada aqui foi aceito por leitura de código. As permissões foram conferidas com `has_function_privilege` e `information_schema`; os dois exploits foram reproduzidos por HTTP e por SQL antes e depois da correção; a guarda interna do razão foi testada com o grant reconcedido de propósito, para provar que basta sozinha; e os caminhos legítimos (`service_role`, `pg_cron` com `role = 'none'`, usuário logado na própria empresa, owner de plataforma administrando) foram exercitados um a um. Suíte E2E completa em banco limpo: **257 passando, 0 falhas**.

E a lição de método, que custou o Problema 4: **verificar a própria correção é o que encontra o resto.** A Fase 2b reportou "21 funções revogadas" e estava certa quanto ao que fez — só não era o que bastava. Contar o que se fez não é medir o resultado.

**Custo.** `getOrCreateIntent` deixa de escrever `payment_intents` com o cliente do usuário e passa por RPC — a validação de tenant, que a RLS fazia, passa a ser explícita dentro da função. É exatamente a troca que o comentário em `actions.ts` desaconselhava, e continua sendo um argumento válido em geral: escolhemos pagá-la aqui porque `payment_intents` guarda a única ligação entre dinheiro e tentativa, e essa ligação não pode depender de nenhum membro se comportar bem.

**Não resolvido.** Da ADR 0033, resta **a Questão 1** — o destino do dinheiro que chega para uma cobrança cancelada, decisão do humano (crédito do cliente ou recebível). A **Questão 2 está fechada por inteiro**: a 2a pelas Fases 3b e 4, e a **2b pela renovação de credencial na drenagem**.

A 2b merece nota, porque o diagnóstico original estava certo e a saída veio de onde ele não olhou. Ele concluía que copiar a renovação para o Deno seria duplicar orquestração de rotação — verdade, e continua sendo. O que mudou é que a Fase 4 criou uma rota **em `apps/web`**, mesmo runtime de `resolveCredentials`. Renovar ali antes de acionar o replay não duplica nada: reusa a orquestração existente, com margem, reivindicação, lease e rotação.

Renovação por **conta**, não por evento — chamar uma vez por par (tenant, provedor) evita gastar a janela de 3 usos da Cora com dez eventos do mesmo lote. E falha de renovação **nunca** interrompe a drenagem: refresh token morto é caso de reconectar a conta, não de impedir que os outros eventos sejam reprocessados.

Verificado com um mock que **recusa o token velho**, para que o teste pudesse falhar: mesmo evento, mesmo token, a única diferença sendo a renovação ter rodado.

| | renovação | resultado |
|---|---|---|
| `contra-evt` | não rodou (sem `expires_at`) | `accepted_unverified` — "Confirmado SEM verificação" |
| `renov-evt` | rodou | `confirmed` — "Confirmado pelo gateway" |

**A confirmação sem verificação da ADR 0033 continua existindo**, e deve continuar: ela cobre o caso em que a renovação também falha. O que muda é que ela deixa de ser o caminho normal para credencial vencida e volta a ser o último recurso que sempre deveria ter sido.

**Em aberto.** Nada de segurança ficou pendente desta varredura: `anon` está fora de `public`, as guardas de papel são NULL-safe, e a migration falha sozinha se qualquer uma das duas coisas regredir. Das Fases, resta apenas a leva de testes de privilégio POR PAPEL (item 15), que é cobertura e não correção.

Duas miudezas anotadas, sem urgência: três policies (`billing_runs`, `fine_attachments`, `late_charge_policies`) declaram `{public}` em vez de `{authenticated}` — inofensivo hoje, porque o `USING` depende de `get_user_tenants()`/`current_customer_ids()`, vazios para o anônimo; e `payments` aceita `DELETE` de `authenticated`, na prática barrado pelo `ON DELETE RESTRICT` das alocações, que são imutáveis.

**Aceito.** A ADR 0033 permite confirmar sem verificar quando a credencial da Cora vence. Isto continua valendo; a mudança é que agora fica marcado em coluna própria e será alvo de alerta na Fase 4, em vez de depender de alguém abrir o log.
