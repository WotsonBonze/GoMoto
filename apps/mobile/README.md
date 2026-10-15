# @gomoto/mobile

App do cliente (Expo + Expo Router). O mesmo código gera **dois apps independentes**, chamados de variantes:

| Variante | Nome | Slug EAS | Bundle / Package | Scheme |
|---|---|---|---|---|
| `gomoto` | GoMoto Mobile | `gomotos` | `com.gomoto.mobile` | `gomoto` |
| `locawone` | Locaw | `locaw-one` | `br.com.one.locaw` | `locaw-one` |

Os dados de cada variante ficam no objeto `variants` em `app.config.ts`. A variante é escolhida pela env `APP_VARIANT` (sem ela, usa `gomoto`).

> **Regra de ouro:** em comandos `eas` que usam perfil de build, escolha a variante pelo **perfil** (`-e`). O `env.APP_VARIANT` do perfil no `eas.json` **sobrescreve** o `APP_VARIANT=` passado no terminal. O prefixo `APP_VARIANT=` só vale para comandos locais (`expo`, `pnpm dev`) e para os comandos `eas` sem perfil de build.

Todos os comandos abaixo rodam dentro de `apps/mobile`.

---

## GoMoto (`gomoto`)

**Rodar local**

```bash
pnpm dev
```

**Conferir a config resolvida**

```bash
npx expo config --type public
```

**Build de teste (APK interno)**

```bash
npx eas build -p android -e preview
```

**Build de produção**

```bash
npx eas build -p android -e production
npx eas build -p ios -e production
```

**Versão (versionCode / buildNumber — gerenciada pelo EAS)**

```bash
npx eas build:version:get -p android -e production
npx eas build:version:set -p android -e production
```

**Enviar para a loja (último build)**

```bash
npx eas submit -p android --latest
npx eas submit -p ios --latest
```

---

## Locaw (`locawone`)

**Rodar local**

```bash
APP_VARIANT=locawone pnpm dev
```

**Conferir a config resolvida**

```bash
APP_VARIANT=locawone npx expo config --type public
```

**Build de teste (APK interno)**

```bash
npx eas build -p android -e preview-locawone
```

**Build de produção**

```bash
npx eas build -p android -e production-locawone
npx eas build -p ios -e production-locawone
```

**Versão (versionCode / buildNumber — gerenciada pelo EAS)**

```bash
npx eas build:version:get -p android -e production-locawone
npx eas build:version:set -p android -e production-locawone
```

**Enviar para a loja (último build)**

```bash
APP_VARIANT=locawone npx eas submit -p android --latest
APP_VARIANT=locawone npx eas submit -p ios --latest
```

---

## Adicionar uma nova variante

1. Adicionar a entrada em `variants` no `app.config.ts`, com `projectId: 'PREENCHER'`.
2. Criar o projeto no EAS: `APP_VARIANT=<chave> npx eas init`. Depois, colar o projectId gerado no lugar de `'PREENCHER'`. O `slug` precisa ser igual ao do projeto no EAS.
3. Criar os perfis `preview-<chave>` e `production-<chave>` no `eas.json`, com `extends` e `env.APP_VARIANT`, como os de `locawone`.
4. Cadastrar as env vars `EXPO_PUBLIC_*` no novo projeto EAS: elas são separadas por projeto.
5. Definir a versão inicial: `npx eas build:version:set -p android -e production-<chave>`.

## Atenção: link mágico de convite

O convite de cliente enviado pelo web aponta sempre para `gomoto://auth-callback` (`apps/web/src/app/(dashboard)/clientes/actions.ts`). Variantes com outro `scheme` (como `locaw-one`) **não abrem** por esse link enquanto o redirect não depender da variante.
