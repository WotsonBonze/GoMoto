'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Smartphone, CheckCircle2, Eye, EyeOff } from 'lucide-react'
import { applyCpfMask } from '@gomoto/core'
import { inviteCustomerToApp, setCustomerPassword, resetCustomerPassword } from '../actions'

interface Props {
  customerId: string
  /**
   * O app faz login por CPF + senha (cpfShellEmail) — o email do cadastro não
   * participa do acesso. Por isso o portão é o CPF, não o email.
   */
  customerCpf?: string | null
  hasAppAccess: boolean
}

export function CustomerAppAccess({ customerId, customerCpf, hasAppAccess }: Props) {
  const [mode, setMode] = useState<'idle' | 'password'>('idle')
  const [passwordValue, setPasswordValue] = useState('')
  const [showPasswordText, setShowPasswordText] = useState(false)
  const [generatedLink, setGeneratedLink] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function handleInvite() {
    setLoading(true)
    const result = await inviteCustomerToApp(customerId)
    if (result.error) { alert(`Erro: ${result.error}`) }
    else if (result.link) { setGeneratedLink(result.link) }
    setLoading(false)
  }

  async function handleSetPassword() {
    if (passwordValue.length < 8) { alert('A senha precisa ter ao menos 8 caracteres.'); return }
    setLoading(true)
    const result = await setCustomerPassword(customerId, passwordValue)
    if (result.error) { alert(`Erro: ${result.error}`) }
    else {
      alert('Senha definida com sucesso. O cliente já pode acessar o app.')
      setMode('idle')
      setPasswordValue('')
    }
    setLoading(false)
  }

  async function handleResetPassword() {
    setLoading(true)
    const result = await resetCustomerPassword(customerId)
    if (result.error) { alert(`Erro: ${result.error}`) }
    else if (result.link) { setGeneratedLink(result.link) }
    setLoading(false)
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 mb-3">
        <Smartphone className="h-4 w-4 text-primary" />
        <h2 className="text-[14px] font-bold text-primary">Acesso ao App</h2>
      </div>

      {!customerCpf ? (
        <p className="text-[13px] text-fg-mute">
          O login no app é feito pelo CPF.{' '}
          <Link href={`/clientes/${customerId}/editar`} className="text-primary hover:underline">
            Cadastre o CPF
          </Link>{' '}
          para liberar o acesso.
        </p>
      ) : hasAppAccess ? (
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-[13px] text-success">
            <CheckCircle2 className="h-4 w-4 shrink-0" />
            <span>Cliente tem acesso ao app mobile.</span>
          </div>
          {mode === 'password' ? (
            <PasswordForm
              value={passwordValue}
              showText={showPasswordText}
              loading={loading}
              onChangeValue={setPasswordValue}
              onToggleShow={() => setShowPasswordText((v) => !v)}
              onConfirm={handleSetPassword}
              onCancel={() => { setMode('idle'); setPasswordValue('') }}
            />
          ) : (
            <div className="flex gap-2 flex-wrap">
              <ActionButton onClick={() => setMode('password')} loading={false}>
                Redefinir senha
              </ActionButton>
              <ActionButton onClick={handleResetPassword} loading={loading}>
                Gerar link de recuperação
              </ActionButton>
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-[13px] text-fg-mute">
            Escolha como liberar o acesso. O cliente entra no app com o CPF{' '}
            <span className="text-fg">{applyCpfMask(customerCpf)}</span> e a senha:
          </p>
          {mode === 'password' ? (
            <PasswordForm
              value={passwordValue}
              showText={showPasswordText}
              loading={loading}
              onChangeValue={setPasswordValue}
              onToggleShow={() => setShowPasswordText((v) => !v)}
              onConfirm={handleSetPassword}
              onCancel={() => { setMode('idle'); setPasswordValue('') }}
            />
          ) : (
            <div className="flex gap-2 flex-wrap">
              <ActionButton onClick={() => setMode('password')} loading={false}>
                Definir senha
              </ActionButton>
              <ActionButton onClick={handleInvite} loading={loading} primary>
                Gerar link de acesso
              </ActionButton>
            </div>
          )}
        </div>
      )}

      {generatedLink && (
        <div className="p-3 bg-primary-tint border border-primary/30 rounded-xl space-y-2">
          <p className="text-[12px] font-medium text-primary">
            Link gerado — compartilhe com o cliente (ex: WhatsApp):
          </p>
          <div className="flex items-start gap-2">
            <p className="text-[11px] text-fg-mute font-mono break-all flex-1 leading-relaxed select-all">
              {generatedLink}
            </p>
            <button
              onClick={() => navigator.clipboard.writeText(generatedLink)}
              className="shrink-0 h-8 px-3 rounded-lg bg-surface-2 text-fg text-[12px] font-medium hover:bg-divider transition-colors"
            >
              Copiar
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Primitivas internas ──────────────────────────────────────────────────────

function ActionButton({
  children,
  onClick,
  loading,
  primary = false,
}: {
  children: React.ReactNode
  onClick: () => void
  loading: boolean
  primary?: boolean
}) {
  return (
    <button
      onClick={onClick}
      disabled={loading}
      className={`h-8 px-3 rounded-lg text-[13px] font-medium transition-colors disabled:opacity-50 ${
        primary
          ? 'bg-primary text-bg hover:bg-primary-hover'
          : 'bg-surface-2 text-fg hover:bg-divider'
      }`}
    >
      {loading ? 'Aguarde…' : children}
    </button>
  )
}

function PasswordForm({
  value,
  showText,
  loading,
  onChangeValue,
  onToggleShow,
  onConfirm,
  onCancel,
}: {
  value: string
  showText: boolean
  loading: boolean
  onChangeValue: (v: string) => void
  onToggleShow: () => void
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <div className="flex items-center gap-2">
      <div className="relative flex-1">
        <input
          type={showText ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChangeValue(e.target.value)}
          placeholder="Mínimo 8 caracteres"
          className="w-full h-9 rounded-lg border border-border bg-surface-2 px-3 pr-10 text-[13px] text-fg placeholder:text-fg-mute focus:border-primary focus:outline-none"
        />
        <button
          type="button"
          onClick={onToggleShow}
          className="absolute right-2.5 top-1/2 -translate-y-1/2 text-fg-mute hover:text-fg transition-colors"
        >
          {showText ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </button>
      </div>
      <button
        onClick={onCancel}
        className="h-9 px-3 rounded-lg bg-surface-2 text-fg text-[13px] font-medium hover:bg-divider transition-colors"
      >
        Cancelar
      </button>
      <button
        onClick={onConfirm}
        disabled={loading}
        className="h-9 px-3 rounded-lg bg-primary text-bg text-[13px] font-bold hover:bg-primary-hover transition-colors disabled:opacity-50"
      >
        {loading ? 'Salvando…' : 'Confirmar'}
      </button>
    </div>
  )
}
