/**
 * @file src/app/(dashboard)/configuracoes/aparencia/page.tsx
 * @description Aparência (ADR 0019) — direção de marca + modo de cor.
 * Preferência por operador, visível para todos os papéis.
 */

'use client'

import { useState, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { Palette, Save } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { cn } from '@/lib/utils'
import { useThemePreference } from '@gomoto/data'
import type { ThemeBrand, ColorMode } from '@gomoto/core'
import { updateThemePreferenceAction } from './actions'
import { SettingsHeader } from '../_components/SettingsHeader'
import { FeedbackMessage, type FeedbackState } from '../_components/FeedbackMessage'

const THEME_BRANDS: { value: ThemeBrand; label: string; description: string; swatch: string[] }[] = [
  { value: 'frota-confiavel', label: 'Frota Confiável', description: 'Azul, neutros frios — recomendado', swatch: ['#F8FAFC', '#2563EB', '#0F172A'] },
  { value: 'estrada', label: 'Estrada', description: 'Petróleo, neutros quentes', swatch: ['#FAFAF9', '#0D9488', '#1C1917'] },
  { value: 'sinalizacao', label: 'Sinalização', description: 'Laranja-ember, escuro por padrão', swatch: ['#0B0C10', '#F2790A', '#F4F5F7'] },
  { value: 'classico', label: 'Clássico', description: 'Verde-limão sobre preto — visual original', swatch: ['#121212', '#BAFF1A', '#FFFFFF'] },
]

const COLOR_MODES: { value: ColorMode; label: string }[] = [
  { value: 'system', label: 'Sistema' },
  { value: 'light', label: 'Claro' },
  { value: 'dark', label: 'Escuro' },
]

export default function AparenciaPage() {
  const router = useRouter()
  const themePreferenceQuery = useThemePreference()
  const [themeBrand, setThemeBrand] = useState<ThemeBrand>('frota-confiavel')
  const [colorMode, setColorMode] = useState<ColorMode>('system')
  const [isSavingTheme, setIsSavingTheme] = useState(false)
  const [themeFeedback, setThemeFeedback] = useState<FeedbackState | null>(null)

  useEffect(() => {
    if (themePreferenceQuery.data) {
      setThemeBrand(themePreferenceQuery.data.theme_brand)
      setColorMode(themePreferenceQuery.data.color_mode)
    }
  }, [themePreferenceQuery.data])

  /**
   * Pré-visualização ao vivo (ADR 0019): escrever os atributos direto no
   * <html> mostra o tema escolhido na hora, sem esperar salvar. Só roda em
   * resposta a clique do usuário — nunca no mount/carregamento da
   * preferência salva, pra não piscar o tema real por um instante.
   *
   * O layout raiz (Server Component) só reexecuta em reload completo ou
   * depois de `router.refresh()` — navegação client-side entre páginas do
   * dashboard não remonta ele. Sem o cleanup abaixo, uma pré-visualização
   * não salva "vazaria" pro resto do app ao trocar de tela (pela sidebar ou
   * pelo submenu de Configurações). `themeSavedRef` guarda se o usuário
   * confirmou com "Salvar Aparência"; se não confirmou, o unmount desta
   * página restaura o que estava persistido antes de qualquer clique.
   */
  const originalThemeRef = useRef<{ brand: string | null; mode: string | null } | null>(null)
  const themeSavedRef = useRef(false)

  useEffect(() => {
    if (originalThemeRef.current === null) {
      originalThemeRef.current = {
        brand: document.documentElement.getAttribute('data-brand'),
        mode: document.documentElement.getAttribute('data-mode'),
      }
    }
    return () => {
      if (themeSavedRef.current || !originalThemeRef.current) return
      const { brand, mode } = originalThemeRef.current
      if (brand) document.documentElement.setAttribute('data-brand', brand)
      if (mode) document.documentElement.setAttribute('data-mode', mode)
      else document.documentElement.removeAttribute('data-mode')
    }
  }, [])

  function handleSelectThemeBrand(brand: ThemeBrand) {
    setThemeBrand(brand)
    document.documentElement.setAttribute('data-brand', brand)
  }

  function handleSelectColorMode(mode: ColorMode) {
    setColorMode(mode)
    if (mode === 'system') {
      document.documentElement.removeAttribute('data-mode')
    } else {
      document.documentElement.setAttribute('data-mode', mode)
    }
  }

  async function handleSaveTheme() {
    setIsSavingTheme(true)
    setThemeFeedback(null)
    const result = await updateThemePreferenceAction({ theme_brand: themeBrand, color_mode: colorMode })
    if (!result.ok) {
      setThemeFeedback({ type: 'error', message: result.error?.message ?? 'Erro ao salvar aparência.' })
    } else {
      themeSavedRef.current = true
      setThemeFeedback({ type: 'success', message: 'Aparência atualizada.' })
      router.refresh()
    }
    setIsSavingTheme(false)
  }

  return (
    <section>
      <SettingsHeader
        icon={Palette}
        tone="primary"
        title="Aparência"
        description="Escolha a identidade visual e o modo de cor do sistema — vale só pra você, não muda pros outros operadores."
      />

      <Card>
        <div className="space-y-5">
          <div>
            <p className="text-[13px] text-fg-soft mb-2">Tema</p>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {THEME_BRANDS.map((brand) => (
                <button
                  key={brand.value}
                  type="button"
                  onClick={() => handleSelectThemeBrand(brand.value)}
                  className={cn(
                    'text-left rounded-xl border p-3 transition-colors',
                    themeBrand === brand.value ? 'border-primary bg-primary-tint' : 'border-border hover:border-fg-mute',
                  )}
                >
                  <div className="flex gap-1 mb-2">
                    {brand.swatch.map((hex) => (
                      <span
                        key={hex}
                        className="w-5 h-5 rounded-full border border-black/10"
                        style={{ backgroundColor: hex }}
                      />
                    ))}
                  </div>
                  <p className="text-[13px] font-medium text-fg">{brand.label}</p>
                  <p className="text-[11px] text-fg-mute mt-0.5">{brand.description}</p>
                </button>
              ))}
            </div>
          </div>

          <div>
            <p className="text-[13px] text-fg-soft mb-2">Modo de cor</p>
            <div className="inline-flex rounded-full border border-border p-1 gap-1">
              {COLOR_MODES.map((mode) => (
                <button
                  key={mode.value}
                  type="button"
                  onClick={() => handleSelectColorMode(mode.value)}
                  className={cn(
                    'h-8 px-4 rounded-full text-[12px] font-medium transition-colors',
                    colorMode === mode.value ? 'bg-primary text-primary-contrast' : 'text-fg-soft hover:text-fg',
                  )}
                >
                  {mode.label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center justify-between pt-2 gap-4">
            <FeedbackMessage feedback={themeFeedback} />
            <Button
              variant="primary"
              size="md"
              loading={isSavingTheme}
              onClick={handleSaveTheme}
              className="ml-auto flex-shrink-0"
            >
              <Save className="w-4 h-4" />
              Salvar Aparência
            </Button>
          </div>
        </div>
      </Card>
    </section>
  )
}
