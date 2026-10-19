export function fmt(d: string | null | undefined) {
  if (!d) return '—'
  const date = d.includes('T') ? new Date(d) : new Date(d + 'T12:00:00')
  return date.toLocaleDateString('pt-BR')
}

export const CONTRACT_LABEL: Record<string, string> = {
  rental:      'Locação',
  rent_to_own: 'Compra Programada',
}

export const CYCLE_LABEL: Record<string, string> = {
  weekly:  'Semanal',
  monthly: 'Mensal',
}

export const STATUS_BADGE: Record<string, { bg: string; text: string; label: string }> = {
  active:      { bg: 'bg-success-bg', text: 'text-success', label: 'Ativa'       },
  closed:      { bg: 'bg-surface-2',  text: 'text-fg-mute', label: 'Encerrada'   },
  transferred: { bg: 'bg-info-bg',    text: 'text-info',    label: 'Transferida' },
}

export const SCHEDULE_STATUS_BADGE: Record<string, { bg: string; text: string; label: string }> = {
  pending:   { bg: 'bg-surface-2',  text: 'text-fg-mute', label: 'Pendente'          },
  overdue:   { bg: 'bg-danger-bg',  text: 'text-danger',  label: 'Atrasada'          },
  submitted: { bg: 'bg-pending-bg', text: 'text-pending', label: 'Aguardando análise' },
  approved:  { bg: 'bg-success-bg', text: 'text-success', label: 'Aprovada'          },
  rejected:  { bg: 'bg-danger-bg',  text: 'text-danger',  label: 'Rejeitada'         },
}

export const INSPECTION_STATUS_BADGE: Record<string, { bg: string; text: string; label: string }> = {
  pending:   { bg: 'bg-surface-2',  text: 'text-fg-mute', label: 'Pendente'  },
  completed: { bg: 'bg-success-bg', text: 'text-success', label: 'Concluída' },
}

export const MAINTENANCE_STATUS_BADGE: Record<string, { bg: string; text: string; label: string }> = {
  pending:   { bg: 'bg-surface-2',  text: 'text-fg-mute', label: 'Pendente'  },
  completed: { bg: 'bg-success-bg', text: 'text-success', label: 'Concluída' },
}

export const MAINTENANCE_TYPE_LABEL: Record<string, string> = {
  preventive: 'Preventiva',
  corrective: 'Corretiva',
  inspection: 'Revisão',
}

const MONTH_SHORT = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'] as const

export type MonthGroup<T> = { key: string; label: string; rows: T[]; total: number }

/**
 * Agrupa linhas pelo mês de uma data ISO (`YYYY-MM-DD…`), na ordem em que os
 * meses aparecem na entrada — quem chama decide se é cronológica ou inversa.
 *
 * Existe para as listas longas da aba Financeiro: um contrato semanal de dois
 * anos tem ~105 parcelas, e uma tabela corrida desse tamanho esconde o que pede
 * ação. Agrupado, cada mês vira uma linha com quantidade e subtotal.
 */
export function groupByMonth<T>(
  rows: T[],
  getDate: (row: T) => string,
  getAmount: (row: T) => number,
): MonthGroup<T>[] {
  const groups = new Map<string, MonthGroup<T>>()
  for (const row of rows) {
    const key = getDate(row).slice(0, 7)
    let group = groups.get(key)
    if (!group) {
      const [year, month] = key.split('-')
      group = { key, label: `${MONTH_SHORT[Number(month) - 1]}/${year}`, rows: [], total: 0 }
      groups.set(key, group)
    }
    group.rows.push(row)
    group.total += Number(getAmount(row))
  }
  return [...groups.values()]
}
