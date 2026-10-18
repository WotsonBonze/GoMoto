-- ADR 0031 — Renovação de credencial de gateway
--
-- O access_token da Cora vale 24 HORAS, e o refresh token é ROTATIVO: renovar
-- devolve um novo, e o anterior sobrevive a no máximo 3 usos. Sem renovação,
-- toda cobrança a partir do segundo dia falha; com renovação descoordenada,
-- duas requisições concorrentes queimam a janela de rotação e derrubam a
-- conexão da locadora inteira.
--
-- (O Mercado Pago esconde o problema: token de ~180 dias. `refresh` existia no
-- código sem um único chamador — o G-08 da ADR 0030.)

-- ---------------------------------------------------------------------------
-- 1. Posse da renovação
-- ---------------------------------------------------------------------------

ALTER TABLE payment_provider_accounts
  ADD COLUMN refresh_claimed_at TIMESTAMPTZ;

COMMENT ON COLUMN payment_provider_accounts.refresh_claimed_at IS
  'ADR 0031: quem está renovando a credencial agora. Lease com prazo — chamada HTTP morre no meio, e posse sem validade é integração travada até alguém mexer no banco.';

-- ---------------------------------------------------------------------------
-- 2. Gravar credencial de formato livre
-- ---------------------------------------------------------------------------
-- `fn_store_provider_credentials(uuid, text, text)` monta o JSON internamente
-- com `access_token`/`refresh_token` fixos — não cabe `expires_at`, e não
-- caberia o formato de um provedor que não use esses dois nomes.
--
-- A sobrecarga JSONB passa a ser a canônica; a de três argumentos continua
-- existindo (a suíte a usa para semear) delegando para ela.

CREATE OR REPLACE FUNCTION fn_store_provider_credentials(
  p_account_id  UUID,
  p_credentials JSONB
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
  IF p_credentials IS NULL OR p_credentials = '{}'::jsonb THEN
    RAISE EXCEPTION 'GATEWAY_EMPTY_CREDENTIALS' USING ERRCODE = '22023';
  END IF;

  SELECT tenant_id, secret_id INTO v_tenant, v_old
    FROM payment_provider_accounts WHERE id = p_account_id FOR UPDATE;

  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'GATEWAY_ACCOUNT_NOT_FOUND' USING ERRCODE = 'no_data_found';
  END IF;

  -- SECURITY DEFINER ignora RLS, então a checagem de tenant é feita aqui.
  -- `service_role` é backend confiável e não tem tenant de usuário — é ele quem
  -- renova, a partir da rota de cobrança.
  IF current_setting('role', true) IS DISTINCT FROM 'service_role'
     AND v_tenant NOT IN (SELECT get_user_tenants()) THEN
    RAISE EXCEPTION 'GATEWAY_WRONG_TENANT' USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- O antigo sai antes de o novo entrar: `vault.secrets.name` é único e o nome
  -- é estável por conta. Seguro porque é uma transação só.
  IF v_old IS NOT NULL THEN
    DELETE FROM vault.secrets WHERE id = v_old;
  END IF;

  v_secret := vault.create_secret(
    p_credentials::text,
    'provider_account_' || p_account_id::text,
    'Credenciais do gateway — conta ' || p_account_id::text
  );

  -- Gravar a credencial nova ENCERRA a posse: quem renovou terminou.
  UPDATE payment_provider_accounts
     SET secret_id = v_secret, refresh_claimed_at = NULL
   WHERE id = p_account_id;

  RETURN v_secret;
END;
$$;

REVOKE ALL ON FUNCTION fn_store_provider_credentials(UUID, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_store_provider_credentials(UUID, JSONB) TO authenticated, service_role;

COMMENT ON FUNCTION fn_store_provider_credentials(UUID, JSONB) IS
  'ADR 0031: grava a credencial no Vault com o formato que o provedor usa. Encerra a posse da renovação.';

-- A versão de 3 argumentos vira um atalho para a de cima.
CREATE OR REPLACE FUNCTION fn_store_provider_credentials(
  p_account_id    UUID,
  p_access_token  TEXT,
  p_refresh_token TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public', 'vault'
AS $$
  SELECT fn_store_provider_credentials(
    p_account_id,
    jsonb_build_object('access_token', p_access_token, 'refresh_token', p_refresh_token)
  );
$$;

-- ---------------------------------------------------------------------------
-- 3. Reivindicar a renovação
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION fn_claim_credential_refresh(
  p_account_id    UUID,
  p_lease_seconds INT DEFAULT 90
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'vault'
AS $$
DECLARE
  v_tenant  UUID;
  v_secret  UUID;
  v_claimed TIMESTAMPTZ;
BEGIN
  -- FOR UPDATE serializa a decisão: sem ele, duas requisições leem
  -- `refresh_claimed_at IS NULL` ao mesmo tempo, as duas renovam, e a rotação
  -- da Cora (3 usos do token anterior) é gasta à toa.
  SELECT tenant_id, secret_id, refresh_claimed_at
    INTO v_tenant, v_secret, v_claimed
    FROM payment_provider_accounts
   WHERE id = p_account_id
     FOR UPDATE;

  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'GATEWAY_ACCOUNT_NOT_FOUND' USING ERRCODE = 'no_data_found';
  END IF;

  IF current_setting('role', true) IS DISTINCT FROM 'service_role'
     AND v_tenant NOT IN (SELECT get_user_tenants()) THEN
    RAISE EXCEPTION 'GATEWAY_WRONG_TENANT' USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Posse viva de outra requisição: quem perde a corrida NÃO renova. Devolve
  -- NULL e o chamador segue com a credencial atual, que ainda vale — a
  -- renovação dispara com margem antes do vencimento, não no vencimento.
  IF v_claimed IS NOT NULL AND v_claimed > now() - make_interval(secs => p_lease_seconds) THEN
    RETURN NULL;
  END IF;

  UPDATE payment_provider_accounts
     SET refresh_claimed_at = now()
   WHERE id = p_account_id;

  IF v_secret IS NULL THEN
    RAISE EXCEPTION 'GATEWAY_NO_CREDENTIALS' USING ERRCODE = 'no_data_found';
  END IF;

  RETURN (SELECT decrypted_secret::jsonb FROM vault.decrypted_secrets WHERE id = v_secret);
END;
$$;

REVOKE ALL ON FUNCTION fn_claim_credential_refresh(UUID, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_claim_credential_refresh(UUID, INT) TO authenticated, service_role;

COMMENT ON FUNCTION fn_claim_credential_refresh IS
  'ADR 0031: reivindica a renovação da credencial. Devolve a credencial atual a quem ganhou a corrida, NULL a quem perdeu. Lease expira sozinho se a chamada HTTP morrer.';

-- ---------------------------------------------------------------------------
-- 4. Soltar uma posse que falhou
-- ---------------------------------------------------------------------------
-- A renovação pode falhar sem gravar credencial nova (rede, 400 do provedor).
-- Esperar o lease vencer atrasaria a próxima tentativa por até 90s à toa.

CREATE OR REPLACE FUNCTION fn_release_credential_refresh(p_account_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_tenant UUID;
BEGIN
  SELECT tenant_id INTO v_tenant FROM payment_provider_accounts WHERE id = p_account_id;
  IF v_tenant IS NULL THEN RETURN; END IF;

  IF current_setting('role', true) IS DISTINCT FROM 'service_role'
     AND v_tenant NOT IN (SELECT get_user_tenants()) THEN
    RAISE EXCEPTION 'GATEWAY_WRONG_TENANT' USING ERRCODE = 'insufficient_privilege';
  END IF;

  UPDATE payment_provider_accounts SET refresh_claimed_at = NULL WHERE id = p_account_id;
END;
$$;

REVOKE ALL ON FUNCTION fn_release_credential_refresh(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_release_credential_refresh(UUID) TO authenticated, service_role;
