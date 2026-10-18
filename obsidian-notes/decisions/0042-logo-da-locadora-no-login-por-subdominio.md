# ADR 0042 — Logo da locadora no login por subdomínio

- **Status:** Implementada (2026-10-17), pendente de deploy
- **Data:** 2026-10-17
- **Autores:** Stakeholder + agente IA
- **Substitui:** —
- **Substituída por:** —

## Contexto

A tela de login do web (redesenhada em 2026-10-17) mostra a identidade Locaw. As locadoras querem que os operadores vejam a marca delas ao entrar. O login roda **antes** de existir sessão, então o tema do tenant (ADR 0019, resolvido por `getCurrentTenantId()`) não serve: a locadora precisa ser identificada pela URL.

Escopo deliberadamente pequeno: **só o logo, só na tela de login web**. Temas continuam os 4 do sistema; nada muda no app mobile, nos emails ou nas telas internas.

## Decisão

1. **Subdomínio coringa.** `*.locaw.com.br` aponta para o mesmo deploy (DNS na Vercel, que emite o SSL coringa). `{sub}.locaw.com.br/login` mostra o logo da locadora; o sistema inteiro funciona sob o subdomínio, porque é o mesmo app. Descartados: rota com slug (`/l/motosrj`, URL com cara de Locaw) e domínio próprio (CNAME + verificação por locadora — upgrade futuro).
2. **Colunas em `tenants`**, não tabela nova: `login_subdomain` (opcional, `UNIQUE`, `CHECK` de formato DNS + reservados), `login_logo_path` (fundo escuro) e `login_logo_light_path` (fundo claro, opcional). Coluna própria em vez de reaproveitar `slug`: o slug existe desde o início, não precisa ser rótulo DNS válido e mudá-lo quebraria a URL.
3. **Só o admin da plataforma define** subdomínio e logos, na tela da empresa (`/admin/empresas/[id]`, seção "Login personalizado"). Evita disputa de nomes e erro de digitação.
4. **Leitura anônima por uma porta só:** `get_login_branding(p_subdomain)` (`SECURITY DEFINER`, `EXECUTE` para `anon`) devolve **apenas** nome e caminhos dos logos, e só de empresa ativa e não suspensa. `tenants` continua fechada para `anon` (CNPJ e dados da empresa).
5. **Bucket público `tenant-branding`** (`{tenant_id}/login-logo-{kind}-{timestamp}.ext`), PNG/WebP/JPG até 1 MB. **Sem SVG**: aberto direto pela URL pública, um SVG executa script na origem do Supabase. Escrita, listagem e remoção só com `is_platform_admin()`. A policy de SELECT existe para o DELETE funcionar — sem ela o Storage responde 200 com lista vazia e o arquivo antigo fica órfão (reproduzido).
6. **Cache em camadas, sem tocar no middleware:**
   - `parseLoginSubdomain` (`@gomoto/core`) descarta raiz, `www`, reservados, rótulos aninhados e hosts de outro domínio sem I/O.
   - `unstable_cache` por subdomínio, tag `login-branding:{sub}`, validade de 1 h como rede de segurança. O "não encontrado" também é guardado (o coringa deixa qualquer um inventar subdomínios); erro de rede não é guardado.
   - A action do admin chama `revalidateTag` do subdomínio antigo e do novo: a troca aparece no próximo acesso.
   - Logo com nome versionado e `cacheControl` de 1 ano: trocar gera caminho novo, então o cache longo nunca serve logo velho.
   - Descartados: `localStorage` (não economiza consulta — o HTML já vem com o logo — e pode mostrar logo de outra locadora) e `Map` em memória (não invalida entre instâncias).
7. **Rodapé** com marca: `{locadora} · powered by Locaw`. Título e tags do painel de marca continuam os da Locaw.
8. **`NEXT_PUBLIC_ROOT_DOMAIN`**: `locaw.com.br` em produção; `localhost` em desenvolvimento (`empresa1.localhost:3000/login`, sem `/etc/hosts`).

## Achado no caminho: owner reativava a própria empresa suspensa

A policy `"Owners can update their tenants"` liberava as 23 colunas de `tenants` para owner/admin da locadora. Reproduzido por HTTP no banco local: com a empresa suspensa, o owner fazia `PATCH /rest/v1/tenants` com `suspended_at=null` e se reativava. Também deixaria a locadora trocar o próprio subdomínio. Nenhum fluxo do sistema usava essa permissão (só o admin da plataforma edita `tenants`, via `platform_admin_manage_tenants`), então a policy foi **removida** na mesma migration.

## Consequências

- Deploy exige `NEXT_PUBLIC_ROOT_DOMAIN=locaw.com.br` na Vercel e a migration `20261018011631_tenant_login_branding.sql` no cloud (`supabase db push`, por humano).
- Fica fora, de propósito: restringir o login ao tenant do subdomínio (membro de outra locadora ainda entra por `motosrj.locaw…` e cai no próprio painel — a personalização é visual), cores, emails do Supabase Auth, mobile e domínio próprio.
- Subdomínio sem logo é válido: o login mostra o logo Locaw com o nome da empresa no rodapé.
