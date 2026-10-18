-- ADR 0033 — Questão 1: dinheiro que chega para cobrança CANCELADA vira crédito
--
-- DECISÃO DO HUMANO (2026-09-07): crédito do cliente, não recebível.
--
-- O problema, registrado na ADR 0033 e sem conserto até aqui: cancelar uma
-- cobrança reverte a emissão no razão, mas o código de pagamento continua vivo
-- no provedor. Se alguém pagar, `fn_confirm_gateway_payment` não perguntava o
-- status da cobrança — alocava e lançava:
--
--     débito   caixa_e_bancos      ✅ o dinheiro entrou mesmo
--     crédito  contas_a_receber    ❌ mas a emissão já tinha sido revertida
--
-- e `contas_a_receber` daquele cliente ficava NEGATIVO: os livros passavam a
-- afirmar que a locadora devia ao cliente, sem que ninguém tivesse decidido
-- isso.
--
-- POR QUE CRÉDITO E NÃO RECEBÍVEL
--
-- Cancelar é dizer ao cliente "você não deve isto". O dinheiro que chega depois
-- é dele, não da locadora — então a contrapartida certa é a dívida com o
-- cliente, que é exatamente o que `creditos_de_clientes` representa. Manter
-- como recebível exigiria uma dívida que foi explicitamente extinta.
--
-- Recusar o dinheiro não era opção: a ADR 0024 é clara em que o que entrou tem
-- que ser reconhecido. O razão registra o fato; quem decide o destino é o
-- humano, e ele decidiu.
--
-- ESCOPO: só `cancelled`. Uma cobrança BAIXADA (`written_off`) que recebe
-- dinheiro é recuperação de perda — o cliente devia mesmo, e nós é que
-- desistimos de cobrar. Tratar as duas igual criaria crédito para quem estava
-- em dívida. Fica registrado como caso separado, sem resposta ainda.

-- ---------------------------------------------------------------------------
-- 1. O crédito sabe de qual pagamento veio
-- ---------------------------------------------------------------------------
-- Mesmo princípio da ADR 0034: o elo causal é dado, não arqueologia. E aqui ele
-- tem um segundo uso — `financial_reconciliation` acusa "dinheiro recebido que
-- não quitou nenhuma cobrança", e este pagamento legitimamente não quita
-- nenhuma. Sem o elo, todo crédito por cancelamento viraria falso positivo na
-- tela de diagnóstico.

ALTER TABLE customer_credits
  ADD COLUMN payment_id UUID REFERENCES payments(id);

COMMENT ON COLUMN customer_credits.payment_id IS
  'ADR 0033: o recebimento que originou este crédito, quando ele veio de dinheiro que chegou para uma cobrança cancelada.';

CREATE INDEX idx_customer_credits_payment ON customer_credits (payment_id)
  WHERE payment_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. A confirmação passa a olhar o status da cobrança
-- ---------------------------------------------------------------------------

DROP FUNCTION IF EXISTS fn_confirm_gateway_payment(
  UUID, UUID, NUMERIC, TIMESTAMPTZ, payment_method_type, TEXT, UUID, TEXT
);

CREATE OR REPLACE FUNCTION fn_confirm_gateway_payment(
  p_tenant_id        UUID,
  p_intent_id        UUID,
  p_amount           NUMERIC,
  p_paid_at          TIMESTAMPTZ,
  p_method           payment_method_type DEFAULT NULL,
  p_notes            TEXT DEFAULT 'Confirmado pelo gateway',
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
  v_status      charge_status;
  v_intent_meth TEXT;
  v_method      payment_method_type;
  v_system      TEXT;
  v_credit_id   UUID;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'AMOUNT_MUST_BE_POSITIVE';
  END IF;

  v_system := CASE WHEN p_provider IS NULL THEN NULL ELSE 'gateway:' || p_provider END;

  SELECT charge_id, COALESCE(accrued_amount, 0), method
    INTO v_charge_id, v_accrued, v_intent_meth
    FROM payment_intents
   WHERE id = p_intent_id AND tenant_id = p_tenant_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'INTENT_NOT_FOUND';
  END IF;

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

  -- O STATUS DA COBRANÇA passa a ser lido. Era a ausência disto que deixava
  -- `contas_a_receber` negativo (ADR 0033, Questão 1).
  SELECT customer_id, rental_id, charge_number, status
    INTO v_customer_id, v_rental_id, v_number, v_status
    FROM charges
   WHERE id = v_charge_id AND tenant_id = p_tenant_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CHARGE_NOT_FOUND';
  END IF;

  -- ── Cobrança CANCELADA: o dinheiro é do cliente ────────────────────
  IF v_status = 'cancelled' THEN
    -- Encargo NÃO é realizado: ele acompanha uma dívida que deixou de existir.
    -- Realizá-lo criaria receita de multa sobre cobrança cancelada.

    INSERT INTO payments (tenant_id, customer_id, amount, method, paid_at,
                          payment_intent_id, notes,
                          gateway_event_id, received_by_system)
    VALUES (p_tenant_id, v_customer_id, p_amount, v_method, p_paid_at,
            p_intent_id,
            -- A ressalva viaja no próprio registro que o operador lê, como a
            -- da ADR 0033 já faz. Um recebimento que não quitou nada precisa
            -- dizer por quê, ali mesmo.
            p_notes || ' — cobrança #' || v_number
                    || ' estava cancelada; valor virou crédito do cliente',
            p_gateway_event_id, v_system)
    RETURNING id INTO v_payment_id;

    -- SEM `payment_allocations`: alocar contra uma cobrança cancelada é
    -- exatamente o que tornava `contas_a_receber` negativo.

    INSERT INTO customer_credits (tenant_id, customer_id, amount, origin, reason,
                                  payment_id, created_by)
    VALUES (p_tenant_id, v_customer_id, p_amount, 'cancelled_charge',
            'Pagamento recebido para a cobrança #' || v_number || ', já cancelada',
            v_payment_id, NULL)
    RETURNING id INTO v_credit_id;

    PERFORM post_financial_transaction(
      p_tenant_id,
      jsonb_build_object(
        'event_type',      'payment_received',
        'description',     'Recebimento de cobrança cancelada #' || v_number
                           || ' — virou crédito do cliente',
        'occurred_at',     p_paid_at,
        'source_module',   'payment',
        'source_id',       v_payment_id,
        'source_event_id', p_gateway_event_id
      ),
      jsonb_build_array(
        jsonb_build_object('account_code', 'caixa_e_bancos', 'direction', 'debit',
                           'amount', p_amount, 'customer_id', v_customer_id,
                           'rental_id', v_rental_id),
        -- A contrapartida é a dívida COM o cliente, não o recebível DELE.
        jsonb_build_object('account_code', 'creditos_de_clientes', 'direction', 'credit',
                           'amount', p_amount, 'customer_id', v_customer_id,
                           'rental_id', v_rental_id)
      )
    );

    UPDATE payment_intents SET status = 'paid' WHERE id = p_intent_id;
    RETURN v_payment_id;
  END IF;

  -- ── Caminho normal ─────────────────────────────────────────────────
  IF v_accrued > 0 THEN
    PERFORM fn_realize_late_charge(p_tenant_id, v_charge_id, v_accrued);
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

REVOKE ALL ON FUNCTION fn_confirm_gateway_payment(
  UUID, UUID, NUMERIC, TIMESTAMPTZ, payment_method_type, TEXT, UUID, TEXT
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION fn_confirm_gateway_payment(
  UUID, UUID, NUMERIC, TIMESTAMPTZ, payment_method_type, TEXT, UUID, TEXT
) TO service_role;

COMMENT ON FUNCTION fn_confirm_gateway_payment IS
  'ADR 0030/0033/0034: confirma pagamento de gateway numa transação. Cobrança cancelada credita o CLIENTE em vez de contas a receber.';

-- ---------------------------------------------------------------------------
-- 3. A reconciliação para de acusar o que agora é correto
-- ---------------------------------------------------------------------------
-- `payment_without_allocation` existe para achar dinheiro recebido que não
-- quitou nada — e um recebimento de cobrança cancelada é exatamente isso, de
-- propósito. Sem esta exceção, toda aplicação da decisão acima viraria um falso
-- positivo permanente na tela de diagnóstico, que é como uma tela de
-- diagnóstico deixa de ser lida.

CREATE OR REPLACE VIEW financial_reconciliation
WITH (security_invoker = true) AS

SELECT
  t.tenant_id,
  'unbalanced_transaction'::TEXT AS issue,
  'financial_transactions'::TEXT AS entity,
  t.id                           AS entity_id,
  'soma ' || to_char(SUM(e.amount_signed), 'FM999999990.00')
    || ' em ' || t.event_type    AS detail,
  t.occurred_at                  AS occurred_at
FROM financial_transactions t
JOIN financial_entries e ON e.transaction_id = t.id
GROUP BY t.id, t.tenant_id, t.event_type, t.occurred_at
HAVING ABS(SUM(e.amount_signed)) > 0.005
   OR COUNT(*) < 2

UNION ALL

SELECT
  c.tenant_id, 'charge_without_entry', 'charges', c.id,
  'cobrança #' || c.charge_number || ' (' || c.source_module || ')',
  c.issue_date::timestamptz
FROM charges c
WHERE c.status <> 'cancelled'
  AND NOT EXISTS (SELECT 1 FROM financial_entries e WHERE e.charge_id = c.id)

UNION ALL

SELECT
  p.tenant_id, 'payable_without_entry', 'payables', p.id,
  p.source_module || ': ' || p.description,
  p.competence_date::timestamptz
FROM payables p
WHERE p.status <> 'cancelled'
  AND NOT EXISTS (SELECT 1 FROM financial_entries e WHERE e.payable_id = p.id)

UNION ALL

SELECT
  cc.tenant_id, 'credit_without_entry', 'customer_credits', cc.id,
  cc.origin || ' R$ ' || to_char(cc.amount, 'FM999999990.00'),
  cc.created_at
FROM customer_credits cc
WHERE NOT EXISTS (
  SELECT 1 FROM financial_transactions t
   WHERE t.source_module = 'customer_credit' AND t.source_id = cc.id)
  -- Crédito por cobrança cancelada é lançado com `source_module = 'payment'`,
  -- porque o fato que o originou é o RECEBIMENTO, não uma concessão de crédito.
  -- O elo com o pagamento é o que prova que ele foi lançado.
  AND cc.payment_id IS NULL

UNION ALL

SELECT
  p.tenant_id, 'payment_without_allocation', 'payments', p.id,
  'R$ ' || to_char(p.amount, 'FM999999990.00') || ' em ' || p.method,
  p.paid_at
FROM payments p
WHERE p.reversed_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM payment_allocations a WHERE a.payment_id = p.id)
  -- Recebimento de cobrança cancelada não quita nada por decisão (ADR 0033).
  AND NOT EXISTS (SELECT 1 FROM customer_credits cc WHERE cc.payment_id = p.id)

UNION ALL

SELECT
  i.tenant_id, 'paid_intent_without_payment', 'payment_intents', i.id,
  i.provider || ' — ' || COALESCE(i.provider_intent_id, 'sem id no provedor'),
  i.updated_at
FROM payment_intents i
WHERE i.status = 'paid'
  AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.payment_intent_id = i.id);

COMMENT ON VIEW financial_reconciliation IS
  'ADR 0034: uma linha por problema. Vazio é o estado saudável. Recebimento de cobrança cancelada não conta como problema — ele vira crédito do cliente por decisão (ADR 0033).';

GRANT SELECT ON financial_reconciliation TO authenticated, service_role;
