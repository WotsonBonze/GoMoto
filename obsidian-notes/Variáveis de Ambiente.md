# 🔐 Variáveis de Ambiente — [[GoMoto]]

## Produção / Desenvolvimento

Arquivo: `.env.local` (nunca commitado)

| Variável | Exemplo | Uso |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `https://oskgooflepkkjdwxuouj.supabase.co` | URL do projeto Supabase |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `eyJhbGc...` | Chave pública (anon) do Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | `eyJhbGc...` | Escrita server-side que contorna RLS: Route Handler do mobile, webhook e job de emissão |
| `CRON_SECRET` | string aleatória | Autentica o **disparo manual** da emissão em `/api/cron/issue-charges`. O agendamento é do pg_cron, dentro do banco; esta rota existe para rodar fora de hora. **Sem ele a rota recusa executar** — melhor não emitir do que deixar aberto um endpoint que cria documentos financeiros (Spec 0014) |
| `NEXT_PUBLIC_APP_URL` | `https://app.gomoto.com.br` | Base da URL de retorno do OAuth de gateway. A rota é `/api/auth/gateway/<provedor>/callback` — **é essa URL que precisa estar registrada no painel do provedor** |
| `GATEWAY_OAUTH_SECRET` | string aleatória | Assina o `state` do OAuth de gateway (ADR 0030). Opcional: sem ela, cai em `SUPABASE_SERVICE_ROLE_KEY`. Antes o `state` era assinado com `MERCADOPAGO_CLIENT_SECRET` — o segredo que nos autentica PERANTE o provedor virava também a chave que prova que o retorno é nosso |
| `MERCADOPAGO_CLIENT_ID` | string do painel MP | OAuth da conta do tenant |
| `MERCADOPAGO_CLIENT_SECRET` | string do painel MP | OAuth da conta do tenant |
| `MERCADOPAGO_WEBHOOK_SECRET` | string do painel MP | Valida a assinatura HMAC do webhook |
| `CORA_API_BASE` | `https://api.stage.cora.com.br` | Homologação; produção é `https://api.cora.com.br` |
| `CORA_CLIENT_ID` | `app-...` | OAuth2 da modalidade **Parceria**. Sem certificado — mTLS é a "Integração Direta", que não é a nossa |
| `CORA_CLIENT_SECRET` | UUID | Vai no `Authorization: Basic` do `/oauth/token` (a Cora não aceita no corpo, ao contrário do MP) |
| `CORA_WEBHOOK_SECRET` | string aleatória | **Segredo no PATH do webhook.** A Cora não assina a notificação e não oferece campo de auth no cadastro do endpoint, então esta é a única barreira na porta. A Edge Function recusa tudo com 404 se ela faltar (ADR 0031) |

> `MERCADOPAGO_REDIRECT_URI` **saiu** (ADR 0030): a URL de retorno é derivada de `NEXT_PUBLIC_APP_URL` + o slug do provedor, para que somar um gateway não exija variável nova e a URL não possa divergir da rota que realmente atende.

> ⚠️ `NEXT_PUBLIC_` expõe a variável no navegador. Seguro apenas para a `anon key` — nunca usar a `service_role key` com esse prefixo.

## Testes

Arquivo: `.env.test`

| Variável | Uso |
|---|---|
| `TEST_USER_EMAIL` | Email do usuário de teste para Playwright |
| `TEST_USER_PASSWORD` | Senha do usuário de teste |

## Supabase — IDs do Projeto

| Info | Valor |
|---|---|
| Project ID | `oskgooflepkkjdwxuouj` |
| URL | `https://oskgooflepkkjdwxuouj.supabase.co` |

## Como configurar ambiente novo

1. Criar projeto no Supabase (supabase.com)
2. Copiar URL e anon key em Project Settings → API
3. Criar `.env.local` com as duas variáveis
4. Executar `supabase-schema.sql` no SQL Editor do Supabase
5. Criar usuário em Authentication → Users
6. Rodar `npm run dev`

## Futuras variáveis (Roadmap)

| Variável | Serviço | Para que |
|---|---|---|
| `RESEND_API_KEY` | Resend | Emails transacionais |
| `SENTRY_DSN` | Sentry | Monitoramento de erros |
| `UPSTASH_REDIS_URL` | Upstash | Rate-limit persistente |
| `UPSTASH_REDIS_TOKEN` | Upstash | Auth do Redis |

## Tags
`#projeto/config` `#projeto/segurança`
