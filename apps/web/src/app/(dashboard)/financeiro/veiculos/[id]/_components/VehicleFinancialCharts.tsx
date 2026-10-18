'use client'

import {
  Area,
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { formatCurrency } from '@gomoto/core'

// ─── Tipos ──────────────────────────────────────────────────────────────────

export interface MonthlyPoint {
  monthKey: string
  label: string
  /** Dinheiro recebido no mês. */
  received: number
  /** Despesas do mês (custo bruto, por competência). */
  expenses: number
  /** Acumulado: aquisição + despesas pagas pela empresa. */
  investment: number
  /** Acumulado: recebido (+ venda, a partir do mês da venda). */
  recovered: number
}

export interface CostCategory {
  code: string
  label: string
  amount: number
}

// ─── Estilo compartilhado (tokens de tema — ver DashboardCharts.tsx) ────────
// Paleta da tela: verde = recebido, âmbar = despesa, vermelho = só atraso,
// azul = a receber / parte do cliente.

const CHART_HEIGHT = 220

const axisTickStyle = { fill: 'var(--fg-mute)', fontSize: 11 }

const tooltipStyle = {
  backgroundColor: 'var(--surface-2)',
  border: '1px solid var(--border)',
  borderRadius: '8px',
  fontSize: '12px',
}

const tooltipLabelStyle = { color: 'var(--fg)', fontWeight: 'bold' as const }
const tooltipItemStyle = { color: 'var(--fg-mute)' }
const legendStyle = { fontSize: 12, color: 'var(--fg-mute)' }

function formatCurrencyShort(value: number) {
  if (Math.abs(value) >= 1000) return `R$${Math.round(value / 1000)}k`
  return `R$${Math.round(value)}`
}

// Recharts tipa o valor do tooltip como `ValueType` (pode vir string/array);
// aqui é sempre número, então normaliza antes de formatar.
function tooltipCurrency(value: unknown): string {
  return formatCurrency(Number(value) || 0)
}

// Muitos meses no ar (rent-to-own chega a 2 anos): mostra só uma marca a cada
// N para o eixo não virar uma parede de texto ilegível.
function tickInterval(length: number) {
  return length > 12 ? Math.ceil(length / 8) : 0
}

// ─── Evolução: investimento × recuperado ─────────────────────────────────────

export function VehiclePaybackChart({ monthly }: { monthly: MonthlyPoint[] }) {
  return (
    <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
      <ComposedChart data={monthly} margin={{ left: 4, right: 8, top: 8 }}>
        <defs>
          <linearGradient id="colorRecovered" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="var(--success)" stopOpacity={0.22} />
            <stop offset="95%" stopColor="var(--success)" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke="var(--border)" vertical={false} />
        <XAxis
          dataKey="label"
          tick={axisTickStyle}
          axisLine={false}
          tickLine={false}
          interval={tickInterval(monthly.length)}
        />
        <YAxis tickFormatter={formatCurrencyShort} tick={axisTickStyle} axisLine={false} tickLine={false} />
        <Tooltip
          contentStyle={tooltipStyle}
          labelStyle={tooltipLabelStyle}
          itemStyle={tooltipItemStyle}
          formatter={(value, name) => [tooltipCurrency(value), name]}
        />
        <Legend wrapperStyle={legendStyle} />
        <Area
          type="monotone"
          dataKey="recovered"
          name="Recuperado"
          stroke="var(--success)"
          fill="url(#colorRecovered)"
          strokeWidth={2}
        />
        <Line
          type="monotone"
          dataKey="investment"
          name="Investimento"
          stroke="var(--fg-mute)"
          strokeDasharray="5 4"
          strokeWidth={2}
          dot={false}
        />
      </ComposedChart>
    </ResponsiveContainer>
  )
}

// ─── Recebido × despesas por mês ─────────────────────────────────────────────

export function VehicleMonthlyChart({ monthly }: { monthly: MonthlyPoint[] }) {
  return (
    <div className="rounded-2xl border border-border bg-surface p-5">
      <div className="mb-4">
        <h3 className="text-[15px] font-bold text-fg">Entrada × Saída por mês</h3>
        <p className="text-[12px] text-fg-mute">Da moto, sem multas e custos repassados ao cliente: entrada pela data do pagamento, saída pela competência</p>
      </div>

      <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
        <BarChart data={monthly} margin={{ left: 4, right: 8, top: 8 }} barGap={2}>
          <CartesianGrid stroke="var(--border)" vertical={false} />
          <XAxis
            dataKey="label"
            tick={axisTickStyle}
            axisLine={false}
            tickLine={false}
            interval={tickInterval(monthly.length)}
          />
          <YAxis tickFormatter={formatCurrencyShort} tick={axisTickStyle} axisLine={false} tickLine={false} />
          <Tooltip
            contentStyle={tooltipStyle}
            labelStyle={tooltipLabelStyle}
            itemStyle={tooltipItemStyle}
            formatter={(value, name) => [tooltipCurrency(value), name]}
            cursor={{ fill: 'var(--surface-2)' }}
          />
          <Legend wrapperStyle={legendStyle} />
          <Bar dataKey="received" name="Entrada" fill="var(--success)" radius={[4, 4, 0, 0]} maxBarSize={28} />
          <Bar dataKey="expenses" name="Saída" fill="var(--warning)" radius={[4, 4, 0, 0]} maxBarSize={28} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

// ─── Composição das entradas e das despesas ──────────────────────────────────
// Mesmo desenho para as duas, cor oposta (verde entra, âmbar sai) — o par
// ensina de onde vem o dinheiro e para onde ele foi com um único vocabulário
// visual.

function CategoryBreakdownChart({
  title,
  subtitle,
  data,
  color,
  tooltipLabel,
}: {
  title: string
  subtitle: string
  data: CostCategory[]
  color: string
  tooltipLabel: string
}) {
  if (data.length === 0) return null

  const height = Math.max(120, data.length * 36)

  return (
    <div className="rounded-2xl border border-border bg-surface p-5">
      <div className="mb-4">
        <h3 className="text-[15px] font-bold text-fg">{title}</h3>
        <p className="text-[12px] text-fg-mute">{subtitle}</p>
      </div>

      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={data} layout="vertical" margin={{ left: 8, right: 24 }}>
          <CartesianGrid stroke="var(--border)" horizontal={false} />
          <XAxis type="number" tickFormatter={formatCurrencyShort} tick={axisTickStyle} axisLine={false} tickLine={false} />
          <YAxis
            type="category"
            dataKey="label"
            tick={{ fill: 'var(--fg-soft)', fontSize: 12 }}
            axisLine={false}
            tickLine={false}
            width={140}
          />
          <Tooltip
            contentStyle={tooltipStyle}
            labelStyle={tooltipLabelStyle}
            itemStyle={tooltipItemStyle}
            formatter={(value) => [tooltipCurrency(value), tooltipLabel]}
            cursor={{ fill: 'var(--surface-2)' }}
          />
          <Bar dataKey="amount" name={tooltipLabel} fill={color} radius={[0, 4, 4, 0]} maxBarSize={18} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

export function VehicleIncomeBreakdownChart({ incomeBreakdown }: { incomeBreakdown: CostCategory[] }) {
  return (
    <CategoryBreakdownChart
      title="Composição das entradas"
      subtitle="Recebido da moto e repasse devolvido, por categoria"
      data={incomeBreakdown}
      color="var(--success)"
      tooltipLabel="Recebido"
    />
  )
}

export function VehicleCostBreakdownChart({ costBreakdown }: { costBreakdown: CostCategory[] }) {
  return (
    <CategoryBreakdownChart
      title="Composição das despesas"
      subtitle="Total por categoria, inclusive o que é repassado ao cliente"
      data={costBreakdown}
      color="var(--warning)"
      tooltipLabel="Despesa"
    />
  )
}
