'use client'

import { useState, useTransition } from 'react'
import { Eye, EyeOff, KeyRound, Plus, ShieldCheck, ShieldOff, Trash2, UserPlus } from 'lucide-react'

import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { Input } from '@/components/ui/Input'
import { Badge } from '@/components/ui/Badge'
import {
  createPlatformAdmin,
  removePlatformAdmin,
  resetPlatformAdminPassword,
  setPlatformAdminRole,
} from './actions'

export type PlatformAdminRow = {
  user_id: string
  email: string
  name: string | null
  role: 'owner' | 'operator'
  created_at: string
  created_by_email: string | null
}

type AddForm = { name: string; email: string; role: 'owner' | 'operator'; password: string; confirmPassword: string }

const EMPTY_FORM: AddForm = { name: '', email: '', role: 'operator', password: '', confirmPassword: '' }

type Props = {
  initialRows: PlatformAdminRow[]
  loadError: string | null
  currentUserId: string
  currentRole: 'owner' | 'operator'
}

export function PlatformAdminsClient({
  initialRows,
  loadError,
  currentUserId,
  currentRole,
}: Props) {
  const [rows, setRows] = useState<PlatformAdminRow[]>(initialRows)
  const [showAdd, setShowAdd] = useState(false)
  const [form, setForm] = useState<AddForm>(EMPTY_FORM)
  const [formError, setFormError] = useState<string | null>(null)
  const [showPassword, setShowPassword] = useState(false)
  const [removingId, setRemovingId] = useState<string | null>(null)
  const [removeError, setRemoveError] = useState<string | null>(null)
  const [resettingId, setResettingId] = useState<string | null>(null)
  const [resetForm, setResetForm] = useState({ password: '', confirmPassword: '' })
  const [resetError, setResetError] = useState<string | null>(null)
  const [showResetPassword, setShowResetPassword] = useState(false)
  const [topError, setTopError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const isOwner = currentRole === 'owner'
  // O guard "≥1 owner" também roda no banco; manter o aviso visual ajuda o
  // usuário a entender por que o toggle aparece desabilitado.
  const ownerCount = rows.filter((r) => r.role === 'owner').length

  function openAdd() {
    setForm(EMPTY_FORM)
    setFormError(null)
    setShowPassword(false)
    setShowAdd(true)
  }

  function handleAdd() {
    setFormError(null)
    setTopError(null)
    if (form.password !== form.confirmPassword) {
      setFormError('A confirmação não coincide com a senha')
      return
    }
    startTransition(async () => {
      const result = await createPlatformAdmin(form)
      if ('error' in result && result.error) {
        setFormError(result.error)
        return
      }
      const created = (result as { row: PlatformAdminRow | null }).row
      if (created) {
        setRows((prev) =>
          [...prev.filter((r) => r.user_id !== created.user_id), created].sort((a, b) =>
            a.role === b.role ? a.email.localeCompare(b.email) : a.role === 'owner' ? -1 : 1,
          ),
        )
      }
      setShowAdd(false)
    })
  }

  function handleSetRole(row: PlatformAdminRow, next: 'owner' | 'operator') {
    if (row.role === next) return
    setTopError(null)
    startTransition(async () => {
      const result = await setPlatformAdminRole(row.user_id, next)
      if ('error' in result && result.error) {
        setTopError(result.error)
        return
      }
      setRows((prev) => prev.map((r) => (r.user_id === row.user_id ? { ...r, role: next } : r)))
    })
  }

  function openRemove(row: PlatformAdminRow) {
    setRemovingId(row.user_id)
    setRemoveError(null)
  }

  function handleRemove() {
    if (!removingId) return
    startTransition(async () => {
      const result = await removePlatformAdmin(removingId)
      if ('error' in result && result.error) {
        setRemoveError(result.error)
        return
      }
      setRows((prev) => prev.filter((r) => r.user_id !== removingId))
      setRemovingId(null)
    })
  }

  function openReset(row: PlatformAdminRow) {
    setResettingId(row.user_id)
    setResetForm({ password: '', confirmPassword: '' })
    setResetError(null)
    setShowResetPassword(false)
  }

  function handleReset() {
    if (!resettingId) return
    setResetError(null)
    if (resetForm.password !== resetForm.confirmPassword) {
      setResetError('A confirmação não coincide com a senha')
      return
    }
    startTransition(async () => {
      const result = await resetPlatformAdminPassword(resettingId, { password: resetForm.password })
      if ('error' in result && result.error) {
        setResetError(result.error)
        return
      }
      setResettingId(null)
    })
  }

  const target = removingId ? rows.find((r) => r.user_id === removingId) ?? null : null
  const resetTarget = resettingId ? rows.find((r) => r.user_id === resettingId) ?? null : null

  return (
    <div className="p-8 max-w-6xl mx-auto">
      <header className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-[24px] font-semibold text-fg flex items-center gap-2">
            <ShieldCheck className="w-6 h-6" /> Admins da plataforma
          </h1>
          <p className="text-[13px] text-fg-mute mt-1">
            Pessoas com acesso ao painel da plataforma. Proprietários gerenciam os outros admins;
            operadores cuidam do dia a dia.
          </p>
        </div>
        {isOwner ? (
          <Button onClick={openAdd}>
            <Plus className="w-4 h-4 mr-1.5" /> Adicionar admin
          </Button>
        ) : null}
      </header>

      {loadError ? (
        <div className="rounded-lg bg-danger-bg text-danger border border-danger px-4 py-3 text-[13px] mb-4">
          Falha ao carregar admins: {loadError}
        </div>
      ) : null}

      {topError ? (
        <div className="rounded-lg bg-danger-bg text-danger border border-danger px-4 py-3 text-[13px] mb-4">
          {topError}
        </div>
      ) : null}

      <div className="rounded-xl border border-divider overflow-hidden bg-surface">
        <table className="w-full text-left">
          <thead className="bg-surface text-[12px] uppercase tracking-wide text-fg-mute">
            <tr>
              <th className="px-4 py-3 font-medium">Pessoa</th>
              <th className="px-4 py-3 font-medium">Papel</th>
              <th className="px-4 py-3 font-medium">Adicionado por</th>
              <th className="px-4 py-3 font-medium text-right">Ações</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-fg-mute text-[14px]">
                  Nenhum admin cadastrado.
                </td>
              </tr>
            ) : (
              rows.map((row) => {
                const isSelf = row.user_id === currentUserId
                const isLastOwner = row.role === 'owner' && ownerCount <= 1
                return (
                  <tr key={row.user_id} className="border-t border-divider">
                    <td className="px-4 py-3 text-[14px] text-fg">
                      <div className="font-medium">{row.name ?? row.email}</div>
                      <div className="text-[12px] text-fg-mute">{row.email}</div>
                    </td>
                    <td className="px-4 py-3">
                      {row.role === 'owner' ? (
                        <Badge variant="brand">Proprietário</Badge>
                      ) : (
                        <Badge variant="muted">Operador</Badge>
                      )}
                    </td>
                    <td className="px-4 py-3 text-[13px] text-fg-mute">
                      {/* Sem quem adicionou = criado na configuração inicial da plataforma. */}
                      {row.created_by_email ?? <span className="italic">Criado na instalação</span>}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="inline-flex gap-2">
                        {isOwner ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={pending}
                            onClick={() => openReset(row)}
                          >
                            <KeyRound className="w-3.5 h-3.5 mr-1" /> Resetar senha
                          </Button>
                        ) : null}
                        {isOwner ? (
                          row.role === 'owner' ? (
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={pending || isLastOwner}
                              onClick={() => handleSetRole(row, 'operator')}
                              title={isLastOwner ? 'É preciso ao menos 1 proprietário' : 'Rebaixar para operador'}
                            >
                              <ShieldOff className="w-3.5 h-3.5 mr-1" /> Rebaixar
                            </Button>
                          ) : (
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={pending}
                              onClick={() => handleSetRole(row, 'owner')}
                              title="Promover a proprietário"
                            >
                              <ShieldCheck className="w-3.5 h-3.5 mr-1" /> Promover
                            </Button>
                          )
                        ) : null}
                        {isOwner ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={pending || isSelf || isLastOwner}
                            onClick={() => openRemove(row)}
                            title={
                              isSelf
                                ? 'Você não pode se remover'
                                : isLastOwner
                                  ? 'É preciso ao menos 1 proprietário'
                                  : 'Remover admin'
                            }
                          >
                            <Trash2 className="w-3.5 h-3.5 mr-1" /> Remover
                          </Button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>

      <Modal open={showAdd} onClose={() => setShowAdd(false)} title="Adicionar admin">
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
            placeholder="pessoa@gomoto.dev"
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
          <div>
            <label className="text-[13px] text-fg-soft block mb-1.5">Papel</label>
            <div className="flex gap-2">
              {(['operator', 'owner'] as const).map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => setForm((prev) => ({ ...prev, role: r }))}
                  disabled={pending}
                  className={
                    'flex-1 h-10 rounded-lg border text-[14px] transition ' +
                    (form.role === r
                      ? 'border-primary text-primary bg-primary-tint'
                      : 'border-divider text-fg-soft hover:border-border')
                  }
                >
                  {r === 'owner' ? (
                    <span className="inline-flex items-center gap-1.5">
                      <ShieldCheck className="w-4 h-4" /> Proprietário
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5">
                      <UserPlus className="w-4 h-4" /> Operador
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>
          {formError ? (
            <div className="rounded-lg bg-danger-bg text-danger border border-danger px-3 py-2 text-[13px]">
              {formError}
            </div>
          ) : null}
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={() => setShowAdd(false)} disabled={pending}>
              Cancelar
            </Button>
            <Button
              onClick={handleAdd}
              disabled={
                pending ||
                form.name.trim().length < 2 ||
                form.email.trim().length === 0 ||
                form.password.length < 8 ||
                form.confirmPassword.length === 0
              }
            >
              {pending ? 'Adicionando…' : 'Adicionar'}
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        open={!!removingId}
        onClose={() => setRemovingId(null)}
        title="Remover admin da plataforma"
      >
        <div className="space-y-4">
          <p className="text-[13px] text-fg-soft">
            A pessoa perde acesso ao control plane imediatamente. O usuário em si permanece
            em <code>auth.users</code> — você só está removendo o vínculo de admin.
          </p>
          {target ? (
            <div className="rounded-lg border border-divider bg-surface px-3 py-2 text-[14px] text-fg">
              <div className="font-medium">{target.name ?? target.email}</div>
              <div className="text-[12px] text-fg-mute">{target.email}</div>
            </div>
          ) : null}
          {removeError ? (
            <div className="rounded-lg bg-danger-bg text-danger border border-danger px-3 py-2 text-[13px]">
              {removeError}
            </div>
          ) : null}
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={() => setRemovingId(null)} disabled={pending}>
              Cancelar
            </Button>
            <Button variant="danger" onClick={handleRemove} disabled={pending}>
              {pending ? 'Removendo…' : 'Remover'}
            </Button>
          </div>
        </div>
      </Modal>

      <Modal open={!!resettingId} onClose={() => setResettingId(null)} title="Resetar senha">
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
            <Button variant="ghost" onClick={() => setResettingId(null)} disabled={pending}>
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
