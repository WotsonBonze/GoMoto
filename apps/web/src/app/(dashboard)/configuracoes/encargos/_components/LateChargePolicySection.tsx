'use client'

/**
 * Política de encargo por atraso — a única forma de configurar multa e juros.
 *
 * Antes desta tela, a política só existia porque o seed a inseriu: mudar multa
 * ou juros exigia SQL direto no banco. O que havia em Configurações era um
 * `saveFinancialSettings` sem chamador, gravando JSON numa chave que nenhum
 * código lia.
 *
 * Salvar cria uma VERSÃO nova. Não há edição da vigente de propósito: a
 * cobrança guarda `late_charge_policy_id`, então o que foi emitido continua
 * valendo o que valia no dia — mexer na linha vigente mudaria retroativamente
 * o que clientes antigos devem.
 */

import { useState, useTransition } from 'react'
import { Percent } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { formatCurrency, formatDate } from '@/lib/utils'
import {
  toPolicyInput,
  DAYS_PER_MONTH,
  type LateChargePolicy,
} from '@gomoto/core'
import { createLateChargePolicyAction } from '../actions'

export type PolicyVersion = LateChargePolicy & {
  id: string
  version: number
  effective_from: string
}

/** Decimal com vírgula, como o resto do sistema — sem zeros à toa. */
function num(n: number, casas = 2): string {
  return n.toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: casas })
}

function hojeLocal(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function LateChargePolicySection({
  versions,
  onSaved,
}: {
  versions: PolicyVersion[]
  /** Recarrega a lista de versões após gravar.
   *
   *  A action chama `revalidatePath('/configuracoes/encargos')`, e isso não tem efeito
   *  nenhum aqui: a tela é Client Component e as versões vêm de
   *  `useLateChargePolicies()`, um cache do TanStack Query. Sem invalidar esse
   *  cache, salvar respondia "salvo" com a tabela mostrando a política antiga —
   *  o operador só via a nova depois de recarregar a página, e no meio tempo a
   *  tela afirmava que a regra em vigor era outra. */
  onSaved?: () => void
}) {
  const [isPending, startTransition] = useTransition()
  const [erro, setErro] = useState<string | null>(null)
  const [ok, setOk] = useState(false)

  // A vigente é a de maior `effective_from` que já começou — a mesma ordem que
  // `resolveLateChargePolicy` usa na emissão.
  const hoje = hojeLocal()
  const vigente = versions.find((v) => v.effective_from <= hoje) ?? versions[0]
  const futuras = versions.filter((v) => v.effective_from > hoje)

  // Empresa nova nasce SEM política, e isso significa não cobrar encargo
  // nenhum. O formulário nascia preenchido com 2% e 1% ao mês nesse caso — os
  // valores de mercado —, e quem abria a tela lia isso como configuração
  // vigente. Campos vazios não deixam dúvida: não há regra, e o que a empresa
  // cobra hoje é zero.
  const semPolitica = !vigente
  const inicial = vigente ? toPolicyInput(vigente) : null

  const [feeType, setFeeType]   = useState<'percentage' | 'fixed'>(inicial?.fee_type ?? 'percentage')
  const [fee, setFee]           = useState(inicial ? String(inicial.fee_value) : '')
  const [juros, setJuros]       = useState(inicial ? String(inicial.monthly_interest_percent) : '')
  const [carencia, setCarencia] = useState(inicial ? String(inicial.grace_period_days) : '')
  const [minimo, setMinimo]     = useState(inicial ? String(inicial.min_amount) : '')
  const [vigencia, setVigencia] = useState(hoje)

  // O operador digita ao mês porque é assim que a cláusula do contrato fala; o
  // banco guarda ao dia. Mostrar a taxa diária derivada evita que a conversão
  // seja um segredo entre o formulário e a tabela.
  const jurosDia = (parseFloat(juros) || 0) / DAYS_PER_MONTH

  function salvar() {
    setErro(null)
    setOk(false)

    // `parseFloat('')` é NaN, e o Zod devolveria "expected number, received
    // nan" — mensagem de biblioteca para um campo que o operador só esqueceu
    // de preencher. Zero é valor legítimo (isenta a linha); vazio não é.
    const numeros = { Multa: fee, 'Juros ao mês': juros, Carência: carencia, 'Encargo mínimo': minimo }
    const faltando = Object.entries(numeros)
      .filter(([, v]) => v.trim() === '' || isNaN(parseFloat(v)))
      .map(([k]) => k)

    if (faltando.length > 0) {
      setErro(`Preencha ${faltando.join(', ')} — use 0 para não cobrar essa parte.`)
      return
    }

    startTransition(async () => {
      const r = await createLateChargePolicyAction({
        fee_type: feeType,
        fee_value: parseFloat(fee),
        monthly_interest_percent: parseFloat(juros),
        grace_period_days: parseInt(carencia, 10),
        min_amount: parseFloat(minimo),
        effective_from: vigencia,
      })
      if (!r.ok) { setErro(r.error.message); return }
      setOk(true)
      onSaved?.()
    })
  }

  return (
    <section>
      <div className="mb-4 flex items-center gap-3">
        <div className="rounded-full bg-warning-bg p-2.5 border border-warning">
          <Percent className="h-5 w-5 text-warning" />
        </div>
        <div>
          <h2 className="text-[28px] font-semibold text-fg">Encargo por atraso</h2>
          <p className="text-[13px] text-fg-mute">
            Multa e juros cobrados quando a cobrança vence sem pagamento. Vale para
            toda a empresa — cobranças já emitidas mantêm a regra do dia em que saíram.
          </p>
        </div>
      </div>

      <Card>
        <div className="space-y-5">
          {semPolitica && (
            <div className="rounded-lg border border-warning bg-warning-bg px-4 py-3 text-[13px] text-warning">
              <strong className="font-semibold">Nenhum encargo configurado.</strong>{' '}
              Cobranças vencidas não recebem multa nem juros — o cliente deve o valor
              original, por quanto tempo passar. Preencha abaixo para começar a cobrar.
            </div>
          )}

          {vigente && (
            <div className="rounded-lg border border-divider bg-surface-2 px-4 py-3 text-[13px]">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-fg-mute">
                  Em vigor · versão {vigente.version} · desde {formatDate(vigente.effective_from)}
                </span>
                <span className="tabular-nums text-fg">
                  {vigente.fee_type === 'percentage'
                    ? `${num(toPolicyInput(vigente).fee_value)}% de multa`
                    : `${formatCurrency(vigente.fee_value)} de multa`}
                  {' · '}
                  {num(toPolicyInput(vigente).monthly_interest_percent)}% ao mês
                  {vigente.grace_period_days > 0 && ` · ${vigente.grace_period_days} dia(s) de carência`}
                  {vigente.min_amount > 0 && ` · mínimo ${formatCurrency(vigente.min_amount)}`}
                </span>
              </div>
            </div>
          )}

          {futuras.length > 0 && (
            <div className="rounded-lg border border-info bg-info-bg px-4 py-3 text-[13px] text-info">
              {futuras.length === 1 ? 'Há uma versão agendada' : `Há ${futuras.length} versões agendadas`}
              {' '}para {futuras.map((f) => formatDate(f.effective_from)).join(', ')}.
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-[13px] text-fg-mute">Tipo de multa</label>
              <select
                value={feeType}
                onChange={(e) => setFeeType(e.target.value as 'percentage' | 'fixed')}
                className="h-9 w-full rounded-lg border border-divider bg-surface px-3 text-[13px] text-fg focus:border-primary focus:outline-none"
              >
                <option value="percentage">Percentual sobre o saldo</option>
                <option value="fixed">Valor fixo em reais</option>
              </select>
            </div>

            <Input
              label={feeType === 'percentage' ? 'Multa (%)' : 'Multa (R$)'}
              type="number"
              step="0.01"
              min="0"
              placeholder={feeType === 'percentage' ? 'ex.: 2' : 'ex.: 35,00'}
              value={fee}
              onChange={(e) => setFee(e.target.value)}
            />

            <div>
              <Input
                label="Juros ao mês (%)"
                type="number"
                step="0.01"
                min="0"
                placeholder="ex.: 1"
                value={juros}
                onChange={(e) => setJuros(e.target.value)}
              />
              <p className="mt-1 text-[12px] text-fg-mute tabular-nums">
                Equivale a {num(jurosDia, 4)}% ao dia, sobre o saldo em aberto.
              </p>
            </div>

            <div>
              <Input
                label="Carência (dias)"
                type="number"
                step="1"
                min="0"
                placeholder="0"
                value={carencia}
                onChange={(e) => setCarencia(e.target.value)}
              />
              <p className="mt-1 text-[12px] text-fg-mute">
                Dias após o vencimento antes de o encargo começar a correr.
              </p>
            </div>

            <Input
              label="Encargo mínimo (R$)"
              type="number"
              step="0.01"
              min="0"
              placeholder="0,00"
              value={minimo}
              onChange={(e) => setMinimo(e.target.value)}
            />

            <div>
              <Input
                label="Em vigor a partir de"
                type="date"
                min={hoje}
                value={vigencia}
                onChange={(e) => setVigencia(e.target.value)}
              />
              <p className="mt-1 text-[12px] text-fg-mute">
                Não retroage: o que já foi cobrado mantém a regra antiga.
              </p>
            </div>
          </div>

          {erro && (
            <div className="rounded-lg border border-danger bg-danger-bg px-3 py-2 text-[13px] text-danger">
              {erro}
            </div>
          )}
          {ok && (
            <div className="rounded-lg border border-success bg-success-bg px-3 py-2 text-[13px] text-success">
              {semPolitica ? 'Encargo configurado' : 'Nova versão salva'}. Cobranças emitidas a partir da vigência usarão esta regra.
            </div>
          )}

          <div className="flex justify-end">
            <Button onClick={salvar} disabled={isPending}>
              {isPending ? 'Salvando…' : semPolitica ? 'Começar a cobrar encargo' : 'Salvar nova versão'}
            </Button>
          </div>
        </div>
      </Card>
    </section>
  )
}
