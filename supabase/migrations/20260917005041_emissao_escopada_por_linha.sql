-- ---------------------------------------------------------------------------
-- Emissão do ajuste de período escopada às linhas criadas, não ao tenant inteiro
-- ---------------------------------------------------------------------------
-- `adjustRentalPeriod` passou a emitir na hora a parcela retroativa criada
-- pelo ajuste (`emits_now`), chamando `fn_issue_charges_for_tenant` sem
-- filtro nenhum — a mesma função do cron, processando toda a fila do
-- tenant numa transação só. `issue_due_charges` não isola falha por
-- cobrança: se QUALQUER outra linha do tenant (de outra locação, sem
-- relação com o ajuste) falhar ao virar documento, a exceção sobe e desfaz
-- a transação inteira, inclusive a cobrança que o ajuste acabou de criar —
-- e como a chamada é best-effort (só loga), o operador veria "ajuste
-- aplicado" sem saber que a cobrança dele foi derrubada por algo de uma
-- locação completamente diferente. Também acopla a latência de "toda a
-- fila do tenant" a uma ação que devia ser rápida.
--
-- Corrigido escopando: `issue_due_charges`/`fn_issue_charges_for_tenant`
-- ganham `p_schedule_line_ids UUID[] DEFAULT NULL`, e o ajuste passa só os
-- ids das linhas que ele mesmo criou. `NULL` (o cron, e qualquer chamador
-- antigo) continua processando o tenant inteiro — comportamento idêntico
-- a hoje.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. fn_adjust_rental_period devolve os ids reais das linhas criadas
-- ---------------------------------------------------------------------------
-- Antes só contava (`GET DIAGNOSTICS ... ROW_COUNT`). Sem o id de volta, a
-- action não tinha como dizer à emissão QUAIS linhas emitir agora — só
-- "quantas foram criadas". Mesma assinatura, mesmo RETURNS JSONB: não
-- mexe em grant nenhum.
--
-- Casamento por `sequence_number` (não por posição no array retornado):
-- `jsonb_array_elements` não garante ordem em `RETURNING`, e
-- `sequence_number` já é único por locação (UNIQUE(rental_id,
-- sequence_number)) — é a chave que o `PlannedScheduleLine` da action já
-- carrega, então não precisa de mais nada novo para casar os dois lados.

CREATE OR REPLACE FUNCTION fn_adjust_rental_period(
  p_tenant_id          UUID,
  p_rental_id          UUID,
  p_params             JSONB,   -- { start_date, end_date, cycle, due_day, cycle_amount, use_pro_rata }
  p_effective_from     DATE,
  p_supersede_line_ids JSONB,   -- [uuid]
  p_new_lines          JSONB,   -- [{ sequence_number, period_start, period_end, due_date, amount }]
  p_justification      TEXT,
  p_adjusted_by        UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public'
AS $$
DECLARE
  v_rental      RECORD;
  v_ids         UUID[];
  v_live        RECORD;
  v_superseded  INT := 0;
  v_created     INT := 0;
  v_cancelled   INT := 0;
  v_new_lines   JSONB := '[]'::jsonb;
BEGIN
  SELECT start_date, end_date, cycle, due_day, cycle_amount, use_pro_rata
    INTO v_rental
    FROM rentals
   WHERE id = p_rental_id AND tenant_id = p_tenant_id AND status = 'active'
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'RENTAL_NOT_ACTIVE';
  END IF;

  SELECT COALESCE(array_agg(value::text::uuid), ARRAY[]::uuid[])
    INTO v_ids
    FROM jsonb_array_elements_text(COALESCE(p_supersede_line_ids, '[]'::jsonb)) AS value;

  -- A GUARDA E A ESCRITA NA MESMA TRANSAÇÃO.
  --
  -- A action lê o cronograma, decide o que cai e cancela as cobranças antes de
  -- chegar aqui. Entre a leitura dela e esta escrita cabe o job de emissão, um
  -- webhook de pagamento e outro operador. Conferir aqui dentro, sob o lock da
  -- locação, é o que impede substituir uma linha cuja cobrança segue viva — o
  -- plano diria que o período não existe mais enquanto o cliente ainda tem um
  -- documento pagável na mão.
  IF array_length(v_ids, 1) > 0 THEN
    SELECT c.charge_number, c.status
      INTO v_live
      FROM charges c
     WHERE c.tenant_id     = p_tenant_id
       AND c.source_module = 'rental'
       AND c.source_id     = ANY (v_ids)
       AND c.status       <> 'cancelled'
     LIMIT 1;

    IF FOUND THEN
      RAISE EXCEPTION 'LINE_HAS_LIVE_CHARGE: cobrança #% ainda está % — cancele antes de substituir a linha do cronograma',
        v_live.charge_number, v_live.status
        USING ERRCODE = 'check_violation';
    END IF;

    -- `superseded`, não `cancelled`: o enum define a primeira como "substituída
    -- por reajuste", `schedule_by_month` já a exclui da previsão e
    -- `issue_due_charges` só consome `scheduled` — logo, linha substituída
    -- nunca reemite.
    UPDATE rental_billing_schedules
       SET status = 'superseded', updated_at = now()
     WHERE tenant_id = p_tenant_id
       AND rental_id = p_rental_id
       AND id        = ANY (v_ids)
       AND status   IN ('scheduled', 'issued');

    GET DIAGNOSTICS v_superseded = ROW_COUNT;
  END IF;

  SELECT count(*)
    INTO v_cancelled
    FROM charges c
   WHERE c.tenant_id     = p_tenant_id
     AND c.source_module = 'rental'
     AND c.source_id     = ANY (v_ids)
     AND c.status        = 'cancelled';

  IF jsonb_array_length(COALESCE(p_new_lines, '[]'::jsonb)) > 0 THEN
    WITH inserted AS (
      INSERT INTO rental_billing_schedules (
        tenant_id, rental_id, sequence_number, period_start, period_end, due_date, amount
      )
      SELECT
        p_tenant_id,
        p_rental_id,
        (item->>'sequence_number')::int,
        (item->>'period_start')::date,
        (item->>'period_end')::date,
        (item->>'due_date')::date,
        (item->>'amount')::numeric
      FROM jsonb_array_elements(p_new_lines) AS item
      RETURNING id, sequence_number
    )
    SELECT COALESCE(jsonb_agg(jsonb_build_object('id', id, 'sequence_number', sequence_number)), '[]'::jsonb)
      INTO v_new_lines
      FROM inserted;

    v_created := jsonb_array_length(v_new_lines);
  END IF;

  UPDATE rentals
     SET start_date   = (p_params->>'start_date')::date,
         end_date     = (p_params->>'end_date')::date,
         cycle        = p_params->>'cycle',
         due_day      = (p_params->>'due_day')::smallint,
         cycle_amount = (p_params->>'cycle_amount')::numeric,
         use_pro_rata = (p_params->>'use_pro_rata')::boolean,
         updated_at   = now()
   WHERE id = p_rental_id AND tenant_id = p_tenant_id;

  INSERT INTO rental_adjustments (
    tenant_id, rental_id,
    previous_cycle_amount, new_cycle_amount,
    previous_cycle, new_cycle,
    previous_due_day, new_due_day,
    previous_use_pro_rata, new_use_pro_rata,
    previous_start_date, new_start_date,
    previous_end_date, new_end_date,
    effective_from,
    updated_billings_count, cancelled_charges_count, created_lines_count,
    justification, adjusted_by
  ) VALUES (
    p_tenant_id, p_rental_id,
    v_rental.cycle_amount, (p_params->>'cycle_amount')::numeric,
    v_rental.cycle,        p_params->>'cycle',
    v_rental.due_day,      (p_params->>'due_day')::smallint,
    v_rental.use_pro_rata, (p_params->>'use_pro_rata')::boolean,
    v_rental.start_date,   (p_params->>'start_date')::date,
    v_rental.end_date,     (p_params->>'end_date')::date,
    p_effective_from,
    v_superseded, v_cancelled, v_created,
    p_justification, p_adjusted_by
  );

  RETURN jsonb_build_object(
    'superseded', v_superseded,
    'created',    v_created,
    'cancelled',  v_cancelled,
    'new_lines',  v_new_lines
  );
END;
$$;

COMMENT ON FUNCTION fn_adjust_rental_period IS
  'ADR 0035: regera o cronograma a partir de uma fronteira, numa transação só. Recusa substituir linha cuja cobrança ainda está viva — cancelar documento é ato da action, conferido aqui sob o lock da locação. Devolve new_lines ({id, sequence_number}[]) para a action poder emitir na hora só o que ela mesma criou.';

-- Assinatura não mudou (mesmos tipos de parâmetro): grant já aplicado em
-- 20260910222500 continua valendo, sem precisar reafirmar.

-- ---------------------------------------------------------------------------
-- 2. issue_due_charges / fn_issue_charges_for_tenant ganham escopo opcional
-- ---------------------------------------------------------------------------
-- Adicionar um parâmetro muda o tipo da assinatura — diferente de toda
-- migration anterior destas duas funções, que só trocou o CORPO sobre a
-- MESMA assinatura (uuid, integer) via CREATE OR REPLACE (e por isso nunca
-- precisou reafirmar grant: a garantia documentada em
-- 20260912220840_periodo_do_ciclo_na_descricao_da_cobranca só vale quando a
-- assinatura não muda). Aqui muda, então o DROP explícito é necessário —
-- sem ele, "CREATE OR REPLACE" com um parâmetro a mais criaria um SEGUNDO
-- overload em vez de substituir o existente, e esse novo overload nasceria
-- com EXECUTE liberado para PUBLIC por padrão — reabrindo exatamente o
-- buraco que 20260815170000_lock_down_emission_rpcs fechou.

DROP FUNCTION IF EXISTS fn_issue_charges_for_tenant(UUID, INT);
DROP FUNCTION IF EXISTS issue_due_charges(UUID, INT);

CREATE FUNCTION issue_due_charges(
  p_tenant_id UUID,
  p_lead_days INT DEFAULT 0,
  p_schedule_line_ids UUID[] DEFAULT NULL
)
RETURNS TABLE(schedule_id UUID, charge_id UUID, charge_number BIGINT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_row      RECORD;
  v_charge   UUID;
  v_number   BIGINT;
BEGIN
  -- A resolução saiu daqui para dentro do laço (ver o INSERT abaixo): emitir em
  -- lote não torna as cobranças o mesmo documento, e uma virada de política no
  -- meio da execução deixaria metade do lote com a regra errada.

  FOR v_row IN
    SELECT s.*, r.customer_id, r.vehicle_id
      FROM rental_billing_schedules s
      JOIN rentals r ON r.id = s.rental_id
     WHERE s.tenant_id = p_tenant_id
       AND s.status    = 'scheduled'
       AND s.period_start <= fn_business_today(p_tenant_id) + p_lead_days
       AND r.status    = 'active'
       AND (p_schedule_line_ids IS NULL OR s.id = ANY (p_schedule_line_ids))
     ORDER BY s.due_date
     FOR UPDATE OF s
  LOOP
    v_number := fn_next_charge_number(p_tenant_id);

    INSERT INTO charges (
      tenant_id, customer_id, rental_id, charge_number,
      due_date, late_charge_policy_id, source_module, source_id
    )
    VALUES (
      p_tenant_id, v_row.customer_id, v_row.rental_id, v_number,
      v_row.due_date, fn_late_charge_policy_at(p_tenant_id, fn_business_today(p_tenant_id)),
      'rental', v_row.id
    )
    RETURNING id INTO v_charge;

    INSERT INTO charge_items (
      tenant_id, charge_id, description, credit_account_code,
      unit_amount, amount, source_module, source_id, vehicle_id
    )
    VALUES (
      p_tenant_id, v_charge,
      'Locação ' || to_char(v_row.period_start, 'DD/MM/YYYY') ||
        -- period_end é o vencimento; o último dia de uso é o dia anterior.
        ' a ' || to_char(v_row.period_end - 1, 'DD/MM/YYYY'),
      'receita_locacao',
      v_row.amount, v_row.amount,
      'rental', v_row.id, v_row.vehicle_id
    );

    UPDATE rental_billing_schedules
       SET status = 'issued', updated_at = now()
     WHERE id = v_row.id;

    schedule_id   := v_row.id;
    charge_id     := v_charge;
    charge_number := v_number;
    RETURN NEXT;
  END LOOP;
END;
$$;

COMMENT ON FUNCTION issue_due_charges IS
  'Emite as cobranças cujo período chegou. Idempotente — só consome linhas scheduled. p_schedule_line_ids restringe a linhas específicas (NULL = tenant inteiro, o comportamento de sempre). A description do item mostra o último dia de USO (period_end - 1); period_end/due_date no schedule continuam a fronteira exclusiva de sempre.';

REVOKE EXECUTE ON FUNCTION issue_due_charges(UUID, INT, UUID[]) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION issue_due_charges(UUID, INT, UUID[]) TO service_role;

CREATE FUNCTION fn_issue_charges_for_tenant(
  p_tenant_id UUID,
  p_lead_days INT DEFAULT 0,
  p_schedule_line_ids UUID[] DEFAULT NULL
)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_row      RECORD;
  v_issued   INT := 0;
  v_entries  JSONB;
  v_total    NUMERIC;
BEGIN
  FOR v_row IN
    SELECT schedule_id, charge_id, charge_number
      FROM issue_due_charges(p_tenant_id, p_lead_days, p_schedule_line_ids)
  LOOP
    -- Débito único em contas a receber; um crédito por conta declarada nos
    -- itens. Se a cobrança misturar naturezas, cada uma vira sua perna.
    SELECT
      COALESCE(sum(ci.amount), 0),
      jsonb_agg(
        jsonb_build_object(
          'account_code', ci.credit_account_code,
          'direction',    'credit',
          'amount',       ci.total,
          'customer_id',  c.customer_id,
          'rental_id',    c.rental_id,
          'charge_id',    c.id,
          'vehicle_id',   ci.vehicle_id
        )
      )
      INTO v_total, v_entries
      FROM charges c
      JOIN (
        SELECT charge_id, credit_account_code,
               sum(amount) AS total, sum(amount) AS amount,
               (array_agg(vehicle_id) FILTER (WHERE vehicle_id IS NOT NULL))[1] AS vehicle_id
          FROM charge_items
         WHERE charge_id = v_row.charge_id
         GROUP BY charge_id, credit_account_code
      ) ci ON ci.charge_id = c.id
     WHERE c.id = v_row.charge_id
     GROUP BY c.id, c.customer_id, c.rental_id;

    IF v_total IS NULL OR v_total <= 0 THEN
      CONTINUE;
    END IF;

    v_entries := v_entries || jsonb_build_array(
      jsonb_build_object(
        'account_code', 'contas_a_receber',
        'direction',    'debit',
        'amount',       v_total,
        'customer_id',  (SELECT customer_id FROM charges WHERE id = v_row.charge_id),
        'rental_id',    (SELECT rental_id   FROM charges WHERE id = v_row.charge_id),
        'charge_id',    v_row.charge_id,
        'vehicle_id',   (SELECT vehicle_id FROM charge_items
                          WHERE charge_id = v_row.charge_id AND vehicle_id IS NOT NULL LIMIT 1)
      )
    );

    PERFORM post_financial_transaction(
      p_tenant_id,
      jsonb_build_object(
        'event_type',    'charge_issued',
        'description',   'Emissão automática — cobrança #' || v_row.charge_number,
        'source_module', 'rental',
        'source_id',     (SELECT rental_id FROM charges WHERE id = v_row.charge_id)
      ),
      v_entries
    );

    v_issued := v_issued + 1;
  END LOOP;

  RETURN v_issued;
END;
$$;

COMMENT ON FUNCTION fn_issue_charges_for_tenant IS
  'Emite as cobranças devidas do tenant E as lança no ledger, na mesma transação. p_schedule_line_ids restringe a linhas específicas (NULL = tenant inteiro, o comportamento do cron).';

REVOKE EXECUTE ON FUNCTION fn_issue_charges_for_tenant(UUID, INT, UUID[]) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION fn_issue_charges_for_tenant(UUID, INT, UUID[]) TO service_role;

-- `fn_run_billing_emission` chama `fn_issue_charges_for_tenant(v_tenant,
-- p_lead_days)` POSICIONAL, 2 argumentos — resolve pro único overload agora
-- existente (3 params), o 3º cai no default NULL. Comportamento do cron
-- (tenant inteiro, sem filtro) fica idêntico a antes; nada a mudar lá.

COMMIT;
