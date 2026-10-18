'use client'

import { useEffect, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { ExternalLink, ImagePlus, Trash2 } from 'lucide-react'
import { updateTenantLoginBranding } from '../../actions'

type LogoKind = 'dark' | 'light'

const LOGO_FIELD: Record<LogoKind, string> = { dark: 'logo', light: 'logo_light' }

/**
 * "Login personalizado" (ADR 0042): o admin da plataforma define o subdomínio
 * e envia os logos que substituem o logo Locaw em `{sub}.{rootDomain}/login`.
 */
export function LoginBrandingForm({
  tenantId,
  rootDomain,
  initialSubdomain,
  logoUrl,
  logoLightUrl,
}: {
  tenantId: string
  rootDomain: string
  initialSubdomain: string | null
  logoUrl: string | null
  logoLightUrl: string | null
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [subdomain, setSubdomain] = useState(initialSubdomain ?? '')
  const [files, setFiles] = useState<Partial<Record<LogoKind, File>>>({})
  const [removed, setRemoved] = useState<Partial<Record<LogoKind, boolean>>>({})
  const [previews, setPreviews] = useState<Partial<Record<LogoKind, string>>>({})
  const [error, setError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [saved, setSaved] = useState(false)

  // Object URLs das prévias: liberados ao trocar/remover o arquivo e ao sair da tela.
  const previewUrls = useRef(previews)
  previewUrls.current = previews
  useEffect(() => () => Object.values(previewUrls.current).forEach((url) => url && URL.revokeObjectURL(url)), [])

  function dropPreview(kind: LogoKind) {
    const url = previewUrls.current[kind]
    if (url) URL.revokeObjectURL(url)
  }

  const current: Record<LogoKind, string | null> = {
    dark: previews.dark ?? (removed.dark ? null : logoUrl),
    light: previews.light ?? (removed.light ? null : logoLightUrl),
  }
  const dirty =
    subdomain.trim().toLowerCase() !== (initialSubdomain ?? '') ||
    Object.keys(files).length > 0 ||
    Object.values(removed).some(Boolean)

  function pickFile(kind: LogoKind, file: File | undefined) {
    if (!file) return
    setSaved(false)
    dropPreview(kind)
    setFiles((prev) => ({ ...prev, [kind]: file }))
    setRemoved((prev) => ({ ...prev, [kind]: false }))
    setPreviews((prev) => ({ ...prev, [kind]: URL.createObjectURL(file) }))
  }

  function removeLogo(kind: LogoKind) {
    setSaved(false)
    dropPreview(kind)
    setFiles(({ [kind]: _file, ...rest }) => rest)
    setPreviews(({ [kind]: _url, ...rest }) => rest)
    setRemoved((prev) => ({ ...prev, [kind]: true }))
  }

  function handleSave() {
    setError(null)
    setFieldErrors({})
    const formData = new FormData()
    formData.set('login_subdomain', subdomain)
    for (const kind of ['dark', 'light'] as const) {
      const file = files[kind]
      if (file) formData.set(LOGO_FIELD[kind], file)
      else if (removed[kind]) formData.set(`remove_${LOGO_FIELD[kind]}`, '1')
    }

    startTransition(async () => {
      const result = await updateTenantLoginBranding(tenantId, formData)
      if ('error' in result && result.error) {
        setError(result.error)
        const issues = (result as { fieldErrors?: { path: string; message: string }[] }).fieldErrors ?? []
        setFieldErrors(Object.fromEntries(issues.map((i) => [i.path, i.message])))
        return
      }
      Object.keys(previewUrls.current).forEach((kind) => dropPreview(kind as LogoKind))
      setFiles({})
      setRemoved({})
      setPreviews({})
      setSaved(true)
      router.refresh()
    })
  }

  const loginUrl = initialSubdomain ? `https://${initialSubdomain}.${rootDomain}/login` : null

  return (
    <div className="login-brand space-y-5 px-4 py-4">
      {/* Subdomínio */}
      <div className="space-y-1.5">
        <label htmlFor="login_subdomain" className="text-[13px] text-fg-soft">Subdomínio do login</label>
        <div className="flex items-center h-9 rounded-lg border border-border bg-surface-2 focus-within:border-primary overflow-hidden max-w-md">
          <input
            id="login_subdomain"
            value={subdomain}
            onChange={(e) => { setSubdomain(e.target.value.toLowerCase()); setSaved(false) }}
            placeholder="minhalocadora"
            autoComplete="off"
            spellCheck={false}
            className="flex-1 min-w-0 h-full px-3 bg-transparent text-[13px] text-fg font-mono placeholder:text-fg-mute focus:outline-none"
          />
          <span className="px-3 text-[13px] text-fg-mute font-mono border-l border-border h-full flex items-center">.{rootDomain}</span>
        </div>
        {fieldErrors.login_subdomain ? (
          <p className="text-[12px] text-danger">{fieldErrors.login_subdomain}</p>
        ) : (
          <p className="text-[12px] text-fg-mute">Deixe vazio para usar o login padrão Locaw.</p>
        )}
        {loginUrl && (
          <a href={loginUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[12px] text-primary hover:underline">
            {loginUrl} <ExternalLink className="w-3 h-3" />
          </a>
        )}
      </div>

      {/* Logos */}
      <div className="grid gap-4 sm:grid-cols-2">
        <LogoSlot
          kind="dark"
          title="Logo para fundo escuro"
          hint="Painel de marca do login. Sem logo, o login mostra o Locaw com o nome da empresa no rodapé."
          url={current.dark}
          error={fieldErrors.logo}
          onPick={pickFile}
          onRemove={removeLogo}
        />
        <LogoSlot
          kind="light"
          title="Logo para fundo claro"
          hint="Login no celular. Opcional — sem ele, usa o de fundo escuro."
          url={current.light}
          error={fieldErrors.logo_light}
          onPick={pickFile}
          onRemove={removeLogo}
        />
      </div>
      <p className="text-[12px] text-fg-mute">PNG, WebP ou JPG, até 1 MB. Prefira fundo transparente e formato horizontal.</p>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={handleSave}
          disabled={!dirty || isPending}
          className="inline-flex items-center h-9 px-4 rounded-full bg-primary text-primary-contrast text-[13px] font-medium hover:bg-primary-hover transition-colors disabled:opacity-50"
        >
          {isPending ? 'Salvando…' : 'Salvar login personalizado'}
        </button>
        {saved && !dirty && <span className="text-[12px] text-success">Salvo</span>}
        {error && !Object.keys(fieldErrors).length && <span className="text-[12px] text-danger">{error}</span>}
      </div>
    </div>
  )
}

function LogoSlot({
  kind,
  title,
  hint,
  url,
  error,
  onPick,
  onRemove,
}: {
  kind: LogoKind
  title: string
  hint: string
  url: string | null
  error?: string
  onPick: (kind: LogoKind, file: File | undefined) => void
  onRemove: (kind: LogoKind) => void
}) {
  const inputId = `login-logo-${kind}`
  return (
    <div className="space-y-1.5">
      <p className="text-[13px] text-fg-soft">{title}</p>
      {/* Prévia no mesmo fundo em que o logo aparece no login. */}
      <div
        className={`h-24 rounded-xl border border-divider flex items-center justify-center px-4 ${
          kind === 'dark' ? 'bg-[var(--login-ink)]' : 'bg-[var(--login-paper)]'
        }`}
      >
        {url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={url} alt={title} className="max-h-12 max-w-full object-contain" />
        ) : (
          <span className={`text-[12px] ${kind === 'dark' ? 'text-[var(--login-ink-fg)]' : 'text-[var(--login-paper-mute)]'}`}>
            Sem logo — usa Locaw
          </span>
        )}
      </div>
      <div className="flex items-center gap-2">
        <label
          htmlFor={inputId}
          className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg bg-surface-2 text-fg-mute text-[13px] font-medium hover:bg-divider hover:text-fg transition-colors cursor-pointer"
        >
          <ImagePlus className="w-3.5 h-3.5" />
          {url ? 'Trocar' : 'Enviar'}
        </label>
        <input
          id={inputId}
          type="file"
          accept="image/png,image/webp,image/jpeg"
          className="sr-only"
          onChange={(e) => { onPick(kind, e.target.files?.[0]); e.target.value = '' }}
        />
        {url && (
          <button
            type="button"
            onClick={() => onRemove(kind)}
            className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg text-fg-mute text-[13px] hover:bg-danger-bg hover:text-danger transition-colors"
          >
            <Trash2 className="w-3.5 h-3.5" /> Remover
          </button>
        )}
      </div>
      {error ? <p className="text-[12px] text-danger">{error}</p> : <p className="text-[12px] text-fg-mute">{hint}</p>}
    </div>
  )
}
