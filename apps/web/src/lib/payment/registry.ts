/**
 * Registry de gateways (ADR 0030).
 *
 * Antes, a rota do QR importava `mercadoPagoProvider` literalmente e
 * `getOrCreateIntent` procurava a conta com `.eq('provider', provider.name)`.
 * A escolha estava invertida: o código decidia o gateway e depois procurava a
 * conta, e o `is_default` do tenant não era lido por ninguém — cadastrar um
 * segundo provedor não mudava nada.
 *
 * Aqui o sentido é o correto: a conta eleita diz o provedor, o provedor é
 * resolvido por slug. Nenhum caminho de cobrança nomeia um gateway.
 */

import { findPaymentProvider, supportsMethod, type GatewayMethod } from '@gomoto/core'
import type { PaymentProvider } from './types'
import { codedError } from './types'
import { mercadoPagoProvider } from './providers/mercadopago'
import { coraProvider } from './providers/cora'
import { infinitePayProvider } from './providers/infinitepay'
import { asaasProvider } from './providers/asaas'

export type ProviderRegistry = Record<string, PaymentProvider>

/**
 * Implementações disponíveis, por slug.
 *
 * Provedor que está no catálogo de `@gomoto/core` com `available: false` NÃO
 * aparece aqui — e é essa ausência que a tela lê como "em breve". Somar um
 * gateway é somar uma linha aqui e virar a flag lá.
 */
export const PROVIDER_REGISTRY: ProviderRegistry = {
  [mercadoPagoProvider.descriptor.id]: mercadoPagoProvider,
  [coraProvider.descriptor.id]: coraProvider,
  [infinitePayProvider.descriptor.id]: infinitePayProvider,
  [asaasProvider.descriptor.id]: asaasProvider,
}

/**
 * Implementação de um provedor.
 *
 * Falha explícita em vez de `undefined`: uma conta gravada com slug sem
 * implementação (provedor removido, escrita fora do fluxo) tem que parar aqui,
 * não estourar como "cannot read property createIntent of undefined" três
 * quadros adiante.
 */
export function getProvider(id: string, registry: ProviderRegistry = PROVIDER_REGISTRY): PaymentProvider {
  const provider = registry[id]
  if (!provider) {
    throw codedError('FORBIDDEN', `Gateway "${id}" não tem implementação nesta versão`)
  }
  return provider
}

/**
 * Valida o meio de pagamento contra o que o provedor sabe gerar.
 *
 * Este é o ponto onde o defeito G-05 morre: `method` vinha do corpo da
 * requisição do app, era propagado por três camadas e descartado no fim, com o
 * QR saindo sempre em PIX. Pedir `boleto` de um provedor que só faz PIX agora
 * é 409, não um PIX silencioso.
 */
export function assertMethodSupported(provider: PaymentProvider, method: string): GatewayMethod {
  if (!supportsMethod(provider.descriptor, method)) {
    throw codedError(
      'CONFLICT',
      `${provider.descriptor.label} não gera cobrança por ${method}`,
    )
  }
  return method
}

/** Provedor com fluxo OAuth, ou falha dizendo por quê. */
export function getOAuthProvider(id: string, registry: ProviderRegistry = PROVIDER_REGISTRY) {
  const descriptor = findPaymentProvider(id)
  if (!descriptor) throw codedError('NOT_FOUND', `Gateway "${id}" desconhecido`)

  const provider = getProvider(id, registry)
  if (descriptor.connectionMode !== 'oauth' || !provider.oauth) {
    throw codedError('CONFLICT', `${descriptor.label} não se conecta por OAuth`)
  }
  return { descriptor, oauth: provider.oauth }
}

/** Provedor que se conecta por chave de API, ou falha dizendo por quê. */
export function getApiKeyProvider(id: string, registry: ProviderRegistry = PROVIDER_REGISTRY) {
  const descriptor = findPaymentProvider(id)
  if (!descriptor) throw codedError('NOT_FOUND', `Gateway "${id}" desconhecido`)

  const provider = getProvider(id, registry)
  if (descriptor.connectionMode !== 'api_key' || !provider.apiKey) {
    throw codedError('CONFLICT', `${descriptor.label} não se conecta por chave de API`)
  }
  return { descriptor, provider, apiKey: provider.apiKey }
}
