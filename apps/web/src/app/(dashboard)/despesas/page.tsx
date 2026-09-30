/**
 * @file page.tsx
 * @description Despesas — contas a pagar da empresa (Spec 0014 / ADR 0024).
 *
 * Reescrita sobre `payables`. A mudança que importa é a RESPONSABILIDADE
 * FINANCEIRA, que passa a existir de fato.
 *
 * A tabela `expenses` não tinha coluna de responsabilidade, nem `customer_id`,
 * nem `rental_id`: despesa compartilhada era inmodelável (F-07). Gerar cobrança
 * a partir de uma despesa era um segundo passo manual, com o INSERT em
 * `billings` escrito à mão na action — uma das três cópias divergentes daquela
 * lógica.
 *
 * Agora o rateio é declarado no cadastro, em VALORES e não em percentual
 * (Princípio 7), e a parte do cliente vira cobrança ou crédito conforme quem
 * executou o serviço.
 */

'use client'

import { useState, useMemo } from 'react'
import Link from 'next/link'
import { useQueryClient } from '@tanstack/react-query'
import {
  Plus, Search, Wallet, TrendingDown, Users, CheckCircle2, XCircle, AlertTriangle, Eye,
} from 'lucide-react'
import { PageTitle } from '@/components/layout/PageTitle'
import { Button } from '@/components/ui/Button'
import { StatusBadge } from '@/components/ui/Badge'
import { Card, StatCard } from '@/components/ui/Card'
import { Input, Select, Textarea } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { formatCurrency, formatDate } from '@/lib/utils'
import { usePayables, useCustomers, useVehicles, useActiveRentals, useBusinessToday } from '@gomoto/data'
import { splitResponsibility } from '@gomoto/core'
import { createExpenseAction, payExpenseAction, cancelExpenseAction } from './actions'
import { EXPENSE_CATEGORIES } from './categories'

type PayableRow = NonNullable<ReturnType<typeof usePayables>['data']>[number]

const TABS = [
  { label: 'Em aberto', value: 'open' },
  { label: 'Pagas', value: 'paid' },
  { label: 'Canceladas', value: 'cancelled' },
  { label: 'Todas', value: 'all' },
]

const RESPONSIBILITY_OPTIONS = [
  { value: 'company', label: 'Empresa' },
  { value: 'customer', label: 'Cliente' },
  { value: 'shared', label: 'Compartilhada' },
]

const REIMBURSEMENT_OPTIONS = [
  { value: 'charge', label: 'Cobrar do cliente' },
  { value: 'credit', label: 'Gerar crédito ao cliente' },
]

const emptyForm = {
  description: '',
  expense_account_code: EXPENSE_CATEGORIES[0]!.value as string,
  competence_date: todayIso(),
  due_date: todayIso(),
  amount: '',
  responsibility: 'company',
  customer_id: '',
  customer_amount: '',
  reimbursement: 'charge',
  vehicle_id: '',
  rental_id: '',
  vendor_name: '',
}

export default function ExpensesPage() {
  const queryClient = useQueryClient()

  const payablesQuery = usePayables()
  // Do BANCO, no fuso do tenant — não de `new Date()`, que é o relógio de quem
  // abriu a tela e não sabe onde o dia do negócio termina.
  const businessToday = useBusinessToday().data ?? ''
  const customersQuery = useCustomers()
  const vehiclesQuery = useVehicles()
  const rentalsQuery = useActiveRentals()

  const payables = useMemo(() => payablesQuery.data ?? [], [payablesQuery.data])

  const [activeTab, setActiveTab] = useState('open')
  const [search, setSearch] = useState('')
  const [saving, setSaving] = useState(false)
  const [feedback, setFeedback] = useState<string | null>(null)
  /** Recusa da action. Vive separado de `feedback`, que é a faixa de sucesso no
   *  topo da página: a explicação de por que a despesa NÃO foi cancelada
   *  aparecia ali embaixo, longe da linha clicada e fácil de não ver. Recusa
   *  exige leitura, então vai para um modal que precisa ser fechado. */
  const [alertMessage, setAlertMessage] = useState<string | null>(null)
  /** Erro do cadastro. Fica DENTRO do modal aberto — empilhar o modal de alerta
   *  por cima de outro modal desbloquearia o scroll da página ao fechar. */
  const [formError, setFormError] = useState<string | null>(null)

  /**
   * Despesa que está sendo baixada.
   *
   * O botão pagava direto no clique: um ícone de 16px tirava dinheiro do caixa,
   * sem dizer quanto nem quando, e sem volta pelo caminho normal — só cancelando
   * a despesa, que estorna. E a data era sempre hoje, sem escolha: pagar a
   * oficina na sexta e lançar na segunda não tinha caminho, embora o
   * recebimento de cobrança trate esse mesmo caso.
   */
  const [paying, setPaying] = useState<PayableRow | null>(null)
  const [payDate, setPayDate] = useState('')
  const [payError, setPayError] = useState<string | null>(null)

  const [modalOpen, setModalOpen] = useState(false)
  const [form, setForm] = useState(emptyForm)
  /** Percentual é entrada de UI; o que vai ao banco é sempre valor. */
  const [shareAmount, setShareAmount] = useState('')
  /**
   * "Já paga": registra e baixa numa tacada só, para quem está lançando uma
   * conta que já saiu do caixa (ex.: dado retroativo) — sem precisar abrir o
   * modal de baixa logo em seguida. São duas chamadas de servidor em sequência
   * (create, depois pay), não uma transação só: se a segunda falhar, a despesa
   * fica criada e em aberto — estado normal, que o operador resolve com um
   * clique a mais, não um dado quebrado.
   */
  const [createPaid, setCreatePaid] = useState(false)
  const [createPaidAt, setCreatePaidAt] = useState('')

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['payables'] })

  const metrics = useMemo(() => {
    const open = payables.filter((p) => p.status === 'open')
    const paid = payables.filter((p) => p.status === 'paid')

    return {
      openTotal: open.reduce((s, p) => s + p.company_amount, 0),
      paidTotal: paid.reduce((s, p) => s + p.company_amount, 0),
      // Quanto está sendo repassado ao cliente — visível separado do custo,
      // porque repasse reduz custo em vez de virar receita (ADR 0024, R-03).
      reimbursable: payables
        .filter((p) => p.status !== 'cancelled')
        .reduce((s, p) => s + p.customer_amount, 0),
    }
  }, [payables])

  const visible = useMemo(() => {
    let list = payables
    if (activeTab !== 'all') list = list.filter((p) => p.status === activeTab)

    const term = search.trim().toLowerCase()
    if (term) {
      list = list.filter(
        (p) =>
          p.description.toLowerCase().includes(term) ||
          (p.vendor_name ?? '').toLowerCase().includes(term),
      )
    }
    return list
  }, [payables, activeTab, search])

  /** Prévia do rateio: converte o percentual da UI em valores que fecham. */
  // Rateio em VALOR, não percentual (ADR 0024, Princípio 7).
  //
  // A tela pedia percentual inteiro de 1 a 99 e derivava o valor. Com isso o
  // rateio de 1/3 — o exemplo que motivou o princípio — era inalcançável: 33%
  // de R$ 300 dá R$ 99, e nenhum inteiro dá R$ 100. O operador não conseguia
  // dizer "o cliente paga cem reais", que é a frase que ele tem na cabeça.
  const splitPreview = useMemo(() => {
    const amount = Number(form.amount)
    const customer = Number(shareAmount)
    if (form.responsibility !== 'shared' || !(amount > 0)) return null
    if (!(customer > 0) || customer >= amount) return null

    try {
      return splitResponsibility(amount, 'shared', customer)
    } catch {
      return null
    }
  }, [form.amount, form.responsibility, shareAmount])

  const customerAmount = useMemo(() => {
    const amount = Number(form.amount) || 0
    if (form.responsibility === 'company') return 0
    if (form.responsibility === 'customer') return amount
    return splitPreview?.customer_amount ?? 0
  }, [form.responsibility, form.amount, splitPreview])

  // Cliente 100% responsável, ou rateio devolvido por crédito: a despesa já
  // nasce paga sozinha (a empresa nunca deve ao fornecedor nesses casos — ver
  // `fn_create_payable`). "Já paga" não faz sentido perguntar de novo ali.
  const bornAlreadyPaid =
    form.responsibility === 'customer' || (customerAmount > 0 && form.reimbursement === 'credit')

  async function handleCreate() {
    setSaving(true)
    setFeedback(null)
    setFormError(null)

    const amount = Number(form.amount)
    const result = await createExpenseAction({
      description: form.description,
      expense_account_code: form.expense_account_code,
      competence_date: form.competence_date,
      due_date: form.due_date,
      amount,
      responsibility: form.responsibility,
      customer_id: form.customer_id || null,
      customer_amount: customerAmount,
      reimbursement: customerAmount > 0 ? form.reimbursement : 'none',
      vehicle_id: form.vehicle_id || null,
      rental_id: form.rental_id || null,
      vendor_name: form.vendor_name || null,
      source_module: 'expense',
    })

    if (!result.ok) {
      setSaving(false)
      setFormError(result.error.message)
      return
    }

    let paidFeedback = ''
    if (createPaid && !bornAlreadyPaid) {
      const payResult = await payExpenseAction(result.data.payable_id, createPaidAt || undefined)
      // "Conta já paga" só acontece se o próprio create já tiver quitado —
      // não é erro, é o resultado que o operador queria de qualquer jeito.
      if (payResult.ok || payResult.error.message === 'Conta já paga') {
        paidFeedback = ' e já registrada como paga'
      } else {
        paidFeedback = `, mas não foi possível marcar como paga: ${payResult.error.message}`
      }
    }

    setSaving(false)
    setModalOpen(false)
    setForm(emptyForm)
    setCreatePaid(false)
    setCreatePaidAt('')

    setFeedback(
      (result.data.charge_id
        ? 'Despesa registrada e cobrança gerada para o cliente'
        : result.data.credit_id
          ? 'Despesa registrada e crédito concedido ao cliente'
          : 'Despesa registrada') + paidFeedback + '.',
    )
    refresh()
  }

  function abrirPagamento(p: PayableRow) {
    setPayError(null)
    // `todayIso()` só como SUGESTÃO visual, se a régua do banco ainda não
    // chegou — nunca como valor gravado às cegas, que era o defeito. O servidor
    // recusa data futura de todo jeito.
    setPayDate(businessToday || todayIso())
    setPaying(p)
  }

  async function confirmarPagamento() {
    if (!paying) return
    setSaving(true)
    setPayError(null)

    // A data vai explícita porque o operador pôde escolher. Omitir só quando a
    // régua ainda não chegou do banco — aí o servidor resolve, que é o certo
    // de todo jeito.
    const result = await payExpenseAction(paying.id, payDate || undefined)
    setSaving(false)

    if (!result.ok) { setPayError(result.error.message); return }

    setPaying(null)
    setFeedback(`Pagamento de ${formatCurrency(paying.amount)} registrado.`)
    refresh()
  }

  async function handleCancel(p: PayableRow) {
    setSaving(true)
    setFeedback(null)
    const result = await cancelExpenseAction(p.id)
    setSaving(false)

    if (!result.ok) { setAlertMessage(result.error.message); return }
    setFeedback('Despesa cancelada.')
    refresh()
  }

  const customers = (customersQuery.data ?? []).filter((c) => c.active)
  const vehicles = vehiclesQuery.data ?? []
  const rentals = rentalsQuery.data ?? []

  const vehiclePlateById = useMemo(
    () => new Map(vehicles.map((v) => [v.id, v.license_plate])),
    [vehicles],
  )
  const categoryLabelByCode = useMemo(
    () => new Map<string, string>(EXPENSE_CATEGORIES.map((c) => [c.value, c.label])),
    [],
  )

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <PageTitle title="Despesas" subtitle="Contas a pagar e rateio com o cliente" />
        <Button onClick={() => { setFormError(null); setModalOpen(true) }}>
          <Plus className="h-4 w-4" /> Nova despesa
        </Button>
      </div>

      {feedback && (
        <div className="border border-[var(--border)] bg-[var(--surface-2)] px-4 py-3 text-[13px]">
          {feedback}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard title="Em aberto" value={formatCurrency(metrics.openTotal)} icon={Wallet}
          subtitle="Parte da empresa" />
        <StatCard title="Pago" value={formatCurrency(metrics.paidTotal)} icon={TrendingDown}
          subtitle="Parte da empresa" />
        <StatCard title="Repassado" value={formatCurrency(metrics.reimbursable)} icon={Users}
          color="info" subtitle="Recuperado do cliente" />
      </div>

      <Card>
        <div className="flex flex-wrap items-center gap-2 border-b border-[var(--divider)] p-4">
          {TABS.map((t) => (
            <button
              key={t.value}
              onClick={() => setActiveTab(t.value)}
              className={`px-3 py-1.5 text-[13px] transition-colors ${
                activeTab === t.value
                  ? 'bg-[var(--primary)] text-[var(--primary-contrast)]'
                  : 'text-[var(--fg-soft)] hover:bg-[var(--surface-2)]'
              }`}
            >
              {t.label}
            </button>
          ))}

          <div className="ml-auto relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--fg-mute)]" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Descrição ou fornecedor"
              className="pl-9"
            />
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-[var(--divider)] text-left text-[11px] uppercase tracking-wide text-[var(--fg-mute)]">
                <th className="px-4 py-2 font-medium">Descrição</th>
                <th className="px-4 py-2 font-medium">Tipo</th>
                <th className="px-4 py-2 font-medium">Veículo</th>
                <th className="px-4 py-2 font-medium">Competência</th>
                <th className="px-4 py-2 font-medium">Vencimento</th>
                <th className="px-4 py-2 font-medium">Pago em</th>
                <th className="px-4 py-2 font-medium text-right">Total</th>
                <th className="px-4 py-2 font-medium text-right">Empresa</th>
                <th className="px-4 py-2 font-medium text-right">Cliente</th>
                <th className="px-4 py-2 font-medium">Situação</th>
                <th className="px-4 py-2 font-medium text-right">Ações</th>
              </tr>
            </thead>
            <tbody>
              {payablesQuery.isLoading && (
                <tr><td colSpan={11} className="px-4 py-8 text-center text-[13px] text-[var(--fg-mute)]">Carregando…</td></tr>
              )}

              {!payablesQuery.isLoading && visible.length === 0 && (
                <tr><td colSpan={11} className="px-4 py-8 text-center text-[13px] text-[var(--fg-mute)]">Nenhuma despesa encontrada.</td></tr>
              )}

              {visible.map((p) => (
                <tr key={p.id} className="h-9 border-b border-[var(--divider)] text-[13px]">
                  <td className="px-4">
                    {p.description}
                    {p.vendor_name && (
                      <span className="ml-2 text-[var(--fg-mute)]">{p.vendor_name}</span>
                    )}
                  </td>
                  <td className="px-4 text-[var(--fg-soft)]">
                    {categoryLabelByCode.get(p.expense_account_code) ?? p.expense_account_code}
                  </td>
                  <td className="px-4 text-[var(--fg-soft)]">
                    {p.vehicle_id ? vehiclePlateById.get(p.vehicle_id) ?? '—' : '—'}
                  </td>
                  <td className="px-4 tabular-nums">{formatDate(p.competence_date)}</td>
                  <td className="px-4 tabular-nums">{formatDate(p.due_date)}</td>
                  <td className="px-4 tabular-nums">
                    {p.status === 'paid' && p.paid_at ? formatDate(p.paid_at) : '—'}
                  </td>
                  <td className="px-4 text-right tabular-nums">{formatCurrency(p.amount)}</td>
                  <td className="px-4 text-right tabular-nums font-medium">
                    {formatCurrency(p.company_amount)}
                  </td>
                  <td className="px-4 text-right tabular-nums text-[var(--info)]">
                    {p.customer_amount > 0 ? formatCurrency(p.customer_amount) : '—'}
                  </td>
                  <td className="px-4"><StatusBadge status={p.status} /></td>
                  <td className="px-4">
                    <div className="flex items-center justify-end gap-1">
                      <Link
                        href={`/despesas/${p.id}`}
                        title="Ver detalhes"
                        className="p-1 text-[var(--fg-soft)] hover:text-[var(--primary)]"
                      >
                        <Eye className="h-4 w-4" />
                      </Link>
                      {p.status === 'open' && (
                        <button
                          title="Registrar pagamento"
                          onClick={() => abrirPagamento(p)}
                          disabled={saving}
                          className="p-1 text-[var(--fg-soft)] hover:text-[var(--success)]"
                        >
                          <CheckCircle2 className="h-4 w-4" />
                        </button>
                      )}
                      {/* Despesa PAGA cancela normalmente desde a ADR 0029 — o
                          estorno da baixa acontece junto. O botão só faltava aqui. */}
                      {(p.status === 'open' || p.status === 'paid') && (
                        <button
                          title="Cancelar"
                          onClick={() => handleCancel(p)}
                          disabled={saving}
                          className="p-1 text-[var(--fg-soft)] hover:text-[var(--danger)]"
                        >
                          <XCircle className="h-4 w-4" />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Nova despesa ------------------------------------------------- */}
      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="Nova despesa">
        <div className="space-y-4">
          <Input
            label="Descrição"
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
          />

          <div className="grid grid-cols-2 gap-4">
            <Select
              label="Categoria"
              value={form.expense_account_code}
              onChange={(e) => setForm({ ...form, expense_account_code: e.target.value })}
              options={EXPENSE_CATEGORIES}
            />
            <Input
              label="Valor total"
              type="number"
              step="0.01"
              value={form.amount}
              onChange={(e) => setForm({ ...form, amount: e.target.value })}
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <Input
              label="Competência"
              type="date"
              value={form.competence_date}
              onChange={(e) => setForm({ ...form, competence_date: e.target.value })}
            />
            <Input
              label="Vencimento"
              type="date"
              value={form.due_date}
              onChange={(e) => setForm({ ...form, due_date: e.target.value })}
            />
          </div>

          {!bornAlreadyPaid && (
            <div>
              <label className="flex items-center gap-2 text-[13px] text-[var(--fg)]">
                <input
                  type="checkbox"
                  checked={createPaid}
                  onChange={(e) => {
                    setCreatePaid(e.target.checked)
                    if (e.target.checked && !createPaidAt) setCreatePaidAt(businessToday || todayIso())
                  }}
                />
                Já paga
              </label>

              {createPaid && (
                <div className="mt-2">
                  <label className="mb-1.5 block text-[13px] text-[var(--fg-mute)]" htmlFor="create-paid-at">
                    Paga em
                  </label>
                  <input
                    id="create-paid-at"
                    type="date"
                    value={createPaidAt}
                    max={businessToday || undefined}
                    onChange={(e) => setCreatePaidAt(e.target.value)}
                    className="h-9 w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 text-[13px] text-[var(--fg)] outline-none focus:border-[var(--primary)]"
                  />
                  <p className="mt-1.5 text-[12px] leading-relaxed text-[var(--fg-mute)]">
                    Registra a despesa e já dá baixa nela, com esta data de pagamento.
                  </p>
                </div>
              )}
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <Select
              label="Veículo (opcional)"
              value={form.vehicle_id}
              onChange={(e) => setForm({ ...form, vehicle_id: e.target.value })}
              options={[
                { value: '', label: 'Sem vínculo' },
                ...vehicles.map((v) => ({ value: v.id, label: v.license_plate })),
              ]}
            />
            <Input
              label="Fornecedor (opcional)"
              value={form.vendor_name}
              onChange={(e) => setForm({ ...form, vendor_name: e.target.value })}
            />
          </div>

          {/* Responsabilidade — o que F-07 tornava impossível */}
          <div className="border-t border-[var(--divider)] pt-4">
            <Select
              label="Responsabilidade financeira"
              value={form.responsibility}
              onChange={(e) => setForm({ ...form, responsibility: e.target.value })}
              options={RESPONSIBILITY_OPTIONS}
            />

            {form.responsibility !== 'company' && (
              <div className="mt-4 space-y-4">
                <Select
                  label="Cliente"
                  value={form.customer_id}
                  onChange={(e) => setForm({ ...form, customer_id: e.target.value })}
                  options={[
                    { value: '', label: 'Selecione…' },
                    ...customers.map((c) => ({ value: c.id, label: c.name })),
                  ]}
                />

                <Select
                  label="Locação (opcional)"
                  value={form.rental_id}
                  onChange={(e) => setForm({ ...form, rental_id: e.target.value })}
                  options={[
                    { value: '', label: 'Sem vínculo' },
                    ...rentals
                      .filter((r) => !form.customer_id || r.customer_id === form.customer_id)
                      .map((r) => ({ value: r.id, label: r.id.slice(0, 8) })),
                  ]}
                />

                {form.responsibility === 'shared' && (
                  <>
                    <Input
                      label="Parte do cliente (R$)"
                      type="number"
                      step="0.01"
                      min="0.01"
                      max={form.amount || undefined}
                      placeholder="0,00"
                      value={shareAmount}
                      onChange={(e) => setShareAmount(e.target.value)}
                    />

                    {splitPreview && (
                      <div className="border border-[var(--divider)] bg-[var(--surface-2)] p-3 text-[13px]">
                        <div className="flex justify-between">
                          <span className="text-[var(--fg-soft)]">Empresa</span>
                          <span className="tabular-nums">{formatCurrency(splitPreview.company_amount)}</span>
                        </div>
                        <div className="mt-1 flex justify-between">
                          <span className="text-[var(--fg-soft)]">Cliente</span>
                          <span className="tabular-nums">{formatCurrency(splitPreview.customer_amount)}</span>
                        </div>
                        <p className="mt-2 border-t border-[var(--divider)] pt-2 text-[12px] text-[var(--fg-mute)]">
                          O rateio é informado e gravado em valores, não em percentual — a soma
                          fecha exatamente, sem centavo sem dono.
                        </p>
                      </div>
                    )}
                  </>
                )}

                <Select
                  label="Como o cliente devolve"
                  value={form.reimbursement}
                  onChange={(e) => setForm({ ...form, reimbursement: e.target.value })}
                  options={REIMBURSEMENT_OPTIONS}
                />

                <p className="text-[12px] text-[var(--fg-mute)]">
                  {form.reimbursement === 'charge'
                    ? 'A empresa executou o serviço: a parte do cliente vira cobrança.'
                    : 'O cliente executou o serviço: a parte dele vira crédito para abater cobranças futuras.'}
                </p>
              </div>
            )}
          </div>

          {formError && (
            <p className="text-[13px] text-[var(--danger)]">{formError}</p>
          )}

          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setModalOpen(false)}>Cancelar</Button>
            <Button
              onClick={handleCreate}
              disabled={
                saving ||
                !form.description ||
                !form.amount ||
                (form.responsibility !== 'company' && !form.customer_id)
              }
            >
              {saving ? 'Salvando…' : 'Registrar despesa'}
            </Button>
          </div>
        </div>
      </Modal>

      {/* Baixa da despesa ---------------------------------------------- */}
      <Modal
        open={paying !== null}
        onClose={() => setPaying(null)}
        title="Registrar pagamento"
        size="sm"
      >
        {paying && (
          <div className="space-y-4">
            {/* O quê e quanto, antes de confirmar. Sair do caixa é irreversível
                pelo caminho normal: desfazer exige cancelar a despesa, que
                estorna o lançamento. */}
            <div className="rounded-lg border border-[var(--divider)] bg-[var(--surface-2)] px-3 py-2.5 text-[13px]">
              <p className="text-[var(--fg)]">{paying.description}</p>
              <div className="mt-2 flex justify-between">
                <span className="text-[var(--fg-mute)]">Sai do caixa</span>
                <span className="font-semibold tabular-nums text-[var(--danger)]">
                  {formatCurrency(paying.amount)}
                </span>
              </div>
              {paying.customer_amount > 0 && (
                <p className="mt-1.5 text-[12px] leading-relaxed text-[var(--fg-mute)]">
                  A empresa paga o valor cheio; {formatCurrency(paying.customer_amount)} são
                  repassados ao cliente e voltam pela cobrança — não saem daqui.
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
              <p className="mt-1.5 text-[12px] leading-relaxed text-[var(--fg-mute)]">
                Retroaja se o pagamento saiu antes do registro — é ela que decide em que mês a
                saída aparece no DRE. Data futura não é aceita.
              </p>
            </div>

            {payError && (
              <p className="text-[13px] text-[var(--danger)]">{payError}</p>
            )}

            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setPaying(null)}>Cancelar</Button>
              <Button onClick={confirmarPagamento} disabled={saving || !payDate}>
                {saving ? 'Registrando…' : 'Confirmar pagamento'}
              </Button>
            </div>
          </div>
        )}
      </Modal>

      {/* Recusa da operação ------------------------------------------- */}
      <Modal
        open={alertMessage !== null}
        onClose={() => setAlertMessage(null)}
        title="Não foi possível concluir"
        size="sm"
      >
        <div className="space-y-4">
          <div className="flex gap-3">
            <AlertTriangle className="h-5 w-5 shrink-0 text-[var(--danger)]" />
            <p className="text-[13px] text-[var(--fg)]">{alertMessage}</p>
          </div>
          <div className="flex justify-end">
            <Button variant="secondary" onClick={() => setAlertMessage(null)}>Entendi</Button>
          </div>
        </div>
      </Modal>
    </div>
  )
}

function todayIso(): string {
  const d = new Date()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${mm}-${dd}`
}
