import { useEffect, useMemo, useState } from 'react'
import {
  ActivityIndicator,
  Alert,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import * as ImagePicker from 'expo-image-picker'
import { useSupabaseContext, useRequiredTenantId, usePeriodicInspectionProfileForRental } from '@gomoto/data'
import type { InspectionScheduleWithStatus } from '@gomoto/core'
import { supabase } from '../../lib/supabase'
import { useTheme, type ThemeTokens } from '../../theme'
import { Button, Card, EmptyState, Icon, ModalHeader, SectionHeader, radius } from '../../components/ui'

type AnswerDraft = { status: 'ok' | 'not_ok' | null; note: string }
type PhotoDraft = { uri: string; storage_path: string | null; uploading: boolean }

type Props = {
  schedule: InspectionScheduleWithStatus | null
  onClose: () => void
  onSubmitted: () => void
}

function guessTypeFromUri(uri: string): string {
  const lower = uri.toLowerCase()
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.webp')) return 'image/webp'
  return 'image/jpeg'
}

async function submitInspection(scheduleId: string, payload: unknown) {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) throw new Error('Não autenticado')
  const webUrl = process.env.EXPO_PUBLIC_WEB_URL ?? ''
  if (!webUrl) throw new Error('EXPO_PUBLIC_WEB_URL não configurado')
  const res = await fetch(`${webUrl}/api/inspections/schedules/${scheduleId}/submit`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const json = await res.json()
  if (!json.ok) throw new Error(json.error?.message ?? 'Falha ao enviar vistoria')
  return json.data as { id: string }
}

export function InspectionSubmitModal({ schedule, onClose, onSubmitted }: Props) {
  const client = useSupabaseContext()
  const getTenantId = useRequiredTenantId()
  const profileQuery = usePeriodicInspectionProfileForRental(schedule?.rental_id)

  const [answers, setAnswers] = useState<Record<string, AnswerDraft>>({})
  const [photos, setPhotos] = useState<Record<string, PhotoDraft>>({})
  const [submitting, setSubmitting] = useState(false)
  const theme = useTheme()
  const styles = useMemo(() => createStyles(theme), [theme])

  useEffect(() => {
    if (!schedule) {
      setAnswers({})
      setPhotos({})
    }
  }, [schedule])

  useEffect(() => {
    if (!profileQuery.data) return
    const nextAnswers: Record<string, AnswerDraft> = {}
    for (const item of profileQuery.data.checklist_items ?? []) nextAnswers[item.id] = { status: null, note: '' }
    setAnswers(nextAnswers)
    const nextPhotos: Record<string, PhotoDraft> = {}
    for (const item of profileQuery.data.photo_items ?? []) nextPhotos[item.id] = { uri: '', storage_path: null, uploading: false }
    setPhotos(nextPhotos)
  }, [profileQuery.data])

  async function pickPhoto(itemId: string) {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync()
    if (!perm.granted) {
      Alert.alert('Permissão negada', 'Precisamos de acesso às fotos para anexar a vistoria.')
      return
    }
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.7 })
    if (result.canceled || !result.assets[0]) return
    const asset = result.assets[0]

    setPhotos((prev) => ({ ...prev, [itemId]: { uri: asset.uri, storage_path: null, uploading: true } }))
    try {
      const res = await fetch(asset.uri)
      const buf = await res.arrayBuffer()
      const contentType = asset.mimeType ?? guessTypeFromUri(asset.uri)
      const ext = contentType === 'image/png' ? 'png' : contentType === 'image/webp' ? 'webp' : 'jpg'
      const tenantId = getTenantId()
      // inspection_id ainda não existe neste ponto (só nasce ao submeter) —
      // usa schedule_id como âncora do path, igualmente única por tenant.
      const path = `${tenantId}/${schedule!.id}/${itemId}.${ext}`
      const { error } = await client.storage.from('inspection-photos').upload(path, buf, { contentType, upsert: true })
      if (error) {
        Alert.alert('Erro no upload', error.message)
        setPhotos((prev) => ({ ...prev, [itemId]: { uri: '', storage_path: null, uploading: false } }))
        return
      }
      setPhotos((prev) => ({ ...prev, [itemId]: { uri: asset.uri, storage_path: path, uploading: false } }))
    } catch (err: unknown) {
      Alert.alert('Erro no upload', err instanceof Error ? err.message : 'Erro desconhecido')
      setPhotos((prev) => ({ ...prev, [itemId]: { uri: '', storage_path: null, uploading: false } }))
    }
  }

  async function handleSubmit() {
    if (!schedule || !profileQuery.data) return
    const checklistItems = profileQuery.data.checklist_items ?? []
    const photoItems = profileQuery.data.photo_items ?? []

    for (const item of checklistItems) {
      if (!answers[item.id]?.status) {
        Alert.alert('Checklist incompleto', `Responda o item "${item.name}".`)
        return
      }
    }
    const missing = photoItems.find((item) => item.is_required && !photos[item.id]?.storage_path)
    if (missing) {
      Alert.alert('Foto obrigatória', `Envie a foto "${missing.label}".`)
      return
    }

    setSubmitting(true)
    try {
      await submitInspection(schedule.id, {
        answers: checklistItems.map((item) => ({
          item_id: item.id,
          status: answers[item.id].status,
          note: answers[item.id].note.trim() || undefined,
        })),
        photos: photoItems
          .filter((item) => photos[item.id]?.storage_path)
          .map((item) => ({ item_id: item.id, storage_path: photos[item.id].storage_path })),
      })
      Alert.alert('Vistoria enviada', 'A locadora vai analisar e confirmar em breve.')
      onSubmitted()
    } catch (err: unknown) {
      Alert.alert('Não foi possível enviar', err instanceof Error ? err.message : 'Erro desconhecido')
    } finally {
      setSubmitting(false)
    }
  }

  if (!schedule) return null

  const checklist = profileQuery.data?.checklist_items ?? []
  const photoItems = profileQuery.data?.photo_items ?? []
  const answered = checklist.filter((item) => answers[item.id]?.status).length
  const requiredPhotos = photoItems.filter((item) => item.is_required)
  const sentRequired = requiredPhotos.filter((item) => photos[item.id]?.storage_path).length
  const totalSteps = checklist.length + requiredPhotos.length
  const doneSteps = answered + sentRequired
  const progress = totalSteps > 0 ? doneSteps / totalSteps : 0

  function setStatus(itemId: string, status: 'ok' | 'not_ok') {
    setAnswers((prev) => ({ ...prev, [itemId]: { ...prev[itemId], status } }))
  }

  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={styles.flex} edges={['top', 'bottom']}>
        <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <ModalHeader
            title="Vistoria periódica"
            subtitle={`Prazo: ${schedule.target_date.split('-').reverse().join('/')}`}
            onClose={onClose}
            disabled={submitting}
          />

          {profileQuery.isLoading ? (
            <View style={styles.centered}>
              <ActivityIndicator color={theme.primary} size="large" />
            </View>
          ) : !profileQuery.data ? (
            <EmptyState
              icon="alert-circle-outline"
              tone="danger"
              title="Checklist indisponível"
              text="Não foi possível carregar o checklist desta vistoria. Tente novamente em instantes."
            />
          ) : (
            <>
              {/* Progresso: o que falta para poder enviar */}
              <View style={styles.progressWrap}>
                <View style={styles.progressTrack}>
                  <View style={[styles.progressFill, { width: `${Math.round(progress * 100)}%` }]} />
                </View>
                <Text style={styles.progressText}>
                  {doneSteps} de {totalSteps} obrigatórios concluídos
                </Text>
              </View>

              <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent} keyboardShouldPersistTaps="handled">
                <SectionHeader title="Checklist" trailing={`${answered}/${checklist.length}`} />
                {checklist.map((item) => {
                  const draft = answers[item.id]
                  const ok = draft?.status === 'ok'
                  const notOk = draft?.status === 'not_ok'
                  return (
                    <Card key={item.id} style={notOk ? { borderColor: theme.danger } : undefined}>
                      <Text style={styles.checklistName}>{item.name}</Text>
                      <View style={styles.choiceRow}>
                        <Pressable
                          style={[styles.choice, ok && { backgroundColor: theme.successBg, borderColor: theme.success }]}
                          onPress={() => setStatus(item.id, 'ok')}
                          accessibilityRole="radio"
                          accessibilityState={{ checked: ok }}
                        >
                          <Icon name={ok ? 'checkmark-circle' : 'checkmark-circle-outline'} size={18} color={ok ? theme.success : theme.textSoft} />
                          <Text style={[styles.choiceText, ok && { color: theme.success }]}>Tudo certo</Text>
                        </Pressable>
                        <Pressable
                          style={[styles.choice, notOk && { backgroundColor: theme.dangerBg, borderColor: theme.danger }]}
                          onPress={() => setStatus(item.id, 'not_ok')}
                          accessibilityRole="radio"
                          accessibilityState={{ checked: notOk }}
                        >
                          <Icon name={notOk ? 'close-circle' : 'close-circle-outline'} size={18} color={notOk ? theme.danger : theme.textSoft} />
                          <Text style={[styles.choiceText, notOk && { color: theme.danger }]}>Com problema</Text>
                        </Pressable>
                      </View>
                      <TextInput
                        value={draft?.note ?? ''}
                        onChangeText={(v) => setAnswers((prev) => ({ ...prev, [item.id]: { ...prev[item.id], note: v } }))}
                        placeholder={notOk ? 'Descreva o problema' : 'Observação (opcional)'}
                        placeholderTextColor={theme.textMute}
                        style={styles.noteInput}
                      />
                    </Card>
                  )
                })}

                <View style={styles.photosHeader}>
                  <SectionHeader title="Fotos" trailing={`${sentRequired}/${requiredPhotos.length} obrigatórias`} />
                </View>
                <View style={styles.photoGrid}>
                  {photoItems.map((item) => {
                    const draft = photos[item.id]
                    const done = !!draft?.storage_path
                    return (
                      <Pressable
                        key={item.id}
                        style={({ pressed }) => [
                          styles.photoSlot,
                          done && styles.photoSlotDone,
                          pressed && styles.pressed,
                        ]}
                        onPress={() => pickPhoto(item.id)}
                        accessibilityRole="button"
                        accessibilityLabel={`Foto: ${item.label}`}
                      >
                        {draft?.uploading ? (
                          <ActivityIndicator color={theme.primary} />
                        ) : draft?.uri ? (
                          <>
                            <Image source={{ uri: draft.uri }} style={styles.photoThumb} />
                            {done ? (
                              <View style={styles.photoCheck}>
                                <Icon name="checkmark" size={12} color="#FFFFFF" />
                              </View>
                            ) : null}
                          </>
                        ) : (
                          <Icon name="camera-outline" size={26} color={theme.primary} />
                        )}
                        <Text style={styles.photoSlotLabel} numberOfLines={2}>
                          {item.label}
                          {item.is_required ? <Text style={{ color: theme.danger }}> *</Text> : null}
                        </Text>
                      </Pressable>
                    )
                  })}
                </View>
              </ScrollView>
              <View style={styles.footer}>
                <Button
                  label="Enviar vistoria"
                  icon="paper-plane-outline"
                  onPress={handleSubmit}
                  loading={submitting}
                />
              </View>
            </>
          )}
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  )
}

const createStyles = (theme: ThemeTokens) => StyleSheet.create({
  flex: { flex: 1, backgroundColor: theme.bg },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 20 },
  pressed: { opacity: 0.8 },
  progressWrap: { paddingHorizontal: 20, paddingBottom: 12, gap: 6 },
  progressTrack: { height: 6, borderRadius: 3, backgroundColor: theme.surfaceAlt, overflow: 'hidden' },
  progressFill: { height: '100%', borderRadius: 3, backgroundColor: theme.primary },
  progressText: { color: theme.textSoft, fontSize: 12.5 },
  body: { flex: 1 },
  bodyContent: { padding: 16, paddingTop: 4, paddingBottom: 32, gap: 12 },
  checklistName: { color: theme.text, fontSize: 15, fontWeight: '600' },
  choiceRow: { flexDirection: 'row', gap: 8, marginTop: 12 },
  choice: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    minHeight: 44,
    borderRadius: radius.md,
    borderWidth: 1.5,
    borderColor: theme.border,
    backgroundColor: theme.surface,
  },
  choiceText: { color: theme.textSoft, fontSize: 14, fontWeight: '600' },
  noteInput: {
    marginTop: 10,
    backgroundColor: theme.surfaceAlt,
    borderRadius: radius.sm + 2,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: theme.text,
    fontSize: 14,
  },
  photosHeader: { marginTop: 12 },
  photoGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  photoSlot: {
    width: '31%',
    aspectRatio: 0.9,
    backgroundColor: theme.surface,
    borderColor: theme.border,
    borderWidth: 1.5,
    borderStyle: 'dashed',
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 6,
    gap: 6,
  },
  photoSlotDone: { borderStyle: 'solid', borderColor: theme.success },
  photoSlotLabel: { color: theme.textSoft, fontSize: 11.5, textAlign: 'center', fontWeight: '500' },
  photoThumb: { width: '100%', height: '62%', borderRadius: radius.sm },
  photoCheck: {
    position: 'absolute',
    top: 8,
    right: 8,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: theme.success,
    alignItems: 'center',
    justifyContent: 'center',
  },
  footer: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 8,
    borderTopColor: theme.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    backgroundColor: theme.surface,
  },
})
