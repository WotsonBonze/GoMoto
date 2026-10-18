---
status: aprovado
versão: 1.0
modo: lite
autor: Alan (com agente IA)
data: 2026-09-12
prd: "[[PRDs/0014-registro-km-locacao]]"
adr: []
related:
  - "[[Banco de Dados]]"
  - "[[Telas/Locações]]"
tags:
  - spec
  - spec-lite
  - km-locacao
  - locacoes
---

# Spec 0014 — Registro de KM na Locação

> ✅ **Status: implementado** em 2026-09-12. Derivada de [[PRDs/0014-registro-km-locacao]]. Migration aplicada e validada localmente (`pnpm db:reset`, grants conferidos no catálogo — `terminate_rental` ganhou parâmetro novo, exigiu `DROP FUNCTION` + `GRANT EXECUTE` explícito para não deixar overload sem exigência de km vivo, nem `authenticated` sem acesso). Unit tests verdes (`schemas/rentals.spec.ts`, `rules/rentals.spec.ts::minimumFinalKm`, `rules/contract-variables.test.ts` — regressão RF-004). 4 testes E2E novos + toda a suíte de locações/financeiro (62 testes) rodando verde em `locacoes.spec.ts` e nos arquivos que chamavam as RPCs diretamente. Detalhes em [[Telas/Locações]] §"Registro de KM".

> **Por que lite?** Duas colunas novas numa tabela existente (`rentals`), sem entidade nova, sem evento assíncrono, sem decisão arquitetural que exija ADR — extensão direta das duas RPCs atômicas que já existem para criação e encerramento de locação.

---

## 1. Visão Geral Técnica

Duas colunas novas em `rentals` (`km_initial`, `km_final`), preenchidas dentro das duas RPCs atômicas que já existem (`create_rental_with_schedule`, `terminate_rental`) — sem tabela nova, sem endpoint novo. Registrar `km_initial` ou `km_final` também atualiza `vehicles.km_current` (RN-001) e é validado contra o km atual do veículo (RN-002) e um contra o outro (RN-003), tudo dentro da mesma transação da RPC, onde o veículo já é travado (`FOR UPDATE`). O contrato impresso passa a ler `km_inicial` de `rental.km_initial` (congelado na criação) em vez de `vehicle.km_current` (mutável) — isso corrige um bug real: hoje `resolveContractVariables` (`packages/core/src/rules/contract-variables.ts:182`) resolve a variável `km_inicial` a partir do km atual do veículo no momento da (re)impressão, não do km de entrega real (RF-004).

---

## 2. Arquitetura

- `supabase/migrations/<timestamp>_registro_km_locacao.sql` — `ALTER TABLE rentals ADD COLUMN km_initial/km_final` + CHECK de consistência + redefine as duas RPCs abaixo.
- `packages/core/src/schemas/rentals.ts` — `RentalSchema.km_initial` (obrigatório), `TerminateRentalSchema.km_final` (obrigatório).
- `packages/core/src/types/index.ts` — `Rental.km_initial: number | null`, `Rental.km_final: number | null`.
- `packages/core/src/rules/contract-variables.ts` — `ResolveContractVariablesInput.rental` ganha `km_initial`; `km_inicial` passa a resolver de `rental.km_initial` em vez de `vehicle.km_current`.
- `packages/core/src/rules/rentals.ts` — `minimumFinalKm(vehicleKmCurrent, rentalKmInitial)`, função pura (RN-002 + RN-003 combinados), usada pela UI para validação/feedback imediato e espelhada pela RPC como fonte de verdade.
- `apps/web/src/app/(dashboard)/locacoes/actions.ts` — `createRental` passa `km_initial` à RPC; `terminateRental` passa `km_final`; ambas traduzem a exceção `KM_BELOW_MINIMUM` em erro de campo (`VALIDATION_ERROR`), mesmo padrão de `vehicleOverlapMessage`.
- `apps/web/src/app/(dashboard)/locacoes/_components/RentalForm.tsx` — campo "Km inicial" no formulário de criação, pré-preenchido com o km atual do veículo selecionado e editável; entra no payload de `createRental` e na chamada de `resolveContractVariables` usada por "Gerar contrato".
- `apps/web/src/app/(dashboard)/locacoes/_components/TerminateForm.tsx` — campo "Km final" obrigatório, com piso calculado por `minimumFinalKm`; bloqueia "Confirmar Encerramento" enquanto inválido; entra no payload de `terminateRental`.
- `apps/web/src/app/(dashboard)/locacoes/[id]/encerrar/page.tsx` — select estendido para incluir `vehicle.km_current` (necessário para o piso no `TerminateForm`).
- `apps/web/src/app/(dashboard)/locacoes/[id]/(tabs)/_lib/get-rental-core.ts` — `RentalCore` e o select ganham `km_initial`/`km_final`.
- `apps/web/src/app/(dashboard)/locacoes/[id]/(tabs)/page.tsx` — card "Veículo" passa a exibir km inicial, km final e km rodado (RF-003); `—` quando `km_initial`/`km_final` forem `null` (locação anterior a esta feature).
- `apps/web/src/app/(dashboard)/locacoes/[id]/(tabs)/contrato/page.tsx` — objeto `rental` passado a `ContractPreviewPanel` ganha `km_initial: rental.km_initial`.

Fluxo principal: `RentalForm` → `createRental` (action) → RPC `create_rental_with_schedule` (grava `rentals.km_initial`, atualiza `vehicles.km_current`) → `getRentalCore` alimenta o detalhe e a aba de contrato. Encerramento espelha o mesmo caminho via `TerminateForm` → `terminateRental` → RPC `terminate_rental`.

---

## 3. Modelo de Dados

`rentals` já é multi-tenant, com RLS via `get_user_tenants()` e trigger de `updated_at` — por ser tabela existente, só ganha colunas; nenhum requisito novo de tenant/RLS/trigger se aplica.

### 3.1 Mudanças

- `rentals.km_initial INTEGER` (nullable — locações anteriores a esta feature ficam `NULL`).
- `rentals.km_final INTEGER` (nullable — preenchido só no encerramento).
- `CHECK` garantindo `km_final >= km_initial` quando ambos existem.
- `create_rental_with_schedule` (RPC) passa a receber/gravar `km_initial` e validar RN-001/RN-002.
- `terminate_rental` (RPC) passa a receber `p_km_final`, validar RN-001/RN-002/RN-003, e trava o veículo (`FOR UPDATE`) — não travava antes; fecha a mesma janela de corrida que a criação já fecha do lado dela.

**Decisão técnica assumida (o PRD não fala explicitamente disso):** `km_final` passa a ser exigido em **todo** encerramento a partir da implementação desta Spec, inclusive de locações criadas antes dela (sem `km_initial`, portanto `NULL`). Nesses casos o piso vira apenas o km atual do veículo (`km_initial` nulo entra como 0 no `GREATEST`). Não há carve-out para locação legada porque o PRD não pede um.

### 3.2 SQL

```sql
-- supabase/migrations/<timestamp>_registro_km_locacao.sql

ALTER TABLE rentals
  ADD COLUMN IF NOT EXISTS km_initial INTEGER,
  ADD COLUMN IF NOT EXISTS km_final   INTEGER;

ALTER TABLE rentals
  ADD CONSTRAINT rentals_km_final_gte_initial_check
  CHECK (km_final IS NULL OR km_initial IS NULL OR km_final >= km_initial);

COMMENT ON COLUMN rentals.km_initial IS 'PRD 0014: km do veículo na entrega, congelado na criação — fonte do km impresso no contrato (RF-004).';
COMMENT ON COLUMN rentals.km_final   IS 'PRD 0014: km do veículo na devolução, gravado no encerramento.';

-- RN-001 + RN-002: km_initial não pode ser menor que o km atual do veículo;
-- grava e atualiza vehicles.km_current na mesma transação (o veículo já é
-- travado FOR UPDATE NOWAIT por create_rental_with_schedule).
CREATE OR REPLACE FUNCTION create_rental_with_schedule(
  p_tenant_id UUID,
  p_rental    JSONB,
  p_schedule  JSONB
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_rental_id  UUID;
  v_vehicle_id UUID    := (p_rental->>'vehicle_id')::uuid;
  v_km_initial INTEGER := (p_rental->>'km_initial')::integer;
  v_vehicle_km INTEGER;
BEGIN
  SELECT km_current INTO v_vehicle_km FROM vehicles
   WHERE id = v_vehicle_id AND tenant_id = p_tenant_id
     FOR UPDATE NOWAIT;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'VEHICLE_NOT_FOUND';
  END IF;

  IF v_km_initial < COALESCE(v_vehicle_km, 0) THEN
    RAISE EXCEPTION 'KM_BELOW_MINIMUM: minimo=%', COALESCE(v_vehicle_km, 0);
  END IF;

  INSERT INTO rentals (
    tenant_id, customer_id, vehicle_id, start_date, end_date,
    cycle, cycle_amount, due_day, use_pro_rata, contract_type,
    status, observations, contract_template_id,
    checkin_checkout_inspection_profile_id, periodic_inspection_profile_id,
    periodic_inspection_frequency_days, km_initial
  )
  SELECT
    p_tenant_id,
    (p_rental->>'customer_id')::uuid,
    v_vehicle_id,
    (p_rental->>'start_date')::date,
    (p_rental->>'end_date')::date,
    p_rental->>'cycle',
    (p_rental->>'cycle_amount')::numeric,
    (p_rental->>'due_day')::smallint,
    COALESCE((p_rental->>'use_pro_rata')::boolean, false),
    COALESCE(p_rental->>'contract_type', 'rental'),
    'active',
    p_rental->>'observations',
    (p_rental->>'contract_template_id')::uuid,
    (p_rental->>'checkin_checkout_inspection_profile_id')::uuid,
    (p_rental->>'periodic_inspection_profile_id')::uuid,
    (p_rental->>'periodic_inspection_frequency_days')::int,
    v_km_initial
  RETURNING id INTO v_rental_id;

  INSERT INTO rental_billing_schedules (
    tenant_id, rental_id, sequence_number, period_start, period_end, due_date, amount
  )
  SELECT
    p_tenant_id, v_rental_id,
    (item->>'sequence_number')::int, (item->>'period_start')::date,
    (item->>'period_end')::date, (item->>'due_date')::date, (item->>'amount')::numeric
  FROM jsonb_array_elements(p_schedule) AS item;

  UPDATE vehicles SET status = 'rented', km_current = v_km_initial, updated_at = now()
   WHERE id = v_vehicle_id AND tenant_id = p_tenant_id;

  RETURN v_rental_id;
END;
$$;

-- RN-001 + RN-002 + RN-003: km_final não pode ser menor que o km atual do
-- veículo NEM menor que o km_initial da própria locação. Passa a travar o
-- veículo FOR UPDATE (não travava antes) para fechar a mesma janela de corrida
-- que create_rental_with_schedule já fecha do lado da criação.
CREATE OR REPLACE FUNCTION terminate_rental(
  p_tenant_id        UUID,
  p_rental_id        UUID,
  p_termination_date DATE,
  p_new_status       TEXT    DEFAULT 'closed',
  p_force            BOOLEAN DEFAULT false,
  p_km_final         INTEGER DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_vehicle_id   UUID;
  v_customer_id  UUID;
  v_km_initial   INTEGER;
  v_vehicle_km   INTEGER;
  v_km_minimum   INTEGER;
  v_open_amount  NUMERIC(14,2);
  v_open_count   INT;
  v_deposit      NUMERIC(14,2);
  v_credit       NUMERIC(14,2);
  v_cancelled    INT;
BEGIN
  SELECT vehicle_id, customer_id, km_initial INTO v_vehicle_id, v_customer_id, v_km_initial
    FROM rentals
   WHERE id = p_rental_id AND tenant_id = p_tenant_id AND status = 'active';

  IF v_vehicle_id IS NULL THEN
    RAISE EXCEPTION 'RENTAL_NOT_ACTIVE';
  END IF;

  IF p_km_final IS NULL THEN
    RAISE EXCEPTION 'KM_FINAL_REQUIRED';
  END IF;

  SELECT km_current INTO v_vehicle_km FROM vehicles
   WHERE id = v_vehicle_id AND tenant_id = p_tenant_id
     FOR UPDATE;

  v_km_minimum := GREATEST(COALESCE(v_vehicle_km, 0), COALESCE(v_km_initial, 0));
  IF p_km_final < v_km_minimum THEN
    RAISE EXCEPTION 'KM_BELOW_MINIMUM: minimo=%', v_km_minimum;
  END IF;

  SELECT COALESCE(SUM(open_amount), 0), COUNT(*)
    INTO v_open_amount, v_open_count
    FROM charge_balances
   WHERE rental_id = p_rental_id AND status = 'open' AND open_amount > 0;

  SELECT COALESCE(balance, 0) INTO v_deposit FROM deposit_balances WHERE rental_id = p_rental_id;
  v_deposit := COALESCE(v_deposit, 0);

  SELECT COALESCE(balance, 0) INTO v_credit
    FROM customer_credit_balances WHERE tenant_id = p_tenant_id AND customer_id = v_customer_id;
  v_credit := COALESCE(v_credit, 0);

  IF v_open_amount > 0 AND NOT p_force THEN
    RAISE EXCEPTION 'RENTAL_HAS_OPEN_CHARGES: % cobrança(s), total %', v_open_count, v_open_amount
      USING ERRCODE = 'check_violation';
  END IF;

  UPDATE rental_billing_schedules
     SET status = 'cancelled', updated_at = now()
   WHERE tenant_id = p_tenant_id AND rental_id = p_rental_id
     AND status = 'scheduled' AND period_start > p_termination_date;
  GET DIAGNOSTICS v_cancelled = ROW_COUNT;

  UPDATE rentals
     SET status = p_new_status, end_date = p_termination_date, km_final = p_km_final, updated_at = now()
   WHERE id = p_rental_id AND tenant_id = p_tenant_id;

  UPDATE vehicles
     SET status = 'available', km_current = p_km_final, updated_at = now()
   WHERE id = v_vehicle_id AND tenant_id = p_tenant_id;

  RETURN jsonb_build_object(
    'rental_id', p_rental_id, 'customer_id', v_customer_id,
    'open_amount', v_open_amount, 'open_charges', v_open_count,
    'deposit_balance', v_deposit, 'credit_balance', v_credit,
    'cancelled_schedules', v_cancelled,
    'requires_settlement', v_deposit > 0 OR v_open_amount > 0 OR v_credit > 0
  );
END;
$$;
```

---

## 4. APIs

Sem endpoint HTTP novo — mutações via Server Actions (ADR 0002), como o resto do módulo de locações.

### 4.1 Server Actions

- `createRental` (`apps/web/src/app/(dashboard)/locacoes/actions.ts`) — payload ganha `km_initial`; chama `create_rental_with_schedule` com o novo campo; traduz `KM_BELOW_MINIMUM` em `VALIDATION_ERROR` no campo `km_initial`.
- `terminateRental` (mesmo arquivo) — payload ganha `km_final`; chama `terminate_rental` com `p_km_final`; traduz `KM_BELOW_MINIMUM`/`KM_FINAL_REQUIRED` em `VALIDATION_ERROR` no campo `km_final`.

### 4.2 Schema Zod

```ts
// packages/core/src/schemas/rentals.ts
export const RentalSchema = z.object({
  // ...campos existentes
  km_initial: z.number().int().nonnegative({ error: 'Km inicial inválido' }),
})

export const TerminateRentalSchema = z.object({
  // ...campos existentes
  km_final: z.number().int().nonnegative({ error: 'Km final inválido' }),
})
```

```ts
// packages/core/src/rules/rentals.ts
/** RN-002 + RN-003: piso do km final — o maior entre o km atual do veículo e o km inicial da locação. */
export function minimumFinalKm(vehicleKmCurrent: number, rentalKmInitial: number): number {
  return Math.max(vehicleKmCurrent, rentalKmInitial)
}
```

```ts
// apps/web/src/app/(dashboard)/locacoes/actions.ts — mesmo padrão de vehicleOverlapMessage()
function kmBelowMinimumMessage(raw: string, field: 'km_initial' | 'km_final') {
  const minimo = raw.split('minimo=')[1]?.trim()
  return {
    code: 'VALIDATION_ERROR' as const,
    field,
    message: minimo
      ? `Km não pode ser menor que ${Number(minimo).toLocaleString('pt-BR')} (km atual do veículo).`
      : 'Km informado é menor que o mínimo aceito.',
  }
}
```

### 4.3 Erros relevantes

- `VALIDATION_ERROR` (campo `km_initial` ou `km_final`) — km abaixo do mínimo aceito (RN-002/RN-003), ou campo ausente (RN-004). Nenhum código novo entra no `ErrorCode` union.

---

## 5. Segurança

- **AuthN:** inalterado — Server Action exige sessão (`supabase.auth.getUser()`).
- **AuthZ:** inalterado — `getCurrentTenantId(supabase)` resolvido server-side; as RPCs filtram por `tenant_id` internamente.
- **RLS:** inalterado — `rentals`/`vehicles` já têm política via `get_user_tenants()`; colunas novas em tabela existente não pedem política nova.

---

## 6. Test Strategy

- **Unit (Vitest, `packages/core`):**
  - `schemas/rentals.spec.ts` — `RentalSchema` rejeita payload sem `km_initial`; `TerminateRentalSchema` rejeita payload sem `km_final`.
  - `rules/rentals.spec.ts` — `minimumFinalKm` retorna o maior dos dois valores (veículo > locação, locação > veículo, empate).
  - `rules/contract-variables.test.ts` — regressão de RF-004: com `vehicle.km_current` diferente de `rental.km_initial`, `resolveContractVariables().km_inicial` usa o valor da locação, não o do veículo.
- **E2E (Playwright, `apps/web/tests/locacoes.spec.ts`):** fluxo cobrindo criação com km inicial → detalhe exibe km inicial → encerramento com km final → detalhe exibe km final e km rodado; mais um caso de erro (km final abaixo do piso é recusado com mensagem visível, encerramento não conclui).

Integration/Contract: N/A no modo lite.

---

## 7. Deploy e Rollback

Migration aplicada antes do deploy do app (padrão do projeto: `pnpm db:reset` local para validar → `supabase db push` em produção, só com aprovação humana explícita). Rollback seguro: nenhuma coluna nova é `NOT NULL`, então uma migration reversa que restaura as duas RPCs às versões anteriores e (opcionalmente) dropa `km_initial`/`km_final` não perde dado de nenhuma outra feature — as linhas voltam a não ter km registrado, como eram antes desta Spec.

---

## 8. Matriz de Rastreabilidade e Aprovação

### 8.1 Matriz

Cobertura **obrigatória 100%** dos RF/RNF/RN do PRD [[PRDs/0014-registro-km-locacao]].

| PRD Item | Descrição curta | Seção(ões) da Spec | Cobertura de Testes |
|---|---|---|---|
| RF-001 | Registrar km inicial na criação | §2, §3 (`create_rental_with_schedule`), §4.2 (`RentalSchema.km_initial`) | E2E: `locacoes.spec.ts::cria locação com km inicial` |
| RF-002 | Registrar km final no encerramento | §2, §3 (`terminate_rental`), §4.2 (`TerminateRentalSchema.km_final`) | E2E: `locacoes.spec.ts::encerra locação com km final` |
| RF-003 | Exibir km inicial, km final e km rodado no detalhe | §2 (`(tabs)/page.tsx`, `get-rental-core.ts`) | E2E: `locacoes.spec.ts::detalhe exibe km inicial, final e rodado` |
| RF-004 | Km inicial da locação é a fonte do km impresso no contrato | §2, §3 (coluna `rentals.km_initial`), §2 (`contract-variables.ts`) | Unit: `contract-variables.test.ts::km_inicial usa rental.km_initial` |
| RN-001 | Registrar km atualiza `vehicles.km_current` | §3 (`UPDATE vehicles SET km_current = ...` nas duas RPCs) | Coberto pelos E2E de RF-001/RF-002 (o card do veículo reflete o novo km) |
| RN-002 | Km não pode ser menor que o km atual do veículo | §3 (`KM_BELOW_MINIMUM` nas duas RPCs) | Unit: `rentals.spec.ts::minimumFinalKm`; E2E: caso de erro |
| RN-003 | Km final nunca menor que o km inicial da locação | §3 (CHECK `rentals_km_final_gte_initial_check` + `GREATEST` na RPC) | Unit: `rentals.spec.ts::minimumFinalKm`; E2E: caso de erro |
| RN-004 | Km inicial/final obrigatórios para concluir criação/encerramento | §4.2 (`RentalSchema.km_initial`, `TerminateRentalSchema.km_final` sem `.optional()`) | Unit: `schemas/rentals.spec.ts` — rejeita payload sem o campo |

Cobertura: 8/8 itens do PRD (100%).

### 8.2 Checklist de aprovação

- [x] Sem `<!-- preencher -->` remanescente
- [x] Campo novo em `rentals` (tabela existente) preserva `tenant_id` + RLS + trigger `updated_at` já existentes na tabela
- [x] Matriz §8.1 cobre 100% dos itens do PRD
- [x] Sem anti-padrões (`actions.ts` morto, `createClient()` em `page.tsx`, lógica em UI handler, Zod duplicado)

**Aprovado por:** Alan em 2026-09-12
