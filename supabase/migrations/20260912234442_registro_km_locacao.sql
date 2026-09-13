-- ---------------------------------------------------------------------------
-- Registro de KM na locação (Spec 0014)
-- ---------------------------------------------------------------------------
-- Duas colunas novas em `rentals` — km_initial (entrega, congelado na
-- criação) e km_final (devolução, gravado no encerramento) — preenchidas
-- dentro das duas RPCs atômicas que já existem. Registrar km atualiza
-- `vehicles.km_current` (RN-001) e é validado contra o km atual do veículo
-- (RN-002) e um contra o outro (RN-003), na mesma transação em que o veículo
-- já é travado.
--
-- `km_inicial` no contrato impresso passa a ler de `rentals.km_initial`
-- (congelado na entrega) em vez de `vehicles.km_current` (mutável) — corrige
-- RF-004: hoje o PDF (re)impresso muda de km conforme o km atual do veículo
-- muda, mesmo depois da entrega.

ALTER TABLE rentals
  ADD COLUMN IF NOT EXISTS km_initial INTEGER,
  ADD COLUMN IF NOT EXISTS km_final   INTEGER;

ALTER TABLE rentals
  ADD CONSTRAINT rentals_km_final_gte_initial_check
  CHECK (km_final IS NULL OR km_initial IS NULL OR km_final >= km_initial);

COMMENT ON COLUMN rentals.km_initial IS 'Spec 0014: km do veículo na entrega, congelado na criação — fonte do km impresso no contrato (RF-004).';
COMMENT ON COLUMN rentals.km_final   IS 'Spec 0014: km do veículo na devolução, gravado no encerramento.';

-- ---------------------------------------------------------------------------
-- create_rental_with_schedule — ganha km_initial (RN-001 + RN-002)
-- ---------------------------------------------------------------------------
-- Corpo idêntico ao vigente (migration 20260910233356, ADR 0036 — trava o
-- veículo, recusa segunda locação ativa), exceto pela leitura do km atual do
-- veículo sob o mesmo lock, a checagem de piso e a gravação de km_initial em
-- `rentals` e `vehicles.km_current`.

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
    -- rentals_contract_type_check aceita apenas 'rental' e 'rent_to_own'
    COALESCE(p_rental->>'contract_type', 'rental'),
    'active',
    p_rental->>'observations',
    (p_rental->>'contract_template_id')::uuid,
    (p_rental->>'checkin_checkout_inspection_profile_id')::uuid,
    (p_rental->>'periodic_inspection_profile_id')::uuid,
    (p_rental->>'periodic_inspection_frequency_days')::int,
    v_km_initial
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
-- terminate_rental — ganha p_km_final (RN-001 + RN-002 + RN-003)
-- ---------------------------------------------------------------------------
-- Corpo idêntico ao vigente (migration 20260819202639), exceto por: exigir
-- p_km_final (RN-004 — sem carve-out para locação legada, ver Spec 0014 §3.1),
-- travar o veículo (não travava antes — fecha a mesma janela de corrida que a
-- criação já fecha do lado dela) e validar/gravar o km de devolução.

-- Assinatura ganhou um parâmetro novo (p_km_final): para o Postgres isso é uma
-- função DIFERENTE, não uma substituição — `CREATE OR REPLACE` criaria um
-- segundo overload e deixaria a versão de 5 parâmetros (sem exigir km) viva ao
-- lado da nova, undermining a própria exigência que esta migration introduz.
DROP FUNCTION IF EXISTS terminate_rental(UUID, UUID, DATE, TEXT, BOOLEAN);

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

  -- Trava o veículo (não travava antes) e lê o km atual sob o lock — mesma
  -- janela de corrida que create_rental_with_schedule já fecha do lado dela.
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

  UPDATE rental_billing_schedules
     SET status = 'cancelled', updated_at = now()
   WHERE tenant_id = p_tenant_id
     AND rental_id = p_rental_id
     AND status    = 'scheduled'
     AND period_start > p_termination_date;

  GET DIAGNOSTICS v_cancelled = ROW_COUNT;

  UPDATE rentals
     SET status = p_new_status, end_date = p_termination_date, km_final = p_km_final, updated_at = now()
   WHERE id = p_rental_id AND tenant_id = p_tenant_id;

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
    'requires_settlement',  v_deposit > 0 OR v_open_amount > 0 OR v_credit > 0
  );
END;
$$;

COMMENT ON FUNCTION terminate_rental IS
  'Spec 0014: exige km_final e trava o veículo, além de apurar cobranças em aberto, caução e crédito do cliente.';

-- A função de 5 parâmetros tinha essas mesmas concessões (ADR 0034 — grant
-- explícito de 20260627230859 + revogação de PUBLIC/anon de 20260906212433).
-- `DROP FUNCTION` acima apagou o objeto e as concessões junto com ele: o novo
-- objeto de 6 parâmetros nasce sem elas, e sem isto `authenticated` perderia a
-- capacidade de encerrar locação (o `ALTER DEFAULT PRIVILEGES` cobre objetos
-- novos, mas repetir explícito aqui é o padrão já em uso nesta migration de
-- ADR 0036 para função nova — não depender só do default).
REVOKE EXECUTE ON FUNCTION terminate_rental(UUID, UUID, DATE, TEXT, BOOLEAN, INTEGER) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION terminate_rental(UUID, UUID, DATE, TEXT, BOOLEAN, INTEGER) TO authenticated, service_role;
