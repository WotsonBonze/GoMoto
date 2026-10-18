import { notFound } from 'next/navigation'
import Link from 'next/link'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { applyCnpjMask, applyZipMask, applyPhoneMask } from '@gomoto/core'
import { requirePlatformAdmin } from '@/lib/auth/platform'
import { SuspendActions } from './_components/SuspendActions'
import { OwnerActions } from './_components/OwnerActions'
import { LoginBrandingForm } from './_components/LoginBrandingForm'
import { loginBrandingPublicUrl, loginRootDomain } from '@/lib/login-branding'

// ─── Auxiliares ───────────────────────────────────────────────────────────────

function fmt(d: string | null | undefined) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function Row({
  label,
  value,
  mono = false,
}: {
  label: string
  value?: string | null
  mono?: boolean
}) {
  return (
    <tr className="border-b border-divider last:border-0">
      <td className="h-9 px-4 text-fg-mute w-48 shrink-0 text-[13px]">{label}</td>
      <td
        className={`h-9 px-4 text-[13px] ${mono ? 'font-mono' : ''} ${
          value ? 'text-fg' : 'text-fg-mute italic'
        }`}
      >
        {value ?? '—'}
      </td>
    </tr>
  )
}

// ─── Página ───────────────────────────────────────────────────────────────────

export default async function EmpresaDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const { supabase } = await requirePlatformAdmin()

  // Dados do tenant
  const { data: tenant, error } = await supabase
    .from('tenants')
    .select('*')
    .eq('id', id)
    .single()

  if (error || !tenant) notFound()

  // Membro owner
  const { data: ownerMember } = await supabase
    .from('tenant_members')
    .select('user_id, created_at')
    .eq('tenant_id', id)
    .eq('role', 'owner')
    .limit(1)
    .maybeSingle()

  // Info do owner via service role (auth.users não exposta via cliente normal)
  let ownerName: string | null = null
  let ownerEmail: string | null = null
  if (ownerMember) {
    const serviceUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (serviceUrl && serviceKey) {
      const adminClient = createAdminClient(serviceUrl, serviceKey, {
        auth: { persistSession: false },
      })
      const { data: authUser } = await adminClient.auth.admin.getUserById(ownerMember.user_id)
      ownerName  = authUser?.user?.user_metadata?.name ?? null
      ownerEmail = authUser?.user?.email ?? null
    }
  }

  // Stats de uso (platform_admin_bypass_* permite leitura de tabelas de domínio)
  const [vehiclesRes, customersRes, rentalsRes] = await Promise.all([
    supabase
      .from('vehicles')
      .select('*', { count: 'exact', head: true })
      .eq('tenant_id', id),
    supabase
      .from('customers')
      .select('*', { count: 'exact', head: true })
      .eq('tenant_id', id),
    supabase
      .from('rentals')
      .select('*', { count: 'exact', head: true })
      .eq('tenant_id', id)
      .eq('status', 'active'),
  ])

  const vehicleCount  = vehiclesRes.count  ?? 0
  const customerCount = customersRes.count ?? 0
  const rentalCount   = rentalsRes.count   ?? 0

  // Histórico de ações da plataforma para este tenant
  const { data: auditLogs } = await supabase
    .from('platform_audit_logs')
    .select('id, action, actor_id, metadata, created_at')
    .eq('target_type', 'tenant')
    .eq('target_id', id)
    .order('created_at', { ascending: false })
    .limit(20)

  // ── Derivados ─────────────────────────────────────────────────────────────

  const isSuspended = !!tenant.suspended_at

  const cnpjFormatted = tenant.cnpj ? applyCnpjMask(tenant.cnpj) : null
  const zipFormatted  = tenant.address_zip ? applyZipMask(tenant.address_zip) : null
  const phoneFormatted = tenant.contact_phone ? applyPhoneMask(tenant.contact_phone) : null

  const addressLine = [
    tenant.address_street && tenant.address_number
      ? `${tenant.address_street}, ${tenant.address_number}`
      : tenant.address_street,
    tenant.address_complement,
    tenant.address_district,
  ]
    .filter(Boolean)
    .join(', ')

  const cityUf = [tenant.address_city, tenant.address_state].filter(Boolean).join(' — ')

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-bg">

      {/* Header */}
      <div className="sticky top-0 z-10 bg-bg border-b border-divider px-6 h-16 flex items-center gap-4">
        <Link
          href="/admin/empresas"
          className="text-[13px] text-fg-mute hover:text-fg transition-colors whitespace-nowrap"
        >
          ← Empresas
        </Link>
        <span className="text-border">/</span>
        <h1 className="text-[18px] font-bold text-fg flex-1 truncate">{tenant.name}</h1>
        <div className="ml-auto flex items-center gap-2">
          <SuspendActions
            tenantId={id}
            tenantName={tenant.name}
            isSuspended={isSuspended}
          />
          <Link
            href={`/admin/empresas/${id}/editar`}
            className="inline-flex items-center h-9 px-4 rounded-full bg-surface-2 text-fg text-[13px] font-medium hover:bg-divider transition-colors"
          >
            Editar
          </Link>
        </div>
      </div>

      <div className="px-6 py-6 space-y-6 max-w-4xl mx-auto">

        {/* Status badges */}
        <div className="flex items-center gap-3 flex-wrap">
          <span
            className={`inline-flex items-center h-7 px-3 rounded-full text-[13px] font-medium border ${
              isSuspended
                ? 'bg-danger-bg text-danger border-danger'
                : 'bg-success-bg text-success border-success'
            }`}
          >
            {isSuspended ? 'Suspensa' : 'Ativa'}
          </span>
          <span className="text-[13px] text-fg-mute font-mono">{tenant.slug}</span>
        </div>

        {/* Aviso de suspensão */}
        {isSuspended && (
          <div className="rounded-xl bg-danger-bg border border-danger px-4 py-3 space-y-0.5">
            <p className="text-[13px] font-medium text-danger">Empresa suspensa</p>
            {tenant.suspended_at && (
              <p className="text-[12px] text-fg-mute">
                Desde {fmt(tenant.suspended_at)}
                {tenant.suspended_reason ? ` — ${tenant.suspended_reason}` : ''}
              </p>
            )}
          </div>
        )}

        {/* Identidade */}
        <section>
          <h2 className="text-[14px] font-bold text-primary mb-3">Identidade</h2>
          <div className="bg-surface rounded-xl overflow-hidden">
            <table className="w-full text-[13px]">
              <tbody>
                <Row label="Nome fantasia"  value={tenant.name} />
                <Row label="Razão social"   value={tenant.legal_name} />
                <Row label="Slug"           value={tenant.slug} mono />
                <Row label="Subdomínio"     value={tenant.login_subdomain ? `${tenant.login_subdomain}.${loginRootDomain()}` : null} mono />
                <Row label="CNPJ"           value={cnpjFormatted} mono />
                <Row label="Cadastrado em"  value={fmt(tenant.created_at)} />
              </tbody>
            </table>
          </div>
        </section>

        {/* Contato */}
        <section>
          <h2 className="text-[14px] font-bold text-primary mb-3">Contato</h2>
          <div className="bg-surface rounded-xl overflow-hidden">
            <table className="w-full text-[13px]">
              <tbody>
                <Row label="Email"    value={tenant.contact_email} />
                <Row label="Telefone" value={phoneFormatted} mono />
              </tbody>
            </table>
          </div>
        </section>

        {/* Endereço */}
        {(tenant.address_street || tenant.address_city) && (
          <section>
            <h2 className="text-[14px] font-bold text-primary mb-3">Endereço</h2>
            <div className="bg-surface rounded-xl overflow-hidden">
              <table className="w-full text-[13px]">
                <tbody>
                  {addressLine && <Row label="Logradouro" value={addressLine} />}
                  <Row label="Cidade / UF" value={cityUf || null} />
                  <Row label="CEP" value={zipFormatted} mono />
                </tbody>
              </table>
            </div>
          </section>
        )}

        {/* Acesso — owner */}
        <section>
          <h2 className="text-[14px] font-bold text-primary mb-3">Responsável</h2>
          <div className="bg-surface rounded-xl overflow-hidden">
            <table className="w-full text-[13px]">
              <tbody>
                <Row label="Nome"      value={ownerName} />
                <Row label="Email"     value={ownerEmail} />
                {ownerMember?.created_at && (
                  <Row label="Membro desde" value={fmt(ownerMember.created_at)} />
                )}
              </tbody>
            </table>
            <div className="border-t border-divider px-4 py-3">
              <OwnerActions tenantId={id} />
            </div>
          </div>
        </section>

        {/* Login personalizado (ADR 0042) */}
        <section>
          <h2 className="text-[14px] font-bold text-primary mb-3">Login personalizado</h2>
          <div className="bg-surface rounded-xl overflow-hidden">
            <LoginBrandingForm
              tenantId={id}
              rootDomain={loginRootDomain()}
              initialSubdomain={tenant.login_subdomain}
              logoUrl={loginBrandingPublicUrl(tenant.login_logo_path)}
              logoLightUrl={loginBrandingPublicUrl(tenant.login_logo_light_path)}
            />
          </div>
        </section>

        {/* Stats de uso */}
        <section>
          <h2 className="text-[14px] font-bold text-primary mb-3">Uso da plataforma</h2>
          <div className="grid grid-cols-3 gap-3">
            {[
              { label: 'Veículos',          value: vehicleCount  },
              { label: 'Clientes',          value: customerCount },
              { label: 'Contratos ativos',  value: rentalCount   },
            ].map(({ label, value }) => (
              <div
                key={label}
                className="bg-surface rounded-xl border border-divider px-4 py-3 text-center"
              >
                <p className="text-[24px] font-bold text-fg">{value}</p>
                <p className="text-[12px] text-fg-mute mt-0.5">{label}</p>
              </div>
            ))}
          </div>
        </section>

        {/* Histórico de ações */}
        {auditLogs && auditLogs.length > 0 && (
          <section>
            <h2 className="text-[14px] font-bold text-primary mb-3">Histórico de ações</h2>
            <div className="bg-surface rounded-xl overflow-hidden">
              <table className="w-full text-[13px]">
                <thead className="border-b border-divider">
                  <tr>
                    <th className="h-9 px-4 text-fg-mute font-medium text-left">Ação</th>
                    <th className="h-9 px-4 text-fg-mute font-medium text-left hidden sm:table-cell">Detalhes</th>
                    <th className="h-9 px-4 text-fg-mute font-medium text-right">Data</th>
                  </tr>
                </thead>
                <tbody>
                  {auditLogs.map((log) => (
                    <tr key={log.id} className="h-9 border-b border-divider last:border-0">
                      <td className="px-4 font-mono text-[12px] text-fg-mute">{log.action}</td>
                      <td className="px-4 text-[12px] text-fg-mute hidden sm:table-cell">
                        {log.metadata && Object.keys(log.metadata as object).length > 0
                          ? Object.entries(log.metadata as Record<string, unknown>)
                              .filter(([, v]) => v !== null && v !== '')
                              .map(([k, v]) => `${k}: ${v}`)
                              .join(' · ')
                          : '—'}
                      </td>
                      <td className="px-4 text-right text-[12px] text-fg-mute whitespace-nowrap">
                        {fmt(log.created_at as string)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

      </div>
    </div>
  )
}
