-- ADR 0034 — Fase 1: o elo entre o evento e o dinheiro
--
-- A pergunta que a auditoria faz não é "o razão fecha?" — isso o
-- `trg_entries_balanced` já garante. É:
--
--   "apareceu R$ 1.240,00 na conta desta locadora em 12/09. Por quê, e quem
--    mandou?"
--
-- A corrente ia de `financial_entries` até `payment_intents` por FK, e então
-- parava. O salto final — qual notificação do provedor causou aquilo — não era
-- dado: era uma busca em JSONB montada na hora, DIFERENTE por gateway
-- (`webhook_resource_id` na Cora, `order_nsu` na InfinitePay,
-- `data.id` no Mercado Pago). Arqueologia, não rastreabilidade.
--
-- E as três marcas de origem ficavam vazias justamente no único recebimento que
-- pessoa nenhuma digitou: `financial_transactions.created_by`,
-- `payments.received_by` e `audit_logs` — este último sem uma linha sequer.

-- ---------------------------------------------------------------------------
-- 1. O evento que causou o dinheiro
-- ---------------------------------------------------------------------------

ALTER TABLE payments
  ADD COLUMN gateway_event_id UUID REFERENCES gateway_events(id),
  -- Quem recebeu, quando não foi gente.
  --
  -- Coluna separada de `received_by` em vez de um `auth.users` de sistema: um
  -- usuário fictício apareceria em listas de membros, em filtros de "quem
  -- registrou" e em qualquer relatório que agrupe por pessoa. Um papel de
  -- máquina não deve se disfarçar de pessoa (ADR 0034, Princípio 3).
  ADD COLUMN received_by_system TEXT
    CHECK (received_by_system ~ '^gateway:[a-z][a-z0-9_]{2,31}$');

COMMENT ON COLUMN payments.gateway_event_id IS
  'ADR 0034: a notificação do provedor que causou este recebimento. É o elo que transformava "por que este dinheiro entrou?" em investigação.';
COMMENT ON COLUMN payments.received_by_system IS
  'ADR 0034: `gateway:<provedor>` quando o recebimento veio de webhook. Excludente com received_by — dinheiro é recebido por uma pessoa OU por um sistema.';

-- Pessoa ou máquina, nunca os dois. Se ambos estiverem preenchidos, a pergunta
-- "quem registrou este recebimento?" passa a ter duas respostas.
ALTER TABLE payments
  ADD CONSTRAINT payments_receiver_is_person_or_system
  CHECK (received_by IS NULL OR received_by_system IS NULL);

-- Recebimento de gateway traz as duas marcas ou nenhuma. Meia marca seria pior
-- que nenhuma: sugere rastreabilidade que não se sustenta.
ALTER TABLE payments
  ADD CONSTRAINT payments_gateway_origin_complete
  CHECK ((gateway_event_id IS NULL) = (received_by_system IS NULL));

CREATE INDEX idx_payments_gateway_event ON payments (gateway_event_id)
  WHERE gateway_event_id IS NOT NULL;

-- ---------------------------------------------------------------------------

ALTER TABLE financial_transactions
  ADD COLUMN source_event_id UUID REFERENCES gateway_events(id);

COMMENT ON COLUMN financial_transactions.source_event_id IS
  'ADR 0034: a notificação de gateway que originou este lançamento. Permite ir do razão ao webhook sem passar por payments.';

CREATE INDEX idx_ftx_source_event ON financial_transactions (source_event_id)
  WHERE source_event_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. "Aceito sem verificar" é estado do negócio, não mensagem de erro
-- ---------------------------------------------------------------------------
-- A ADR 0033 permite confirmar um `INVOICE.PAID` da Cora sem reconsultar a API
-- quando a credencial venceu. A ressalva era gravada como prefixo de texto
-- (`CONFIRMADO_SEM_VERIFICACAO:`) dentro de `processing_error` — a MESMA coluna
-- que carrega falhas de verdade, distinguida só por `processed_at` estar
-- preenchido.
--
-- Duas consequências: achar todos dependia de `LIKE`, e a coluna passou a ter
-- dois significados. Este é o campo próprio.

ALTER TABLE gateway_events
  ADD COLUMN accepted_without_verification BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN gateway_events.accepted_without_verification IS
  'ADR 0033/0034: o pagamento foi confirmado SEM reconsultar a API do provedor (credencial vencida). Alvo de alerta na Fase 4.';

-- Achar os aceitos sem verificação vira consulta booleana, e o índice parcial
-- deixa isso barato mesmo com a tabela grande.
CREATE INDEX idx_gateway_events_unverified
  ON gateway_events (received_at DESC)
  WHERE accepted_without_verification;

-- ---------------------------------------------------------------------------
-- 3. O razão passa a aceitar a origem do evento
-- ---------------------------------------------------------------------------
-- `post_financial_transaction` monta a transação a partir de um JSONB. Somar
-- uma chave não muda assinatura nem quebra chamador nenhum: quem não passa
-- `source_event_id` grava NULL, que é o certo para todo lançamento que não
-- veio de webhook.
--
-- A base é a versão de `20260815010437_financial_cleanup_inert_dimensions.sql`,
-- NÃO a original de `20260813001840`: aquela ainda escrevia `branch_id` e
-- `cost_center_id`, colunas removidas por inércia. Partir da original
-- ressuscitaria as duas e a função quebra no primeiro lançamento.

CREATE OR REPLACE FUNCTION post_financial_transaction(
  p_tenant_id   UUID,
  p_transaction JSONB,
  p_entries     JSONB
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_tx_id UUID;
BEGIN
  IF jsonb_array_length(p_entries) < 2 THEN
    RAISE EXCEPTION
      'Lançamento exige contrapartida: recebido % perna(s) (ADR 0024, Princípio 1).',
      jsonb_array_length(p_entries)
      USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO financial_transactions (
    tenant_id, event_type, occurred_at, description,
    currency, exchange_rate, source_module, source_id,
    reverses_transaction_id, created_by, source_event_id
  )
  VALUES (
    p_tenant_id,
    p_transaction->>'event_type',
    COALESCE((p_transaction->>'occurred_at')::timestamptz, now()),
    p_transaction->>'description',
    COALESCE(p_transaction->>'currency', 'BRL'),
    COALESCE((p_transaction->>'exchange_rate')::numeric, 1),
    p_transaction->>'source_module',
    NULLIF(p_transaction->>'source_id', '')::uuid,
    NULLIF(p_transaction->>'reverses_transaction_id', '')::uuid,
    NULLIF(p_transaction->>'created_by', '')::uuid,
    NULLIF(p_transaction->>'source_event_id', '')::uuid
  )
  RETURNING id INTO v_tx_id;

  INSERT INTO financial_entries (
    tenant_id, transaction_id, account_code, direction, amount,
    customer_id, vehicle_id, rental_id, charge_id, payable_id
  )
  SELECT
    p_tenant_id,
    v_tx_id,
    e->>'account_code',
    (e->>'direction')::entry_direction,
    (e->>'amount')::numeric,
    NULLIF(e->>'customer_id', '')::uuid,
    NULLIF(e->>'vehicle_id', '')::uuid,
    NULLIF(e->>'rental_id', '')::uuid,
    NULLIF(e->>'charge_id', '')::uuid,
    NULLIF(e->>'payable_id', '')::uuid
  FROM jsonb_array_elements(p_entries) AS e;

  RETURN v_tx_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- 4. A confirmação registra de onde veio
-- ---------------------------------------------------------------------------
-- DROP antes do CREATE: somar parâmetros com DEFAULT a uma função plpgsql cria
-- uma SOBRECARGA, não substitui a original. Duas versões coexistindo deixariam
-- o PostgREST escolher por número de argumentos — e a versão sem rastro
-- continuaria alcançável.

DROP FUNCTION IF EXISTS fn_confirm_gateway_payment(
  UUID, UUID, NUMERIC, TIMESTAMPTZ, payment_method_type, TEXT
);

CREATE OR REPLACE FUNCTION fn_confirm_gateway_payment(
  p_tenant_id        UUID,
  p_intent_id        UUID,
  p_amount           NUMERIC,
  p_paid_at          TIMESTAMPTZ,
  p_method           payment_method_type DEFAULT NULL,
  p_notes            TEXT DEFAULT 'Confirmado pelo gateway',
  -- Novos na ADR 0034. DEFAULT NULL mantém a suíte e qualquer chamador antigo
  -- funcionando; quem confirma dinheiro de verdade passa os dois.
  p_gateway_event_id UUID DEFAULT NULL,
  p_provider         TEXT DEFAULT NULL
) RETURNS UUID
LANGUAGE plpgsql
AS $$
DECLARE
  v_payment_id  UUID;
  v_charge_id   UUID;
  v_accrued     NUMERIC;
  v_customer_id UUID;
  v_rental_id   UUID;
  v_number      INT;
  v_intent_meth TEXT;
  v_method      payment_method_type;
  v_system      TEXT;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'AMOUNT_MUST_BE_POSITIVE';
  END IF;

  -- O formato de `received_by_system` mora aqui e no CHECK da coluna, não no
  -- adaptador de cada gateway: três lugares construindo a mesma string dariam
  -- três oportunidades de divergir.
  v_system := CASE WHEN p_provider IS NULL THEN NULL ELSE 'gateway:' || p_provider END;

  SELECT charge_id, COALESCE(accrued_amount, 0), method
    INTO v_charge_id, v_accrued, v_intent_meth
    FROM payment_intents
   WHERE id = p_intent_id AND tenant_id = p_tenant_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'INTENT_NOT_FOUND';
  END IF;

  -- O que o intent pediu é o que o pagamento registra. `p_method` explícito
  -- ainda ganha, para o caso de o gateway informar o meio real (ex.: link de
  -- pagamento quitado no cartão).
  v_method := COALESCE(
    p_method,
    CASE v_intent_meth
      WHEN 'pix'          THEN 'pix'
      WHEN 'credit_card'  THEN 'credit_card'
      WHEN 'boleto'       THEN 'bank_transfer'
      ELSE 'other'
    END::payment_method_type
  );

  SELECT id INTO v_payment_id
    FROM payments
   WHERE payment_intent_id = p_intent_id AND tenant_id = p_tenant_id;

  IF FOUND THEN
    UPDATE payment_intents SET status = 'paid'
     WHERE id = p_intent_id AND status <> 'paid';
    RETURN v_payment_id;
  END IF;

  IF v_accrued > 0 THEN
    PERFORM fn_realize_late_charge(p_tenant_id, v_charge_id, v_accrued);
  END IF;

  SELECT customer_id, rental_id, charge_number
    INTO v_customer_id, v_rental_id, v_number
    FROM charges
   WHERE id = v_charge_id AND tenant_id = p_tenant_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CHARGE_NOT_FOUND';
  END IF;

  INSERT INTO payments (tenant_id, customer_id, amount, method, paid_at,
                        payment_intent_id, notes,
                        gateway_event_id, received_by_system)
  VALUES (p_tenant_id, v_customer_id, p_amount, v_method, p_paid_at,
          p_intent_id, p_notes,
          p_gateway_event_id, v_system)
  RETURNING id INTO v_payment_id;

  INSERT INTO payment_allocations (tenant_id, payment_id, charge_id, amount)
  VALUES (p_tenant_id, v_payment_id, v_charge_id, p_amount);

  PERFORM post_financial_transaction(
    p_tenant_id,
    jsonb_build_object(
      'event_type',      'payment_received',
      'description',     'Recebimento via gateway — cobrança #' || v_number,
      'occurred_at',     p_paid_at,
      'source_module',   'payment',
      'source_id',       v_payment_id,
      -- O razão passa a apontar para o webhook direto, sem escala em payments.
      'source_event_id', p_gateway_event_id
    ),
    jsonb_build_array(
      jsonb_build_object('account_code', 'caixa_e_bancos', 'direction', 'debit',
                         'amount', p_amount, 'customer_id', v_customer_id,
                         'rental_id', v_rental_id, 'charge_id', v_charge_id),
      jsonb_build_object('account_code', 'contas_a_receber', 'direction', 'credit',
                         'amount', p_amount, 'customer_id', v_customer_id,
                         'rental_id', v_rental_id, 'charge_id', v_charge_id)
    )
  );

  UPDATE payment_intents SET status = 'paid' WHERE id = p_intent_id;

  RETURN v_payment_id;
END;
$$;

-- O DROP levou os grants junto. Só o webhook confirma pagamento.
REVOKE ALL ON FUNCTION fn_confirm_gateway_payment(
  UUID, UUID, NUMERIC, TIMESTAMPTZ, payment_method_type, TEXT, UUID, TEXT
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION fn_confirm_gateway_payment(
  UUID, UUID, NUMERIC, TIMESTAMPTZ, payment_method_type, TEXT, UUID, TEXT
) TO service_role;

COMMENT ON FUNCTION fn_confirm_gateway_payment IS
  'ADR 0030/0034: confirma pagamento de gateway numa transação. Registra o evento que causou o dinheiro e o sistema que o recebeu.';
