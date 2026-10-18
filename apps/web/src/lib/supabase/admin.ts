/**
 * Cliente Supabase com `service_role` (ADR 0034).
 *
 * Existe para as capacidades que a Fase 2 tirou do alcance de `authenticated`:
 * ler a credencial do gateway no Vault e girá-la. São operações que o navegador
 * não deve alcançar por papel nenhum, e por isso deixaram de ter grant para
 * `authenticated` — o que também significa que o cliente SSR do usuário não as
 * executa mais.
 *
 * `service_role` IGNORA RLS. Todo caminho que passa por aqui carrega a checagem
 * de tenant explicitamente — ou na função do banco (`SECURITY DEFINER` com
 * `get_user_tenants()`), ou na própria chamada. Não é atalho para pular a
 * isolação; é o papel certo para uma operação que não é de usuário.
 *
 * NUNCA importar de um Client Component: `SUPABASE_SERVICE_ROLE_KEY` não tem
 * prefixo `NEXT_PUBLIC_`, então o import falharia no bundle do cliente com a
 * chave `undefined` — barulhento, mas por acidente. O pacote `server-only`
 * transformaria isso em erro de build; não está no projeto e somá-lo por causa
 * de um arquivo não se paga.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js'

let cached: SupabaseClient | null = null

/**
 * Instância única por processo.
 *
 * Sem sessão e sem refresh automático: não há usuário para manter logado, e o
 * cliente padrão criaria um timer de renovação por instância — em ambiente
 * serverless isso vira um timer por invocação.
 */
export function createAdminClient(): SupabaseClient {
  if (cached) return cached

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!url || !key) {
    // Falha nomeada em vez de um 401 obscuro três chamadas adiante. Sem esta
    // chave, gerar cobrança para de funcionar por inteiro — a mensagem tem que
    // dizer isso, não "não autorizado".
    throw new Error(
      'SUPABASE_SERVICE_ROLE_KEY ausente: o caminho de pagamento não consegue ler a credencial do gateway.',
    )
  }

  cached = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  return cached
}
