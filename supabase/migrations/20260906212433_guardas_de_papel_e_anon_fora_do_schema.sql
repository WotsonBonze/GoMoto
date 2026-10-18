-- ADR 0034 — Fase 2c: a guarda que NULL desliga, e `anon` fora do schema
--
-- Dois achados encontrados ao continuar a varredura da Fase 2b. O primeiro é
-- pior que o do razão, porque não depende de nada exótico: basta ter conta.
--
-- ===========================================================================
-- ACHADO 1 — ESCALAÇÃO DE PRIVILÉGIO PARA ADMIN DA PLATAFORMA 🔴
-- ===========================================================================
--
-- As três funções de administração da plataforma guardavam assim:
--
--     IF get_platform_role() <> 'owner' THEN
--         RAISE EXCEPTION 'apenas owners podem ...' USING ERRCODE='42501';
--     END IF;
--
-- `get_platform_role()` é `SELECT role FROM platform_admins WHERE user_id =
-- auth.uid()`. Para quem NÃO é admin da plataforma — isto é, para todo usuário
-- normal e para o anônimo — ela devolve **NULL**.
--
-- E `NULL <> 'owner'` não é TRUE: é **NULL**. `IF NULL THEN` não executa.
-- **A guarda inteira é pulada exatamente para quem ela existe para barrar.**
--
-- Reproduzido ao vivo, com um `operator` comum de tenant (`get_platform_role()`
-- = NULL, `is_platform_admin()` = false):
--
--     SELECT add_platform_admin_by_email('outra-conta-minha@...', 'owner');
--     → sucesso. A conta virou platform_admin OWNER.
--
-- Platform admin owner enxerga TODOS os tenants. Ou seja: qualquer funcionário
-- de qualquer locadora criava uma segunda conta e se promovia a administrador
-- da plataforma inteira.
--
-- O que segurou os outros dois caminhos foi acidente, não desenho:
--   - `remove_platform_admin` parou em "a plataforma precisa de pelo menos um
--     owner" — regra de negócio, que só vale enquanto houver um único owner;
--   - para o `anon`, `add_platform_admin_by_email` abortou no
--     `platform_audit_logs.actor_id NOT NULL`, porque `auth.uid()` é NULL.
--     A trilha de auditoria defendeu por efeito colateral.
--
-- A correção é `IS DISTINCT FROM`, que é NULL-safe e já é o operador usado no
-- resto do schema (`fn_provider_credentials`, `fn_store_provider_credentials`,
-- `fn_assert_gateway_owner`). Estas três funções são de 2026-06-15 e ficaram
-- para trás.
--
-- Somado no caminho: `SET search_path` nas três. `SECURITY DEFINER` sem
-- search_path fixo resolve nomes pela do chamador.

CREATE OR REPLACE FUNCTION add_platform_admin_by_email(p_email TEXT, p_role TEXT)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_actor   UUID := auth.uid();
    v_user_id UUID;
BEGIN
    -- `IS DISTINCT FROM`, não `<>`: para quem não é admin o papel é NULL, e
    -- `NULL <> 'owner'` devolve NULL — a guarda não disparava.
    IF get_platform_role() IS DISTINCT FROM 'owner' THEN
        RAISE EXCEPTION 'apenas owners podem adicionar platform_admin' USING ERRCODE='42501';
    END IF;
    IF p_role NOT IN ('owner', 'operator') THEN
        RAISE EXCEPTION 'role inválida' USING ERRCODE='22023';
    END IF;

    SELECT id INTO v_user_id
      FROM auth.users
     WHERE LOWER(email) = LOWER(p_email)
     LIMIT 1;

    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'usuário % não encontrado em auth.users', p_email USING ERRCODE='P0002';
    END IF;

    INSERT INTO platform_admins (user_id, role, created_by)
    VALUES (v_user_id, p_role, v_actor);
    -- UNIQUE em user_id → conflito vira 23505 e o app traduz.

    INSERT INTO platform_audit_logs (actor_id, action, target_type, target_id, metadata)
    VALUES (v_actor, 'platform_admin.add', 'platform_admin', v_user_id,
            jsonb_build_object('email', LOWER(p_email), 'role', p_role));

    RETURN v_user_id;
END;
$$;

-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION remove_platform_admin(p_user_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_actor       UUID := auth.uid();
    v_target_role TEXT;
    v_owner_count INT;
BEGIN
    IF get_platform_role() IS DISTINCT FROM 'owner' THEN
        RAISE EXCEPTION 'apenas owners podem remover platform_admin' USING ERRCODE='42501';
    END IF;

    SELECT role INTO v_target_role FROM platform_admins WHERE user_id = p_user_id;
    IF v_target_role IS NULL THEN
        RAISE EXCEPTION 'platform_admin não encontrado' USING ERRCODE='P0002';
    END IF;

    IF v_target_role = 'owner' THEN
        SELECT COUNT(*) INTO v_owner_count FROM platform_admins WHERE role = 'owner';
        IF v_owner_count <= 1 THEN
            RAISE EXCEPTION 'a plataforma precisa de pelo menos um owner' USING ERRCODE='23514';
        END IF;
    END IF;

    DELETE FROM platform_admins WHERE user_id = p_user_id;

    INSERT INTO platform_audit_logs (actor_id, action, target_type, target_id, metadata)
    VALUES (v_actor, 'platform_admin.remove', 'platform_admin', p_user_id,
            jsonb_build_object('was_role', v_target_role));
END;
$$;

-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION set_platform_admin_role(p_user_id UUID, p_role TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_actor        UUID := auth.uid();
    v_current_role TEXT;
    v_owner_count  INT;
BEGIN
    IF get_platform_role() IS DISTINCT FROM 'owner' THEN
        RAISE EXCEPTION 'apenas owners podem alterar role' USING ERRCODE='42501';
    END IF;
    IF p_role NOT IN ('owner', 'operator') THEN
        RAISE EXCEPTION 'role inválida' USING ERRCODE='22023';
    END IF;

    SELECT role INTO v_current_role FROM platform_admins WHERE user_id = p_user_id;
    IF v_current_role IS NULL THEN
        RAISE EXCEPTION 'platform_admin não encontrado' USING ERRCODE='P0002';
    END IF;

    IF v_current_role = p_role THEN
        RETURN;  -- noop; evita log poluído
    END IF;

    IF v_current_role = 'owner' THEN
        SELECT COUNT(*) INTO v_owner_count FROM platform_admins WHERE role = 'owner';
        IF v_owner_count <= 1 THEN
            RAISE EXCEPTION 'a plataforma precisa de pelo menos um owner' USING ERRCODE='23514';
        END IF;
    END IF;

    UPDATE platform_admins SET role = p_role, updated_at = NOW() WHERE user_id = p_user_id;

    INSERT INTO platform_audit_logs (actor_id, action, target_type, target_id, metadata)
    VALUES (v_actor, 'platform_admin.set_role', 'platform_admin', p_user_id,
            jsonb_build_object('from', v_current_role, 'to', p_role));
END;
$$;

-- ===========================================================================
-- ACHADO 2 — O SEGUNDO CAMINHO ATÉ O `anon`: o default do PostgreSQL
-- ===========================================================================
--
-- A Fase 2b revogou `anon` de 21 funções de dinheiro e mediu o resultado. Ao
-- reconferir, várias continuavam alcançáveis. O motivo é que existem **DOIS
-- caminhos independentes** concedendo, e a Fase 2b fechou só um:
--
--   1. `ALTER DEFAULT PRIVILEGES ... GRANT ALL ON ROUTINES TO anon`
--      (migration 20260627230859) — grant DIRETO para `anon`. Fechado na 2b.
--   2. O default do próprio PostgreSQL: **`CREATE FUNCTION` concede EXECUTE a
--      `PUBLIC`**, e `anon` é membro de `PUBLIC`. NÃO fechado.
--
-- Dá para ver no ACL: `=X/postgres` (grantee vazio) é o grant para `PUBLIC`.
-- `fn_pay_payable` tinha; `fn_provider_credentials`, que fez
-- `REVOKE ALL ... FROM PUBLIC` na própria migration, não tinha — e por isso
-- estava de fato fechada.
--
-- É a mesma lição pela terceira vez: `REVOKE ... FROM PUBLIC` e
-- `REVOKE ... FROM anon` são coisas diferentes, e precisar dos dois não é
-- redundância.
--
-- Verificado antes de revogar: NENHUMA rotina depende do grant de `PUBLIC`
-- para `authenticated` ou `service_role` — os dois têm grant explícito em
-- todas (consequência da própria migration 20260627230859). Ou seja, isto
-- tira acesso de `anon` e de mais ninguém.
--
-- Verificado no código: nenhuma RPC de `public` é chamada antes do login.
-- `get_platform_role()` aparece no middleware e na tela de login, mas só depois
-- de haver sessão.

REVOKE EXECUTE ON ALL ROUTINES IN SCHEMA public FROM PUBLIC;
REVOKE EXECUTE ON ALL ROUTINES IN SCHEMA public FROM anon;

-- E para as FUTURAS: sem isto, a próxima função nasce com EXECUTE para PUBLIC
-- e o buraco se reabre sozinho — que é exatamente como este chegou até aqui.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE EXECUTE ON ROUTINES FROM PUBLIC;

-- ===========================================================================
-- VERIFICAÇÃO NA PRÓPRIA MIGRATION
-- ===========================================================================
-- Uma migration de permissão que não confere o resultado é uma intenção, não
-- uma garantia — e a Fase 2b provou isso ao revogar 21 funções e fechar menos
-- que 21. Aqui a migration FALHA se o resultado não for o esperado.

DO $$
DECLARE
  v_anon    INT;
  v_perdeu  INT;
BEGIN
  -- Nenhuma rotina de `public` pode sobrar ao alcance do `anon`.
  SELECT count(*) INTO v_anon
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND has_function_privilege('anon', p.oid, 'EXECUTE');

  IF v_anon > 0 THEN
    RAISE EXCEPTION 'ADR 0034: % rotina(s) de public ainda alcançáveis por anon', v_anon;
  END IF;

  -- E `authenticated` não pode ter perdido nada no caminho: o objetivo é
  -- fechar `anon`, não quebrar a aplicação.
  SELECT count(*) INTO v_perdeu
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('get_user_tenants', 'get_platform_role', 'is_platform_admin',
                       'current_customer_ids', 'get_own_membership_status',
                       'list_tenant_members', 'post_financial_transaction',
                       'fn_create_charge', 'fn_open_payment_intent')
     AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE');

  IF v_perdeu > 0 THEN
    RAISE EXCEPTION 'ADR 0034: % função crítica perdeu acesso de authenticated', v_perdeu;
  END IF;

  RAISE NOTICE 'ADR 0034 Fase 2c: anon sem EXECUTE em public; authenticated intacto';
END;
$$;
