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
 * - Layout responsivo e estilizado com o branding da aplicação.
 */

'use client'

// Hooks do React para gerenciamento de estado local.
import { useState } from 'react'
// Cliente Supabase configurado para operações no lado do navegador (Client Side).
import { createClient } from '@/lib/supabase/client'
// Componentes de interface reaproveitáveis (UI Library).
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
// Ícone de moto para reforço visual da marca.
import { Bike } from 'lucide-react'

/**
 * @function LoginPage
 * @description Componente principal da página de login.
 * Renderiza o formulário centralizado com logo e campos de entrada.
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
    // Container principal: Centraliza o conteúdo vertical e horizontalmente.
    <div className="min-h-screen bg-bg flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        
        {/* 
            Seção de Identidade Visual (Logo):
            Reforça a marca Locaw com ícone e tipografia em negrito.
        */}
        <div className="flex flex-col items-center gap-3 mb-8">
          <div className="w-14 h-14 bg-primary rounded-2xl flex items-center justify-center">
            <Bike className="w-7 h-7 text-bg" />
          </div>
          <div className="text-center">
            <h1 className="text-[28px] font-bold text-fg">Locaw</h1>
            <p className="text-[20px] text-fg-mute mt-1">Sistema de Gestão</p>
          </div>
        </div>

        {/* 
            Card de Formulário:
            Concentra os campos de interação do usuário com bordas e fundo destacados.
        */}
        <div className="bg-surface border border-border rounded-2xl p-6">
          <h2 className="text-[20px] font-semibold text-fg mb-5">Entrar na conta</h2>

          <form onSubmit={handleLogin} className="space-y-4">
            {/* Campo de entrada para o E-mail. */}
            <Input
              label="Email"
              type="email"
              placeholder="seu@email.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
            />
            {/* Campo de entrada para a Senha com máscara de caracteres. */}
            <Input
              label="Senha"
              type="password"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="current-password"
            />

            {/* 
                Exibição de Erros:
                Renderização condicional de um alerta caso a autenticação falhe.
            */}
            {error && (
              <div className="rounded-2xl px-4 py-3 bg-danger-bg border border-danger">
                <p className="text-[13px] text-danger">{error}</p>
              </div>
            )}

            {/* 
                Botão de Ação:
                Inicia o processo de login. Exibe spinner se estiver em estado de loading.
            */}
            <Button type="submit" className="w-full mt-2" loading={loading} size="lg">
              {loading ? 'Entrando...' : 'Entrar'}
            </Button>
          </form>
        </div>

        {/* Rodapé com Direitos Autorais e Ano Dinâmico. */}
        <p className="text-center text-[12px] text-fg-mute mt-6">
          Locaw © {new Date().getFullYear()}
        </p>
      </div>
    </div>
  )
}
