-- ---------------------------------------------------------------------------
-- Ciclo de vida e trilha das integrações de pagamento (ADR 0039)
-- ---------------------------------------------------------------------------
-- Conectar → (Ativar) → Desconectar → Excluir, com UMA integração por provedor
-- por locadora, e toda mudança registrada em `audit_logs` pelo banco.
--
-- "Excluir" não apaga a linha: `payment_intents` aponta para ela (ON DELETE
-- RESTRICT), e por trás dos intents estão pagamentos e lançamentos do razão
-- (ADR 0024, Princípio 3). Excluir = credencial apagada do Vault + `deleted_at`.
-- A linha fica como histórico e sai da tela e da unicidade.

-- ── 1. Colunas ────────────────────────────────────────────────────────────

ALTER TABLE payment_provider_accounts
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_by UUID REFERENCES auth.users(id) ON DELETE SET NULL;

-- Excluída nunca está conectada nem cobrando: o estado é coerente por
-- construção, não por disciplina de quem escreve.
ALTER TABLE payment_provider_accounts
  ADD CONSTRAINT payment_provider_accounts_deleted_is_inactive
  CHECK (deleted_at IS NULL OR (NOT active AND NOT is_default AND secret_id IS NULL));

-- `authenticated` lê esta tabela por GRANT DE COLUNA (é o que esconde o
-- `secret_id`). Coluna nova não entra sozinha: sem isto, o filtro
-- `deleted_at IS NULL` da tela responde 403 e a lista de gateways some —
-- pego no teste pelo navegador, invisível para typecheck e testes.
GRANT SELECT (deleted_at) ON payment_provider_accounts TO authenticated;

COMMENT ON COLUMN payment_provider_accounts.deleted_at IS
  'ADR 0039: integração excluída — credencial apagada, fora da tela e da unicidade. A linha fica porque intents e pagamentos apontam para ela.';

-- ── 2. Trilha: toda mudança de integração em audit_logs ───────────────────
--
-- Trigger, e não a aplicação: a trilha que mora só na aplicação some no
-- primeiro caminho que não passa por ela (ADR 0034). Uma linha por mudança de
-- linha, com a ação semântica, o autor e o e-mail do autor no momento —
-- `tenant_members` não guarda e-mail e `auth.users` não é legível pela tela.
--
-- A credencial NUNCA entra, nem o `secret_id`. A renovação automática de token
-- (só `secret_id`/`refresh_claimed_at` mudam) não gera linha aqui: ela já é
-- `token_refreshed`, gravada por `fn_store_provider_credentials`.
--
-- `gomoto.gateway_action = 'connect'` é marcado por `fn_connect_provider_account`
-- e distingue "uma pessoa reconectou" de "o sistema renovou o token".

CREATE OR REPLACE FUNCTION fn_audit_provider_account()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_action  TEXT;
  v_marker  TEXT := COALESCE(current_setting('gomoto.gateway_action', true), '');
  v_uid     UUID := auth.uid();
  v_email   TEXT;
  v_system  TEXT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_action := 'gateway_connected';
  ELSIF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN
    v_action := 'gateway_deleted';
  ELSIF v_marker = 'connect' THEN
    v_action := 'gateway_reconnected';
  ELSIF OLD.active AND NOT NEW.active THEN
    v_action := 'gateway_disconnected';
  ELSIF NOT OLD.is_default AND NEW.is_default THEN
    v_action := 'gateway_activated';
  ELSIF OLD.is_default AND NOT NEW.is_default THEN
    v_action := 'gateway_deactivated';
  ELSE
    -- Refresh de token, carimbo de posse, `updated_at`: não é decisão de
    -- ninguém sobre a integração.
    RETURN NEW;
  END IF;

  IF v_uid IS NOT NULL THEN
    SELECT email INTO v_email FROM auth.users WHERE id = v_uid;
  ELSE
    v_system := COALESCE(NULLIF(current_setting('gomoto.actor_system', true), ''), 'system:database');
  END IF;

  INSERT INTO audit_logs (tenant_id, user_id, actor_system, action, table_name, record_id, old_data, new_data)
  VALUES (
    NEW.tenant_id,
    v_uid,
    v_system,
    v_action,
    'payment_provider_accounts',
    NEW.id,
    CASE WHEN TG_OP = 'UPDATE' THEN jsonb_build_object(
      'active', OLD.active, 'is_default', OLD.is_default, 'account_label', OLD.account_label,
      'external_account_id', OLD.external_account_id
    ) END,
    jsonb_build_object(
      'provider', NEW.provider,
      'external_account_id', NEW.external_account_id,
      'account_label', NEW.account_label,
      'active', NEW.active,
      'is_default', NEW.is_default,
      'deleted_at', NEW.deleted_at,
      'actor_email', v_email
    )
  );

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION fn_audit_provider_account() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_audit_provider_account ON payment_provider_accounts;
CREATE TRIGGER trg_audit_provider_account
  AFTER INSERT OR UPDATE ON payment_provider_accounts
  FOR EACH ROW EXECUTE FUNCTION fn_audit_provider_account();

-- ── 3. Dados existentes: uma integração viva por (locadora, provedor) ─────
--
-- Fica a que cobra, senão a conectada, senão a mais recente; as outras viram
-- excluídas, com o segredo apagado e a trilha assinada pela migration. Em
-- produção (conferido em 2026-10-11) isso atinge só a InfinitePay desconectada
-- da WAT Motos — aprovado pelo Alan.
--
-- Duas CONECTADAS do mesmo provedor não têm escolha automática segura: a
-- migration falha e alguém decide.

DO $$
DECLARE
  r RECORD;
BEGIN
  IF EXISTS (
    SELECT 1 FROM payment_provider_accounts
     WHERE deleted_at IS NULL AND active
     GROUP BY tenant_id, provider HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'ADR 0039: há locadora com duas integrações CONECTADAS do mesmo provedor — resolva antes de migrar';
  END IF;

  PERFORM set_config('gomoto.actor_system', 'system:migration_0039', true);

  FOR r IN
    SELECT id, secret_id FROM (
      SELECT a.id, a.secret_id,
             row_number() OVER (
               PARTITION BY a.tenant_id, a.provider
               ORDER BY a.is_default DESC, a.active DESC, a.created_at DESC
             ) AS pos
        FROM payment_provider_accounts a
       WHERE a.deleted_at IS NULL
    ) x
    WHERE x.pos > 1
  LOOP
    IF r.secret_id IS NOT NULL THEN
      DELETE FROM vault.secrets WHERE id = r.secret_id;
    END IF;

    UPDATE payment_intents SET status = 'expired'
     WHERE provider_account_id = r.id AND status = 'pending';

    UPDATE payment_provider_accounts
       SET active = false, is_default = false, secret_id = NULL, deleted_at = now()
     WHERE id = r.id;
  END LOOP;

  PERFORM set_config('gomoto.actor_system', '', true);
END;
$$;

-- ── 4. Unicidade: uma por provedor, ignorando as excluídas ────────────────
--
-- A chave antiga incluía `external_account_id`: reconectar com OUTRA conta
-- criava linha nova ao lado da antiga. Ela também impediria reconectar a mesma
-- conta depois de excluída, então sai — a nova cobre o caso vivo.

-- Nome truncado pelo Postgres (63 caracteres), conferido no catálogo.
ALTER TABLE payment_provider_accounts
  DROP CONSTRAINT IF EXISTS payment_provider_accounts_tenant_id_provider_external_accou_key;

CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_accounts_one_per_provider
  ON payment_provider_accounts (tenant_id, provider)
  WHERE deleted_at IS NULL;

-- ── 5. Conectar / reconectar ──────────────────────────────────────────────
--
-- Reconectar aceita só a MESMA conta no provedor. Outra conta é recusada aqui,
-- no banco: a tela orienta a excluir a atual primeiro.
--
-- A credencial é gravada no MESMO comando que cria/reativa a linha: assim a
-- trilha vê uma mudança só (e não "reconectou" duas vezes).

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
  v_external   TEXT;
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

  SELECT id, external_account_id, secret_id INTO v_account, v_external, v_old_secret
    FROM payment_provider_accounts
   WHERE tenant_id = p_tenant_id AND provider = p_provider AND deleted_at IS NULL
     FOR UPDATE;

  IF v_account IS NOT NULL AND v_external IS DISTINCT FROM p_external_account_id THEN
    RAISE EXCEPTION 'GATEWAY_PROVIDER_ALREADY_CONNECTED' USING ERRCODE = '23505';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM payment_provider_accounts
     WHERE tenant_id = p_tenant_id AND is_default AND active
       AND (v_account IS NULL OR id <> v_account)
  ) INTO v_has_other;
  v_elected := NOT v_has_other;

  PERFORM set_config('gomoto.gateway_action', 'connect', true);

  IF v_account IS NULL THEN
    v_account := gen_random_uuid();
    v_secret := vault.create_secret(
      p_credentials::text,
      'provider_account_' || v_account::text,
      'Credenciais do gateway — conta ' || v_account::text
    );
    INSERT INTO payment_provider_accounts
      (id, tenant_id, provider, external_account_id, account_label, is_default, active, secret_id)
    VALUES
      (v_account, p_tenant_id, p_provider, p_external_account_id, p_account_label, v_elected, true, v_secret);
  ELSE
    -- O nome do segredo é estável por conta e único no Vault: o antigo sai
    -- antes de o novo entrar, na mesma transação.
    IF v_old_secret IS NOT NULL THEN
      DELETE FROM vault.secrets WHERE id = v_old_secret;
    END IF;
    v_secret := vault.create_secret(
      p_credentials::text,
      'provider_account_' || v_account::text,
      'Credenciais do gateway — conta ' || v_account::text
    );
    UPDATE payment_provider_accounts
       SET account_label = p_account_label,
           active = true,
           is_default = is_default OR v_elected,
           secret_id = v_secret,
           refresh_claimed_at = NULL
     WHERE id = v_account
    RETURNING payment_provider_accounts.is_default INTO v_elected;
  END IF;

  PERFORM set_config('gomoto.gateway_action', '', true);

  RETURN QUERY SELECT v_account, v_elected;
END;
$$;

REVOKE ALL ON FUNCTION fn_connect_provider_account(UUID, TEXT, TEXT, TEXT, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fn_connect_provider_account(UUID, TEXT, TEXT, TEXT, JSONB) TO authenticated, service_role;

COMMENT ON FUNCTION fn_connect_provider_account IS
  'ADR 0030/0039: conecta ou reconecta (só a MESMA conta) um gateway. Uma integração viva por provedor; outra conta exige excluir a atual.';

-- ── 6. Desconectar: recusa excluída ───────────────────────────────────────

CREATE OR REPLACE FUNCTION fn_disconnect_provider_account(p_account_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_tenant  UUID;
  v_deleted TIMESTAMPTZ;
BEGIN
  SELECT tenant_id, deleted_at INTO v_tenant, v_deleted
    FROM payment_provider_accounts WHERE id = p_account_id FOR UPDATE;

  IF v_tenant IS NULL OR v_deleted IS NOT NULL THEN
    RAISE EXCEPTION 'GATEWAY_ACCOUNT_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  PERFORM fn_assert_gateway_owner(v_tenant);

  -- A credencial FICA: desconectar é reversível, e um código já enviado ao
  -- cliente que for pago ainda precisa ser conferido no provedor (ADR 0039).
  UPDATE payment_provider_accounts
     SET active = false, is_default = false
   WHERE id = p_account_id;

  UPDATE payment_intents
     SET status = 'expired'
   WHERE provider_account_id = p_account_id AND status = 'pending';
END;
$$;

REVOKE ALL ON FUNCTION fn_disconnect_provider_account(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fn_disconnect_provider_account(UUID) TO authenticated, service_role;

-- ── 7. Excluir ─────────────────────────────────────────────────────────────
--
-- Só a partir de DESCONECTADA. A limpeza no provedor (cancelar códigos não
-- pagos, remover o webhook) acontece ANTES, na Server Action, enquanto a
-- credencial ainda existe; aqui é a metade local, numa transação.

CREATE OR REPLACE FUNCTION fn_delete_provider_account(p_account_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'vault'
AS $$
DECLARE
  v_tenant  UUID;
  v_active  BOOLEAN;
  v_secret  UUID;
  v_deleted TIMESTAMPTZ;
BEGIN
  SELECT tenant_id, active, secret_id, deleted_at INTO v_tenant, v_active, v_secret, v_deleted
    FROM payment_provider_accounts WHERE id = p_account_id FOR UPDATE;

  IF v_tenant IS NULL OR v_deleted IS NOT NULL THEN
    RAISE EXCEPTION 'GATEWAY_ACCOUNT_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  PERFORM fn_assert_gateway_owner(v_tenant);

  IF v_active THEN
    RAISE EXCEPTION 'GATEWAY_DISCONNECT_FIRST' USING ERRCODE = '23514';
  END IF;

  IF v_secret IS NOT NULL THEN
    DELETE FROM vault.secrets WHERE id = v_secret;
  END IF;

  UPDATE payment_intents
     SET status = 'expired'
   WHERE provider_account_id = p_account_id AND status = 'pending';

  UPDATE payment_provider_accounts
     SET secret_id = NULL, deleted_at = now(), deleted_by = auth.uid(), is_default = false
   WHERE id = p_account_id;
END;
$$;

REVOKE ALL ON FUNCTION fn_delete_provider_account(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fn_delete_provider_account(UUID) TO authenticated, service_role;

COMMENT ON FUNCTION fn_delete_provider_account IS
  'ADR 0039: exclui (irreversível) uma integração DESCONECTADA — apaga a credencial do Vault, expira pendentes, grava deleted_at. A linha fica como histórico.';
