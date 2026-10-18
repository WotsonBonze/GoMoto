-- ADR 0034 — Fase 5: a trilha do tenant passa a ver dinheiro
--
-- `apps/web/src/lib/audit.ts` declara `payment_confirmed` e `token_refreshed` no
-- vocabulário de ações desde sempre. **Nenhum dos dois teve um único escritor.**
-- A trilha de auditoria da locadora registrava "conectou gateway" e "gerou Pix",
-- e nunca "recebeu dinheiro" nem "estornou".
--
-- A causa não é descuido, é estrutura: a confirmação roda em Deno, com
-- `service_role`, e `logAction` vive em `apps/web`. É a mesma fronteira que fez
-- `_shared/inbox.ts` existir. Nenhuma quantidade de disciplina no código da
-- aplicação alcança um caminho que não passa pela aplicação.
--
-- Por isso a trilha do dinheiro passa a ser escrita pelo BANCO, por trigger, na
-- MESMA transação que cria o pagamento. Isso resolve dois problemas de uma vez:
--
--   1. alcança os três caminhos — webhook de gateway, recebimento manual e
--      abatimento por crédito — sem que nenhum precise lembrar de chamar nada;
--   2. a escrita não pode ser "engolida". `logAction` captura a própria falha e
--      segue (`catch { console.error }`), então uma trilha que não gravou é
--      indistinguível de uma que gravou. Aqui, se o registro falhar, a
--      transação inteira falha — e um pagamento que não pode ser auditado não
--      acontece.

-- ---------------------------------------------------------------------------
-- 1. A trilha passa a aceitar quem não é gente
-- ---------------------------------------------------------------------------
-- `user_id NOT NULL` é o que impedia o banco de registrar dinheiro de gateway:
-- `auth.uid()` é NULL sob `service_role`, e não há usuário a nomear.
--
-- A saída NÃO é um `auth.users` de sistema. Um usuário fictício apareceria em
-- listas de membros e em qualquer relatório que agrupe por pessoa — é o mesmo
-- princípio que criou `payments.received_by_system` na Fase 1: papel de máquina
-- não se disfarça de pessoa (ADR 0034, Princípio 3).

ALTER TABLE audit_logs ALTER COLUMN user_id DROP NOT NULL;

ALTER TABLE audit_logs
  ADD COLUMN actor_system TEXT
    CHECK (actor_system ~ '^(gateway:[a-z][a-z0-9_]{2,31}|system:[a-z][a-z0-9_]{2,31})$');

COMMENT ON COLUMN audit_logs.actor_system IS
  'ADR 0034: quem agiu quando não foi gente — `gateway:<provedor>` ou `system:<origem>`. Excludente com user_id.';

-- Toda linha tem exatamente UM autor. Sem isto, "quem fez isso?" poderia ter
-- duas respostas ou nenhuma, e uma trilha que não sabe responder isso não é
-- trilha.
ALTER TABLE audit_logs
  ADD CONSTRAINT audit_logs_exactly_one_actor
  CHECK ((user_id IS NULL) <> (actor_system IS NULL));

CREATE INDEX idx_audit_logs_actor_system ON audit_logs (actor_system)
  WHERE actor_system IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. Todo pagamento deixa rastro, venha de onde vier
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION fn_audit_payment()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_user   UUID;
  v_system TEXT;
  v_action TEXT;
  v_data   JSONB;
BEGIN
  -- Quem recebeu, na ordem em que a resposta é mais específica:
  --   `received_by`  — a pessoa que registrou o recebimento manual;
  --   `auth.uid()`   — quem estava logado, quando a linha não nomeia ninguém
  --                    (abatimento por crédito, retenção de caução);
  --   `received_by_system` — o gateway.
  v_user   := COALESCE(NEW.received_by, auth.uid());
  v_system := NEW.received_by_system;

  -- `service_role` sem `received_by_system` é backend nosso agindo sem gateway:
  -- a emissão por cron, um script de manutenção. Nomear isso é melhor que
  -- inventar um usuário ou deixar a transação morrer no CHECK.
  IF v_user IS NULL AND v_system IS NULL THEN
    v_system := 'system:database';
  END IF;

  -- Pessoa E sistema ao mesmo tempo não existe. Quando a linha traz
  -- `received_by_system`, ele ganha: foi o gateway que recebeu, mesmo que uma
  -- pessoa estivesse logada em algum lugar quando o webhook chegou.
  IF v_system IS NOT NULL THEN
    v_user := NULL;
  END IF;

  IF TG_OP = 'INSERT' THEN
    v_action := 'payment_confirmed';
    v_data := jsonb_build_object(
      'amount',            NEW.amount,
      'method',            NEW.method,
      'paid_at',           NEW.paid_at,
      'notes',             NEW.notes,
      'customer_id',       NEW.customer_id,
      'payment_intent_id', NEW.payment_intent_id,
      -- O elo da Fase 1 viaja junto: quem lê a trilha chega ao webhook que
      -- causou o dinheiro sem sair dela.
      'gateway_event_id',  NEW.gateway_event_id
    );
  ELSE
    v_action := 'payment_reversed';
    v_data := jsonb_build_object(
      'amount',          NEW.amount,
      'reversal_reason', NEW.reversal_reason,
      'reversed_at',     NEW.reversed_at,
      'reversed_by',     NEW.reversed_by
    );
    -- Estorno tem autor próprio, e ele não é quem recebeu.
    IF NEW.reversed_by IS NOT NULL THEN
      v_user := NEW.reversed_by;
      v_system := NULL;
    END IF;
  END IF;

  INSERT INTO audit_logs (tenant_id, user_id, actor_system, action, table_name, record_id, new_data)
  VALUES (NEW.tenant_id, v_user, v_system, v_action, 'payments', NEW.id, v_data);

  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION fn_audit_payment IS
  'ADR 0034: registra recebimento e estorno em audit_logs, na mesma transação. Alcança o webhook (Deno), que a aplicação não alcança.';

CREATE TRIGGER trg_payments_audit_insert
  AFTER INSERT ON payments
  FOR EACH ROW EXECUTE FUNCTION fn_audit_payment();

-- Só a transição para estornado. `fn_protect_payment` já impede desfazer um
-- estorno, então esta condição dispara no máximo uma vez por pagamento.
CREATE TRIGGER trg_payments_audit_reversal
  AFTER UPDATE ON payments
  FOR EACH ROW
  WHEN (OLD.reversed_at IS NULL AND NEW.reversed_at IS NOT NULL)
  EXECUTE FUNCTION fn_audit_payment();

-- ---------------------------------------------------------------------------
-- 3. Renovação de credencial também deixa rastro
-- ---------------------------------------------------------------------------
-- `token_refreshed` é o outro nome que existia sem escritor. A renovação é
-- silenciosa por desenho (acontece ao gerar cobrança, sem interação), e é
-- justamente por isso que ela precisa de rastro: quando uma conexão morre, a
-- pergunta é "quando foi a última renovação bem-sucedida?", e hoje ela não tem
-- resposta.
--
-- Fica em `fn_store_provider_credentials`, que é o ponto único por onde toda
-- credencial nova passa — conexão inicial, rotação e reconexão.

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
  v_tenant   UUID;
  v_old      UUID;
  v_secret   UUID;
  v_provider TEXT;
BEGIN
  IF p_credentials IS NULL OR p_credentials = '{}'::jsonb THEN
    RAISE EXCEPTION 'GATEWAY_EMPTY_CREDENTIALS' USING ERRCODE = '22023';
  END IF;

  SELECT tenant_id, secret_id, provider INTO v_tenant, v_old, v_provider
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

  -- A credencial NUNCA entra na trilha — nem cifrada, nem em pedaço. O que se
  -- registra é que houve renovação, quando, e de qual conta.
  INSERT INTO audit_logs (tenant_id, user_id, actor_system, action, table_name, record_id, new_data)
  VALUES (
    v_tenant,
    CASE WHEN auth.uid() IS NULL THEN NULL ELSE auth.uid() END,
    CASE WHEN auth.uid() IS NULL THEN 'gateway:' || v_provider ELSE NULL END,
    'token_refreshed',
    'payment_provider_accounts',
    p_account_id,
    jsonb_build_object('provider', v_provider, 'expires_at', p_credentials->>'expires_at')
  );

  RETURN v_secret;
END;
$$;

REVOKE ALL ON FUNCTION fn_store_provider_credentials(UUID, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION fn_store_provider_credentials(UUID, JSONB) TO service_role;

-- ---------------------------------------------------------------------------
-- 4. A trilha continua imutável
-- ---------------------------------------------------------------------------
-- As policies de `audit_logs` são SELECT e INSERT apenas (RNF-005), e sem
-- policy de UPDATE/DELETE a RLS nega por padrão. Mas as duas escritas novas
-- acontecem em funções `SECURITY DEFINER`, que IGNORAM RLS — a garantia
-- precisava passar a existir onde ela não pode ser contornada.

CREATE OR REPLACE FUNCTION fn_reject_audit_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'Trilha de auditoria é imutável (RNF-005). % em % não é permitido.',
    TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER trg_audit_logs_immutable
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION fn_reject_audit_mutation();
