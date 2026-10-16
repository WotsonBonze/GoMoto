import { useMemo, useState } from 'react'
import {
  Alert,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import * as ImagePicker from 'expo-image-picker'
import { useCreateMaintenanceRecord } from '@gomoto/data'
import type { Maintenance } from '@gomoto/core'
import { useTheme, type ThemeTokens } from '../theme'
import { Button, Icon, IconCircle, ModalHeader, Notice, TextField, radius } from './ui'

type PickedPhoto = {
  uri: string
  contentType: string
  body: ArrayBuffer
}

type Styles = ReturnType<typeof createStyles>

type Props = {
  visible: boolean
  onClose: () => void
  customerId: string
  maintenance: Maintenance | null
}

// Quando o cliente fecha uma preventiva agendada, vinculamos via maintenance_id.
// Quando o item ainda não está no plano (corretiva avulsa), maintenance fica null
// e a aprovação no web decide se cria uma `maintenances` ou descarta.
export function RegisterMaintenanceModal({ visible, onClose, customerId, maintenance }: Props) {
  const [actualKm, setActualKm] = useState('')
  const [workshop, setWorkshop] = useState('')
  const [cost, setCost] = useState('')
  const [notes, setNotes] = useState('')
  const [odometerPhoto, setOdometerPhoto] = useState<PickedPhoto | null>(null)
  const [invoicePhoto, setInvoicePhoto] = useState<PickedPhoto | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const theme = useTheme()
  const styles = useMemo(() => createStyles(theme), [theme])

  const create = useCreateMaintenanceRecord()

  function resetForm() {
    setActualKm('')
    setWorkshop('')
    setCost('')
    setNotes('')
    setOdometerPhoto(null)
    setInvoicePhoto(null)
  }

  function handleClose() {
    if (submitting) return
    resetForm()
    onClose()
  }

  async function pickPhoto(kind: 'odometer' | 'invoice') {
    // Só câmera: a foto precisa ser tirada na hora (sem acesso à galeria).
    const perm = await ImagePicker.requestCameraPermissionsAsync()
    if (!perm.granted) {
      Alert.alert(
        'Câmera não autorizada',
        'Para tirar a foto, permita o acesso à câmera nos ajustes do aparelho.',
      )
      return
    }
    const result = await ImagePicker.launchCameraAsync({
      // default já é 'images'; explicitar evita o warn de MediaTypeOptions
      // deprecado e ainda mantém intenção no call site.
      mediaTypes: ['images'],
      quality: 0.7,
      allowsEditing: false,
    })
    if (result.canceled || !result.assets[0]) return
    const asset = result.assets[0]
    // No RN, blob vindo de fetch(uri).blob() faz upload vazio no Supabase storage.
    // Convertendo pra ArrayBuffer o binário chega íntegro.
    const res = await fetch(asset.uri)
    const buf = await res.arrayBuffer()
    const contentType = asset.mimeType ?? guessTypeFromUri(asset.uri)
    const photo: PickedPhoto = { uri: asset.uri, contentType, body: buf }
    if (kind === 'odometer') setOdometerPhoto(photo)
    else setInvoicePhoto(photo)
  }

  async function handleSubmit() {
    if (!maintenance) return
    const kmNum = parseInt(actualKm.replace(/\D/g, ''), 10)
    if (!Number.isFinite(kmNum) || kmNum < 0) {
      Alert.alert('KM inválido', 'Informe a quilometragem atual da moto.')
      return
    }
    const costNum = cost.trim()
      ? Number(cost.replace(/\./g, '').replace(',', '.'))
      : null
    if (costNum != null && (!Number.isFinite(costNum) || costNum < 0)) {
      Alert.alert('Custo inválido', 'Informe um valor numérico (ex.: 250,00) ou deixe em branco.')
      return
    }
    if (!odometerPhoto) {
      Alert.alert('Foto do hodômetro', 'Tire uma foto do painel da moto para comprovar a KM.')
      return
    }
    setSubmitting(true)
    try {
      await create.mutateAsync({
        customer_id: customerId,
        vehicle_id: maintenance.vehicle_id,
        maintenance_id: maintenance.id,
        actual_km: kmNum,
        cost: costNum,
        workshop: workshop.trim() || null,
        notes: notes.trim() || null,
        odometer_photo: { body: odometerPhoto.body, contentType: odometerPhoto.contentType },
        invoice_photo: invoicePhoto
          ? { body: invoicePhoto.body, contentType: invoicePhoto.contentType }
          : null,
      })
      Alert.alert(
        'Enviado pra aprovação',
        'A locadora vai revisar e confirmar a manutenção. Você pode acompanhar pelo histórico.',
      )
      resetForm()
      onClose()
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Erro desconhecido'
      Alert.alert('Não deu pra registrar', msg)
    } finally {
      setSubmitting(false)
    }
  }

  const predicted = maintenance?.predicted_km
    ? `KM previsto: ${maintenance.predicted_km.toLocaleString('pt-BR')}`
    : undefined

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={handleClose}>
      <SafeAreaView style={styles.flex} edges={['top', 'bottom']}>
        <KeyboardAvoidingView
          style={styles.flex}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <ModalHeader
            title="Registrar conclusão"
            subtitle={maintenance ? maintenance.description || maintenance.type : undefined}
            onClose={handleClose}
            disabled={submitting}
          />
          <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent} keyboardShouldPersistTaps="handled">
            <Notice
              tone="info"
              text="Informe os dados do serviço. A locadora revisa e confirma — você acompanha pelo histórico."
            />

            <TextField
              label="KM atual da moto"
              icon="speedometer-outline"
              value={actualKm}
              onChangeText={setActualKm}
              keyboardType="numeric"
              placeholder="Ex.: 45200"
              hint={predicted}
            />

            <PhotoSlot
              label="Foto do hodômetro"
              hint="Foto do painel mostrando a quilometragem"
              photo={odometerPhoto}
              onPress={() => pickPhoto('odometer')}
              onClear={() => setOdometerPhoto(null)}
              styles={styles}
              theme={theme}
            />

            <TextField
              label="Oficina"
              optional
              icon="storefront-outline"
              value={workshop}
              onChangeText={setWorkshop}
              placeholder="Nome da oficina"
            />

            <TextField
              label="Custo total (R$)"
              optional
              icon="cash-outline"
              value={cost}
              onChangeText={setCost}
              keyboardType="decimal-pad"
              placeholder="Ex.: 250,00"
            />

            <TextField
              label="Observações"
              optional
              value={notes}
              onChangeText={setNotes}
              multiline
              numberOfLines={3}
              placeholder="Peças trocadas, observações da oficina..."
            />

            <PhotoSlot
              label="Foto da nota fiscal"
              optional
              hint="Comprovante do serviço"
              photo={invoicePhoto}
              onPress={() => pickPhoto('invoice')}
              onClear={() => setInvoicePhoto(null)}
              styles={styles}
              theme={theme}
            />
          </ScrollView>
          <View style={styles.footer}>
            <Button
              label="Enviar para aprovação"
              icon="paper-plane-outline"
              onPress={handleSubmit}
              loading={submitting}
            />
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  )
}

function PhotoSlot({
  label,
  hint,
  optional,
  photo,
  onPress,
  onClear,
  styles,
  theme,
}: {
  label: string
  hint: string
  optional?: boolean
  photo: PickedPhoto | null
  onPress: () => void
  onClear: () => void
  styles: Styles
  theme: ThemeTokens
}) {
  return (
    <View style={styles.slotWrap}>
      <Text style={styles.slotLabel}>
        {label}
        {optional ? <Text style={styles.slotOptional}> (opcional)</Text> : null}
      </Text>
      {photo ? (
        <View style={styles.photoFilled}>
          <Image source={{ uri: photo.uri }} style={styles.photoThumb} />
          <View style={styles.photoInfo}>
            <View style={styles.photoOk}>
              <Icon name="checkmark-circle" size={16} color={theme.success} />
              <Text style={[styles.photoOkText, { color: theme.success }]}>Foto anexada</Text>
            </View>
            <View style={styles.photoActions}>
              <Pressable onPress={onPress} hitSlop={8}>
                <Text style={styles.photoActionText}>Trocar</Text>
              </Pressable>
              <Pressable onPress={onClear} hitSlop={8}>
                <Text style={[styles.photoActionText, styles.photoRemove]}>Remover</Text>
              </Pressable>
            </View>
          </View>
        </View>
      ) : (
        <Pressable
          style={({ pressed }) => [styles.photoEmpty, pressed && styles.pressed]}
          onPress={onPress}
          accessibilityRole="button"
          accessibilityLabel={`Adicionar ${label}`}
        >
          <IconCircle name="camera-outline" tone="primary" size={44} />
          <View style={styles.photoEmptyTexts}>
            <Text style={styles.photoEmptyTitle}>Adicionar foto</Text>
            <Text style={styles.photoEmptyHint}>{hint}</Text>
          </View>
        </Pressable>
      )}
    </View>
  )
}

function guessTypeFromUri(uri: string): string {
  const lower = uri.toLowerCase()
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.heic') || lower.endsWith('.heif')) return 'image/heic'
  if (lower.endsWith('.gif')) return 'image/gif'
  return 'image/jpeg'
}

const createStyles = (theme: ThemeTokens) => StyleSheet.create({
  flex: { flex: 1, backgroundColor: theme.bg },
  body: { flex: 1 },
  bodyContent: { padding: 16, paddingTop: 4, paddingBottom: 32, gap: 18 },
  pressed: { opacity: 0.8 },
  slotWrap: { gap: 6 },
  slotLabel: { color: theme.text, fontSize: 14, fontWeight: '600' },
  slotOptional: { color: theme.textMute, fontWeight: '400' },
  photoEmpty: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: theme.surface,
    borderColor: theme.border,
    borderStyle: 'dashed',
    borderWidth: 1.5,
    borderRadius: radius.md,
    padding: 14,
  },
  photoEmptyTexts: { flex: 1, gap: 2 },
  photoEmptyTitle: { color: theme.primary, fontSize: 15, fontWeight: '600' },
  photoEmptyHint: { color: theme.textSoft, fontSize: 13 },
  photoFilled: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: theme.surface,
    borderColor: theme.border,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: 10,
  },
  photoThumb: { width: 64, height: 64, borderRadius: radius.sm, backgroundColor: theme.surfaceAlt },
  photoInfo: { flex: 1, gap: 8 },
  photoOk: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  photoOkText: { fontSize: 14, fontWeight: '600' },
  photoActions: { flexDirection: 'row', gap: 20 },
  photoActionText: { color: theme.primary, fontSize: 14, fontWeight: '600' },
  photoRemove: { color: theme.danger },
  footer: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 8,
    borderTopColor: theme.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    backgroundColor: theme.surface,
  },
})
