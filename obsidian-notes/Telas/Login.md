# 🔐 Tela: Login — [[GoMoto]]

Rota: `/login` | Tipo: Client Component | Grupo: `(auth)` (sem Sidebar/Header)

## Layout (redesenho 2026-10-17)

Identidade fixa da Locaw — **não** segue o tema do tenant (ADR 0019): o login roda sem sessão. Cores em tokens escopados `.login-brand` (`--login-ink`, `--login-accent`, `--login-paper*`) no fim de `globals.css`. Títulos em Archivo 800 (`next/font/google`).

- Desktop (`lg+`): duas colunas.
  - **Esquerda (escura):** logo Locaw, eyebrow "Gestão de locação de veículos", título "Do contrato ao pagamento, sem sair da pista." com faixa tracejada amarela (pista) atrás da última linha, círculos decorativos e chips (Contratos, Cobranças recorrentes, Controle da frota).
  - **Direita (branca):** "Precisa de ajuda? Suporte" (`/suporte.html`), "Bem-vindo de volta", formulário, rodapé "Locaw © {ano} · Termos · Privacidade" (`/privacidade.html`).
- Abaixo de `lg`: só o formulário, com o logo no topo.
- Senha com botão **Mostrar/Ocultar**.
- **Inertes por enquanto** (texto visível, sem ação): "Esqueci a senha" (não há fluxo de recuperação no web) e "Termos" (não há página de termos).
- Fora do escopo do mockup, de propósito: checkbox "Manter conectado" (a sessão já persiste sempre) e card de evento/campanha (sem conteúdo real).

## Login personalizado por subdomínio (ADR 0042)

- `page.tsx` (Server Component) lê o `Host`, chama `getLoginBranding()` (`apps/web/src/lib/login-branding.ts`) e entrega a `LoginForm.tsx` (Client Component com o formulário).
- `{sub}.{NEXT_PUBLIC_ROOT_DOMAIN}/login` com subdomínio cadastrado: logo da locadora no lugar do logo Locaw (versão escura no painel de marca, clara no celular) e rodapé `{locadora} · powered by Locaw`. Título e tags não mudam.
- Sem subdomínio, subdomínio desconhecido, empresa suspensa ou erro na consulta: identidade Locaw.
- Cache: `unstable_cache` por subdomínio (tag `login-branding:{sub}`, 1 h), invalidado pelo admin ao salvar; logos com nome versionado e cache imutável.
- Dev: `http://empresa1.localhost:3000/login` (seed).
- Subdomínio e logos: admin da plataforma em `/admin/empresas/[id]` → "Login personalizado".

## Campos

| Campo | Tipo | autoComplete |
|---|---|---|
| Email | email | email |
| Senha | password | current-password |

## Lógica de Login

```javascript
async function handleLogin(event) {
  event.preventDefault()
  setError('')
  setLoading(true)

  const { error } = await supabase.auth.signInWithPassword({ email, password })

  if (error) {
    setError('Email ou senha incorretos.')
    setLoading(false)
    return
  }

  // platform_admin → /admin/dashboard; demais → /dashboard (navegação dura)
  window.location.href = destino
}
```

- Erro exibido em card: `bg-danger-bg border-danger text-danger`
- Botão mostra `loading={true}` durante a requisição

## Rate Limiting (Middleware)

- Máximo 10 POSTs em `/login` por IP em 15 minutos
- Sliding window in-memory (`Map<string, number[]>`)
- Se exceder: HTTP 429
- IP extraído via `x-forwarded-for` ou `x-real-ip`
- ⚠️ Perde o histórico em restart do servidor — migrar para Redis/Upstash no futuro

## Comportamento de Redirecionamento

- Usuário não autenticado → qualquer rota privada → `/login`
- Usuário autenticado → `/login` → `/dashboard`
- Rotas `/auth/*` → sempre públicas

## Tags
`#projeto/tela` `#gomoto/auth`
