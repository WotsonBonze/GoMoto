/**
 * @file layout.tsx
 * @description Layout raiz (Root Layout) da aplicação GoMoto.
 * 
 * Este é o componente de nível mais alto na hierarquia do Next.js (App Router).
 * Ele define a estrutura base do documento HTML que envolve todas as páginas do sistema.
 * 
 * Responsabilidades:
 * - Definição do idioma global da aplicação (pt-BR).
 * - Importação dos estilos globais (CSS).
 * - Configuração de metadados SEO (Título e Descrição).
 * - Renderização do corpo do documento (body) onde o conteúdo das páginas será injetado.
 * 
 * Por ser o layout raiz, ele é aplicado tanto às rotas públicas (Login) 
 * quanto às rotas autenticadas (Dashboard).
 */

// Importação do tipo Metadata para garantir tipagem correta nas configurações de SEO.
import type { Metadata } from 'next'
// Importação do arquivo de estilos globais que contém as diretivas do Tailwind CSS e resets de CSS.
import './globals.css'
import { createClient } from '@/lib/supabase/server'
import { getThemePreference } from '@/lib/auth/theme'

/**
 * @constant metadata
 * @description Objeto de configuração para os metadados da aplicação.
 * Estes valores são utilizados pelo Next.js para preencher as tags <head> do HTML,
 * influenciando como o site aparece em mecanismos de busca e abas do navegador.
 * 
 * @type {Metadata}
 */
export const metadata: Metadata = {
  // Título da aba do navegador.
  title: 'Locaw — Sistema de Gestão',
  // Descrição para SEO e compartilhamento social.
  description: 'Sistema de gestão para locadora de motos',
}

/**
 * @function RootLayout
 * @description Componente de layout principal que encapsula toda a aplicação.
 * 
 * @param {Object} props - Propriedades do componente.
 * @param {React.ReactNode} props.children - Representa os componentes das páginas 
 *                                          ou layouts filhos que serão renderizados 
 *                                          dentro desta estrutura.
 * 
 * @returns {JSX.Element} A estrutura base do HTML5.
 */
export default async function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  // Resolvida aqui (não no (dashboard)/layout.tsx) porque só o layout raiz
  // pode escrever atributos no <html> — layouts aninhados renderizam dentro
  // do <body> (ADR 0019 §5). Sem sessão/tenant (login, platform_admin), cai
  // no default 'frota-confiavel' + 'system'.
  const supabase = await createClient()
  const { theme_brand, color_mode } = await getThemePreference(supabase)

  return (
    // Define o atributo lang como 'pt-BR' para acessibilidade e motores de busca.
    // data-brand sempre presente; data-mode só quando a preferência não é
    // 'system' — nesse caso o CSS resolve sozinho via prefers-color-scheme,
    // sem precisar de JS no primeiro paint (ADR 0019 §1).
    <html lang="pt-BR" data-brand={theme_brand} data-mode={color_mode !== 'system' ? color_mode : undefined}>
      {/*
          A tag <body> é onde o Next.js injetará o conteúdo das rotas.
          As classes CSS aplicadas aqui afetarão todo o sistema globalmente.
      */}
      <body>
        {/*
            O children é um placeholder para o conteúdo dinâmico das páginas.
            Tudo o que for definido nos arquivos page.tsx ou layouts aninhados
            será renderizado exatamente neste ponto.
        */}
        {children}
      </body>
    </html>
  )
}
