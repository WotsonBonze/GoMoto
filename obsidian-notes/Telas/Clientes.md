# 👥 Tela: Clientes — [[GoMoto]]

Rotas: `/clientes` (listagem) · `/clientes/novo` (criação) · `/clientes/[id]` (detalhe) · `/clientes/[id]/editar` (edição)
Tipo: listagem e formulário são Client Component; detalhe (`[id]/page.tsx`) é Server Component.

> ⚠️ Nota atualizada em 2026-08-09 durante o planejamento da Spec 0012 — a versão anterior descrevia um modal de detalhes e um formulário só de Pessoa Física que não existem mais no código atual.

## Listagem (`/clientes`)

- Botão **"+ Novo Cliente"** no `PageTitle`, linka pra `/clientes/novo` — clientes **não** entram só via Fila, há criação direta.
- 2 KPI cards (Ativos + Ex-Clientes).
- Barra de filtros: abas (Todos/Ativos/Ex-Clientes) + dropdown UF + busca.
- Tabela com 5 colunas — **sem coluna de CPF** (removida da listagem).
- Dados via hooks de `@gomoto/data`: `useCustomers()`, `useActiveRentals()`, `useDeleteCustomer()` — não é mais fetch inline com `createClient()`.

### Filtros

| Filtro | Valores |
|---|---|
| Abas | Todos / Ativos (`active !== false`) / Ex-Clientes (`active === false`) |
| Dropdown Estado | 27 UFs brasileiras |
| Busca textual | `name`, `cpf`, `phone` (case-insensitive) |

### Colunas da Tabela

| Coluna | Conteúdo |
|---|---|
| Nome | `customer.name` (ou `company_name` se PJ, com badge "PJ" abaixo) |
| Telefone | Ícone MessageCircle + link WhatsApp `https://wa.me/55{digits}` |
| Moto Atual | Badge `PLACA — MARCA MODELO` (via contrato/locação ativa) ou "—" |
| Status | Badge verde "Ativo" ou vermelho "Ex-Cliente" |
| Ações | Eye (→ `/clientes/[id]`), Edit2 (→ `/clientes/[id]/editar`), Trash2 (modal de confirmação) |

Clicar no nome → navega para a página de detalhe (**não é mais modal**).

### Exclusão

Modal de confirmação com o aviso "Clientes com contrato ativo não podem ser excluídos" — o bloqueio em si é resolvido dentro de `useDeleteCustomer()` (`@gomoto/data`), não mais checado inline na page.

## Formulário (`CustomerForm.tsx`, usado em `/novo` e `/editar`)

Layout com navegação lateral por seção (sticky), não é mais um form plano. Primeira seção define **Tipo de Pessoa** (Pessoa Física / Pessoa Jurídica) — o restante do formulário muda de acordo.

### Seções — Pessoa Física

| Seção | Campos |
|---|---|
| Dados Pessoais | Nome completo, CPF, RG, Data de Nascimento |
| Habilitação (CNH) | Número, Categoria (`CNH_CATEGORIES` de `@gomoto/core`: ACC/A/B/AB/C/AC/D/AD/E/AE — valor legado fora da lista aparece como opção extra), Validade |
| Contato | Telefone 1, Telefone 2, Email, Nome/Telefone dos Contatos de Emergência **1, 2 e 3** |
| Endereço | CEP (com **busca automática** via ViaCEP — preenche Logradouro/Bairro/Cidade/UF), Logradouro, Número, Complemento, Bairro, Cidade, UF |
| Documentos | Foto da CNH, Comprovante de Residência (upload, ver §Documentos abaixo) |
| Observações | Observações internas |
| Encerramento *(só edição)* | Toggle Ativo/Ex-Cliente, Data de Saída, Motivo (habilitados só quando "Ex-Cliente") |

### Seções — Pessoa Jurídica

Mesma estrutura, exceto:
- "Dados Pessoais" vira "Dados da Empresa": Razão Social, Nome Fantasia, Nome do Responsável, CNPJ.
- Sem seção de Habilitação (CNH) — não se aplica a PJ.
- Sem Contatos de Emergência.
- "Documentos" pede "Cartão CNPJ ou documento da empresa" no lugar de comprovante de residência.

Todos os campos são opcionais (sem `required` no HTML), exceto os que o Zod schema de `@gomoto/core` exigir no server.

### Contatos de emergência

São **três** pares nome/telefone, todos opcionais e só para Pessoa Física. As colunas seguem a convenção já usada em `phone`/`phone2` — o primeiro par não tem sufixo:

| Posição | Colunas |
|---|---|
| 1 | `emergency_contact_name`, `emergency_contact_phone` |
| 2 | `emergency_contact_name2`, `emergency_contact_phone2` |
| 3 | `emergency_contact_name3`, `emergency_contact_phone3` |

O telefone é gravado só com dígitos (`stripPhone`) e mascarado na exibição. No detalhe do cliente, cada par só vira linha se tiver nome ou telefone preenchido. A coluna legada `emergency_contact` (texto livre) continua no banco e no `CustomerSchema`, mas nenhuma tela escreve nela.

## Documentos (upload)

- Bucket Supabase Storage: **`customer-documents`** (privado, 10MB, JPG/PNG/WebP/PDF).
- Path: `${tenantId}/${customerId}/${slot}/${timestamp}.${ext}`, `slot ∈ {'cnh', 'residency'}`.
- Colunas em `customers`: `drivers_license_photo_url`, `residency_proof_url` (e `document_photo_url` como fallback legado só na leitura do detalhe, não usado mais no formulário). Ambas passaram a ser validadas por `CustomerSchema` (`@gomoto/core`) a partir da Spec 0012 — antes eram gravadas sem passar pelo Zod, e `updateCustomer` descartava esses campos silenciosamente.
- **Modo criação**: arquivo fica em memória (`File`) até `createCustomer` retornar o `id`; só então sobe pro Storage e faz um `updateCustomer` com a URL.
- **Modo edição**: upload imediato ao selecionar o arquivo, seguido de `updateCustomer({ [field]: path })`.
- Exibição no upload: preview inline (imagem ou ícone "PDF" se PDF), botão de remover.

### Extração de CNH via IA (Spec 0012 / ADR 0023)

Ao selecionar a **Foto da CNH** (PF, ambos os modos), o form dispara em paralelo a Server Action `extractCnhFields` (`clientes/actions.ts`) — Gemini via Vercel AI Gateway, `apps/web/src/lib/document-extraction/extract.ts`, schema `CnhFieldsSchema` (`@gomoto/core`). Campos extraídos (Nome, CPF, RG, Nascimento, Nº/Categoria/Validade da CNH) pré-preenchem o form automaticamente; campos com confiança baixa ganham um badge **"Confira"** ao lado do label. Contagem "X de Y campos identificados" some abaixo do upload. Falha/timeout (15s) mostra "Tentar novamente" / "Preencher manualmente", sem perder o que já foi digitado.

A extração em si não persiste nada — o arquivo só sobe pro Storage no save do formulário (mesmo fluxo acima). Fora de produção a extração é SIMULADA por padrão — a suíte E2E (`document-extraction-cliente.spec.ts`) roda sem configurar nada, e `DOCUMENT_EXTRACTION_REAL=1` exercita a IA de verdade. Produção nunca simula, mesmo que a variável apareça no deploy.

## Página de Detalhe (`/clientes/[id]`, Server Component)

Não é mais modal — página própria, com signed URLs (1h) geradas server-side para os documentos.

Seções condicionais conforme o registro: Contrato Ativo (locação + veículo vinculado), Dados da Empresa (PJ) / Dados Pessoais (PF), Contato, Endereço, Habilitação — CNH (PF, com aviso visual "(Vencida)" se `drivers_license_validity` no passado), Acesso ao App (`CustomerAppAccess`, só PF com **CPF** — o login do app é CPF + senha via `cpfShellEmail`; o email do cadastro não participa do acesso), **Documentos** (thumbnails via função local `DocumentThumb` — não é componente exportado/reutilizável), Encerramento (ex-clientes), Situação financeira (bloqueio por inadimplência + créditos disponíveis), Créditos, Observações.

## Tags
`#projeto/tela` `#gomoto/clientes`
