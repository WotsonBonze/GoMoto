-- ---------------------------------------------------------------------------
-- Encerramento retroativo decide o que fazer com cada cobrança (Spec 0016)
-- ---------------------------------------------------------------------------
-- Até aqui, `terminate_rental` só cancelava linhas do cronograma ainda NÃO
-- emitidas (`status='scheduled'`) que caíssem fora do período. Cobrança já
-- emitida para período posterior à data de encerramento nunca era tocada —
-- ficava em aberto e cobrável do cliente para sempre, mesmo representando um
-- período em que o contrato já deveria estar encerrado.
--
-- Revisão de 2026-09-17 (mesmo dia, achado ao revisar a UI): o desenho
-- original tratava toda cobrança emitida fora do período como candidata
-- OPCIONAL — o operador decidia cobrança a cobrança. Redesenhado para:
--
--   FORA do período → sempre cancelada, sem escolha. Mesmo tratamento que
--   linha `scheduled` fora do período já tinha; agora `issued` segue a
--   mesma regra, e o comportamento fica consistente entre as duas.
--
--   DENTRO do período → mantida por padrão (como sempre foi), mas o
--   operador pode marcar qualquer uma para cancelar mesmo assim — inclusive
--   linha ainda não emitida, o que é capacidade NOVA (antes só se cancelava
--   automaticamente fora do período).
--
-- A decisão de CANCELAR uma cobrança emitida é tomada fora desta função: a
-- Server Action `terminateRental` recarrega o plano (`planRetroactiveTermination`,
-- @gomoto/core) e chama `cancelCharge` (apps/web/src/lib/financial/charges.ts)
-- para cada uma — as `cancel_auto` (fora do período) e as marcadas por opção
-- (dentro) —, ANTES de chamar esta RPC, mesma ordem que `adjustRentalPeriod`
-- já usa (ADR 0035). `cancelCharge` já reverte a emissão no razão e recusa
-- cobrança com pagamento ou crédito alocado (RN-001 do PRD 0016), então esta
-- função não precisa duplicar essa regra.
--
-- Duas coisas ficam por conta desta RPC, sob o MESMO lock da locação:
--
--   1. Linha do cronograma cuja cobrança acabou de ser cancelada (pela Action,
--      logo acima) ainda estaria `issued` para sempre, apontando para uma
--      cobrança `cancelled` — mesma inconsistência que a ADR 0035 evita no
--      ajuste de período (lá a linha vira `superseded`; aqui, por ser
--      encerramento, vira `cancelled`, o mesmo estado já usado para as linhas
--      `scheduled` fora do período).
--
--   2. Linha ainda não emitida, DENTRO do período, que o operador marcou por
--      opção (`p_extra_schedule_line_ids_to_cancel`) — capacidade nova. A de
--      FORA do período continua caindo na mesma UPDATE de sempre.
--
-- ASSINATURA MUDA (parâmetro a mais) — por isso `DROP FUNCTION` explícito
-- antes de recriar, e GRANT reafirmado no final. `CREATE OR REPLACE` só
-- preserva grant quando a lista de tipos de parâmetro não muda (documentado
-- na migration `20260917005041_emissao_escopada_por_linha`); sem o DROP, a
-- assinatura nova nasceria como uma SEGUNDA função (overload), com EXECUTE
-- liberado para PUBLIC por padrão — reabrindo o que a migration
-- `registro_km_locacao` fechou.

DROP FUNCTION IF EXISTS terminate_rental(UUID, UUID, DATE, TEXT, BOOLEAN, INTEGER, BOOLEAN, NUMERIC, NUMERIC);

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
  -- Spec 0016 (revisão): linhas AINDA NÃO EMITIDAS, dentro do período, que o
  -- operador marcou por opção para cancelar mesmo assim. As de fora do
  -- período continuam cobertas pela UPDATE de sempre, sem precisar disto.
  p_extra_schedule_line_ids_to_cancel UUID[] DEFAULT NULL
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
  v_cancelled        INT;
  v_cancelled_issued INT;
  v_start_date       DATE;
  v_fine_config      NUMERIC(14,2);
  v_min_term_days    INTEGER;
  v_fine_eligible    BOOLEAN;
  v_fine_amount      NUMERIC(14,2) := 0;
  v_fine_charge_id   UUID;
BEGIN
  -- Trava a linha da locação (Spec 0015 / RN-010) — hoje esta SELECT não
  -- travava; duas chamadas concorrentes podiam ambas passar daqui antes do
  -- commit de qualquer uma.
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

  -- Trava o veículo e lê o km atual sob o lock — mesma janela de corrida que
  -- create_rental_with_schedule já fecha do lado dela.
  SELECT km_current INTO v_vehicle_km FROM vehicles
   WHERE id = v_vehicle_id AND tenant_id = p_tenant_id
     FOR UPDATE;

  v_km_minimum := GREATEST(COALESCE(v_vehicle_km, 0), COALESCE(v_km_initial, 0));
  IF p_km_final < v_km_minimum THEN
    RAISE EXCEPTION 'KM_BELOW_MINIMUM: minimo=%', v_km_minimum;
  END IF;

  -- Cobranças que o plano decidiu cancelar (PRD 0016) já chegam aqui com
  -- `status='cancelled'` — a Action cancela antes de chamar esta RPC —,
  -- então já saem desta soma sozinhas, sem precisar de filtro extra.
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
  -- partir do que o client mandou (RN-002/RN-003). start_date + minimum_term_days
  -- é o mesmo cálculo de isRentalTerminationWithinMinimum(), agora parametrizado
  -- pela própria locação em vez de RENTAL_MINIMUM_DURATION.
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
    -- fn_create_charge, fn_retain_deposit_on_charge e fn_apply_customer_credit
    -- já existem (ADR 0026) — chamados aqui dentro da MESMA transação em vez
    -- de 3 Server Actions separadas (RN-009).
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

  -- Fora do período: sempre cancelada (sem escolha). Dentro do período: só a
  -- que o operador marcou por opção (`p_extra_schedule_line_ids_to_cancel`,
  -- capacidade nova da revisão de 2026-09-17).
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

  -- PRD 0016: cobrança já EMITIDA que o plano cancelou — automaticamente fora
  -- do período, ou por opção do operador dentro dele — chega aqui com
  -- `charges.status = 'cancelled'` (a Action já chamou `cancelCharge` para
  -- cada uma). Falta só destravar a LINHA do cronograma, que sem isto ficaria
  -- `issued` apontando para uma cobrança cancelada para sempre — mesmo
  -- cuidado que a ADR 0035 tem com `superseded`, só que aqui o estado certo é
  -- `cancelled` (é encerramento, não reajuste). O discriminador é "esta
  -- cobrança foi cancelada", não a data: dentro ou fora do período, o efeito
  -- na linha é o mesmo.
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
    'fine_charge_id',       v_fine_charge_id
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION terminate_rental(UUID, UUID, DATE, TEXT, BOOLEAN, INTEGER, BOOLEAN, NUMERIC, NUMERIC, UUID[]) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION terminate_rental(UUID, UUID, DATE, TEXT, BOOLEAN, INTEGER, BOOLEAN, NUMERIC, NUMERIC, UUID[]) TO authenticated, service_role;
