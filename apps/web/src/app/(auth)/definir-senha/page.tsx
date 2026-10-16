/**
 * @file page.tsx (Definir senha)
 * @description Continuação do fluxo de convite (Spec 0011 §3.5): a pessoa
 * convidada (Platform Admin ou Usuário do Sistema de um tenant) chega aqui a
 * partir do link de `generateLink({ type: 'invite' })` e define a senha
 * inicial. Não existia nenhuma rota web equivalente antes desta Spec — o
 * mecanismo só estava fiado ponta a ponta pro mobile.
 */

'use client'

import { useEffect, useState } from 'react'
import { Bike, Eye, EyeOff } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { SetInitialPasswordSchema } from '@gomoto/core'

type Status = 'checking' | 'ready' | 'invalid'

export default function DefinirSenhaPage() {
  const [status, setStatus] = useState<Status>('checking')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    // O client do browser (@supabase/ssr) força flowType:'pkce' — nesse modo
    // o SDK REJEITA o formato de callback do link de convite/magic link
    // (#access_token=...&refresh_token=..., "implicit grant"), que é o único
    // formato que a Admin API (generateLink) produz. detectSessionInUrl
    // automático não funciona aqui por causa desse descompasso; extraímos os
    // tokens do hash manualmente e chamamos setSession() direto — mesma
    // abordagem já usada no mobile (contexts/auth.tsx) para o mesmo link.
    const params = new URLSearchParams(window.location.hash.slice(1))
    const accessToken = params.get('access_token')
    const refreshToken = params.get('refresh_token')

    // Remove os tokens da URL assim que lidos, mesmo em caso de falha —
    // evita deixá-los expostos na barra de endereço/histórico do navegador.
    window.history.replaceState(null, '', window.location.pathname)

    if (!accessToken || !refreshToken) {
      setStatus('invalid')
      return
    }

    const supabase = createClient()
    supabase.auth.setSession({ access_token: accessToken, refresh_token: refreshToken }).then(({ error: sessionError }) => {
      setStatus(sessionError ? 'invalid' : 'ready')
    })
  }, [])

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    setError('')

    const parsed = SetInitialPasswordSchema.safeParse({ password })
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Senha inválida')
      return
    }
    if (password !== confirmPassword) {
      setError('A confirmação não coincide com a senha')
      return
    }

    setLoading(true)
    const supabase = createClient()
    // Chamada direta do client — a sessão já embutida no link autentica
    // essa chamada, sem passar por Server Action (Spec 0011 §3.5 passo 4).
    const { error: updateErr } = await supabase.auth.updateUser({ password })
    if (updateErr) {
      setError('Não foi possível definir a senha. Tente novamente.')
      setLoading(false)
      return
    }

    // Navegação "dura" (não router.push) pelo mesmo motivo do login: o
    // layout raiz só resolve o tema salvo (ADR 0019) numa nova requisição
    // ao servidor, senão herda o tema default cacheado desta tela.
    // O layout do dashboard já resolve platform_admin vs. tenant_member e
    // manda pro lugar certo (lógica existente em (dashboard)/layout.tsx).
    window.location.href = '/dashboard'
  }

  return (
    <div className="min-h-screen bg-bg flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center gap-3 mb-8">
          <div className="w-14 h-14 bg-primary rounded-2xl flex items-center justify-center">
            <Bike className="w-7 h-7 text-bg" />
          </div>
          <div className="text-center">
            <h1 className="text-[28px] font-bold text-fg">Locaw</h1>
            <p className="text-[16px] text-fg-mute mt-1">Defina sua senha de acesso</p>
          </div>
        </div>

        <div className="bg-surface border border-border rounded-2xl p-6">
          {status === 'checking' ? (
            <p className="text-[13px] text-fg-mute text-center py-6">Validando convite...</p>
          ) : status === 'invalid' ? (
            <div className="rounded-2xl px-4 py-3 bg-danger-bg border border-danger">
              <p className="text-[13px] text-danger">
                Link expirado ou já utilizado. Peça um novo convite ao responsável.
              </p>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="relative">
                <Input
                  label="Nova senha"
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  hint="Mínimo de 8 caracteres."
                  autoComplete="new-password"
                  required
                  autoFocus
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
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                autoComplete="new-password"
                required
              />
              {error && (
                <div className="rounded-2xl px-4 py-3 bg-danger-bg border border-danger">
                  <p className="text-[13px] text-danger">{error}</p>
                </div>
              )}
              <Button type="submit" className="w-full mt-2" loading={loading} size="lg">
                {loading ? 'Salvando...' : 'Definir senha e entrar'}
              </Button>
            </form>
          )}
        </div>
      </div>
    </div>
  )
}
