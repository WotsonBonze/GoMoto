# ADR 0021 — Tema do app mobile (cliente)

- **Status:** Implementada
- **Data:** 2026-08-05
- **Autores:** Stakeholder + agente IA
- **Substitui:** —
- **Substituída por:** [[decisions/0040-identidade-visual-app-mobile-v2|ADR 0040]] (só a paleta, §1 — o mecanismo de tema segue valendo)
- **Estende:** [[decisions/0019-sistema-multi-tema-web|ADR 0019]] §"Quando reavaliar" — previa reabrir quando `apps/mobile` ganhasse suporte a tema.

## Contexto

`apps/mobile` (Expo, app do cliente locatário) nunca tinha token de tema — cada tela repetia o hex do antigo visual emprestado da InfinitePay (`#121212`/`#BAFF1A`) direto no próprio `StyleSheet.create`, em 13 arquivos (`app/`, `app/(tabs)/`, `src/screens/`, `src/components/`). O `app.json` já declarava `"userInterfaceStyle": "automatic"`, mas nenhuma tela de fato reagia ao claro/escuro do sistema.

Diferente do cockpit web (ADR 0019), aqui **não é um seletor de 4 marcas** — o stakeholder já tinha confirmado antes que o app do cliente mantém identidade própria, única, não o mesmo picker do web.

## Decisão

### 1. Uma identidade só; claro/escuro com override manual (revisado)

`apps/mobile/src/theme/tokens.ts` exporta `lightTheme`/`darkTheme` com o mesmo azul da direção "Frota Confiável" do web (`#2563EB` claro / `#3B82F6` escuro) — mesma marca em todo o sistema, personalidade diferente por contexto de uso (já eram os termos do estudo original de tema mobile).

Primeira versão desta ADR não tinha override manual ("é um app de uso rápido, não precisa"). O stakeholder pediu o controle na sequência, já que a aba Conta existe e pode ganhar opções — revisado:

- `ThemeProvider` (`src/theme/ThemeProvider.tsx`), no topo de `app/_layout.tsx`, resolve a preferência (`'auto' | 'light' | 'dark'`, default `'auto'`) — em `'auto'` segue `useColorScheme()`, nos outros dois força o modo. Persistida em `AsyncStorage` (`gomoto.themePreference`, mesmo padrão de chave de `ACTIVE_TENANT_KEY` em `contexts/auth.tsx`) — sobrevive a reabrir o app, mas é local ao aparelho, não sincroniza entre dispositivos nem com o banco (diferente do web, ADR 0019 §2, que persiste por operador em `tenant_members`).
- `useTheme()`/`useStatusBarStyle()` passaram a ler do contexto em vez de chamar `useColorScheme()` direto — nenhuma das 13 telas já migradas precisou mudar, a interface do hook não mudou.
- `useThemePreference()` novo, expõe `{ preference, setPreference }` pra UI.
- Seção "Aparência" na aba Conta (`app/(tabs)/suporte.tsx`), logo abaixo de "Meu perfil": três botões (Sistema/Claro/Escuro), troca instantânea em qualquer tela montada.

`useStatusBarStyle()` resolve o `style` do `<StatusBar>` do `expo-status-bar` como o oposto do fundo (claro em tema escuro, escuro em tema claro) — 5 telas usavam esse componente fixo em `"light"`.

### 2. Dois tokens que o web não tem: `indigo`/`violet`

`BillingsScreen.tsx` usa 4 cores de **categoria** de cobrança (ciclo/avulsa/complementar/multa) — não é severidade, é tipo. `cycle` e `fine` já cabiam em `success`/`danger`; `one_time` e `complementary` precisavam de tom próprio pra não colidir. Adicionados só no tema mobile, reaproveitando os hex que já existiam no app (`#9B9BFF` indigo, `#D97FF5` violeta, ambos do modo escuro original) com equivalentes claros derivados.

### 3. Padrão de estilo dinâmico: `createStyles(theme)` + `useMemo`

React Native não tem CSS custom properties — `StyleSheet.create` roda uma vez com valores estáticos. Padrão adotado em todo arquivo migrado:

```ts
const createStyles = (theme: ThemeTokens) => StyleSheet.create({ ... })
// dentro do componente:
const theme = useTheme()
const styles = useMemo(() => createStyles(theme), [theme])
```

Sub-componentes declarados fora do componente principal (ex.: `SectionHeader`, `BillingRow`, `TypeBadge`) recebem `styles` (e, quando precisam, o tone map já resolvido — `typeTone`, `statusTone`) via prop — não há import de um `styles` de módulo mais.

Mapas de cor por status/categoria que antes eram `const X = { ...hex }` no topo do arquivo viraram funções `getXTone(theme)`, memoizadas uma vez por render em vez de recriadas por item de lista.

### 4. `#121212`/`#f5f5f5` não são mapeamento 1:1

O sweep mecânico (mesmo princípio do ADR 0019 §"refactor(web)") não pôde tratar `#121212` cegamente: no código antigo esse hex significa tanto "fundo da tela" (`theme.bg`) quanto "texto preto sobre botão verde-limão" (`theme.primaryContrast`) — dependia de contexto. Esses casos (login, definir senha, registrar manutenção, enviar vistoria, pagar com Pix) foram resolvidos um a um, não pelo script.

### 5. Ícone, splash e favicon — placeholders gerados, não arte final

`app.json` não tinha `icon`, `splash` nem `adaptiveIcon` configurados — o app buildava com os padrões do Expo, sem nenhuma identidade visual. Resolvido com placeholders, não arte final (ninguém pediu design de logo):

- **Marca**: um anel com raios (roda de moto) — geometria simples, calculada por distância ao centro, sem depender de fonte/texto.
- **Geração**: sem Pillow/ImageMagick disponíveis no ambiente, escrito um encoder PNG mínimo em Python puro (só `struct`/`zlib` da stdlib) — `IHDR` + `IDAT` (RGBA 8-bit, sem filtro) + `IEND`, com CRC32 manual. Script descartável, não versionado.
- **Assets** (`apps/mobile/assets/`, todos 1024×1024 exceto o favicon):
  - `icon.png` — opaco (exigência do iOS), fundo azul de marca (`#2563EB`) + marca branca.
  - `adaptive-icon-foreground.png` — transparente, marca branca dentro da safe zone do Android; `backgroundColor` da camada de fundo vai direto no `app.json` (`android.adaptiveIcon.backgroundColor`), sem precisar de um segundo arquivo.
  - `splash-icon.png` — transparente, marca na cor `--primary` (não branca) porque precisa funcionar tanto no fundo claro quanto escuro do splash.
  - `favicon.png` — 48×48, versão pequena com fundo, só pro export web do Expo.
- **Splash claro/escuro de verdade**: `expo-splash-screen` (`~56.0.14`, instalado via `expo install` pra pegar a versão compatível com o SDK) configurado como plugin com `backgroundColor` claro (`#F8FAFC`, = `lightTheme.bg`) e `dark.backgroundColor` escuro (`#0B1120`, = `darkTheme.bg`) — a mesma imagem serve pros dois, só o fundo muda. É a primeira peça do app que reage ao tema **antes** do JS carregar.
- **Validado** com `npx expo config --type public` (schema resolve sem erro) e `npx expo-doctor` — os 5 avisos que aparecem (`newArchEnabled` no schema, Metro/symlinks, `@react-navigation/bottom-tabs` junto com expo-router, React duplicado no monorepo, pacotes atrás da SDK 56) são todos **pré-existentes**, nenhum relacionado a ícone/splash/favicon — confirmado comparando com o `app.json` de antes desta ADR.
- **Splash animada (2026-10-16)**: a splash nativa é estática por natureza (storyboard no iOS; o ícone animado do Android 12+ não é exposto pelo `expo-splash-screen`). A animação é uma continuação em JS: `app/_layout.tsx` chama `SplashScreen.preventAutoHideAsync()` no módulo e o `src/components/AnimatedSplash.tsx` desenha um primeiro quadro idêntico à nativa (mesmo fundo por `useColorScheme` — a nativa segue o SO, não a preferência salva —, mesma logo em 200px), chama `hideAsync()` no primeiro layout, pulsa a logo (Reanimated) enquanto a sessão carrega e, quando `loading` vira `false`, cresce e some revelando o `Stack`. Substituiu o `ActivityIndicator` que aparecia entre a splash e a primeira tela. As cores do `AnimatedSplash` espelham o plugin em `app.config.ts` — mudar uma exige mudar a outra. Só aparece em build (EAS/dev client); o Expo Go mostra a splash dele.

### 6. Fluxo de autenticação é sempre claro — não usa `useTheme()`

Bug reportado: a tela de login abria escura sempre que o SO do aparelho estava em modo escuro (preferência `'auto'`, default, resolve pro sistema). `login.tsx`, `set-password.tsx` e `select-tenant.tsx` — as 3 telas que existem fora das tabs, antes de terminar de autenticar — usam `lightTheme` importado direto de `theme/tokens.ts`, não o hook `useTheme()`. Motivo: antes do login não dá pra saber ainda quem é o cliente nem se a preferência salva no aparelho é dele (AsyncStorage é por aparelho, não por conta — um aparelho compartilhado ou revendido poderia mostrar a preferência de outra pessoa na tela de login). `useStatusBarStyle()` também fica fixo (`'dark'`, ícones escuros sobre fundo claro) nessas 3 telas, pelo mesmo motivo.

Nada muda pra dentro das tabs (`app/(tabs)/*`) — continuam lendo `useTheme()` do `ThemeProvider` normalmente: preferência salva do cliente, ou `'auto'` (segue o SO) se nunca configurou. Esse comportamento já era o que a ADR descrevia desde a primeira versão — o bug era só as telas de autenticação vazando o mesmo contexto.

## Consequências

### Positivas
- App do cliente ganha claro/escuro de verdade, sem trabalho de UI novo — só troca de token.
- Mesma marca (azul) do cockpit web reforça identidade única do produto pros dois públicos.
- Zero hex cravado nos 13 arquivos — confirmado por grep e `tsc --noEmit` limpo.

### Negativas
- Preferência é local ao aparelho — cliente que troca de celular perde a escolha manual (volta pro default `'auto'`). Aceitável: é conforto visual, não dado de negócio.

### Pendências conhecidas, fora do escopo desta ADR
- Os 4 PNGs em `apps/mobile/assets/` são placeholders geométricos (roda/anel), não arte final — feitos pra sair do zero absoluto (Expo default) e ficar fácil de substituir depois: mesmo nome de arquivo, mesma dimensão, mesmo lugar no `app.json`, sem precisar tocar em configuração de novo quando a arte real chegar.
- Sem `android.adaptiveIcon.monochromeImage` (ícone temático do Android 13+) — não crítico, dá pra adicionar depois sem quebrar nada.
- Nada do trabalho desta ADR foi commitado ainda — está no working tree da branch `feat/sistema-multi-tema-web`, junto com o resto do tema web (ADR 0019/0020).

## Quando reavaliar

- Se aparecer uma terceira cor de categoria em `BillingsScreen` ou telas futuras, `indigo`/`violet` já estão livres pra reaproveitar antes de inventar um token novo.
- Se o app ganhar mais telas de configuração, o padrão `ThemeProvider` + `AsyncStorage` já estabelecido aqui serve de referência pra qualquer outra preferência local (não só tema).

## Referências

- ADR 0019 — arquitetura de tokens do cockpit web, mesma origem de paleta ("Frota Confiável") e do padrão `'system'/'light'/'dark'`.
- `apps/mobile/src/theme/tokens.ts`, `useTheme.ts`, `ThemeProvider.tsx` — implementação.
- `apps/mobile/src/contexts/auth.tsx` — padrão de chave de `AsyncStorage` reaproveitado (`ACTIVE_TENANT_KEY`).
- `apps/mobile/app.json`, `apps/mobile/assets/` — ícone, adaptive icon, favicon e splash screen (claro/escuro).
- Estudo de tema mobile (conversa anterior) — origem da decisão de identidade única + azul de marca.
