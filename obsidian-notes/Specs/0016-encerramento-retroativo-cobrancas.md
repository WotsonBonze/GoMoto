---
status: aprovado
versão: 1.1
modo: lite
autor: Alan (com agente IA)
data: 2026-09-17
prd: "[[PRDs/0016-encerramento-retroativo-cobrancas]]"
related:
  - "[[decisions/0035-ajuste-de-periodo-da-locacao]]"
  - "[[decisions/0033-dinheiro-para-cobranca-cancelada]]"
  - "[[Telas/Locações]]"
  - "[[Banco de Dados]]"
tags:
  - spec
  - spec-lite
  - encerramento-retroativo-cobrancas
  - locacoes
---

# Spec 0016 — Encerramento retroativo de contrato com decisão sobre cobranças já emitidas

> 🟢 **Status: aprovado** (modo lite) em 2026-09-17, **revisado no mesmo dia** (v1.1) durante a implementação — ver PRD v1.1. Implementado, testado (unit + E2E) e verificado no navegador.

> **Ajuste de UI (2026-09-18):** a lista "Dentro do período" só exibe linha `keep_optional` — `keep_locked` (já paga ou com crédito aplicado) some da tela: nada a decidir ali, e mostrar só poluía a lista com o que já está resolvido. A classificação (`planRetroactiveTermination`) e o contrato de banco não mudam — é filtro só no `insidePeriod` de `TerminateForm.tsx`.

> **Por que lite?** Toca uma única tela (Encerrar contrato), reaproveita uma capacidade já existente (`cancelCharge`, ADR 0035), sem entidade nova.

---

## 1. Visão Geral Técnica

A tela de encerramento (`/locacoes/[id]/encerrar`) passa a classificar TODA linha viva do cronograma — vencida, emitida ou ainda planejada — em duas listas:

- **Fora do período** (período de referência posterior à data de encerramento): **sempre cancelada**, sem escolha do operador — emitida ou não. Exceção: cobrança com valor já reduzido (pagamento/crédito) fica **bloqueada**, sinalizada para tratamento à parte (RN-001).
- **Dentro do período**: **mantida por padrão**, com opção de o operador cancelar mesmo assim — capacidade nova, vale tanto para cobrança emitida quanto para parcela ainda não emitida.

Hoje a RPC `terminate_rental` só cancelava parcelas do cronograma ainda **não** emitidas (`rental_billing_schedules.status = 'scheduled'`) que caíssem fora do período; cobrança emitida nunca era tocada, e nenhuma linha dentro do período podia ser cancelada por opção. A feature reaproveita `cancelCharge` (`apps/web/src/lib/financial/charges.ts`) — a mesma função que `adjustRentalPeriod` já usa (ADR 0035) para cancelar cobrança emitida com reversão no razão. Sem tabela nova, sem mudança de modelo financeiro: orquestração nova na Server Action + UI, e uma extensão da RPC `terminate_rental` (novo parâmetro) para aceitar o cancelamento opcional de linha ainda não emitida dentro do período e para manter `rental_billing_schedules` consistente com toda cobrança cancelada.

---

## 2. Arquitetura

- `packages/core/src/schemas/rentals.ts` — `TerminateRentalSchema` ganha `extra_charge_ids_to_cancel` e `extra_schedule_line_ids_to_cancel` (ambos `z.array(z.string().uuid()).optional().default([])`) — só o cancelamento OPCIONAL de algo que sobreviveria por padrão (dentro do período). Fora do período não entra no payload: é automático.
- `packages/core/src/rules/schedule.ts` — `planRetroactiveTermination(lines, charges, terminationDate)`, função pura que classifica cada linha em `cancel_auto` (fora, elegível), `blocked` (fora, valor reduzido), `keep_optional` (dentro, elegível) ou `keep_locked` (dentro, valor reduzido). A MESMA função alimenta a prévia da tela e a revalidação server-side da action — mesmo princípio de `planPeriodAdjustment` (ADR 0035): prévia e persistência não podem divergir. Tipo `TerminationChargeInfo` carrega `is_overdue` (de `charge_balances`, via `fn_business_today` — nunca o relógio do browser).
- `packages/data` — hook `useRentalTerminationPlan(rentalId, terminationDate)` (`hooks/useLedger.ts`), combinando `listRentalSchedule` (todas as linhas) + novo `listRentalIssuedChargeInfo` (`repositories/ledger.ts`, cobranças emitidas + saldo + `is_overdue`) através de `planRetroactiveTermination`.
- `apps/web/src/app/(dashboard)/locacoes/_components/TerminateForm.tsx` — duas seções: "Fora do período — serão canceladas" (informativa, sem controles) e "Dentro do período" (toggle Manter/Cancelar por linha + atalho "cancelar todas elegíveis"). `openCharges` é filtrado uma vez, na origem, por tudo que será cancelado (automático + opcional) — RF-004 se propaga sozinho para caução/crédito/multa/botão de confirmar.
- `apps/web/src/app/(dashboard)/locacoes/_lib/termination-plan.ts` (**novo**, espelha `period-adjustment.ts`) — `loadTerminationPlan`, recarrega o mesmo plano no servidor; a action nunca confia nos ids "extra" vindos do client.
- `apps/web/src/app/(dashboard)/locacoes/actions.ts::terminateRental` — recarrega o plano no servidor, valida que todo id "extra" recebido é realmente `keep_optional`, cancela via `cancelCharge` toda `cancel_auto` + o que foi validado como extra (sequencial; aborta sem chamar a RPC se uma falhar), e passa as linhas planejadas extras (dentro do período) num novo parâmetro da RPC.
- `supabase/migrations/20260918005335_encerramento_cancela_cobranca_emitida.sql` — `terminate_rental` ganha o parâmetro `p_extra_schedule_line_ids_to_cancel UUID[] DEFAULT NULL` e duas mudanças no corpo (§3).

**Fluxo principal:**
1. **UI** — operador escolhe data retroativa → hook classifica toda linha viva → seção "fora" é só informativa → seção "dentro" permite marcar (individual ou "cancelar todas elegíveis") → `openAmount` recalculado no client excluindo tudo que será cancelado (RF-004).
2. **Server Action** `terminateRental` — valida Zod → recarrega o plano no servidor e rejeita qualquer id "extra" que não seja `keep_optional` → cancela cada cobrança (`cancel_auto` + extras validados) via `cancelCharge` (sequencial; se uma falhar, aborta **sem** chamar a RPC) → chama `terminate_rental` com as linhas planejadas extras → `logAction` por cobrança cancelada + pelo encerramento → `revalidatePath`.
3. **DB** — `charges.status='cancelled'` + reversão no razão (via `cancelCharge`) → `rental_billing_schedules.status='cancelled'` para toda linha fora do período (automático, inalterado) + linha emitida cuja cobrança foi cancelada (qualquer período) + linha planejada extra dentro do período (novo parâmetro) → `rentals` fecha, veículo libera (inalterado).

---

## 3. Modelo de Dados

**Sem tabela nova, sem coluna nova.** Único ajuste de schema: `terminate_rental` ganha um parâmetro — **assinatura muda**, por isso a migration faz `DROP FUNCTION` explícito da assinatura antiga antes de recriar, e reafirma `GRANT` (documentado na própria migration `20260917005041_emissao_escopada_por_linha`: `CREATE OR REPLACE` só preserva grant quando a lista de tipos de parâmetro não muda; sem o DROP, a nova assinatura nasceria como um SEGUNDO overload com `EXECUTE` liberado a `PUBLIC` por padrão).

### 3.1 Mudanças

1. Novo parâmetro `p_extra_schedule_line_ids_to_cancel UUID[] DEFAULT NULL`.
2. A `UPDATE` que cancela linha `scheduled` fora do período passa a também cancelar as linhas cujo id está nesse array (dentro do período, opcional).
3. A `UPDATE` que sincroniza linha `issued` com cobrança cancelada perde a restrição `period_start > p_termination_date` — agora cobre qualquer cobrança cancelada, dentro ou fora do período.

### 3.2 SQL

```sql
-- Migration: supabase/migrations/20260918005335_encerramento_cancela_cobranca_emitida.sql

DROP FUNCTION IF EXISTS terminate_rental(UUID, UUID, DATE, TEXT, BOOLEAN, INTEGER, BOOLEAN, NUMERIC, NUMERIC);

CREATE FUNCTION terminate_rental(
  p_tenant_id           UUID,
  p_rental_id           UUID,
  p_termination_date    DATE,
  p_new_status          TEXT    DEFAULT 'closed',
  p_force               BOOLEAN DEFAULT false,
  p_km_final            INTEGER DEFAULT NULL,
  p_charge_fine         BOOLEAN DEFAULT false,
  p_fine_deposit_amount NUMERIC DEFAULT 0,
  p_fine_credit_amount  NUMERIC DEFAULT 0,
  p_extra_schedule_line_ids_to_cancel UUID[] DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  -- ... todas as variáveis existentes, inalteradas ...
BEGIN
  -- ... tudo igual até a UPDATE de linhas 'scheduled' ...

  -- Fora do período: sempre. Dentro do período: só a marcada por opção.
  UPDATE rental_billing_schedules
     SET status = 'cancelled', updated_at = now()
   WHERE tenant_id = p_tenant_id
     AND rental_id = p_rental_id
     AND status    = 'scheduled'
     AND (
       period_start > p_termination_date
       OR id = ANY(COALESCE(p_extra_schedule_line_ids_to_cancel, ARRAY[]::UUID[]))
     );

  GET DIAGNOSTICS v_cancelled = ROW_COUNT;

  -- Cobrança emitida cancelada (automática ou por opção) chega aqui com
  -- `charges.status='cancelled'`. A linha do cronograma acompanha, dentro ou
  -- fora do período — o discriminador é "esta cobrança foi cancelada", não a
  -- data.
  UPDATE rental_billing_schedules rbs
     SET status = 'cancelled', updated_at = now()
    FROM charges c
   WHERE rbs.tenant_id    = p_tenant_id
     AND rbs.rental_id    = p_rental_id
     AND rbs.status       = 'issued'
     AND c.tenant_id      = p_tenant_id
     AND c.source_module  = 'rental'
     AND c.source_id      = rbs.id
     AND c.status         = 'cancelled';

  GET DIAGNOSTICS v_cancelled_issued = ROW_COUNT;
  v_cancelled := v_cancelled + v_cancelled_issued;

  -- ... resto do corpo inalterado (UPDATE rentals, UPDATE vehicles, RETURN) ...
END;
$$;

REVOKE EXECUTE ON FUNCTION terminate_rental(UUID, UUID, DATE, TEXT, BOOLEAN, INTEGER, BOOLEAN, NUMERIC, NUMERIC, UUID[]) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION terminate_rental(UUID, UUID, DATE, TEXT, BOOLEAN, INTEGER, BOOLEAN, NUMERIC, NUMERIC, UUID[]) TO authenticated, service_role;
```

Verificado no catálogo após `pnpm db:reset`: só existe a assinatura de 10 parâmetros; `authenticated`/`service_role` com `EXECUTE`, `anon` sem.

---

## 4. APIs

### 4.1 Endpoint(s)

Sem endpoint HTTP novo. Server Action existente `terminateRental` (`apps/web/src/app/(dashboard)/locacoes/actions.ts`) ganha dois campos de payload.

### 4.2 Schema Zod

```ts
// packages/core/src/schemas/rentals.ts
export const TerminateRentalSchema = z.object({
  lease_id:         z.string().uuid(),
  termination_date: dateString,
  new_status:       z.enum(['closed', 'transferred']).default('closed'),
  force:            z.boolean().optional().default(false),
  km_final:         z.number().int().nonnegative({ error: 'Km final inválido' }),
  charge_fine:          z.boolean().optional().default(false),
  fine_deposit_amount:  z.number().min(0).optional().default(0),
  fine_credit_amount:   z.number().min(0).optional().default(0),
  // Spec 0016 (revisão): cancelamento OPCIONAL de algo que sobreviveria por
  // padrão (dentro do período). Fora do período é automático — não entra aqui.
  extra_charge_ids_to_cancel:        z.array(z.string().uuid()).optional().default([]),
  extra_schedule_line_ids_to_cancel: z.array(z.string().uuid()).optional().default([]),
}).refine(/* ...refinamentos existentes, inalterados... */)
```

### 4.3 Erros relevantes

| Código | Quando |
|---|---|
| `VALIDATION_ERROR` | Zod falha |
| `UNAUTHORIZED` | sem sessão/tenant |
| `CHARGE_NOT_ELIGIBLE_FOR_TERMINATION` | `cancelCharge` recusa por `paid_amount > 0` — pagamento **ou** crédito aplicado (RF-003, CA-003, CA-006) |
| `TERMINATION_ITEM_NOT_CANDIDATE` | um id "extra" (charge ou schedule line) não corresponde a uma linha `keep_optional` no plano recarregado no servidor — defesa contra payload adulterado |
| `RENTAL_NOT_ACTIVE`, `RENTAL_HAS_OPEN_CHARGES`, ... | inalterados — nota: cobrança cancelada (automática ou extra) já sai de `charge_balances.status='open'` **antes** dessa checagem, porque é cancelada antes da RPC rodar |

---

## 5. Segurança

- **AuthN:** Supabase Auth — `terminateRental` exige sessão, igual hoje.
- **AuthZ:** `getCurrentTenantId(supabase)` server-side; RLS em `charges`/`rental_billing_schedules`/`rentals` via `get_user_tenants()` já isola por tenant. Nenhuma role nova — mesma persona Operador.
- **RLS:** sem tabela nova, políticas herdadas.
- Validação adicional: a action nunca chama `cancelCharge`, nem passa um schedule line id à RPC, para algo que não seja `cancel_auto` (automático) ou `keep_optional` validado no plano recarregado no servidor — RN-002 aplicado como autorização de dado, não só como filtro de UI.
- **`terminate_rental` mudou de assinatura** — migration reafirma `GRANT EXECUTE` para `authenticated`/`service_role` e `REVOKE` de `PUBLIC`/`anon` explicitamente (§3), conferido no catálogo (`has_function_privilege`), não só na migration.
- **Risco herdado, não introduzido por esta feature:** `cancelCharge` lê `charge_balances.paid_amount` (SELECT) e só depois faz o `UPDATE` de status — não é uma única instrução atômica. Uma corrida entre essa leitura e um pagamento/crédito chegando no meio (webhook, outro operador) poderia, em teoria, cancelar uma cobrança que acabou de deixar de ser elegível. Essa exposição já existe hoje em `adjustRentalPeriod` e não piora com este PRD — registro aqui para decisão consciente, não bloqueia esta Spec.

---

## 6. Test Strategy

- **Unit (Vitest, `packages/core`):** `packages/core/src/rules/schedule.spec.ts::planRetroactiveTermination` (8 casos) — fora do período elegível vira `cancel_auto` (emitida ou planejada); fora do período com pagamento ou com crédito vira `blocked`; dentro do período elegível vira `keep_optional` (emitida ou planejada); dentro do período com valor reduzido vira `keep_locked`; `is_overdue` passa direto da cobrança; linha emitida sem cobrança correspondente não quebra; linha já `cancelled`/`superseded` não aparece no plano.
- **E2E (Playwright, `apps/web/tests/encerramento-retroativo-cobrancas.spec.ts`, 8 casos):** fora do período — cobrança emitida elegível é cancelada sem marcação (RN-002); linha planejada fora do período é cancelada pela própria RPC; cobrança com pagamento fica bloqueada, não cancelada automaticamente (RN-001/RF-003). Dentro do período — cobrança emitida elegível é mantida por padrão sem marcação nenhuma (RF-002); cobrança emitida marcada por opção é cancelada e a linha acompanha; linha planejada marcada por opção é cancelada via o novo parâmetro da RPC; cobrança com pagamento fica `keep_locked`, sem opção de marcação (RN-001). Suítes vizinhas (`multa-rescisao-antecipada.spec.ts`, `ajuste-de-periodo.spec.ts`, `billings-rentals.spec.ts`) rodadas para confirmar que a mudança de assinatura de `terminate_rental` não quebrou nenhum chamador existente — todas verdes.

Integration/Contract: N/A no modo lite.

---

## 7. Deploy e Rollback

Migration primeiro (`DROP FUNCTION` + `CREATE FUNCTION` + `GRANT`, dentro de uma transação — Postgres aplica migrations do Supabase CLI de forma transacional) → deploy do app. Rollback: nova migration restaurando a assinatura e o corpo anteriores (9 parâmetros), com o mesmo cuidado de `DROP` + `GRANT` explícito. Frontend e Server Action podem ser revertidos independentemente da migration, pois os dois campos novos são opcionais com default `[]` — mas **não** o inverso: a migration exige que o app já envie (ou omita) os campos corretos, já que a assinatura da função mudou.

---

## 8. Matriz de Rastreabilidade e Aprovação

### 8.1 Matriz

| PRD Item | Descrição curta | Seção(ões) da Spec | Cobertura de Testes |
|---|---|---|---|
| RF-001 | Sistema identifica e divide toda cobrança viva entre dentro e fora do período | §2 (`planRetroactiveTermination`, hook), §3 | Unit: `schedule.spec.ts` (7 casos de classificação); E2E: todos os 8 casos |
| RF-002 | Cobrança fora do período é sempre cancelada, sem escolha do operador | §2 (`action==='cancel_auto'`), §3 (SQL) | Unit: `::fora do período e elegível: cancel_auto`; E2E: `::cobrança emitida elegível é sempre cancelada, sem marcação alguma`, `::linha ainda não emitida é cancelada pela própria RPC` |
| RF-003 | Cobrança com valor já reduzido nunca é cancelada por este fluxo | §2 (`action==='blocked'`/`'keep_locked'`), §4.3 (`CHARGE_NOT_ELIGIBLE_FOR_TERMINATION`) | Unit: `::blocked` (pagamento e crédito), `::keep_locked`; E2E: `::fica bloqueada`, `::fica keep_locked` |
| RF-004 | Apuração financeira reflete todo cancelamento antes da confirmação | §2 (`TerminateForm` filtra `openCharges` na origem) | E2E: verificado via `somaAberto`/`settlement.open_amount` em todos os casos de cancelamento; visual no navegador |
| RF-005 | Operador pode cancelar, por opção, cobrança dentro do período | §2 (`action==='keep_optional'`, toggle Manter/Cancelar, atalho) | Unit: `::keep_optional`; E2E: `::marcada por opção é cancelada` (emitida e planejada) |
| RN-001 | Cobrança reduzida é imune, dentro ou fora do período, inclusive no atalho em lote | §2, §5 | Unit: `::blocked`/`::keep_locked` (pagamento e crédito); E2E: `::fica bloqueada`, `::fica keep_locked` |
| RN-002 | Período de referência decide dentro/fora; automático de um lado, opcional do outro | §2 (função pura), §3 (SQL) | Unit: `::cancel_auto`/`::keep_optional` conforme `is_outside_period` |
| RN-003 | Cancelamento é integral, nunca parcial | §2 (`cancelCharge` reaproveitado sem alteração) | N/A — comportamento herdado de `cancelCharge`, já coberto pelos testes de `ajuste-de-periodo.spec.ts` |

### 8.2 Checklist de aprovação

- [x] Sem `<!-- preencher -->` remanescente
- [x] Nenhuma tabela/coluna nova — §3 documenta apenas extensão de função existente (com `DROP`+`GRANT` por mudança de assinatura)
- [x] Matriz §8.1 cobre 100% dos itens do PRD (RF-001 a RF-005, RN-001 a RN-003)
- [x] Sem anti-padrões (`actions.ts` morto, `createClient()` em `page.tsx`, lógica em UI, Zod duplicado)
- [x] Implementado, testado (16 unit + 8 E2E novos, todos verdes; suítes vizinhas sem regressão) e verificado no navegador

**Aprovado por:** Alan em 2026-09-17
