'use client'

/**
 * Contatos da locadora — o que o cliente vê em "Fale com a locadora", na aba
 * Conta do app. Cada contato tem um nome livre ("Financeiro", "Manutenção"),
 * telefone e/ou e-mail, o tipo do número (ligação ou WhatsApp — define ícone e
 * ação no app) e um horário de atendimento opcional. A ordem aqui é a do app.
 *
 * Só Owner/Admin enxergam a seção; a RLS de `tenant_contacts` repete a regra.
 */

import { useState, useTransition } from 'react'
import { ArrowDown, ArrowUp, Clock, Contact, Mail, MessageCircle, Pencil, Phone, Plus, Trash2, X } from 'lucide-react'
import { applyPhoneMask, type ContactPhoneKind, type TenantContact } from '@gomoto/core'
import { cn } from '@/lib/utils'
import { Card } from '@/components/ui/Card'
import { Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import {
  createTenantContactAction,
  updateTenantContactAction,
  deleteTenantContactAction,
  reorderTenantContactsAction,
} from '../actions'

type Draft = { label: string; phone: string; phone_kind: ContactPhoneKind; email: string; business_hours: string }
const EMPTY_DRAFT: Draft = { label: '', phone: '', phone_kind: 'phone', email: '', business_hours: '' }

const PHONE_KINDS: { value: ContactPhoneKind; label: string; Icon: typeof Phone }[] = [
  { value: 'phone', label: 'Telefone', Icon: Phone },
  { value: 'whatsapp', label: 'WhatsApp', Icon: MessageCircle },
]

export function TenantContactsSection({
  contacts,
  isLoading,
  onChanged,
}: {
  contacts: TenantContact[]
  isLoading: boolean
  /** Recarrega o `useTenantContacts()` — `revalidatePath` não alcança o cache do TanStack Query. */
  onChanged: () => void
}) {
  const [isPending, startTransition] = useTransition()
  /** `null` = formulário fechado; `'new'` = novo contato; id = editando. */
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT)
  const [error, setError] = useState<string | null>(null)

  function openNew() {
    setDraft(EMPTY_DRAFT)
    setError(null)
    setEditing('new')
  }

  function openEdit(contact: TenantContact) {
    setDraft({
      label: contact.label,
      phone: contact.phone ? applyPhoneMask(contact.phone) : '',
      phone_kind: contact.phone_kind,
      email: contact.email ?? '',
      business_hours: contact.business_hours ?? '',
    })
    setError(null)
    setEditing(contact.id)
  }

  function close() {
    setEditing(null)
    setError(null)
  }

  function run(action: () => Promise<{ ok: boolean; error?: { message: string } }>, after?: () => void) {
    setError(null)
    startTransition(async () => {
      const result = await action()
      if (!result.ok) {
        setError(result.error?.message ?? 'Não foi possível salvar')
        return
      }
      after?.()
      onChanged()
    })
  }

  function handleSave() {
    const id = editing
    if (!id) return
    run(
      () => (id === 'new' ? createTenantContactAction(draft) : updateTenantContactAction(id, draft)),
      close,
    )
  }

  function handleDelete(contact: TenantContact) {
    if (!window.confirm(`Excluir o contato "${contact.label}"? Ele some do app do cliente.`)) return
    run(() => deleteTenantContactAction(contact.id), () => { if (editing === contact.id) close() })
  }

  function handleMove(index: number, delta: -1 | 1) {
    const target = index + delta
    if (target < 0 || target >= contacts.length) return
    const ids = contacts.map((c) => c.id)
    ;[ids[index], ids[target]] = [ids[target]!, ids[index]!]
    run(() => reorderTenantContactsAction(ids))
  }

  const form = (
    <div className="rounded-xl border border-border p-4 space-y-3">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <Input
          label="Nome do contato"
          placeholder="Ex.: Financeiro"
          value={draft.label}
          maxLength={60}
          onChange={(e) => setDraft({ ...draft, label: e.target.value })}
        />
        <Input
          label="Número"
          placeholder="(11) 98765-4321"
          inputMode="tel"
          value={draft.phone}
          onChange={(e) => setDraft({ ...draft, phone: applyPhoneMask(e.target.value) })}
        />
        <Input
          label="E-mail"
          type="email"
          placeholder="financeiro@empresa.com"
          value={draft.email}
          onChange={(e) => setDraft({ ...draft, email: e.target.value })}
        />
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
        <div>
          <p className="text-[13px] text-fg-soft mb-2">Tipo do número</p>
          <div className="inline-flex rounded-full border border-border p-1 gap-1">
            {PHONE_KINDS.map(({ value, label, Icon }) => (
              <button
                key={value}
                type="button"
                onClick={() => setDraft({ ...draft, phone_kind: value })}
                className={cn(
                  'h-8 px-4 rounded-full text-[12px] font-medium transition-colors inline-flex items-center gap-1.5',
                  draft.phone_kind === value ? 'bg-primary text-primary-contrast' : 'text-fg-soft hover:text-fg',
                )}
              >
                <Icon className="w-3.5 h-3.5" />
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="md:col-span-2">
          <Input
            label="Horário de atendimento (opcional)"
            placeholder="Ex.: Seg a sex, 8h às 18h"
            value={draft.business_hours}
            maxLength={120}
            onChange={(e) => setDraft({ ...draft, business_hours: e.target.value })}
          />
        </div>
      </div>
      <p className="text-[12px] text-fg-mute">Informe ao menos um: número ou e-mail.</p>
      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={close} disabled={isPending}>
          <X className="w-4 h-4" />
          Cancelar
        </Button>
        <Button variant="primary" size="sm" loading={isPending} onClick={handleSave}>
          {editing === 'new' ? 'Adicionar contato' : 'Salvar contato'}
        </Button>
      </div>
    </div>
  )

  return (
    <section>
      <div className="flex items-center gap-3 mb-4">
        <div className="p-2.5 rounded-full bg-info-bg border border-info">
          <Contact className="w-5 h-5 text-info" />
        </div>
        <div>
          <h2 className="text-[28px] font-semibold text-fg">Contatos para o cliente</h2>
          <p className="text-[13px] text-fg-mute">
            Aparecem no app do cliente, em Conta → &quot;Fale com a locadora&quot;, nesta ordem.
          </p>
        </div>
      </div>

      <Card>
        <div className="space-y-4">
          {isLoading ? (
            <p className="text-[13px] text-fg-mute">Carregando contatos…</p>
          ) : contacts.length === 0 && editing !== 'new' ? (
            <p className="text-[13px] text-fg-mute">
              Nenhum contato cadastrado — a seção "Fale com a locadora" não aparece no app do cliente.
            </p>
          ) : (
            <table className="w-full">
              <thead>
                <tr className="h-9 text-[13px] text-fg-mute text-left border-b border-border">
                  <th className="font-medium">Contato</th>
                  <th className="font-medium">Número</th>
                  <th className="font-medium">E-mail</th>
                  <th className="font-medium">Atendimento</th>
                  <th className="w-36" />
                </tr>
              </thead>
              <tbody>
                {contacts.map((contact, index) => (
                  <tr key={contact.id} className="h-9 text-[13px] border-b border-border last:border-0">
                    <td className="text-fg font-medium">{contact.label}</td>
                    <td className="text-fg-soft">
                      {contact.phone ? (
                        <span
                          className="inline-flex items-center gap-1.5"
                          title={contact.phone_kind === 'whatsapp' ? 'WhatsApp' : 'Telefone'}
                        >
                          {contact.phone_kind === 'whatsapp'
                            ? <MessageCircle className="w-3.5 h-3.5 text-success" />
                            : <Phone className="w-3.5 h-3.5" />}
                          {applyPhoneMask(contact.phone)}
                        </span>
                      ) : '—'}
                    </td>
                    <td className="text-fg-soft">
                      {contact.email ? (
                        <span className="inline-flex items-center gap-1.5">
                          <Mail className="w-3.5 h-3.5" />
                          {contact.email}
                        </span>
                      ) : '—'}
                    </td>
                    <td className="text-fg-soft">
                      {contact.business_hours ? (
                        <span className="inline-flex items-center gap-1.5">
                          <Clock className="w-3.5 h-3.5" />
                          {contact.business_hours}
                        </span>
                      ) : '—'}
                    </td>
                    <td>
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="ghost" size="icon-sm" title="Subir"
                          disabled={isPending || index === 0}
                          onClick={() => handleMove(index, -1)}
                        >
                          <ArrowUp className="w-4 h-4" />
                        </Button>
                        <Button
                          variant="ghost" size="icon-sm" title="Descer"
                          disabled={isPending || index === contacts.length - 1}
                          onClick={() => handleMove(index, 1)}
                        >
                          <ArrowDown className="w-4 h-4" />
                        </Button>
                        <Button
                          variant="ghost" size="icon-sm" title="Editar"
                          disabled={isPending}
                          onClick={() => openEdit(contact)}
                        >
                          <Pencil className="w-4 h-4" />
                        </Button>
                        <Button
                          variant="ghost" size="icon-sm" title="Excluir"
                          disabled={isPending}
                          onClick={() => handleDelete(contact)}
                        >
                          <Trash2 className="w-4 h-4 text-danger" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {editing ? form : (
            <Button variant="outline" size="sm" onClick={openNew} disabled={isLoading}>
              <Plus className="w-4 h-4" />
              Adicionar contato
            </Button>
          )}

          {error ? <p className="text-[13px] text-danger">{error}</p> : null}
        </div>
      </Card>
    </section>
  )
}
