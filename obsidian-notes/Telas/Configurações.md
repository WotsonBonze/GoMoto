# ⚙️ Tela: Configurações — [[GoMoto]]

Rota: `/configuracoes` | Tipo: Client Component

## Seções

> Seção "Dados da Empresa" removida (2026-08-07) — os campos `empresa_*` na tabela `settings` não eram consumidos por nenhuma outra tela (contratos, relatórios, etc.).

### Gateway de Pagamento (Owner apenas) — [[decisions/0030-multiplos-gateways-de-pagamento|ADR 0030]]

O tenant conecta **quantos gateways quiser**; exatamente **um** gera as cobranças.

A lista sai do catálogo `PAYMENT_PROVIDERS` (`@gomoto/core/payments`) cruzado com as contas do tenant — nenhum nome de provedor está escrito na tela. Provedor com `available: false` aparece como **"Em breve"**, com o botão desabilitado: o tenant vê para onde a integração vai sem clicar em algo que não faz nada.

| Estado da linha | Badge | Ações |
|---|---|---|
| `is_default AND active` | **Gerando cobranças** | Desconectar |
| `active`, sem `is_default` | Conectado | **Ativar**, Desconectar |
| conta existente, `active = false` | (do catálogo) | Reconectar |
| nunca conectado, `available` | — | Conectar |
| nunca conectado, `available = false` | Em breve | Conectar (desabilitado) |

**Conectar não elege.** Só o primeiro gateway do tenant nasce eleito; um segundo entra como "Conectado" e a troca é um clique explícito em *Ativar*. Conectar nunca redireciona o dinheiro da empresa em silêncio.

**Aviso de "Nenhum gateway ativo".** Existe conta conectada e nenhuma eleita — normalmente depois de desconectar a que cobrava. O app do cliente para de gerar cobrança online; sem o aviso, isso acontecia sem nada na tela dizer por quê.

**Provedores disponíveis:**

| Provedor | Conexão | Gera |
|---|---|---|
| Mercado Pago | OAuth2 | Pix |
| Cora | OAuth2 | Pix (mín. R$ 5,00) |
| InfinitePay | **InfiniteTag digitada** | Link de checkout (mín. R$ 1,00) |

Nos dois primeiros o tenant é levado ao provedor, faz login e autoriza. O `redirect_uri` (`<NEXT_PUBLIC_APP_URL>/api/auth/gateway/<provedor>/callback`) precisa estar **registrado no painel de cada provedor**, senão a autorização é recusada antes da tela de login.

**InfinitePay conecta por handle** — [[decisions/0032-integracao-infinitepay-checkout|ADR 0032]]. Não há OAuth nem chave: a credencial é a InfiniteTag, um nome de usuário **público**. O operador digita (com ou sem `$`) e o GoMoto **sonda a API criando um link de verificação de R$ 1,00** antes de gravar — é a única prova disponível de que a tag cobra, porque `payment_check` responde igual para pedido inexistente e pedido não pago.

Depois de gravar, um modal mostra o link e pede conferência, com *Não é minha conta* desconectando na hora. O motivo é que **nada na API prova posse do handle**: digitar errado manda o dinheiro para a conta de um estranho, em silêncio. A conta pode precisar habilitar o **Checkout Externo** no app da InfinitePay — o erro é o mesmo de handle inexistente, então a mensagem cobre as duas leituras.

Escrita: as três operações passam por RPC `SECURITY DEFINER` (`fn_connect_provider_account`, `fn_set_default_provider_account`, `fn_disconnect_provider_account`), que checam Owner **e** tenant dentro do banco. `authenticated` não tem `INSERT`/`UPDATE` em `payment_provider_accounts` — a linha aponta para uma credencial no Vault, e o guard de dinheiro não pode viver só na aplicação.

### Contatos para o cliente (Owner/Admin)

Lista de contatos que aparece no **app do cliente**, aba Conta → *Fale com a locadora*, na ordem definida aqui (setas subir/descer). Cada contato tem **nome livre** ("Financeiro", "Manutenção"), **número e/ou e-mail** — ao menos um —, o **tipo do número** (Telefone ou WhatsApp) e um **horário de atendimento** opcional em texto livre ("Seg a sex, 8h às 18h").

- Tabela `tenant_contacts` (`label`, `phone` só dígitos 10–11, `phone_kind` `phone|whatsapp`, `email`, `business_hours`, `sort_order`).
- Validação: `TenantContactInputSchema` (`@gomoto/core`) — aceita telefone mascarado e normaliza para dígitos.
- Escrita: `createTenantContactAction`, `updateTenantContactAction`, `deleteTenantContactAction`, `reorderTenantContactsAction` em `configuracoes/actions.ts`; todas com `requireTenantOwnerOrAdmin` + `logAction`.
- RLS: membros leem, **clientes do tenant leem** (`get_customer_tenants()`), só Owner/Admin escrevem (`get_user_admin_tenant_memberships()`); `anon` sem grant.
- Leitura: `useTenantContacts()` (`@gomoto/data`), filtrando pelo tenant do `SupabaseProvider` — um cliente de duas locadoras enxerga as duas pela RLS.

No app, o ícone segue o tipo (WhatsApp verde ou telefone; envelope quando só há e-mail) e o horário aparece abaixo do número. Tocar abre direto o WhatsApp ou a ligação; se o contato também tem e-mail, o app pergunta qual canal usar. O cliente vê **somente** os contatos cadastrados aqui: sem nenhum, a seção "Fale com a locadora" não aparece no app. O telefone e o e-mail gerais da empresa (`tenants.contact_phone/contact_email`) não são exibidos ao cliente.

### Encargo por atraso (Owner apenas) — ADR 0024

A única forma de configurar multa e juros. Antes desta seção, `late_charge_policies` só recebia escrita por migration: mudar a política exigia SQL direto no banco.

| Campo | Unidade na tela | Unidade em `late_charge_policies` |
|---|---|---|
| Tipo de multa | percentual / valor fixo | `fee_type` |
| Multa | **%** (2 = 2%) ou R$ | `fee_value` — **fração** (0.02) quando percentual |
| Juros | **% ao mês** (1 = 1% a.m.) | `daily_interest_rate` — **fração ao dia** (÷ 30) |
| Carência | dias | `grace_period_days` |
| Encargo mínimo | R$ | `min_amount` |
| Em vigor a partir de | data ≥ hoje | `effective_from` |

**Empresa nova nasce sem política, e isso é o estado correto.** `create_tenant_with_owner` não cria nenhuma; o back-fill da migration de políticas só alcançou os tenants que já existiam. Sem política, cobrança vencida não acumula multa nem juros — o cliente deve o valor original, por quanto tempo passar.

Nesse estado a tela mostra um aviso e os campos ficam **vazios**, com a convenção de mercado apenas no placeholder. Antes eles nasciam preenchidos com 2% e 1% ao mês, e quem abria a tela lia configuração onde não havia nenhuma.

A conversão entre as duas colunas vive em `toPolicyRow`/`toPolicyInput` (`@gomoto/core`, `rules/late-charge-policy.ts`), testada. Não é detalhe de formatação: a convenção já divergiu duas vezes nesta base — a função `calculateLateCharges` (removida) tratava `2` como 2%, enquanto a regra viva trata `0.02` como 2%.

**Salvar cria uma VERSÃO nova, nunca edita a vigente.** Cobrança guarda `late_charge_policy_id`, então o que já foi emitido continua valendo o que valia no dia. A numeração e a trava de retroatividade estão em `fn_create_late_charge_policy`, sob `FOR UPDATE` do tenant — `MAX(version)+1` calculado no app daria o mesmo número a duas gravações simultâneas.

Quem escolhe a política de uma cobrança é o banco, por `fn_late_charge_policy_at(tenant, data)`, na **data de emissão**. Fonte única: emissão avulsa (`fn_create_charge`) e cron (`issue_due_charges`) chamam a mesma função.

Havia três respostas para "qual política vale": `fn_create_charge` casava por `due_date`, o cron por `CURRENT_DATE` resolvido uma vez para o lote inteiro, e a lista do cockpit usava a vigente hoje para todas as linhas. Com uma versão só na base ninguém percebia; a segunda fez a mesma cobrança valer R$ 35 de multa fixa na lista e 2% na tela de detalhe.

`due_date` tinha um efeito difícil de defender: cobrança emitida hoje com vencimento em 60 dias podia pegar uma versão **agendada**, ainda não vigente.

### Diagnóstico das integrações (Owner e Admin) — [[decisions/0034-auditabilidade-do-caminho-do-dinheiro|ADR 0034]]

Sub-rota `/configuracoes/integracoes`, no mesmo padrão de `/configuracoes/usuarios`: card com `ChevronRight` na tela principal, guarda por `requireTenantOwnerOrAdmin()` com `redirect('/configuracoes')` — Operator e Viewer não sabem que a tela existe.

**Por que Owner/Admin e não Operator:** um evento de gateway carrega valor, cliente e o erro cru do provedor. É informação de gestão, no mesmo nível de "Usuários".

A tela responde duas perguntas que antes não tinham resposta **dentro do produto** — o rastro existia em `gateway_events` desde a Spec 0014, mas só era alcançável por quem tivesse acesso ao banco e soubesse montar o SQL. Numa locadora, isso é ninguém.

#### Eventos recebidos — view `gateway_event_audit`

Uma linha por notificação de gateway, com a corrente `evento → pagamento → razão` montada (as FKs vieram da Fase 1 da ADR 0034). Cinco situações, decididas **em SQL** e não na tela:

| Situação | Quando | Cor |
|---|---|---|
| **Confirmado** | verificado com o provedor e lançado no razão | verde |
| **Aceito sem conferir** | confirmado sem reconsultar o provedor — credencial vencida ([[decisions/0033-dinheiro-para-cobranca-cancelada\|ADR 0033]]) | âmbar |
| **Sem efeito** | ciclo de vida (`INVOICE.DRAFTED`, `CREATED`) — nunca vira dinheiro | cinza |
| **Não processado** | recebido, ainda na fila | âmbar |
| **Falhou** | processamento falhou; o provedor **não reenvia** | vermelho |

A ordem da classificação importa e está na view: **"aceito sem conferir" ganha de "confirmado"**. Um recebimento aceito sem verificação é processado *e* precisa de olho humano; se `confirmado` viesse antes, a ressalva sumiria da tela — que é o oposto do que a ADR 0033 decidiu ao aceitar aquele risco.

O erro cru do provedor fica **fora da tabela**, em cartões abaixo dela: é longo, e espremê-lo numa célula obrigaria a truncar justamente o que explica a falha. Foi o que faltou quando o primeiro pagamento da InfinitePay sumiu.

Filtro "Precisam de atenção" isola falhos, pendentes e aceitos sem conferir.

#### Reconciliação do razão — view `financial_reconciliation`

Uma linha por **problema**; vazio é o estado saudável. Seis verificações:

| Problema | O que significa |
|---|---|
| `unbalanced_transaction` | lançamento que não fecha em zero, ou com uma perna só |
| `charge_without_entry` | cobrança emitida sem lançamento — some do DRE e continua na tela |
| `payable_without_entry` | despesa que não chega ao DRE |
| `credit_without_entry` | crédito que nasce sem saldo utilizável (foi bug real) |
| `payment_without_allocation` | dinheiro recebido que não quitou nada |
| `paid_intent_without_payment` | tentativa marcada como paga sem pagamento |

As quatro primeiras já eram feitas por `apps/web/tests/reconciliacao.spec.ts` — **contra o banco de teste, em CI**. As duas últimas são novas e vieram da ADR 0034: são as formas de a corrente do gateway quebrar sem violar invariante nenhuma do banco.

Ambas as views são `security_invoker = true`: a RLS de cada tabela de origem continua valendo, e a página não filtra por tenant à mão.

#### Reprocessar

Botão em cada evento **falho ou não processado** — e só neles. Chama
`replayGatewayEventAction`, que confere papel (Owner/Admin), confere que o
evento é do tenant (leitura com o cliente do usuário, sob RLS) e então aciona a
Edge Function `gateway-replay` com `service_role`.

Não aparece em "aceito sem conferir": aquele dinheiro **já entrou**. Oferecer
reprocessar ali convidaria a mexer num recebimento concluído para resolver uma
ressalva que se resolve olhando o extrato.

O reprocessamento roda o **mesmo** processador do webhook — os três saíram para
`supabase/functions/_shared/` justamente para que o dreno não seja uma segunda
implementação da confirmação de pagamento. Falha volta para a fila com o motivo
novo, que é o que o operador precisa ler.

### 1. Segurança (ícone Lock `#a880ff`)

| Campo | Tipo |
|---|---|
| Nova Senha | password com toggle Eye/EyeOff |
| Confirmar Nova Senha | password |

**Validações:**
- Mínimo 6 caracteres
- Senhas devem corresponder

Salva via `supabase.auth.updateUser({ password: newPassword })`.

### 2. Informações da Conta (ícone User `#e65e24`) — Read-Only

- E-mail de acesso (`supabase.auth.getUser()`)
- Membro desde (data formatada com `Intl.DateTimeFormat('pt-BR', { day, month, year })`)

## Componente FeedbackMessage

```typescript
type: 'success' | 'error'
// success: bg #0e2f13, border #229731, icon CheckCircle2
// error:   bg #7c1c1c, border #ff9c9a, icon AlertCircle
```

## Queries Supabase

```sql
-- Alterar senha
supabase.auth.updateUser({ password: '...' })

-- Buscar usuário logado
supabase.auth.getUser()
```

## Tags
`#projeto/tela` `#gomoto/configuracoes`
