/**
 * @file page.tsx (Login)
 * @description Rota `/login`. Resolve no servidor a marca da locadora pelo
 * subdomínio (`{sub}.locaw.com.br`, ADR 0042) e entrega ao formulário — o
 * logo já vem no HTML, sem piscar o logo Locaw antes.
 */

import { headers } from 'next/headers'
import { getLoginBranding } from '@/lib/login-branding'
import { LoginForm } from './LoginForm'

export default async function LoginPage() {
  const branding = await getLoginBranding(headers().get('host'))
  return <LoginForm branding={branding} />
}
