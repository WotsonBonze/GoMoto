import { PAYMENT_PROVIDERS, type PaymentProviderDescriptor } from '@gomoto/core'
import type { ProviderAccountRow } from '@gomoto/data'

/**
 * Estado de um provedor para a tela de gateways.
 *
 * `connected` e `billing` são coisas diferentes, e a distinção é o ponto da
 * feature: uma conta pode estar conectada e não ser a que cobra.
 */
export type GatewayRowState = {
  descriptor: PaymentProviderDescriptor
  account: ProviderAccountRow | null
  connected: boolean
  billing: boolean
}

/**
 * Uma linha por provedor do catálogo, com a conta que REPRESENTA o provedor.
 *
 * Um provedor pode ter mais de uma conta: reconectar com OUTRA conta no
 * provedor (sandbox → produção no Asaas, outra conta no Mercado Pago) cria
 * linha nova e a antiga fica desconectada, preservada pelo histórico. A tela
 * mostrava a primeira que a consulta devolvesse — e com as duas fora do
 * gateway ativo a ordem entre elas é indefinida: aparecia a desconectada com
 * "Reconectar", e a conectada sumia sem botão de Ativar.
 *
 * Prioridade: a que cobra, depois a conectada, depois qualquer uma.
 */
export function buildGatewayRows(accounts: ProviderAccountRow[]): GatewayRowState[] {
  return PAYMENT_PROVIDERS.map((descriptor) => {
    const own = accounts.filter((a) => a.provider === descriptor.id)
    const account =
      own.find((a) => a.is_default && a.active)
      ?? own.find((a) => a.active)
      ?? own[0]
      ?? null
    return {
      descriptor,
      account,
      connected: !!account?.active,
      billing: !!account?.is_default && !!account?.active,
    }
  })
}
