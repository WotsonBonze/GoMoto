# Desenvolvimento Local

Como rodar o GoMoto inteiramente offline, com Supabase em Docker, sem depender da nuvem.

> **Por que ler isto?** Toda a Fase 0.1 de [[Arquitetura Proposta]] gira em torno de eliminar a dependência do projeto cloud `hcnxbqunescfanqzmsha` para o dia a dia. Migrations passam a ser versionadas em `supabase/migrations/` e validadas localmente antes de subir.

---

## Pré-requisitos

| Ferramenta     | Versão mínima | Como instalar                                          |
| -------------- | ------------- | ------------------------------------------------------ |
| Node.js        | 20 LTS        | `nvm install 20`                                       |
| pnpm           | 10+           | `npm i -g pnpm` (ou `corepack enable`)                 |
| Docker Engine  | 24+           | https://docs.docker.com/engine/install/                |
| Supabase CLI   | 2.x           | `npm i -g supabase` ou https://supabase.com/docs/guides/cli |

Verifique:

```bash
node -v       # v20+ ou v22
pnpm -v       # 10+
docker -v     # 24+
supabase -v   # 2.x
```

---

## Primeira execução

```bash
# 1. Subir o stack do Supabase (Postgres + Auth + Storage + Studio)
pnpm db:start
# (na primeira vez baixa ~2 GB de imagens Docker — vá tomar um café)

# 2. Ver as chaves geradas para o ambiente local
pnpm db:status
# Você verá algo como:
#   API URL:        http://127.0.0.1:54321
#   DB URL:         postgresql://postgres:postgres@127.0.0.1:54322/postgres
#   Studio URL:     http://127.0.0.1:54323
#   anon key:       eyJhbGciOi...
#   service_role:   eyJhbGciOi...

# 3. Criar seu .env.local a partir do template
cp .env.local.example .env.local
# Cole as chaves "anon key" e "service_role" do passo 2

# 4. Aplicar migrations + seed do zero
pnpm db:reset
# Isso roda TODAS as migrations em supabase/migrations/ e depois supabase/seed.sql

# 5. Subir a aplicação Next.js
pnpm dev
```

Acesse:

- **App:** http://localhost:3000
- **Studio (gerenciar o DB local):** http://127.0.0.1:54323
- **Login de teste:** `empresa01@teste.com` / `12345678` (owner da Empresa Teste 1, criado pelo seed — ver `supabase/seed.sql` para as demais contas, incluindo `master@teste.com` como platform_admin)

---

## Rodando os testes E2E (Playwright)

```bash
cd apps/web
pnpm exec playwright install chromium   # uma vez, baixa o browser
```

Crie `apps/web/.env.test` (gitignored, não commitar) com as credenciais do seed:

```
TEST_USER_EMAIL=empresa01@teste.com
TEST_USER_PASSWORD=12345678
```

`pnpm --filter web test:e2e` roda contra `http://localhost:3000` (precisa do `pnpm dev` já rodando) e do Supabase local já com `pnpm db:reset` aplicado.

`apps/web/tests/helpers.ts` cria dados de teste via `@supabase/supabase-js` autenticado como o usuário de `.env.test`, sem passar pelo browser. Esses inserts passam pelas mesmas políticas RLS do app — todo helper que insere em `customers`/`vehicles`/`rentals` **precisa** de `tenant_id` explícito (via `getTestTenantId()`, que resolve por `get_user_tenants()`). Faltou isso até 2026-08-07: a suíte inteira falhava silenciosamente com "row-level security policy" — corrigido junto com a Spec 0010.

**Suíte de extração de documentos via IA** (`document-extraction-cliente.spec.ts`, `document-extraction-multa.spec.ts` — Spec 0012): **não precisa de configuração nenhuma.** Fora de produção a extração é simulada por padrão.

Era o contrário — real por padrão, mock só com `DOCUMENT_EXTRACTION_MOCK=1` — e na prática ninguém lembrava da variável: bastava reiniciar o dev server sem ela para cinco testes falharem por motivo ambiental, com a suíte passando a mentir sobre o estado do código. Aconteceu repetidamente.

Para exercitar o Gemini de verdade (custa chamada e exige `AI_GATEWAY_API_KEY`):

```bash
DOCUMENT_EXTRACTION_REAL=1 pnpm --filter web dev
```

**Produção nunca simula**, mesmo que a variável apareça no deploy: `NODE_ENV === 'production'` força a extração real. O modo de falha seria cadastrar cliente com o CPF fixo do fixture, e isso não pode depender de disciplina de configuração.

O mock devolve um `ExtractionResult` fixo por tipo de documento — o nome do arquivo enviado no teste dirige o cenário (`mock-fail` simula falha do provedor, `mock-plate-<PLACA>` simula a placa extraída pra casar com um veículo criado no teste). Ver `apps/web/src/lib/document-extraction/mock.ts`.

---

## Comandos do dia a dia

| Comando            | O que faz                                                              |
| ------------------ | ---------------------------------------------------------------------- |
| `pnpm db:start`    | Sobe os containers Docker (idempotente)                                |
| `pnpm db:stop`     | Para os containers (preserva o volume — dados ficam)                   |
| `pnpm db:reset`    | **DESTRUTIVO**: apaga o banco local e reaplica migrations + seed       |
| `pnpm db:status`   | Mostra URLs e chaves do stack rodando                                  |
| `pnpm db:diff -f <nome>` | Compara seu DB local com as migrations e gera uma nova migration |
| `pnpm db:push`     | **CUIDADO**: aplica migrations no projeto cloud (ver regra abaixo)     |

---

## Fluxo de uma alteração de schema

Você quer adicionar uma coluna `discount_pct` em `contracts`. Faça assim:

```bash
# 1. Suba o stack se ainda não estiver rodando
pnpm db:start

# 2. Edite o schema direto no Studio (http://127.0.0.1:54323)
#    ou rode SQL ad-hoc: psql postgresql://postgres:postgres@127.0.0.1:54322/postgres

# 3. Gere a migration a partir do diff
pnpm db:diff -f add_discount_to_contracts
# Cria: supabase/migrations/<timestamp>_add_discount_to_contracts.sql

# 4. Revise o SQL gerado (sempre confira — a CLI às vezes inclui ruído)
#    Ajuste comentários, ordem, etc.

# 5. Valide do zero: descarta o banco e reaplica TUDO incluindo a nova migration
pnpm db:reset

# 6. Commit
git add supabase/migrations/<arquivo>.sql
git commit -m "feat(db): adiciona discount_pct em contracts"
```

---

## Regra de ouro: nunca rode migrations contra a cloud direto

O projeto cloud de produção é `oskgooflepkkjdwxuouj` (Supabase "gomotos2"); `hcnxbqunescfanqzmsha` era o projeto do MVP e não é mais usado. Hoje a produção só tem dados de teste. Até a Fase 5 ([[Arquitetura Proposta#Fase 5]]) entrarem com multi-tenancy + ambientes separados (`dev`/`staging`/`prod`), tratamos a cloud como **somente leitura** para mudanças de schema.

- ❌ **NÃO** rode `pnpm db:push` apontando para a cloud.
- ❌ **NÃO** edite tabelas no Dashboard do Supabase cloud.
- ✅ Toda mudança de schema **nasce local**, vira migration commitada, e só sobe para a cloud em um momento controlado (via PR + revisão).

Veja também: [[CLAUDE.md]] (seção "Regras invioláveis").

---

## Solução de problemas

### "Cannot connect to the Docker daemon"
- Inicie o Docker: `sudo systemctl start docker` (Linux) ou abra o Docker Desktop.

### "port is already allocated"
- Outro stack do Supabase está rodando. `pnpm db:stop` e tente de novo.
- Se o conflito for com Postgres do sistema: pare-o (`sudo systemctl stop postgresql`) ou ajuste portas em `supabase/config.toml`.

### `db:reset` falha com erro de RLS
- O `seed.sql` roda com privilégios de superuser, então RLS é ignorado lá. Se quebrou, provavelmente sua migration nova tem `CREATE POLICY` antes do `CREATE TABLE`. Reordene.

### Chaves no `.env.local` ficaram inválidas após `db:reset`
- `db:reset` **mantém** as chaves anon/service_role, mas se você fez `supabase stop --no-backup` + `start` novamente, elas podem mudar. Rode `pnpm db:status` e recopie.

### Migration foi criada mas não aparece em `db:reset`
- Verifique o nome do arquivo: precisa começar com timestamp (`YYYYMMDDHHMMSS_`). A CLI gera certo via `db:diff -f`; só dá problema se você renomeou manualmente.

---

## Estrutura de pastas relevante

```
supabase/
├── config.toml              # Configuração do stack local (commit)
├── migrations/              # Histórico de schema (commit)
│   └── 20260611002632_initial_schema.sql
├── seed.sql                 # Dados de desenvolvimento (commit)
├── .branches/               # Branches locais — ignorado
├── .temp/                   # Cache da CLI — ignorado
└── volumes/                 # Dados do Postgres em disco — ignorado
```

O `.gitignore` da raiz já cobre `.branches/`, `.temp/` e `volumes/`. Migrations e seed **vão para o git**.

---

## Próximos passos previstos

Quando a Fase 5 entrar:

- `seed.sql` passará a criar **2 tenants** com dados isolados.
- Surgirão ambientes `staging.gomoto.app` e `app.gomoto.app` com projetos Supabase distintos.
- Criaremos `pnpm db:push:staging` e fluxo de PR-deploy que aplica migrations só após aprovação.

Por enquanto, vivemos com **single-tenant local + cloud única** para o MVP.

---

## Veja também

- [[Arquitetura Proposta]] — Fase 0.1 inteira
- [[CLAUDE.md]] — regras para a IA sobre DB
- [[Banco de Dados]] — descrição das tabelas
- [[Variáveis de Ambiente]] — referência completa de envs
