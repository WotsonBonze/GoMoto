import { useCallback, useMemo } from 'react'
import {
  ActivityIndicator,
  Image,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useFocusEffect, useRouter } from 'expo-router'
import {
  useMyCharges,
  useMaintenances,
  useRentals,
  useVehicles,
} from '@gomoto/data'
import type { MyChargeRow } from '@gomoto/data'
import {
  calculateMaintenanceStatus,
  type Maintenance,
  type Rental,
  type Vehicle,
} from '@gomoto/core'
import { useAuth } from '../../src/contexts/auth'
import { useTheme, type ThemeTokens } from '../../src/theme'
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Icon,
  IconCircle,
  ScreenHeader,
  SectionHeader,
  radius,
  type IconName,
  type Tone,
} from '../../src/components/ui'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function greeting(): string {
  const h = new Date().getHours()
  if (h < 12) return 'Bom dia'
  if (h < 18) return 'Boa tarde'
  return 'Boa noite'
}

function formatCurrency(value: number | null | undefined): string {
  if (value == null) return '—'
  return value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  const [y, m, d] = iso.split('-')
  return `${d}/${m}/${y}`
}

/**
 * Hoje no fuso do APARELHO. `toISOString()` devolve UTC: depois das 21h no
 * Brasil já é "amanhã", e a cobrança que vence hoje aparecia como vencida.
 */
function localTodayIso(): string {
  const d = new Date()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${mm}-${dd}`
}

function daysUntil(isoDate: string): number {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const due = new Date(isoDate + 'T00:00:00')
  return Math.round((due.getTime() - today.getTime()) / 86_400_000)
}

function dueLabel(isoDate: string): string {
  const days = daysUntil(isoDate)
  if (days === 0) return 'Vence hoje'
  if (days === 1) return 'Vence amanhã'
  return `Vence em ${days} dias · ${formatDate(isoDate)}`
}

const CYCLE_LABEL: Record<string, string> = {
  monthly: '/mês',
  weekly: '/semana',
}

const MAINTENANCE_STATUS: Record<string, { label: string; tone: Tone }> = {
  overdue:   { label: 'Vencida',   tone: 'danger' },
  upcoming:  { label: 'Próxima',   tone: 'pending' },
  scheduled: { label: 'Agendada',  tone: 'success' },
  completed: { label: 'Concluída', tone: 'neutral' },
}

type Styles = ReturnType<typeof createStyles>

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/** Placa no formato Mercosul — reconhecível de relance. */
function Plate({ value, styles }: { value: string; styles: Styles }) {
  return (
    <View style={styles.plate}>
      <View style={styles.plateStrip}>
        <Text style={styles.plateStripText}>BRASIL</Text>
      </View>
      <Text style={styles.plateText}>{value}</Text>
    </View>
  )
}

/** Veículo + contrato, na superfície de marca: o "cartão" da locação. */
function RentalHeroCard({ rental, styles, theme }: { rental: Rental; styles: Styles; theme: ThemeTokens }) {
  const vehicle = rental.vehicle
  const cycleLabel = CYCLE_LABEL[rental.cycle ?? ''] ?? ''
  const stats: { label: string; value: string }[] = [
    ...(rental.cycle_amount ? [{ label: 'Valor', value: `${formatCurrency(rental.cycle_amount)}${cycleLabel}` }] : []),
    { label: 'Início', value: formatDate(rental.start_date) },
    ...(rental.end_date ? [{ label: 'Término', value: formatDate(rental.end_date) }] : []),
  ]

  return (
    <Card variant="brand" padded={false}>
      {vehicle?.photo_url ? (
        <Image source={{ uri: vehicle.photo_url }} style={styles.heroPhoto} resizeMode="cover" />
      ) : null}
      <View style={styles.heroBody}>
        <View style={styles.heroTop}>
          <View style={styles.heroTitles}>
            <View style={styles.heroStatus}>
              <View style={[styles.heroStatusDot, { backgroundColor: theme.brandPositive }]} />
              <Text style={[styles.heroStatusText, { color: theme.brandPositive }]}>Locação ativa</Text>
            </View>
            <Text style={styles.heroModel} numberOfLines={1}>
              {vehicle ? `${vehicle.make} ${vehicle.model}` : 'Meu veículo'}
            </Text>
          </View>
          {vehicle?.license_plate ? <Plate value={vehicle.license_plate} styles={styles} /> : null}
        </View>

        <View style={styles.heroStats}>
          {stats.map((s, i) => (
            <View key={s.label} style={[styles.heroStat, i > 0 && styles.heroStatDivider]}>
              <Text style={styles.heroStatLabel}>{s.label}</Text>
              <Text style={styles.heroStatValue} numberOfLines={1} adjustsFontSizeToFit>{s.value}</Text>
            </View>
          ))}
        </View>
      </View>
    </Card>
  )
}

/** Situação financeira: vencidas têm precedência sobre o próximo pagamento. */
function PaymentCard({
  overdue,
  next,
  onPress,
  styles,
  theme,
}: {
  overdue: MyChargeRow[]
  next: MyChargeRow | undefined
  onPress: () => void
  styles: Styles
  theme: ThemeTokens
}) {
  if (overdue.length > 0) {
    const total = overdue.reduce((s, b) => s + b.amount_due, 0)
    return (
      <Card style={{ borderColor: theme.danger }}>
        <View style={styles.cardRow}>
          <IconCircle name="alert-circle" tone="danger" />
          <View style={styles.cardBody}>
            <Text style={[styles.cardEyebrow, { color: theme.danger }]}>
              {overdue.length > 1 ? `${overdue.length} cobranças vencidas` : 'Cobrança vencida'}
            </Text>
            <Text style={[styles.cardAmount, { color: theme.danger }]}>{formatCurrency(total)}</Text>
            <Text style={styles.cardMeta} numberOfLines={1}>
              Desde {formatDate(overdue[0]!.due_date)} · encargos podem ser acrescidos
            </Text>
          </View>
        </View>
        <Button label="Regularizar agora" variant="danger" onPress={onPress} style={styles.cardButton} />
      </Card>
    )
  }

  if (next) {
    return (
      <Card onPress={onPress}>
        <View style={styles.cardRow}>
          <IconCircle name="calendar-outline" tone="primary" />
          <View style={styles.cardBody}>
            <Text style={styles.cardEyebrow}>Próximo pagamento</Text>
            <Text style={styles.cardAmount}>{formatCurrency(next.amount_due)}</Text>
            <Text style={styles.cardMeta} numberOfLines={1}>{dueLabel(next.due_date)}</Text>
          </View>
          <Icon name="chevron-forward" size={20} color={theme.textMute} />
        </View>
      </Card>
    )
  }

  return (
    <Card onPress={onPress}>
      <View style={styles.cardRow}>
        <IconCircle name="checkmark-circle" tone="success" />
        <View style={styles.cardBody}>
          <Text style={styles.cardTitle}>Pagamentos em dia</Text>
          <Text style={styles.cardMeta}>Nenhuma cobrança em aberto agora.</Text>
        </View>
        <Icon name="chevron-forward" size={20} color={theme.textMute} />
      </View>
    </Card>
  )
}

function QuickAction({
  icon,
  label,
  onPress,
  styles,
}: {
  icon: IconName
  label: string
  onPress: () => void
  styles: Styles
}) {
  return (
    <Pressable
      style={({ pressed }) => [styles.quick, pressed && styles.pressed]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <IconCircle name={icon} tone="primary" size={44} />
      <Text style={styles.quickLabel} numberOfLines={1}>{label}</Text>
    </Pressable>
  )
}

function MaintenanceCard({
  maintenance,
  vehicle,
  onPress,
  styles,
  theme,
}: {
  maintenance: Maintenance
  vehicle: Vehicle | undefined
  onPress: () => void
  styles: Styles
  theme: ThemeTokens
}) {
  const status = calculateMaintenanceStatus({
    completed: maintenance.completed,
    predicted_km: maintenance.predicted_km,
    scheduled_date: maintenance.scheduled_date,
    current_km: vehicle?.km_current ?? 0,
  })
  const meta = MAINTENANCE_STATUS[status] ?? MAINTENANCE_STATUS.scheduled!
  return (
    <Card onPress={onPress}>
      <View style={styles.cardRow}>
        <IconCircle name="construct-outline" tone={meta.tone === 'success' ? 'primary' : meta.tone} />
        <View style={styles.cardBody}>
          <Text style={styles.cardTitle} numberOfLines={1}>{maintenance.description}</Text>
          {maintenance.scheduled_date ? (
            <Text style={styles.cardMeta}>Prevista para {formatDate(maintenance.scheduled_date)}</Text>
          ) : maintenance.predicted_km ? (
            <Text style={styles.cardMeta}>
              Aos {maintenance.predicted_km.toLocaleString('pt-BR')} km
            </Text>
          ) : null}
        </View>
        <Badge label={meta.label} tone={meta.tone} size="sm" />
        <Icon name="chevron-forward" size={20} color={theme.textMute} />
      </View>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export default function HomeTab() {
  const router = useRouter()
  const { tenants, activeTenantId } = useAuth()
  const theme = useTheme()
  const styles = useMemo(() => createStyles(theme), [theme])

  const rentalsQuery      = useRentals({ status: 'active' })
  const billingsQuery     = useMyCharges(true)
  const maintenancesQuery = useMaintenances()
  const vehiclesQuery     = useVehicles()

  useFocusEffect(
    useCallback(() => {
      void rentalsQuery.refetch()
      void billingsQuery.refetch()
      void maintenancesQuery.refetch()
      void vehiclesQuery.refetch()
    }, [rentalsQuery.refetch, billingsQuery.refetch, maintenancesQuery.refetch, vehiclesQuery.refetch]),
  )

  const isLoading = rentalsQuery.isLoading || billingsQuery.isLoading

  const isRefreshing =
    (rentalsQuery.isFetching && !rentalsQuery.isLoading) ||
    (billingsQuery.isFetching && !billingsQuery.isLoading)

  async function handleRefresh() {
    await Promise.all([
      rentalsQuery.refetch(),
      billingsQuery.refetch(),
      maintenancesQuery.refetch(),
      vehiclesQuery.refetch(),
    ])
  }

  // Locadora ativa
  const activeTenant = tenants.find((t) => t.id === activeTenantId)

  // Locação ativa (primeira — clientes normalmente têm uma)
  const activeRental: Rental | undefined = (rentalsQuery.data ?? [])[0]

  // Mapa de veículos para calcular status de manutenção
  const vehiclesById = useMemo(() => {
    const m = new Map<string, Vehicle>()
    for (const v of vehiclesQuery.data ?? []) m.set(v.id, v)
    return m
  }, [vehiclesQuery.data])

  const today = localTodayIso()

  // Cobranças vencidas (status overdue, ou pending com due_date < hoje)
  const overdueBillings = useMemo(() => {
    return (billingsQuery.data ?? [])
      .filter((b) => b.is_overdue || (b.status === 'open' && b.due_date < today))
      .sort((a, b) => a.due_date.localeCompare(b.due_date))
  }, [billingsQuery.data, today])

  // Próxima cobrança pendente (não vencida) — mais próxima por due_date
  const nextBilling: MyChargeRow | undefined = useMemo(() => {
    return (billingsQuery.data ?? [])
      .filter((b) => b.status === 'open' && !b.is_overdue && b.due_date >= today)
      .sort((a, b) => a.due_date.localeCompare(b.due_date))[0]
  }, [billingsQuery.data, today])

  // Manutenção mais urgente (overdue > upcoming > scheduled) filtrando só o veículo ativo
  const urgentMaintenance: Maintenance | undefined = useMemo(() => {
    const activeVehicleId = activeRental?.vehicle_id
    const STATUS_ORDER: Record<string, number> = { overdue: 0, upcoming: 1, scheduled: 2, completed: 99 }
    return (maintenancesQuery.data ?? [])
      .filter((m) => !m.completed && (!activeVehicleId || m.vehicle_id === activeVehicleId))
      .map((m) => ({
        m,
        status: calculateMaintenanceStatus({
          completed: m.completed,
          predicted_km: m.predicted_km,
          scheduled_date: m.scheduled_date,
          current_km: vehiclesById.get(m.vehicle_id)?.km_current ?? 0,
        }),
      }))
      .filter(({ status }) => status !== 'completed')
      .sort((a, b) => (STATUS_ORDER[a.status] ?? 99) - (STATUS_ORDER[b.status] ?? 99))
      .map(({ m }) => m)[0]
  }, [maintenancesQuery.data, activeRental?.vehicle_id, vehiclesById])

  const go = (path: string) => () => router.navigate(path as never)

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScreenHeader eyebrow={greeting()} title={activeTenant?.name ?? 'GoMoto'} />

      {isLoading ? (
        <View style={styles.centered}>
          <ActivityIndicator color={theme.primary} size="large" />
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          refreshControl={
            <RefreshControl refreshing={isRefreshing} onRefresh={handleRefresh} tintColor={theme.primary} />
          }
        >
          {!activeRental ? (
            <EmptyState
              icon="bicycle-outline"
              tone="primary"
              title="Sem locação ativa"
              text="Quando você tiver uma locação ativa, o veículo, os pagamentos e as manutenções aparecem aqui."
            />
          ) : (
            <>
              <RentalHeroCard rental={activeRental} styles={styles} theme={theme} />

              <View style={styles.quickRow}>
                <QuickAction icon="wallet-outline" label="Pagar" onPress={go('/(tabs)/cobrancas')} styles={styles} />
                <QuickAction icon="construct-outline" label="Manutenção" onPress={go('/(tabs)/manutencoes')} styles={styles} />
                <QuickAction icon="camera-outline" label="Vistoria" onPress={go('/(tabs)/vistorias')} styles={styles} />
                <QuickAction icon="chatbubbles-outline" label="Suporte" onPress={go('/(tabs)/suporte')} styles={styles} />
              </View>

              <View style={styles.section}>
                <SectionHeader title="Pagamentos" actionLabel="Ver todos" onAction={go('/(tabs)/cobrancas')} />
                <PaymentCard
                  overdue={overdueBillings}
                  next={nextBilling}
                  onPress={go('/(tabs)/cobrancas')}
                  styles={styles}
                  theme={theme}
                />
              </View>

              {urgentMaintenance && (
                <View style={styles.section}>
                  <SectionHeader title="Manutenção" actionLabel="Ver todas" onAction={go('/(tabs)/manutencoes')} />
                  <MaintenanceCard
                    maintenance={urgentMaintenance}
                    vehicle={vehiclesById.get(urgentMaintenance.vehicle_id)}
                    onPress={go('/(tabs)/manutencoes')}
                    styles={styles}
                    theme={theme}
                  />
                </View>
              )}
            </>
          )}
        </ScrollView>
      )}
    </SafeAreaView>
  )
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const createStyles = (theme: ThemeTokens) => StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: theme.bg,
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scrollContent: {
    paddingHorizontal: 16,
    paddingTop: 4,
    paddingBottom: 40,
    gap: 20,
  },
  section: {
    gap: 10,
  },
  pressed: {
    opacity: 0.7,
  },

  // Hero (superfície de marca)
  heroPhoto: {
    width: '100%',
    height: 170,
    backgroundColor: theme.brandBorder,
  },
  heroBody: {
    padding: 18,
    gap: 18,
  },
  heroTop: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  heroTitles: {
    flex: 1,
    gap: 4,
  },
  heroStatus: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  heroStatusDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
  },
  heroStatusText: {
    fontSize: 12,
    fontWeight: '700',
  },
  heroModel: {
    color: theme.brandText,
    fontSize: 20,
    fontWeight: '700',
    letterSpacing: -0.3,
  },
  // Placa real é igual em qualquer tema — cores fixas de propósito.
  plate: {
    backgroundColor: '#FFFFFF',
    borderRadius: 6,
    borderWidth: 1.5,
    borderColor: '#0C1424',
    overflow: 'hidden',
    alignItems: 'center',
    minWidth: 92,
  },
  plateStrip: {
    alignSelf: 'stretch',
    backgroundColor: '#1D4FC4',
    paddingVertical: 1,
    alignItems: 'center',
  },
  plateStripText: {
    color: '#FFFFFF',
    fontSize: 7,
    fontWeight: '800',
    letterSpacing: 1.5,
  },
  plateText: {
    color: '#0C1424',
    fontSize: 16,
    fontWeight: '800',
    letterSpacing: 1.5,
    paddingHorizontal: 8,
    paddingVertical: 2,
    fontVariant: ['tabular-nums'],
  },
  heroStats: {
    flexDirection: 'row',
    backgroundColor: theme.brandInset,
    borderRadius: radius.md,
    paddingVertical: 12,
  },
  heroStat: {
    flex: 1,
    paddingHorizontal: 12,
    gap: 2,
  },
  heroStatDivider: {
    borderLeftWidth: 1,
    borderLeftColor: theme.brandBorder,
  },
  heroStatLabel: {
    color: theme.brandTextSoft,
    fontSize: 11.5,
    fontWeight: '500',
  },
  heroStatValue: {
    color: theme.brandText,
    fontSize: 14,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },

  // Quick actions
  quickRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 8,
  },
  quick: {
    flex: 1,
    alignItems: 'center',
    gap: 8,
    paddingVertical: 14,
    backgroundColor: theme.surface,
    borderColor: theme.border,
    borderWidth: 1,
    borderRadius: radius.lg,
  },
  quickLabel: {
    color: theme.text,
    fontSize: 12,
    fontWeight: '600',
  },

  // Cards de informação
  cardRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  cardBody: {
    flex: 1,
    gap: 2,
  },
  cardEyebrow: {
    color: theme.textSoft,
    fontSize: 12.5,
    fontWeight: '600',
  },
  cardTitle: {
    color: theme.text,
    fontSize: 15,
    fontWeight: '600',
  },
  cardAmount: {
    color: theme.text,
    fontSize: 22,
    fontWeight: '800',
    letterSpacing: -0.5,
    fontVariant: ['tabular-nums'],
  },
  cardMeta: {
    color: theme.textSoft,
    fontSize: 13,
  },
  cardButton: {
    marginTop: 14,
  },
})
