import { useMemo, useState } from 'react'
import {
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { StatusBar } from 'expo-status-bar'
import { SafeAreaView } from 'react-native-safe-area-context'
import {
  useCustomers,
  useMaintenanceRecords,
  useMaintenances,
  useVehicles,
} from '@gomoto/data'
import {
  calculateMaintenanceStatus,
  type Maintenance,
  type MaintenanceRecord,
  type MaintenanceStatus,
  type Vehicle,
} from '@gomoto/core'
import { useAuth } from '../../src/contexts/auth'
import { RegisterMaintenanceModal } from '../../src/components/RegisterMaintenanceModal'
import { useTheme, useStatusBarStyle, type ThemeTokens } from '../../src/theme'
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Icon,
  IconCircle,
  Notice,
  ScreenHeader,
  SegmentedControl,
  radius,
  type IconName,
  type Tone,
} from '../../src/components/ui'

const STATUS_ORDER: Record<MaintenanceStatus, number> = {
  overdue: 0,
  upcoming: 1,
  scheduled: 2,
  completed: 3,
}

const STATUS_LABEL: Record<MaintenanceStatus, string> = {
  overdue: 'Vencida',
  upcoming: 'Próxima',
  scheduled: 'Agendada',
  completed: 'Concluída',
}

const STATUS_TONE: Record<MaintenanceStatus, Tone> = {
  overdue: 'danger',
  upcoming: 'pending',
  scheduled: 'primary',
  completed: 'success',
}

const TYPE_LABEL: Record<string, string> = {
  preventive: 'Preventiva',
  corrective: 'Corretiva',
  inspection: 'Vistoria',
}

type MaintenanceWithStatus = Maintenance & { _status: MaintenanceStatus }

function deriveStatus(m: Maintenance, vehicle: Vehicle | undefined): MaintenanceStatus {
  return calculateMaintenanceStatus({
    completed: m.completed,
    predicted_km: m.predicted_km,
    scheduled_date: m.scheduled_date,
    current_km: vehicle?.km_current ?? 0,
  })
}

function formatKm(km: number | null): string {
  if (km == null) return '—'
  return `${km.toLocaleString('pt-BR')} km`
}

function formatDate(date: string | null): string {
  if (!date) return '—'
  const [y, mo, d] = date.split('-')
  return `${d}/${mo}/${y}`
}

export default function ManutencoesTab() {
  const { activeTenantId } = useAuth()
  const maintenancesQuery = useMaintenances()
  const vehiclesQuery = useVehicles()
  const recordsQuery = useMaintenanceRecords()
  const customersQuery = useCustomers()

  const [selected, setSelected] = useState<Maintenance | null>(null)
  const [tab, setTab] = useState<'upcoming' | 'history'>('upcoming')
  const theme = useTheme()
  const statusBarStyle = useStatusBarStyle()
  const styles = useMemo(() => createStyles(theme), [theme])

  const loading =
    maintenancesQuery.isLoading || vehiclesQuery.isLoading || customersQuery.isLoading
  const refreshing = maintenancesQuery.isFetching && !maintenancesQuery.isLoading
  const error = maintenancesQuery.error ?? vehiclesQuery.error ?? recordsQuery.error

  const vehiclesById = useMemo(() => {
    const map = new Map<string, Vehicle>()
    for (const m of vehiclesQuery.data ?? []) map.set(m.id, m)
    return map
  }, [vehiclesQuery.data])

  // Cliente tem 1 customer por tenant — pega o da locadora ativa.
  const customerId = useMemo(() => {
    const list = customersQuery.data ?? []
    return list.find((c) => c.tenant_id === activeTenantId)?.id ?? null
  }, [customersQuery.data, activeTenantId])

  // Mapa de pending por maintenance_id: presença = "Aguardando aprovação"
  // → desabilita botão e troca o CTA pela tag.
  const pendingByMaintenanceId = useMemo(() => {
    const map = new Map<string, MaintenanceRecord>()
    for (const r of recordsQuery.data ?? []) {
      if (r.status === 'pending' && r.maintenance_id) map.set(r.maintenance_id, r)
    }
    return map
  }, [recordsQuery.data])

  const { upcoming, history } = useMemo(() => {
    const items = (maintenancesQuery.data ?? []).map((m) => ({
      ...m,
      _status: deriveStatus(m, vehiclesById.get(m.vehicle_id)),
    }))
    const upcoming = items
      .filter((m) => m._status !== 'completed')
      .sort((a, b) => {
        const s = STATUS_ORDER[a._status] - STATUS_ORDER[b._status]
        if (s !== 0) return s
        const aDate = a.scheduled_date ?? ''
        const bDate = b.scheduled_date ?? ''
        return aDate.localeCompare(bDate)
      })
    const history = items
      .filter((m) => m._status === 'completed')
      .sort((a, b) => (b.completed_date ?? '').localeCompare(a.completed_date ?? ''))
      .slice(0, 10)
    return { upcoming, history }
  }, [maintenancesQuery.data, vehiclesById])

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <StatusBar style={statusBarStyle} />
      <ScreenHeader title="Manutenção" />
      <ScrollView
        style={styles.body}
        contentContainerStyle={styles.bodyContent}
        refreshControl={
          <RefreshControl
            tintColor={theme.primary}
            refreshing={refreshing}
            onRefresh={() => {
              maintenancesQuery.refetch()
              vehiclesQuery.refetch()
              recordsQuery.refetch()
            }}
          />
        }
      >
        <SegmentedControl
          value={tab}
          onChange={setTab}
          options={[
            { value: 'upcoming', label: 'Próximas', count: upcoming.length },
            { value: 'history', label: 'Histórico' },
          ]}
        />

        {loading ? (
          <View style={styles.loading}>
            <ActivityIndicator color={theme.primary} />
          </View>
        ) : error ? (
          <Notice
            tone="danger"
            icon="cloud-offline-outline"
            title="Não foi possível carregar"
            text="Puxe a tela para baixo para tentar de novo."
          />
        ) : tab === 'upcoming' ? (
          upcoming.length === 0 ? (
            <EmptyState
              icon="shield-checkmark-outline"
              tone="success"
              title="Tudo em dia"
              text="Nenhuma manutenção pendente — seu veículo está em dia."
            />
          ) : (
            upcoming.map((m) => (
              <MaintenanceCard
                key={m.id}
                item={m}
                vehicle={vehiclesById.get(m.vehicle_id)}
                pendingRecord={pendingByMaintenanceId.get(m.id)}
                canRegister={!!customerId}
                onRegister={() => setSelected(m)}
                styles={styles}
                theme={theme}
              />
            ))
          )
        ) : history.length === 0 ? (
          <EmptyState
            icon="time-outline"
            title="Sem histórico ainda"
            text="As manutenções concluídas do seu veículo aparecem aqui."
          />
        ) : (
          history.map((m) => (
            <MaintenanceCard
              key={m.id}
              item={m}
              vehicle={vehiclesById.get(m.vehicle_id)}
              styles={styles}
              theme={theme}
            />
          ))
        )}
      </ScrollView>
      {customerId ? (
        <RegisterMaintenanceModal
          visible={selected !== null}
          onClose={() => setSelected(null)}
          customerId={customerId}
          maintenance={selected}
        />
      ) : null}
    </SafeAreaView>
  )
}

function MaintenanceCard({
  item,
  vehicle,
  pendingRecord,
  canRegister,
  onRegister,
  styles,
  theme,
}: {
  item: MaintenanceWithStatus
  vehicle?: Vehicle
  pendingRecord?: MaintenanceRecord
  canRegister?: boolean
  onRegister?: () => void
  styles: Styles
  theme: ThemeTokens
}) {
  const tone = STATUS_TONE[item._status]
  const isOpen = item._status !== 'completed'
  const showRegisterCta = isOpen && !pendingRecord && canRegister && onRegister
  return (
    <Card style={item._status === 'overdue' ? { borderColor: theme.danger } : undefined}>
      <View style={styles.cardHeader}>
        <IconCircle name={isOpen ? 'construct-outline' : 'checkmark-done'} tone={tone} />
        <View style={styles.cardTitles}>
          <Text style={styles.cardTitle} numberOfLines={2}>
            {item.description || TYPE_LABEL[item.type] || item.type}
          </Text>
          <Text style={styles.cardMeta} numberOfLines={1}>
            {vehicle ? `${vehicle.license_plate} · ${vehicle.make} ${vehicle.model}` : 'Veículo não identificado'}
          </Text>
        </View>
        <Badge label={STATUS_LABEL[item._status]} tone={tone} size="sm" />
      </View>

      <View style={styles.cardFields}>
        {item._status === 'completed' ? (
          <>
            <Field icon="calendar-outline" label="Concluída em" value={formatDate(item.completed_date)} styles={styles} theme={theme} />
            <Field icon="speedometer-outline" label="KM no serviço" value={formatKm(item.actual_km)} styles={styles} theme={theme} />
          </>
        ) : (
          <>
            <Field icon="calendar-outline" label="Prevista" value={formatDate(item.scheduled_date)} styles={styles} theme={theme} />
            <Field icon="speedometer-outline" label="KM previsto" value={formatKm(item.predicted_km)} styles={styles} theme={theme} />
          </>
        )}
      </View>

      {isOpen && pendingRecord ? (
        <View style={styles.cardFooter}>
          <Notice tone="pending" icon="hourglass-outline" text="Conclusão enviada — aguardando aprovação da locadora." />
        </View>
      ) : null}
      {showRegisterCta ? (
        <Button
          label="Registrar conclusão"
          icon="checkmark-circle-outline"
          variant={item._status === 'overdue' ? 'primary' : 'secondary'}
          size="md"
          onPress={onRegister}
          style={styles.cardFooter}
        />
      ) : null}
    </Card>
  )
}

function Field({
  icon,
  label,
  value,
  styles,
  theme,
}: {
  icon: IconName
  label: string
  value: string
  styles: Styles
  theme: ThemeTokens
}) {
  return (
    <View style={styles.field}>
      <Icon name={icon} size={16} color={theme.textMute} />
      <View>
        <Text style={styles.fieldLabel}>{label}</Text>
        <Text style={styles.fieldValue}>{value}</Text>
      </View>
    </View>
  )
}

type Styles = ReturnType<typeof createStyles>

const createStyles = (theme: ThemeTokens) => StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.bg },
  body: { flex: 1 },
  bodyContent: { paddingHorizontal: 16, paddingTop: 4, paddingBottom: 40, gap: 14 },
  loading: { paddingVertical: 40, alignItems: 'center' },
  cardHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  cardTitles: { flex: 1, gap: 2 },
  cardTitle: { color: theme.text, fontSize: 15, fontWeight: '600' },
  cardMeta: { color: theme.textSoft, fontSize: 13 },
  cardFields: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 14,
    backgroundColor: theme.surfaceAlt,
    borderRadius: radius.md,
    padding: 12,
  },
  field: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8 },
  fieldLabel: { color: theme.textMute, fontSize: 11.5 },
  fieldValue: { color: theme.text, fontSize: 14, fontWeight: '600', marginTop: 1 },
  cardFooter: { marginTop: 12 },
})
