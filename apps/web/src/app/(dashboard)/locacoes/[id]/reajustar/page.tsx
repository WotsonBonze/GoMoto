import { redirect } from 'next/navigation'

/**
 * Reajustar virou um recorte de Ajustar (ADR 0035).
 *
 * A rota sobrevive como redirect em vez de sumir: ela está em links salvos, no
 * histórico do navegador e em abas abertas, e 404 no meio de uma operação é
 * pior do que uma navegação a mais.
 */
export default async function ReajustarRedirect({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  redirect(`/locacoes/${id}/ajustar`)
}
