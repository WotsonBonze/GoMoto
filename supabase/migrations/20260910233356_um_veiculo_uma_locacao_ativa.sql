-- ---------------------------------------------------------------------------
-- Um veículo, uma locação (ADR 0036)
-- ---------------------------------------------------------------------------
-- A moto não pode estar com dois clientes ao mesmo tempo, e o banco não sabia
-- disso. `create_rental_with_schedule` trava a linha do veículo, mas não olha
-- se ele já está locado: a checagem de "locação ativa" existia na RPC antiga
-- (`create_rental_with_charges`) e se perdeu na reescrita da Spec 0014. A tela
-- só lista veículos com `status = 'available'`, e isso seguia valendo por
-- convenção, não por regra — `vehicles.status` é coluna mantida à mão, e
-- `@gomoto/data` ainda tem um INSERT direto em `rentals` que não passa por
-- RPC nenhuma.
--
-- A prova de que o buraco é real estava na própria suíte E2E: specs criavam
-- seis locações ativas na mesma moto e passavam.
--
-- São DUAS regras, porque são dois jeitos diferentes de violar a mesma coisa:
--
--   1. Duas locações `active` no mesmo veículo. Índice único parcial — vale
--      para qualquer caminho de escrita, sem depender de a aplicação lembrar.
--
--   2. Períodos que se cruzam. A locação ativa não pode começar antes de a
--      anterior ter devolvido a moto. A regra 1 não pega isso (a anterior já
--      está `closed`), e desde a ADR 0035 dá para antecipar o início de uma
--      locação ativa — o caminho ficou a um campo de data de distância.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Pré-checagem
-- ---------------------------------------------------------------------------
-- Se já houver violação, falha dizendo QUAL veículo, em vez de deixar o
-- CREATE UNIQUE INDEX morrer com "could not create unique index" e um id
-- qualquer. Nada é corrigido automaticamente: escolher qual das locações é a
-- verdadeira é decisão de quem conhece o contrato.

DO $$
DECLARE
  v_lista TEXT;
BEGIN
  SELECT string_agg(
           format('%s (%s ativas)', COALESCE(v.license_plate, d.vehicle_id::text), d.n),
           ', ' ORDER BY d.n DESC)
    INTO v_lista
    FROM (
      SELECT vehicle_id, count(*) AS n
        FROM rentals
       WHERE status = 'active' AND vehicle_id IS NOT NULL
       GROUP BY vehicle_id
      HAVING count(*) > 1
    ) d
    LEFT JOIN vehicles v ON v.id = d.vehicle_id;

  IF v_lista IS NOT NULL THEN
    RAISE EXCEPTION 'Veículo com mais de uma locação ativa: %', v_lista
      USING HINT = 'Encerre as locações excedentes pela tela de Encerrar e aplique a migration de novo. Nada foi alterado.';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Regra 1 — no máximo uma locação ativa por veículo
-- ---------------------------------------------------------------------------

CREATE UNIQUE INDEX idx_rentals_one_active_per_vehicle
  ON rentals (vehicle_id)
  WHERE status = 'active';

COMMENT ON INDEX idx_rentals_one_active_per_vehicle IS
  'ADR 0036: um veículo não pode ter duas locações ativas. Vale para qualquer caminho de escrita, não só a RPC.';

-- ---------------------------------------------------------------------------
-- 3. Regra 2 — o período da locação ativa não cruza o de outra do mesmo veículo
-- ---------------------------------------------------------------------------
-- Semântica `[início, fim)`: devolver e retirar a moto no MESMO dia não é
-- sobreposição. Fim nulo é contrato em aberto, que ocupa tudo dali em diante.
-- Fim anterior ao início acontece quando se encerra uma locação antes de ela
-- começar — é período vazio, e `daterange` recusaria o par invertido.
--
-- A mesma regra existe em TS (`rentalPeriodsOverlap`, @gomoto/core) para a
-- prévia da tela avisar antes do clique. Esta é a que vale.

CREATE OR REPLACE FUNCTION fn_rental_period(p_start DATE, p_end DATE)
RETURNS daterange
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $$
  SELECT CASE
    WHEN p_start IS NULL THEN NULL
    WHEN p_end   IS NULL THEN daterange(p_start, NULL, '[)')
    ELSE daterange(p_start, GREATEST(p_start, p_end), '[)')
  END
$$;

COMMENT ON FUNCTION fn_rental_period IS
  'ADR 0036: período de ocupação da locação como [início, fim). Fim nulo = em aberto; fim antes do início = vazio.';

-- Trigger e não EXCLUDE: a restrição de exclusão validaria também o HISTÓRICO,
-- e uma sobreposição antiga em produção faria o `db push` falhar sem que
-- ninguém tivesse errado agora. O que precisa ser impossível é GRAVAR uma
-- sobreposição nova — e toda gravação de locação ativa passa por aqui.
--
-- Só olha a linha quando ela é `active`: é a única que se move. Encerrar
-- (`closed`) só encurta ou fixa a data de devolução, e nunca há locação ativa
-- posterior a ela na mesma moto — a regra 1 garante.
--
-- SECURITY DEFINER para enxergar as locações do veículo independentemente de
-- RLS; só lê e recusa. O lock no veículo é o mesmo que
-- `create_rental_with_schedule` e `terminate_rental` já tomam, então as
-- escritas de uma mesma moto passam em fila.

CREATE OR REPLACE FUNCTION fn_guard_rental_vehicle_period()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_other RECORD;
BEGIN
  IF NEW.status <> 'active' OR NEW.vehicle_id IS NULL OR NEW.start_date IS NULL THEN
    RETURN NEW;
  END IF;

  PERFORM 1 FROM vehicles WHERE id = NEW.vehicle_id FOR UPDATE;

  SELECT r.start_date, r.end_date
    INTO v_other
    FROM rentals r
   WHERE r.vehicle_id = NEW.vehicle_id
     AND r.id <> NEW.id
     AND r.start_date IS NOT NULL
     AND fn_rental_period(r.start_date, r.end_date) && fn_rental_period(NEW.start_date, NEW.end_date)
   ORDER BY r.start_date DESC
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'VEHICLE_PERIOD_OVERLAP: o veículo esteve em outra locação de % a %',
      to_char(v_other.start_date, 'DD/MM/YYYY'),
      COALESCE(to_char(v_other.end_date, 'DD/MM/YYYY'), 'hoje, sem data de fim')
      USING ERRCODE = 'exclusion_violation';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION fn_guard_rental_vehicle_period IS
  'ADR 0036: recusa gravar locação ativa cujo período cruza o de outra locação do mesmo veículo.';

CREATE TRIGGER trg_rentals_vehicle_period
  BEFORE INSERT OR UPDATE OF status, vehicle_id, start_date, end_date ON rentals
  FOR EACH ROW EXECUTE FUNCTION fn_guard_rental_vehicle_period();

REVOKE EXECUTE ON FUNCTION fn_guard_rental_vehicle_period() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION fn_rental_period(DATE, DATE)      FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION fn_rental_period(DATE, DATE)      TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. A criação diz o motivo em vez de deixar o índice falar
-- ---------------------------------------------------------------------------
-- O índice é a garantia; esta checagem é a mensagem. Sob o lock do veículo
-- que a função já toma, ela é confiável — e o operador recebe
-- "veículo já está locado" em vez de "duplicate key value violates unique
-- constraint". Corpo idêntico ao vigente, exceto pelo bloco novo.

CREATE OR REPLACE FUNCTION public.create_rental_with_schedule(p_tenant_id uuid, p_rental jsonb, p_schedule jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_rental_id  UUID;
  v_vehicle_id UUID := (p_rental->>'vehicle_id')::uuid;
BEGIN
  -- Trava o veículo: impede duas locações concorrentes para a mesma moto.
  PERFORM 1 FROM vehicles
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

  INSERT INTO rentals (
    tenant_id, customer_id, vehicle_id, start_date, end_date,
    cycle, cycle_amount, due_day, use_pro_rata, contract_type,
    status, observations, contract_template_id,
    checkin_checkout_inspection_profile_id, periodic_inspection_profile_id,
    periodic_inspection_frequency_days
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
    (p_rental->>'periodic_inspection_frequency_days')::int
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

  UPDATE vehicles SET status = 'rented', updated_at = now()
   WHERE id = v_vehicle_id AND tenant_id = p_tenant_id;

  RETURN v_rental_id;
END;
$function$;

COMMIT;
