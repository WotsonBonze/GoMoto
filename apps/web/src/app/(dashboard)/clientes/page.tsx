'use client'

import { useState, useMemo } from 'react'
import Link from 'next/link'
import { Plus, Edit2, Trash2, Eye, Users, UserMinus, Search, MessageCircle, AlertCircle } from 'lucide-react'
import { PageTitle } from '@/components/layout/PageTitle'

import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { Modal } from '@/components/ui/Modal'

import { useCustomers, useDeleteCustomer, useActiveRentals } from '@gomoto/data'
import { applyCpfMask, applyCnpjMask } from '@gomoto/core'
import type { Customer } from '@gomoto/core'

// ─── Constantes ──────────────────────────────────────────────────────────────

type StatusFilter = 'all' | 'active' | 'former'

const STATE_OPTIONS = [
  'AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS',
  'MG','PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO',
]

// ─── Componente ──────────────────────────────────────────────────────────────

export default function ClientesPage() {
  const customersQuery  = useCustomers()
  const activeRentals   = useActiveRentals()
  const deleteMutation  = useDeleteCustomer()

  const allCustomers = useMemo(
    () => ((customersQuery.data ?? []) as Customer[]).filter((c) => !c.in_queue),
    [customersQuery.data],
  )

  const activeContractMap = useMemo(() => {
    const map = new Map<string, { license_plate: string; model: string; make: string }>()
    for (const rental of activeRentals.data ?? []) {
      if (rental.vehicle && rental.customer_id) {
        map.set(rental.customer_id, {
          license_plate: rental.vehicle.license_plate,
          model: rental.vehicle.model,
          make: rental.vehicle.make ?? '',
        })
      }
    }
    return map
  }, [activeRentals.data])

  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [stateFilter, setStateFilter]   = useState('')
  const [searchTerm, setSearchTerm]     = useState('')
  const [deletingCustomer, setDeletingCustomer] = useState<Customer | null>(null)

  const kpis = useMemo(() => ({
    active: allCustomers.filter((c) => c.active !== false).length,
    former: allCustomers.filter((c) => c.active === false).length,
  }), [allCustomers])

  const filtered = useMemo(() => {
    let list = allCustomers
    if (statusFilter === 'active')      list = list.filter((c) => c.active !== false)
    else if (statusFilter === 'former') list = list.filter((c) => c.active === false)
    if (stateFilter) list = list.filter((c) => c.state === stateFilter)
    if (searchTerm.trim()) {
      const term = searchTerm.toLowerCase()
      // Documento e telefone comparados só pelos dígitos: a coluna mostra o CPF
      // com máscara e o banco o guarda sem, e o telefone é o contrário. Colar o
      // CPF copiado da tabela precisa achar o cliente.
      const digits = searchTerm.replace(/\D/g, '')
      const hasDigits = (v: string | null | undefined) =>
        !!digits && !!v && v.replace(/\D/g, '').includes(digits)
      list = list.filter(
        (c) => c.name?.toLowerCase().includes(term) ||
               hasDigits(c.cpf) ||
               hasDigits(c.cnpj) ||
               hasDigits(c.phone),
      )
    }
    return list
  }, [allCustomers, statusFilter, stateFilter, searchTerm])

  const tabs: { value: StatusFilter; label: string; count: number }[] = [
    { value: 'all',    label: 'Todos',       count: allCustomers.length },
    { value: 'active', label: 'Ativos',      count: kpis.active },
    { value: 'former', label: 'Ex-Clientes', count: kpis.former },
  ]

  async function confirmDeletion() {
    if (!deletingCustomer) return
    try {
      await deleteMutation.mutateAsync(deletingCustomer.id)
    } finally {
      setDeletingCustomer(null)
    }
  }

  const loading  = customersQuery.isLoading
  const fetchErr = customersQuery.error ? 'Não foi possível carregar os clientes.' : null

  return (
    <div className="flex flex-col bg-bg">
      <PageTitle
        title="Clientes"
        actions={
          <Link
            href="/clientes/novo"
            className="inline-flex items-center gap-2 h-9 px-4 rounded-full bg-primary text-bg text-[13px] font-bold hover:bg-primary-hover transition-colors"
          >
            <Plus className="w-4 h-4" />
            Novo Cliente
          </Link>
        }
      />

      {/* Barra de filtros — sticky abaixo do PageTitle */}
      <div className="sticky top-[60px] z-[9] bg-bg border-b border-divider px-6 py-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap border-b border-fg-mute">
          {tabs.map((tab) => (
            <button
              key={tab.value}
              onClick={() => setStatusFilter(tab.value)}
              className={`px-3 py-2 text-[13px] font-medium transition-all border-b-2 ${
                statusFilter === tab.value
                  ? 'border-primary text-fg'
                  : 'border-transparent text-fg-mute hover:text-fg'
              }`}
            >
              {tab.label}
              <span className="ml-1.5 text-fg-mute">({tab.count})</span>
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <select
            value={stateFilter}
            onChange={(e) => setStateFilter(e.target.value)}
            className="h-10 rounded-full border border-border bg-surface-2 px-4 text-[13px] text-fg focus:border-primary focus:outline-none"
          >
            <option value="">Todos os estados</option>
            {STATE_OPTIONS.map((uf) => (
              <option key={uf} value={uf} className="bg-surface">{uf}</option>
            ))}
          </select>

          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-fg-mute" />
            <input
              type="text"
              placeholder="Buscar nome, CPF/CNPJ ou telefone…"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="h-10 rounded-full border border-border bg-surface-2 pl-9 pr-4 text-[13px] text-fg placeholder:text-fg-mute focus:border-primary focus:outline-none w-52"
            />
          </div>
        </div>
      </div>

      {/* Conteúdo scrollável: KPIs + erro + tabela */}
      <div className="p-6 space-y-4">

        <div className="grid grid-cols-2 gap-4">
          <div className="bg-surface rounded-2xl border border-border px-6 py-4 flex items-center justify-between">
            <div>
              <p className="text-[14px] font-normal text-fg-mute">Clientes Ativos</p>
              <p className="text-[28px] font-bold text-fg">{kpis.active}</p>
            </div>
            <div className="rounded-full bg-surface-2 p-3">
              <Users className="h-6 w-6 text-primary" />
            </div>
          </div>
          <div className="bg-surface rounded-2xl border border-border px-6 py-4 flex items-center justify-between">
            <div>
              <p className="text-[14px] font-normal text-fg-mute">Ex-Clientes</p>
              <p className="text-[28px] font-bold text-fg">{kpis.former}</p>
            </div>
            <div className="rounded-full bg-surface-2 p-3">
              <UserMinus className="h-6 w-6 text-primary" />
            </div>
          </div>
        </div>

        {fetchErr && (
          <div className="flex items-center gap-3 px-4 py-3 bg-danger-bg border border-danger rounded-xl">
            <AlertCircle className="w-4 h-4 text-danger shrink-0" />
            <p className="text-[13px] text-danger">{fetchErr}</p>
            <button onClick={() => customersQuery.refetch()} className="ml-auto text-[12px] text-primary hover:underline font-medium">
              Tentar novamente
            </button>
          </div>
        )}

        <div className="overflow-hidden rounded-xl bg-surface">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[13px] text-fg">
              <thead className="border-b border-divider">
                <tr>
                  <th className="h-9 px-4 text-[13px] font-medium text-fg-mute">Nome</th>
                  <th className="h-9 px-4 text-[13px] font-medium text-fg-mute">CPF / CNPJ</th>
                  <th className="h-9 px-4 text-[13px] font-medium text-fg-mute">Telefone</th>
                  <th className="h-9 px-4 text-[13px] font-medium text-fg-mute">Moto Atual</th>
                  <th className="h-9 px-4 text-[13px] font-medium text-fg-mute">Status</th>
                  <th className="h-9 px-4 text-right text-[13px] font-medium text-fg-mute">Ações</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr>
                    <td colSpan={6}>
                      <div className="flex items-center justify-center py-16">
                        <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                      </div>
                    </td>
                  </tr>
                ) : filtered.length === 0 ? (
                  <tr>
                    <td colSpan={6}>
                      <div className="flex flex-col items-center justify-center py-16 gap-3">
                        <div className="w-12 h-12 bg-surface-2 rounded-full flex items-center justify-center">
                          <Users className="w-6 h-6 text-fg-mute" />
                        </div>
                        <p className="text-[13px] text-fg-mute">Nenhum cliente encontrado.</p>
                        <button
                          onClick={() => { setStatusFilter('all'); setStateFilter(''); setSearchTerm('') }}
                          className="text-[13px] text-primary hover:underline"
                        >
                          Limpar filtros
                        </button>
                      </div>
                    </td>
                  </tr>
                ) : (
                  filtered.map((customer) => {
                    const contract = activeContractMap.get(customer.id)
                    const whatsapp = customer.phone
                      ? `https://wa.me/55${customer.phone.replace(/\D/g, '')}`
                      : null
                    return (
                      <tr
                        key={customer.id}
                        className="h-9 border-b border-divider transition-colors hover:bg-surface-2"
                      >
                        <td className="px-4 text-[13px]">
                          <Link
                            href={`/clientes/${customer.id}`}
                            className="font-medium text-fg hover:text-primary transition-colors"
                          >
                            {customer.person_type === 'company'
                              ? (customer.company_name ?? customer.name)
                              : customer.name}
                          </Link>
                          {customer.person_type === 'company' && (
                            <p className="text-[11px] text-fg-mute">PJ</p>
                          )}
                        </td>
                        {/* O CPF é o login do cliente no app — à vista para não
                            precisar abrir a ficha. PJ não tem CPF: mostra o CNPJ. */}
                        <td className="px-4 text-[13px] font-mono whitespace-nowrap">
                          {customer.person_type === 'company'
                            ? (customer.cnpj ? applyCnpjMask(customer.cnpj) : <span className="text-fg-mute">—</span>)
                            : (customer.cpf ? applyCpfMask(customer.cpf) : <span className="text-fg-mute">—</span>)}
                        </td>
                        <td className="px-4 text-[13px]">
                          {whatsapp ? (
                            <a
                              href={whatsapp}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="flex items-center gap-1.5 text-fg hover:text-primary transition-colors w-fit"
                            >
                              <MessageCircle className="w-3.5 h-3.5 shrink-0" />
                              {customer.phone}
                            </a>
                          ) : (
                            <span className="text-fg-mute">—</span>
                          )}
                        </td>
                        <td className="px-4 text-[13px]">
                          {contract ? (
                            <Badge variant="brand">
                              {contract.license_plate} — {contract.make} {contract.model}
                            </Badge>
                          ) : (
                            <span className="text-fg-mute">—</span>
                          )}
                        </td>
                        <td className="px-4 text-[13px]">
                          {customer.active !== false
                            ? <Badge variant="success">Ativo</Badge>
                            : <Badge variant="danger">Ex-Cliente</Badge>
                          }
                        </td>
                        <td className="px-4 text-right text-[13px]">
                          <div className="flex items-center justify-end gap-1">
                            <Link
                              href={`/clientes/${customer.id}`}
                              className="inline-flex items-center justify-center h-8 w-8 rounded-lg bg-surface-2 text-fg-mute hover:bg-divider hover:text-fg transition-colors"
                              title="Ver detalhes"
                            >
                              <Eye className="h-4 w-4" />
                            </Link>
                            <Link
                              href={`/clientes/${customer.id}/editar`}
                              className="inline-flex items-center justify-center h-8 w-8 rounded-lg bg-surface-2 text-fg-mute hover:bg-divider hover:text-fg transition-colors"
                              title="Editar"
                            >
                              <Edit2 className="h-4 w-4" />
                            </Link>
                            <Button
                              variant="danger"
                              size="sm"
                              className="h-8 w-8 p-0"
                              title="Excluir"
                              onClick={() => setDeletingCustomer(customer)}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    )
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Modal: confirmação de exclusão */}
      <Modal open={!!deletingCustomer} onClose={() => setDeletingCustomer(null)} title="Confirmar Exclusão" size="sm">
        <div className="space-y-6">
          <div className="p-4 bg-danger-bg border border-danger rounded-xl">
            <p className="text-fg-mute text-[13px] leading-relaxed text-center">
              Você está prestes a excluir o cliente<br />
              <strong className="text-fg text-base font-bold">{deletingCustomer?.name}</strong>
              <br /><br />
              Esta operação <span className="text-danger font-bold underline">não pode ser desfeita</span>.
              Clientes com contrato ativo não podem ser excluídos.
            </p>
          </div>
          <div className="flex gap-3">
            <Button variant="ghost" onClick={() => setDeletingCustomer(null)} className="flex-1">
              Cancelar
            </Button>
            <Button
              variant="danger"
              onClick={confirmDeletion}
              className="flex-1"
              loading={deleteMutation.isPending}
            >
              <Trash2 className="w-4 h-4" />
              Excluir
            </Button>
          </div>
        </div>
      </Modal>

    </div>
  )
}
