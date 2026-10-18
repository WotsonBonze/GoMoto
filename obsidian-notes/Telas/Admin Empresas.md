# 🏢 Tela: Admin › Empresas — [[GoMoto]]

Rotas: `/admin/empresas` (lista), `/admin/empresas/novo`, `/admin/empresas/[id]` (detalhe), `/admin/empresas/[id]/editar`. Só admin da plataforma (`requirePlatformAdmin`). Actions em `apps/web/src/app/(admin)/admin/empresas/actions.ts`. Origem: [[Specs/0001-area-administrativa-plataforma]].

## Detalhe — seção "Login personalizado" (ADR 0042)

Componente `LoginBrandingForm` + action `updateTenantLoginBranding(id, formData)`.

| Campo | Coluna | Regra |
|---|---|---|
| Subdomínio do login | `tenants.login_subdomain` | `LoginSubdomainSchema` (`@gomoto/core`) + `CHECK` no banco: rótulo DNS, sem reservados (`www`, `admin`, `api`…). Vazio = login padrão Locaw. Único entre empresas. |
| Logo para fundo escuro | `tenants.login_logo_path` | Painel de marca do login. PNG/WebP/JPG ≤ 1 MB (conteúdo conferido por assinatura do arquivo). |
| Logo para fundo claro | `tenants.login_logo_light_path` | Login no celular; opcional (cai no escuro). |

- Prévia de cada logo no mesmo fundo em que aparece no login.
- Upload no bucket público `tenant-branding` como `{tenant_id}/login-logo-{kind}-{timestamp}.ext` com cache de 1 ano; o arquivo substituído/removido é apagado **depois** do UPDATE.
- Auditoria: `platform_audit_logs` com `tenant.login_branding_update` (subdomínio antes/depois, logo trocado/removido).
- Invalida o cache do login do subdomínio antigo e do novo (`revalidateTag`).
- A linha "Subdomínio" aparece também em Identidade.

## Tags
`#projeto/tela` `#gomoto/admin`
