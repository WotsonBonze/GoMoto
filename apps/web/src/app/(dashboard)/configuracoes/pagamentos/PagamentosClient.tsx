'use client'

import { useEffect, useState } from 'react'
import { useProviderAccounts } from '@gomoto/data'
import { PaymentGatewaySection, type GatewayFeedback } from './_components/PaymentGatewaySection'

export function PagamentosClient() {
  const paymentConnectionQuery = useProviderAccounts()
  const [paymentFeedback, setPaymentFeedback] = useState<GatewayFeedback | null>(null)

  // Retorno do OAuth: `api/auth/gateway/[provider]/callback` redireciona para
  // cá com `?payment=connected|cancelled|error&reason=...`.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const payment = params.get('payment')
    const reason  = params.get('reason')

    if (payment === 'connected') {
      // `elected=false` significa que o tenant já tinha outro gateway cobrando.
      // Conectar não troca quem recebe o dinheiro — a tela tem que dizer isso,
      // senão o usuário assume que a conta nova passou a valer.
      const elected = params.get('elected') === 'true'
      setPaymentFeedback({
        type: 'success',
        message: elected
          ? 'Conta conectada. Ela já é o gateway que gera as cobranças.'
          : 'Conta conectada. Para que ela gere as cobranças, clique em "Ativar".',
      })
      void paymentConnectionQuery.refetch()
    } else if (payment === 'cancelled') {
      setPaymentFeedback({ type: 'error', message: 'Conexão cancelada. Nenhuma conta foi vinculada.' })
    } else if (payment === 'error') {
      const messages: Record<string, string> = {
        state_mismatch:   'Falha de segurança (CSRF). Tente novamente.',
        token_exchange:   'O provedor recusou a autorização. Tente novamente.',
        misconfiguration: 'Integração não configurada no servidor. Contate o suporte.',
        unknown_provider: 'Gateway desconhecido.',
        forbidden:        'Apenas o Owner da empresa pode conectar um gateway.',
        missing_params:   'Retorno incompleto do provedor. Tente novamente.',
        other_account:    'Você autorizou uma conta diferente da integração atual deste gateway. Para usar outra conta, exclua a integração atual primeiro.',
      }
      setPaymentFeedback({ type: 'error', message: messages[reason ?? ''] ?? 'Erro ao conectar.' })
    }

    if (payment) {
      window.history.replaceState({}, '', '/configuracoes/pagamentos')
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <PaymentGatewaySection
      accounts={paymentConnectionQuery.data?.accounts ?? []}
      isLoading={paymentConnectionQuery.isLoading}
      feedback={paymentFeedback}
      onFeedback={setPaymentFeedback}
      onChanged={() => { void paymentConnectionQuery.refetch() }}
    />
  )
}
