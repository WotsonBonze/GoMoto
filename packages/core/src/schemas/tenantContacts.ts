import { z } from 'zod'

/**
 * Contato da locadora exibido no app do cliente ("Fale com a locadora").
 *
 * Rótulo livre ("Financeiro", "Manutenção") + telefone e/ou e-mail — ao menos
 * um dos dois. O telefone entra com ou sem máscara e sai só com dígitos
 * (10 ou 11, DDD incluso), que é o que a coluna aceita.
 *
 * `phone_kind` diz se o número é para ligar ou WhatsApp — o app escolhe ícone
 * e ação por ele. `business_hours` é texto livre ("Seg a sex, 8h às 18h").
 */
export const ContactPhoneKindSchema = z.enum(['phone', 'whatsapp'])
export type ContactPhoneKind = z.infer<typeof ContactPhoneKindSchema>

const optionalText = z
  .string()
  .trim()
  .optional()
  .nullable()
  .transform((v) => (v ? v : null))

export const TenantContactInputSchema = z
  .object({
    label: z.string().trim().min(1, 'Informe o nome do contato').max(60, 'Nome do contato: até 60 caracteres'),
    phone: optionalText
      .transform((v) => (v ? v.replace(/\D/g, '') : null))
      .refine((v) => v === null || /^[0-9]{10,11}$/.test(v), {
        message: 'Telefone inválido: informe DDD + número',
      }),
    phone_kind: ContactPhoneKindSchema.default('phone'),
    email: optionalText.pipe(z.string().max(200).email('E-mail inválido').nullable()),
    business_hours: optionalText.pipe(
      z.string().max(120, 'Horário de atendimento: até 120 caracteres').nullable(),
    ),
  })
  .refine((c) => c.phone !== null || c.email !== null, {
    message: 'Informe um telefone ou um e-mail',
    path: ['phone'],
  })
export type TenantContactInput = z.input<typeof TenantContactInputSchema>
export type TenantContactData = z.output<typeof TenantContactInputSchema>

export type TenantContact = TenantContactData & {
  id: string
  sort_order: number
}
