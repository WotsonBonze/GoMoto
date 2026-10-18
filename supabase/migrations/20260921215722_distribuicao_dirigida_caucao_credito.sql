-- ---------------------------------------------------------------------------
-- Distribuição dirigida de caução e crédito no encerramento (Spec 0017)
-- ---------------------------------------------------------------------------
-- O acerto do encerramento (ADR 0026) abatia caução e crédito de forma
-- AGREGADA: o operador escolhia um valor único e duas Server Actions
-- (`closeRentalFinancial`, `applyCreditToRentalDebt`) o espalhavam pelas
-- cobranças abertas, da mais antiga para a mais nova, DEPOIS de
-- `terminate_rental` já ter fechado a locação. Duas consequências:
--
--   1. O operador não escolhia qual dívida era quitada com o dinheiro do
--      cliente (o abatimento era cego).
--   2. Nada era atômico: se a terceira chamada falhasse, as duas primeiras já
--      estavam commitadas e a locação já estava fechada.
--
-- Agora o operador informa, dívida a dívida, quanto de caução e quanto de
-- crédito aplicar — e a distribuição inteira roda DENTRO desta função, na
-- mesma transação que trava a locação, cria a multa e a fecha. Qualquer
-- `RAISE EXCEPTION` no meio (dívida que mudou de estado, saldo que acabou)
-- reverte TUDO: a locação nem chega a fechar (PRD 0017, RN-006).
--
-- Nenhuma regra financeira nova: cada alocação é uma chamada às mesmas
-- `fn_retain_deposit_on_charge` / `fn_apply_customer_credit` que já guardam
-- saldo e dívida sob trava do cliente (ADR 0026). O que esta migration
-- acrescenta é a ORQUESTRAÇÃO dentro da transação e uma guarda que essas duas
-- funções não têm (ver CHARGE_NOT_IN_RENTAL, abaixo).
--
-- ASSINATURA MUDA (3 parâmetros a mais) — `DROP FUNCTION` explícito antes de
-- recriar, e GRANT reafirmado no final. `CREATE OR REPLACE` só preserva grant
-- quando a lista de tipos de parâmetro não muda (documentado na migration
-- `20260917005041_emissao_escopada_por_linha`); sem o DROP, a assinatura nova
-- nasceria como um SEGUNDO overload, com EXECUTE liberado a PUBLIC por padrão.

-- ---------------------------------------------------------------------------
-- 1. charge_balances ganha `source_module` (RF-001)
-- ---------------------------------------------------------------------------
-- A lista de dívidas da tela precisa dizer de onde cada uma vem (ciclo, multa,
-- entrada, despesa rateada). `charges.source_module` já é NOT NULL desde
-- `charge_single_origin`; só não estava exposto na view. Apenso ao FINAL da
-- lista de colunas: `CREATE OR REPLACE VIEW` não permite reordenar nem remover
-- as existentes.

CREATE OR REPLACE VIEW charge_balances WITH (security_invoker = true) AS
SELECT c.id AS charge_id,
    c.tenant_id,
    c.customer_id,
    c.rental_id,
    c.charge_number,
        CASE
            WHEN c.status = ANY (ARRAY['cancelled'::charge_status, 'written_off'::charge_status]) THEN c.status
            WHEN (COALESCE(i.total, 0::numeric) - COALESCE(a.allocated, 0::numeric)) <= 0::numeric THEN 'paid'::charge_status
            ELSE 'open'::charge_status
        END AS status,
    c.issue_date,
    c.due_date,
    c.currency,
    COALESCE(i.total, 0::numeric) AS total_amount,
    COALESCE(a.allocated, 0::numeric) AS paid_amount,
    COALESCE(i.total, 0::numeric) - COALESCE(a.allocated, 0::numeric) AS open_amount,
    (c.status <> ALL (ARRAY['cancelled'::charge_status, 'written_off'::charge_status]))
      AND COALESCE(i.total, 0::numeric) > COALESCE(a.allocated, 0::numeric)
      AND c.due_date < fn_business_today(c.tenant_id) AS is_overdue,
    GREATEST(0, fn_business_today(c.tenant_id) - c.due_date) AS days_overdue,
    c.late_charge_policy_id,
    COALESCE(l.late_charge, 0::numeric) AS late_charge_amount,
    c.source_module
   FROM charges c
     LEFT JOIN LATERAL ( SELECT sum(ci.amount) AS total
           FROM charge_items ci
          WHERE ci.charge_id = c.id) i ON true
     LEFT JOIN LATERAL ( SELECT sum(pa.amount) AS allocated
           FROM payment_allocations pa
             JOIN payments p ON p.id = pa.payment_id
          WHERE pa.charge_id = c.id AND p.reversed_at IS NULL) a ON true
     LEFT JOIN LATERAL ( SELECT sum(ci.amount) AS late_charge
           FROM charge_items ci
          WHERE ci.charge_id = c.id
            AND ci.source_module = 'late_charge') l ON true;

-- ---------------------------------------------------------------------------
-- 2. terminate_rental — distribuição dirigida (RF-003 a RF-010)
-- ---------------------------------------------------------------------------

DROP FUNCTION IF EXISTS terminate_rental(UUID, UUID, DATE, TEXT, BOOLEAN, INTEGER, BOOLEAN, NUMERIC, NUMERIC, UUID[]);

CREATE FUNCTION terminate_rental(
  p_tenant_id           UUID,
  p_rental_id           UUID,
  p_termination_date    DATE,
  p_new_status          TEXT    DEFAULT 'closed',
  p_force               BOOLEAN DEFAULT false,
  p_km_final            INTEGER DEFAULT NULL,
  p_charge_fine         BOOLEAN DEFAULT false,   -- Spec 0015 (RF-004)
  p_fine_deposit_amount NUMERIC DEFAULT 0,       -- Spec 0015 (RF-006)
  p_fine_credit_amount  NUMERIC DEFAULT 0,       -- Spec 0015 (RF-006)
  p_extra_schedule_line_ids_to_cancel UUID[] DEFAULT NULL,  -- Spec 0016
  -- Spec 0017: distribuição dirigida, dívida a dívida. Cada elemento é
  -- {"charge_id": uuid, "amount": numeric}. A multa NÃO entra aqui — o
  -- charge_id dela só existe depois de criada, logo abaixo; ela continua
  -- usando p_fine_deposit_amount / p_fine_credit_amount.
  p_deposit_allocations JSONB DEFAULT '[]',
  p_credit_allocations  JSONB DEFAULT '[]',
  -- Motivo ÚNICO para toda a distribuição de caução desta chamada (ADR 0026):
  -- explica ao cliente por que o dinheiro dele virou pagamento.
  p_deposit_reason      TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_vehicle_id       UUID;
  v_customer_id      UUID;
  v_km_initial       INTEGER;
  v_vehicle_km       INTEGER;
  v_km_minimum       INTEGER;
  v_open_amount      NUMERIC(14,2);
  v_open_count       INT;
  v_deposit          NUMERIC(14,2);
  v_credit           NUMERIC(14,2);
  v_deposit_after    NUMERIC(14,2);
  v_credit_after     NUMERIC(14,2);
  v_cancelled        INT;
  v_cancelled_issued INT;
  v_start_date       DATE;
  v_fine_config      NUMERIC(14,2);
  v_min_term_days    INTEGER;
  v_fine_eligible    BOOLEAN;
  v_fine_amount      NUMERIC(14,2) := 0;
  v_fine_charge_id   UUID;
  v_alloc            RECORD;
  v_charge_status    charge_status;
  v_deposit_reason   TEXT;
  v_deposit_allocated NUMERIC(14,2) := 0;
  v_credit_allocated  NUMERIC(14,2) := 0;
BEGIN
  -- Trava a linha da locação (Spec 0015 / RN-010).
  SELECT vehicle_id, customer_id, km_initial, start_date,
         early_termination_fine_amount, minimum_term_days
    INTO v_vehicle_id, v_customer_id, v_km_initial, v_start_date,
         v_fine_config, v_min_term_days
    FROM rentals
   WHERE id = p_rental_id AND tenant_id = p_tenant_id AND status = 'active'
     FOR UPDATE;

  IF v_vehicle_id IS NULL THEN
    RAISE EXCEPTION 'RENTAL_NOT_ACTIVE';
  END IF;

  IF p_km_final IS NULL THEN
    RAISE EXCEPTION 'KM_FINAL_REQUIRED';
  END IF;

  -- Trava o veículo e lê o km atual sob o lock.
  SELECT km_current INTO v_vehicle_km FROM vehicles
   WHERE id = v_vehicle_id AND tenant_id = p_tenant_id
     FOR UPDATE;

  v_km_minimum := GREATEST(COALESCE(v_vehicle_km, 0), COALESCE(v_km_initial, 0));
  IF p_km_final < v_km_minimum THEN
    RAISE EXCEPTION 'KM_BELOW_MINIMUM: minimo=%', v_km_minimum;
  END IF;

  -- Cobranças que o plano decidiu cancelar (PRD 0016) já chegam aqui com
  -- `status='cancelled'` — a Action cancela antes de chamar esta RPC —, então
  -- já saem desta soma sozinhas, sem precisar de filtro extra.
  SELECT COALESCE(SUM(open_amount), 0), COUNT(*)
    INTO v_open_amount, v_open_count
    FROM charge_balances
   WHERE rental_id = p_rental_id AND status = 'open' AND open_amount > 0;

  SELECT COALESCE(balance, 0) INTO v_deposit
    FROM deposit_balances WHERE rental_id = p_rental_id;
  v_deposit := COALESCE(v_deposit, 0);

  -- Saldo de crédito do cliente. Derivado do razão, como todo saldo.
  SELECT COALESCE(balance, 0) INTO v_credit
    FROM customer_credit_balances
   WHERE tenant_id = p_tenant_id AND customer_id = v_customer_id;
  v_credit := COALESCE(v_credit, 0);

  IF v_open_amount > 0 AND NOT p_force THEN
    RAISE EXCEPTION 'RENTAL_HAS_OPEN_CHARGES: % cobrança(s), total %', v_open_count, v_open_amount
      USING ERRCODE = 'check_violation';
  END IF;

  -- Spec 0015 — elegibilidade e valor da multa recalculados aqui, nunca a
  -- partir do que o client mandou (RN-002/RN-003).
  v_fine_eligible := v_fine_config IS NOT NULL
                  AND v_min_term_days IS NOT NULL
                  AND p_termination_date < (v_start_date + v_min_term_days);

  IF v_fine_eligible THEN
    v_fine_amount := v_fine_config;
  END IF;

  IF p_charge_fine AND NOT v_fine_eligible THEN
    RAISE EXCEPTION 'FINE_NOT_APPLICABLE';
  END IF;

  IF p_charge_fine AND (p_fine_deposit_amount + p_fine_credit_amount) > v_fine_amount THEN
    RAISE EXCEPTION 'FINE_ALLOCATION_EXCEEDS_TOTAL: multa=%, alocado=%',
      v_fine_amount, p_fine_deposit_amount + p_fine_credit_amount;
  END IF;

  IF p_charge_fine THEN
    v_fine_charge_id := (fn_create_charge(
      p_tenant_id,
      jsonb_build_object(
        'customer_id',    v_customer_id,
        'rental_id',      p_rental_id,
        'due_date',       p_termination_date,
        'source_module',  'early_termination_fine',
        'source_id',      p_rental_id
      ),
      jsonb_build_array(jsonb_build_object(
        'description',          'Multa por rescisão antecipada',
        'credit_account_code',  'receita_multa_rescisao',
        'quantity',              1,
        'unit_amount',           v_fine_amount,
        'amount',                v_fine_amount
      ))
    )->>'charge_id')::uuid;

    IF p_fine_deposit_amount > 0 THEN
      PERFORM fn_retain_deposit_on_charge(
        p_tenant_id, p_rental_id, v_fine_charge_id, p_fine_deposit_amount,
        'Multa por rescisão antecipada'
      );
    END IF;

    IF p_fine_credit_amount > 0 THEN
      PERFORM fn_apply_customer_credit(
        p_tenant_id, v_customer_id, v_fine_charge_id, p_fine_credit_amount
      );
    END IF;
  END IF;

  -- ------------------------------------------------------------------------
  -- Spec 0017 — distribuição dirigida, dívida a dívida
  -- ------------------------------------------------------------------------
  -- Cada `fn_*` relê saldo e dívida ATUAIS sob trava do cliente e recusa acima
  -- de qualquer um dos dois. Como tudo roda na transação desta função, uma
  -- recusa no meio desfaz as alocações anteriores E o encerramento: é isso que
  -- dá RN-006 (nada aplicado pela metade) sem compensação nenhuma no client.
  --
  -- `auth.uid()` vai como autor: as duas Server Actions que isto substitui
  -- passavam `user.id`, e sem isso `payments.received_by` ficaria nulo — o
  -- rastro de quem gastou o dinheiro do cliente se perderia na migração.
  v_deposit_reason := CASE
    WHEN NULLIF(btrim(p_deposit_reason), '') IS NULL THEN 'Retenção de caução'
    ELSE 'Retenção de caução — ' || btrim(p_deposit_reason)
  END;

  FOR v_alloc IN
    SELECT * FROM jsonb_to_recordset(COALESCE(p_deposit_allocations, '[]'::jsonb))
      AS x(charge_id UUID, amount NUMERIC)
  LOOP
    -- As duas `fn_*` só conferem o dono da cobrança pelo CLIENTE, não pela
    -- LOCAÇÃO. "Outras locações do mesmo cliente" é decisão de produto (PRD 0017
    -- §3.5), não limitação técnica — sem esta guarda, um payload adulterado
    -- gastaria a caução DESTA locação em dívida de outro contrato que segue vivo.
    SELECT cb.status INTO v_charge_status
      FROM charge_balances cb
     WHERE cb.charge_id = v_alloc.charge_id
       AND cb.tenant_id = p_tenant_id
       AND cb.rental_id = p_rental_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'CHARGE_NOT_IN_RENTAL: %', v_alloc.charge_id;
    END IF;

    -- RN-005/RN-006: só dívida ainda EM ABERTO recebe alocação. `open_amount` da
    -- view é `itens − alocações` e ignora o status: uma cobrança cancelada por
    -- outro operador entre a leitura da tela e a confirmação continua com
    -- `open_amount > 0`, e as `fn_*` abaixo aceitariam gastar caução nela.
    IF v_charge_status <> 'open' THEN
      RAISE EXCEPTION 'CHARGE_NOT_OPEN: % (%)', v_alloc.charge_id, v_charge_status;
    END IF;

    PERFORM fn_retain_deposit_on_charge(
      p_tenant_id, p_rental_id, v_alloc.charge_id, v_alloc.amount,
      v_deposit_reason, auth.uid()
    );
    v_deposit_allocated := v_deposit_allocated + v_alloc.amount;
  END LOOP;

  -- Crédito DEPOIS da caução: se a mesma dívida recebe as duas, o teto conjunto
  -- (RN-001) vale sem lógica extra — `fn_apply_customer_credit` relê
  -- `open_amount` já reduzido pela caução aplicada acima.
  FOR v_alloc IN
    SELECT * FROM jsonb_to_recordset(COALESCE(p_credit_allocations, '[]'::jsonb))
      AS x(charge_id UUID, amount NUMERIC)
  LOOP
    SELECT cb.status INTO v_charge_status
      FROM charge_balances cb
     WHERE cb.charge_id = v_alloc.charge_id
       AND cb.tenant_id = p_tenant_id
       AND cb.rental_id = p_rental_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'CHARGE_NOT_IN_RENTAL: %', v_alloc.charge_id;
    END IF;

    IF v_charge_status <> 'open' THEN
      RAISE EXCEPTION 'CHARGE_NOT_OPEN: % (%)', v_alloc.charge_id, v_charge_status;
    END IF;

    PERFORM fn_apply_customer_credit(
      p_tenant_id, v_customer_id, v_alloc.charge_id, v_alloc.amount, auth.uid()
    );
    v_credit_allocated := v_credit_allocated + v_alloc.amount;
  END LOOP;

  -- O depósito fecha SEMPRE ao encerrar, seja qual for o destino do dinheiro —
  -- o mesmo que `closeRentalFinancial` fazia nos três caminhos, agora dentro da
  -- transação. O que sobrar continua visível em `deposit_balances` (a view não
  -- filtra por `closed_at`): fechar marca o fim do vínculo com o contrato, não
  -- a resolução do saldo.
  UPDATE deposits
     SET closed_at = now()
   WHERE rental_id = p_rental_id AND tenant_id = p_tenant_id AND closed_at IS NULL;

  -- Fora do período: sempre cancelada (sem escolha). Dentro do período: só a
  -- que o operador marcou por opção (Spec 0016).
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

  -- PRD 0016: linha `issued` cuja cobrança foi cancelada (pela Action, antes
  -- desta RPC) acompanha — dentro ou fora do período.
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

  UPDATE rentals
     SET status = p_new_status, end_date = p_termination_date, km_final = p_km_final, updated_at = now()
   WHERE id = p_rental_id AND tenant_id = p_tenant_id AND status = 'active';

  IF NOT FOUND THEN
    -- Segunda chamada concorrente que esperou o FOR UPDATE e chegou aqui
    -- depois que a primeira já commitou (RN-010).
    RAISE EXCEPTION 'RENTAL_NOT_ACTIVE';
  END IF;

  UPDATE vehicles
     SET status = 'available', updated_at = now(), km_current = p_km_final
   WHERE id = v_vehicle_id AND tenant_id = p_tenant_id;

  -- Saldos DEPOIS da distribuição, relidos do razão: `deposit_balance` e
  -- `credit_balance` abaixo são os de ANTES (o que a apuração viu).
  SELECT COALESCE(balance, 0) INTO v_deposit_after
    FROM deposit_balances WHERE rental_id = p_rental_id;
  v_deposit_after := COALESCE(v_deposit_after, 0);

  SELECT COALESCE(balance, 0) INTO v_credit_after
    FROM customer_credit_balances
   WHERE tenant_id = p_tenant_id AND customer_id = v_customer_id;
  v_credit_after := COALESCE(v_credit_after, 0);

  RETURN jsonb_build_object(
    'rental_id',            p_rental_id,
    'customer_id',          v_customer_id,
    'open_amount',          v_open_amount,
    'open_charges',         v_open_count,
    'deposit_balance',      v_deposit,
    'credit_balance',       v_credit,
    'cancelled_schedules',  v_cancelled,
    'requires_settlement',  v_deposit > 0 OR v_open_amount > 0 OR v_credit > 0,
    'fine_eligible',        v_fine_eligible,
    'fine_charged',         p_charge_fine,
    'fine_amount',          v_fine_amount,
    'fine_deposit_amount',  p_fine_deposit_amount,
    'fine_credit_amount',   p_fine_credit_amount,
    'fine_charge_id',       v_fine_charge_id,
    'deposit_allocated',    v_deposit_allocated,
    'credit_allocated',     v_credit_allocated,
    'deposit_remaining',    v_deposit_after,
    'credit_remaining',     v_credit_after
  );
END;
$$;

COMMENT ON FUNCTION terminate_rental IS
  'Spec 0017: distribuição dirigida de caução/crédito, dívida a dívida, na mesma transação que fecha a locação — qualquer recusa desfaz tudo. A devolução da sobra continua fora (returnRemainingDeposit / settleCustomerCredit).';

REVOKE EXECUTE ON FUNCTION terminate_rental(UUID, UUID, DATE, TEXT, BOOLEAN, INTEGER, BOOLEAN, NUMERIC, NUMERIC, UUID[], JSONB, JSONB, TEXT) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION terminate_rental(UUID, UUID, DATE, TEXT, BOOLEAN, INTEGER, BOOLEAN, NUMERIC, NUMERIC, UUID[], JSONB, JSONB, TEXT) TO authenticated, service_role;
