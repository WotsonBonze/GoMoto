/**
 * Contrato de gateway de pagamento — a metade com I/O (ADR 0030).
 *
 * A metade pura (catálogo, métodos suportados, modo de conexão) vive em
 * `@gomoto/core/payments`. Aqui fica o que fala com a rede.
 *
 * O contrato anterior tinha só `createIntent`. Onboarding, refresh de
 * credencial e consulta de status estavam espalhados como funções soltas do
 * Mercado Pago, chamadas por `import` direto — o que fazia "somar um gateway"
 * significar "mexer em toda rota que toca pagamento".
 */

import type { EmbeddedLateChargeTerms, GatewayMethod, PaymentProviderDescriptor } from '@gomoto/core'

/**
 * Formato livre por provedor. Vai inteiro para o Vault e volta inteiro de lá;
 * nem o banco nem esta camada olham dentro. É o que permite `{access_token}` do
 * Mercado Pago e `{client_id, certificate, private_key}` do Cora conviverem sem
 * uma coluna para cada.
 */
export type ProviderCredentials = Record<string, unknown>

/** O que um provedor devolve quando o tenant termina de conectar. */
export type ProviderConnection = {
  /** Identidade da conta no provedor. É por aqui que o webhook acha o tenant. */
  externalAccountId: string
  /**
   * Como o usuário reconhece a conta na tela: e-mail no Mercado Pago, CNPJ na
   * Cora. Não é "email" — foi o que o primeiro provedor devolvia.
   */
  accountLabel: string | null
  credentials: ProviderCredentials
}

export type CreateIntentParams = {
  amount: number
  chargeId: string
  method: GatewayMethod
  credentials: ProviderCredentials
  customer: { name: string | null; email: string | null; document: string | null }
  /**
   * Multa e juros a embutir no código, para provedor com
   * `accruesLateChargesNatively` (ADR 0037). `null` para os demais — e o
   * provedor que os embute recusa gerar sem eles, em vez de emitir um código
   * que quitaria a dívida sem encargo.
   */
  lateCharge?: EmbeddedLateChargeTerms | null
  /** Fuso da locadora, para quem precisa de "fim do dia" (validade do código). */
  timezone?: string | null
}

export type CreatedIntent = {
  providerIntentId: string
  expiresAt: string | null
  /** QR code, linha digitável, URL — o que o provedor devolver. */
  payload: Record<string, unknown>
}

export type PaymentProvider = {
  descriptor: PaymentProviderDescriptor

  /**
   * Presente apenas quando `descriptor.connectionMode === 'oauth'`.
   * O registry garante a coerência entre os dois.
   */
  oauth?: {
    buildAuthUrl(state: string): string
    exchangeCode(code: string): Promise<ProviderConnection>
    refresh(credentials: ProviderCredentials): Promise<ProviderCredentials>
  }

  /**
   * Presente apenas quando `descriptor.connectionMode === 'api_key'`.
   *
   * `connect` SONDA a chave antes de qualquer gravação e devolve a conexão
   * pronta para o Vault — inclusive o que o provedor configurou do lado dele
   * (o webhook do Asaas). Se a gravação falhar depois, `disconnect` desfaz.
   */
  apiKey?: {
    connect(key: string): Promise<ProviderConnection>
  }

  /**
   * Desfaz no provedor o que a conexão criou lá (ex.: o webhook do Asaas).
   *
   * Best-effort: desconectar é decisão do tenant e já aconteceu do nosso lado.
   * Quem chama registra a falha e segue.
   */
  disconnect?(credentials: ProviderCredentials): Promise<void>

  createIntent(params: CreateIntentParams): Promise<CreatedIntent>

  /**
   * Cancela a tentativa no provedor (ADR 0033, Questão 1).
   *
   * **Opcional de propósito.** A InfinitePay não oferece cancelamento — a API
   * dela tem `/links` e `/payment_check`, e nada mais. Um método obrigatório
   * obrigaria uma implementação que joga fora, e o chamador não teria como
   * saber a diferença entre "cancelei" e "fingi que cancelei".
   *
   * A ausência é a resposta: o provedor não sabe cancelar, e o sistema segue
   * protegido pela metade local — o dinheiro que chegar vira crédito do
   * cliente.
   *
   * O contrato é FRACO por natureza: cancelar no provedor reduz a
   * probabilidade de o pagamento acontecer, nunca a elimina. O cliente pode
   * estar com o código aberto e pagar no mesmo segundo. Quem chama trata falha
   * como informação, jamais como impedimento.
   */
  cancelIntent?(params: {
    providerIntentId: string
    credentials: ProviderCredentials
  }): Promise<void>
}

/**
 * A credencial do gateway não vale mais.
 *
 * Existe como tipo próprio porque o tratamento é diferente de qualquer outra
 * falha: não adianta tentar de novo, alguém precisa reconectar a conta. Antes,
 * o 401 do Mercado Pago virava `Error('MP_UNAUTHORIZED')`, ninguém o
 * distinguia, e o cliente lia "Falha ao gerar cobrança. Tente novamente." —
 * conselho errado para um token que expirou há dois meses.
 */
export class ProviderAuthError extends Error {
  readonly code = 'GATEWAY_UNAUTHORIZED' as const
  constructor(readonly provider: string, message?: string) {
    super(message ?? `Credencial do gateway ${provider} inválida ou expirada`)
    this.name = 'ProviderAuthError'
  }
}

/** Erro de fluxo com código que as rotas mapeiam para HTTP. */
export type CodedError = Error & { code?: string }

export function codedError(code: string, message: string): CodedError {
  return Object.assign(new Error(message), { code })
}
