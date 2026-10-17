/**
 * Diagnóstico das integrações de pagamento — ADR 0034, Fase 3.
 *
 * O problema que esta tela resolve: até aqui, quando um pagamento não aparecia,
 * ninguém dentro do produto conseguia responder por quê. O rastro existia — o
 * inbox `gateway_events` guarda tudo que o provedor mandou —, mas só era
 * alcançável por quem tivesse acesso ao banco e soubesse montar o SQL. Numa
 * locadora, isso é ninguém.
 *
 * Duas perguntas, uma por seção:
 *
 *   1. **O que o gateway mandou, e o que virou disso?** (`gateway_event_audit`)
 *   2. **Existe documento que não virou lançamento?** (`financial_reconciliation`)
 *
 * A segunda pergunta já era feita por `apps/web/tests/reconciliacao.spec.ts`,
 * contra o banco de teste, em CI. Aqui ela passa a ser respondível sobre os
 * dados reais, por quem opera.
 *
 * Owner/Admin: um evento de gateway carrega valor, cliente e o erro cru do
 * provedor. É informação de gestão, no mesmo nível de "Usuários".
 */

import { redirect } from 'next/navigation'

import { requireTenantOwnerOrAdmin } from '@/lib/auth/tenant'
import { IntegracoesClient, type GatewayEventRow, type ReconciliationRow } from './IntegracoesClient'

export const dynamic = 'force-dynamic'

/**
 * Quantos eventos trazer.
 *
 * Não é paginação: é o que cabe numa tela de diagnóstico. Quem precisa de mais
 * está investigando um caso específico, e para isso os filtros do topo servem
 * melhor que rolar uma lista longa.
 */
const LIMITE_EVENTOS = 100

export default async function IntegracoesPage() {
  let ctx
  try {
    ctx = await requireTenantOwnerOrAdmin()
  } catch {
    redirect('/configuracoes/conta')
  }

  // As duas views são `security_invoker`, então a RLS filtra por tenant sozinha
  // — não há `.eq('tenant_id', ...)` aqui de propósito, pelo mesmo motivo que o
  // resto do projeto confia na RLS para leitura.
  const [eventos, reconciliacao] = await Promise.all([
    ctx.supabase
      .from('gateway_event_audit')
      .select('*')
      .order('received_at', { ascending: false })
      .limit(LIMITE_EVENTOS),
    ctx.supabase
      .from('financial_reconciliation')
      .select('*')
      .order('occurred_at', { ascending: false })
      .limit(LIMITE_EVENTOS),
  ])

  return (
    <IntegracoesClient
      eventos={(eventos.data ?? []) as GatewayEventRow[]}
      reconciliacao={(reconciliacao.data ?? []) as ReconciliationRow[]}
      loadError={eventos.error?.message ?? reconciliacao.error?.message ?? null}
    />
  )
}
