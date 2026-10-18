/**
 * Renovação de credencial de gateway (ADR 0031 §2).
 *
 * O access_token da Cora vale 24 HORAS e o refresh token é ROTATIVO: renovar
 * devolve um novo, e o anterior sobrevive a no máximo 3 usos. Duas requisições
 * concorrentes renovando gastam a janela à toa e, no limite, derrubam a conexão
 * da locadora inteira.
 *
 * O que se prova aqui:
 *  - só UMA requisição renova; a outra segue com a credencial vigente
 *  - o refresh token novo é gravado (senão a próxima renovação usa o gasto)
 *  - posse abandonada por falha de rede não trava a integração para sempre
 *  - credencial longe do vencimento não dispara renovação nenhuma
 */

import { test, expect } from '@playwright/test'
import { getSupabaseAdmin, TEST_TAG } from './helpers'
import { resolveCredentials } from '../src/lib/payment/credentials'
import type { PaymentProvider, ProviderCredentials } from '../src/lib/payment/types'

const admin = () => getSupabaseAdmin()
const RUN = Date.now().toString(36)

/**
 * Tenant 2, de propósito — NÃO o de `getTestTenantId()`.
 *
 * `api-payment-intent.spec.ts` tem um teste que desconecta TODAS as contas
 * ativas do tenant 1 para montar a condição "nenhum gateway eleito". Os
 * arquivos de spec rodam em workers paralelos: com este aqui no mesmo tenant,
 * um derruba a conta do outro no meio, e o índice único parcial de
 * `is_default` estoura na hora errada. Deu falha intermitente na suíte.
 *
 * Este spec não precisa de nada do tenant 1 — só de uma linha em
 * `payment_provider_accounts` e das RPCs de credencial. Tenant separado é
 * isolamento de verdade, não sincronização entre arquivos.
 */
const tenantId = '00000000-0000-0000-0000-000000000002'

let accountId = ''

/** Provedor falso que conta quantas vezes o refresh foi de fato chamado. */
function provedorFalso(opts: { falhar?: boolean } = {}) {
  const renovacoes: ProviderCredentials[] = []
  const provider: PaymentProvider = {
    descriptor: {
      id: 'cora', label: 'Provedor Falso', description: 'teste',
      connectionMode: 'oauth', methods: ['pix'], minAmount: 0.01, available: true,
    },
    oauth: {
      buildAuthUrl: () => 'https://exemplo',
      exchangeCode: async () => { throw new Error('não usado') },
      async refresh(credentials) {
        renovacoes.push(credentials)
        if (opts.falhar) throw new Error('rede caiu no meio da renovação')
        return {
          access_token: `tk-renovado-${renovacoes.length}`,
          refresh_token: `rf-renovado-${renovacoes.length}`,
          expires_at: new Date(Date.now() + 24 * 3600_000).toISOString(),
        }
      },
    },
    createIntent: async () => { throw new Error('não usado') },
  }
  return { provider, renovacoes }
}

/** Grava a credencial da conta com o vencimento pedido. */
async function semear(expiresAt: string | null) {
  const creds: Record<string, unknown> = {
    access_token: 'tk-original', refresh_token: 'rf-original',
  }
  if (expiresAt) creds.expires_at = expiresAt
  const { error } = await admin().rpc('fn_store_provider_credentials', {
    p_account_id: accountId, p_credentials: creds,
  })
  if (error) throw new Error(`semear: ${error.message}`)
}

async function tokenVigente(): Promise<string> {
  const { data } = await admin().rpc('fn_provider_credentials', { p_account_id: accountId })
  return (data as { access_token: string }).access_token
}

const AGORA_MAIS = (ms: number) => new Date(Date.now() + ms).toISOString()

test.beforeAll(async () => {
  const { data, error } = await admin()
    .from('payment_provider_accounts')
    .insert({
      tenant_id: tenantId, provider: 'cora',
      external_account_id: `${TEST_TAG}-renov-${RUN}`, active: true,
    })
    .select('id').single()
  if (error) throw new Error(`conta: ${error.message}`)
  accountId = (data as { id: string }).id
})

test.afterAll(async () => {
  if (accountId) await admin().from('payment_provider_accounts').delete().eq('id', accountId)
})

const conta = () => ({ id: accountId, provider: 'cora' })

test('credencial longe do vencimento não é renovada', async () => {
  await semear(AGORA_MAIS(20 * 3600_000)) // 20h de sobra
  const { provider, renovacoes } = provedorFalso()

  const creds = await resolveCredentials(conta(), provider)

  expect(renovacoes, 'renovou sem precisar — queimaria a rotação da Cora').toHaveLength(0)
  expect(creds.access_token).toBe('tk-original')
})

test('credencial perto de vencer é renovada e o refresh NOVO é gravado', async () => {
  await semear(AGORA_MAIS(60_000)) // 1 min — dentro da margem de 10 min
  const { provider, renovacoes } = provedorFalso()

  const creds = await resolveCredentials(conta(), provider)

  expect(renovacoes).toHaveLength(1)
  expect(creds.access_token).toBe('tk-renovado-1')

  // O refresh token rotativo precisa estar PERSISTIDO: se ficar o antigo, a
  // renovação seguinte usa um token que já gastou a janela de 3 usos.
  const { data } = await admin().rpc('fn_provider_credentials', { p_account_id: accountId })
  const gravada = data as { access_token: string; refresh_token: string }
  expect(gravada.access_token).toBe('tk-renovado-1')
  expect(gravada.refresh_token, 'gravou o refresh token antigo').toBe('rf-renovado-1')
})

test('duas requisições concorrentes renovam UMA vez só', async () => {
  await semear(AGORA_MAIS(60_000))
  const { provider, renovacoes } = provedorFalso()

  const [a, b] = await Promise.all([
    resolveCredentials(conta(), provider),
    resolveCredentials(conta(), provider),
  ])

  expect(renovacoes, 'as duas renovaram — a rotação da Cora seria gasta em dobro').toHaveLength(1)

  // Quem perdeu a corrida segue com a credencial vigente. Ela ainda vale: a
  // renovação dispara com 10 minutos de margem, não no vencimento.
  const tokens = [a.access_token, b.access_token]
  expect(tokens).toContain('tk-renovado-1')
  expect(tokens.filter((t) => t === 'tk-original').length).toBeLessThanOrEqual(1)
})

test('renovação que falha solta a posse em vez de travar a integração', async () => {
  await semear(AGORA_MAIS(60_000))
  const falho = provedorFalso({ falhar: true })

  // Token ainda válido (dentro da margem): a cobrança segue com o atual.
  const creds = await resolveCredentials(conta(), falho.provider)
  expect(creds.access_token).toBe('tk-original')

  const { data: linha } = await admin()
    .from('payment_provider_accounts').select('refresh_claimed_at').eq('id', accountId).single()
  expect(
    (linha as { refresh_claimed_at: string | null }).refresh_claimed_at,
    'posse ficou pendurada — a próxima tentativa esperaria o lease vencer',
  ).toBeNull()

  // E a tentativa seguinte, agora com o provedor são, renova de verdade.
  const bom = provedorFalso()
  await resolveCredentials(conta(), bom.provider)
  expect(bom.renovacoes).toHaveLength(1)
  expect(await tokenVigente()).toBe('tk-renovado-1')
})

test('credencial vencida com renovação falhando manda reconectar', async () => {
  await semear(AGORA_MAIS(-60_000)) // já venceu
  const { provider } = provedorFalso({ falhar: true })

  await expect(resolveCredentials(conta(), provider))
    .rejects.toThrow(/reconecte a conta/i)
})

test('provedor sem validade conhecida não é renovado', async () => {
  await semear(null) // sem expires_at — MP conectado antes da ADR 0031
  const { provider, renovacoes } = provedorFalso()

  const creds = await resolveCredentials(conta(), provider)

  expect(renovacoes).toHaveLength(0)
  expect(creds.access_token).toBe('tk-original')
})
