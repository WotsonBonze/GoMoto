-- ============================================================
-- Contatos da locadora exibidos no app do cliente
-- ============================================================
-- Antes, "Fale com a locadora" (aba Conta do mobile) mostrava só o par
-- tenants.contact_phone/contact_email — um número para tudo. A locadora quer
-- direcionar: "Financeiro (xx) ...", "Manutenção (xx) ...".
--
-- Cada linha é um contato com rótulo livre e telefone e/ou e-mail (ao menos
-- um). `sort_order` define a ordem no app.
--
-- Leitura: membros do tenant (cockpit) e clientes do tenant (mobile, via
-- get_customer_tenants()). Escrita: só Owner/Admin — é informação que todo
-- cliente vê, não preferência operacional.
-- ============================================================

CREATE TABLE tenant_contacts (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    label       VARCHAR(60)  NOT NULL,
    phone       VARCHAR(11)  NULL,
    email       VARCHAR(200) NULL,
    sort_order  INTEGER      NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_tenant_contacts_label   CHECK (length(trim(label)) > 0),
    CONSTRAINT chk_tenant_contacts_channel CHECK (phone IS NOT NULL OR email IS NOT NULL),
    CONSTRAINT chk_tenant_contacts_phone   CHECK (phone IS NULL OR phone ~ '^[0-9]{10,11}$'),
    CONSTRAINT chk_tenant_contacts_email   CHECK (email IS NULL OR position('@' in email) > 1)
);

CREATE INDEX idx_tenant_contacts_tenant ON tenant_contacts(tenant_id, sort_order);

CREATE TRIGGER update_tenant_contacts_updated_at
    BEFORE UPDATE ON tenant_contacts
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE tenant_contacts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant_contacts_member_select" ON tenant_contacts
    FOR SELECT TO authenticated
    USING (tenant_id IN (SELECT get_user_tenants()));

CREATE POLICY "tenant_contacts_customer_select" ON tenant_contacts
    FOR SELECT TO authenticated
    USING (tenant_id IN (SELECT get_customer_tenants()));

CREATE POLICY "tenant_contacts_admin_insert" ON tenant_contacts
    FOR INSERT TO authenticated
    WITH CHECK (tenant_id IN (SELECT get_user_admin_tenant_memberships()));

CREATE POLICY "tenant_contacts_admin_update" ON tenant_contacts
    FOR UPDATE TO authenticated
    USING (tenant_id IN (SELECT get_user_admin_tenant_memberships()))
    WITH CHECK (tenant_id IN (SELECT get_user_admin_tenant_memberships()));

CREATE POLICY "tenant_contacts_admin_delete" ON tenant_contacts
    FOR DELETE TO authenticated
    USING (tenant_id IN (SELECT get_user_admin_tenant_memberships()));

-- O default do schema já não concede a anon desde o ADR 0034; explícito aqui
-- para não depender do histórico de ALTER DEFAULT PRIVILEGES.
REVOKE ALL ON tenant_contacts FROM anon;
