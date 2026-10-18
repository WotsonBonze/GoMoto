/**
 * Retorno do investimento de UM veículo, por dinheiro (PRD 0008, RN-040 a RN-045).
 *
 *   investido  = aquisição + despesas lançadas (não canceladas)
 *   recuperado = dinheiro recebido das locações + valor de venda (se alienado)
 *   payback    = primeiro mês em que recuperado ≥ investido
 *
 * A parte do cliente numa despesa entra em `investido` (a empresa desembolsa) e
 * volta em `recuperado` quando o cliente paga a cobrança de repasse — o saldo
 * fecha sem precisar separar o repasse dentro do que foi recebido.
 *
 * Função pura: recebe datas e valores já lidos, não faz I/O nem lê o relógio.
 */

export type DatedAmount = {
  /** 'YYYY-MM-DD' ou timestamp ISO — só o mês (UTC) importa. */
  date: string
  amount: number
}

export type VehiclePaybackInput = {
  /** 0 quando o valor de aquisição não foi cadastrado. */
  acquisition_amount: number
  /** 0 quando o veículo não foi vendido. */
  sale_amount: number
  /** 'YYYY-MM-DD'. Sem data, a venda conta no último mês da série. */
  sold_on: string | null
  /** Início mais antigo conhecido do veículo. */
  start_date: string
  /** 'YYYY-MM-DD' — injetado para a função continuar pura. */
  today: string
  receipts: DatedAmount[]
  expenses: DatedAmount[]
}

export type VehiclePaybackPoint = {
  /** 'YYYY-MM' */
  month: string
  received: number
  expenses: number
  /** Acumulado até o fim do mês. */
  invested: number
  recovered: number
}

export type VehiclePayback = {
  points: VehiclePaybackPoint[]
  invested_total: number
  recovered_total: number
  /** Quanto falta para recuperar o investido; 0 quando já recuperou. */
  remaining: number
  /** Ganho acima do investido; 0 antes do payback. */
  profit: number
  /** recuperado / investido, limitado a 100. null sem aquisição cadastrada. */
  progress_pct: number | null
  /** (recuperado − investido) / aquisição, em %. null sem aquisição (RN-044). */
  roi_pct: number | null
  /** Primeiro mês com recuperado ≥ investido. null se ainda não pagou. */
  reached_month: string | null
}

const MAX_MONTHS = 600

export function monthOf(date: string): string {
  return date.slice(0, 7)
}

export function nextMonth(month: string): string {
  const [y, m] = month.split('-').map(Number)
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`
}

export function calculateVehiclePayback(input: VehiclePaybackInput): VehiclePayback {
  const received = new Map<string, number>()
  const expenses = new Map<string, number>()
  for (const r of input.receipts) add(received, monthOf(r.date), r.amount)
  for (const e of input.expenses) add(expenses, monthOf(e.date), e.amount)

  let start = monthOf(input.start_date)
  let end = monthOf(input.today)
  for (const key of [...received.keys(), ...expenses.keys()]) {
    if (key < start) start = key
    if (key > end) end = key
  }
  if (input.sold_on) {
    const sold = monthOf(input.sold_on)
    if (sold > end) end = sold
  }

  const months: string[] = []
  for (let m = start; months.length < MAX_MONTHS; m = nextMonth(m)) {
    months.push(m)
    if (m === end) break
  }

  const soldMonth = input.sold_on ? monthOf(input.sold_on) : end
  let cumReceived = 0
  let cumExpenses = 0
  const points: VehiclePaybackPoint[] = months.map((month) => {
    const r = received.get(month) ?? 0
    const e = expenses.get(month) ?? 0
    cumReceived += r
    cumExpenses += e
    const sale = input.sale_amount > 0 && month >= soldMonth ? input.sale_amount : 0
    return {
      month,
      received: round2(r),
      expenses: round2(e),
      invested: round2(input.acquisition_amount + cumExpenses),
      recovered: round2(cumReceived + sale),
    }
  })

  const investedTotal = round2(input.acquisition_amount + cumExpenses)
  const recoveredTotal = round2(cumReceived + (input.sale_amount > 0 ? input.sale_amount : 0))
  const hasAcquisition = input.acquisition_amount > 0
  const reached = hasAcquisition ? points.find((p) => p.recovered >= p.invested) : undefined

  return {
    points,
    invested_total: investedTotal,
    recovered_total: recoveredTotal,
    remaining: round2(Math.max(0, investedTotal - recoveredTotal)),
    profit: round2(Math.max(0, recoveredTotal - investedTotal)),
    progress_pct: hasAcquisition && investedTotal > 0
      ? round2(Math.min(100, (recoveredTotal / investedTotal) * 100))
      : null,
    roi_pct: hasAcquisition
      ? round2(((recoveredTotal - investedTotal) / input.acquisition_amount) * 100)
      : null,
    reached_month: reached?.month ?? null,
  }
}

function add(map: Map<string, number>, key: string, value: number) {
  map.set(key, (map.get(key) ?? 0) + value)
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
