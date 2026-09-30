import { notFound } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { getCurrentTenantId } from '@/lib/auth/tenant'
import { businessToday } from '@/lib/financial'
import { formatCurrency, formatDate } from '@/lib/utils'
import { StatusBadge } from '@/components/ui/Badge'
import { EXPENSE_CATEGORIES } from '../categories'
import { PayableActions } from './_components/PayableActions'

const RESPONSIBILITY_LABELS: Record<string, string> = {
  company: 'Empresa',
  customer: 'Cliente',
  shared: 'Compartilhada',
}

const REIMBURSEMENT_LABELS: Record<string, string> = {
  none: 'Não se aplica',
  charge: 'Cobrança ao cliente',
  credit: 'Crédito ao cliente',
}

export default async function ExpenseDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const supabase = await createClient()
  const tenantId = await getCurrentTenantId(supabase)
  if (!tenantId) notFound()

  const { data: payableRow, error } = await supabase
    .from('payables')
    .select('*')
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .maybeSingle()

  if (error || !payableRow) notFound()

  const payable = payableRow as {
    id: string; description: string; expense_account_code: string
    competence_date: string; due_date: string; amount: number
    status: 'open' | 'paid' | 'cancelled'; paid_at: string | null
    responsibility: 'company' | 'customer' | 'shared'
    customer_id: string | null; customer_amount: number
    reimbursement: 'none' | 'charge' | 'credit'
    vehicle_id: string | null; rental_id: string | null
    vendor_name: string | null; source_module: string; source_id: string | null
    created_at: string
  }

  const companyAmount = Math.round((payable.amount - payable.customer_amount) * 100) / 100

  // A cobrança de repasse (quando existe) nasce com `source_module` do próprio
  // payable e `source_id` = a origem externa quando ela existir (manutenção,
  // multa) ou o próprio payable quando não existir (`fn_create_payable`,
  // `COALESCE(v_source_id, v_payable)`) — mesma regra dos dois lados.
  const [vehicleRes, customerRes, rentalRes, chargeRes, creditRes, hojeNegocio] = await Promise.all([
    payable.vehicle_id
      ? supabase.from('vehicles').select('id, license_plate, make, model').eq('id', payable.vehicle_id).maybeSingle()
      : Promise.resolve({ data: null }),
    payable.customer_id
      ? supabase.from('customers').select('id, name, phone').eq('id', payable.customer_id).maybeSingle()
      : Promise.resolve({ data: null }),
    payable.rental_id
      ? supabase.from('rentals').select('id').eq('id', payable.rental_id).maybeSingle()
      : Promise.resolve({ data: null }),
    payable.customer_amount > 0
      ? supabase
          .from('charges')
          .select('id, status, due_date, charge_number')
          .eq('tenant_id', tenantId)
          .eq('source_module', payable.source_module)
          .eq('source_id', payable.source_id ?? payable.id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    payable.customer_amount > 0
      ? supabase
          .from('customer_credits')
          .select('id, amount, origin, reason, created_at')
          .eq('payable_id', payable.id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    businessToday(supabase, tenantId),
  ])

  const vehicle = vehicleRes.data as { id: string; license_plate: string; make: string; model: string } | null
  const customer = customerRes.data as { id: string; name: string; phone: string | null } | null
  const rental = rentalRes.data as { id: string } | null
  const charge = chargeRes.data as { id: string; status: string; due_date: string; charge_number: number } | null
  const credit = creditRes.data as { id: string; amount: number; origin: string; reason: string; created_at: string } | null

  const categoryLabel = EXPENSE_CATEGORIES.find((c) => c.value === payable.expense_account_code)?.label
    ?? payable.expense_account_code

  return (
    <div className="min-h-screen bg-[var(--bg)]">
      <div className="sticky top-0 z-10 flex h-16 items-center gap-4 border-b border-[var(--divider)] bg-[var(--bg)] px-6">
        <Link href="/despesas" className="whitespace-nowrap text-[13px] text-[var(--fg-mute)] transition-colors hover:text-[var(--fg)]">
          ← Despesas
        </Link>
        <span className="text-[var(--border)]">/</span>
        <h1 className="flex-1 truncate text-[15px] font-bold text-[var(--fg)]">
          {payable.description}
        </h1>
      </div>

      <div className="mx-auto max-w-4xl space-y-6 px-6 py-6">

        {/* ── Status + valor ────────────────────────────────────────────── */}
        <div className="flex flex-wrap items-center gap-4">
          <StatusBadge status={payable.status} />
          <span className="text-2xl font-bold text-[var(--fg)]">
            {formatCurrency(payable.amount)}
          </span>
          {payable.customer_amount > 0 && (
            <span className="text-[14px] text-[var(--fg-mute)]">
              {formatCurrency(companyAmount)} empresa + {formatCurrency(payable.customer_amount)} cliente
            </span>
          )}
        </div>

        {/* ── Dados da despesa ───────────────────────────────────────────── */}
        <section>
          <h2 className="mb-3 text-[14px] font-bold text-[var(--primary)]">Despesa</h2>
          <div className="overflow-hidden rounded-xl bg-[var(--surface)]">
            <table className="w-full text-[13px]">
              <tbody>
                {([
                  ['Categoria', categoryLabel],
                  ['Fornecedor', payable.vendor_name],
                  ['Competência', formatDate(payable.competence_date)],
                  ['Vencimento', formatDate(payable.due_date)],
                  ['Pago em', payable.status === 'paid' && payable.paid_at ? formatDate(payable.paid_at) : null],
                ] as [string, string | null | undefined][]).filter(([, v]) => v).map(([label, value]) => (
                  <tr key={label} className="border-b border-[var(--divider)] last:border-0">
                    <td className="h-9 w-44 shrink-0 px-4 text-[var(--fg-mute)]">{label}</td>
                    <td className="h-9 px-4 text-[var(--fg)]">{value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* ── Vínculo ────────────────────────────────────────────────────── */}
        {(customer || vehicle || rental) && (
          <section>
            <h2 className="mb-3 text-[14px] font-bold text-[var(--primary)]">Vínculo</h2>
            <div className="grid grid-cols-2 gap-4">
              {customer && (
                <div className="space-y-1 rounded-xl bg-[var(--surface)] p-4">
                  <p className="text-[12px] font-medium uppercase tracking-wide text-[var(--fg-mute)]">Cliente</p>
                  <p className="text-[15px] font-bold text-[var(--fg)]">{customer.name}</p>
                  {customer.phone && <p className="text-[13px] text-[var(--fg-mute)]">{customer.phone}</p>}
                  <Link href={`/clientes/${customer.id}`} className="text-[12px] text-[var(--fg-mute)] transition-colors hover:text-[var(--primary)]">
                    Ver cliente →
                  </Link>
                </div>
              )}
              {vehicle && (
                <div className="space-y-1 rounded-xl bg-[var(--surface)] p-4">
                  <p className="text-[12px] font-medium uppercase tracking-wide text-[var(--fg-mute)]">Veículo</p>
                  <p className="font-mono text-[15px] font-bold text-[var(--primary)]">{vehicle.license_plate}</p>
                  <p className="text-[13px] text-[var(--fg)]">{vehicle.make} {vehicle.model}</p>
                  <Link href={`/veiculos/${vehicle.id}`} className="text-[12px] text-[var(--fg-mute)] transition-colors hover:text-[var(--primary)]">
                    Ver veículo →
                  </Link>
                </div>
              )}
              {rental && (
                <div className="space-y-1 rounded-xl bg-[var(--surface)] p-4">
                  <p className="text-[12px] font-medium uppercase tracking-wide text-[var(--fg-mute)]">Locação</p>
                  <Link href={`/locacoes/${rental.id}`} className="text-[12px] text-[var(--fg-mute)] transition-colors hover:text-[var(--primary)]">
                    {rental.id.slice(0, 8)} →
                  </Link>
                </div>
              )}
            </div>
          </section>
        )}

        {/* ── Responsabilidade e repasse ──────────────────────────────────── */}
        {payable.customer_amount > 0 && (
          <section>
            <h2 className="mb-3 text-[14px] font-bold text-[var(--primary)]">Responsabilidade e repasse</h2>
            <div className="overflow-hidden rounded-xl bg-[var(--surface)]">
              <table className="w-full text-[13px]">
                <tbody>
                  <tr className="border-b border-[var(--divider)]">
                    <td className="h-9 w-44 shrink-0 px-4 text-[var(--fg-mute)]">Responsabilidade</td>
                    <td className="h-9 px-4 text-[var(--fg)]">{RESPONSIBILITY_LABELS[payable.responsibility] ?? payable.responsibility}</td>
                  </tr>
                  <tr className="border-b border-[var(--divider)] last:border-0">
                    <td className="h-9 w-44 shrink-0 px-4 text-[var(--fg-mute)]">Como devolve</td>
                    <td className="h-9 px-4 text-[var(--fg)]">{REIMBURSEMENT_LABELS[payable.reimbursement] ?? payable.reimbursement}</td>
                  </tr>
                  {charge && (
                    <tr className="border-b border-[var(--divider)] last:border-0">
                      <td className="h-9 w-44 shrink-0 px-4 text-[var(--fg-mute)]">Cobrança gerada</td>
                      <td className="h-9 px-4">
                        <Link href={`/cobrancas/${charge.id}`} className="text-[var(--primary)] hover:underline">
                          Cobrança #{charge.charge_number} →
                        </Link>
                        <span className="ml-2"><StatusBadge status={charge.status} /></span>
                      </td>
                    </tr>
                  )}
                  {credit && (
                    <tr className="last:border-0">
                      <td className="h-9 w-44 shrink-0 px-4 text-[var(--fg-mute)]">Crédito gerado</td>
                      <td className="h-9 px-4 text-[var(--fg)]">
                        {formatCurrency(credit.amount)} em {formatDate(credit.created_at)}
                        {customer && (
                          <Link href={`/clientes/${customer.id}`} className="ml-2 text-[12px] text-[var(--fg-mute)] hover:text-[var(--primary)]">
                            ver no cliente →
                          </Link>
                        )}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {/* ── Ações ─────────────────────────────────────────────────────── */}
        <section>
          <h2 className="mb-3 text-[14px] font-bold text-[var(--primary)]">Ações</h2>
          <PayableActions
            payableId={payable.id}
            status={payable.status}
            amount={payable.amount}
            customerAmount={payable.customer_amount}
            businessToday={hojeNegocio}
          />
        </section>

      </div>
    </div>
  )
}
