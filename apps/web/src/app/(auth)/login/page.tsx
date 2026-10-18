/**
 * @file page.tsx (Login)
 * @description Página de autenticação do sistema GoMoto.
 * 
 * Este arquivo implementa a interface de usuário para login, 
 * permitindo que os operadores acessem o dashboard administrativo.
 * 
 * Funcionalidades:
 * - Formulário de login com campos de e-mail e senha.
 * - Integração com o Supabase Auth para validação de credenciais.
 * - Tratamento de erros de autenticação com feedback visual.
 * - Gerenciamento de estado de carregamento (loading) durante o processo de entrada.
 * - Redirecionamento automático para o dashboard após login bem-sucedido.
 * - Layout em duas colunas (painel de marca + formulário), responsivo:
 *   abaixo de lg só o formulário aparece, com o logo no topo.
 */

'use client'

// Hooks do React para gerenciamento de estado local.
import { useState } from 'react'
// Cliente Supabase configurado para operações no lado do navegador (Client Side).
import { createClient } from '@/lib/supabase/client'
// Fonte display (títulos) da identidade da tela de login.
import { Archivo } from 'next/font/google'
// Ícones: moto (marca) e spinner do botão.
import { Bike, Loader2 } from 'lucide-react'

const display = Archivo({ subsets: ['latin'], weight: '800' })

/**
 * @function LoginPage
 * @description Componente principal da página de login.
 * Renderiza o painel de marca e o formulário de entrada.
 * 
 * @returns {JSX.Element} A interface completa da tela de login.
 */
export default function LoginPage() {
  /**
   * @state email
   * @description Armazena o valor do campo de e-mail digitado pelo usuário.
   */
  const [email, setEmail] = useState('')

  /**
   * @state password
   * @description Armazena o valor do campo de senha digitado pelo usuário.
   */
  const [password, setPassword] = useState('')

  /**
   * @state error
   * @description Armazena mensagens de erro retornadas pelo servidor ou validações locais.
   */
  const [error, setError] = useState('')

  /**
   * @state loading
   * @description Controla o estado de submissão do formulário para exibir indicadores visuais no botão.
   */
  const [loading, setLoading] = useState(false)

  /**
   * @state showPassword
   * @description Alterna a visibilidade da senha (botão "Mostrar").
   */
  const [showPassword, setShowPassword] = useState(false)

  /**
   * @function handleLogin
   * @async
   * @description Processa a tentativa de login do usuário.
   * 
   * @param {React.FormEvent} event - O evento de submissão do formulário.
   */
  async function handleLogin(event: React.FormEvent) {
    // Evita o recarregamento padrão da página ao submeter o formulário.
    event.preventDefault()
    // Limpa erros anteriores antes de iniciar uma nova tentativa.
    setError('')
    // Ativa o estado de carregamento.
    setLoading(true)

    // Inicializa o cliente do Supabase para autenticação via navegador.
    const supabase = createClient()
    
    /**
     * Tenta autenticar o usuário utilizando e-mail e senha.
     * O método signInWithPassword retorna um objeto contendo data ou error.
     */
    const { error: authError } = await supabase.auth.signInWithPassword({ email, password })

    /**
     * Tratamento de falha na autenticação:
     * Se houver um erro, exibe uma mensagem amigável e desativa o loading.
     */
    if (authError) {
      setError('Email ou senha incorretos.')
      setLoading(false)
      return
    }

    // Separação de planos: platform_admin vai pro control plane;
    // tenant_member vai pro cockpit. Cada papel só vê o seu universo.
    const { data: platformRole } = await supabase.rpc('get_platform_role')

    // Navegação "dura" (não router.push): o layout raiz só resolve o tema
    // salvo (ADR 0019) via uma nova requisição ao servidor. router.push é
    // navegação client-side e reaproveita o layout raiz já cacheado da
    // tela de login (tema default, sem sessão) — o tema real só aparecia
    // depois de um F5. window.location força o layout raiz a re-executar
    // com a sessão recém-criada antes do primeiro paint.
    window.location.href = platformRole === 'owner' || platformRole === 'operator' ? '/admin/dashboard' : '/dashboard'
  }


  return (
    // Duas colunas no desktop: painel de marca escuro (esquerda) + formulário
    // em fundo claro (direita). Abaixo de lg o painel de marca some e o logo
    // sobe para o topo do formulário.
    <div className="login-brand min-h-screen grid lg:grid-cols-[minmax(0,2.1fr)_minmax(440px,1fr)] bg-[var(--login-paper)]">

      {/* Painel de marca */}
      <aside className="relative hidden lg:flex flex-col overflow-hidden bg-[var(--login-ink)] px-12 py-11">
        {/* Círculos concêntricos decorativos no canto superior direito. */}
        <div aria-hidden className="pointer-events-none absolute -top-[260px] -right-[160px] w-[640px] h-[640px] rounded-full border border-[var(--login-ink-line)]" />
        <div aria-hidden className="pointer-events-none absolute -top-[180px] -right-[80px] w-[480px] h-[480px] rounded-full border border-[var(--login-ink-line)]" />

        <BrandMark tone="dark" />

        <div className="relative my-auto">
          <p className="text-[13px] font-semibold tracking-[0.18em] uppercase text-[var(--login-accent)] mb-6">
            Gestão de locação de veículos
          </p>
          <div className="relative">
            {/* Faixa de pista: corre da borda esquerda do painel até a direita,
                atrás da última linha do título. */}
            <div
              aria-hidden
              className="absolute -left-12 -right-12 top-[78%] h-[5px] bg-[repeating-linear-gradient(to_right,var(--login-accent)_0_64px,transparent_64px_110px)]"
            />
            <h1 className={`${display.className} relative text-[clamp(48px,5.4vw,80px)] leading-[0.92] tracking-[-0.035em] text-[var(--login-ink-fg)] max-w-[660px]`}>
              Do contrato ao pagamento, sem sair da pista.
            </h1>
          </div>
        </div>

        <ul className="relative flex flex-wrap gap-2.5">
          {['Contratos', 'Cobranças recorrentes', 'Controle da frota'].map((feature) => (
            <li key={feature} className="rounded-full border border-[var(--login-ink-chip)] px-4 py-2 text-[13px] text-[var(--login-ink-fg)]">
              {feature}
            </li>
          ))}
        </ul>
      </aside>

      {/* Painel do formulário */}
      <main className="flex flex-col px-6 py-8 sm:px-12 lg:py-11 text-[var(--login-paper-fg)]">
        <div className="flex items-center justify-between lg:justify-end">
          <div className="lg:hidden"><BrandMark tone="light" /></div>
          <p className="text-[13px] text-[var(--login-paper-soft)]">
            Precisa de ajuda?{' '}
            <a href="/suporte.html" className="font-semibold text-[var(--login-paper-fg)] underline underline-offset-2">Suporte</a>
          </p>
        </div>

        <div className="w-full max-w-[380px] mx-auto my-auto py-12">
          <h2 className={`${display.className} text-[32px] leading-tight tracking-[-0.02em]`}>Bem-vindo de volta</h2>
          <p className="text-[15px] text-[var(--login-paper-soft)] mt-1 mb-8">Acesse o painel da sua locadora.</p>

          <form onSubmit={handleLogin} className="space-y-5">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="email" className="text-[13px] font-semibold">Email</label>
              <input
                id="email"
                type="email"
                placeholder="voce@locadora.com.br"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
                className={fieldClass}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <label htmlFor="password" className="text-[13px] font-semibold">Senha</label>
                {/* Recuperação de senha ainda não existe no web — o link fica
                    visível mas inerte até o fluxo ser implementado. */}
                <span
                  aria-disabled="true"
                  title="Em breve"
                  className="text-[13px] underline underline-offset-2 text-[var(--login-paper-mute)] cursor-not-allowed"
                >
                  Esqueci a senha
                </span>
              </div>
              <div className="relative">
                <input
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  placeholder="Sua senha"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  autoComplete="current-password"
                  className={`${fieldClass} pr-24`}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? 'Ocultar senha' : 'Mostrar senha'}
                  className="absolute right-4 top-1/2 -translate-y-1/2 text-[13px] font-semibold"
                >
                  {showPassword ? 'Ocultar' : 'Mostrar'}
                </button>
              </div>
            </div>

            {error && (
              <div role="alert" className="rounded-xl px-4 py-3 bg-danger-bg border border-danger">
                <p className="text-[13px] text-danger">{error}</p>
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full h-14 mt-2 rounded-xl bg-[var(--login-ink)] text-white text-[16px] font-bold flex items-center justify-center gap-2 transition-opacity hover:opacity-90 disabled:opacity-70 disabled:cursor-wait"
            >
              {loading ? (
                <><Loader2 className="w-4 h-4 animate-spin" /> Entrando...</>
              ) : (
                <>Entrar <span aria-hidden className="text-[var(--login-accent)]">→</span></>
              )}
            </button>
          </form>
        </div>

        <p className="text-center text-[12px] text-[var(--login-paper-mute)]">
          Locaw © {new Date().getFullYear()} ·{' '}
          {/* Ainda não há página de termos de uso — mesmo tratamento do "Esqueci a senha". */}
          <span aria-disabled="true" title="Em breve" className="underline underline-offset-2 cursor-not-allowed">Termos</span>
          {' · '}
          <a href="/privacidade.html" className="underline underline-offset-2 text-[var(--login-paper-soft)]">Privacidade</a>
        </p>
      </main>
    </div>
  )
}

/** Classes dos campos de texto do login (fundo branco, borda clara). */
const fieldClass =
  'w-full h-14 px-4 rounded-xl bg-[var(--login-paper)] border border-[var(--login-paper-border)] text-[15px] placeholder:text-[var(--login-paper-mute)] focus:outline-none focus:border-[var(--login-ink)] focus:ring-2 focus:ring-[var(--login-accent)]/40 transition-colors'

/**
 * @function BrandMark
 * @description Logo Locaw (ícone de moto em quadrado amarelo + nome).
 * `tone` define a cor do nome conforme o fundo.
 */
function BrandMark({ tone }: { tone: 'dark' | 'light' }) {
  return (
    <div className="relative flex items-center gap-3">
      <div className="w-11 h-11 rounded-xl bg-[var(--login-accent)] flex items-center justify-center">
        <Bike className="w-6 h-6 text-[var(--login-ink)]" />
      </div>
      <span className={`${display.className} text-[22px] tracking-[-0.02em] ${tone === 'dark' ? 'text-white' : 'text-[var(--login-paper-fg)]'}`}>
        Locaw
      </span>
    </div>
  )
}
