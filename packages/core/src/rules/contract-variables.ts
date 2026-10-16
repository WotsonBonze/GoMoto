/**
 * @file rules/contract-variables.ts
 * @description Catálogo de variáveis `{{chave}}` usadas nos modelos de
 * contrato (Tiptap) e resolução delas a partir de dados reais de uma
 * locação. Movido de `apps/web/.../contratos/modelos/_components/variables.ts`
 * para o domínio — é lógica pura sem I/O, consumida por telas de rotas
 * diferentes (modelos de contrato e criação de locação).
 */

import type { Customer, Vehicle } from '../types/index'
import { applyCpfMask, applyZipMask, formatDocument, formatRenavam } from '../masks'
import { formatCurrencyPlain } from '../utils/index'
import { currencyToExtensoPtBr } from '../utils/currency-words'
import { formatDateExtensoPtBr } from '../utils/date-words'
import { formatDueDay, type RentalCycle } from './rentals'

export interface TemplateVariable {
  key: string
  label: string
  category: string
  sample: string
}

export const TEMPLATE_VARIABLES = [
  // Cliente
  { key: 'nome_cliente',      label: 'Nome completo',              category: 'Cliente',    sample: 'João Silva Santos' },
  { key: 'cpf_cliente',       label: 'CPF',                        category: 'Cliente',    sample: '123.456.789-00' },
  { key: 'rg_cliente',        label: 'RG',                         category: 'Cliente',    sample: '12.488.178' },
  { key: 'cnh_cliente',       label: 'Número da habilitação',      category: 'Cliente',    sample: '00123456789' },
  { key: 'categoria_cnh',     label: 'Categoria CNH',              category: 'Cliente',    sample: 'AB' },
  { key: 'endereco_cliente',  label: 'Endereço completo',          category: 'Cliente',    sample: 'Rua das Flores, 123, Bairro Centro, Rio de Janeiro — RJ, 20040-020' },
  { key: 'cep_cliente',       label: 'CEP',                        category: 'Cliente',    sample: '20040-020' },
  // Veículo
  { key: 'marca_veiculo',        label: 'Marca',                      category: 'Veículo',       sample: 'HONDA' },
  { key: 'modelo_veiculo',       label: 'Marca + Modelo',             category: 'Veículo',       sample: 'HONDA CG 160 START' },
  { key: 'ano_fabricacao_veiculo', label: 'Ano de fabricação',        category: 'Veículo',       sample: '2024' },
  { key: 'ano_modelo_veiculo',   label: 'Ano do modelo',              category: 'Veículo',       sample: '2025' },
  { key: 'ano_fab_mod_veiculo',  label: 'Fabricação/Modelo (ex: 2024/2025)', category: 'Veículo', sample: '2024/2025' },
  { key: 'renavam_veiculo',      label: 'RENAVAM',                    category: 'Veículo',       sample: '00123456789' },
  { key: 'placa_veiculo',        label: 'Placa',                      category: 'Veículo',       sample: 'ABC-1D23' },
  { key: 'chassi_veiculo',       label: 'Chassi',                     category: 'Veículo',       sample: '9C2JC4110SR500001' },
  { key: 'cor_veiculo',          label: 'Cor',                        category: 'Veículo',       sample: 'Vermelho' },
  { key: 'combustivel_veiculo',  label: 'Combustível',                category: 'Veículo',       sample: 'Flex' },
  { key: 'km_inicial',        label: 'KM atual do veículo (no momento da locação)', category: 'Veículo', sample: '12.540' },
  // Amostra deliberadamente diferente da de nome_empresa: registered_owner_name
  // só coincide com o nome da empresa quando a moto já foi transferida pro
  // CNPJ dela (ownership_transferred=true) — antes disso é o vendedor/pessoa
  // física (ver PRD 0002). Sample igual ao de nome_empresa deixava as duas
  // variáveis parecendo o mesmo dado no preview do modelo.
  { key: 'proprietario_veiculo', label: 'Proprietário (nome)',        category: 'Veículo',       sample: 'Roberto Almeida Souza' },
  { key: 'documento_proprietario_veiculo', label: 'Documento do proprietário (CPF/CNPJ)', category: 'Veículo', sample: '987.654.321-00' },
  // Financeiro e datas
  { key: 'valor_semanal',     label: 'Valor do ciclo por extenso (legado — use valor_ciclo)', category: 'Financeiro', sample: '350,00 (trezentos e cinquenta reais)' },
  { key: 'valor_ciclo',       label: 'Valor do ciclo por extenso (semanal ou mensal)', category: 'Financeiro', sample: '350,00 (trezentos e cinquenta reais)' },
  { key: 'ciclo_cobranca',    label: 'Ciclo de cobrança',          category: 'Financeiro', sample: 'Mensal' },
  { key: 'dia_vencimento',    label: 'Dia de vencimento',          category: 'Financeiro', sample: 'Dia 10' },
  { key: 'caucao',            label: 'Valor da caução por extenso', category: 'Financeiro', sample: '1.000,00 (mil reais)' },
  { key: 'data_inicio',       label: 'Data de início por extenso', category: 'Datas',      sample: '1 de julho de 2026' },
  { key: 'data_fim',          label: 'Data de fim por extenso',    category: 'Datas',      sample: '30 de setembro de 2026' },
  { key: 'data_hoje',         label: 'Data atual por extenso',     category: 'Datas',      sample: '6 de julho de 2026' },
  // Empresa
  { key: 'nome_empresa',      label: 'Nome da empresa',            category: 'Empresa',    sample: 'Locaw Locações LTDA' },
] as const satisfies readonly TemplateVariable[]

// Deriva as chaves reais do catálogo — usado para forçar em tempo de
// compilação que `resolveContractVariables`/`buildSampleData` cubram 100%
// das variáveis declaradas acima (nenhuma chave nova pode ficar sem resolução).
export type TemplateVariableKey = (typeof TEMPLATE_VARIABLES)[number]['key']

// Derivado do catálogo (não mantido à mão) — uma categoria nova em
// TEMPLATE_VARIABLES aparece aqui automaticamente, na ordem em que aparece
// pela primeira vez no array acima.
export const VARIABLE_CATEGORIES = Array.from(
  new Set(TEMPLATE_VARIABLES.map(v => v.category)),
) as (typeof TEMPLATE_VARIABLES)[number]['category'][]

export function buildSampleData(): Record<TemplateVariableKey, string> {
  return Object.fromEntries(TEMPLATE_VARIABLES.map(v => [v.key, v.sample])) as Record<TemplateVariableKey, string>
}

export function substituteVariables(html: string, data: Record<string, string>): string {
  return html.replace(/\{\{([\w_]+)\}\}/g, (match, key) => data[key] ?? match)
}

// Colunas de `customers`/`vehicles` que `resolveContractVariables` precisa —
// única fonte de verdade para o Pick abaixo. NÃO dá para montar o `.select()`
// do Supabase a partir destes arrays em runtime (`.join(',')`): o client
// tipado só infere o shape do retorno quando a string passada a `.select()`
// é literal, então quem faz select explícito (não `select('*')`) precisa
// copiar os nomes à mão — use `warnMissingContractFields` (abaixo) logo após
// o fetch para pegar esquecimentos em dev.
export const CONTRACT_CUSTOMER_FIELDS = [
  'name', 'cpf', 'rg', 'drivers_license', 'drivers_license_category',
  'street', 'street_number', 'complement', 'neighborhood', 'city', 'state', 'zip_code',
] as const satisfies readonly (keyof Customer)[]

export const CONTRACT_VEHICLE_FIELDS = [
  'make', 'model', 'year_manufacture', 'year_model', 'renavam',
  'license_plate', 'chassis', 'color', 'fuel', 'km_current',
  'registered_owner_name', 'registered_owner_document',
] as const satisfies readonly (keyof Vehicle)[]

/**
 * @function warnMissingContractFields
 * @description Alerta (console.warn, dev only) quando um registro vindo de
 * um `select()` explícito do Supabase não tem alguma das colunas listadas
 * em `CONTRACT_CUSTOMER_FIELDS`/`CONTRACT_VEHICLE_FIELDS` — sinal de que o
 * `.select()` da página ficou desalinhado com o que `resolveContractVariables`
 * precisa. Verifica presença da CHAVE, não o valor (`null` é um dado válido).
 */
export function warnMissingContractFields(
  label: string,
  record: Record<string, unknown> | null | undefined,
  fields: readonly string[],
): void {
  if (process.env.NODE_ENV === 'production' || !record) return
  const missing = fields.filter(f => !(f in record))
  if (missing.length > 0) {
    console.warn(`[contract-variables] ${label}: colunas ausentes no select() — ${missing.join(', ')}. Verifique CONTRACT_CUSTOMER_FIELDS/CONTRACT_VEHICLE_FIELDS.`)
  }
}

export interface ResolveContractVariablesInput {
  customer: Pick<Customer, (typeof CONTRACT_CUSTOMER_FIELDS)[number]>
  vehicle: Pick<Vehicle, (typeof CONTRACT_VEHICLE_FIELDS)[number]>
  rental: {
    cycle: RentalCycle
    due_day: number
    cycle_amount: number
    start_date: string
    end_date: string
    security_deposit?: number | null
    /**
     * Spec 0014 (RF-004): km do veículo NA ENTREGA, congelado em
     * `rentals.km_initial`. Fonte de `km_inicial` — `vehicle.km_current` é
     * mutável e muda depois da entrega, o que fazia o PDF reimpresso mudar de
     * km sozinho. `null`/ausente cai no fallback de `vehicle.km_current`, para
     * locação anterior a esta feature e para o preview do formulário de
     * criação (a locação ainda não existe no banco).
     */
    km_initial?: number | null
  }
  tenantName: string
  /** Injetável para teste determinístico — default `new Date()`. */
  today?: Date
}

/**
 * @function resolveContractVariables
 * @description Resolve o dicionário `{{chave}} → valor` de um contrato a
 * partir de dados reais de cliente/veículo/locação/tenant, para uso em
 * `substituteVariables`. Complementa `buildSampleData` (dados fictícios,
 * usada só no preview de modelos).
 */
export function resolveContractVariables(input: ResolveContractVariablesInput): Record<TemplateVariableKey, string> {
  const { customer, vehicle, rental, tenantName } = input
  const today = input.today ?? new Date()

  const addressParts = [
    [customer.street, customer.street_number].filter(Boolean).join(', ') || null,
    customer.complement,
    customer.neighborhood ? `Bairro ${customer.neighborhood}` : null,
    [customer.city, customer.state].filter(Boolean).join(' — ') || null,
    customer.zip_code ? applyZipMask(customer.zip_code) : null,
  ].filter(Boolean) as string[]

  const cycleAmountWords = `${formatCurrencyPlain(rental.cycle_amount)} (${currencyToExtensoPtBr(rental.cycle_amount)})`
  const depositWords = rental.security_deposit
    ? `${formatCurrencyPlain(rental.security_deposit)} (${currencyToExtensoPtBr(rental.security_deposit)})`
    : 'Não há caução'

  return {
    nome_cliente: customer.name ?? '',
    cpf_cliente: customer.cpf ? applyCpfMask(customer.cpf) : '',
    rg_cliente: customer.rg ?? '',
    cnh_cliente: customer.drivers_license ?? '',
    categoria_cnh: customer.drivers_license_category ?? '',
    endereco_cliente: addressParts.join(', '),
    cep_cliente: customer.zip_code ? applyZipMask(customer.zip_code) : '',

    marca_veiculo: vehicle.make ?? '',
    modelo_veiculo: `${vehicle.make ?? ''} ${vehicle.model ?? ''}`.trim(),
    ano_fabricacao_veiculo: vehicle.year_manufacture ?? '',
    ano_modelo_veiculo: vehicle.year_model ?? '',
    ano_fab_mod_veiculo: vehicle.year_model ? `${vehicle.year_manufacture}/${vehicle.year_model}` : (vehicle.year_manufacture ?? ''),
    renavam_veiculo: vehicle.renavam ? formatRenavam(vehicle.renavam) : '',
    placa_veiculo: vehicle.license_plate ?? '',
    chassi_veiculo: vehicle.chassis ?? '',
    cor_veiculo: vehicle.color ?? '',
    combustivel_veiculo: vehicle.fuel ?? '',
    km_inicial: (() => {
      const km = rental.km_initial ?? vehicle.km_current
      return km != null ? km.toLocaleString('pt-BR') : ''
    })(),
    proprietario_veiculo: vehicle.registered_owner_name ?? '',
    documento_proprietario_veiculo: vehicle.registered_owner_document ? formatDocument(vehicle.registered_owner_document) : '',

    valor_semanal: cycleAmountWords,
    valor_ciclo: cycleAmountWords,
    ciclo_cobranca: rental.cycle === 'monthly' ? 'Mensal' : 'Semanal',
    dia_vencimento: formatDueDay(rental.cycle, String(rental.due_day)),
    caucao: depositWords,

    data_inicio: formatDateExtensoPtBr(rental.start_date),
    data_fim: formatDateExtensoPtBr(rental.end_date),
    data_hoje: formatDateExtensoPtBr(today.toISOString().slice(0, 10)),

    nome_empresa: tenantName || '',
  }
}
