import type { ReactNode } from 'react'
import Link from 'next/link'
import {
  Edit2, X, SlidersHorizontal, Zap,
} from 'lucide-react'
import { formatCurrency } from '@/lib/utils'
import { getRentalCore } from './_lib/get-rental-core'
import { STATUS_BADGE, CYCLE_LABEL } from './_lib/shared'
import { RentalTabNav } from './_components/RentalTabNav'

export default async function RentalDetailLayout({
  children,
  params,
}: {
  children: ReactNode
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const { rental } = await getRentalCore(id)

  const statusCfg = STATUS_BADGE[rental.status] ?? STATUS_BADGE.closed
  const isActive  = rental.status === 'active'
  const hasAnyInspectionLink = Boolean(
    rental.checkin_checkout_inspection_profile_id || rental.periodic_inspection_profile_id,
  )

  return (
    <div className="min-h-screen bg-bg">

      <div className="sticky top-0 z-10 bg-bg">

        {/* ── Header: breadcrumb + título + ações ──────────────────────────── */}
        <div className="flex h-16 items-center gap-4 border-b border-divider px-6">
          <Link href="/locacoes" className="whitespace-nowrap text-[13px] text-fg-mute transition-colors hover:text-fg">
            ← Locações
          </Link>
          <span className="text-border">/</span>
          <h1 className="flex-1 truncate text-[15px] font-bold text-fg">
            {rental.customer?.name ?? '—'} · {rental.vehicle?.license_plate ?? '—'}
          </h1>

          <div className="flex items-center gap-2">
            {isActive && (
              <>
                <Link
                  href={`/locacoes/${id}/cobranca-avulsa`}
                  className="inline-flex h-9 items-center gap-1.5 rounded-full border border-border px-3 text-[13px] text-fg-mute transition-colors hover:border-fg-mute hover:text-fg"
                  title="Cobrança Avulsa"
                >
                  <Zap className="h-4 w-4" />
                  Cobrança avulsa
                </Link>
                {/* Renovar e Reajustar eram dois recortes do mesmo ato — e ter
                    dois donos para o prazo fazia as regras divergirem (ADR 0035). */}
                <Link
                  href={`/locacoes/${id}/ajustar`}
                  className="inline-flex h-9 items-center gap-1.5 rounded-full border border-border px-3 text-[13px] text-fg-mute transition-colors hover:border-fg-mute hover:text-fg"
                  title="Ajustar período, ciclo e valor"
                >
                  <SlidersHorizontal className="h-4 w-4" />
                  Ajustar
                </Link>
                <Link
                  href={`/locacoes/${id}/encerrar`}
                  className="inline-flex h-9 items-center gap-1.5 rounded-full border border-danger bg-danger-bg px-3 text-[13px] text-danger transition-opacity hover:opacity-80"
                  title="Encerrar"
                >
                  <X className="h-4 w-4" />
                  Encerrar
                </Link>
              </>
            )}
            <Link
              href={`/locacoes/${id}/editar`}
              className="inline-flex h-9 items-center gap-1.5 rounded-full bg-surface-2 px-3 text-[13px] text-fg transition-colors hover:bg-divider"
            >
              <Edit2 className="h-4 w-4" />
              Editar
            </Link>
          </div>
        </div>

        {/* ── Status + valor do ciclo ───────────────────────────────────────── */}
        <div className="flex flex-wrap items-center gap-4 border-b border-divider px-6 py-3">
          <span className={`inline-flex h-7 items-center rounded-full border border-transparent px-3 text-[13px] font-medium ${statusCfg.bg} ${statusCfg.text}`}>
            {statusCfg.label}
          </span>
          <span className="text-[15px] font-bold text-fg">
            {rental.cycle_amount != null ? formatCurrency(rental.cycle_amount) : '—'}
            <span className="ml-1 text-[13px] font-normal text-fg-mute">/{CYCLE_LABEL[rental.cycle ?? 'monthly'] ?? 'ciclo'}</span>
          </span>
        </div>

        {/* ── Navegação por abas ────────────────────────────────────────────── */}
        <RentalTabNav rentalId={id} showVistorias={hasAnyInspectionLink} />
      </div>

      <div className="mx-auto max-w-4xl space-y-6 px-6 py-6">
        {children}
      </div>
    </div>
  )
}
