-- ---------------------------------------------------------------------------
-- O razão realiza o encargo que o provedor COBROU, não só o estimado (ADR 0037)
-- ---------------------------------------------------------------------------
-- Até aqui todo gateway congelava o valor na geração do código, e
-- `fn_confirm_gateway_payment` realizava exatamente o `accrued_amount` gravado
-- no intent (20260820204953_gateway_realiza_encargo.sql).
--
-- O Asaas emite Pix com vencimento (`cobv`) com multa e juros embutidos: quem
-- calcula o valor final é o banco do pagador, no dia em que paga. É o que
-- garante o encargo quando o cliente guarda o código e paga depois (ADR 0038,
-- P2). O valor pago passa a ser MAIOR que o do intent, e a diferença é
-- encargo — verificado no sandbox: `value 102.03`, `originalValue 100`,
-- `interestValue 2.03`.
--
-- Sem isto, a diferença entraria como pagamento e não como encargo: a cobrança
-- ficaria com saldo negativo e a receita de multa sumiria do DRE — o mesmo
-- defeito que a migration de 2026-08-20 corrigiu para o encargo do intent.
--
-- `p_extra_late_charge` DEFAULT 0: os demais gateways não mudam de
-- comportamento. O corpo é o da 20260907181350, alterado só nos três pontos
-- comentados.

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
  p_provider         TEXT DEFAULT NULL,
  p_extra_late_charge NUMERIC DEFAULT 0
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

  -- O encargo que o provedor somou está DENTRO do valor pago: nunca pode ser
  -- negativo nem maior que ele. Fora disso é adaptador mandando lixo, e
  -- realizar receita de multa a partir de lixo é pior que falhar.
  IF p_extra_late_charge IS NULL OR p_extra_late_charge < 0 OR p_extra_late_charge > p_amount THEN
    RAISE EXCEPTION 'EXTRA_LATE_CHARGE_OUT_OF_RANGE';
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
  -- Encargo realizado = o embutido no código na geração + o que o provedor
  -- somou depois, na hora de pagar (ADR 0037). Para quem congela o valor, o
  -- segundo é sempre 0 e nada muda.
  v_accrued := v_accrued + p_extra_late_charge;

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

-- Assinatura nova = função nova para o catálogo de privilégios. Sem repetir o
-- REVOKE, os default privileges do schema devolveriam EXECUTE a `authenticated`
-- e qualquer usuário logado confirmaria pagamento (ADR 0034).
REVOKE ALL ON FUNCTION fn_confirm_gateway_payment(
  UUID, UUID, NUMERIC, TIMESTAMPTZ, payment_method_type, TEXT, UUID, TEXT, NUMERIC
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION fn_confirm_gateway_payment(
  UUID, UUID, NUMERIC, TIMESTAMPTZ, payment_method_type, TEXT, UUID, TEXT, NUMERIC
) TO service_role;

COMMENT ON FUNCTION fn_confirm_gateway_payment IS
  'ADR 0030/0033/0034/0037: confirma pagamento de gateway numa transação. Cobrança cancelada credita o CLIENTE. p_extra_late_charge = encargo que o provedor somou no pagamento (Pix com vencimento), realizado junto do encargo do intent.';
