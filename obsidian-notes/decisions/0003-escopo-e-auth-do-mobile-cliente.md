# ADR 0003 — Escopo e autenticação do mobile (cliente final)

- **Status:** Aceita (estendida por [[decisions/0004-control-plane-e-identidade-do-cliente|ADR 0004]] em 2026-06-15 e por [[decisions/0016-escrita-cliente-mobile-route-handler|ADR 0016]] em 2026-07-30)
- **Data:** 2026-06-12
- **Autores:** Stakeholder + agente IA
- **Substitui:** —
- **Substituída por:** —
- **Estendida por:** [[decisions/0004-control-plane-e-identidade-do-cliente|ADR 0004]] — formaliza CPF como identidade global (§2) e troca login email→CPF via shell email (§4), além do picker dedicado `/select-tenant` (§3). [[decisions/0016-escrita-cliente-mobile-route-handler|ADR 0016]] — resolve a seção "Quando reavaliar" abaixo ("Cliente precisa escrever"): formaliza Route Handler + service role como o padrão de escrita do cliente mobile, mantendo RLS exclusivamente de leitura.

## Contexto

`apps/web` é o cockpit administrativo do operador (admin/operator/viewer em `tenant_members`). `apps/mobile` foi bootstrapado em SDK 56 + Expo Router + login Supabase no commit `6303f8b`, mas o login atual aceita **qualquer** `auth.users` — inclusive operadores. Não há gating de papel, não há features cliente-específicas, e o schema não conhece a noção de "cliente como usuário autenticado": `customers` é uma tabela CRM sem vínculo com `auth.users`.

Antes de continuar codando telas no mobile, precisamos fixar:

1. Quem é o usuário do mobile.
2. Como ele entra no sistema.
3. Como o backend separa rigorosamente o universo cliente do universo administrativo.
4. O que ele pode fazer (escopo MVP).

Multi-tenancy adiciona uma dimensão: a mesma pessoa pode alugar moto em duas empresas distintas (ex.: cliente da "GoMoto Bonze" e da "GoMoto Norte"). O modelo de auth precisa absorver isso sem confundir com membership administrativo.

## Decisão

### 1. Separação por interface, não por constraint

Cada app olha **apenas a sua tabela de papel** ao autenticar:

- **`apps/web`** considera autenticado quem tem linha em `tenant_members`. Se o `auth.uid()` não está lá, faz `signOut()` e devolve o login com mensagem genérica.
- **`apps/mobile`** considera autenticado quem tem linha em `customers` com `user_id = auth.uid()`. Caso contrário, `signOut()` + login.
  - **Sessão por aparelho (2026-10-16):** todo `signOut` do mobile usa `scope: 'local'`. O padrão do auth-js é `'global'` e, antes, sair em um aparelho revogava a sessão do cliente em todos os outros (eles caíam no login na renovação seguinte do token). O mesmo usuário pode estar logado em vários aparelhos ao mesmo tempo.
  - **Falha ao ler `customers` ≠ "não é cliente":** a query de vínculo lança erro em vez de devolver `[]`. Na abertura do app, um erro mantém a sessão (com a última locadora salva no aparelho); só a lista vazia confirmada desloga. No login, um erro desfaz a sessão local e mostra uma mensagem de conexão.

Não há constraint cruzada no banco. Se um mesmo `auth.users` aparecer nas duas tabelas, cada app simplesmente ignora a presença na outra: o web só enxerga o universo administrativo, o mobile só enxerga o universo cliente. Isso é o suficiente porque (a) nenhum dado vaza — RLS filtra por papel, não por identidade global; (b) a UX "muito bem distinta" exigida pelo stakeholder está garantida pela separação de **apps**, não de **contas**; (c) não acrescentamos trigger nem fail-mode de "email já existe como admin, não pode ser cliente". Reversível se o stakeholder decidir endurecer depois — só adicionar trigger.

### 2. Modelo de schema do cliente

```sql
ALTER TABLE customers
  ADD COLUMN user_id UUID NULL REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE INDEX idx_customers_user_id ON customers(user_id) WHERE user_id IS NOT NULL;

CREATE UNIQUE INDEX customers_tenant_user_unique
  ON customers(tenant_id, user_id) WHERE user_id IS NOT NULL;
```

- `user_id` é **nullable** — cliente pode ser cadastrado pelo admin antes de receber o convite (mesmo fluxo de hoje).
- UNIQUE parcial `(tenant_id, user_id)` — um `auth.users` representa **um** `customers` por tenant; mas o mesmo `auth.users` pode aparecer em N linhas de `customers`, **uma por tenant** (multi-tenant cliente).
- Sem UNIQUE em `user_id` isolado — esse é o ponto que habilita "cliente de mais de uma empresa".
- Sem constraint cruzada com `tenant_members` — a separação admin/cliente acontece nos apps (§1), não no schema.

### 3. Multi-tenant no mobile

Após login, o backend retorna a lista de tenants em que o `auth.uid()` tem `customers` row:

```sql
SELECT t.id, t.name FROM tenants t
JOIN customers c ON c.tenant_id = t.id
WHERE c.user_id = auth.uid();
```

- **0 tenants:** rejeita login (não é cliente).
- **1 tenant:** entra direto, salva tenant ativo em `AsyncStorage`.
- **N tenants:** mostra seletor "Escolha a empresa", salva escolha. App expõe troca de tenant nas configurações.

Todas as queries do mobile filtram pelo tenant ativo. RLS faz o reforço server-side (vê §5).

> **Implementado em 2026-10-16** (até então nenhuma das duas frases acima valia):
> - **Filtro por locadora ativa:** a RLS de cliente usa `current_customer_ids()`, que devolve o cadastro do usuário em **todas** as locadoras — ela isola cliente de cliente, não locadora de locadora para o mesmo cliente. Sem filtro no app, quem era cliente de duas via a mesma placa no Início e as cobranças misturadas, qualquer que fosse a escolha. Agora o `SupabaseProvider` do mobile liga `scopeReadsToTenant`, e os hooks de lista (`useRentals`, `useVehicles`, `useMaintenances`, `useMaintenanceRecords`, `useCustomers`, `useMyCharges`, `useMyPaidCharges`, vistorias do cliente) filtram por `tenant_id` via `useReadScope()` e levam a locadora na queryKey. O web não liga o escopo — comportamento inalterado.
> - **Troca na aba Conta:** seção "Locadora", visível só com 2+ locadoras: mostra a locadora ativa e o item "Trocar de locadora", que abre um modal com a lista (✓ na atual, suspensas desabilitadas); tocar numa locadora troca via `selectTenant()` e volta ao Início.

### 4. Convite e onboarding do cliente

O admin no web é quem dispara o acesso:

1. Admin cria/edita `customers` no web e informa o email do cliente.
2. Botão **"Enviar acesso ao app"** dispara uma Server Action que:
   - Resolve `auth.users` pelo email. Se já existe (cliente de outro tenant), apenas grava o `user_id` na linha `customers` deste tenant. **Não** dispara novo email.
   - Se não existe, chama `supabase.auth.admin.inviteUserByEmail(email, { redirectTo: 'gomoto://auth-callback' })` via `SUPABASE_SERVICE_ROLE_KEY` server-side. Supabase manda email com magic link; ao clicar, o app abre via deep link (`scheme: "gomoto"` já configurado em `app.json`).
3. Primeiro login (magic link) cai em tela de **definir senha**. Após salvar senha, redireciona pra home.
4. Logins seguintes: email + senha. "Esqueci a senha" dispara `signInWithOtp` (magic link de novo).

### 5. RLS para o cliente

Cliente é **read-only** no MVP. Policies SELECT adicionais em:

- `contracts WHERE customer_id IN (SELECT id FROM customers WHERE user_id = auth.uid() AND tenant_id = <ativo>)`
- `billings` com a mesma cláusula
- `motorcycles WHERE id IN (SELECT motorcycle_id FROM contracts WHERE customer_id ...)`
- `maintenances WHERE motorcycle_id IN (...)`

Função helper `current_customer_id(tenant_id UUID)` evita repetir o sub-select. Policies de INSERT/UPDATE/DELETE **continuam exclusivas para `tenant_members`** — o cliente jamais escreve.

O bloqueio "admin não loga no mobile" também roda no client (após login, check `tenant_members` e `signOut()` se for admin) — mas RLS server-side é a fonte de verdade: mesmo que o gating client falhe, o cliente não consegue ler dados que não são dele.

### 6. Features MVP do mobile (escopo trancado)

| Tela | Conteúdo |
|---|---|
| **Login** | Magic link / email-senha + seletor de tenant |
| **Definir senha** | Apenas no primeiro acesso pós-magic-link |
| **Home / Contrato vigente** | Moto alugada, datas, valor mensal, status |
| **Cobranças** | Lista (em aberto / pagas), valor, vencimento, histórico |
| **Manutenções da moto** | Próxima prevista, histórico de concluídas |
| **Suporte** | Telefone / WhatsApp do operador do tenant (vem de `companies`) |
| **Sair** | `signOut({ scope: 'local' })` + volta pro login (só este aparelho) |

Fora do MVP: pagar cobrança no app, abrir chamado, push notifications, edição de dados pessoais.

## Alternativas consideradas

| Alternativa | Por que descartada |
|---|---|
| **Role `customer` em `tenant_members`** | Mistura conceitos: `tenant_members` modela **operação interna** do tenant; cliente é **consumidor externo**. RLS de admin já depende dessa tabela; sobrecarregar quebra a auditoria de "quem é colaborador". |
| **Tabela separada `customer_profiles(user_id, customer_id)`** | Indireção sem ganho. `customers.user_id` direto é suficiente porque a relação é 1-a-1 dentro do tenant. |
| **Bloquear cross-membership por trigger** | Custo concreto (função + 2 triggers + UX de erro "email já é admin") sem ganho — a separação de apps já entrega a UX "muito bem distinta" exigida. Reversível se o stakeholder mudar de ideia: basta adicionar trigger depois. |
| **Magic link em todo login (sem senha)** | Atrito alto em uso diário. Cliente que abre o app pra ver cobrança espera login direto, não esperar email. Magic link fica como vetor de primeiro acesso + recuperação. |
| **Auto-cadastro do cliente (signup público)** | Modelo B2B aqui — o cliente é cadastrado no CRM pelo operador antes de qualquer interação. Auto-cadastro abriria fila de validação manual e contradiz o fluxo atual de `customers`. |

## Consequências

### Positivas

- **Universos auditáveis.** `tenant_members` continua representando time interno; `customers.user_id` representa consumidor. Nunca há ambiguidade.
- **Multi-tenant cliente natural.** Mesmo `auth.users` em N linhas de `customers` (uma por tenant). UI resolve com seletor.
- **RLS server-side é o gate real.** Mesmo que o client mobile seja "burlado", o cliente não vê dado que não é dele.
- **Convite reaproveita auth existente.** Cliente que já tem conta (porque é cliente de outra empresa) não recebe email duplicado — admin só vincula.

### Negativas

- **`packages/data` precisa de provider sem SSR pra rodar no RN.** Hoje os hooks assumem `useSupabaseContext()` Next. Slice próximo: extrair provider neutro ou criar um paralelo no mobile.
- **Service role key no server.** `inviteUserByEmail` exige `SUPABASE_SERVICE_ROLE_KEY`; já existe no `.env.local.example` mas nunca foi usada. Garantir que **só** Server Actions consumam.
- **Sem garantia de schema contra cross-membership.** Confiamos no gate dos apps. Se um operador for cadastrado também como cliente em outro tenant por engano administrativo, ele consegue logar nos dois apps com a mesma conta. Mitigação: monitor (query simples `SELECT user_id FROM customers INTERSECT SELECT user_id FROM tenant_members`) — se aparecer, é dado pra revisar manualmente.

### Neutras

- **Sem push notifications no MVP.** Cliente abre o app pra ver — não recebe alerta. Adicionar depois com Expo Notifications.
- **Sem edição de perfil.** Cliente pediu corrigir CPF? Liga pro operador. Operador edita no web.

## Quando reavaliar

- **Cliente precisa escrever** (pagar cobrança, abrir chamado, atualizar dados): reabrir §5 e portar o padrão `actions.ts` da [[decisions/0002-padrao-canonico-pagina-server-actions|ADR 0002]] pra mobile (provavelmente via HTTP em API route Next, não Server Action direto).
- **Push notifications** entram no roadmap: revisa convite/onboarding pra capturar Expo push token.
- **Cross-membership virar problema real** (operador conseguindo se logar como cliente da própria empresa): adicionar trigger `BEFORE INSERT/UPDATE` em `customers` e `tenant_members` checando a outra tabela. Schema não muda — só ganha enforcement.
- **Cliente quer auto-cadastro**: schema ganha fluxo público de signup com fila de aprovação no web.

## Estado atual

- Schema **ainda não** modificado. Migration `add_customer_user_link.sql` é o próximo passo.
- Login mobile **ainda aceita admin** — `6303f8b` será endurecido (rejeitar se `auth.uid()` está em `tenant_members`) na mesma migration/PR.
- `apps/mobile/app.json` já tem `scheme: "gomoto"` — deep link funciona out of the box.
- `SUPABASE_SERVICE_ROLE_KEY` já presente em `.env.local.example` do web.

## Referências

- [[decisions/0001-monorepo-pnpm-turborepo|ADR 0001]] — adoção do monorepo + multi-tenant (P2).
- [[decisions/0002-padrao-canonico-pagina-server-actions|ADR 0002]] — façade `actions.ts` co-localizada (será reaplicado se cliente passar a escrever).
- `supabase/migrations/20260611232140_tenants_and_tenant_members.sql` — modelo administrativo de membership.
- `supabase/migrations/20260611002632_initial_schema.sql:40` — tabela `customers` (ganha `user_id`).
- Commit `6303f8b` — login mobile inicial (sem gating de papel).
