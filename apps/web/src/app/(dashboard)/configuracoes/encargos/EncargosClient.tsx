'use client'

import { Loader2 } from 'lucide-react'
import { useLateChargePolicies } from '@gomoto/data'
import { LateChargePolicySection, type PolicyVersion } from './_components/LateChargePolicySection'

export function EncargosClient() {
  const policiesQuery = useLateChargePolicies()

  // O formulário copia a política vigente para o próprio estado UMA vez, ao
  // montar. Montado antes das versões chegarem, ele nasce vazio — e a tela
  // diria "preencha a multa" com uma política em vigor. Quando tudo vivia em
  // /configuracoes isso não aparecia só porque a seção esperava a consulta de
  // papel, que por acaso terminava depois.
  if (policiesQuery.isLoading) {
    return (
      <div className="flex justify-center py-10">
        <Loader2 className="animate-spin text-fg-mute" size={28} />
      </div>
    )
  }

  return (
    <LateChargePolicySection
      versions={(policiesQuery.data ?? []) as PolicyVersion[]}
      onSaved={() => { void policiesQuery.refetch() }}
    />
  )
}
