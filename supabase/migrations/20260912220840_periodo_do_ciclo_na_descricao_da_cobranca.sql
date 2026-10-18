-- ---------------------------------------------------------------------------
-- O período na descrição da cobrança mostra o último dia de USO, não o vencimento
-- ---------------------------------------------------------------------------
-- `period_end` é a fronteira EXCLUSIVA do período — o mesmo valor do
-- `due_date`, e é isso que faz uma linha do cronograma encaixar com a seguinte
-- sem buraco (`period_end` de uma linha = `period_start` da próxima; mesma
-- convenção `[início, fim)` da ADR 0036 para o período da locação inteira).
--
-- `issue_due_charges` gravava a description da cobrança como
-- 'Locação DD/MM/YYYY a DD/MM/YYYY' usando `period_end` cru. Um ciclo semanal
-- de 23/12 a 30/12 (vencimento 30/12) virava "Locação 23/12/2026 a
-- 30/12/2026" — 8 dias aparentes para uma cobrança que cobre 7 (23 a 29). O
-- dia 30 é o instante em que o ciclo seguinte começa, não um dia a mais
-- sendo cobrado; o cálculo em si sempre esteve certo (`dateDiffDays` já conta
-- só os 7 dias), o texto que mentia.
--
-- Corrigido subtraindo 1 dia do `period_end` só na formatação da description
-- — o dado gravado em `rental_billing_schedules`/`charges` não muda em nada.
-- Vale só para cobranças emitidas DAQUI PRA FRENTE: documento já emitido é
-- imutável (Princípio 5), e a description das cobranças antigas continua
-- como estava — está correta para o texto que existia quando foi emitida.
--
-- CREATE OR REPLACE preserva REVOKE/GRANT já aplicados
-- (20260815170000_lock_down_emission_rpcs.sql): só o corpo muda.

CREATE OR REPLACE FUNCTION public.issue_due_charges(p_tenant_id uuid, p_lead_days integer DEFAULT 0)
 RETURNS TABLE(schedule_id uuid, charge_id uuid, charge_number bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$;

COMMENT ON FUNCTION issue_due_charges IS
  'Emite as cobranças cujo período chegou. Idempotente — só consome linhas scheduled. A description do item mostra o último dia de USO (period_end - 1); period_end/due_date no schedule continuam a fronteira exclusiva de sempre.';
