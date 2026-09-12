-- ---------------------------------------------------------------------------
-- Ajuste de período e condições da locação (ADR 0035)
-- ---------------------------------------------------------------------------
-- Até aqui o período do contrato não era editável. `start_date` não mudava por
-- caminho nenhum; `end_date` só esticava (`fn_renew_rental`, que recusa
-- encurtar) ou virava encerramento (`terminate_rental`, que fecha a locação e
-- libera o veículo); `cycle`, `due_day` e `use_pro_rata` ficaram congelados
-- quando `regenerate_rental_schedule` caiu junto com o modelo financeiro
-- antigo. A orientação registrada era "encerre e crie outra locação" — e um
-- erro de digitação custava um contrato.
--
-- O que torna a correção possível é a ADR 0024: o PLANO
-- (`rental_billing_schedules`) é mutável e o DOCUMENTO (`charges`) é imutável.
-- Então a operação tem uma fronteira: antes dela nada muda; depois, o
-- cronograma é regerado. Linha `scheduled` do lado do futuro é substituída sem
-- consequência financeira. Linha `issued` exige cancelar a cobrança primeiro —
-- e é exatamente isso que esta função se recusa a presumir.
--
-- O cálculo (quais linhas caem, quais cobranças cancelar, quais linhas nascem)
-- vive em `planPeriodAdjustment`, função pura de @gomoto/core, a mesma que
-- alimenta a prévia na tela. Aqui só se escreve — e se confere.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Auditoria do que mudou
-- ---------------------------------------------------------------------------
-- Mesmo padrão de `20260725012126`, que já acrescentou previous_cycle/
-- new_due_day/etc. quando o reajuste passou a mexer na forma do cronograma.
-- Nullable de propósito: reajuste de valor puro continua usando só as colunas
-- de valor, sem inventar data.

ALTER TABLE rental_adjustments
  ADD COLUMN IF NOT EXISTS previous_start_date     DATE,
  ADD COLUMN IF NOT EXISTS new_start_date          DATE,
  ADD COLUMN IF NOT EXISTS previous_end_date       DATE,
  ADD COLUMN IF NOT EXISTS new_end_date            DATE,
  ADD COLUMN IF NOT EXISTS effective_from          DATE,
  ADD COLUMN IF NOT EXISTS cancelled_charges_count INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS created_lines_count     INT NOT NULL DEFAULT 0;

COMMENT ON COLUMN rental_adjustments.effective_from IS
  'Fronteira do ajuste: períodos que terminam até esta data não foram tocados.';
COMMENT ON COLUMN rental_adjustments.cancelled_charges_count IS
  'Cobranças emitidas que precisaram ser canceladas para o plano poder mudar.';

-- ---------------------------------------------------------------------------
-- 2. fn_adjust_rental_period
-- ---------------------------------------------------------------------------
-- SECURITY INVOKER de propósito, como `fn_renew_rental`: as políticas RLS de
-- `rentals` e `rental_billing_schedules` continuam valendo para quem chama. O
-- tenant vem resolvido server-side pela action e é conferido aqui de novo.

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
    FROM jsonb_array_elements(p_new_lines) AS item;

    GET DIAGNOSTICS v_created = ROW_COUNT;
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
    'cancelled',  v_cancelled
  );
END;
$$;

COMMENT ON FUNCTION fn_adjust_rental_period IS
  'ADR 0035: regera o cronograma a partir de uma fronteira, numa transação só. Recusa substituir linha cuja cobrança ainda está viva — cancelar documento é ato da action, conferido aqui sob o lock da locação.';

REVOKE EXECUTE ON FUNCTION fn_adjust_rental_period(UUID, UUID, JSONB, DATE, JSONB, JSONB, TEXT, UUID) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION fn_adjust_rental_period(UUID, UUID, JSONB, DATE, JSONB, JSONB, TEXT, UUID) TO authenticated;

-- ---------------------------------------------------------------------------
-- 3. As duas antecessoras viram recortes desta
-- ---------------------------------------------------------------------------
-- Não são derrubadas: uma aba aberta em produção ainda pode chamá-las, e
-- função removida vira erro no meio de uma operação do operador. Ficam
-- marcadas para quem for ler o catálogo depois.

COMMENT ON FUNCTION adjust_rental_schedule IS
  'OBSOLETA (ADR 0035) — recorte de fn_adjust_rental_period que só mudava o valor. Mantida para não quebrar sessão aberta.';

COMMENT ON FUNCTION fn_renew_rental IS
  'OBSOLETA (ADR 0035) — recorte de fn_adjust_rental_period que só estendia o fim. Mantida para não quebrar sessão aberta.';

COMMIT;
