import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  resolveContractVariables, buildSampleData, substituteVariables, TEMPLATE_VARIABLES,
  warnMissingContractFields, CONTRACT_VEHICLE_FIELDS,
} from './contract-variables'

const baseInput = {
  customer: {
    name: 'João Silva Santos',
    cpf: '12345678900',
    rg: '12.488.178',
    drivers_license: '00123456789',
    drivers_license_category: 'AB',
    street: 'Rua das Flores',
    street_number: '123',
    complement: null,
    neighborhood: 'Centro',
    city: 'Rio de Janeiro',
    state: 'RJ',
    zip_code: '20040020',
  },
  vehicle: {
    make: 'Honda',
    model: 'CG 160 Start',
    year_manufacture: '2024',
    year_model: '2025',
    renavam: '00123456789',
    license_plate: 'ABC1D23',
    chassis: '9C2JC4110SR500001',
    color: 'Vermelho',
    fuel: 'Flex',
    km_current: 12540,
    registered_owner_name: 'GoMoto Locações LTDA',
    registered_owner_document: '12345678000190',
  },
  rental: {
    cycle: 'monthly' as const,
    due_day: 10,
    cycle_amount: 350,
    start_date: '2026-07-01',
    end_date: '2026-09-30',
    security_deposit: 1000,
  },
  tenantName: 'GoMoto Locações LTDA',
  today: new Date('2026-07-06T12:00:00'),
}

describe('resolveContractVariables', () => {
  it('resolve todas as chaves de cliente', () => {
    const vars = resolveContractVariables(baseInput)
    expect(vars.nome_cliente).toBe('João Silva Santos')
    expect(vars.cpf_cliente).toBe('123.456.789-00')
    expect(vars.rg_cliente).toBe('12.488.178')
    expect(vars.cnh_cliente).toBe('00123456789')
    expect(vars.categoria_cnh).toBe('AB')
    expect(vars.endereco_cliente).toBe('Rua das Flores, 123, Bairro Centro, Rio de Janeiro — RJ, 20040-020')
    expect(vars.cep_cliente).toBe('20040-020')
  })

  it('resolve todas as chaves de veículo', () => {
    const vars = resolveContractVariables(baseInput)
    expect(vars.marca_veiculo).toBe('Honda')
    expect(vars.modelo_veiculo).toBe('Honda CG 160 Start')
    expect(vars.ano_fabricacao_veiculo).toBe('2024')
    expect(vars.ano_modelo_veiculo).toBe('2025')
    expect(vars.ano_fab_mod_veiculo).toBe('2024/2025')
    expect(vars.renavam_veiculo).toBeTruthy()
    expect(vars.placa_veiculo).toBe('ABC1D23')
    expect(vars.chassi_veiculo).toBe('9C2JC4110SR500001')
    expect(vars.cor_veiculo).toBe('Vermelho')
    expect(vars.combustivel_veiculo).toBe('Flex')
    expect(vars.km_inicial).toBe('12.540')
    expect(vars.proprietario_veiculo).toBe('GoMoto Locações LTDA')
    expect(vars.documento_proprietario_veiculo).toBe('12.345.678/0001-90')
  })

  it('resolve valores financeiros e datas', () => {
    const vars = resolveContractVariables(baseInput)
    expect(vars.valor_ciclo).toBe('350,00 (trezentos e cinquenta reais)')
    expect(vars.valor_semanal).toBe(vars.valor_ciclo)
    expect(vars.ciclo_cobranca).toBe('Mensal')
    expect(vars.dia_vencimento).toBe('Dia 10')
    expect(vars.caucao).toBe('1.000,00 (mil reais)')
    expect(vars.data_inicio).toBe('1 de julho de 2026')
    expect(vars.data_fim).toBe('30 de setembro de 2026')
    expect(vars.data_hoje).toBe('6 de julho de 2026')
    expect(vars.nome_empresa).toBe('GoMoto Locações LTDA')
  })

  it('sem caução → "Não há caução"', () => {
    const vars = resolveContractVariables({ ...baseInput, rental: { ...baseInput.rental, security_deposit: null } })
    expect(vars.caucao).toBe('Não há caução')
  })

  // Spec 0014, RF-004: km_inicial precisa vir da LOCAÇÃO (congelado na
  // entrega), não do veículo (mutável — muda a cada km rodado depois da
  // entrega, o que fazia o PDF reimpresso mudar de km sozinho).
  it('km_inicial usa rental.km_initial quando presente, mesmo diferente do km atual do veículo', () => {
    const vars = resolveContractVariables({
      ...baseInput,
      vehicle: { ...baseInput.vehicle, km_current: 20000 },
      rental: { ...baseInput.rental, km_initial: 12540 },
    })
    expect(vars.km_inicial).toBe('12.540')
  })

  // Locação anterior a esta feature: km_initial é null no banco. Sem
  // fallback, o contrato reimpresso sairia sem km — melhor exibir o km atual
  // do veículo, como sempre exibiu, do que exibir vazio.
  it('km_inicial cai no km atual do veículo quando rental.km_initial é null/ausente', () => {
    const vars = resolveContractVariables({
      ...baseInput,
      vehicle: { ...baseInput.vehicle, km_current: 20000 },
      rental: { ...baseInput.rental, km_initial: null },
    })
    expect(vars.km_inicial).toBe('20.000')
  })

  it('ciclo semanal usa nome do dia da semana', () => {
    const vars = resolveContractVariables({
      ...baseInput,
      rental: { ...baseInput.rental, cycle: 'weekly', due_day: 5 },
    })
    expect(vars.ciclo_cobranca).toBe('Semanal')
    expect(vars.dia_vencimento).toBe('Sexta-feira')
  })

  it('toda chave do catálogo TEMPLATE_VARIABLES é coberta pelo resolver ou por buildSampleData', () => {
    const resolved = resolveContractVariables(baseInput)
    const sample = buildSampleData()
    for (const v of TEMPLATE_VARIABLES) {
      expect(Object.prototype.hasOwnProperty.call(resolved, v.key)).toBe(true)
      expect(Object.prototype.hasOwnProperty.call(sample, v.key)).toBe(true)
    }
  })
})

describe('substituteVariables', () => {
  it('substitui {{chave}} e preserva placeholders desconhecidos', () => {
    const html = '<p>{{nome_cliente}} — {{chave_inexistente}}</p>'
    expect(substituteVariables(html, { nome_cliente: 'Ana' })).toBe('<p>Ana — {{chave_inexistente}}</p>')
  })
})

describe('warnMissingContractFields', () => {
  const originalEnv = process.env.NODE_ENV

  afterEach(() => {
    vi.restoreAllMocks()
    process.env.NODE_ENV = originalEnv
  })

  it('avisa quando uma coluna esperada não veio no registro (fora de produção)', () => {
    process.env.NODE_ENV = 'development'
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { registered_owner_name, ...vehicleWithoutOwner } = baseInput.vehicle as Record<string, unknown>
    warnMissingContractFields('vehicle', vehicleWithoutOwner, CONTRACT_VEHICLE_FIELDS)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toContain('registered_owner_name')
  })

  it('não avisa quando todas as colunas estão presentes (mesmo com valor null)', () => {
    process.env.NODE_ENV = 'development'
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    warnMissingContractFields('vehicle', { ...baseInput.vehicle, registered_owner_name: null }, CONTRACT_VEHICLE_FIELDS)
    expect(warn).not.toHaveBeenCalled()
  })

  it('não avisa em produção mesmo faltando coluna', () => {
    process.env.NODE_ENV = 'production'
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    warnMissingContractFields('vehicle', {}, CONTRACT_VEHICLE_FIELDS)
    expect(warn).not.toHaveBeenCalled()
  })
})
