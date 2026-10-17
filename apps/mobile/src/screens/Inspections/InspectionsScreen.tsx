import { useMemo, useState } from 'react'
import {
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import {
  usePendingInspectionSchedulesForCustomer,
  usePeriodicInspectionsForCustomer,
} from '@gomoto/data'
import type { Inspection, InspectionScheduleWithStatus } from '@gomoto/core'
import { InspectionSubmitModal } from './InspectionSubmitModal'
import { useRefreshOnFocus } from '../../hooks/useRefreshOnFocus'
import { useTheme, type ThemeTokens } from '../../theme'
import {
  Badge,
  Button,
  Card,
  EmptyState,
  IconCircle,
  ListItem,
  Notice,
  ScreenHeader,
  SegmentedControl,
  type Tone,
} from '../../components/ui'

const SCHEDULE_STATUS: Record<string, { label: string; tone: Tone }> = {
  pending: { label: 'Pendente', tone: 'primary' },
  overdue: { label: 'Atrasada', tone: 'warning' },
  rejected: { label: 'Rejeitada', tone: 'danger' },
}

const HISTORY_STATUS: Record<string, { label: string; tone: Tone }> = {
  submitted: { label: 'Em análise', tone: 'pending' },
  approved: { label: 'Aprovada', tone: 'success' },
  rejected: { label: 'Rejeitada', tone: 'danger' },
}

function formatDate(iso: string): string {
  const [y, m, d] = iso.split('-')
  return `${d}/${m}/${y}`
}

export function InspectionsScreen() {
  const [refreshing, setRefreshing] = useState(false)
  const [tab, setTab] = useState<'pending' | 'history'>('pending')
  const [selected, setSelected] = useState<InspectionScheduleWithStatus | null>(null)
  const theme = useTheme()
  const styles = useMemo(() => createStyles(theme), [theme])

  const pendingQuery = usePendingInspectionSchedulesForCustomer()
  const historyQuery = usePeriodicInspectionsForCustomer()

  // staleTime das vistorias é 60 s (useCustomerInspections).
  useRefreshOnFocus([pendingQuery], 60_000)

  async function handleRefresh() {
    setRefreshing(true)
    await Promise.all([pendingQuery.refetch(), tab === 'history' ? historyQuery.refetch() : Promise.resolve()])
    setRefreshing(false)
  }

  const pending = pendingQuery.data ?? []
  const history = historyQuery.data ?? []

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScreenHeader title="Vistorias" />

      {pendingQuery.isLoading ? (
        <View style={styles.centered}>
          <ActivityIndicator color={theme.primary} size="large" />
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={theme.primary} />}
        >
          <SegmentedControl
            value={tab}
            onChange={setTab}
            options={[
              { value: 'pending', label: 'Pendentes', count: pending.length },
              { value: 'history', label: 'Histórico' },
            ]}
          />

          {tab === 'pending' ? (
            pending.length === 0 ? (
              <EmptyState
                icon="camera-outline"
                tone="success"
                title="Nenhuma vistoria pendente"
                text="Vistorias periódicas aparecem aqui conforme a frequência combinada com a locadora."
              />
            ) : (
              pending.map((s) => {
                const meta = SCHEDULE_STATUS[s.status] ?? SCHEDULE_STATUS.pending!
                const rejected = s.status === 'rejected'
                return (
                  <Card key={s.id} onPress={() => setSelected(s)}>
                    <View style={styles.cardHeader}>
                      <IconCircle name="camera-outline" tone={meta.tone} />
                      <View style={styles.cardTitles}>
                        <Text style={styles.cardTitle}>Vistoria periódica</Text>
                        <Text style={styles.cardMeta}>Prazo: {formatDate(s.target_date)}</Text>
                      </View>
                      <Badge label={meta.label} tone={meta.tone} size="sm" />
                    </View>
                    {rejected && s.latest_inspection?.review_notes ? (
                      <View style={styles.cardBlock}>
                        <Notice tone="danger" title="Motivo da rejeição" text={s.latest_inspection.review_notes} />
                      </View>
                    ) : null}
                    <Button
                      label={rejected ? 'Reenviar vistoria' : 'Fazer vistoria'}
                      icon="camera"
                      size="md"
                      variant={s.status === 'pending' ? 'secondary' : 'primary'}
                      onPress={() => setSelected(s)}
                      style={styles.cardBlock}
                    />
                  </Card>
                )
              })
            )
          ) : historyQuery.isLoading ? (
            <View style={styles.inlineLoading}>
              <ActivityIndicator color={theme.primary} />
            </View>
          ) : history.length === 0 ? (
            <EmptyState
              icon="time-outline"
              title="Nenhuma vistoria enviada"
              text="As vistorias que você enviar ficam registradas aqui."
            />
          ) : (
            <Card padded={false}>
              {history.map((insp: Inspection, i) => {
                const meta = HISTORY_STATUS[insp.status] ?? HISTORY_STATUS.submitted!
                const date = (insp.executed_at ?? insp.created_at).slice(0, 10)
                return (
                  <ListItem
                    key={insp.id}
                    icon={insp.status === 'approved' ? 'checkmark-circle-outline' : 'camera-outline'}
                    iconTone={meta.tone}
                    label={`Enviada em ${formatDate(date)}`}
                    sublabel={insp.status === 'rejected' && insp.review_notes ? insp.review_notes : undefined}
                    trailing={<Badge label={meta.label} tone={meta.tone} size="sm" />}
                    last={i === history.length - 1}
                  />
                )
              })}
            </Card>
          )}
        </ScrollView>
      )}

      <InspectionSubmitModal
        schedule={selected}
        onClose={() => setSelected(null)}
        onSubmitted={() => {
          setSelected(null)
          void pendingQuery.refetch()
          void historyQuery.refetch()
        }}
      />
    </SafeAreaView>
  )
}

const createStyles = (theme: ThemeTokens) => StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.bg },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 60 },
  scrollContent: { paddingHorizontal: 16, paddingTop: 4, paddingBottom: 40, gap: 14 },
  inlineLoading: { paddingVertical: 32, alignItems: 'center' },
  cardHeader: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  cardTitles: { flex: 1, gap: 2 },
  cardTitle: { color: theme.text, fontSize: 15, fontWeight: '600' },
  cardMeta: { color: theme.textSoft, fontSize: 13 },
  cardBlock: { marginTop: 12 },
})
