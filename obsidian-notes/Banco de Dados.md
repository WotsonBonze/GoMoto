# 🗄️ Banco de Dados — [[GoMoto]]

Backend [[Supabase]] (PostgreSQL). Local: `http://127.0.0.1:54321` (Docker). Cloud: produção, só recebe mudança via `supabase db push` controlado por humano.

> ✅ **Redesenho financeiro concluído.** O domínio financeiro roda sobre um ledger de movimentos com contrapartida — ver [[decisions/0024-ledger-financeiro-com-contrapartida|ADR 0024]] e [[Specs/0014-redesenho-financeiro|Spec 0014]].

## Panorama

64 objetos em `public` (57 tabelas + 7 views), 113 migrations versionadas em `supabase/migrations/`.

## Multi-tenancy

Implementado (fase 5). Toda tabela de domínio tem `tenant_id NOT NULL REFERENCES tenants(id) ON DELETE CASCADE`, RLS habilitada e política `tenant_isolation_*` via a função `get_user_tenants()`.

Exceções deliberadas — catálogos globais sem `tenant_id`: `permission_modules`, `permissions`, `role_permissions`.

| Tabela | Função |
|---|---|
| `tenants` | Empresas (locadoras) |
| `tenant_members` | Vínculo usuário ↔ tenant, com papel e ciclo de vida |
| `tenant_contacts` | Contatos por área que a locadora publica no app do cliente ("Fale com a locadora"); clientes leem, Owner/Admin escrevem |
| `platform_admins` | Administradores da plataforma (control plane) |
| `platform_audit_logs` | Auditoria de ações do control plane |

## Core do negócio

| Tabela | Função |
|---|---|
| `vehicles` | Frota (renomeada de `motorcycles` na ADR 0012) |
| `vehicle_photos` | Galeria por slot (ADR 0010) |
| `vehicle_documents` | Documentação do veículo |
| `vehicle_status_history` | Histórico append-only de status (ADR 0011) |
| `customers` | Clientes PF e PJ, com vínculo opcional a `auth.users` |
| `clients_documents` | Documentos do cliente |
| `rentals` | Locações |
| `queue_entries` | Fila de espera |
| `contract_templates` | Modelos `.docx` de contrato |
| `settings` | Config por tenant, key/value |
| `processes` | Base de conhecimento Q&A interna |
| `audit_logs` | Log de ações (`logAction`) |

## Financeiro — ledger

O núcleo é imutável e balanceado. **Saldo nunca é coluna**: todo saldo é agregação de lançamentos, e atraso é derivado de `due_date`, não armazenado.

### Núcleo

| Tabela | Função |
|---|---|
| `financial_accounts` | Plano de contas — **catálogo global**, sem `tenant_id` (precedente: `permissions`) |
| `financial_transactions` | Fato financeiro. Append-only; correção é estorno via `reverses_transaction_id` |
| `financial_entries` | Pernas de débito/crédito. `amount_signed` gerada; `SUM = 0` por transação, garantido por `CONSTRAINT TRIGGER DEFERRABLE` |

### Documentos

| Tabela | Função |
|---|---|
| `rental_billing_schedules` | **Plano** de cobrança da locação — mutável, é onde o reajuste atua |
| `charges` / `charge_items` | **Documento** emitido, imutável. Uma cobrança cobra **uma coisa só**: a origem é do documento, e o item a herda — trigger recusa item de outra origem, e índice único impede a mesma origem gerar duas cobranças vivas |
| `payments` / `payment_allocations` | Recebimento N:N — habilita pagamento parcial e um pagamento cobrindo várias cobranças |
| `payables` | Contas a pagar com responsabilidade e rateio **em valores**, nunca percentual |
| `deposits` / `customer_credits` | Documentos sem coluna de saldo — o saldo vem das views |

### Política e classificação

| Tabela | Função |
|---|---|
| `late_charge_policies`, `delinquency_policies`, `credit_policies` | Política **tipada e versionada**; o documento fixa a versão por ponteiro |
| `report_lines` + `tenant_account_mappings` | Linha de DRE e base fiscal **por tenant** — o ledger registra o fato, o tenant escolhe a classificação |
| `branches`, `cost_centers` | Dimensões organizacionais |

### Gateway

`payment_provider_accounts` (multi-provedor por tenant), `payment_intents`, `gateway_events` (inbox com `UNIQUE(provider, provider_event_id)` — idempotência é propriedade do banco).

### Views — tudo derivado

| View | Entrega |
|---|---|
| `charge_balances` | total, pago, em aberto, `is_overdue`, `days_overdue`, `source_module` (origem da cobrança — Spec 0017). **`open_amount` é `itens − alocações` e ignora o `status`**: cobrança cancelada continua com `open_amount > 0`; quem decide quem recebe dinheiro precisa filtrar `status = 'open'` |
| `customer_delinquency` | fatos de inadimplência por cliente |
| `deposit_balances`, `customer_credit_balances` | saldos agregados do ledger |
| `vehicle_financial_position` | receita, custo bruto, repassado, `net_result` por veículo |
| `rental_financial_result` | resultado da locação |
| `income_statement` | DRE resolvido pela política vigente na **data do fato** |

Todas usam `LEFT JOIN LATERAL` com subconsulta agregada — nunca `JOIN` irmão seguido de `SUM`. É essa forma que torna inexpressável o fan-out que inflava `vehicle_cost_summary` em 5×.

### RPCs

`post_financial_transaction` (escrita atômica no ledger), `create_rental_with_schedule`, `issue_due_charges` (job diário), `adjust_rental_schedule`, `terminate_rental` (com apuração; desde a Spec 0017 também aplica a distribuição dirigida de caução e crédito na mesma transação que fecha a locação).

## Operações

| Tabela | Função |
|---|---|
| `maintenances` | Manutenções (preventiva e corretiva) |
| `maintenance_items` | Itens padrão de manutenção |
| `maintenance_plans` / `maintenance_plan_items` | Planos preventivos (ADR 0006) |
| `maintenance_records` | Registro enviado pelo cliente, com aprovação |
| `fines` | Multas, com campos de NA/NP (PRD 0013) |
| `fine_attachments` | Anexos da multa |
| `inspections` | Vistorias |
| `inspection_profiles` + `inspection_profile_*_items` | Perfis de vistoria (ADR 0015) |
| `inspection_schedules` | Agendamento de vistoria periódica |

## Controle de acesso

`permission_modules`, `permissions`, `role_permissions` — catálogo global semeado (ADR 0022). Nesta versão é seed sem consumidor em runtime; a autorização efetiva usa `tenant_members.role` e `platform_admins.role`.

## Convenções obrigatórias

Toda tabela nova de domínio precisa de:

- `tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE`
- RLS habilitada + política `tenant_isolation_<tabela>` via `get_user_tenants()`
- Trigger `update_updated_at_column` em `BEFORE UPDATE`
- Identificadores em inglês

Views devem usar `WITH (security_invoker = true)` para herdar o isolamento das tabelas base.

## Workflow

- `pnpm db:reset` — zera e roda o seed (`supabase/seed.sql`)
- `pnpm db:diff <nome>` — gera migration a partir de mudanças no Studio local
- `supabase migration new <nome>` — cria migration vazia

Detalhes em [[Desenvolvimento Local]].

## Tags

`#projeto/banco` `#stack/supabase`
