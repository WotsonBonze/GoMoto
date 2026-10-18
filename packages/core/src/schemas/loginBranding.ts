import { z } from 'zod'

/**
 * Subdomínios que nunca viram login de locadora (ADR 0042). Espelhada no
 * CHECK chk_tenants_login_subdomain_format — mudar aqui exige migration.
 */
export const RESERVED_LOGIN_SUBDOMAINS = [
  'www', 'app', 'admin', 'api', 'suporte', 'mail', 'status',
  'login', 'auth', 'static', 'cdn',
] as const

/** Um rótulo DNS: minúsculas, números e hífen, sem hífen nas pontas, até 63. */
const SUBDOMAIN_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/

export const LoginSubdomainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(SUBDOMAIN_PATTERN, 'Use letras minúsculas, números e hífen (sem hífen no início ou no fim)')
  .refine((value) => !(RESERVED_LOGIN_SUBDOMAINS as readonly string[]).includes(value), {
    message: 'Subdomínio reservado pelo sistema',
  })

/** Logo do login: mesmos limites do bucket tenant-branding (sem SVG). */
export const LOGIN_LOGO_MAX_BYTES = 1024 * 1024
export const LOGIN_LOGO_MIME_TYPES = ['image/png', 'image/webp', 'image/jpeg'] as const

/**
 * Formulário "Login personalizado" do admin da plataforma. Campo vazio
 * desliga o login personalizado (`null`).
 */
export const TenantLoginBrandingSchema = z.object({
  login_subdomain: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? null : value),
    LoginSubdomainSchema.nullable(),
  ),
})
