import { notFound } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { getCurrentTenantId } from '@/lib/auth/tenant'
import {
  VEHICLE_STATUS_LABELS,
  VEHICLE_TYPE_LABELS,
  VEHICLE_PHOTO_SLOT_LABELS,
  ACQUISITION_TYPE_LABELS,
  type VehiclePhotoSlot,
  type VehicleStatus,
  formatRenavam,
  formatDocument,
  formatIMEI,
} from '@gomoto/core'
import { getSelectableStatuses } from '@gomoto/core'
import { formatCurrency } from '@/lib/utils'
import VehicleStatusActions from './_components/VehicleStatusActions'
import VehiclePhotoGallery from './_components/VehiclePhotoGallery'
import { VEHICLE_TRACKER_ENABLED } from '@/lib/vehicles/features'

const INSPECTION_KIND_LABEL: Record<string, string> = {
  checkin: 'Check-in',
  checkout: 'Check-out',
  periodic: 'Vistoria periódica',
}

const INSPECTION_STATUS_BADGE: Record<string, { bg: string; text: string; label: string }> = {
  pending:   { bg: 'bg-surface-2',   text: 'text-fg-mute', label: 'Pendente'          },
  completed: { bg: 'bg-success-bg',   text: 'text-success', label: 'Concluída'         },
  submitted: { bg: 'bg-pending-bg',   text: 'text-pending', label: 'Aguardando análise' },
  approved:  { bg: 'bg-success-bg',   text: 'text-success', label: 'Aprovada'          },
  rejected:  { bg: 'bg-danger-bg',   text: 'text-danger', label: 'Rejeitada'         },
}

const STATUS_COLORS: Record<VehicleStatus, string> = {
  available:   'bg-success-bg text-success border-success',
  rented:      'bg-info-bg text-info border-info',
  reserved:    'bg-info-bg text-info border-info',
  maintenance: 'bg-warning-bg text-warning border-warning/30',
  sinister:    'bg-danger-bg text-danger border-danger/30',
  sold:        'bg-surface text-fg-mute border-fg-mute',
  inactive:    'bg-surface text-fg-mute border-fg-mute',
}

export default async function VehicleDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const supabase = await createClient()
  const tenantId = await getCurrentTenantId(supabase)
  if (!tenantId) notFound()

  const [motoResult, photosResult, historyResult, documentsResult, obligationsResult, maintenancesResult] =
    await Promise.all([
      supabase.from('vehicles').select('*').eq('id', id).single(),
      supabase.from('vehicle_photos').select('*').eq('vehicle_id', id),
      supabase
        .from('vehicle_status_history')
        .select('*')
        .eq('vehicle_id', id)
        .order('created_at', { ascending: false }),
      supabase
        .from('vehicle_documents')
        .select('*')
        .eq('vehicle_id', id)
        .eq('is_current', true),
      supabase
        .from('vehicle_obligations')
        .select('*')
        .eq('vehicle_id', id)
        .order('due_date', { ascending: true }),
      supabase
        .from('maintenances')
        .select('*')
        .eq('vehicle_id', id)
        .order('created_at', { ascending: false })
        .limit(10),
    ])

  if (motoResult.error || !motoResult.data) notFound()

  const moto = motoResult.data
  const photos = photosResult.data ?? []
  const history = historyResult.data ?? []
  const documents = documentsResult.data ?? []
  const obligations = obligationsResult.data ?? []
  const maintenances = maintenancesResult.data ?? []

  // Histórico agregado de vistorias do veículo, através de todas as suas
  // locações (RF-023) — join direto, sem passar por @gomoto/data (repositórios
  // do pacote arrastariam hooks/contexto React, incompatíveis com Server Component).
  const { data: inspectionHistoryData } = await supabase
    .from('inspections')
    .select('*, rental:rentals!inner(id, vehicle_id, customer:customers(id,name))')
    .eq('rental.vehicle_id', id)
    .order('created_at', { ascending: false })
  const inspectionHistory = (inspectionHistoryData ?? []) as Array<{
    id: string
    kind: string
    status: string
    created_at: string
    executed_at: string | null
    rental: { customer: { name: string } | null } | null
  }>

  const maintenancePlan = moto.maintenance_plan_id
    ? (
        await supabase
          .from('maintenance_plans')
          .select('id, name')
          .eq('id', moto.maintenance_plan_id)
          .maybeSingle()
      ).data
    : null

  // Gerar URLs assinadas para fotos em paralelo
  const photoUrls: Partial<Record<VehiclePhotoSlot, string>> = {}
  await Promise.all(
    photos.map(async (photo) => {
      const { data } = await supabase.storage
        .from('vehicle-photos')
        .createSignedUrl(photo.url, 3600)
      if (data?.signedUrl) {
        photoUrls[photo.slot as VehiclePhotoSlot] = data.signedUrl
      }
    }),
  )

  const currentStatus = moto.status as VehicleStatus
  const selectableStatuses = getSelectableStatuses(currentStatus)

  function formatDate(d: string | null | undefined) {
    if (!d) return '—'
    const date = d.includes('T') ? new Date(d) : new Date(d + 'T12:00:00')
    return date.toLocaleDateString('pt-BR')
  }

  const OBLIGATION_TYPE_LABELS: Record<string, string> = {
    ipva: 'IPVA',
    licensing: 'Licenciamento',
    dpvat: 'DPVAT',
    insurance: 'Seguro',
    crv_issuance: 'Emissão CRV',
    detran_fee: 'Taxa DETRAN',
    other: 'Outro',
  }

  return (
    <div className="min-h-screen bg-bg">
      {/* Header */}
      <div className="sticky top-0 z-10 bg-bg border-b border-divider px-6 h-16 flex items-center gap-4">
        <Link href="/veiculos" className="text-[13px] text-fg-mute hover:text-fg transition-colors">
          ← Veículos
        </Link>
        <span className="text-border">/</span>
        <h1 className="text-[18px] font-bold text-fg">
          {moto.make} {moto.model} · {moto.license_plate}
        </h1>
        <div className="ml-auto flex items-center gap-3">
          <Link
            href={`/veiculos/${id}/editar`}
            className="inline-flex items-center h-9 px-4 rounded-full bg-surface-2 text-fg text-[13px] font-medium hover:bg-divider transition-colors"
          >
            Editar dados
          </Link>
        </div>
      </div>

      <div className="px-6 py-6 space-y-6 max-w-5xl mx-auto">
        {/* Status + Ações */}
        <div className="flex items-center gap-4">
          <span
            className={`inline-flex items-center h-7 px-3 rounded-full text-[13px] font-medium border ${STATUS_COLORS[currentStatus]}`}
          >
            {VEHICLE_STATUS_LABELS[currentStatus]}
          </span>
          {selectableStatuses.length > 0 && (
            <VehicleStatusActions
              vehicleId={id}
              currentStatus={currentStatus}
              selectableStatuses={selectableStatuses}
            />
          )}
        </div>

        {/* Galeria de fotos */}
        <section>
          <h2 className="text-[14px] font-bold text-primary mb-3">Fotos</h2>
          <VehiclePhotoGallery
            vehicleId={id}
            photoUrls={photoUrls}
          />
        </section>

        {/* Dados básicos */}
        <section>
          <h2 className="text-[14px] font-bold text-primary mb-3">Identificação</h2>
          <div className="bg-surface rounded-xl overflow-hidden">
            <table className="w-full text-[13px]">
              <tbody>
                {[
                  ['Placa', moto.license_plate],
                  ['Tipo', VEHICLE_TYPE_LABELS[moto.vehicle_type as keyof typeof VEHICLE_TYPE_LABELS] ?? null],
                  ['RENAVAM', moto.renavam ? formatRenavam(moto.renavam) : null],
                  ['Chassi', moto.chassis],
                  ['Marca', moto.make],
                  ['Modelo', moto.model],
                  ['Ano fab./modelo', `${moto.year_manufacture ?? '—'} / ${moto.year_model ?? '—'}`],
                  ['Cor', moto.color],
                  ['Combustível', moto.fuel],
                  ['Cilindrada', moto.engine_capacity],
                  ['KM de entrada', moto.km_entry != null ? moto.km_entry.toLocaleString('pt-BR') : 'Não informado (dá para informar na edição)'],
                  ['KM atual', moto.km_current != null ? moto.km_current.toLocaleString('pt-BR') : '—'],
                  ['Observações', moto.observations],
                ].map(([label, value]) => (
                  <tr key={label as string} className="border-b border-divider last:border-0">
                    <td className="h-9 px-4 text-fg-mute w-48">{label}</td>
                    <td className="h-9 px-4 text-fg">{value || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* Aquisição */}
        <section>
          <h2 className="text-[14px] font-bold text-primary mb-3">Aquisição</h2>
          <div className="bg-surface rounded-xl overflow-hidden">
            <table className="w-full text-[13px]">
              <tbody>
                {[
                  ['Tipo', moto.acquisition_type ? ACQUISITION_TYPE_LABELS[moto.acquisition_type as keyof typeof ACQUISITION_TYPE_LABELS] ?? moto.acquisition_type : '—'],
                  ['Data da compra', formatDate(moto.purchase_date)],
                  ['Valor pago', moto.acquisition_amount ? formatCurrency(moto.acquisition_amount) : '—'],
                  ['Valor FIPE', moto.fipe_value ? formatCurrency(moto.fipe_value) : '—'],
                  ['Dono anterior', moto.previous_owner],
                  ['CPF/CNPJ anterior', moto.previous_owner_cpf ? formatDocument(moto.previous_owner_cpf) : null],
                ].map(([label, value]) => (
                  <tr key={label as string} className="border-b border-divider last:border-0">
                    <td className="h-9 px-4 text-fg-mute w-48">{label}</td>
                    <td className="h-9 px-4 text-fg">{value || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* Documentação registral */}
        <section>
          <h2 className="text-[14px] font-bold text-primary mb-3">Documentação Registral</h2>
          <div className="bg-surface rounded-xl overflow-hidden">
            <table className="w-full text-[13px]">
              <tbody>
                {[
                  ['Proprietário registrado', moto.registered_owner_name],
                  ['Documento', moto.registered_owner_document ? formatDocument(moto.registered_owner_document) : null],
                  ['Tipo', moto.registered_owner_type?.toUpperCase()],
                  ['UF', moto.registration_state],
                  ['Transferência', moto.ownership_transferred ? 'Concluída' : 'Pendente'],
                  ['Data da transferência', formatDate(moto.ownership_transfer_date)],
                ].map(([label, value]) => (
                  <tr key={label as string} className="border-b border-divider last:border-0">
                    <td className="h-9 px-4 text-fg-mute w-48">{label}</td>
                    <td className="h-9 px-4 text-fg">{value || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* Rastreador — escondido até existir a integração (lib/vehicles/features) */}
        {VEHICLE_TRACKER_ENABLED && (
          <section>
            <h2 className="text-[14px] font-bold text-primary mb-3">Rastreador GPS</h2>
            <div className="bg-surface rounded-xl overflow-hidden">
              {moto.has_tracker ? (
                <table className="w-full text-[13px]">
                  <tbody>
                    {[
                      ['Marca', moto.tracker_brand],
                      ['Modelo', moto.tracker_model],
                      ['IMEI', moto.tracker_imei ? formatIMEI(moto.tracker_imei) : null],
                    ].map(([label, value]) => (
                      <tr key={label as string} className="border-b border-divider last:border-0">
                        <td className="h-9 px-4 text-fg-mute w-48">{label}</td>
                        <td className="h-9 px-4 text-fg font-mono">{value || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className="h-9 px-4 flex items-center text-[13px] text-fg-mute">Sem rastreador cadastrado</p>
              )}
            </div>
          </section>
        )}

        {/* Seguro */}
        <section>
          <h2 className="text-[14px] font-bold text-primary mb-3">Seguro</h2>
          <div className="bg-surface rounded-xl overflow-hidden">
            {moto.has_insurance ? (
              <table className="w-full text-[13px]">
                <tbody>
                  {[
                    ['Valor mensal', moto.insurance_monthly_amount ? formatCurrency(moto.insurance_monthly_amount) : '—'],
                    ['Vencimento', formatDate(moto.insurance_expiry_date)],
                  ].map(([label, value]) => (
                    <tr key={label as string} className="border-b border-divider last:border-0">
                      <td className="h-9 px-4 text-fg-mute w-48">{label}</td>
                      <td className="h-9 px-4 text-fg">{value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="h-9 px-4 flex items-center text-[13px] text-fg-mute">Sem seguro cadastrado</p>
            )}
          </div>
        </section>

        {/* Histórico de status */}
        <section>
          <h2 className="text-[14px] font-bold text-primary mb-3">
            Histórico de Status <span className="text-[12px] font-normal text-fg-mute">({history.length})</span>
          </h2>
          <div className="bg-surface rounded-xl overflow-hidden">
            {history.length === 0 ? (
              <p className="text-[13px] text-fg-mute px-4 py-3">Nenhuma transição registrada.</p>
            ) : (
              <table className="w-full text-[13px]">
                <thead className="border-b border-divider">
                  <tr>
                    <th className="h-9 px-4 text-left text-fg-mute font-medium">De</th>
                    <th className="h-9 px-4 text-left text-fg-mute font-medium">Para</th>
                    <th className="h-9 px-4 text-left text-fg-mute font-medium">Data</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((entry) => (
                    <tr key={entry.id} className="border-b border-divider last:border-0">
                      <td className="h-9 px-4 text-fg-mute">
                        {entry.previous_status
                          ? VEHICLE_STATUS_LABELS[entry.previous_status as VehicleStatus]
                          : <span className="italic text-fg-mute">Cadastro</span>}
                      </td>
                      <td className="h-9 px-4 text-fg">
                        {VEHICLE_STATUS_LABELS[entry.new_status as VehicleStatus]}
                      </td>
                      <td className="h-9 px-4 text-fg-mute">
                        {new Date(entry.created_at).toLocaleDateString('pt-BR', {
                          day: '2-digit', month: '2-digit', year: 'numeric',
                          hour: '2-digit', minute: '2-digit',
                        })}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>

        {/* Histórico de vistorias (RF-023) */}
        <section>
          <h2 className="text-[14px] font-bold text-primary mb-3">
            Histórico de Vistorias <span className="text-[12px] font-normal text-fg-mute">({inspectionHistory.length})</span>
          </h2>
          <div className="bg-surface rounded-xl overflow-hidden">
            {inspectionHistory.length === 0 ? (
              <p className="text-[13px] text-fg-mute px-4 py-3">Nenhuma vistoria registrada para este veículo.</p>
            ) : (
              <table className="w-full text-[13px]">
                <thead className="border-b border-divider">
                  <tr>
                    <th className="h-9 px-4 text-left text-fg-mute font-medium">Tipo</th>
                    <th className="h-9 px-4 text-left text-fg-mute font-medium">Cliente</th>
                    <th className="h-9 px-4 text-left text-fg-mute font-medium">Data</th>
                    <th className="h-9 px-4 text-left text-fg-mute font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {inspectionHistory.map((insp) => {
                    const badge = INSPECTION_STATUS_BADGE[insp.status] ?? INSPECTION_STATUS_BADGE.pending
                    return (
                      <tr key={insp.id} className="border-b border-divider last:border-0 hover:bg-surface-2 transition-colors">
                        <td className="h-9 px-4">
                          <Link href={`/vistorias/execute/${insp.id}`} className="text-fg hover:text-primary transition-colors">
                            {INSPECTION_KIND_LABEL[insp.kind] ?? insp.kind}
                          </Link>
                        </td>
                        <td className="h-9 px-4 text-fg-mute">{insp.rental?.customer?.name ?? '—'}</td>
                        <td className="h-9 px-4 text-fg-mute">
                          {new Date(insp.executed_at ?? insp.created_at).toLocaleDateString('pt-BR')}
                        </td>
                        <td className="h-9 px-4">
                          <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${badge.bg} ${badge.text}`}>
                            {badge.label}
                          </span>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </div>
        </section>

        {/* Documentos */}
        {documents.length > 0 && (
          <section>
            <h2 className="text-[14px] font-bold text-primary mb-3">Documentos Atuais</h2>
            <div className="bg-surface rounded-xl overflow-hidden">
              <table className="w-full text-[13px]">
                <thead className="border-b border-divider">
                  <tr>
                    <th className="h-9 px-4 text-left text-fg-mute font-medium">Tipo</th>
                    <th className="h-9 px-4 text-left text-fg-mute font-medium">Nº</th>
                    <th className="h-9 px-4 text-left text-fg-mute font-medium">Ano-exercício</th>
                    <th className="h-9 px-4 text-left text-fg-mute font-medium">Emissão</th>
                  </tr>
                </thead>
                <tbody>
                  {documents.map((doc) => (
                    <tr key={doc.id} className="border-b border-divider last:border-0">
                      <td className="h-9 px-4 text-fg uppercase">{doc.type}</td>
                      <td className="h-9 px-4 text-fg-mute font-mono">{doc.document_number || '—'}</td>
                      <td className="h-9 px-4 text-fg-mute">{doc.exercise_year ?? '—'}</td>
                      <td className="h-9 px-4 text-fg-mute">{formatDate(doc.issued_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {/* Obrigações */}
        <section>
          <h2 className="text-[14px] font-bold text-primary mb-3">Obrigações Anuais</h2>
          <div className="bg-surface rounded-xl overflow-hidden">
            {obligations.length === 0 ? (
              <p className="h-9 px-4 flex items-center text-[13px] text-fg-mute">Nenhuma obrigação cadastrada</p>
            ) : (
              <table className="w-full text-[13px]">
                <thead className="border-b border-divider">
                  <tr>
                    <th className="h-9 px-4 text-left text-fg-mute font-medium">Tipo</th>
                    <th className="h-9 px-4 text-left text-fg-mute font-medium">Ano ref.</th>
                    <th className="h-9 px-4 text-left text-fg-mute font-medium">Valor</th>
                    <th className="h-9 px-4 text-left text-fg-mute font-medium">Vencimento</th>
                    <th className="h-9 px-4 text-left text-fg-mute font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {obligations.map((obl) => (
                    <tr key={obl.id} className="border-b border-divider last:border-0">
                      <td className="h-9 px-4 text-fg">{OBLIGATION_TYPE_LABELS[obl.type] ?? obl.type}</td>
                      <td className="h-9 px-4 text-fg-mute">{obl.reference_year ?? '—'}</td>
                      <td className="h-9 px-4 text-primary">{formatCurrency(obl.amount)}</td>
                      <td className="h-9 px-4 text-fg-mute">{formatDate(obl.due_date)}</td>
                      <td className="h-9 px-4">
                        <span className={`text-[12px] font-medium ${obl.status === 'paid' ? 'text-success' : obl.status === 'overdue' ? 'text-danger' : obl.status === 'exempt' ? 'text-fg-mute' : 'text-warning'}`}>
                          {obl.status === 'paid' ? 'Pago' : obl.status === 'overdue' ? 'Vencido' : obl.status === 'exempt' ? 'Isento' : 'Pendente'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>

        {/* Plano de manutenção */}
        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-[14px] font-bold text-primary">Plano de Manutenção</h2>
            <Link
              href={`/veiculos/${id}/editar#sec-maintenance`}
              className="text-[12px] text-primary hover:underline"
            >
              {maintenancePlan ? 'Trocar plano' : 'Atribuir plano'}
            </Link>
          </div>
          <div className="bg-surface rounded-xl overflow-hidden">
            {maintenancePlan ? (
              <table className="w-full text-[13px]">
                <tbody>
                  <tr>
                    <td className="h-9 px-4 text-fg-mute w-48">Plano vinculado</td>
                    <td className="h-9 px-4">
                      <Link
                        href={`/planos-manutencao/${maintenancePlan.id}`}
                        className="text-primary hover:underline"
                      >
                        {maintenancePlan.name}
                      </Link>
                    </td>
                  </tr>
                </tbody>
              </table>
            ) : (
              <p className="h-9 px-4 flex items-center text-[13px] text-fg-mute">Nenhum plano de manutenção vinculado</p>
            )}
          </div>
        </section>

        {/* Manutenções recentes */}
        {maintenances.length > 0 && (
          <section>
            <h2 className="text-[14px] font-bold text-primary mb-3">Manutenções Recentes</h2>
            <div className="bg-surface rounded-xl overflow-hidden">
              <table className="w-full text-[13px]">
                <thead className="border-b border-divider">
                  <tr>
                    <th className="h-9 px-4 text-left text-fg-mute font-medium">Descrição</th>
                    <th className="h-9 px-4 text-left text-fg-mute font-medium">Data prev.</th>
                    <th className="h-9 px-4 text-left text-fg-mute font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {maintenances.map((m) => (
                    <tr key={m.id} className="border-b border-divider last:border-0">
                      <td className="h-9 px-4 text-fg">{m.description}</td>
                      <td className="h-9 px-4 text-fg-mute">{formatDate(m.scheduled_date)}</td>
                      <td className="h-9 px-4">
                        <span className={`text-[12px] font-medium ${m.completed ? 'text-success' : 'text-warning'}`}>
                          {m.completed ? 'Concluída' : 'Pendente'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </div>
    </div>
  )
}
