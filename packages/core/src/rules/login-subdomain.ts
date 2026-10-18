import { LoginSubdomainSchema } from '../schemas/loginBranding'

/**
 * Extrai o subdomínio de login de locadora de um `Host` (ADR 0042).
 *
 * Só aceita UM rótulo imediatamente antes do domínio raiz: `motosrj.locaw.com.br`
 * → `motosrj`. Domínio raiz, reservados (`www`…), formato inválido, rótulos
 * aninhados (`a.b.locaw.com.br`) e hosts de outro domínio (`*.vercel.app`)
 * devolvem `null` — o login cai na identidade Locaw sem consultar o banco.
 *
 * Em desenvolvimento `rootDomain` é `localhost`, e `motosrj.localhost:3000`
 * funciona sem mexer em /etc/hosts.
 */
export function parseLoginSubdomain(host: string | null | undefined, rootDomain: string): string | null {
  if (!host || !rootDomain) return null
  const hostname = host.trim().toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '')
  const root = rootDomain.trim().toLowerCase().replace(/\.$/, '')
  const suffix = `.${root}`
  if (!hostname.endsWith(suffix)) return null

  const label = hostname.slice(0, -suffix.length)
  if (label.includes('.')) return null

  const parsed = LoginSubdomainSchema.safeParse(label)
  return parsed.success ? parsed.data : null
}
