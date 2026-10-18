import { redirect } from 'next/navigation'

/**
 * `/configuracoes` não tem conteúdo próprio: cada assunto vive na sua
 * sub-rota (ver `layout.tsx`). "Minha conta" é a única que todo papel vê.
 */
export default function ConfiguracoesPage() {
  redirect('/configuracoes/conta')
}
