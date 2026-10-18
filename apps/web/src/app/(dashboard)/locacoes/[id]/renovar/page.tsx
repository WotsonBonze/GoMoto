import { redirect } from 'next/navigation'

/**
 * Renovar virou um recorte de Ajustar (ADR 0035): esticar o fim é mudar um dos
 * seis parâmetros do cronograma. Mesmo racional de `reajustar/page.tsx` para
 * manter a rota viva como redirect.
 */
export default async function RenovarRedirect({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  redirect(`/locacoes/${id}/ajustar`)
}
