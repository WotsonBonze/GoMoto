'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { AlertTriangle, CheckCircle2, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { formatCurrency } from '@/lib/utils'
import { payExpenseAction, cancelExpenseAction } from '../../actions'

type Props = {
  payableId: string
  status: 'open' | 'paid' | 'cancelled'
  amount: number
  customerAmount: number
  /** Do banco, no fuso do tenant — teto do input de data. */
  businessToday: string
}

export function PayableActions({ payableId, status, amount, customerAmount, businessToday }: Props) {
  const router = useRouter()
  const [saving, setSaving] = useState(false)

  const [payOpen, setPayOpen] = useState(false)
  const [payDate, setPayDate] = useState(businessToday)
  const [payError, setPayError] = useState<string | null>(null)

  const [cancelOpen, setCancelOpen] = useState(false)
  const [cancelError, setCancelError] = useState<string | null>(null)

  async function confirmarPagamento() {
    setSaving(true)
    setPayError(null)
    const result = await payExpenseAction(payableId, payDate || undefined)
    setSaving(false)

    if (!result.ok) { setPayError(result.error.message); return }
    setPayOpen(false)
    router.refresh()
  }

  async function confirmarCancelamento() {
    setSaving(true)
    setCancelError(null)
    const result = await cancelExpenseAction(payableId)
    setSaving(false)

    if (!result.ok) { setCancelError(result.error.message); return }
    setCancelOpen(false)
    router.refresh()
  }

  if (status === 'cancelled') {
    return <p className="text-[13px] text-[var(--fg-mute)]">Despesa cancelada — nenhuma ação disponível.</p>
  }

  return (
    <>
      <div className="flex gap-2">
        {status === 'open' && (
          <Button onClick={() => { setPayError(null); setPayDate(businessToday); setPayOpen(true) }}>
            <CheckCircle2 className="h-4 w-4" /> Registrar pagamento
          </Button>
        )}
        <Button variant="secondary" onClick={() => { setCancelError(null); setCancelOpen(true) }}>
          <XCircle className="h-4 w-4" /> Cancelar despesa
        </Button>
      </div>

      {/* Baixa da despesa ------------------------------------------------ */}
      <Modal open={payOpen} onClose={() => setPayOpen(false)} title="Registrar pagamento" size="sm">
        <div className="space-y-4">
          <div className="rounded-lg border border-[var(--divider)] bg-[var(--surface-2)] px-3 py-2.5 text-[13px]">
            <div className="flex justify-between">
              <span className="text-[var(--fg-mute)]">Sai do caixa</span>
              <span className="font-semibold tabular-nums text-[var(--danger)]">{formatCurrency(amount)}</span>
            </div>
            {customerAmount > 0 && (
              <p className="mt-1.5 text-[12px] leading-relaxed text-[var(--fg-mute)]">
                A empresa paga o valor cheio; {formatCurrency(customerAmount)} são repassados ao cliente
                e voltam pela cobrança — não saem daqui.
              </p>
            )}
          </div>

          <div>
            <label className="mb-1.5 block text-[13px] text-[var(--fg-mute)]" htmlFor="pay-date">
              Data do pagamento
            </label>
            <input
              id="pay-date"
              type="date"
              value={payDate}
              max={businessToday || undefined}
              onChange={(e) => setPayDate(e.target.value)}
              className="h-9 w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 text-[13px] text-[var(--fg)] outline-none focus:border-[var(--primary)]"
            />
          </div>

          {payError && <p className="text-[13px] text-[var(--danger)]">{payError}</p>}

          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setPayOpen(false)}>Cancelar</Button>
            <Button onClick={confirmarPagamento} disabled={saving || !payDate}>
              {saving ? 'Registrando…' : 'Confirmar pagamento'}
            </Button>
          </div>
        </div>
      </Modal>

      {/* Cancelamento ----------------------------------------------------- */}
      <Modal open={cancelOpen} onClose={() => setCancelOpen(false)} title="Cancelar despesa" size="sm">
        <div className="space-y-4">
          <div className="flex gap-3">
            <AlertTriangle className="h-5 w-5 shrink-0 text-[var(--warning)]" />
            <p className="text-[13px] text-[var(--fg)]">
              {status === 'paid'
                ? 'Esta despesa já foi paga — cancelar estorna o pagamento e o lançamento no razão.'
                : 'Cancelar estorna o lançamento desta despesa no razão.'}
              {customerAmount > 0 && ' A cobrança ou crédito de repasse gerados também são desfeitos, se ainda não tiverem sido usados.'}
            </p>
          </div>

          {cancelError && <p className="text-[13px] text-[var(--danger)]">{cancelError}</p>}

          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setCancelOpen(false)}>Voltar</Button>
            <Button variant="danger" onClick={confirmarCancelamento} disabled={saving}>
              {saving ? 'Cancelando…' : 'Confirmar cancelamento'}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  )
}
