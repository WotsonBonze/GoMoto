-- ============================================================
-- ADR 0042 — Logo da locadora no login por subdomínio.
--
-- 1. tenants ganha login_subdomain (opcional, único) e os dois caminhos
--    de logo no bucket tenant-branding.
-- 2. Bucket público tenant-branding: logo é público por natureza; só o
--    admin da plataforma escreve.
-- 3. get_login_branding(): única porta anônima — devolve SÓ nome e logos
--    de empresa ativa e não suspensa. tenants continua fechada para anon.
-- 4. Remove "Owners can update their tenants": liberava as 23 colunas
--    para owner/admin da locadora (inclusive suspended_at — um owner
--    suspenso se reativava com um PATCH direto). Nenhum fluxo do sistema
--    usa essa permissão: quem edita tenants é o admin da plataforma
--    (platform_admin_manage_tenants), e passaria a deixar a locadora
--    trocar o próprio subdomínio.
-- ============================================================

-- ── 1. Colunas ──────────────────────────────────────────────

-- Lista de reservados espelhada em @gomoto/core (RESERVED_LOGIN_SUBDOMAINS).
ALTER TABLE tenants
    ADD COLUMN login_subdomain       VARCHAR(63),
    ADD COLUMN login_logo_path       TEXT,
    ADD COLUMN login_logo_light_path TEXT,
    ADD CONSTRAINT tenants_login_subdomain_key UNIQUE (login_subdomain),
    ADD CONSTRAINT chk_tenants_login_subdomain_format CHECK (
        login_subdomain IS NULL OR (
            login_subdomain ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'
            AND login_subdomain NOT IN (
                'www', 'app', 'admin', 'api', 'suporte', 'mail', 'status',
                'login', 'auth', 'static', 'cdn'
            )
        )
    );

COMMENT ON COLUMN tenants.login_subdomain IS
    'Subdomínio do login personalizado ({sub}.locaw.com.br). Definido só pelo admin da plataforma (ADR 0042).';
COMMENT ON COLUMN tenants.login_logo_path IS
    'Caminho no bucket tenant-branding do logo para fundo escuro (painel de marca do login).';
COMMENT ON COLUMN tenants.login_logo_light_path IS
    'Caminho no bucket tenant-branding do logo para fundo claro; se nulo, o login usa login_logo_path.';

-- ── 2. Bucket ───────────────────────────────────────────────

-- Sem SVG de propósito: aberto direto pela URL pública, um SVG executa
-- script na origem do Supabase.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('tenant-branding', 'tenant-branding', true, 1048576, ARRAY['image/png', 'image/webp', 'image/jpeg'])
ON CONFLICT (id) DO NOTHING;

-- A URL pública (/object/public/) dispensa policy. Esta SELECT é para o
-- Storage achar o objeto no DELETE/upsert: sem ela, remover o logo antigo
-- "funciona" (200, lista vazia) e o arquivo fica órfão.
CREATE POLICY "tenant-branding: listagem do admin da plataforma"
    ON storage.objects FOR SELECT TO authenticated
    USING (bucket_id = 'tenant-branding' AND is_platform_admin());

CREATE POLICY "tenant-branding: escrita do admin da plataforma"
    ON storage.objects FOR INSERT TO authenticated
    WITH CHECK (bucket_id = 'tenant-branding' AND is_platform_admin());

CREATE POLICY "tenant-branding: update do admin da plataforma"
    ON storage.objects FOR UPDATE TO authenticated
    USING (bucket_id = 'tenant-branding' AND is_platform_admin());

CREATE POLICY "tenant-branding: delete do admin da plataforma"
    ON storage.objects FOR DELETE TO authenticated
    USING (bucket_id = 'tenant-branding' AND is_platform_admin());

-- ── 3. Leitura pública da marca ─────────────────────────────

CREATE OR REPLACE FUNCTION get_login_branding(p_subdomain TEXT)
RETURNS TABLE (name TEXT, logo_path TEXT, logo_light_path TEXT)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
    SELECT t.name::TEXT, t.login_logo_path, t.login_logo_light_path
      FROM tenants t
     WHERE t.login_subdomain = lower(p_subdomain)
       AND t.active
       AND t.suspended_at IS NULL
     LIMIT 1;
$$;

REVOKE ALL ON FUNCTION get_login_branding(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_login_branding(TEXT) TO anon, authenticated;

-- ── 4. Fecha o UPDATE de tenants para a locadora ────────────

DROP POLICY IF EXISTS "Owners can update their tenants" ON tenants;
