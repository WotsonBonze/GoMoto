import type { ExpoConfig } from 'expo/config';

/**
 * Variantes do app: cada uma é um app independente nas lojas e no EAS
 * (bundle/package próprio, projeto EAS próprio).
 *
 * A variante é escolhida pela env `APP_VARIANT` — definida nos perfis do
 * `eas.json` para builds, ou no shell para rodar local
 * (`APP_VARIANT=app2 pnpm dev`). Sem a env, usa `gomoto`.
 */
type AppVariant = {
  name: string;
  slug: string;
  scheme: string;
  bundleIdentifier: string;
  package: string;
  projectId: string;
};

const version = '0.5.0';

const variants = {
  gomoto: {
    name: 'GoMoto Mobile',
    slug: 'gomotos',
    scheme: 'gomoto',
    bundleIdentifier: 'com.gomoto.mobile',
    package: 'com.gomoto.mobile',
    projectId: 'e2ae872e-1f8a-4827-94af-50d8b51f76a9',
  },
  // TODO: preencher com os dados do segundo app (projectId vem de `eas init`).
  locawone: {
    name: 'Locaw',
    slug: 'locaw-one',
    scheme: 'locaw-one',
    bundleIdentifier: 'br.com.one.locaw',
    package: 'br.com.one.locaw',
    projectId: '3cae0509-f91b-45cc-9ea9-3cca461dfefb',
  },
} satisfies Record<string, AppVariant>;

type VariantKey = keyof typeof variants;

const variantKey = (process.env.APP_VARIANT ?? 'gomoto') as VariantKey;
const variant: AppVariant | undefined = variants[variantKey];

if (!variant) {
  throw new Error(
    `APP_VARIANT inválida: "${process.env.APP_VARIANT}". Use uma de: ${Object.keys(variants).join(', ')}`,
  );
}

const config: ExpoConfig = {
  name: variant.name,
  slug: variant.slug,
  version: version,
  scheme: variant.scheme,
  orientation: 'portrait',
  userInterfaceStyle: 'automatic',
  icon: './assets/icon.png',
  ios: {
    supportsTablet: false,
    bundleIdentifier: variant.bundleIdentifier,
    // Só HTTPS/TLS do sistema — isento da declaração de exportação da Apple.
    config: {
      usesNonExemptEncryption: false,
    },
  },
  android: {
    package: variant.package,
    adaptiveIcon: {
      foregroundImage: './assets/adaptive-icon-foreground.png',
      backgroundColor: '#2563EB',
    },
  },
  web: {
    bundler: 'metro',
    favicon: './assets/favicon.png',
  },
  plugins: [
    'expo-router',
    [
      'expo-splash-screen',
      {
        image: './assets/splash-icon.png',
        imageWidth: 200,
        resizeMode: 'contain',
        backgroundColor: '#F8FAFC',
        dark: {
          backgroundColor: '#0B1120',
        },
      },
    ],
    'expo-web-browser',
  ],
  extra: {
    router: {},
    eas: {
      projectId: variant.projectId,
    },
  },
  owner: 'apg-dev',
};

export default config;
