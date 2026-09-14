-- ---------------------------------------------------------------------------
-- Multa por Rescisão Antecipada de Contrato (Spec 0015)
-- ---------------------------------------------------------------------------
-- Multa e prazo mínimo de contrato deixam de ser CONTRACT_TERMINATION_FINE_BRL
-- e RENTAL_MINIMUM_DURATION (constantes globais em packages/core) e passam a
-- ser configuração opcional por locação. O acerto da multa no encerramento
-- (cobrança + abatimento de caução/crédito) entra DENTRO de `terminate_rental`
-- — a mesma transação que já apura débito aberto e libera o veículo — em vez
-- de virar mais uma Server Action orquestrada no client. Isso fecha RN-009
-- (falha parcial não pode deixar a locação encerrada com multa pela metade) e
-- aproveita a mudança para corrigir RN-010: a leitura de `rentals` aqui nunca
-- travou a linha nem reconfirmava `status='active'` no UPDATE final, então
-- duas chamadas concorrentes podiam ambas terminar a mesma locação.

-- ---------------------------------------------------------------------------
-- 1. Configuração por locação (RF-001/RF-002)
-- ---------------------------------------------------------------------------

ALTER TABLE rentals
  ADD COLUMN IF NOT EXISTS early_termination_fine_amount NUMERIC(14,2),
  ADD COLUMN IF NOT EXISTS minimum_term_days INTEGER;

ALTER TABLE rentals
  ADD CONSTRAINT rentals_early_termination_fine_amount_check
    CHECK (early_termination_fine_amount IS NULL OR early_termination_fine_amount > 0),
  ADD CONSTRAINT rentals_minimum_term_days_check
    CHECK (minimum_term_days IS NULL OR minimum_term_days > 0);

COMMENT ON COLUMN rentals.early_termination_fine_amount IS
  'Spec 0015: multa por rescisão antecipada configurada para esta locação. NULL = sem multa configurada (RN-003).';
COMMENT ON COLUMN rentals.minimum_term_days IS
  'Spec 0015: prazo mínimo de vigência, em dias corridos a partir de start_date (RN-001). NULL = sem prazo mínimo configurado.';

-- ---------------------------------------------------------------------------
-- 2. Conta contábil da multa (mesmo catálogo global da migration 02, ADR 0024)
-- ---------------------------------------------------------------------------
-- Conta própria em vez de reaproveitar `receita_locacao` — mesmo precedente de
-- `receita_encargos_atraso` (LATE_CHARGE_REVENUE), que também separa uma
-- receita "de penalidade" da receita normal de locação. NÃO reaproveita
-- `despesa_multa`/`repasse_multa`: aquelas são do domínio de multa de
-- trânsito (despesa repassada ao responsável) — o oposto econômico de uma
-- multa contratual, que é receita da empresa.

-- Toda conta 'revenue' precisa de default_report_line_code não nulo
-- (financial_accounts_report_line_coherent, migration 03/17). Mesmo
-- tratamento de `receita_encargos_atraso` — outra receita de penalidade
-- ligada ao comportamento do contrato, não ao serviço de locação em si.
INSERT INTO financial_accounts (code, name, kind, normal_direction, is_configurable, sort_order, default_report_line_code, default_in_tax_base)
VALUES ('receita_multa_rescisao', 'Receita de multa por rescisão antecipada', 'revenue', 'credit', true, 225, 'financial_income', true);

-- ---------------------------------------------------------------------------
-- 3. create_rental_with_schedule — ganha os 2 campos na criação (RF-001)
-- ---------------------------------------------------------------------------
-- Mesma assinatura (p_rental é jsonb) — não é overload novo, só 2 chaves a
-- mais lidas do payload. CREATE OR REPLACE é suficiente aqui.

CREATE OR REPLACE FUNCTION public.create_rental_with_schedule(p_tenant_id uuid, p_rental jsonb, p_schedule jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_rental_id  UUID;
  v_vehicle_id UUID    := (p_rental->>'vehicle_id')::uuid;
  v_km_initial INTEGER := (p_rental->>'km_initial')::integer;
  v_vehicle_km INTEGER;
BEGIN
  -- Trava o veículo (impede duas locações concorrentes para a mesma moto) e
  -- lê o km atual sob o mesmo lock — é ele quem define o piso (RN-002).
  SELECT km_current INTO v_vehicle_km FROM vehicles
   WHERE id = v_vehicle_id AND tenant_id = p_tenant_id
     FOR UPDATE NOWAIT;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'VEHICLE_NOT_FOUND';
  END IF;

  -- ADR 0036: a trava acima só serializava as criações; nada impedia a
  -- segunda de passar depois da primeira.
  IF EXISTS (
    SELECT 1 FROM rentals
     WHERE vehicle_id = v_vehicle_id AND tenant_id = p_tenant_id AND status = 'active'
  ) THEN
    RAISE EXCEPTION 'VEHICLE_ALREADY_RENTED';
  END IF;

  IF v_km_initial IS NOT NULL AND v_km_initial < COALESCE(v_vehicle_km, 0) THEN
    RAISE EXCEPTION 'KM_BELOW_MINIMUM: minimo=%', COALESCE(v_vehicle_km, 0);
  END IF;

  INSERT INTO rentals (
    tenant_id, customer_id, vehicle_id, start_date, end_date,
    cycle, cycle_amount, due_day, use_pro_rata, contract_type,
    status, observations, contract_template_id,
    checkin_checkout_inspection_profile_id, periodic_inspection_profile_id,
    periodic_inspection_frequency_days, km_initial,
    early_termination_fine_amount, minimum_term_days           -- Spec 0015
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
    -- rentals_contract_type_check aceita apenas 'rental' e 'rent_to_own'
    COALESCE(p_rental->>'contract_type', 'rental'),
    'active',
    p_rental->>'observations',
    (p_rental->>'contract_template_id')::uuid,
    (p_rental->>'checkin_checkout_inspection_profile_id')::uuid,
    (p_rental->>'periodic_inspection_profile_id')::uuid,
    (p_rental->>'periodic_inspection_frequency_days')::int,
    v_km_initial,
    (p_rental->>'early_termination_fine_amount')::numeric,     -- Spec 0015
    (p_rental->>'minimum_term_days')::int                      -- Spec 0015
  RETURNING id INTO v_rental_id;

  -- Cronograma vindo de generateSchedule() em @gomoto/core — a mesma função
  -- que alimenta o preview antes da confirmação (RF-036).
  INSERT INTO rental_billing_schedules (
    tenant_id, rental_id, sequence_number, period_start, period_end, due_date, amount
  )
  SELECT
    p_tenant_id,
    v_rental_id,
    (item->>'sequence_number')::int,
    (item->>'period_start')::date,
    (item->>'period_end')::date,
    (item->>'due_date')::date,
    (item->>'amount')::numeric
  FROM jsonb_array_elements(p_schedule) AS item;

  -- Km registrado atualiza o veículo (RN-001). Sem km_initial (chamada que não
  -- passa pelo Zod — ex.: RPC direta), o km do veículo não muda.
  UPDATE vehicles
     SET status = 'rented', updated_at = now(),
         km_current = COALESCE(v_km_initial, km_current)
   WHERE id = v_vehicle_id AND tenant_id = p_tenant_id;

  RETURN v_rental_id;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 4. terminate_rental — ganha a decisão da multa (RF-003 a RF-007) + trava a
--    locação (RN-010, corrige a lacuna: leitura de hoje não usa FOR UPDATE nem
--    reconfirma status no UPDATE final).
-- ---------------------------------------------------------------------------
-- Assinatura ganha 3 parâmetros novos → função nova para o Postgres, mesmo
-- padrão já usado na migration 20260912234442 ao adicionar p_km_final: DROP
-- explícito da assinatura anterior (evita overload duplicado) + REGRANT
-- explícito (ADR 0034 — ALTER DEFAULT PRIVILEGES não cobre reconceder em cima
-- de DROP, e a versão de 6 parâmetros perderia suas concessões silenciosamente
-- se dependêssemos só do default).
DROP FUNCTION IF EXISTS terminate_rental(UUID, UUID, DATE, TEXT, BOOLEAN, INTEGER);

CREATE OR REPLACE FUNCTION terminate_rental(
  p_tenant_id           UUID,
  p_rental_id           UUID,
  p_termination_date    DATE,
  p_new_status          TEXT    DEFAULT 'closed',
  p_force               BOOLEAN DEFAULT false,
  p_km_final            INTEGER DEFAULT NULL,
  p_charge_fine         BOOLEAN DEFAULT false,   -- Spec 0015 (RF-004)
  p_fine_deposit_amount NUMERIC DEFAULT 0,       -- Spec 0015 (RF-006)
  p_fine_credit_amount  NUMERIC DEFAULT 0        -- Spec 0015 (RF-006)
) RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_vehicle_id     UUID;
  v_customer_id    UUID;
  v_km_initial     INTEGER;
  v_vehicle_km     INTEGER;
  v_km_minimum     INTEGER;
  v_open_amount    NUMERIC(14,2);
  v_open_count     INT;
  v_deposit        NUMERIC(14,2);
  v_credit         NUMERIC(14,2);
  v_cancelled      INT;
  v_start_date     DATE;
  v_fine_config    NUMERIC(14,2);
  v_min_term_days  INTEGER;
  v_fine_eligible  BOOLEAN;
  v_fine_amount    NUMERIC(14,2) := 0;
  v_fine_charge_id UUID;
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

  UPDATE rental_billing_schedules
     SET status = 'cancelled', updated_at = now()
   WHERE tenant_id = p_tenant_id
     AND rental_id = p_rental_id
     AND status    = 'scheduled'
     AND period_start > p_termination_date;

  GET DIAGNOSTICS v_cancelled = ROW_COUNT;

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

COMMENT ON FUNCTION terminate_rental IS
  'Spec 0015: trava a locação (FOR UPDATE) e resolve a multa por rescisão antecipada — cobrança e abatimentos na mesma transação do encerramento.';

-- A função de 6 parâmetros tinha essas mesmas concessões (padrão em uso desde
-- ADR 0034/0036). `DROP FUNCTION` acima apagou o objeto e as concessões
-- junto: o novo objeto de 9 parâmetros nasce sem elas.
REVOKE EXECUTE ON FUNCTION terminate_rental(UUID, UUID, DATE, TEXT, BOOLEAN, INTEGER, BOOLEAN, NUMERIC, NUMERIC) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION terminate_rental(UUID, UUID, DATE, TEXT, BOOLEAN, INTEGER, BOOLEAN, NUMERIC, NUMERIC) TO authenticated, service_role;
