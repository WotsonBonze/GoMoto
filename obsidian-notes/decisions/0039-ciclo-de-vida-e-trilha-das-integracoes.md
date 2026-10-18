# ADR 0039 — Ciclo de vida e trilha das integrações de pagamento

- **Status:** Aceita (implementada 2026-10-11)
- **Data:** 2026-10-11
- **Autores:** Alan + agente IA
- **Substitui:** —
- **Substituída por:** —
- **Relacionada:** [[decisions/0030-multiplos-gateways-de-pagamento|ADR 0030]], [[decisions/0024-ledger-financeiro-com-contrapartida|ADR 0024]], [[decisions/0033-dinheiro-para-cobranca-cancelada|ADR 0033]], [[decisions/0034-auditabilidade-do-caminho-do-dinheiro|ADR 0034]], [[decisions/0037-integracao-asaas|ADR 0037]]

## Contexto

Pedido do Alan (2026-10-11): *"precisamos ter conectar, desconectar e excluir a integração; uma nova integração só é adicionada se a anterior for excluída; manter a rastreabilidade para controlar quando e quem alterou as configurações de integração."*

Estado atual:

- Só existem **conectar** e **desconectar**. A chave única é `(tenant_id, provider, external_account_id)`: reconectar com **outra** conta do mesmo provedor cria uma linha nova ao lado da antiga. Em produção, a **WAT Motos** já tem 2 contas InfinitePay (1 cobrando, 1 desconectada); com o Asaas sandbox → produção, toda locadora passaria por isso.
- A tela de Integrações desenha **uma linha por provedor**, então a segunda conta confunde a tela (corrigido paliativamente em `e4a751f`).
- **A trilha é da aplicação**: `logAction` em conectar/ativar/desconectar. A troca de credencial de uma conta já conectada não deixa registro próprio. É o mesmo tipo de lacuna que a ADR 0034 fechou para o dinheiro, movendo a trilha para trigger: o que mora só na aplicação some no primeiro caminho que não passa por ela.
- A tabela é referenciada por `payment_intents.provider_account_id` (`ON DELETE RESTRICT`), e o pagamento e o razão dependem do intent. **Apagar a linha não é opção** (ADR 0024, Princípio 3).

## Decisões (escolhidas pelo Alan)

### 1. Uma integração por provedor por locadora

A locadora continua podendo ter Mercado Pago, Cora, InfinitePay e Asaas ao mesmo tempo (ADR 0030 intacta), **uma de cada**. Garantido no banco:

```sql
CREATE UNIQUE INDEX ... ON payment_provider_accounts (tenant_id, provider) WHERE deleted_at IS NULL;
```

A chave antiga `(tenant_id, provider, external_account_id)` sai: ela impediria reconectar a mesma conta depois de uma exclusão, e a nova a cobre enquanto a integração existe.

### 2. Três estados, transições explícitas

```
(nenhuma) ──Conectar──▶ CONECTADA ──Ativar──▶ COBRANDO
                          ▲   │                  │
              Reconectar  │   └──Desconectar◀────┘
              (MESMA      │          │
               conta)     └──── DESCONECTADA ──Excluir──▶ EXCLUÍDA (some da tela;
                                                           libera Conectar outra conta)
```

- **Desconectar** é reversível: a conta para de cobrar e de aparecer como opção, mas **a credencial e o webhook ficam**. Pagamento de um código já emitido continua sendo confirmado.
  *Muda o comportamento atual do Asaas*, que removia o webhook ao desconectar (fase 2 da ADR 0037). A remoção vai para o Excluir.
- **Reconectar** aceita **só a mesma conta** (mesma carteira Asaas, conta MP/Cora, InfiniteTag): renova a credencial. Outra conta é recusada no banco com `GATEWAY_PROVIDER_ALREADY_CONNECTED` → "exclua a integração atual para conectar outra conta".
- **Excluir** só a partir de **Desconectada** (`GATEWAY_DISCONNECT_FIRST`), **na hora**, sem período de carência (decisão do Alan: o mais simples possível), com o aviso abaixo na tela. É irreversível:
  1. na Server Action, enquanto a credencial existe: cancela no provedor os intents não pagos (`cancelIntent`, best-effort, ADR 0033) e chama `disconnect` do provedor (remove o webhook do Asaas, com a guarda de carteira compartilhada entre locadoras que já existe);
  2. na RPC `fn_delete_provider_account`, numa transação: confere owner e estado, **apaga o segredo do Vault**, zera `secret_id`, grava `deleted_at`/`deleted_by` e expira os intents pendentes.
  A linha fica no banco como histórico: os intents, pagamentos e eventos continuam apontando para ela.

**Avisos na tela** (o usuário confirma antes):

- **Desconectar:** *"Este gateway deixa de gerar cobranças. Os códigos de pagamento já enviados aos clientes continuam válidos e, se forem pagos, a cobrança é baixada automaticamente. Você pode reconectar esta mesma conta depois."*
- **Excluir:** *"Esta ação não pode ser desfeita. Os códigos de pagamento (Pix e links) gerados por esta integração e ainda não pagos serão cancelados, e a credencial será apagada. Se um cliente pagar um desses códigos depois da exclusão, o pagamento NÃO será baixado automaticamente: será preciso registrá-lo manualmente na cobrança. Os pagamentos já recebidos e o histórico continuam no sistema."*

"Excluir os dados de pagamento" significa cancelar os **códigos não pagos**. Pagamentos recebidos estão no razão e não se apagam (ADR 0024, Princípio 3).

**Considerado e descartado:** manter a credencial e o webhook em "modo só-confirmação" por um prazo depois da exclusão, para baixar sozinho um pagamento tardio. Resolveria o risco residual abaixo, mas exige uma rotina agendada e um estado a mais. O Alan preferiu o aviso explícito e a baixa manual.

### 3. Trilha no banco, por trigger

Trigger `AFTER INSERT OR UPDATE` em `payment_provider_accounts` grava em `audit_logs` cada transição, na mesma transação da mudança:

| Ação | Quando |
|---|---|
| `gateway_connected` | linha nova |
| `gateway_reconnected` | credencial renovada pela conexão (reativação ou troca de chave da mesma conta) |
| `gateway_activated` / `gateway_deactivated` | `is_default` muda |
| `gateway_disconnected` | `active` true → false |
| `gateway_deleted` | `deleted_at` preenchido |

- **Quem:** `auth.uid()` em `user_id`; sem usuário (service_role, migration), `actor_system` diz quem foi.
- **Nunca a credencial**, nem o `secret_id`. Grava provedor, conta (`external_account_id`), rótulo e o estado antes/depois.
- A renovação automática de token (Cora/MP) já é registrada como `token_refreshed` (ADR 0034) e **não** é duplicada aqui. A RPC de conexão marca a própria escrita (`set_config` local à transação) para o trigger distinguir "reconexão por uma pessoa" de "refresh do sistema".
- Os `logAction` de gateway na aplicação saem: duas fontes para o mesmo fato divergiriam.

### 4. Histórico na tela

Em Integrações, cada provedor ganha **"Histórico"**: lista do que aconteceu (conectada, ativada, desconectada, excluída, reconectada), **por quem** (nome/e-mail) e **quando**, inclusive das integrações já excluídas daquele provedor. A leitura é por `@gomoto/data`, respeitando a RLS de `audit_logs` (tenant).

## Migração dos dados existentes

Para cada `(tenant_id, provider)` com mais de uma linha, fica a que **cobra**, senão a **ativa**, senão a **mais recente**. As outras viram `deleted_at = now()`, com o segredo apagado do Vault e auditoria `gateway_deleted` com `actor_system = 'migration:0039'`. Hoje isso atinge **só a InfinitePay desconectada da WAT Motos** (conferido em produção, 2026-10-11). Se a migration encontrar uma conta **ativa** duplicada, ela **falha** em vez de escolher sozinha.

## Consequências

- **Risco residual, aceito e avisado na tela:** depois de excluir, um código antigo pago pelo cliente não é baixado automaticamente.
  - **Asaas:** o webhook foi removido, então nenhum aviso chega. O dinheiro está na conta da locadora e a baixa é manual.
  - **Mercado Pago / Cora / InfinitePay:** o aviso chega, mas sem credencial não há como conferir. O evento fica na fila de replay com erro (ADR 0033: preferível ao silêncio).
  - O cancelamento no provedor antes de excluir reduz o risco; a **InfinitePay não tem cancelamento**.
- Uma migration: colunas `deleted_at`/`deleted_by`, índice parcial, troca da chave única, `fn_connect_provider_account` (regra da mesma conta), `fn_delete_provider_account`, trigger de auditoria e a limpeza dos dados. `fn_set_default` e `fn_disconnect` passam a recusar conta excluída.
- `listProviderAccounts` deixa de devolver excluídas; novo `listGatewayHistory` em `@gomoto/data`.
- Tela: estados Conectar / (Ativar, Desconectar) / (Reconectar, Excluir), modal de exclusão explicando a irreversibilidade, e o Histórico.
- Testes: unitários das transições e da trilha, RPC em transação no banco local (owner, estados, unicidade, Vault apagado, auditoria sem credencial), e o fluxo na tela.

## Implementação (2026-10-11)

Aprovada pelo Alan, incluindo a limpeza da WAT Motos na migration.

- Migration `20261011013620_ciclo_de_vida_e_trilha_das_integracoes.sql`: colunas, CHECK "excluída é inativa e sem segredo", trigger `trg_audit_provider_account`, limpeza de duplicatas, índice parcial, `fn_connect` (só a mesma conta), `fn_disconnect` (mantém a credencial), `fn_delete_provider_account`.
- App: `deleteGatewayAction` (cancela os códigos no provedor e remove o webhook antes da RPC); `disconnectGatewayAction` não mexe mais no provedor; `logAction` de gateway removido (actions e callback OAuth); `listProviderAccounts` sem excluídas; `listGatewayHistory`/`useGatewayHistory`; tela com Reconectar/Excluir, os dois avisos e a tabela "Histórico de alterações"; cron `drain-gateway-events` ignora excluídas; guarda do webhook compartilhado passa a olhar "não excluída" em vez de "ativa".

**Verificado:**

- Banco local, com sessão de owner: outra conta com uma viva → `GATEWAY_PROVIDER_ALREADY_CONNECTED`; reconectar a mesma → uma linha `gateway_reconnected`; excluir conectada → `GATEWAY_DISCONNECT_FIRST`; excluir desconectada → segredo fora do Vault, `deleted_by` gravado; mexer na excluída → recusado; outra conta depois de excluir → ok; refresh de token não gera linha de integração.
- Migration sobre uma duplicata semeada: a antiga virou excluída, o segredo saiu do Vault, e a trilha a assinou como `system:migration_0039`.
- **Navegador:** Desconectar e Excluir pela tela, com os avisos exatos; histórico com e-mail do autor e horário de Brasília; console limpo.

**Defeito que só o navegador pegou:** `authenticated` lê a tabela por GRANT DE COLUNA, e a coluna nova não entrou. O filtro `deleted_at` respondia 403 e a lista de gateways sumia. Corrigido na migration com `GRANT SELECT (deleted_at)`.

**Observação, fora do escopo:** `anon` tem todos os privilégios de tabela em `payment_provider_accounts`, local e produção. É o padrão do Supabase para tabelas novas em `public`; a RLS está ligada e a única policy é de `authenticated`, então `anon` não lê nem altera linhas pela API. Não é explorável hoje, mas fica registrado.
