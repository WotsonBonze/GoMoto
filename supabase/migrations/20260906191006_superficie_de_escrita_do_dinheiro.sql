-- ADR 0034 — Fase 2: quem consegue escrever no caminho do dinheiro
--
-- Quatro capacidades estavam concedidas a `authenticated`. Nenhuma delas é
-- alcançável anonimamente — mas `authenticated` aqui é qualquer membro da
-- locadora, inclusive `viewer`, e o alcance é o NAVEGADOR: o PostgREST atende
-- essas chamadas com a anon key mais o JWT do usuário, sem passar por uma linha
-- do nosso código.
--
-- O princípio que faltava: QUEM DECIDE O QUE É ALCANÇÁVEL É O GRANT, NÃO O
-- CHAMADOR. Uma Server Action rodar no servidor não protege nada se a RPC que
-- ela chama também atende o navegador com o mesmo papel.

-- ---------------------------------------------------------------------------
-- 1. O razão deixa de aceitar INSERT direto
-- ---------------------------------------------------------------------------
-- `post_financial_transaction` é SECURITY DEFINER desde que existe. O grant de
-- INSERT nas duas tabelas era, portanto, desnecessário desde sempre — e com
-- ele um membro postava lançamentos forjados escolhendo `created_by`,
-- `event_type` e `source_module`. O `trg_entries_balanced` só exige que a
-- transação some zero; a exigência de DUAS PERNAS mora na RPC, que o INSERT
-- direto contorna.
--
-- SELECT continua: o DRE, o razão e os relatórios leem estas tabelas sob RLS.

REVOKE INSERT ON TABLE financial_transactions FROM authenticated;
REVOKE INSERT ON TABLE financial_entries      FROM authenticated;

COMMENT ON TABLE financial_transactions IS
  'Spec 0014: fato financeiro. Append-only — correção é transação de estorno, nunca UPDATE. ADR 0034: escrita só por post_financial_transaction (SECURITY DEFINER).';

-- ---------------------------------------------------------------------------
-- 2. Marcar estorno exige que o razão já tenha estornado
-- ---------------------------------------------------------------------------
-- `fn_protect_payment` blindava valor, método, data e cliente. Não blindava
-- `reversed_at` — e `charge_balances` filtra as alocações por
-- `p.reversed_at IS NULL`:
--
--   UPDATE payments SET reversed_at = now(), reversal_reason = 'x' WHERE ...
--
-- A cobrança REABRE, o cliente volta a dever, e o razão continua mostrando o
-- dinheiro em `caixa_e_bancos`. Divergência permanente entre recebíveis e
-- razão, sem transação de estorno, sem `reversed_by`, sem `audit_logs`.
--
-- A trava NÃO é uma flag de sessão (`set_config` é chamável por
-- `authenticated`, então seria forjável). É estrutural: o estorno no razão tem
-- que EXISTIR antes da marca. `fn_reverse_payment` já satisfaz isso por
-- construção — ela lança as transações invertidas ANTES de tocar em `payments`,
-- e foi escrita nessa ordem justamente porque a ordem inversa já produziu esta
-- divergência uma vez (2026-08-17).

CREATE OR REPLACE FUNCTION fn_protect_payment()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.amount      IS DISTINCT FROM OLD.amount      OR
     NEW.method      IS DISTINCT FROM OLD.method      OR
     NEW.paid_at     IS DISTINCT FROM OLD.paid_at     OR
     NEW.customer_id IS DISTINCT FROM OLD.customer_id
  THEN
    RAISE EXCEPTION
      'Pagamento % é imutável em valor, método, data e cliente (ADR 0024, Princípio 3). Corrija por estorno.',
      OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.reversed_at IS NOT NULL AND NEW.reversed_at IS DISTINCT FROM OLD.reversed_at THEN
    RAISE EXCEPTION 'Pagamento % já estornado: estorno não se desfaz.', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  -- A origem do recebimento não se reescreve: seria apagar de quem o dinheiro
  -- veio depois de ele ter entrado.
  IF NEW.gateway_event_id   IS DISTINCT FROM OLD.gateway_event_id OR
     NEW.received_by_system IS DISTINCT FROM OLD.received_by_system OR
     NEW.received_by        IS DISTINCT FROM OLD.received_by
  THEN
    RAISE EXCEPTION
      'Pagamento % é imutável na origem (ADR 0034). Quem recebeu e o que causou o recebimento não mudam.',
      OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  -- Marcar como estornado exige o estorno JÁ LANÇADO no razão.
  IF OLD.reversed_at IS NULL AND NEW.reversed_at IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
         FROM financial_transactions r
         JOIN financial_transactions o ON o.id = r.reverses_transaction_id
        WHERE r.tenant_id     = NEW.tenant_id
          AND o.source_module = 'payment'
          AND o.source_id     = NEW.id
     )
  THEN
    RAISE EXCEPTION
      'Pagamento % não pode ser marcado como estornado sem estorno no razão (ADR 0034). Use fn_reverse_payment.',
      OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION fn_protect_payment IS
  'ADR 0024/0034: pagamento é imutável em valor, método, data, cliente e origem. `reversed_at` só é aceito depois de o estorno existir no razão.';

-- ---------------------------------------------------------------------------
-- 3. A credencial do gateway sai do alcance do navegador
-- ---------------------------------------------------------------------------
-- `fn_provider_credentials` conferia apenas PERTENCIMENTO AO TENANT e estava
-- concedida a `authenticated`. Um POST em /rest/v1/rpc/fn_provider_credentials
-- devolvia `access_token` e `refresh_token` em texto puro — para qualquer
-- membro, inclusive `viewer`. O `account_id` é legível pelos grants de coluna
-- da própria tabela.
--
-- O contraste dizia tudo: CONECTAR e ELEGER gateway exigem `owner`
-- (`fn_assert_gateway_owner`). LER O TOKEN exigia só estar na empresa.
--
-- A defesa de manter isto sob RLS ("a garantia é do banco, não uma comparação
-- escrita à mão") vale para LINHAS. A RLS decide quais linhas um papel enxerga;
-- ela não tem gradação de papel dentro do tenant. Um segredo do Vault não é uma
-- linha do tenant — é uma capacidade.
--
-- As quatro funções saem juntas porque as quatro tocam o segredo: uma devolve,
-- uma devolve e reivindica, uma grava e uma libera a posse. Deixar qualquer uma
-- para trás deixaria uma porta com a mesma chave.

REVOKE EXECUTE ON FUNCTION fn_provider_credentials(UUID)              FROM authenticated;
REVOKE EXECUTE ON FUNCTION fn_claim_credential_refresh(UUID, INT)     FROM authenticated;
REVOKE EXECUTE ON FUNCTION fn_release_credential_refresh(UUID)        FROM authenticated;
REVOKE EXECUTE ON FUNCTION fn_store_provider_credentials(UUID, JSONB) FROM authenticated;
REVOKE EXECUTE ON FUNCTION fn_store_provider_credentials(UUID, TEXT, TEXT) FROM authenticated;

COMMENT ON FUNCTION fn_provider_credentials IS
  'ADR 0034: devolve a credencial do gateway. SERVICE_ROLE apenas — a checagem de tenant lá dentro protege contra o outro tenant, não contra o outro papel do mesmo tenant.';

-- `fn_connect_provider_account` CONTINUA com `authenticated`: ela é o caminho
-- de conexão pela tela, já é `owner`-only por dentro, e não devolve segredo
-- nenhum — grava.

-- ---------------------------------------------------------------------------
-- 4. `payment_intents` deixa de ser escrita direta do navegador
-- ---------------------------------------------------------------------------
-- `GRANT ALL` mais policy `FOR ALL`: qualquer membro dava UPDATE ou DELETE nos
-- intents do próprio tenant. Apagar um intent zera `payments.payment_intent_id`
-- (ON DELETE SET NULL) e corta a ligação entre o recebimento e a tentativa que
-- o originou — exatamente o histórico que o ON DELETE RESTRICT em
-- `provider_account_id` foi criado para preservar.

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES
  ON TABLE payment_intents FROM authenticated;

-- A policy passa a dizer o que de fato acontece. Era `FOR ALL`, o que sugeria
-- uma escrita que agora não existe — e teria voltado a existir sozinha no dia
-- em que alguém regrantasse a tabela. Mesmo defeito que a `audit_logs` teve
-- (RNF-005) e pelo mesmo motivo.
DROP POLICY IF EXISTS tenant_isolation_payment_intents ON payment_intents;

CREATE POLICY tenant_isolation_payment_intents ON payment_intents
  FOR SELECT TO authenticated
  USING (tenant_id IN (SELECT get_user_tenants()));

-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION fn_expire_payment_intent(p_intent_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_tenant UUID;
BEGIN
  SELECT tenant_id INTO v_tenant FROM payment_intents WHERE id = p_intent_id;
  IF v_tenant IS NULL THEN RETURN; END IF;

  IF current_setting('role', true) IS DISTINCT FROM 'service_role'
     AND v_tenant NOT IN (SELECT get_user_tenants()) THEN
    RAISE EXCEPTION 'INTENT_WRONG_TENANT' USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Só `pending` expira. Um intent já pago não volta atrás, e uma corrida entre
  -- a expiração por tempo e a confirmação do webhook tem que perder para o
  -- webhook: dinheiro que entrou vale mais que um relógio.
  UPDATE payment_intents
     SET status = 'expired'
   WHERE id = p_intent_id AND status = 'pending';
END;
$$;

REVOKE ALL ON FUNCTION fn_expire_payment_intent(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_expire_payment_intent(UUID) TO authenticated, service_role;

COMMENT ON FUNCTION fn_expire_payment_intent IS
  'ADR 0034: expira uma tentativa pendente. Substitui o UPDATE direto que o navegador alcançava.';

-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION fn_open_payment_intent(
  p_tenant_id           UUID,
  p_charge_id           UUID,
  p_provider            TEXT,
  p_provider_account_id UUID,
  p_method              TEXT,
  p_provider_intent_id  TEXT,
  p_amount              NUMERIC,
  p_accrued_amount      NUMERIC,
  p_expires_at          TIMESTAMPTZ,
  p_payload             JSONB
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_intent_id UUID;
BEGIN
  -- SECURITY DEFINER ignora RLS: a checagem que a policy fazia passa a ser
  -- explícita. É a troca que a ADR 0034 aceita de olhos abertos — o argumento
  -- de que a RLS é melhor que comparação à mão continua verdadeiro em geral, e
  -- perde aqui porque `payment_intents` guarda a ÚNICA ligação entre dinheiro e
  -- tentativa, e essa ligação não pode depender de todo membro se comportar.
  IF current_setting('role', true) IS DISTINCT FROM 'service_role'
     AND p_tenant_id NOT IN (SELECT get_user_tenants()) THEN
    RAISE EXCEPTION 'INTENT_WRONG_TENANT' USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- A cobrança tem que ser do tenant que está cobrando. Sem isto, o
  -- SECURITY DEFINER permitiria abrir uma tentativa contra cobrança alheia.
  IF NOT EXISTS (
    SELECT 1 FROM charges
     WHERE id = p_charge_id AND tenant_id = p_tenant_id
  ) THEN
    RAISE EXCEPTION 'CHARGE_NOT_FOUND' USING ERRCODE = 'no_data_found';
  END IF;

  -- A conta de gateway idem — ela é quem aponta para a credencial.
  IF NOT EXISTS (
    SELECT 1 FROM payment_provider_accounts
     WHERE id = p_provider_account_id AND tenant_id = p_tenant_id
  ) THEN
    RAISE EXCEPTION 'GATEWAY_ACCOUNT_NOT_FOUND' USING ERRCODE = 'no_data_found';
  END IF;

  -- `idx_payment_intents_one_pending_per_charge` continua sendo quem decide a
  -- corrida. O 23505 sobe para o chamador, que já sabe reaproveitar o QR
  -- vencedor em vez de mostrar erro a quem tem um código válido na mão.
  INSERT INTO payment_intents (
    tenant_id, charge_id, provider, provider_account_id, method,
    provider_intent_id, amount, accrued_amount, status, expires_at, payload
  )
  VALUES (
    p_tenant_id, p_charge_id, p_provider, p_provider_account_id, p_method,
    p_provider_intent_id, p_amount, p_accrued_amount, 'pending', p_expires_at, p_payload
  )
  RETURNING id INTO v_intent_id;

  RETURN v_intent_id;
END;
$$;

REVOKE ALL ON FUNCTION fn_open_payment_intent(
  UUID, UUID, TEXT, UUID, TEXT, TEXT, NUMERIC, NUMERIC, TIMESTAMPTZ, JSONB
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_open_payment_intent(
  UUID, UUID, TEXT, UUID, TEXT, TEXT, NUMERIC, NUMERIC, TIMESTAMPTZ, JSONB
) TO authenticated, service_role;

COMMENT ON FUNCTION fn_open_payment_intent IS
  'ADR 0034: abre uma tentativa de pagamento. Substitui o INSERT direto — a checagem de tenant sai da RLS e vira explícita, porque a tabela deixou de ser escrevível pelo navegador.';
