-- ADR 0031 — `account_email` deixa de mentir
--
-- A coluna nasceu quando só existia o Mercado Pago, que devolve o e-mail da
-- conta. A Cora não devolve e-mail nenhum: o que identifica a conta para quem
-- olha a tela é o CNPJ, que vem no claim `cnpj` do access token.
--
-- O propósito da coluna sempre foi "como o usuário reconhece QUAL conta é
-- aquela" (ADR 0030). O nome é que estava preso ao primeiro provedor. Sem a
-- renomeação, a alternativa era a tela mostrar `cdc0cb16-3a84-4be9-88db-...`
-- ao lado de "Cora" — um UUID que não diz nada a ninguém.

ALTER TABLE payment_provider_accounts RENAME COLUMN account_email TO account_label;

COMMENT ON COLUMN payment_provider_accounts.account_label IS
  'ADR 0031: identificação legível da conta no provedor — e-mail no Mercado Pago, CNPJ na Cora. Não é segredo: o segredo mora no Vault.';

-- O GRANT acompanha o nome.
GRANT SELECT (account_label) ON TABLE payment_provider_accounts TO authenticated;

-- `fn_connect_provider_account` referencia a coluna pelo nome antigo, e o
-- parâmetro correspondente também muda de nome. `CREATE OR REPLACE` recusa
-- renomear parâmetro (42P13), então a função é derrubada e recriada.
--
-- DROP e CREATE na mesma migration: entre um e outro a função não existe, mas
-- a migration inteira roda em uma transação, então nenhuma requisição enxerga
-- o intervalo.

DROP FUNCTION IF EXISTS fn_connect_provider_account(UUID, TEXT, TEXT, TEXT, JSONB);

CREATE OR REPLACE FUNCTION fn_connect_provider_account(
  p_tenant_id           UUID,
  p_provider            TEXT,
  p_external_account_id TEXT,
  p_account_label       TEXT,
  p_credentials         JSONB
)
RETURNS TABLE (account_id UUID, elected BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'vault'
AS $$
DECLARE
  v_account    UUID;
  v_old_secret UUID;
  v_secret     UUID;
  v_has_other  BOOLEAN;
  v_elected    BOOLEAN;
BEGIN
  PERFORM fn_assert_gateway_owner(p_tenant_id);
  PERFORM pg_advisory_xact_lock(hashtext('gateway_account:' || p_tenant_id::text));

  IF p_credentials IS NULL OR p_credentials = '{}'::jsonb THEN
    RAISE EXCEPTION 'GATEWAY_EMPTY_CREDENTIALS' USING ERRCODE = '22023';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM payment_provider_accounts
     WHERE tenant_id = p_tenant_id AND is_default AND active
       AND NOT (provider = p_provider AND external_account_id = p_external_account_id)
  ) INTO v_has_other;

  v_elected := NOT v_has_other;

  INSERT INTO payment_provider_accounts AS a
    (tenant_id, provider, external_account_id, account_label, is_default, active)
  VALUES
    (p_tenant_id, p_provider, p_external_account_id, p_account_label, v_elected, true)
  ON CONFLICT (tenant_id, provider, external_account_id) DO UPDATE
    SET account_label = EXCLUDED.account_label,
        active        = true,
        is_default    = a.is_default OR v_elected
  RETURNING a.id, a.secret_id, a.is_default
    INTO v_account, v_old_secret, v_elected;

  IF v_old_secret IS NOT NULL THEN
    DELETE FROM vault.secrets WHERE id = v_old_secret;
  END IF;

  v_secret := vault.create_secret(
    p_credentials::text,
    'provider_account_' || v_account::text,
    'Credenciais do gateway — conta ' || v_account::text
  );

  UPDATE payment_provider_accounts
     SET secret_id = v_secret, refresh_claimed_at = NULL
   WHERE id = v_account;

  RETURN QUERY SELECT v_account, v_elected;
END;
$$;

REVOKE ALL ON FUNCTION fn_connect_provider_account(UUID, TEXT, TEXT, TEXT, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_connect_provider_account(UUID, TEXT, TEXT, TEXT, JSONB) TO authenticated, service_role;

COMMENT ON FUNCTION fn_connect_provider_account IS
  'ADR 0030/0031: conecta/reconecta gateway. Linha e segredo na mesma transação. Só o primeiro gateway nasce eleito.';
