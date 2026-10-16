import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { generateTextMock } = vi.hoisted(() => ({ generateTextMock: vi.fn() }))

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>()
  return { ...actual, generateText: generateTextMock }
})

const { extractFields, EXTRACTION_TIMEOUT_MS } = await import('./extract')
const { isMockEnabled } = await import('./mock')

function makeFile(name = 'cnh.pdf', type = 'application/pdf'): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type })
}

beforeEach(() => {
  generateTextMock.mockReset()
  // Fora de produção a simulação é o PADRÃO. Estes testes exercitam o caminho
  // real — o dispatch para o provedor —, então pedem explicitamente por ele.
  process.env.DOCUMENT_EXTRACTION_REAL = '1'
})

afterEach(() => {
  delete process.env.DOCUMENT_EXTRACTION_REAL
})

describe('extractFields — dispatch do registry', () => {
  it('chama generateText com o model, timeout e prompt de CNH corretos', async () => {
    generateTextMock.mockResolvedValue({
      output: {
        name: { value: 'João', confidence: 'high' },
        cpf: { value: '12345678901', confidence: 'high' },
        rg: { value: null, confidence: 'low' },
        birth_date: { value: '1990-01-01', confidence: 'high' },
        drivers_license: { value: '123', confidence: 'high' },
        drivers_license_category: { value: 'AB', confidence: 'high' },
        drivers_license_validity: { value: '2030-01-01', confidence: 'high' },
      },
    })

    await extractFields('cnh', makeFile())

    expect(generateTextMock).toHaveBeenCalledTimes(1)
    const call = generateTextMock.mock.calls[0][0]
    expect(call.model).toBe('google/gemini-2.5-flash')
    expect(call.timeout).toBe(EXTRACTION_TIMEOUT_MS)
    expect(call.temperature).toBe(0)
    expect(call.messages[0].content[0].text).toContain('CNH')
    expect(call.messages[0].content[1]).toMatchObject({ type: 'file', mediaType: 'application/pdf' })
  })

  it('inclui providerOptions.gateway.disallowPromptTraining em toda chamada (RNF-005)', async () => {
    generateTextMock.mockResolvedValue({
      output: {
        license_plate: { value: 'ABC1234', confidence: 'high' },
        description: { value: 'x', confidence: 'high' },
        infraction_date: { value: '2026-01-01', confidence: 'high' },
        amount: { value: 100, confidence: 'high' },
        ait_number: { value: null, confidence: 'low' },
        infraction_location: { value: null, confidence: 'low' },
        renainf_number: { value: null, confidence: 'low' },
        notification_date: { value: null, confidence: 'low' },
        prior_defense_deadline: { value: null, confidence: 'low' },
        driver_identification_deadline: { value: null, confidence: 'low' },
        senatran_infraction_code: { value: null, confidence: 'low' },
        senatran_infraction_subcode: { value: null, confidence: 'low' },
        issuing_agency_name: { value: null, confidence: 'low' },
        issuing_agency_code: { value: null, confidence: 'low' },
        competent_agency_code: { value: null, confidence: 'low' },
        competent_agency_name: { value: null, confidence: 'low' },
        driver_name: { value: null, confidence: 'low' },
        driver_cnh: { value: null, confidence: 'low' },
        driver_cpf: { value: null, confidence: 'low' },
        driver_document: { value: null, confidence: 'low' },
        infraction_time: { value: null, confidence: 'low' },
        measurement_instrument_id: { value: null, confidence: 'low' },
        traffic_agent_id: { value: null, confidence: 'low' },
        measured_speed: { value: null, confidence: 'low' },
        considered_speed: { value: null, confidence: 'low' },
        speed_limit: { value: null, confidence: 'low' },
        original_renainf_number: { value: null, confidence: 'low' },
        infraction_municipality_code: { value: null, confidence: 'low' },
        infraction_municipality_name: { value: null, confidence: 'low' },
        infraction_state: { value: null, confidence: 'low' },
        senatran_message: { value: null, confidence: 'low' },
      },
    })

    await extractFields('fine_notice', makeFile('multa.pdf'))

    const call = generateTextMock.mock.calls[0][0]
    expect(call.providerOptions.gateway.disallowPromptTraining).toBe(true)
    // Vertex lê PDF com menos detalhe (categoria/CPF errados) — rota fixa no AI Studio.
    expect(call.providerOptions.gateway.only).toEqual(['google'])
  })

  it('calcula fieldsFound/fieldsTotal a partir de um resultado com campos nulos (RF-005)', async () => {
    generateTextMock.mockResolvedValue({
      output: {
        name: { value: 'João', confidence: 'high' },
        cpf: { value: null, confidence: 'low' },
        rg: { value: null, confidence: 'low' },
        birth_date: { value: '1990-01-01', confidence: 'high' },
        drivers_license: { value: null, confidence: 'low' },
        drivers_license_category: { value: null, confidence: 'low' },
        drivers_license_validity: { value: null, confidence: 'low' },
      },
    })

    const result = await extractFields('cnh', makeFile())

    expect(result).not.toBeNull()
    expect(result!.fieldsTotal).toBe(7)
    expect(result!.fieldsFound).toBe(2)
  })

  it('aplica o pós-processamento da CNH (normaliza e rebaixa o que não confere)', async () => {
    generateTextMock.mockResolvedValue({
      output: {
        name: { value: 'João', confidence: 'high' },
        cpf: { value: '529.982.247-25', confidence: 'high' },
        rg: { value: '254954811 DETRAN RJ', confidence: 'high' },
        birth_date: { value: '1990-01-01', confidence: 'high' },
        // 10 dígitos: o Nº do espelho lido no lugar do registro.
        drivers_license: { value: '2408149527', confidence: 'high' },
        drivers_license_category: { value: 'B', confidence: 'high' },
        drivers_license_validity: { value: '2030-01-01', confidence: 'high' },
      },
    })

    const result = await extractFields('cnh', makeFile())

    expect(result!.fields.cpf).toEqual({ value: '52998224725', confidence: 'high' })
    expect(result!.fields.rg).toEqual({ value: '254954811', confidence: 'high' })
    expect(result!.fields.drivers_license).toEqual({ value: '2408149527', confidence: 'low' })
  })
})

describe('extractFields — falhas (RNF-001/CA-010)', () => {
  it('timeout do provedor → retorna null, nunca lança exceção', async () => {
    generateTextMock.mockRejectedValue(new Error('timed out'))

    await expect(extractFields('cnh', makeFile())).resolves.toBeNull()
  })

  it('erro do provedor → retorna null', async () => {
    generateTextMock.mockRejectedValue(new Error('provider error'))

    await expect(extractFields('fine_notice', makeFile('multa.pdf'))).resolves.toBeNull()
  })
})

describe('extractFields — simulação por padrão fora de produção', () => {
  beforeEach(() => {
    // Sem a variável: é o estado normal de quem roda `pnpm dev` ou a suíte E2E
    // sem lembrar de configurar nada.
    delete process.env.DOCUMENT_EXTRACTION_REAL
  })

  it('não chama o provedor real quando ninguém pede pelo real', async () => {
    const result = await extractFields('cnh', makeFile())

    expect(generateTextMock).not.toHaveBeenCalled()
    expect(result?.documentType).toBe('cnh')
  })

  it('arquivo "mock-fail" simula falha do provedor', async () => {
    const result = await extractFields('cnh', makeFile('cnh-mock-fail.pdf'))

    expect(result).toBeNull()
  })

  it('PRODUÇÃO nunca simula, mesmo com a variável setada por engano', async () => {
    // O modo de falha aqui seria cadastrar cliente com o CPF fixo do fixture.
    // Não pode depender de disciplina de configuração no deploy.
    // `vi.stubEnv` porque `process.env.NODE_ENV` é somente-leitura sob vitest e
    // `Object.defineProperty` recusa o descritor.
    vi.stubEnv('NODE_ENV', 'production')
    try {
      expect(isMockEnabled()).toBe(false)

      vi.stubEnv('DOCUMENT_EXTRACTION_REAL', '0')
      expect(isMockEnabled(), 'produção simulou extração').toBe(false)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('DOCUMENT_EXTRACTION_REAL=1 devolve o caminho real', async () => {
    process.env.DOCUMENT_EXTRACTION_REAL = '1'
    expect(isMockEnabled()).toBe(false)
  })
})
