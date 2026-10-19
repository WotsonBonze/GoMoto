'use client'

import { useMemo, useState, useTransition } from 'react'
import { Eye, EyeOff, KeyRound, RotateCcw, Search, UserPlus, UserX, UsersRound } from 'lucide-react'
import { isSelfPromotion, wouldLeaveZeroActiveOwners, type TenantMemberRole } from '@gomoto/core'

import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { Input, Select } from '@/components/ui/Input'
import { Badge } from '@/components/ui/Badge'
import {
  inviteTenantMember,
  updateTenantMemberRole,
  revokeTenantMember,
  reactivateTenantMember,
  resetTenantMemberPassword,
} from './actions'
import { SettingsHeader } from '../_components/SettingsHeader'

export type TenantMemberRow = {
  id: string
  user_id: string
  email: string
  name: string | null
  role: TenantMemberRole
  status: 'active' | 'revoked'
  created_at: string
}

type InviteForm = { name: string; email: string; role: TenantMemberRole; password: string; confirmPassword: string }

const EMPTY_FORM: InviteForm = { name: '', email: '', role: 'operator', password: '', confirmPassword: '' }

const ROLE_OPTIONS: { value: TenantMemberRole; label: string }[] = [
  { value: 'owner', label: 'Proprietário' },
  { value: 'admin', label: 'Administrador' },
  { value: 'operator', label: 'Operador' },
  { value: 'viewer', label: 'Visualizador' },
]

const ROLE_BADGE: Record<TenantMemberRole, 'brand' | 'info' | 'muted'> = {
  owner: 'brand',
  admin: 'info',
  operator: 'muted',
  viewer: 'muted',
}

type Props = {
  initialRows: TenantMemberRow[]
  loadError: string | null
  currentUserId: string
  currentRole: TenantMemberRole
}

export function UsuariosClient({ initialRows, loadError, currentUserId, currentRole }: Props) {
  const [rows, setRows] = useState<TenantMemberRow[]>(initialRows)
  const [search, setSearch] = useState('')

  const [showInvite, setShowInvite] = useState(false)
  const [form, setForm] = useState<InviteForm>(EMPTY_FORM)
  const [formError, setFormError] = useState<string | null>(null)
  const [showPassword, setShowPassword] = useState(false)

  const [revokeTarget, setRevokeTarget] = useState<TenantMemberRow | null>(null)
  const [revokeError, setRevokeError] = useState<string | null>(null)

  const [resetTarget, setResetTarget] = useState<TenantMemberRow | null>(null)
  const [resetForm, setResetForm] = useState({ password: '', confirmPassword: '' })
  const [resetError, setResetError] = useState<string | null>(null)
  const [showResetPassword, setShowResetPassword] = useState(false)

  const [topError, setTopError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const filteredRows = useMemo(() => {
    const term = search.trim().toLowerCase()
    if (!term) return rows
    return rows.filter(
      (r) => r.email.toLowerCase().includes(term) || (r.name ?? '').toLowerCase().includes(term),
    )
  }, [rows, search])

  const canManage = currentRole === 'owner' || currentRole === 'admin'

  function openInvite() {
    setForm(EMPTY_FORM)
    setFormError(null)
    setShowPassword(false)
    setShowInvite(true)
  }

  function handleInvite() {
    setFormError(null)
    setTopError(null)
    if (form.password !== form.confirmPassword) {
      setFormError('A confirmação não coincide com a senha')
      return
    }
    startTransition(async () => {
      const result = await inviteTenantMember(form)
      if (!result.ok) {
        setFormError(result.error.message)
        return
      }
      setShowInvite(false)
      window.location.reload()
    })
  }

  function membersForOwnerCheck() {
    return rows.map((r) => ({ userId: r.user_id, role: r.role, status: r.status }))
  }

  function handleChangeRole(row: TenantMemberRow, newRole: TenantMemberRole) {
    if (row.role === newRole) return
    setTopError(null)
    startTransition(async () => {
      const result = await updateTenantMemberRole(row.id, newRole)
      if (!result.ok) {
        setTopError(result.error.message)
        return
      }
      setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, role: newRole } : r)))
    })
  }

  function openRevoke(row: TenantMemberRow) {
    setRevokeTarget(row)
    setRevokeError(null)
  }

  function handleRevoke() {
    if (!revokeTarget) return
    startTransition(async () => {
      const result = await revokeTenantMember(revokeTarget.id)
      if (!result.ok) {
        setRevokeError(result.error.message)
        return
      }
      setRows((prev) => prev.map((r) => (r.id === revokeTarget.id ? { ...r, status: 'revoked' } : r)))
      setRevokeTarget(null)
    })
  }

  function handleReactivate(row: TenantMemberRow) {
    setTopError(null)
    startTransition(async () => {
      const result = await reactivateTenantMember(row.id)
      if (!result.ok) {
        setTopError(result.error.message)
        return
      }
      setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, status: 'active' } : r)))
    })
  }

  function openReset(row: TenantMemberRow) {
    setResetTarget(row)
    setResetForm({ password: '', confirmPassword: '' })
    setResetError(null)
    setShowResetPassword(false)
  }

  function handleReset() {
    if (!resetTarget) return
    setResetError(null)
    if (resetForm.password !== resetForm.confirmPassword) {
      setResetError('A confirmação não coincide com a senha')
      return
    }
    startTransition(async () => {
      const result = await resetTenantMemberPassword(resetTarget.id, { password: resetForm.password })
      if (!result.ok) {
        setResetError(result.error.message)
        return
      }
      setResetTarget(null)
    })
  }

  return (
    <div>
      <SettingsHeader
        icon={UsersRound}
        title="Usuários"
        description="Convide, gerencie papéis e controle o acesso das pessoas da sua empresa ao Locaw."
      />

      <div className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div className="relative w-72">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-fg-mute" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar por nome ou email"
              className="h-10 w-full rounded-lg border border-border bg-surface-2 pl-9 pr-4 text-[13px] text-fg placeholder:text-fg-mute focus:border-primary focus:outline-none"
            />
          </div>
          {canManage ? (
            <Button onClick={openInvite}>
              <UserPlus className="w-4 h-4 mr-1.5" /> Convidar usuário
            </Button>
          ) : null}
        </div>

        {loadError ? (
          <div className="rounded-lg bg-danger-bg text-danger border border-danger px-4 py-3 text-[13px]">
            Falha ao carregar usuários: {loadError}
          </div>
        ) : null}

        {topError ? (
          <div className="rounded-lg bg-danger-bg text-danger border border-danger px-4 py-3 text-[13px]">
            {topError}
          </div>
        ) : null}

        <div className="rounded-xl border border-divider overflow-hidden bg-surface">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[13px] text-fg">
              <thead>
                <tr className="border-b border-divider">
                  <th className="h-9 px-4 text-fg-mute text-[13px] font-medium">Pessoa</th>
                  <th className="h-9 px-4 text-fg-mute text-[13px] font-medium">Papel</th>
                  <th className="h-9 px-4 text-fg-mute text-[13px] font-medium">Status</th>
                  <th className="h-9 px-4 text-right text-fg-mute text-[13px] font-medium">Ações</th>
                </tr>
              </thead>
              <tbody>
                {filteredRows.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="px-4 py-8 text-center text-fg-mute text-[13px] italic">
                      Nenhum usuário encontrado.
                    </td>
                  </tr>
                ) : (
                  filteredRows.map((row) => {
                    const isSelf = row.user_id === currentUserId
                    const isActive = row.status === 'active'

                    return (
                      <tr key={row.id} className="h-9 text-[13px] border-b border-divider transition-colors hover:bg-surface-2">
                        <td className="px-4">
                          <div className="font-medium text-fg">{row.name ?? row.email}</div>
                          <div className="text-[12px] text-fg-mute">{row.email}</div>
                        </td>
                        <td className="px-4">
                          {canManage && isActive ? (
                            <select
                              value={row.role}
                              disabled={pending}
                              onChange={(e) => handleChangeRole(row, e.target.value as TenantMemberRole)}
                              className="h-8 rounded-lg border border-border bg-surface-2 px-2 text-[12px] text-fg focus:border-primary focus:outline-none"
                            >
                              {ROLE_OPTIONS.filter((opt) => {
                                if (isSelf && isSelfPromotion(currentUserId, row.user_id, row.role, opt.value)) {
                                  return false // RF-016/RN-004
                                }
                                if (wouldLeaveZeroActiveOwners(membersForOwnerCheck(), row.user_id, { changeRoleTo: opt.value })) {
                                  return false // RF-017/RN-003
                                }
                                return true
                              }).map((opt) => (
                                <option key={opt.value} value={opt.value}>
                                  {opt.label}
                                </option>
                              ))}
                            </select>
                          ) : (
                            <Badge variant={ROLE_BADGE[row.role]}>
                              {ROLE_OPTIONS.find((o) => o.value === row.role)?.label ?? row.role}
                            </Badge>
                          )}
                        </td>
                        <td className="px-4">
                          {isActive ? (
                            <Badge variant="success">Ativo</Badge>
                          ) : (
                            <Badge variant="danger">Revogado</Badge>
                          )}
                        </td>
                        <td className="px-4 text-right">
                          {canManage ? (
                            <div className="inline-flex gap-2">
                              {isActive ? (
                                <>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    disabled={pending}
                                    onClick={() => openReset(row)}
                                  >
                                    <KeyRound className="w-3.5 h-3.5 mr-1" /> Resetar senha
                                  </Button>
                                  {!isSelf ? (
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      disabled={
                                        pending ||
                                        wouldLeaveZeroActiveOwners(membersForOwnerCheck(), row.user_id, 'revoke')
                                      }
                                      onClick={() => openRevoke(row)}
                                      title={
                                        wouldLeaveZeroActiveOwners(membersForOwnerCheck(), row.user_id, 'revoke')
                                          ? 'É preciso ao menos 1 proprietário ativo'
                                          : 'Revogar acesso'
                                      }
                                    >
                                      <UserX className="w-3.5 h-3.5 mr-1" /> Revogar
                                    </Button>
                                  ) : null}
                                </>
                              ) : (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  disabled={pending}
                                  onClick={() => handleReactivate(row)}
                                >
                                  <RotateCcw className="w-3.5 h-3.5 mr-1" /> Reativar
                                </Button>
                              )}
                            </div>
                          ) : null}
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

      <Modal open={showInvite} onClose={() => setShowInvite(false)} title="Convidar usuário">
        <div className="space-y-4">
          <Input
            label="Nome"
            autoFocus
            value={form.name}
            onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
            placeholder="Nome completo"
            disabled={pending}
          />
          <Input
            label="Email"
            type="email"
            value={form.email}
            onChange={(e) => setForm((prev) => ({ ...prev, email: e.target.value }))}
            placeholder="pessoa@empresa.com"
            disabled={pending}
          />
          <div className="relative">
            <Input
              label="Senha"
              type={showPassword ? 'text' : 'password'}
              value={form.password}
              onChange={(e) => setForm((prev) => ({ ...prev, password: e.target.value }))}
              hint="Mínimo de 8 caracteres."
              disabled={pending}
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              className="absolute right-3 top-[38px] text-fg-mute hover:text-fg transition-colors focus:outline-none"
              title={showPassword ? 'Ocultar senha' : 'Mostrar senha'}
            >
              {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
            </button>
          </div>
          <Input
            label="Confirmar senha"
            type={showPassword ? 'text' : 'password'}
            value={form.confirmPassword}
            onChange={(e) => setForm((prev) => ({ ...prev, confirmPassword: e.target.value }))}
            disabled={pending}
          />
          <Select
            label="Papel"
            value={form.role}
            onChange={(e) => setForm((prev) => ({ ...prev, role: e.target.value as TenantMemberRole }))}
            options={ROLE_OPTIONS}
            disabled={pending}
          />
          {formError ? (
            <div className="rounded-lg bg-danger-bg text-danger border border-danger px-3 py-2 text-[13px]">
              {formError}
            </div>
          ) : null}
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={() => setShowInvite(false)} disabled={pending}>
              Cancelar
            </Button>
            <Button
              onClick={handleInvite}
              disabled={
                pending ||
                form.name.trim().length < 2 ||
                form.email.trim().length === 0 ||
                form.password.length < 8 ||
                form.confirmPassword.length === 0
              }
            >
              {pending ? 'Convidando…' : 'Convidar'}
            </Button>
          </div>
        </div>
      </Modal>

      <Modal open={!!revokeTarget} onClose={() => setRevokeTarget(null)} title="Revogar acesso">
        <div className="space-y-4">
          <p className="text-[13px] text-fg-soft">
            A pessoa perde acesso imediatamente em todas as telas. O histórico de ações dela é
            preservado — você pode reativar o acesso depois, sem gerar um novo convite.
          </p>
          {revokeTarget ? (
            <div className="rounded-lg border border-divider bg-surface px-3 py-2 text-[14px] text-fg">
              <div className="font-medium">{revokeTarget.name ?? revokeTarget.email}</div>
              <div className="text-[12px] text-fg-mute">{revokeTarget.email}</div>
            </div>
          ) : null}
          {revokeError ? (
            <div className="rounded-lg bg-danger-bg text-danger border border-danger px-3 py-2 text-[13px]">
              {revokeError}
            </div>
          ) : null}
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={() => setRevokeTarget(null)} disabled={pending}>
              Cancelar
            </Button>
            <Button variant="danger" onClick={handleRevoke} disabled={pending}>
              {pending ? 'Revogando…' : 'Revogar acesso'}
            </Button>
          </div>
        </div>
      </Modal>

      <Modal open={!!resetTarget} onClose={() => setResetTarget(null)} title="Resetar senha">
        <div className="space-y-4">
          {resetTarget ? (
            <div className="rounded-lg border border-divider bg-surface px-3 py-2 text-[14px] text-fg">
              <div className="font-medium">{resetTarget.name ?? resetTarget.email}</div>
              <div className="text-[12px] text-fg-mute">{resetTarget.email}</div>
            </div>
          ) : null}
          <div className="relative">
            <Input
              label="Nova senha"
              type={showResetPassword ? 'text' : 'password'}
              autoFocus
              value={resetForm.password}
              onChange={(e) => setResetForm((prev) => ({ ...prev, password: e.target.value }))}
              hint="Mínimo de 8 caracteres."
              disabled={pending}
            />
            <button
              type="button"
              onClick={() => setShowResetPassword((v) => !v)}
              className="absolute right-3 top-[38px] text-fg-mute hover:text-fg transition-colors focus:outline-none"
              title={showResetPassword ? 'Ocultar senha' : 'Mostrar senha'}
            >
              {showResetPassword ? <EyeOff size={18} /> : <Eye size={18} />}
            </button>
          </div>
          <Input
            label="Confirmar nova senha"
            type={showResetPassword ? 'text' : 'password'}
            value={resetForm.confirmPassword}
            onChange={(e) => setResetForm((prev) => ({ ...prev, confirmPassword: e.target.value }))}
            disabled={pending}
          />
          {resetError ? (
            <div className="rounded-lg bg-danger-bg text-danger border border-danger px-3 py-2 text-[13px]">
              {resetError}
            </div>
          ) : null}
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={() => setResetTarget(null)} disabled={pending}>
              Cancelar
            </Button>
            <Button onClick={handleReset} disabled={pending || resetForm.password.length < 8}>
              {pending ? 'Resetando…' : 'Resetar senha'}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  )
}
