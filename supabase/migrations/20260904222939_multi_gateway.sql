-- ADR 0030 — Múltiplos gateways de pagamento, um ativo por tenant
--
-- A Spec 0014 tirou o Mercado Pago do schema. O que ficou faltando era a
-- aplicação usar isso: o provedor era escolhido por `import`, e a escrita da
-- conta batia numa parede de permissão que ninguém tinha exercitado.
--
-- Esta migration entrega três coisas:
--   1. os invariantes que faltavam (default tem que ser ativo, provider e
--      method deixam de ser texto livre);
--   2. a escrita da conta de gateway como RPC — `authenticated` continua sem
--      INSERT/UPDATE na tabela, o que é certo, porque a linha aponta para uma
--      credencial de pagamento no Vault;
--   3. o método do pagamento derivado do intent, em vez de assumido.

-- ---------------------------------------------------------------------------
-- 1. Invariantes
-- ---------------------------------------------------------------------------

-- `idx_provider_accounts_one_default` já garantia no máximo um default por
-- tenant. Não garantia que ele estivesse ATIVO — e um default inativo é
-- exatamente o estado em que a cobrança para de ser gerada sem ninguém saber
-- por quê. Desconectar o gateway eleito deixava o tenant nesse limbo.
ALTER TABLE payment_provider_accounts
  ADD CONSTRAINT payment_provider_accounts_default_must_be_active
  CHECK (NOT is_default OR active);

-- `provider` é texto livre de propósito: somar um gateway não deve exigir
-- migration (ADR 0030 §4). Mas texto livre aceitava `'Mercado Pago'`,
-- `'mercado_pago'` e `''` — contas órfãs que nenhum webhook resolve, porque a
-- resolução é por igualdade exata. O formato é a trava; a lista de provedores
-- válidos vive em @gomoto/core, onde ela pode crescer sem DDL.
ALTER TABLE payment_provider_accounts
  ADD CONSTRAINT payment_provider_accounts_provider_slug
  CHECK (provider ~ '^[a-z][a-z0-9_]{2,31}$');

COMMENT ON COLUMN payment_provider_accounts.active IS
  'A conta está conectada e a credencial vale. Estado "configurado".';

COMMENT ON COLUMN payment_provider_accounts.is_default IS
  'ADR 0030: o gateway que GERA as cobranças. No máximo um por tenant e sempre active. Configurar é uma coisa, cobrar é outra.';

-- `method` chegava como string livre da requisição do app. A rota aceitava
-- 'boleto', o provedor ignorava e gerava PIX (G-05). A validação real é contra
-- `descriptor.methods` do provedor, na aplicação; aqui fica o piso.
ALTER TABLE payment_intents
  ADD CONSTRAINT payment_intents_method_check
  CHECK (method IN ('pix', 'boleto', 'credit_card', 'payment_link'));

-- `account_email` identifica a conta para quem olha a tela ("qual conta é
-- essa?"). Foi adicionado na migration do Vault, que não regrantou nada, então
-- o callback gravava e a UI nunca podia ler (G-06). Não é segredo — o segredo
-- está no Vault e só sai por `fn_provider_credentials`.
GRANT SELECT (account_email) ON TABLE payment_provider_accounts TO authenticated;

-- ---------------------------------------------------------------------------
-- 2. Escrita da conta de gateway
-- ---------------------------------------------------------------------------
-- `REVOKE ALL ... FROM authenticated` na migration 12 tirou INSERT e UPDATE da
-- tabela, mas o callback OAuth e o disconnect continuaram escrevendo com o
-- cliente SSR — que roda como `authenticated`. Resultado em produção:
--
--   ERROR: permission denied for table payment_provider_accounts
--
-- e o usuário via `?payment=error&reason=db_error`. Conectar gateway nunca
-- funcionou depois da Spec 0014.
--
-- A correção não é regrantar: a linha é o ponteiro para uma credencial que
-- movimenta dinheiro. É passar a escrita por função com checagem de papel e de
-- tenant — o mesmo padrão de `set_tenant_member_role`.
--
-- Owner, não Admin: eleger o gateway que recebe o dinheiro da empresa é
-- decisão de dono. A Server Action também confere, mas o guard de dinheiro não
-- pode viver só na aplicação.

CREATE OR REPLACE FUNCTION fn_assert_gateway_owner(p_tenant_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_role TEXT;
BEGIN
  -- `service_role` é backend confiável (Edge Function, script de migração) e
  -- não tem papel de usuário.
  IF current_setting('role', true) = 'service_role' THEN
    RETURN;
  END IF;

  IF p_tenant_id NOT IN (SELECT get_user_tenants()) THEN
    RAISE EXCEPTION 'GATEWAY_WRONG_TENANT' USING ERRCODE = '42501';
  END IF;

  SELECT role INTO v_role
    FROM tenant_members
   WHERE user_id = auth.uid() AND tenant_id = p_tenant_id AND status = 'active';

  IF v_role IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION 'GATEWAY_OWNER_ONLY' USING ERRCODE = '42501';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION fn_assert_gateway_owner(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_assert_gateway_owner(UUID) TO authenticated, service_role;

-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION fn_connect_provider_account(
  p_tenant_id           UUID,
  p_provider            TEXT,
  p_external_account_id TEXT,
  p_account_email       TEXT,
  p_credentials         JSONB
)
RETURNS TABLE (account_id UUID, elected BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'vault'
AS $$
DECLARE
  v_account   UUID;
  v_old_secret UUID;
  v_secret    UUID;
  v_has_other BOOLEAN;
  v_elected   BOOLEAN;
BEGIN
  PERFORM fn_assert_gateway_owner(p_tenant_id);

  -- Serializa as conexões DESTE tenant.
  --
  -- A decisão "nasce eleito?" é ler-decidir-escrever, e não há linha para travar
  -- quando é a primeira conta. Duas conexões concorrentes de provedores
  -- diferentes leriam ambas "não há eleito", ambas gravariam `is_default` e uma
  -- morreria no índice único — erro de banco cru no rosto de quem só clicou em
  -- "Conectar". O lock é de transação: some sozinho no COMMIT.
  PERFORM pg_advisory_xact_lock(hashtext('gateway_account:' || p_tenant_id::text));

  IF p_credentials IS NULL OR p_credentials = '{}'::jsonb THEN
    RAISE EXCEPTION 'GATEWAY_EMPTY_CREDENTIALS' USING ERRCODE = '22023';
  END IF;

  -- Conectar NÃO elege. Um segundo gateway não pode redirecionar o dinheiro em
  -- silêncio; a troca é ato explícito, por `fn_set_default_provider_account`.
  -- Mas o primeiro precisa nascer eleito, senão o tenant conecta e nada cobra.
  SELECT EXISTS (
    SELECT 1 FROM payment_provider_accounts
     WHERE tenant_id = p_tenant_id AND is_default AND active
       AND NOT (provider = p_provider AND external_account_id = p_external_account_id)
  ) INTO v_has_other;

  v_elected := NOT v_has_other;

  INSERT INTO payment_provider_accounts AS a
    (tenant_id, provider, external_account_id, account_email, is_default, active)
  VALUES
    (p_tenant_id, p_provider, p_external_account_id, p_account_email, v_elected, true)
  ON CONFLICT (tenant_id, provider, external_account_id) DO UPDATE
    SET account_email = EXCLUDED.account_email,
        active        = true,
        -- Reconectar uma conta que já era a eleita a mantém eleita; reconectar
        -- uma secundária não a promove.
        is_default    = a.is_default OR v_elected
  RETURNING a.id, a.secret_id, a.is_default
    INTO v_account, v_old_secret, v_elected;

  -- O segredo anterior sai ANTES de o novo entrar.
  --
  -- `vault.secrets.name` é único, e o esquema herdado nomeava com
  -- `..._<epoch em segundos>` criando o novo primeiro. Reconectar a mesma conta
  -- duas vezes dentro do MESMO segundo estourava
  -- `duplicate key value violates unique constraint "secrets_name_idx"` —
  -- erro de banco cru para quem só clicou em "Reconectar". Apagar primeiro
  -- torna o nome estável e dispensa o carimbo de tempo.
  --
  -- Seguro porque é uma transação só: se a criação falhar, o rollback devolve o
  -- segredo antigo. Fora de transação esta ordem perderia a credencial.
  IF v_old_secret IS NOT NULL THEN
    DELETE FROM vault.secrets WHERE id = v_old_secret;
  END IF;

  -- Segredo e linha na MESMA transação. Antes eram duas chamadas do callback:
  -- falha entre elas deixava conta ativa sem credencial, e o erro seguinte era
  -- "integração não configurada" apontando para o lugar errado.
  v_secret := vault.create_secret(
    p_credentials::text,
    'provider_account_' || v_account::text,
    'Credenciais do gateway — conta ' || v_account::text
  );

  UPDATE payment_provider_accounts SET secret_id = v_secret WHERE id = v_account;

  RETURN QUERY SELECT v_account, v_elected;
END;
$$;

REVOKE ALL ON FUNCTION fn_connect_provider_account(UUID, TEXT, TEXT, TEXT, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_connect_provider_account(UUID, TEXT, TEXT, TEXT, JSONB) TO authenticated, service_role;

COMMENT ON FUNCTION fn_connect_provider_account IS
  'ADR 0030: conecta/reconecta gateway. Linha e segredo na mesma transação. Só o primeiro gateway nasce eleito.';

-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION fn_set_default_provider_account(p_account_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_tenant UUID;
  v_active BOOLEAN;
BEGIN
  -- FOR UPDATE porque a eleição é leitura-decisão-escrita sobre o conjunto de
  -- contas do tenant: dois cliques simultâneos em "Ativar" sem o lock deixam o
  -- rebaixamento de um sobrescrevendo a promoção do outro, e o tenant fica sem
  -- gateway eleito — nenhuma cobrança é gerada e nada no log explica.
  SELECT tenant_id, active INTO v_tenant, v_active
    FROM payment_provider_accounts WHERE id = p_account_id FOR UPDATE;

  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'GATEWAY_ACCOUNT_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  PERFORM fn_assert_gateway_owner(v_tenant);

  IF NOT v_active THEN
    RAISE EXCEPTION 'GATEWAY_ACCOUNT_INACTIVE' USING ERRCODE = '23514';
  END IF;

  -- Rebaixa antes de promover: o índice único parcial não tolera dois defaults
  -- nem por um instante dentro da transação.
  UPDATE payment_provider_accounts
     SET is_default = false
   WHERE tenant_id = v_tenant AND is_default AND id <> p_account_id;

  UPDATE payment_provider_accounts
     SET is_default = true
   WHERE id = p_account_id;

  -- QR pendente de OUTRO gateway deixa de ser oferecido pelo app: o tenant
  -- escolheu onde quer receber. Um pagamento tardio nesse QR continua sendo
  -- reconhecido — `fn_confirm_gateway_payment` não olha o status do intent,
  -- justamente para que dinheiro que entrou nunca fique sem registro.
  UPDATE payment_intents
     SET status = 'expired'
   WHERE tenant_id = v_tenant
     AND status = 'pending'
     AND provider_account_id <> p_account_id;
END;
$$;

REVOKE ALL ON FUNCTION fn_set_default_provider_account(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_set_default_provider_account(UUID) TO authenticated, service_role;

-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION fn_disconnect_provider_account(p_account_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_tenant UUID;
BEGIN
  SELECT tenant_id INTO v_tenant
    FROM payment_provider_accounts WHERE id = p_account_id FOR UPDATE;

  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'GATEWAY_ACCOUNT_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  PERFORM fn_assert_gateway_owner(v_tenant);

  -- Desativa em vez de apagar: `payment_intents.provider_account_id` é
  -- ON DELETE RESTRICT e o histórico de tentativas precisa continuar
  -- rastreável (ADR 0024, Princípio 3).
  --
  -- O segredo NÃO é apagado do Vault: o webhook resolve a conta pelo
  -- `external_account_id` sem filtrar por `active`, e precisa do token para
  -- consultar o pagamento. Dinheiro que entra depois de desconectar ainda é
  -- reconhecido. O segredo só some quando a conta é reconectada (rotação).
  UPDATE payment_provider_accounts
     SET active = false, is_default = false
   WHERE id = p_account_id;

  UPDATE payment_intents
     SET status = 'expired'
   WHERE provider_account_id = p_account_id AND status = 'pending';
END;
$$;

REVOKE ALL ON FUNCTION fn_disconnect_provider_account(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_disconnect_provider_account(UUID) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. O método do pagamento vem do intent
-- ---------------------------------------------------------------------------
-- `p_method DEFAULT 'pix'` e o webhook nunca passando nada: um pagamento por
-- cartão entraria no razão como PIX. Enquanto só existe PIX isso é invisível —
-- e é justamente por isso que precisa ser corrigido antes do segundo gateway.

CREATE OR REPLACE FUNCTION fn_confirm_gateway_payment(
  p_tenant_id   UUID,
  p_intent_id   UUID,
  p_amount      NUMERIC,
  p_paid_at     TIMESTAMPTZ,
  p_method      payment_method_type DEFAULT NULL,
  p_notes       TEXT DEFAULT 'Confirmado pelo gateway'
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
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'AMOUNT_MUST_BE_POSITIVE';
  END IF;

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
                        payment_intent_id, notes)
  VALUES (p_tenant_id, v_customer_id, p_amount, v_method, p_paid_at,
          p_intent_id, p_notes)
  RETURNING id INTO v_payment_id;

  INSERT INTO payment_allocations (tenant_id, payment_id, charge_id, amount)
  VALUES (p_tenant_id, v_payment_id, v_charge_id, p_amount);

  PERFORM post_financial_transaction(
    p_tenant_id,
    jsonb_build_object(
      'event_type',    'payment_received',
      'description',   'Recebimento via gateway — cobrança #' || v_number,
      'occurred_at',   p_paid_at,
      'source_module', 'payment',
      'source_id',     v_payment_id
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

-- ---------------------------------------------------------------------------
-- 4. Rotação de credencial pelo mesmo esquema de nome
-- ---------------------------------------------------------------------------
-- `fn_store_provider_credentials` (migration do Vault) carrega o mesmo defeito:
-- cria o segredo novo antes de apagar o antigo, com o segundo corrente no nome.
-- Duas rotações no mesmo segundo colidem em `secrets_name_idx`.
--
-- Ela continua existindo por ser o caminho de ROTAÇÃO de uma conta que já
-- existe — é dela que o refresh de token vai depender —, enquanto
-- `fn_connect_provider_account` cria a conta e a credencial de uma vez.

CREATE OR REPLACE FUNCTION fn_store_provider_credentials(
  p_account_id    UUID,
  p_access_token  TEXT,
  p_refresh_token TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'vault'
AS $$
DECLARE
  v_tenant UUID;
  v_old    UUID;
  v_secret UUID;
BEGIN
  SELECT tenant_id, secret_id INTO v_tenant, v_old
    FROM payment_provider_accounts WHERE id = p_account_id FOR UPDATE;

  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'Conta de provedor não encontrada' USING ERRCODE = 'no_data_found';
  END IF;

  -- SECURITY DEFINER ignora RLS, então a checagem de tenant é feita aqui: sem
  -- ela, qualquer autenticado gravaria credencial na conta de outra empresa.
  -- `service_role` é backend confiável e não tem tenant de usuário.
  IF current_setting('role', true) IS DISTINCT FROM 'service_role'
     AND v_tenant NOT IN (SELECT get_user_tenants()) THEN
    RAISE EXCEPTION 'Conta de provedor de outro tenant' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF v_old IS NOT NULL THEN
    DELETE FROM vault.secrets WHERE id = v_old;
  END IF;

  v_secret := vault.create_secret(
    jsonb_build_object('access_token', p_access_token, 'refresh_token', p_refresh_token)::text,
    'provider_account_' || p_account_id::text,
    'Credenciais do gateway — conta ' || p_account_id::text
  );

  UPDATE payment_provider_accounts SET secret_id = v_secret WHERE id = p_account_id;

  RETURN v_secret;
END;
$$;
