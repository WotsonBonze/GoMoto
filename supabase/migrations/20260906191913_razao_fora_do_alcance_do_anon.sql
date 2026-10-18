-- ADR 0034 — Fase 2b: o razão sai do alcance de `anon`
--
-- ACHADO CRÍTICO, encontrado ao VERIFICAR a Fase 2 no banco em vez de deduzir
-- pelas migrations. Reproduzido ao vivo, com a chave anônima e nada mais:
--
--   POST /rest/v1/rpc/post_financial_transaction
--   apikey: <anon key — a que viaja no bundle do navegador>
--   { "p_tenant_id": "<qualquer tenant>", ... }
--   → HTTP 200, lançamento de R$ 999.999,00 criado no razão daquele tenant
--
-- Sem login. Sem pertencer à empresa. Em tenant escolhido a dedo.
--
-- ## Por que isso existia
--
-- `20260627230859_grant_authenticated_role.sql` resolveu um problema real — o
-- `postgres` local não concedia SELECT/INSERT/UPDATE/DELETE e o projeto
-- quebrava depois de `db:reset` — com um instrumento largo demais:
--
--   GRANT ALL ON ALL TABLES   IN SCHEMA public TO anon, authenticated, service_role;
--   GRANT ALL ON ALL ROUTINES IN SCHEMA public TO anon, authenticated, service_role;
--   ALTER DEFAULT PRIVILEGES ... GRANT ALL ON TABLES   TO anon, ...;
--   ALTER DEFAULT PRIVILEGES ... GRANT ALL ON ROUTINES TO anon, ...;
--
-- O `ALTER DEFAULT PRIVILEGES` é o que torna isto insidioso: **toda tabela e
-- toda função criada depois nasce concedida a `anon`**. Todo `GRANT` cuidadoso
-- escrito nas migrations seguintes estava concedendo o que já estava concedido,
-- e todo `REVOKE ... FROM PUBLIC` não tocava em `anon`, porque `anon` é um role
-- nomeado e não faz parte de `PUBLIC`.
--
-- Medido neste banco antes da correção: 67 das 71 rotinas de `public`
-- executáveis por `anon`, 37 delas `SECURITY DEFINER` — ou seja, ignorando RLS.
--
-- ## O que salvou o resto
--
-- Quase todas as funções de dinheiro conferem o tenant por dentro
-- (`get_user_tenants()`), e para `anon` esse conjunto é VAZIO — então elas
-- levantam exceção mesmo estando concedidas. A RLS cobriu as tabelas pelo mesmo
-- motivo: as políticas são `TO authenticated`.
--
-- `post_financial_transaction` é a exceção, e por isso era explorável:
-- `SECURITY DEFINER`, recebe `p_tenant_id` como PARÂMETRO e nunca perguntou
-- quem estava chamando. A checagem de tenant morava em cada chamador; a função
-- que efetivamente escreve no razão não tinha nenhuma.
--
-- ## Duas camadas, porque uma só já falhou aqui
--
--   1. A função passa a exigir papel e tenant (abaixo).
--   2. O grant sai de `anon` na superfície de dinheiro, e o DEFAULT deixa de
--      conceder a `anon` daqui para a frente.
--
-- A camada 1 sozinha bastaria para este caso. A camada 2 é o que impede a
-- próxima função de dinheiro de nascer exposta por omissão — que foi
-- exatamente o que aconteceu.

-- ---------------------------------------------------------------------------
-- 1. Quem pode escrever no razão
-- ---------------------------------------------------------------------------

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
  v_role  TEXT;
BEGIN
  -- LISTA DE PERMITIDOS, não de proibidos.
  --
  -- Um `IF v_role = 'anon' THEN recusa` fecharia o buraco de hoje e deixaria
  -- aberto o de amanhã: role novo exposto pelo PostgREST entraria por omissão.
  -- Aqui, quem não está nomeado não escreve no razão.
  --
  --   service_role → backend confiável (Edge Function do webhook)
  --   none         → conexão direta, fora do PostgREST: `pg_cron` (emissão
  --                  diária) e migrations rodam assim. Verificado: o GUC `role`
  --                  vale 'none' nesse contexto.
  --   authenticated→ usuário logado, e só no razão da PRÓPRIA empresa
  v_role := COALESCE(current_setting('role', true), 'none');

  IF v_role = 'authenticated' THEN
    IF p_tenant_id NOT IN (SELECT get_user_tenants()) THEN
      RAISE EXCEPTION 'LEDGER_WRONG_TENANT: lançamento em empresa que não é sua.'
        USING ERRCODE = '42501';
    END IF;
  ELSIF v_role NOT IN ('service_role', 'none') THEN
    RAISE EXCEPTION 'LEDGER_FORBIDDEN_ROLE: % não escreve no razão.', v_role
      USING ERRCODE = '42501';
  END IF;

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

COMMENT ON FUNCTION post_financial_transaction IS
  'ADR 0024/0034: escrita atômica no razão. Exige service_role, conexão direta (cron) ou usuário logado da própria empresa — `anon` não escreve.';

-- ---------------------------------------------------------------------------
-- 2. O grant sai de `anon` na superfície de dinheiro
-- ---------------------------------------------------------------------------
-- Predicado em vez de 28 assinaturas escritas à mão: a lista mudaria a cada
-- função nova e a próxima pessoa esqueceria de somar a dela — que é a forma do
-- defeito que esta migration existe para corrigir.
--
-- Funções de trigger ficam de fora porque não são chamáveis por RPC (o
-- PostgREST não expõe quem retorna `trigger`), e revogá-las não muda nada.

DO $$
DECLARE
  f RECORD;
  n INT := 0;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure AS assinatura
      FROM pg_proc p
      JOIN pg_namespace ns ON ns.oid = p.pronamespace
      JOIN pg_type t ON t.oid = p.prorettype
     WHERE ns.nspname = 'public'
       AND t.typname <> 'trigger'
       AND has_function_privilege('anon', p.oid, 'EXECUTE')
       -- Parênteses obrigatórios: `~` liga mais forte que `||`, então sem eles
       -- o predicado vira `(proname ~ 'a') || 'b'` — texto, não booleano.
       AND p.proname ~ ('(payment|gateway|credential|financial|charge|payable|'
                     || 'credit|deposit|ledger|invoice|reverse|allocat|billing)')
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon', f.assinatura);
    n := n + 1;
  END LOOP;

  RAISE NOTICE 'ADR 0034: EXECUTE revogado de anon em % funções de dinheiro', n;
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. O DEFAULT deixa de conceder a `anon`
-- ---------------------------------------------------------------------------
-- Isto é o conserto da CAUSA. Sem ele, a próxima tabela e a próxima função
-- nascem concedidas a `anon` de novo, e a Fase 2 inteira vira um instantâneo
-- que envelhece.
--
-- Só vale para objetos criados DEPOIS desta migration — objetos existentes já
-- foram tratados no passo 2 (dinheiro) e continuam concedidos fora dele. Ver a
-- ressalva no fim do arquivo.
--
-- `authenticated` e `service_role` seguem no default: a aplicação depende
-- disso, e para eles a RLS é a barreira desenhada.

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON TABLES FROM anon;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON ROUTINES FROM anon;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON SEQUENCES FROM anon;

-- ---------------------------------------------------------------------------
-- RESSALVA REGISTRADA (ADR 0034, Fase 3)
-- ---------------------------------------------------------------------------
-- Esta migration fecha o DOMÍNIO DE DINHEIRO e o default daqui para a frente.
-- Ela NÃO varre o que sobrou: `anon` continua com EXECUTE em funções de outros
-- domínios criadas antes daqui — entre elas `add_to_queue`,
-- `create_rental_with_schedule`, `adjust_rental_schedule`,
-- `check_user_email_conflict`, `list_platform_admins` e as de fila.
--
-- Não foram tocadas aqui de propósito: varrer `anon` do schema inteiro exige
-- saber o que os fluxos ANTERIORES AO LOGIN legitimamente chamam (convite,
-- definição de senha, verificação de e-mail), e errar isso derruba a entrada no
-- produto. É um passo próprio, com a sua própria verificação.
