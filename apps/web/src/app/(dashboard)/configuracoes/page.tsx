/**
 * @file src/app/(dashboard)/configuracoes/page.tsx
 * @description Página de Configurações do Sistema GoMoto.
 *
 * @funcionalidades
 * 1. **Segurança**: Altera a senha do usuário via `supabase.auth.updateUser`.
 * 2. **Informações da Conta**: Exibe e-mail e data de criação do usuário logado.
 */

'use client'

import React, { useState, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Lock, User, Save, Eye, EyeOff, CheckCircle2, AlertCircle, Loader2, Palette, UsersRound, ChevronRight, Activity } from 'lucide-react'
import { PageTitle } from '@/components/layout/PageTitle'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Input } from '@/components/ui/Input'
import { cn } from '@/lib/utils'
import { createClient } from '@/lib/supabase/client'
import { useProviderAccounts, useThemePreference, useLateChargePolicies } from '@gomoto/data'
import type { ThemeBrand, ColorMode } from '@gomoto/core'
import { updateThemePreferenceAction } from './actions'
import { LateChargePolicySection, type PolicyVersion } from './_components/LateChargePolicySection'
import { PaymentGatewaySection, type GatewayFeedback } from './_components/PaymentGatewaySection'

const THEME_BRANDS: { value: ThemeBrand; label: string; description: string; swatch: string[] }[] = [
  { value: 'frota-confiavel', label: 'Frota Confiável', description: 'Azul, neutros frios — recomendado', swatch: ['#F8FAFC', '#2563EB', '#0F172A'] },
  { value: 'estrada', label: 'Estrada', description: 'Petróleo, neutros quentes', swatch: ['#FAFAF9', '#0D9488', '#1C1917'] },
  { value: 'sinalizacao', label: 'Sinalização', description: 'Laranja-ember, escuro por padrão', swatch: ['#0B0C10', '#F2790A', '#F4F5F7'] },
  { value: 'classico', label: 'Clássico', description: 'Verde-limão sobre preto — visual original', swatch: ['#121212', '#BAFF1A', '#FFFFFF'] },
]

const COLOR_MODES: { value: ColorMode; label: string }[] = [
  { value: 'system', label: 'Sistema' },
  { value: 'light', label: 'Claro' },
  { value: 'dark', label: 'Escuro' },
]

/**
 * @interface UserData
 * @description Define as informações exibidas do usuário logado obtidas via Supabase Auth.
 */
interface UserData {
  email: string
  createdAt: string
}

/**
 * @interface FeedbackState
 * @description Estado das mensagens de feedback inline exibidas após operações assíncronas.
 */
interface FeedbackState {
  type: 'success' | 'error'
  message: string
}

/**
 * @component SettingsPage
 * @description Componente principal da página de Configurações.
 * Gerencia os dados da empresa, segurança e informações da conta do usuário logado.
 */
export default function SettingsPage() {
  /**
   * Cliente Supabase criado fora do ciclo de render para evitar
   * a criação de novas instâncias a cada atualização de estado.
   */
  const supabase = React.useMemo(() => createClient(), [])
  const router = useRouter()

  // --- ESTADOS: Segurança (Senha) ---

  /** @state newPassword — Campo de nova senha. */
  const [newPassword, setNewPassword] = useState<string>('')

  /** @state confirmPassword — Campo de confirmação da nova senha. */
  const [confirmPassword, setConfirmPassword] = useState<string>('')

  /** @state showPassword — Alterna a visibilidade dos campos de senha. */
  const [showPassword, setShowPassword] = useState<boolean>(false)

  /** @state isSavingPassword — Bloqueia o botão durante a operação de troca de senha. */
  const [isSavingPassword, setIsSavingPassword] = useState<boolean>(false)

  /** @state passwordFeedback — Mensagem inline de sucesso ou erro da seção de senha. */
  const [passwordFeedback, setPasswordFeedback] = useState<FeedbackState | null>(null)

  // --- ESTADOS: Informações da Conta ---

  /** @state userData — E-mail e data de criação do usuário autenticado. */
  const [userData, setUserData] = useState<UserData | null>(null)

  /** @state isLoadingUser — Exibe o spinner enquanto os dados do usuário carregam. */
  const [isLoadingUser, setIsLoadingUser] = useState<boolean>(true)

  /**
   * @state canManageUsers — Owner/Admin do tenant vê o card de "Usuários"
   * (Spec 0011 RNF-003: Operator/Viewer não deve nem saber que a tela existe,
   * então o link só aparece pra quem pode de fato acessá-la).
   */
  const [canManageUsers, setCanManageUsers] = useState(false)

  /**
   * @state isOwner — só o Owner do tenant vê/manipula a Integração de
   * Pagamento (conectar/desconectar Mercado Pago afeta o recebimento de
   * toda a empresa). Mais restrito que canManageUsers (que também libera Admin).
   */
  const [isOwner, setIsOwner] = useState(false)

  // --- ESTADOS: Integração de Pagamento ---

  const paymentConnectionQuery = useProviderAccounts()
  const policiesQuery = useLateChargePolicies()
  const [paymentFeedback, setPaymentFeedback] = useState<GatewayFeedback | null>(null)

  // --- ESTADOS: Aparência (ADR 0019) ---

  const themePreferenceQuery = useThemePreference()
  const [themeBrand, setThemeBrand] = useState<ThemeBrand>('frota-confiavel')
  const [colorMode, setColorMode] = useState<ColorMode>('system')
  const [isSavingTheme, setIsSavingTheme] = useState(false)
  const [themeFeedback, setThemeFeedback] = useState<FeedbackState | null>(null)

  useEffect(() => {
    if (themePreferenceQuery.data) {
      setThemeBrand(themePreferenceQuery.data.theme_brand)
      setColorMode(themePreferenceQuery.data.color_mode)
    }
  }, [themePreferenceQuery.data])

  /**
   * Pré-visualização ao vivo (ADR 0019): escrever os atributos direto no
   * <html> mostra o tema escolhido na hora, sem esperar salvar. Só roda em
   * resposta a clique do usuário — nunca no mount/carregamento da
   * preferência salva, pra não piscar o tema real por um instante.
   *
   * O layout raiz (Server Component) só reexecuta em reload completo ou
   * depois de `router.refresh()` — navegação client-side entre páginas do
   * dashboard não remonta ele. Sem o cleanup abaixo, uma pré-visualização
   * não salva "vazaria" pro resto do app ao trocar de tela pela sidebar.
   * `themeSavedRef` guarda se o usuário confirmou com "Salvar Aparência";
   * se não confirmou, o unmount desta página restaura o que estava
   * persistido antes de qualquer clique.
   */
  const originalThemeRef = useRef<{ brand: string | null; mode: string | null } | null>(null)
  const themeSavedRef = useRef(false)

  useEffect(() => {
    if (originalThemeRef.current === null) {
      originalThemeRef.current = {
        brand: document.documentElement.getAttribute('data-brand'),
        mode: document.documentElement.getAttribute('data-mode'),
      }
    }
    return () => {
      if (themeSavedRef.current || !originalThemeRef.current) return
      const { brand, mode } = originalThemeRef.current
      if (brand) document.documentElement.setAttribute('data-brand', brand)
      if (mode) document.documentElement.setAttribute('data-mode', mode)
      else document.documentElement.removeAttribute('data-mode')
    }
  }, [])

  function handleSelectThemeBrand(brand: ThemeBrand) {
    setThemeBrand(brand)
    document.documentElement.setAttribute('data-brand', brand)
  }

  function handleSelectColorMode(mode: ColorMode) {
    setColorMode(mode)
    if (mode === 'system') {
      document.documentElement.removeAttribute('data-mode')
    } else {
      document.documentElement.setAttribute('data-mode', mode)
    }
  }

  async function handleSaveTheme() {
    setIsSavingTheme(true)
    setThemeFeedback(null)
    const result = await updateThemePreferenceAction({ theme_brand: themeBrand, color_mode: colorMode })
    if (!result.ok) {
      setThemeFeedback({ type: 'error', message: result.error?.message ?? 'Erro ao salvar aparência.' })
    } else {
      themeSavedRef.current = true
      setThemeFeedback({ type: 'success', message: 'Aparência atualizada.' })
      router.refresh()
    }
    setIsSavingTheme(false)
  }

  /**
   * @effect fetchInitialData
   * @description Busca as informações do usuário logado via Supabase Auth
   * ao montar o componente.
   */
  useEffect(() => {
    async function fetchInitialData() {
      try {
        // Busca o usuário autenticado para exibir na seção "Informações da Conta"
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

          const { data: membership } = await supabase
            .from('tenant_members')
            .select('role')
            .eq('user_id', user.id)
            .eq('status', 'active')
            .maybeSingle()
          setCanManageUsers(membership?.role === 'owner' || membership?.role === 'admin')
          setIsOwner(membership?.role === 'owner')
        }
      } catch {
        // Falha silenciosa: o card de conta exibirá mensagem de erro
      } finally {
        setIsLoadingUser(false)
      }
    }

    fetchInitialData()
  }, [supabase])

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const payment = params.get('payment')
    const reason  = params.get('reason')

    if (payment === 'connected') {
      // `elected=false` significa que o tenant já tinha outro gateway cobrando.
      // Conectar não troca quem recebe o dinheiro — a tela tem que dizer isso,
      // senão o usuário assume que a conta nova passou a valer.
      const elected = params.get('elected') === 'true'
      setPaymentFeedback({
        type: 'success',
        message: elected
          ? 'Conta conectada. Ela já é o gateway que gera as cobranças.'
          : 'Conta conectada. Para que ela gere as cobranças, clique em "Ativar".',
      })
      void paymentConnectionQuery.refetch()
    } else if (payment === 'cancelled') {
      setPaymentFeedback({ type: 'error', message: 'Conexão cancelada. Nenhuma conta foi vinculada.' })
    } else if (payment === 'error') {
      const messages: Record<string, string> = {
        state_mismatch:   'Falha de segurança (CSRF). Tente novamente.',
        token_exchange:   'O provedor recusou a autorização. Tente novamente.',
        misconfiguration: 'Integração não configurada no servidor. Contate o suporte.',
        unknown_provider: 'Gateway desconhecido.',
        forbidden:        'Apenas o Owner da empresa pode conectar um gateway.',
        missing_params:   'Retorno incompleto do provedor. Tente novamente.',
        other_account:    'Você autorizou uma conta diferente da integração atual deste gateway. Para usar outra conta, exclua a integração atual primeiro.',
      }
      setPaymentFeedback({ type: 'error', message: messages[reason ?? ''] ?? 'Erro ao conectar.' })
    }

    if (payment) {
      window.history.replaceState({}, '', '/configuracoes')
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /**
   * @function handleSavePassword
   * @description Valida e altera a senha do usuário via Supabase Auth.
   * Após sucesso, limpa os campos e exibe confirmação.
   */
  const handleSavePassword = async () => {
    setPasswordFeedback(null)

    // Validação: mínimo de 6 caracteres
    if (newPassword.length < 6) {
      setPasswordFeedback({
        type: 'error',
        message: 'A nova senha deve ter pelo menos 6 caracteres.',
      })
      return
    }

    // Validação: senhas devem ser iguais
    if (newPassword !== confirmPassword) {
      setPasswordFeedback({
        type: 'error',
        message: 'A confirmação de senha não coincide com a nova senha.',
      })
      return
    }

    setIsSavingPassword(true)

    try {
      const { error } = await supabase.auth.updateUser({ password: newPassword })

      if (error) throw error

      setPasswordFeedback({
        type: 'success',
        message: 'Senha alterada com sucesso!',
      })
      // Limpa os campos após a alteração bem-sucedida
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

  /**
   * @component FeedbackMessage
   * @description Componente interno que renderiza mensagens de sucesso ou erro inline.
   * Usa ícones semânticos para reforçar visualmente o tipo de feedback.
   */
  const FeedbackMessage = ({ feedback }: { feedback: FeedbackState | null }) => {
    if (!feedback) return null
    const isSuccess = feedback.type === 'success'
    return (
      <div
        className={`flex items-center gap-2 rounded-2xl px-4 py-3 text-[13px] font-medium ${
          isSuccess
            ? 'bg-success-bg border border-success text-success'
            : 'bg-danger-bg border border-danger text-danger'
        }`}
      >
        {isSuccess ? <CheckCircle2 size={16} /> : <AlertCircle size={16} />}
        <span>{feedback.message}</span>
      </div>
    )
  }

  return (
    <div className="flex flex-col min-h-full">
      <PageTitle title="Configurações" subtitle="Gerencie as preferências do sistema e detalhes da sua conta" />
      <div className="p-6 space-y-8 max-w-5xl">

        {/* SEÇÃO 1: Aparência (ADR 0019) — preferência pessoal, colocada primeiro
            para ser encontrada sem depender de rolar a página (achado de
            descobribilidade da auditoria de UX/UI 2026-08-06, ver ADR 0019 §7). */}
        <section>
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2.5 rounded-full bg-primary-tint">
              <Palette className="w-5 h-5 text-primary" />
            </div>
            <div>
              <h2 className="text-[28px] font-semibold text-fg">Aparência</h2>
              <p className="text-[13px] text-fg-mute">
                Escolha a identidade visual e o modo de cor do sistema — vale só pra você, não muda pros outros operadores.
              </p>
            </div>
          </div>

          <Card>
            <div className="space-y-5">
              <div>
                <p className="text-[13px] text-fg-soft mb-2">Tema</p>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  {THEME_BRANDS.map((brand) => (
                    <button
                      key={brand.value}
                      type="button"
                      onClick={() => handleSelectThemeBrand(brand.value)}
                      className={cn(
                        'text-left rounded-xl border p-3 transition-colors',
                        themeBrand === brand.value ? 'border-primary bg-primary-tint' : 'border-border hover:border-fg-mute',
                      )}
                    >
                      <div className="flex gap-1 mb-2">
                        {brand.swatch.map((hex) => (
                          <span
                            key={hex}
                            className="w-5 h-5 rounded-full border border-black/10"
                            style={{ backgroundColor: hex }}
                          />
                        ))}
                      </div>
                      <p className="text-[13px] font-medium text-fg">{brand.label}</p>
                      <p className="text-[11px] text-fg-mute mt-0.5">{brand.description}</p>
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <p className="text-[13px] text-fg-soft mb-2">Modo de cor</p>
                <div className="inline-flex rounded-full border border-border p-1 gap-1">
                  {COLOR_MODES.map((mode) => (
                    <button
                      key={mode.value}
                      type="button"
                      onClick={() => handleSelectColorMode(mode.value)}
                      className={cn(
                        'h-8 px-4 rounded-full text-[12px] font-medium transition-colors',
                        colorMode === mode.value ? 'bg-primary text-primary-contrast' : 'text-fg-soft hover:text-fg',
                      )}
                    >
                      {mode.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex items-center justify-between pt-2 gap-4">
                <FeedbackMessage feedback={themeFeedback} />
                <Button
                  variant="primary"
                  size="md"
                  loading={isSavingTheme}
                  onClick={handleSaveTheme}
                  className="ml-auto flex-shrink-0"
                >
                  <Save className="w-4 h-4" />
                  Salvar Aparência
                </Button>
              </div>
            </div>
          </Card>
        </section>

        {/* SEÇÃO 2: Segurança — Alteração de Senha */}
        <section>
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2.5 rounded-full bg-info-bg border border-info">
              <Lock className="w-5 h-5 text-info" />
            </div>
            <div>
              <h2 className="text-[28px] font-semibold text-fg">Segurança</h2>
              <p className="text-[13px] text-fg-mute">Altere sua senha de acesso ao painel.</p>
            </div>
          </div>

          <Card>
            <div className="space-y-4">
              {/* Campo: Nova Senha com botão de visibilidade */}
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

              {/* Campo: Confirmação de Senha */}
              <div className="relative">
                <Input
                  label="Confirmar Nova Senha"
                  type={showPassword ? 'text' : 'password'}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                />
              </div>

              {/* Área de ações com feedback inline */}
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

        {/* SEÇÃO 3: Gateway de Pagamento (ADR 0030) — só Owner vê/manipula:
            escolher por onde a empresa recebe não é preferência operacional.
            Mesmo padrão de "esconder, não só bloquear" já usado pra Usuários
            (RNF-003). A checagem que vale é a do banco, em fn_assert_gateway_owner. */}
        {isOwner ? (
          <PaymentGatewaySection
            accounts={paymentConnectionQuery.data?.accounts ?? []}
            isLoading={paymentConnectionQuery.isLoading}
            feedback={paymentFeedback}
            onFeedback={setPaymentFeedback}
            onChanged={() => { void paymentConnectionQuery.refetch() }}
          />
        ) : null}

        {/* SEÇÃO 3-b: Encargo por atraso — Owner só, mesmo racional da integração
            de pagamento: define quanto TODO cliente paga de multa e juros, não é
            preferência operacional. Até aqui só dava pra mudar por SQL. */}
        {isOwner ? (
          <LateChargePolicySection
            versions={(policiesQuery.data ?? []) as PolicyVersion[]}
            onSaved={() => { void policiesQuery.refetch() }}
          />
        ) : null}

        {/* SEÇÃO 4: Usuários (Spec 0011) — só visível pra Owner/Admin do tenant;
            RNF-003 quer que Operator/Viewer nem saiba que a tela existe. */}
        {canManageUsers ? (
          <section>
            <div className="flex items-center gap-3 mb-4">
              <div className="p-2.5 rounded-full bg-info-bg border border-info">
                <UsersRound className="w-5 h-5 text-info" />
              </div>
              <div>
                <h2 className="text-[28px] font-semibold text-fg">Usuários</h2>
                <p className="text-[13px] text-fg-mute">
                  Convide pessoas da sua equipe, gerencie papéis e revogue acesso.
                </p>
              </div>
            </div>

            <Link href="/configuracoes/usuarios">
              <Card className="hover:border-fg-mute transition-colors cursor-pointer">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-[13px] font-medium text-fg">Gerenciar usuários</p>
                    <p className="text-[12px] text-fg-mute mt-0.5">
                      Convidar, alterar papel, revogar e reativar acesso de membros da empresa.
                    </p>
                  </div>
                  <ChevronRight className="w-5 h-5 text-fg-mute shrink-0" />
                </div>
              </Card>
            </Link>
          </section>
        ) : null}

        {/* SEÇÃO 4-bis: Diagnóstico das integrações (ADR 0034) */}
        {canManageUsers ? (
          <section>
            <div className="flex items-center gap-3 mb-4">
              <div className="p-2.5 rounded-full bg-info-bg border border-info">
                <Activity className="w-5 h-5 text-info" />
              </div>
              <div>
                <h2 className="text-[28px] font-semibold text-fg">Integrações</h2>
                <p className="text-[13px] text-fg-mute">
                  O que os gateways enviaram e o que virou dinheiro de verdade.
                </p>
              </div>
            </div>

            <Link href="/configuracoes/integracoes">
              <Card className="hover:border-fg-mute transition-colors cursor-pointer">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-[13px] font-medium text-fg">Diagnóstico das integrações</p>
                    <p className="text-[12px] text-fg-mute mt-0.5">
                      Eventos recebidos dos gateways, o que falhou, e a reconciliação do razão.
                    </p>
                  </div>
                  <ChevronRight className="w-5 h-5 text-fg-mute shrink-0" />
                </div>
              </Card>
            </Link>
          </section>
        ) : null}

        {/* SEÇÃO 5: Informações da Conta */}
        <section>
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2.5 rounded-full bg-warning-bg border border-warning">
              <User className="w-5 h-5 text-warning" />
            </div>
            <div>
              <h2 className="text-[28px] font-semibold text-fg">Informações da Conta</h2>
              <p className="text-[13px] text-fg-mute">Detalhes do usuário autenticado no sistema.</p>
            </div>
          </div>

          <Card>
            {isLoadingUser ? (
              /* Estado de carregamento do usuário */
              <div className="flex justify-center py-6">
                <Loader2 className="animate-spin text-fg-mute" size={28} />
              </div>
            ) : userData ? (
              /* Exibe os dados do usuário logado */
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
              /* Fallback quando os dados do usuário não puderam ser carregados */
              <div className="py-4 text-center">
                <p className="text-danger text-[13px]">
                  Não foi possível carregar as informações do usuário.
                </p>
              </div>
            )}
          </Card>
        </section>
      </div>

    </div>
  )
}
