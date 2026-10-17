/**
 * @file src/app/(dashboard)/configuracoes/conta/page.tsx
 * @description Minha conta — dados do usuário logado e troca de senha.
 * Visível para todos os papéis.
 */

'use client'

import React, { useState, useEffect } from 'react'
import { Lock, User, Save, Eye, EyeOff, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Input } from '@/components/ui/Input'
import { createClient } from '@/lib/supabase/client'
import { SettingsHeader } from '../_components/SettingsHeader'
import { FeedbackMessage, type FeedbackState } from '../_components/FeedbackMessage'

/**
 * @interface UserData
 * @description Define as informações exibidas do usuário logado obtidas via Supabase Auth.
 */
interface UserData {
  email: string
  createdAt: string
}

export default function ContaPage() {
  /**
   * Cliente Supabase criado fora do ciclo de render para evitar
   * a criação de novas instâncias a cada atualização de estado.
   */
  const supabase = React.useMemo(() => createClient(), [])

  // --- ESTADOS: Segurança (Senha) ---
  const [newPassword, setNewPassword] = useState<string>('')
  const [confirmPassword, setConfirmPassword] = useState<string>('')
  const [showPassword, setShowPassword] = useState<boolean>(false)
  const [isSavingPassword, setIsSavingPassword] = useState<boolean>(false)
  const [passwordFeedback, setPasswordFeedback] = useState<FeedbackState | null>(null)

  // --- ESTADOS: Informações da Conta ---
  const [userData, setUserData] = useState<UserData | null>(null)
  const [isLoadingUser, setIsLoadingUser] = useState<boolean>(true)

  /** Busca e-mail e data de criação do usuário autenticado ao montar. */
  useEffect(() => {
    async function fetchUser() {
      try {
        const {
          data: { user },
          error: userError,
        } = await supabase.auth.getUser()

        if (user && !userError) {
          setUserData({
            email: user.email ?? 'E-mail não disponível',
            createdAt: new Date(user.created_at).toLocaleDateString('pt-BR', {
              day: 'numeric',
              month: 'long',
              year: 'numeric',
            }),
          })
        }
      } catch {
        // Falha silenciosa: o card de conta exibirá mensagem de erro
      } finally {
        setIsLoadingUser(false)
      }
    }

    fetchUser()
  }, [supabase])

  /**
   * @function handleSavePassword
   * @description Valida e altera a senha do usuário via Supabase Auth.
   * Após sucesso, limpa os campos e exibe confirmação.
   */
  const handleSavePassword = async () => {
    setPasswordFeedback(null)

    if (newPassword.length < 6) {
      setPasswordFeedback({ type: 'error', message: 'A nova senha deve ter pelo menos 6 caracteres.' })
      return
    }

    if (newPassword !== confirmPassword) {
      setPasswordFeedback({ type: 'error', message: 'A confirmação de senha não coincide com a nova senha.' })
      return
    }

    setIsSavingPassword(true)

    try {
      const { error } = await supabase.auth.updateUser({ password: newPassword })
      if (error) throw error

      setPasswordFeedback({ type: 'success', message: 'Senha alterada com sucesso!' })
      setNewPassword('')
      setConfirmPassword('')
    } catch {
      setPasswordFeedback({
        type: 'error',
        message: 'Erro ao alterar a senha. Verifique sua conexão e tente novamente.',
      })
    } finally {
      setIsSavingPassword(false)
    }
  }

  return (
    <>
      <section>
        <SettingsHeader
          icon={User}
          tone="warning"
          title="Informações da Conta"
          description="Detalhes do usuário autenticado no sistema."
        />

        <Card>
          {isLoadingUser ? (
            <div className="flex justify-center py-6">
              <Loader2 className="animate-spin text-fg-mute" size={28} />
            </div>
          ) : userData ? (
            <div className="space-y-4">
              <div>
                <p className="text-[13px] text-fg-mute mb-1">E-mail de Acesso</p>
                <p className="text-fg font-medium">{userData.email}</p>
              </div>
              <div className="border-t border-border" />
              <div>
                <p className="text-[13px] text-fg-mute mb-1">Membro desde</p>
                <p className="text-fg font-medium">{userData.createdAt}</p>
              </div>
            </div>
          ) : (
            <div className="py-4 text-center">
              <p className="text-danger text-[13px]">
                Não foi possível carregar as informações do usuário.
              </p>
            </div>
          )}
        </Card>
      </section>

      <section>
        <SettingsHeader icon={Lock} title="Segurança" description="Altere sua senha de acesso ao painel." />

        <Card>
          <div className="space-y-4">
            <div className="relative">
              <Input
                label="Nova Senha"
                type={showPassword ? 'text' : 'password'}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                hint="Mínimo de 6 caracteres."
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3 top-[38px] text-fg-mute hover:text-fg transition-colors focus:outline-none"
                title={showPassword ? 'Ocultar senha' : 'Mostrar senha'}
              >
                {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>

            <div className="relative">
              <Input
                label="Confirmar Nova Senha"
                type={showPassword ? 'text' : 'password'}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
              />
            </div>

            <div className="flex items-center justify-between pt-2 gap-4">
              <FeedbackMessage feedback={passwordFeedback} />
              <Button
                variant="primary"
                size="md"
                loading={isSavingPassword}
                onClick={handleSavePassword}
                className="ml-auto flex-shrink-0"
              >
                <Save className="w-4 h-4" />
                Alterar Senha
              </Button>
            </div>
          </div>
        </Card>
      </section>
    </>
  )
}
