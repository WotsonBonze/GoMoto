import { test, expect } from '@playwright/test'
import { TEST_TAG, getSupabase, getSupabaseAdmin, getTestTenantId } from './helpers'

/**
 * P-6 (Spec 0014 §10.1) — isolamento por tenant nas tabelas do redesenho.
 *
 * A Spec 0014 §6 chama este teste de obrigatório para cada tabela nova. A RLS
 * existe e está habilitada, mas "habilitada" não é o mesmo que "correta": uma
 * política com `USING (true)`, um `GRANT` largo ou uma view sem
 * `security_invoker` deixam a RLS ligada e o dado exposto.
 *
 * Método: o service_role (que ignora RLS) semeia uma linha real em cada tabela
 * sob o tenant 2. Em seguida o cliente autenticado como **empresa01** (owner do
 * tenant 1, via anon key — o mesmo caminho do app) tenta ler, escrever, alterar
 * e apagar. Tudo deve dar em nada.
 *
 * Semear de verdade é o ponto: asserção de "não vejo nada" sobre tabela vazia
 * passa sozinha e não prova coisa alguma. Cada caso confirma antes, pelo admin,
 * que a linha existe.
 */

const TENANT_2 = '00000000-0000-0000-0000-000000000002'
const admin = () => getSupabaseAdmin()

/** IDs semeados no tenant 2, preenchidos no beforeAll. */
const seeded: Record<string, string> = {}
/** Linhas do tenant 2 que o cleanup consegue remover (ledger é imutável). */
const cleanup: { table: string; id: string }[] = []

async function seed(table: string, payload: Record<string, unknown>): Promise<string> {
  const { data, error } = await admin().from(table).insert(payload).select('id').single()
  if (error) throw new Error(`Setup falhou em ${table}: ${error.message}`)
  const id = (data as { id: string }).id
  seeded[table] = id
  return id
}

test.describe('Isolamento por tenant — tabelas do redesenho financeiro (Spec 0014 §6)', () => {
  test.beforeAll(async () => {
    const suffix = Date.now().toString(36)

    // ── Dependências do tenant 2 ────────────────────────────────────────────
    const customerId = await seed('customers', {
      tenant_id: TENANT_2, name: `${TEST_TAG} Cliente T2 ${suffix}`, in_queue: false,
    })
    cleanup.push({ table: 'customers', id: customerId })

    const vehicleId = await seed('vehicles', {
      tenant_id: TENANT_2, license_plate: `T2${suffix.slice(-5).toUpperCase()}`,
      // O default da coluna ('purchase') viola o próprio CHECK da tabela —
      // bug de schema pré-existente, o mesmo contornado em createTestVehicle().
      acquisition_type: 'used',
    })
    cleanup.push({ table: 'vehicles', id: vehicleId })

    const rentalId = await seed('rentals', {
      tenant_id: TENANT_2, customer_id: customerId, vehicle_id: vehicleId,
    })
    cleanup.push({ table: 'rentals', id: rentalId })

    // Par de controle no tenant 1: prova que o cliente autenticado enxerga o
    // que é dele. Sem ele, "não vejo nada" seria indistinguível de sessão morta.
    const { data: ctrl, error: ctrlErr } = await admin()
      .from('late_charge_policies')
      .insert({
        tenant_id: await getTestTenantId(), version: 98, effective_from: '2026-01-01',
        fee_type: 'percentage', fee_value: 0.01,
      })
      .select('id')
      .single()
    if (ctrlErr) throw new Error(`Setup falhou na política de controle: ${ctrlErr.message}`)
    seeded['policy_tenant1'] = (ctrl as { id: string }).id
    cleanup.push({ table: 'late_charge_policies', id: (ctrl as { id: string }).id })

    // ── Dimensões e política ────────────────────────────────────────────────
    cleanup.push({ table: 'late_charge_policies', id: await seed('late_charge_policies', { tenant_id: TENANT_2, version: 99, effective_from: '2026-01-01', fee_type: 'percentage', fee_value: 0.02 }) })
    cleanup.push({ table: 'delinquency_policies', id: await seed('delinquency_policies', { tenant_id: TENANT_2, version: 99, effective_from: '2026-01-01' }) })
    cleanup.push({ table: 'credit_policies', id: await seed('credit_policies', { tenant_id: TENANT_2, version: 99, effective_from: '2026-01-01' }) })
    cleanup.push({ table: 'tenant_account_mappings', id: await seed('tenant_account_mappings', { tenant_id: TENANT_2, version: 99, effective_from: '2026-01-01', account_code: 'repasse_multa', report_line_code: 'expense_recovery' }) })

    // ── Documentos ──────────────────────────────────────────────────────────
    // Numeração vem da mesma RPC que o app usa — `suffix` é base36 e não serve
    // como número de cobrança.
    const { data: chargeNumber } = await admin().rpc('fn_next_charge_number', { p_tenant_id: TENANT_2 })

    const chargeId = await seed('charges', {
      tenant_id: TENANT_2, customer_id: customerId, charge_number: chargeNumber as number, due_date: '2026-09-01',
      source_module: 'rental', source_id: rentalId,
    })
    cleanup.push({ table: 'charges', id: chargeId })

    cleanup.push({ table: 'charge_items', id: await seed('charge_items', {
      tenant_id: TENANT_2, charge_id: chargeId, description: `${TEST_TAG} Item T2`,
      credit_account_code: 'receita_locacao', quantity: 1, unit_amount: 100, amount: 100,
      source_module: 'rental', source_id: rentalId,
    }) })

    cleanup.push({ table: 'rental_billing_schedules', id: await seed('rental_billing_schedules', {
      tenant_id: TENANT_2, rental_id: rentalId, sequence_number: 1,
      period_start: '2026-09-01', period_end: '2026-09-30', due_date: '2026-09-01', amount: 100,
    }) })

    const paymentId = await seed('payments', {
      tenant_id: TENANT_2, customer_id: customerId, amount: 50, method: 'pix', paid_at: new Date().toISOString(),
    })
    cleanup.push({ table: 'payments', id: paymentId })

    cleanup.push({ table: 'payment_allocations', id: await seed('payment_allocations', {
      tenant_id: TENANT_2, payment_id: paymentId, charge_id: chargeId, amount: 50,
    }) })

    cleanup.push({ table: 'payables', id: await seed('payables', {
      tenant_id: TENANT_2, description: `${TEST_TAG} Payable T2`, expense_account_code: 'despesa_manutencao',
      competence_date: '2026-09-01', due_date: '2026-09-10', amount: 200, source_module: 'maintenance',
    }) })

    cleanup.push({ table: 'deposits', id: await seed('deposits', {
      tenant_id: TENANT_2, rental_id: rentalId, customer_id: customerId, amount: 300,
    }) })

    cleanup.push({ table: 'customer_credits', id: await seed('customer_credits', {
      tenant_id: TENANT_2, customer_id: customerId, amount: 25, origin: 'manual_adjustment', reason: `${TEST_TAG} crédito T2`,
    }) })


    // ── Gateway ─────────────────────────────────────────────────────────────
    const providerAccountId = await seed('payment_provider_accounts', {
      tenant_id: TENANT_2, provider: 'mercadopago', external_account_id: `acct_${suffix}`,
      account_label: 'loja-t2@teste.com',
    })
    cleanup.push({ table: 'payment_provider_accounts', id: providerAccountId })

    cleanup.push({ table: 'payment_intents', id: await seed('payment_intents', {
      tenant_id: TENANT_2, charge_id: chargeId, provider: 'mercadopago',
      provider_account_id: providerAccountId, method: 'pix', amount: 100,
    }) })

    cleanup.push({ table: 'gateway_events', id: await seed('gateway_events', {
      tenant_id: TENANT_2, provider: 'mercadopago', provider_event_id: `evt_${suffix}`,
      event_type: 'payment.updated', payload: { id: suffix }, signature_valid: true,
    }) })

    // ── Ledger (imutável: fica sem cleanup, por construção) ─────────────────
    const txId = await seed('financial_transactions', {
      tenant_id: TENANT_2, event_type: 'charge_issued', occurred_at: new Date().toISOString(),
      description: `${TEST_TAG} Transação T2`, source_module: 'e2e_tenant_isolation',
    })

    const { data: entries, error: entriesErr } = await admin()
      .from('financial_entries')
      .insert([
        // `charge_id` amarra o lançamento à cobrança semeada acima. Sem ele a
        // linha ficava órfã e `reconciliacao.spec.ts`, que varre o banco
        // inteiro, acusava resíduo de fixture como se fosse defeito real.
        { tenant_id: TENANT_2, transaction_id: txId, account_code: 'contas_a_receber', direction: 'debit',  amount: 100, charge_id: chargeId },
        { tenant_id: TENANT_2, transaction_id: txId, account_code: 'receita_locacao',  direction: 'credit', amount: 100, charge_id: chargeId },
      ])
      .select('id')
    if (entriesErr) throw new Error(`Setup falhou em financial_entries: ${entriesErr.message}`)
    seeded['financial_entries'] = (entries as { id: string }[])[0].id
  })

  test.afterAll(async () => {
    // Ordem inversa da criação: as FKs do financeiro são RESTRICT.
    //
    // Best-effort de propósito. Cobrança emitida e lançamento não são apagáveis
    // (Princípios 3 e 5), e o que os referencia — cliente, veículo, locação —
    // fica preso junto. Cada execução deixa esse resíduo no tenant 2; é o preço
    // de testar sobre dados reais em vez de mock, e não afeta as asserções,
    // que só olham os ids desta execução.
    for (const { table, id } of [...cleanup].reverse()) {
      await admin().from(table).delete().eq('id', id)
    }
  })

  // Tabelas novas do redesenho que carregam dado de tenant.
  const TABELAS = [
    'financial_transactions', 'financial_entries',
    'charges', 'charge_items', 'rental_billing_schedules',
    'payments', 'payment_allocations', 'payables',
    'deposits', 'customer_credits', 'tenant_account_mappings',
    'late_charge_policies', 'delinquency_policies', 'credit_policies',
    'payment_provider_accounts', 'payment_intents', 'gateway_events',
  ] as const

  for (const tabela of TABELAS) {
    test(`${tabela} — tenant 1 não lê, altera nem apaga linha do tenant 2`, async () => {
      const sb = await getSupabase() // empresa01 (tenant 1), anon key + RLS
      const id = seeded[tabela]

      expect(id, `setup não semeou ${tabela}`).toBeTruthy()

      // A linha existe de fato — sem isto, tudo abaixo passaria a seco.
      const { data: existe } = await admin().from(tabela).select('id').eq('id', id).maybeSingle()
      expect(existe, `linha semeada em ${tabela} sumiu antes da asserção`).not.toBeNull()

      // LEITURA — nem por id, nem varrendo por tenant_id.
      const { data: porId } = await sb.from(tabela).select('id').eq('id', id)
      expect(porId ?? [], `${tabela}: vazou leitura por id`).toEqual([])

      const { data: porTenant } = await sb.from(tabela).select('id').eq('tenant_id', TENANT_2)
      expect(porTenant ?? [], `${tabela}: vazou varredura por tenant_id`).toEqual([])

      // UPDATE — RLS devolve 0 linhas afetadas em vez de erro.
      const { data: atualizadas } = await sb.from(tabela).update({ tenant_id: TENANT_2 }).eq('id', id).select('id')
      expect(atualizadas ?? [], `${tabela}: UPDATE cruzou a fronteira`).toEqual([])

      // DELETE — idem.
      const { data: apagadas } = await sb.from(tabela).delete().eq('id', id).select('id')
      expect(apagadas ?? [], `${tabela}: DELETE cruzou a fronteira`).toEqual([])

      // A linha do outro tenant continua intacta.
      const { data: depois } = await admin().from(tabela).select('id').eq('id', id).maybeSingle()
      expect(depois, `${tabela}: linha do tenant 2 foi destruída`).not.toBeNull()
    })
  }

  test('controle: o mesmo cliente enxerga o próprio tenant', async () => {
    // Sem esta asserção o spec inteiro é decorativo: um cliente não autenticado
    // lê vazio em tudo e faria os 20 casos acima passarem sem RLS nenhuma.
    // Aqui o mesmo cliente, na mesma tabela, tem que ver a linha do seu tenant.
    const sb = await getSupabase()
    const tenant1 = await getTestTenantId()

    expect(tenant1).not.toBe(TENANT_2)

    const { data, error } = await sb.from('late_charge_policies').select('id, tenant_id').eq('id', seeded['policy_tenant1'])

    expect(error, error?.message).toBeNull()
    expect(data ?? [], 'cliente autenticado não vê nem o próprio tenant — as demais asserções não provam nada').toHaveLength(1)
    expect((data as { tenant_id: string }[])[0].tenant_id).toBe(tenant1)
  })

  test('INSERT carimbando tenant alheio é recusado', async () => {
    const sb = await getSupabase()

    // O caminho de ataque mais direto: forjar tenant_id no payload. É por isso
    // que o app resolve o tenant server-side via getCurrentTenantId() — aqui a
    // barreira do banco é verificada de forma independente.
    const { data, error } = await sb
      .from('late_charge_policies')
      .insert({
        tenant_id: TENANT_2, version: 97, effective_from: '2026-01-01',
        fee_type: 'percentage', fee_value: 0.01,
      })
      .select('id')

    expect(error, 'INSERT com tenant alheio deveria ser recusado pela RLS').not.toBeNull()
    expect(data).toBeNull()
  })

  test('NENHUMA view com tenant_id vaza dado de outro tenant', async () => {
    const sb = await getSupabase()
    const tenant1 = await getTestTenantId()

    // A lista de views era escrita à mão aqui — e foi exatamente por isso que o
    // furo passou: seis views novas nasceram sem `security_invoker`, ninguém
    // lembrou de acrescentá-las, e o teste seguiu verde.
    //
    // View no Postgres executa com os direitos do DONO. Como as deste schema
    // pertencem ao superusuário, sem `security_invoker = true` a RLS
    // simplesmente não se aplica: qualquer usuário autenticado lê a carteira
    // inteira, de todos os tenants. A tela filtrar por `tenant_id` não protege
    // nada — basta omitir o filtro em um lugar.
    //
    // Agora o teste DESCOBRE as views. Qualquer uma criada daqui em diante
    // entra na varredura sem ninguém precisar lembrar.
    const { data: views, error: viewsError } = await getSupabaseAdmin()
      .from('schema_view_security')
      .select('view_name')
      .eq('has_tenant_id', true)
      .order('view_name')

    expect(viewsError, `introspecção falhou: ${viewsError?.message}`).toBeNull()

    const nomes = ((views ?? []) as { view_name: string }[]).map((v) => v.view_name)
    expect(nomes.length, 'nenhuma view encontrada — o teste não provaria nada').toBeGreaterThan(5)

    for (const view of nomes) {
      const { data, error } = await sb.from(view).select('tenant_id')
      expect(error, `${view}: ${error?.message}`).toBeNull()

      const alheias = ((data ?? []) as { tenant_id: string }[]).filter((r) => r.tenant_id !== tenant1)
      expect(alheias, `${view} devolveu linha de outro tenant`).toEqual([])
    }
  })

  test('toda view do schema declara security_invoker', async () => {
    // Verificação estrutural, complementar à de dados acima: uma view nova pode
    // não ter linha de outro tenant HOJE no banco de teste e ainda assim estar
    // aberta. Aqui a ausência da opção já reprova.
    const { data, error } = await getSupabaseAdmin()
      .from('schema_view_security')
      .select('view_name')
      .eq('security_invoker', false)
      .order('view_name')

    expect(error, `introspecção falhou: ${error?.message}`).toBeNull()

    const abertas = ((data ?? []) as { view_name: string }[]).map((v) => v.view_name)
    expect(abertas, 'view sem security_invoker ignora RLS e vaza entre tenants').toEqual([])
  })

  test('credencial do gateway não é legível por usuário autenticado', async () => {
    // A credencial saiu da tabela e vive no Vault; a leitura passa por
    // `fn_provider_credentials`, que é SECURITY DEFINER e por isso IGNORA RLS.
    //
    // A garantia mudou de lugar na ADR 0034 e ficou MAIS FORTE. Antes, a
    // função atendia `authenticated` e a checagem de tenant lá dentro é que
    // barrava a leitura cruzada — o que deixava um `viewer` lendo o token da
    // PRÓPRIA empresa, e com ele se movimenta dinheiro. Agora `authenticated`
    // não tem EXECUTE nenhum: a recusa acontece antes de a função rodar.
    //
    // Por isso a asserção é sobre o CÓDIGO e não sobre a mensagem. As duas
    // camadas recusam com 42501 (`insufficient_privilege`) — o grant e o
    // `RAISE` interno —, e o teste não deve depender de qual delas atendeu
    // primeiro.
    const contaAlheia = seeded['payment_provider_accounts']

    // Semear um segredo DE VERDADE é o que dá sentido ao teste: sem credencial
    // gravada a função devolveria null para qualquer um, e a asserção passaria
    // sem nenhuma checagem de tenant existir.
    const { error: seedErr } = await admin().rpc('fn_store_provider_credentials', {
      p_account_id:    contaAlheia,
      p_access_token:  'APP_USR-segredo-do-tenant-2',
      p_refresh_token: 'TG-refresh-t2',
    })
    expect(seedErr, seedErr?.message).toBeNull()

    // Controle: o backend confiável enxerga, então há o que vazar.
    const { data: comoAdmin } = await admin().rpc('fn_provider_credentials', { p_account_id: contaAlheia })
    expect((comoAdmin as { access_token?: string } | null)?.access_token).toBe('APP_USR-segredo-do-tenant-2')

    const sb = await getSupabase()
    const { data, error } = await sb.rpc('fn_provider_credentials', {
      p_account_id: contaAlheia,
    })

    // O que não pode, em hipótese nenhuma, é devolver o segredo.
    expect(data ?? null, 'credencial foi devolvida a um autenticado').toBeNull()
    expect(error, 'a leitura deveria ser recusada').not.toBeNull()
    expect(error!.code, `recusa deveria ser por privilégio, veio: ${error!.message}`).toBe('42501')
  })

  test('a credencial não é selecionável junto com a linha', async () => {
    // O ponto de tirar o token da tabela: nenhum SELECT amplo — nem log de
    // linha, nem dump — carrega o segredo junto.
    const colunas = await admin()
      .from('payment_provider_accounts')
      .select('*')
      .eq('id', seeded['payment_provider_accounts'])
      .single()

    const linha = colunas.data as Record<string, unknown>
    expect(Object.keys(linha)).not.toContain('credentials')
    expect(JSON.stringify(linha)).not.toMatch(/APP_USR|access_token/)
  })
})
