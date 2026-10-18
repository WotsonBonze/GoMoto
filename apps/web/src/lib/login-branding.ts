/**
 * @file login-branding.ts
 * @description Marca da locadora na tela de login, resolvida pelo subdomínio
 * (ADR 0042).
 *
 * Camadas para não consultar o banco a cada visita:
 * 1. `parseLoginSubdomain` descarta raiz, `www`, reservados e hosts de outro
 *    domínio sem I/O.
 * 2. `unstable_cache` por subdomínio, com tag invalidada pelo admin ao salvar
 *    (`revalidateTag`). O "não encontrado" também fica em cache — com o
 *    coringa `*.locaw.com.br`, qualquer um inventa subdomínios à vontade.
 * 3. Os logos têm nome versionado e cache imutável no Storage (ver a action
 *    do admin), então o navegador só baixa de novo quando o logo muda.
 */

import { unstable_cache } from 'next/cache'
import { createClient } from '@supabase/supabase-js'
import { parseLoginSubdomain } from '@gomoto/core'

export const LOGIN_BRANDING_BUCKET = 'tenant-branding'

/** Validade de segurança — a invalidação normal é por tag, imediata. */
const CACHE_SECONDS = 60 * 60

export type LoginBranding = {
  name: string
  /** Logo para fundo escuro (painel de marca). */
  logoUrl: string | null
  /** Logo para fundo claro (só formulário, abaixo de lg). */
  logoLightUrl: string | null
}

/** Tag do cache da marca de um subdomínio — usada também pelo admin ao salvar. */
export function loginBrandingTag(subdomain: string): string {
  return `login-branding:${subdomain}`
}

/** Domínio raiz dos logins de locadora; em desenvolvimento, `localhost`. */
export function loginRootDomain(): string {
  return process.env.NEXT_PUBLIC_ROOT_DOMAIN ?? 'localhost'
}

export function loginBrandingPublicUrl(path: string | null): string | null {
  if (!path) return null
  return `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/${LOGIN_BRANDING_BUCKET}/${path}`
}

type CachedBranding = { found: false } | ({ found: true } & LoginBranding)

/**
 * Consulta anônima de propósito: o login roda sem sessão, e `unstable_cache`
 * não pode depender de cookies. A RPC só expõe nome e logos de empresa ativa.
 */
async function fetchBranding(subdomain: string): Promise<CachedBranding> {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { persistSession: false } },
  )
  const { data, error } = await supabase.rpc('get_login_branding', { p_subdomain: subdomain })
  // Falha de rede não pode virar "não encontrado" em cache por uma hora:
  // lança para o unstable_cache não guardar, e quem chama cai no padrão.
  if (error) throw error

  const row = (data as { name: string; logo_path: string | null; logo_light_path: string | null }[] | null)?.[0]
  if (!row) return { found: false }

  const logoUrl = loginBrandingPublicUrl(row.logo_path)
  return {
    found: true,
    name: row.name,
    logoUrl,
    logoLightUrl: loginBrandingPublicUrl(row.logo_light_path) ?? logoUrl,
  }
}

/**
 * Marca do login para o `Host` da requisição, ou `null` para a identidade
 * Locaw (sem subdomínio, subdomínio desconhecido ou erro na consulta).
 */
export async function getLoginBranding(host: string | null): Promise<LoginBranding | null> {
  const subdomain = parseLoginSubdomain(host, loginRootDomain())
  if (!subdomain) return null

  try {
    const cached = await unstable_cache(() => fetchBranding(subdomain), ['login-branding', subdomain], {
      revalidate: CACHE_SECONDS,
      tags: [loginBrandingTag(subdomain)],
    })()
    if (!cached.found) return null
    return { name: cached.name, logoUrl: cached.logoUrl, logoLightUrl: cached.logoLightUrl }
  } catch {
    return null
  }
}
