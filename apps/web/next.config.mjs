import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
const supabaseHttpOrigin = supabaseUrl ? new URL(supabaseUrl).origin : ''
const supabaseWsOrigin = supabaseHttpOrigin.replace(/^http/, 'ws')

const csp = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  `img-src 'self' data: blob: ${supabaseHttpOrigin} https://*.basemaps.cartocdn.com https://server.arcgisonline.com https://unpkg.com`,
  `connect-src 'self' ${supabaseHttpOrigin} ${supabaseWsOrigin} https://viacep.com.br`,
  "frame-ancestors 'none'",
].join('; ')

/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ['@gomoto/core'],
  experimental: {
    // Default de Server Actions é 1MB — extração de documentos (Spec 0012,
    // RNF-003) precisa aceitar upload de até 10MB.
    serverActions: {
      bodySizeLimit: '10mb',
    },
  },
  webpack(config) {
    config.resolve.alias = {
      ...config.resolve.alias,
      // pdfjs-dist legacy/build inclui canvas (addon nativo Node.js) como fallback
      // server-side. No cliente, canvas não existe — alias para false evita o erro.
      canvas: false,

      // UMA cópia do react-query em todo o bundle.
      //
      // O contexto do React Query é escopo de módulo: duas cópias físicas viram
      // dois contextos, e o `QueryClientProvider` montado aqui deixa de alcançar
      // os hooks do `@gomoto/data`. O sintoma é `No QueryClient set` numa tela
      // que tem provider — e derruba o dashboard inteiro com HTTP 500.
      //
      // As duas cópias são legítimas: `apps/web` está em React 18 e
      // `apps/mobile` em React 19, então o pnpm resolve o peer `react` do
      // react-query duas vezes. `@gomoto/data` é usado pelos dois e carrega a
      // própria cópia (devDependency + `auto-install-peers=true`), que pode
      // cair em qualquer um dos lados conforme o grafo é re-resolvido.
      //
      // Aconteceu de verdade: um `pnpm add` não relacionado virou a resolução de
      // `packages/data` de react@18 para react@19 no lockfile e quebrou a
      // produção. Localmente não reproduzia, porque o `node_modules` já
      // instalado continuava apontando para a cópia antiga — só uma instalação
      // limpa (como a da Vercel) expõe o problema.
      //
      // O alias fixa a resolução na cópia deste app e tira a sorte da jogada.
      '@tanstack/react-query': require.resolve('@tanstack/react-query'),
    }
    return config
  },
  async redirects() {
    return [
      {
        source: '/motos/:path*',
        destination: '/veiculos/:path*',
        permanent: true,
      },
    ]
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-XSS-Protection', value: '1; mode=block' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          { key: 'Content-Security-Policy', value: csp },
        ],
      },
    ]
  },
}

export default nextConfig