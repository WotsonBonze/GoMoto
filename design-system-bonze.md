# BONZE DESIGN SYSTEM — AI REFERENCE
## Source of truth for ALL UI generation. Follow exactly. Never deviate. Never invent.
## Stack: Next.js 14 + TypeScript + TailwindCSS + Lucide Icons (NOT InfinitePay SVGs)
## Version: 4.1 — 2026-04-13 (páginas adicionais: clients, booking, link-na-bio, referral, social-shop, external-checkout, products, das-mei, lending + modals/drawers)
## SIZE EXCEPTION: Table rows use h-9 (36px) + text-[13px] — user preference over InfinitePay's 64px/16px default.

---

## RESPONSE STYLE — MANDATORY

Keep all AI responses short and direct. Do not explain what you did unless the user asks. Do not add summaries at the end of responses. Avoid verbose justifications — just do the task and confirm briefly. The user reads the code; they don't need it narrated.

---

## AI WORKFLOW — MANDATORY

**ALWAYS use Codex and Gemini. Never execute tasks directly.**

| Priority | Tool | When to use |
|----------|------|-------------|
| **1st — PRIMARY** | **Codex CLI** (`/codex:rescue`) | All code generation, file editing, dev tasks |
| **2nd — SECONDARY** | **Gemini CLI** | Large files, full codebase analysis, Codex fallback |

- Codex model: always latest (`o4-mini` or newer)
- Gemini model: always `gemini-3.1-pro-preview`
- Claude role: understand → delegate → review → deliver

---

## QUICK ENFORCEMENT — READ FIRST

NEVER use transparency (`/10`, `/30`, `/50`, `/80`) on semantic backgrounds. Use solid hex.
NEVER use the `<Table>` component — always use raw `<table>` HTML per section 19.
NEVER use `text-xs` or `uppercase` or `tracking-wider` in table headers.
NEVER add `py-3` to `<th>` or `<td>` — height is controlled by `h-9` on `<tr>`.
NEVER use `divide-y` on `<tbody>`.
NEVER use `text-sm` on `<table>` — font size is set per element.
NEVER use `text-sm font-medium` for KPI labels — use `text-[14px] font-normal`.
NEVER use `text-2xl font-bold` for KPI values — use `text-[28px] font-bold`.
NEVER place JSX comments `{/* */}` between a `.map(item => (` and its `<tr>` — use JS `/* */`.
NEVER use `rounded-full` on tab navigation buttons — only on buttons and filter chips.
NEVER use `bg-[#BAFF1A]` as tab active state — use `border-b-2 border-[#BAFF1A]` instead.
NEVER use `text-sm` for filter chips — use `text-[20px]` (real InfinitePay value).
NEVER use `border-[#474747]` for inactive filter chips — use `border-2 border-[#323232]`.
ALWAYS use `rounded-full` (pill) for all CTA/action buttons and filter chips.
ALWAYS use solid semantic colors for alerts and banners.
ALWAYS keep KPI cards: text-div LEFT + icon-div RIGHT with `justify-between`.
ALWAYS use `border-2 border-[#BAFF1A]` (not border-b) for selected period/card state.
ALWAYS use `text-[#f5f5f5]` for debit amounts in statements — NOT red.
Action bar buttons: `h-10 rounded-full bg-[#323232] text-[#ffffff] px-6 font-medium text-[16px]` — NEVER primary.
Primary CTA: `bg-[#BAFF1A] text-[#000000] h-10 px-6 font-medium rounded-full` — ONLY for "Adicionar", "Criar", "Salvar".
Modal confirm: `bg-[#ffffff] text-[#121212] h-12 px-6 font-medium rounded-full` — "Aplicar", "Exportar".
Disabled button: `bg-[#323232] text-[#9e9e9e] cursor-not-allowed` — NUNCA `opacity-50`.

---

## 1. COLOR TOKENS

| Role | Hex | Tailwind |
|------|-----|----------|
| Page background | `#121212` | `bg-[#121212]` |
| Card / container | `#202020` | `bg-[#202020]` |
| Table header row | `#323232` | `bg-[#323232]` |
| Table even row | `#323232` | `even:bg-[#323232]` |
| Table hover | `#474747` | `hover:bg-[#474747]` |
| Border / dividers | `#474747` | `border-[#474747]` |
| Brand (lime) | `#BAFF1A` | `bg-[#BAFF1A]` |
| Secondary accent (green-light) | `#9bfd53` | `bg-[#9bfd53]` |
| Text primary | `#f5f5f5` | `text-[#f5f5f5]` |
| Text secondary | `#c7c7c7` | `text-[#c7c7c7]` |
| Text tertiary / labels | `#9e9e9e` | `text-[#9e9e9e]` |
| Brand bg (solid) | `#243300` | `bg-[#243300]` |
| Brand border | `#6b9900` | `border-[#6b9900]` |
| Brand text on dark | `#BAFF1A` | `text-[#BAFF1A]` |
| Success bg | `#0e2f13` | `bg-[#0e2f13]` |
| Success text | `#229731` | `text-[#229731]` |
| Error bg | `#7c1c1c` | `bg-[#7c1c1c]` |
| Error border | `#ff9c9a` | `border-[#ff9c9a]` |
| Error text | `#ff9c9a` | `text-[#ff9c9a]` |
| Warning bg | `#3a180f` | `bg-[#3a180f]` |
| Warning text | `#e65e24` | `text-[#e65e24]` |
| Info bg | `#2d0363` | `bg-[#2d0363]` |
| Info text | `#a880ff` | `text-[#a880ff]` |
| Danger button | `#bf1d1e` | `bg-[#bf1d1e]` |
| Input bg / border | `#323232` | `bg-[#323232] border-[#323232]` |
| Neutral button (light) | `#eeeeee` | `bg-[#eeeeee]` |
| Divider / icon muted | `#616161` | `text-[#616161] border-[#616161]` |

---

## 2. TYPOGRAPHY

| Use | px | Tailwind | Confirmado |
|-----|-----|---------|-----------|
| Detail / drawer main value | 40px | `text-[40px] font-bold text-[#f5f5f5]` | sale detail H2, statement H1 |
| Hero / onboarding title | 32px | `text-[32px] font-bold text-[#f5f5f5]` | /booking H2 |
| Page title H1/H2 | 28px | `text-[28px] font-bold text-[#f5f5f5]` | /settings H2, /clients H1, /invoices/create H1 |
| KPI value | 28px | `text-[28px] font-bold` | dashboard |
| Sub-section H3 | 24px | `text-[24px] font-bold text-[#f5f5f5]` | /settings H3 |
| Balance / montante | 24px | `text-[24px] font-bold text-[#f5f5f5]` | /statements, /cards |
| Tab label (plans) | 20px | `text-[20px] font-medium text-[#f5f5f5]` | /plans |
| Filter chip text | 20px | `text-[20px] font-normal` | /plans, /clients |
| Section heading H4 | 20px | `text-[20px] font-bold text-[#f5f5f5]` | /settings H4 |
| Period card label | 18px | `text-[18px] font-medium text-[#f5f5f5]` | /receivables "Últimas vendas" |
| Tab label (sales) | 16px | `text-[16px] font-medium text-[#f5f5f5]` | /sales |
| Body / table cells | 13px | `text-[13px]` | preferência do usuário |
| Nav sub-label | 14px | `text-[14px] font-normal text-[#c7c7c7]` | /settings sidebar |
| KPI label | 14px | `text-[14px] font-normal text-[#9e9e9e]` | dashboard |
| KPI sub (apoio) | 12px | `text-[12px] mt-0.5 text-[#9e9e9e]` | dashboard |
| Caption / badge | 12px | `text-[12px] font-medium` | (usar valor fixo, não `text-xs`) |

Font: `Inter` (CeraPro is InfinitePay proprietary — NOT available in Bonze projects).
Weight: 400 regular, 500 medium, 700 bold. No 600.

---

## 3. BUTTONS

Base classes (all buttons):
```
inline-flex items-center justify-center gap-2 font-medium transition-all duration-150
hover:scale-[1.025] active:scale-95
disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100
rounded-full
```

| Variant | Classes | Uso real |
|---------|---------|---------|
| primary | `bg-[#BAFF1A] text-[#000000] h-10 px-6 font-medium hover:bg-[#a8e617]` | CTA principal ("Criar plano", "Adicionar") |
| secondary | `bg-[#323232] text-[#ffffff] h-10 px-6 font-medium hover:bg-[#474747]` | Action bar ("Filtros", "Relatório", "Lançamentos recentes") |
| white | `bg-[#ffffff] text-[#121212] h-10 px-6 font-medium hover:bg-[#f0f0f0]` | CTA inline ("Baixar informe", "Ver taxas novas") |
| white-lg | `bg-[#ffffff] text-[#121212] h-12 px-6 font-medium hover:bg-[#f0f0f0]` | Modal confirm ("Aplicar", "Exportar", "Cancelar") |
| ghost | `bg-transparent text-[#c7c7c7] hover:bg-[#323232] hover:text-[#f5f5f5]` | Ações discretas |
| danger | `bg-[#bf1d1e] text-[#f5f5f5] hover:bg-[#a01819]` | Ações destrutivas |
| outline | `bg-transparent border border-[#474747] text-[#f5f5f5] hover:border-[#BAFF1A] hover:text-[#BAFF1A]` | Filtros outline (raro) |
| neutral-sm | `bg-[#eeeeee] text-[#000000] h-8 px-4 font-medium text-[14px]` | "Baixar" informe, ações pequenas de download |
| actions-sm | `bg-[#323232] text-[#ffffff] h-8 px-4 font-medium text-[14px]` | "Ações" dropdown em client detail |

Tamanhos reais confirmados via CSS:
- `h-10 px-6` (40px) — padrão de todos os botões de action bar
- `h-12 px-6` (48px) — modal confirms e CTAs grandes
- `h-9` (36px) — sidebar nav item ativo
- `h-8 px-4` (32px) — small action buttons ("Baixar", "Ações")

**Disabled state (confirmed via /pay/bank-slip):** `bg-[#323232] text-[#9e9e9e] cursor-not-allowed` — NÃO usar `opacity-50`. InfinitePay usa cor diferente (secondary bg + tertiary text), não transparência.

ALWAYS: `rounded-full` on every button. NEVER `rounded-md` or `rounded-lg` for buttons.

---

## 4. INPUTS / FORMS

```html
<div class="space-y-1">
  <label class="text-[14px] text-[#c7c7c7]">Label</label>
  <div class="flex items-center gap-2 px-4 bg-[#323232] border-2 border-[#323232]
              rounded-lg h-12 focus-within:border-[#474747]">
    <LucideIcon class="w-4 h-4 text-[#9e9e9e]" />
    <input class="flex-1 bg-transparent text-[#f5f5f5] outline-none
                  placeholder:text-[#616161]" />
  </div>
  <span class="text-xs text-[#ff9c9a]">Error message</span>
</div>
```

States:
- Normal: `bg-[#323232] border-[#323232]`
- Hover: `border-[#474747]`
- Focus: `border-[#474747]` (via `focus-within`)
- Error: `border-[#bf1d1e]`

Sizes: `h-10` (small/filters), `h-12` (forms), `h-[72px]` (large).

---

## 5. TABLES — CRITICAL RULES

> Ver seção 19 para o padrão completo e ultra-detalhado de grid. Esta seção é um resumo de referência rápida.

### HTML Structure (use `<table>`, NOT `<div>` flex tables)

```tsx
{/* Container obrigatório — NUNCA usar <Card> ou div genérica */}
<div className="overflow-hidden rounded-2xl border border-[#474747] bg-[#202020]">
  <div className="overflow-x-auto">
    <table className="w-full text-left text-[13px] text-[#f5f5f5]">
      {/* SEMPRE: text-left text-[13px] text-[#f5f5f5] no <table> */}
      <thead className="bg-[#323232] text-[#c7c7c7]">
        {/* SEMPRE: bg-[#323232] text-[#c7c7c7] no <thead> — não apenas no <tr> */}
        <tr>
          <th className="h-9 px-4 font-bold">Coluna Normal</th>
          <th className="h-9 px-4 text-right font-bold">Ações</th>
          {/* NUNCA: text-xs, uppercase, tracking-wider, py-3 no <th> */}
          {/* NUNCA: text-left no <th> — já herdado do <table> */}
        </tr>
      </thead>
      <tbody>
        {/* NUNCA divide-y no <tbody> */}
        {items.map(item => (
          <tr
            key={item.id}
            className="h-9 transition-colors odd:bg-transparent even:bg-[#323232] hover:bg-[#474747]"
          >
            {/* NUNCA border-b ou border-t no <tr> */}
            <td className="px-4">
              {/* NUNCA py-3 ou py-2 no <td> — altura vem do h-9 no <tr> */}
              <p className="font-medium text-[#f5f5f5]">{item.name}</p>
            </td>
            <td className="px-4 text-right">
              {/* Ações sempre alinhadas à direita */}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
</div>
```

### Table Rules Checklist

| Elemento | OBRIGATÓRIO | PROIBIDO |
|---------|-------------|---------|
| `<table>` | `w-full text-left text-[13px] text-[#f5f5f5]` | `text-sm`, `text-right` no table |
| Container | `overflow-hidden rounded-2xl border border-[#474747] bg-[#202020]` | `rounded-lg`, `<Card>` |
| Scroll | `<div className="overflow-x-auto">` | nenhum |
| `<thead>` | `bg-[#323232] text-[#c7c7c7]` | só bg sem o text |
| `<th>` | `h-9 px-4 font-bold` | `py-3`, `text-xs`, `uppercase`, `tracking-wider`, `text-[13px]` no próprio th |
| `<th>` Ações | `h-9 px-4 text-right font-bold` | alinhar à esquerda |
| `<tbody>` | sem classes | `divide-y`, `divide-[#323232]` |
| `<tr>` | `h-9 transition-colors odd:bg-transparent even:bg-[#323232] hover:bg-[#474747]` | `border-b`, `border-t` |
| `<td>` | `px-4` | `py-3`, `py-2`, `text-sm`, `font-medium` no td (vai no elemento filho) |
| `<td>` Ações | `px-4 text-right` | alinhar à esquerda |

---

## 6. KPI STAT CARDS — ESPECIFICAÇÃO COMPLETA E OBRIGATÓRIA

> Esta seção é a fonte de verdade absoluta para todos os cards de métricas (KPI) do sistema.
> Qualquer implementação futura DEVE replicar exatamente o que está aqui — sem adaptações, sem simplificações.

---

### 6.1 Grid externo (wrapper dos cards)

```tsx
<div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
  {/* 4 cards aqui */}
</div>
```

| Propriedade | Classe | Valor real |
|---|---|---|
| Display | `grid` | CSS Grid |
| Colunas mobile | `grid-cols-2` | 2 colunas em telas < 640px |
| Colunas desktop | `sm:grid-cols-4` | 4 colunas em telas ≥ 640px |
| Espaço entre cards | `gap-4` | 16px entre todos (horizontal e vertical) |

**PROIBIDO no grid:**
- `gap-x-4 gap-y-4` separados — usar apenas `gap-4`
- `grid-cols-1` como fallback — o mobile é 2 colunas, não 1
- `flex flex-wrap` no lugar de grid
- `grid-cols-3` ou qualquer outro número

---

### 6.2 Container do card (elemento raiz de cada card)

```tsx
<div className="flex items-center justify-between rounded-2xl border border-[#474747] bg-[#202020] px-6 py-4">
```

| Propriedade | Classe | Valor real |
|---|---|---|
| Display | `flex` | flexbox horizontal |
| Alinhamento vertical | `items-center` | centraliza texto e ícone no eixo Y |
| Distribuição horizontal | `justify-between` | texto empurrado à esquerda, ícone à direita |
| Border radius | `rounded-2xl` | 16px — formato arredondado padrão do sistema |
| Borda | `border` | 1px sólida |
| Cor da borda | `border-[#474747]` | cinza médio |
| Fundo | `bg-[#202020]` | cinza escuro — fundo padrão de card |
| Padding horizontal | `px-6` | 24px nos lados esquerdo e direito |
| Padding vertical | `py-4` | 16px no topo e na base |

**PROIBIDO no container:**
- `p-6` genérico — usar `px-6 py-4` separados (padding vertical menor)
- `rounded-xl` — SEMPRE `rounded-2xl`
- `rounded-lg` — SEMPRE `rounded-2xl`
- `shadow-*` — sem sombra em dark mode
- `hover:*` — card KPI não tem interação de hover
- `cursor-pointer` — card KPI não é clicável
- `gap-*` — o espaço entre texto e ícone vem do `justify-between`, não de gap
- `min-h-*` ou `h-*` fixo — altura definida pelo conteúdo + padding
- `w-full` explícito — o grid já controla a largura

---

### 6.3 Div interna esquerda (agrupador dos textos)

```tsx
<div>
  {/* label, value e sub aqui */}
</div>
```

> Esta `<div>` é propositalmente sem classes. Ela serve apenas para agrupar os 3 textos
> verticalmente. O `flex items-center justify-between` do container já cuida do posicionamento.

**PROIBIDO:**
- Qualquer classe nessa div — deixar sem className
- `flex flex-col` explícito — comportamento padrão de div em bloco

---

### 6.4 Label (rótulo do KPI)

```tsx
<p className="text-[14px] font-normal text-[#9e9e9e]">{label}</p>
```

| Propriedade | Classe | Valor real |
|---|---|---|
| Tamanho | `text-[14px]` | 14px fixo |
| Peso | `font-normal` | 400 — explicitamente normal |
| Cor | `text-[#9e9e9e]` | cinza terciário |
| Margin top/bottom | nenhum | sem espaço acima do label |

**PROIBIDO no label:**
- `text-sm` — usar `text-[14px]` fixo
- `text-xs` — muito pequeno
- `font-medium` — peso deve ser 400 (normal)
- `font-bold` — peso deve ser 400 (normal)
- `uppercase` — texto como foi escrito, sem transformação
- `tracking-wider` ou `tracking-[0.2em]` — sem letter-spacing
- `text-[#c7c7c7]` — usar `text-[#9e9e9e]` (terciário, mais apagado)
- `text-[#f5f5f5]` — cor primária é para o value, não o label
- `mb-*` — sem margin bottom

---

### 6.5 Value (valor principal do KPI)

```tsx
<p className="text-[28px] font-bold text-[#f5f5f5]">{value}</p>
```

| Propriedade | Classe | Valor real |
|---|---|---|
| Tamanho | `text-[28px]` | 28px fixo — maior elemento do card |
| Peso | `font-bold` | 700 |
| Cor | `text-[#f5f5f5]` | branco primário — máximo contraste |
| Margin top/bottom | nenhum | sem espaço entre label e value |
| Tipo de dado | `string \| number` | aceita texto (nome de categoria) ou número formatado |

**PROIBIDO no value:**
- `text-2xl` — usar `text-[28px]` fixo (text-2xl = 24px, diferente)
- `text-3xl` — grande demais
- `text-xl` — pequeno demais
- `font-semibold` — usar `font-bold` (700, não 600)
- `font-medium` — muito fino para valor principal
- `text-[#BAFF1A]` — cor de marca não é usada no value
- `mt-1` ou `mt-2` — sem margin top
- `leading-tight` ou qualquer `leading-*` explícito

---

### 6.6 Sub (texto de apoio — opcional)

```tsx
{sub && <p className="text-[12px] mt-0.5 text-[#9e9e9e]">{sub}</p>}
```

| Propriedade | Classe | Valor real |
|---|---|---|
| Tamanho | `text-[12px]` | 12px fixo |
| Margin top | `mt-0.5` | 2px acima do sub — aproximado ao value |
| Cor | `text-[#9e9e9e]` | cinza terciário (mesma cor do label) |
| Condicional | `{sub && ...}` | só renderiza se a prop `sub` existir |
| Peso | herdado | `font-normal` (400) — sem declaração explícita |

**PROIBIDO no sub:**
- `text-xs` — usar `text-[12px]` fixo (mesmo valor, mas explícito)
- `mt-1` — usar `mt-0.5` (2px, não 4px — fica mais próximo do value)
- `text-[#616161]` — muito apagado; usar `text-[#9e9e9e]`
- `opacity-70` — não usar opacidade; cor sólida
- Renderizar sempre (sem condicional) — sub é opcional e pode ser `undefined`

---

### 6.7 Container do ícone (círculo)

```tsx
<div className="bg-[#323232] p-3 rounded-full">
```

| Propriedade | Classe | Valor real |
|---|---|---|
| Fundo | `bg-[#323232]` | cinza médio-escuro — contrasta com o card `#202020` |
| Padding | `p-3` | 12px em todos os lados — cria o círculo ao redor do ícone |
| Formato | `rounded-full` | círculo perfeito |

**PROIBIDO no container do ícone:**
- `flex items-center justify-center` — desnecessário; SVG é inline e centraliza sozinho
- `bg-[#202020]` — seria igual ao fundo do card, sem destaque
- `bg-[#474747]` — muito claro
- `bg-[#BAFF1A]` — marca no fundo destrói contraste do ícone branco
- `p-2` — pequeno demais, círculo fica apertado
- `p-4` — grande demais
- `rounded-xl` ou `rounded-lg` — SEMPRE `rounded-full`
- `w-10 h-10` fixo — deixar o tamanho ser definido pelo padding `p-3` + tamanho do ícone

---

### 6.8 Ícone (Lucide Icon)

```tsx
<Icon className="w-6 h-6 text-[#BAFF1A]" />
```

| Propriedade | Classe | Valor real |
|---|---|---|
| Largura | `w-6` | 24px |
| Altura | `h-6` | 24px |
| Cor | `text-[#BAFF1A]` | verde-limão (cor de marca) — sempre |

**PROIBIDO no ícone:**
- `w-5 h-5` — pequeno demais para KPI
- `w-8 h-8` — grande demais para KPI
- `text-[#f5f5f5]` — ícone branco perde destaque no fundo cinza
- `text-[#9e9e9e]` — apagado demais
- Qualquer cor semântica (vermelho, laranja) no ícone — SEMPRE verde-limão `#BAFF1A`
- `shrink-0` — desnecessário dentro do círculo

---

### 6.9 JSX completo do componente KpiCard (referência canônica)

```tsx
function KpiCard({
  icon: Icon,
  label,
  value,
  sub,
}: {
  icon: React.ElementType
  label: string
  value: string | number
  sub?: string
}) {
  return (
    <div className="flex items-center justify-between rounded-2xl border border-[#474747] bg-[#202020] px-6 py-4">
      <div>
        <p className="text-[14px] font-normal text-[#9e9e9e]">{label}</p>
        <p className="text-[28px] font-bold text-[#f5f5f5]">{value}</p>
        {sub && <p className="text-[12px] mt-0.5 text-[#9e9e9e]">{sub}</p>}
      </div>
      <div className="bg-[#323232] p-3 rounded-full">
        <Icon className="w-6 h-6 text-[#BAFF1A]" />
      </div>
    </div>
  )
}
```

> Este componente DEVE ficar fora do componente principal da página para evitar
> redefinição a cada render. Definir dentro do componente pai é anti-padrão.

---

### 6.10 Anti-patterns — o que NUNCA fazer em KPI cards

| Anti-padrão | Correto |
|---|---|
| `bg-[#202020] rounded-2xl p-6` | `bg-[#202020] rounded-2xl px-6 py-4 border border-[#474747]` |
| `text-2xl font-bold` no value | `text-[28px] font-bold` |
| `text-sm font-medium uppercase` no label | `text-[14px] font-normal` |
| `text-xs` no sub | `text-[12px]` |
| `mt-1` no sub | `mt-0.5` |
| `text-[#c7c7c7]` no label | `text-[#9e9e9e]` |
| `opacity-70` no sub | cor sólida `text-[#9e9e9e]` |
| Ícone com `text-[#f5f5f5]` | `text-[#BAFF1A]` sempre |
| Container do ícone com `rounded-xl` | `rounded-full` |
| `bg-[#BAFF1A]/10` no container do ícone | `bg-[#323232]` |
| Sem borda no card | `border border-[#474747]` obrigatório |
| `rounded-xl` no card | `rounded-2xl` |
| `grid-cols-1` em mobile | `grid-cols-2` |
| `p-6` uniforme no card | `px-6 py-4` |
| Sub sempre visível (sem condicional) | `{sub && <p>...</p>}` |
| Ícone `w-4 h-4` | `w-6 h-6` no KPI card |

---

## 7. CARDS / CONTAINERS

```tsx
// Standard card
<div className="bg-[#202020] rounded-2xl p-4">

// Card with border
<div className="bg-[#202020] rounded-2xl p-4 border border-[#474747]">

// Section within page (accordion header, panel header)
<div className="bg-[#202020] rounded-2xl p-4 flex items-center justify-between">
```

- `rounded-2xl` (16px) for all cards — NEVER `rounded-lg` on cards
- No shadow in dark mode
- Inner sections / sub-cards: `bg-[#323232] rounded-xl`

---

## 8. BADGES / STATUS CHIPS

```tsx
// Generic badge
<span className="px-2 py-0.5 rounded-full text-xs font-medium bg-[#0e2f13] text-[#229731]">
  Ativo
</span>
```

| Semantic | bg | text |
|----------|-----|------|
| success | `bg-[#0e2f13]` | `text-[#229731]` |
| error/danger | `bg-[#7c1c1c]` | `text-[#ff9c9a]` |
| warning | `bg-[#3a180f]` | `text-[#e65e24]` |
| info | `bg-[#2d0363]` | `text-[#a880ff]` |
| neutral | `bg-[#323232]` | `text-[#c7c7c7]` |
| brand | `bg-[#243300]` | `text-[#BAFF1A]` |

Base: `px-2 py-0.5 rounded-full text-xs font-medium`

**Filter chips (status/period — confirmado via CSS real):**
- Inativo: `px-4 py-1 rounded-full text-[20px] font-normal text-[#f5f5f5] border-2 border-[#323232] hover:border-[#BAFF1A] transition-colors`
- Ativo: `px-4 py-1 rounded-full text-[20px] font-medium text-[#000000] bg-[#BAFF1A] border-2 border-[#BAFF1A]`
- Exemplos: "Em dia", "Pendente", "Atrasado", "Mensal", "Anual", "Sem cobranças"

---

## 9. ALERTS / BANNERS / FEEDBACK BOXES

ALWAYS use SOLID colors. NEVER transparency (`/10`, `/30`).

```tsx
// Brand/info alert (green lime)
<div className="bg-[#243300] border border-[#6b9900] rounded-xl p-4 text-[#BAFF1A]">

// Error banner
<div className="bg-[#7c1c1c] border border-[#ff9c9a] rounded-xl p-4 text-[#ff9c9a]">

// Warning alert
<div className="bg-[#3a180f] border border-[#e65e24] rounded-xl p-4 text-[#e65e24]">

// Success alert
<div className="bg-[#0e2f13] border border-[#229731] rounded-xl p-4 text-[#229731]">
```

Anti-patterns:
- `bg-[#BAFF1A]/10` → WRONG. Use `bg-[#243300]`
- `border-[#BAFF1A]/50` → WRONG. Use `border-[#6b9900]`
- `bg-red-900/30` → WRONG. Use `bg-[#7c1c1c]`
- `bg-[#ff9c9a]/30` → WRONG. Use `bg-[#7c1c1c]`

---

## 10. MODALS

### Regra principal: NUNCA abrir barra de rolagem

O componente `<Modal>` usa `max-h-[96vh] overflow-y-auto`. Para que nunca apareça scrollbar:
- Formulários com 5+ campos: usar `size="lg"` (672px) — NUNCA `size="md"`
- Formulários com upload: SEMPRE `size="lg"` ou maior
- Espaçamento interno do form: `space-y-3` (não `space-y-4`) quando há muitos campos
- Uploads lado a lado: usar `grid grid-cols-2 gap-3` em vez de coluna única

```tsx
// Uso correto do componente Modal do projeto
<Modal
  open={modalOpen}
  onClose={handleCloseModal}
  title="Título"
  size="lg"          // formulários com 5+ campos ou upload
>
  <form onSubmit={handleSave} className="space-y-3">
    {/* campos */}
    <div className="flex gap-3 justify-end pt-1">
      <Button type="button" variant="ghost" onClick={handleCloseModal}>Cancelar</Button>
      <Button type="submit" loading={saving}>Salvar</Button>
    </div>
  </form>
</Modal>
```

### Modal size guide

| size | max-width | When to use |
|------|-----------|-------------|
| `sm` | max-w-md  | Confirmações simples (excluir, confirmar pagamento) |
| `md` | max-w-lg  | Formulários com até 4 campos simples |
| `lg` | max-w-2xl | Formulários com 5+ campos ou qualquer upload |
| `xl` | max-w-4xl | Formulários complexos com múltiplas colunas |

### Aviso condicional no modal (sem crescer a altura)

Para exibir um alerta dentro do modal **sem abrir scrollbar**, inserir o bloco **acima dos botões** de forma compacta (`p-3`, `text-xs`). O form deve usar `space-y-3` e uploads em grid para compensar a altura do alerta:

```tsx
{showWarning && (
  <div className="bg-[#3a180f] border border-[#e65e24] rounded-xl p-3 flex items-start gap-2">
    <AlertCircle className="w-4 h-4 text-[#e65e24] shrink-0 mt-0.5" />
    <div>
      <p className="text-xs font-medium text-[#e65e24]">Título do aviso</p>
      <p className="text-xs text-[#e65e24] mt-0.5 leading-tight opacity-80">
        Descrição curta. Deseja realmente continuar?
      </p>
    </div>
  </div>
)}
<div className="flex gap-3 justify-end pt-1">
  <Button type="button" variant="ghost" onClick={onClose}>Cancelar</Button>
  {showWarning
    ? <Button type="submit" variant="danger">Confirmar mesmo assim</Button>
    : <Button type="submit">Salvar</Button>
  }
</div>
```

---

## 11. LAYOUT STRUCTURE

```
Page wrapper: bg-[#121212] min-h-screen
Sidebar offset: pl-[78px] (fixed sidebar is 80px wide)
Page padding: p-6 md:p-10
Content max-width: none (full width)
```

```tsx
// Standard page with header + table
<div className="min-h-screen bg-[#121212]">
  {/* Sticky toolbar */}
  <div className="sticky top-0 z-10 bg-[#121212] border-b border-[#323232] px-6 py-4
                  flex items-center gap-4">
    <h1 className="text-[28px] font-bold text-[#f5f5f5]">Título da Página</h1>
    <div className="ml-auto flex gap-3">
      <Button variant="secondary">Ação</Button>
      <Button variant="primary">Nova ação</Button>
    </div>
  </div>
  {/* KPI row */}
  <div className="px-6 py-4 grid grid-cols-2 md:grid-cols-4 gap-4">
    {/* KPI cards */}
  </div>
  {/* Filter bar */}
  <div className="px-6 pb-4 flex gap-3">
    {/* search + filter chips */}
  </div>
  {/* Table */}
  <div className="px-6 pb-10">
    <table className="w-full text-[16px]">...</table>
  </div>
</div>
```

---

## 12. SIDEBAR

> Confirmado via CSS real extraído do app.infinitepay.io/home em 2026-04-14.
> Implementado e validado via Playwright em 2026-04-15.
> Implementado em `src/components/layout/Sidebar.tsx` — NÃO recriar, apenas atualizar.

### 12.1 Container principal

| Propriedade | Valor real | Classe Tailwind |
|-------------|-----------|-----------------|
| Position | `fixed` | `fixed inset-y-0 left-0` |
| Largura colapsada | `85px` | `w-[85px]` |
| Largura expandida (hover) | `280px` | `hover:w-[280px]` |
| Altura | `100vh` | `h-screen` |
| Background | `#121212` | `bg-[#121212]` |
| Borda direita | `1px solid #323232` | `border-r border-[#323232]` |
| z-index | `50` | `z-50` |
| Transição | `0.3s cubic-bezier(0.4,0,0.2,1)` | `transition-all duration-300 ease-in-out` |
| Overflow | `hidden` | `overflow-hidden` |
| Flex | coluna | `flex flex-col` |

**Mecanismo de expansão:** puramente via hover (`group` + `group-hover:`). **Sem botão toggle.**
O elemento raiz recebe a classe `group`. Todos os filhos usam `group-hover:` para reagir.

**Offset do conteúdo principal:** `pl-[85px]` (não 78px, não 80px — é 85px).

```tsx
<aside className="group fixed inset-y-0 left-0 z-50 flex flex-col h-screen
                  w-[85px] hover:w-[280px]
                  bg-[#121212] border-r border-[#323232]
                  overflow-hidden transition-all duration-300 ease-in-out">
  {/* ... conteúdo ... */}
</aside>
```

---

### 12.2 Técnica de ocultação do label — CSS Grid Trick (OBRIGATÓRIO)

**NUNCA usar `overflow-x-clip` no wrapper para esconder o texto.** Isso gera corte abrupto e transição horrível.

O label de cada item usa **double-span com CSS Grid** para animar suavemente de largura 0 → auto:

```tsx
{/* Span externo: controla a largura via grid-template-columns */}
<span className="inline-grid [grid-template-columns:0fr] group-hover:[grid-template-columns:1fr]
                 transition-[grid-template-columns,opacity,transform] duration-300 ease-in-out
                 opacity-0 -translate-x-2
                 group-hover:opacity-100 group-hover:translate-x-0
                 overflow-hidden">
  {/* Span interno: mantém o texto em linha única */}
  <span className="whitespace-nowrap overflow-hidden">Label aqui</span>
</span>
```

| Estado | grid-template-columns | opacity | transform |
|--------|-----------------------|---------|-----------|
| Colapsado | `0fr` (largura = 0) | `0` | `translateX(-8px)` |
| Expandido (hover) | `1fr` (largura natural) | `1` | `translateX(0)` |

**Por que funciona:** `grid-template-columns: 0fr` força o conteúdo a 0px de largura sem `display:none`, permitindo a animação CSS. O span interno com `whitespace-nowrap` garante que o texto não quebre linha durante a transição.

**Variável reutilizável recomendada:**
```tsx
const labelClassName =
  'inline-grid [grid-template-columns:0fr] group-hover:[grid-template-columns:1fr] ' +
  'transition-[grid-template-columns,opacity,transform] duration-300 ease-in-out ' +
  'opacity-0 -translate-x-2 group-hover:opacity-100 group-hover:translate-x-0 overflow-hidden'
```

---

### 12.3 Header (área do logo)

```tsx
<div className="pt-6 px-5 pb-2 flex items-center w-[85px] group-hover:w-full
                overflow-hidden transition-all duration-300 ease-in-out">
  <Link href="/dashboard" className="flex items-center gap-3 outline-none rounded-lg">
    <div className="w-10 h-10 flex-shrink-0 bg-[#BAFF1A] rounded-lg flex items-center justify-center">
      <Bike className="w-6 h-6 text-[#121212]" />
    </div>
    <span className={labelClassName}>
      <span className="whitespace-nowrap overflow-hidden text-[#f5f5f5] text-[16px] font-bold">
        GoMoto
      </span>
    </span>
  </Link>
</div>
```

---

### 12.4 Área de navegação (nav scroll)

```tsx
<nav className="flex flex-1 flex-col min-h-0 overflow-hidden group-hover:overflow-y-auto pb-4">
  {/* Nav items aqui */}
</nav>
```

---

### 12.5 Wrapper de cada item de nav

```tsx
<div className="px-4 mb-1">
  {/* Link aqui — SEM overflow-x-clip, SEM w-[85px] no wrapper */}
</div>
```

---

### 12.6 Nav link — ATIVO

```tsx
<Link
  href="/dashboard"
  className="flex items-center gap-2 px-4 h-10 w-full
             bg-[#BAFF1A] text-[#000000]
             rounded-lg text-[14px] font-medium
             transition-all duration-300"
>
  <Icon className="w-5 h-5 flex-shrink-0" />
  <span className={labelClassName}>
    <span className="whitespace-nowrap overflow-hidden">Dashboard</span>
  </span>
</Link>
```

| Propriedade | Valor |
|-------------|-------|
| Background | `#BAFF1A` |
| Cor do texto | `#000000` (preto) |
| Altura | `40px` (h-10) |
| Border radius | `8px` (rounded-lg) |
| Font size | `14px` |
| Font weight | `500` (medium) |
| Gap ícone→texto | `8px` (gap-2) |
| Ícone | `w-5 h-5 flex-shrink-0` |

---

### 12.7 Nav link — INATIVO

```tsx
<Link
  href="/motos"
  className="flex items-center gap-2 px-4 h-10 w-full
             text-[#c7c7c7]
             rounded-lg text-[14px] font-normal
             hover:bg-[#323232] hover:text-[#f5f5f5]
             transition-all duration-300"
>
  <Icon className="w-5 h-5 flex-shrink-0" />
  <span className={labelClassName}>
    <span className="whitespace-nowrap overflow-hidden">Motos</span>
  </span>
</Link>
```

| Propriedade | Valor |
|-------------|-------|
| Background | `transparent` |
| Cor do texto | `#c7c7c7` |
| Hover bg | `#323232` |
| Hover text | `#f5f5f5` |

---

### 12.8 Footer — usuário + logout

```tsx
<div className="border-t border-[#323232] p-3 space-y-1">
  {/* User button */}
  <button className="flex items-center w-full h-10 px-4 gap-2 rounded-lg hover:bg-[#323232] transition-all duration-300">
    <div className="w-6 h-6 rounded-full bg-[#323232] border border-[#474747] flex-shrink-0 flex items-center justify-center">
      <span className="text-[#f5f5f5] text-[11px] font-bold">G</span>
    </div>
    <span className={`${labelClassName} flex-1`}>
      <span className="whitespace-nowrap overflow-hidden flex flex-col text-left">
        <span className="text-[13px] font-medium text-[#f5f5f5] leading-none">GoMoto</span>
        <span className="text-[11px] text-[#9e9e9e] mt-0.5">Admin</span>
      </span>
    </span>
    <MoreVertical className="w-4 h-4 text-[#9e9e9e] flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
  </button>

  {/* Logout */}
  <form action="/auth/logout" method="post">
    <button type="submit" className="flex items-center gap-2 px-4 h-10 w-full
             text-[#c7c7c7] rounded-lg text-[14px] font-normal
             hover:bg-[#7c1c1c] hover:text-[#ff9c9a] transition-all duration-300">
      <LogOut className="w-5 h-5 flex-shrink-0" />
      <span className={labelClassName}>
        <span className="whitespace-nowrap overflow-hidden">Sair</span>
      </span>
    </button>
  </form>
</div>
```

---

### 12.9 Itens de nav do GoMoto

```
Dashboard       → /dashboard    → LayoutDashboard
Fila de Locadores → /fila       → Clock
Manutenção      → /manutencao   → Wrench
Multas          → /multas       → AlertTriangle
Despesas        → /despesas     → TrendingDown
Entradas        → /entradas     → TrendingUp
Cobranças       → /cobrancas    → DollarSign
Motos           → /motos        → Bike
Clientes        → /clientes     → Users
Contratos       → /contratos    → FileText
Relatórios      → /relatorios   → BarChart2
Processos       → /processos    → HelpCircle
Configurações   → /configuracoes → Settings
```

---

### 12.10 Regras obrigatórias

- SEMPRE usar o **CSS Grid Trick** (double-span) para animar o label — NUNCA `overflow-x-clip` no wrapper.
- SEMPRE `flex-shrink-0` nos ícones.
- SEMPRE `whitespace-nowrap overflow-hidden` no span interno do label.
- NUNCA toggle manual — expansão é ONLY hover-based.
- NUNCA `bg-[#202020]` na sidebar — o bg correto é `#121212`.
- NUNCA `w-[80px]` ou `w-[260px]` — os valores corretos são `85px` / `280px`.
- NUNCA `pl-[78px]` no layout — o offset correto é `pl-[85px]`.
- Ícones Lucide: sempre `w-5 h-5` nos nav links.

---

## 13. GOМОТО PAGE PATTERNS

### 13.1 Pattern: List page with KPIs + filters + table
Used by: `/clientes`, `/contratos`, `/cobrancas`, `/entradas`, `/despesas`, `/multas`, `/fila`

```
sticky toolbar: title + actions
KPI grid: 2-4 cards (bg-[#202020] rounded-2xl)
filter bar: search input + filter chips + optional date picker
table: w-full text-[16px] with thead/tbody rules from section 5
```

### 13.2 Pattern: Maintenance/queue page with accordion sections
Used by: `/manutencao`, `/fila`

```
sticky toolbar: title + actions
KPI grid: 2-4 cards
accordion items: bg-[#202020] rounded-2xl (header with chevron)
  expanded content: inner table or card list with bg-[#323232] rounded-xl
```

### 13.3 Pattern: Config/details page
Used by: `/configuracoes`, `/processos`

```
page header: title + optional back button
sections: bg-[#202020] rounded-2xl p-6
  section heading: text-[16px] font-bold border-b border-[#474747] pb-3 mb-4
  setting rows: flex justify-between items-center h-11
    label: text-[16px] text-[#f5f5f5]
    value: text-[16px] text-[#9e9e9e]
```

---

## 13.4 Pattern: Statement / transaction list (Extrato)

> Confirmado via CSS real em `/statements`. Lista vertical de transações agrupadas por data.

```tsx
{/* ─── GRUPO DE DATA ─────────────────────────────────────────────────────
    Header sticky com data (Quarta • 08 Abr, 2026)                       */}
<div className="pt-10 px-6 pb-2">
  <p className="text-[16px] font-medium text-[#f5f5f5]">Quarta • 08 Abr, 2026</p>
</div>

{/* ─── ITEM DE TRANSAÇÃO ──────────────────────────────────────────────── */}
<div className="flex items-center justify-between px-6 h-[80px] hover:bg-[#202020] transition-colors">
  {/* Avatar/icon + info */}
  <div className="flex items-center gap-3">
    <div className="w-10 h-10 rounded-full bg-[#323232] flex items-center justify-center">
      <ArrowDownLeft className="w-5 h-5 text-[#229731]" />
    </div>
    <div>
      <p className="text-[16px] font-medium text-[#f5f5f5]">Nome da transação</p>
      <p className="text-[14px] font-normal text-[#c7c7c7]">Descrição / categoria</p>
    </div>
  </div>
  {/* Valor */}
  <p className="text-[16px] font-medium text-[#229731]">+R$ 250,00</p>
  {/* Débito: text-[#f5f5f5] (branco, não vermelho!) */}
</div>
```

**Tipografia do extrato:**
| Elemento | font-size | font-weight | color |
|----------|-----------|-------------|-------|
| Saldo principal | `text-[24px]` | `font-bold` | `#f5f5f5` |
| Data agrupadora | `text-[16px]` | `font-medium` | `#f5f5f5` |
| Nome da transação | `text-[16px]` | `font-medium` | `#f5f5f5` |
| Descrição / sub | `text-[14px]` | `font-normal` | `#c7c7c7` |
| Valor crédito (+) | `text-[16px]` | `font-medium` | `#229731` |
| Valor débito (-) | `text-[16px]` | `font-medium` | `#f5f5f5` (NÃO vermelho) |

---

## 13.5 Toggle switch

> Confirmado em `/settings` (Ative as notificações). Sempre com `rounded-full`, `w-10 h-6`.

```tsx
<button
  role="switch"
  aria-checked={enabled}
  onClick={() => setEnabled(!enabled)}
  className={`relative w-10 h-6 rounded-full transition-colors ${
    enabled ? 'bg-[#baff1a]' : 'bg-[#9e9e9e]'
  }`}
>
  <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${
    enabled ? 'translate-x-4' : 'translate-x-0'
  }`} />
</button>
```

| Estado | bg | thumb |
|--------|-----|-------|
| ON | `bg-[#baff1a]` | `bg-white translate-x-4` |
| OFF | `bg-[#9e9e9e]` | `bg-white translate-x-0` |

---

## 14. ICONS

Library: **Lucide Icons** (import from `lucide-react`)
NOT InfinitePay SVG system. NOT Phosphor.

Sizes:
- `w-4 h-4` — inside inputs, small contexts
- `w-5 h-5` — buttons, inline
- `w-6 h-6` — KPI cards, section headers
- `w-8 h-8` — large feature icons

Color in dark mode: `text-[#e0e0e0]` default, `text-[#BAFF1A]` brand accent, `text-[#9e9e9e]` muted.

---

## 15. ANIMATIONS

```
Buttons: transition-all duration-150 | hover:scale-[1.025] | active:scale-95
Sidebar expand: transition-[width] duration-300 ease-[cubic-bezier(0.4,0,0.2,1)]
Modals: animate-in fade-in-0 zoom-in-95 (or simple opacity transition)
```

---

## 16. ANTI-PATTERNS CATALOG
> Real bugs found and fixed in GoMoto pages. Never repeat these.

| Wrong | Correct | Reason |
|-------|---------|--------|
| `<table className="text-sm">` | `text-[16px]` | Design system requires 16px body text |
| `<th className="py-3 text-xs uppercase tracking-wider">` | `h-16 font-bold text-[#c7c7c7]` | th height from h-16 on tr, no decorators |
| `<tbody className="divide-y divide-[#323232]">` | `<tbody>` plain | Rows self-handle borders via odd/even |
| `<td className="px-4 py-3">` | `<td className="px-4 font-medium">` | Height from h-16 on tr |
| `<p className="text-sm font-medium uppercase">Label</p>` (KPI) | `text-[14px] font-normal` | KPI labels never uppercase |
| `<p className="text-2xl font-bold">` (KPI) | `text-[28px] font-bold` | Exact token: 28px |
| `bg-[#BAFF1A]/10` | `bg-[#243300]` | No transparency on semantic bg |
| `border-[#BAFF1A]/50` | `border-[#6b9900]` | No transparency on semantic borders |
| `bg-[#7c1c1c]/30` or `bg-red-900/30` | `bg-[#7c1c1c]` | Error bg is solid |
| `{/* comment */}` between `map(item => (` and `<tr>` | `/* comment */` (JS, not JSX) | JSX expressions invalid there |
| Mixing `<th>` open with `</td>` close | Match tags correctly | TypeScript/JSX parse error |
| KPI: icon LEFT, text RIGHT | text LEFT, icon RIGHT — `justify-between`, ícone dentro de `bg-[#323232] p-3 rounded-full` | Layout obrigatório do design system |
| `border-[#BAFF1A]/50` on upload drop zone | `border-[#BAFF1A]` solid | No transparency |

---

## 17. FILE STRUCTURE (GoMoto project)

```
src/
├── app/(dashboard)/
│   ├── fila/page.tsx
│   ├── manutencao/page.tsx
│   ├── multas/page.tsx
│   ├── despesas/page.tsx
│   ├── clientes/page.tsx
│   ├── contratos/page.tsx
│   ├── cobrancas/page.tsx
│   ├── entradas/page.tsx
│   ├── motos/page.tsx
│   ├── relatorios/page.tsx
│   ├── processos/page.tsx
│   └── configuracoes/page.tsx
├── components/
│   ├── ui/
│   │   ├── Button.tsx  — variants: primary/secondary/ghost/danger/outline
│   │   ├── Badge.tsx   — Badge + StatusBadge
│   │   ├── Card.tsx    — Card + StatCard
│   │   ├── Input.tsx   — Input + Select + Textarea
│   │   ├── Modal.tsx   — Modal with backdrop
│   │   └── Table.tsx   — generic Table
│   └── layout/
│       ├── Sidebar.tsx — fixed nav
│       └── Header.tsx  — page header
├── lib/
│   ├── supabase/client.ts
│   ├── supabase/server.ts
│   └── utils.ts  — formatCurrency, formatDate, cn, getStatusColor
└── types/index.ts
```

---

## 18. SUPABASE / DATA RULES

- All table names: English (`motorcycles`, `customers`, `contracts`, `fines`, `maintenance`, `expenses`)
- All column names: English (`name`, `status`, `created_at`, `due_date`, `amount`)
- Queries: use `src/lib/supabase/client.ts` (browser) or `src/lib/supabase/server.ts` (server)
- Types: defined in `src/types/index.ts` — always update when adding new fields

---

## 19. DATA GRID — PADRÃO OBRIGATÓRIO ÚNICO

> **REGRA ABSOLUTA:** Toda tela que exibe listagem de dados DEVE usar exatamente este padrão.
> NUNCA usar o componente `<Table>` genérico. NUNCA inventar variações. NUNCA adaptar "por contexto".
> O grid é sempre igual. O que muda é o conteúdo das colunas, não a estrutura, cores ou comportamento.
> **Referência de verdade:** `/manutencao/page.tsx` — grid perfeito validado pelo usuário.

---

### 19.1 Estrutura completa do grid

```tsx
{/* ─── CONTAINER EXTERNO ───────────────────────────────────────────────────
    NUNCA usar <Card> ou div genérica. Sempre este exato padrão. */}
<div className="overflow-hidden rounded-2xl border border-[#474747] bg-[#202020]">

  {/* ─── SCROLL HORIZONTAL ───────────────────────────────────────────────
      Obrigatório para tabelas não quebrarem em telas menores. */}
  <div className="overflow-x-auto">

    {/* ─── ELEMENTO TABLE ──────────────────────────────────────────────────
        SEMPRE: w-full text-left text-[13px] text-[#f5f5f5]
        text-left → alinha todo conteúdo à esquerda por padrão
        text-[13px] → fonte base de todas as células (compacto, preferência do usuário)
        text-[#f5f5f5] → cor base herdada pelas células */}
    <table className="w-full text-left text-[13px] text-[#f5f5f5]">

      {/* ─── CABEÇALHO ───────────────────────────────────────────────────
          SEMPRE: bg-[#323232] text-[#c7c7c7] no <thead>
          bg-[#323232] → fundo cinza médio para separar visualmente do corpo
          text-[#c7c7c7] → cor secundária para labels de coluna */}
      <thead className="bg-[#323232] text-[#c7c7c7]">
        <tr>
          {/* ─── TH PADRÃO ─────────────────────────────────────────────
              h-9 → altura fixa 36px (NÃO usar py-3 nunca)
              px-4 → padding horizontal de 16px
              font-bold → peso 700
              NÃO colocar: text-xs, uppercase, tracking-wider, py-3
              NÃO colocar: text-left (já herdado do <table>)
              NÃO colocar: text-[13px] no próprio <th> */}
          <th className="h-9 px-4 font-bold">Item</th>
          <th className="h-9 px-4 font-bold">Previsão</th>
          <th className="h-9 px-4 font-bold">Situação</th>
          <th className="h-9 px-4 font-bold">Status</th>

          {/* ─── TH DE AÇÕES ───────────────────────────────────────────
              Única coluna com alinhamento diferente: text-right
              Botões de ação sempre alinhados à direita da tabela */}
          <th className="h-9 px-4 text-right font-bold">Ações</th>
        </tr>
      </thead>

      {/* ─── CORPO DA TABELA ─────────────────────────────────────────────
          SEM NENHUMA CLASSE no <tbody>
          NUNCA: divide-y, divide-[#323232], border ou qualquer classe */}
      <tbody>
        {items.map((item) => (
          /* ─── LINHA DA TABELA ────────────────────────────────────────
              h-9 → altura fixa 36px (NÃO usar py em td)
              transition-colors → anima suavemente o hover e o estado
              odd:bg-transparent → linhas ímpares com fundo transparente (herda bg-[#202020] do container)
              even:bg-[#323232] → linhas pares com fundo cinza (zebra)
              hover:bg-[#474747] → hover uniforme em toda a linha
              cursor-pointer → quando a linha inteira é clicável
              NUNCA: border-b, border-t em <tr> */}
          <tr
            key={item.id}
            className="h-9 transition-colors odd:bg-transparent even:bg-[#323232] hover:bg-[#474747] cursor-pointer"
            onClick={() => handleView(item)}
          >

            {/* ─── TD PADRÃO ───────────────────────────────────────────
                px-4 → padding horizontal de 16px
                NUNCA: py-3, py-2 — altura vem do h-16 no <tr>
                NUNCA: text-sm, font-medium no próprio <td>
                O font-medium e cores ficam nos elementos filhos (<p>, <span>) */}
            <td className="px-4">
              {/* Texto principal da célula */}
              <p className="font-medium text-[#f5f5f5]">{item.description}</p>
              {/* Sub-info opcional abaixo do texto principal */}
              <p className="text-xs text-[#616161]">Detalhe secundário</p>
            </td>

            <td className="px-4">
              <p className="text-[#f5f5f5]">{item.value}</p>
            </td>

            <td className="px-4">
              {/* Conteúdo dinâmico — ver seção 19.6 para todas as variações */}
            </td>

            <td className="px-4">
              {/* Badges de status — ver seção 19.7 */}
            </td>

            {/* ─── TD DE AÇÕES ─────────────────────────────────────────
                px-4 text-right → padding + alinhamento à direita
                justify-end nos botões internos */}
            <td className="px-4 text-right">
              <div className="flex items-center justify-end gap-1">
                {/* Botões de ação — ver seção 19.4 */}
              </div>
            </td>

          </tr>
        ))}
      </tbody>
    </table>
  </div>
</div>
```

---

### 19.2 Checklist obrigatório — elemento por elemento

| Elemento | String de classes OBRIGATÓRIA | O que NUNCA colocar |
|----------|-------------------------------|---------------------|
| Container externo | `overflow-hidden rounded-2xl border border-[#474747] bg-[#202020]` | `rounded-lg`, `rounded-xl`, `<Card>`, shadow |
| Wrapper scroll | `overflow-x-auto` | nenhum outro |
| `<table>` | `w-full text-left text-[13px] text-[#f5f5f5]` | `text-sm`, `text-right`, componente `<Table>` |
| `<thead>` | `bg-[#323232] text-[#c7c7c7]` | só bg sem o `text-[#c7c7c7]` |
| `<tr>` do header | sem classes adicionais | `bg-[#323232]` no `<tr>` — já está no `<thead>` |
| `<th>` padrão | `h-9 px-4 font-bold` | `py-3`, `py-2`, `text-xs`, `uppercase`, `tracking-wider`, `tracking-widest`, `text-[13px]`, `text-left` |
| `<th>` Ações | `h-9 px-4 text-right font-bold` | alinhar à esquerda |
| `<tbody>` | _(sem classes)_ | `divide-y`, `divide-[#323232]`, qualquer classe |
| `<tr>` dados | `h-9 transition-colors odd:bg-transparent even:bg-[#323232] hover:bg-[#474747]` | `border-b`, `border-t`, `border` |
| `<tr>` clicável | adicionar `cursor-pointer` ao final | `onClick` na `<td>` em vez da `<tr>` |
| `<tr>` histórico dimmed | adicionar `opacity-70` (colapsado) ou `opacity-80` (view direta) | `opacity-50`, `opacity-60` |
| `<td>` padrão | `px-4` | `py-3`, `py-2`, `py-1`, `text-sm`, `font-medium` no td |
| `<td>` Ações | `px-4 text-right` | alinhar à esquerda |

---

### 19.3 Estados obrigatórios (loading / empty)

**Loading — dentro da tabela (quando a tabela já está montada):**
```tsx
<tbody>
  <tr>
    <td colSpan={N}>  {/* N = número total de colunas */}
      <div className="flex items-center justify-center py-16">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-[#BAFF1A] border-t-transparent" />
      </div>
    </td>
  </tr>
</tbody>
```

**Loading — antes da tabela renderizar (loading da página inteira):**
```tsx
<div className="flex items-center justify-center py-20">
  <div className="h-6 w-6 animate-spin rounded-full border-2 border-[#BAFF1A] border-t-transparent" />
</div>
```

**Empty — dentro da tabela:**
```tsx
<tbody>
  <tr>
    <td colSpan={N}>
      <div className="flex flex-col items-center justify-center py-16 gap-3">
        <div className="w-12 h-12 bg-[#323232] rounded-full flex items-center justify-center">
          <IconName className="w-6 h-6 text-[#9e9e9e]" />
        </div>
        <p className="text-[16px] text-[#9e9e9e]">Nenhum item encontrado.</p>
        <button
          onClick={() => { setFilter('all'); setSearch('') }}
          className="text-sm text-[#BAFF1A] hover:underline"
        >
          Limpar filtros
        </button>
      </div>
    </td>
  </tr>
</tbody>
```

**Empty — quando a tabela inteira está ausente (ex: accordions):**
```tsx
<div className="flex flex-col items-center justify-center rounded-2xl border border-[#474747] bg-[#202020] p-16 text-center">
  <IconName className="mb-4 h-12 w-12 text-[#474747]" />
  <p className="text-lg font-medium text-[#f5f5f5]">Nenhum item encontrado.</p>
  <p className="mt-1 text-sm text-[#9e9e9e]">Ajuste os filtros ou cadastre um novo item.</p>
</div>
```

---

### 19.4 Botões de ação — especificação completa e IMUTÁVEL

> **REGRA ABSOLUTA:** Os botões de ação são sempre quadrados (`h-8 w-8 p-0`), só ícone, sem texto.
> A ordem é sempre: **Ver → Editar → (Ação especial) → Excluir**. Nunca inverter. Nunca trocar ícone.
> SEMPRE usar o componente `<Button>`, nunca `<button>` raw nos botões de ação.

```tsx
{/* Layout container dos botões — sempre igual */}
<div className="flex items-center justify-end gap-1">

  {/* 1º botão: Ver detalhes ─────────────────────────────────────────────
      variant="secondary" → bg-[#323232] text-[#f5f5f5] hover:bg-[#474747]
      size="sm" → dimensões sm do componente Button
      className="h-8 w-8 p-0" → quadrado fixo 32×32px, sem padding interno
      title → tooltip nativo do browser
      e.stopPropagation() → não acionar onClick da <tr> */}
  <Button
    variant="secondary"
    size="sm"
    className="h-8 w-8 p-0"
    title="Ver detalhes"
    onClick={(e) => { e.stopPropagation(); handleView(item) }}
  >
    <Eye className="h-4 w-4" />
    {/* h-4 w-4 → 16px — tamanho obrigatório dentro de botões compactos h-8 w-8 */}
  </Button>

  {/* 2º botão: Editar ───────────────────────────────────────────────────
      Mesmo padrão exato do Ver, só muda variant e ícone */}
  <Button
    variant="secondary"
    size="sm"
    className="h-8 w-8 p-0"
    title="Editar"
    onClick={(e) => { e.stopPropagation(); handleEdit(item) }}
  >
    <Edit2 className="h-4 w-4" />
  </Button>

  {/* 3º botão: Ação especial (OPCIONAL — ex: Concluir, Aprovar, Pagar) ──
      Entra ENTRE Editar e Excluir quando existir
      variant="primary" → bg-[#BAFF1A] text-[#000000] */}
  <Button
    variant="primary"
    size="sm"
    className="h-8 w-8 p-0"
    title="Registrar conclusão"
    onClick={(e) => { e.stopPropagation(); handleComplete(item) }}
  >
    <CheckCircle2 className="h-4 w-4" />
  </Button>

  {/* Último botão: Excluir ──────────────────────────────────────────────
      SEMPRE o último. variant="danger" → bg-[#bf1d1e] text-[#f5f5f5] */}
  <Button
    variant="danger"
    size="sm"
    className="h-8 w-8 p-0"
    title="Excluir"
    onClick={(e) => { e.stopPropagation(); handleDelete(item.id) }}
  >
    <Trash2 className="h-4 w-4" />
  </Button>

</div>
```

**Tabela de referência dos botões de ação:**

| Posição | Ação | Ícone Lucide | Variante | Cor resultante |
|---------|------|-------------|----------|---------------|
| 1º | Ver detalhes | `Eye` | `secondary` | `bg-[#323232]` |
| 2º | Editar | `Edit2` | `secondary` | `bg-[#323232]` |
| 3º (se existir) | Ação especial | contextual | `primary` | `bg-[#BAFF1A]` |
| Último | Excluir | `Trash2` | `danger` | `bg-[#bf1d1e]` |

**Ícone dentro do botão de ação:** SEMPRE `h-4 w-4` — nunca `h-5 w-5` em botões `h-8 w-8 p-0`.

---

### 19.5 Barra de filtros — estrutura completa

```tsx
{/* ─── WRAPPER DA BARRA DE FILTROS ─────────────────────────────────────────
    flex-col em mobile, flex-row em sm+
    justify-between separa pílulas (esquerda) de dropdowns+busca (direita) */}
<div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">

  {/* ─── ESQUERDA: PÍLULAS DE STATUS ──────────────────────────────────────
      Filtros rápidos por status ou agrupamento principal.
      Ativo: bg-[#BAFF1A] text-[#000000] (lime sólido)
      Inativo: bg-[#202020] border border-[#474747] text-[#9e9e9e]
      Hover inativo: hover:text-[#f5f5f5] hover:border-[#616161] */}
  <div className="flex gap-2 flex-wrap">
    {tabs.map((tab) => (
      <button
        key={tab.value}
        onClick={() => setStatusFilter(tab.value)}
        className={`px-4 py-2 rounded-full text-sm font-medium transition-all ${
          statusFilter === tab.value
            ? 'bg-[#BAFF1A] text-[#000000]'
            : 'bg-[#202020] border border-[#474747] text-[#9e9e9e] hover:text-[#f5f5f5] hover:border-[#616161]'
        }`}
      >
        {tab.label}
        {/* Contador: ml-1.5 opacity-70 — NUNCA badge separado, sempre inline */}
        {tab.count > 0 && (
          <span className="ml-1.5 opacity-70">({tab.count})</span>
        )}
      </button>
    ))}
  </div>

  {/* ─── DIREITA: DROPDOWNS + BUSCA ───────────────────────────────────────
      Dropdowns de refinamento por tipo, moto, etc. + campo de busca textual.
      Todos com h-10 rounded-full — NUNCA rounded-lg aqui */}
  <div className="flex items-center gap-2 flex-wrap">

    {/* Dropdown de agrupamento (ex: por moto) ─────────────────────────────
        h-10 → altura 40px
        rounded-full → pílula (consistente com as pílulas de status)
        border border-[#474747] → borda cinza padrão
        bg-[#202020] → fundo card
        px-3 → padding interno
        text-sm text-[#f5f5f5] → fonte sm, cor primária
        focus:border-[#BAFF1A] → destaque verde no foco
        focus:outline-none → remove outline padrão do browser */}
    <select
      value={motorcycleFilter}
      onChange={(e) => setMotorcycleFilter(e.target.value)}
      className="h-10 rounded-full border border-[#474747] bg-[#202020] px-3 text-sm text-[#f5f5f5] focus:border-[#BAFF1A] focus:outline-none"
    >
      <option value="">Todas as motos</option>
      {motorcycles.map((m) => (
        {/* className="bg-[#202020]" obrigatório em cada <option> */}
        <option key={m.id} value={m.id} className="bg-[#202020]">
          {m.license_plate} — {m.make} {m.model}
        </option>
      ))}
    </select>

    {/* Dropdown por tipo ───────────────────────────────────────────────────
        Mesmo padrão exato do dropdown de moto */}
    <select
      value={typeFilter}
      onChange={(e) => setTypeFilter(e.target.value)}
      className="h-10 rounded-full border border-[#474747] bg-[#202020] px-3 text-sm text-[#f5f5f5] focus:border-[#BAFF1A] focus:outline-none"
    >
      <option value="all">Todos os tipos</option>
      <option value="preventive">Preventiva</option>
      <option value="corrective">Corretiva</option>
    </select>

    {/* Campo de busca textual ──────────────────────────────────────────────
        Posição relativa para o ícone absoluto funcionar
        pl-9 → espaço para o ícone de lupa à esquerda
        pr-4 → padding direito padrão
        w-44 → largura fixa 176px */}
    <div className="relative">
      {/* Ícone da lupa: absolute, centralizado verticalmente, cor [#616161] */}
      <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[#616161]" />
      <input
        type="text"
        placeholder="Buscar..."
        value={searchQuery}
        onChange={(e) => setSearchQuery(e.target.value)}
        className="h-10 rounded-full border border-[#474747] bg-[#202020] pl-9 pr-4 text-sm text-[#f5f5f5] placeholder:text-[#616161] focus:border-[#BAFF1A] focus:outline-none w-44"
      />
    </div>

  </div>
</div>
```

**Tabela de referência dos filtros:**

| Elemento | String de classes completa |
|----------|---------------------------|
| Wrapper geral | `flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between` |
| Grupo pílulas | `flex gap-2 flex-wrap` |
| Pílula base | `px-4 py-2 rounded-full text-sm font-medium transition-all` |
| Pílula ATIVA | `+ bg-[#BAFF1A] text-[#000000]` |
| Pílula INATIVA | `+ bg-[#202020] border border-[#474747] text-[#9e9e9e] hover:text-[#f5f5f5] hover:border-[#616161]` |
| Contador na pílula | `ml-1.5 opacity-70` dentro de `<span>` inline |
| Grupo direita | `flex items-center gap-2 flex-wrap` |
| `<select>` dropdown | `h-10 rounded-full border border-[#474747] bg-[#202020] px-3 text-sm text-[#f5f5f5] focus:border-[#BAFF1A] focus:outline-none` |
| `<option>` | `className="bg-[#202020]"` em cada um |
| Container busca | `relative` |
| Ícone lupa | `absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[#616161]` |
| `<input>` busca | `h-10 rounded-full border border-[#474747] bg-[#202020] pl-9 pr-4 text-sm text-[#f5f5f5] placeholder:text-[#616161] focus:border-[#BAFF1A] focus:outline-none w-44` |

---

### 19.6 Tipografia das células — guia completo

Toda a tipografia fica nos elementos filhos dentro de `<td className="px-4">`. O `<td>` em si nunca recebe font-size, font-weight ou color.

**Texto principal da célula (linha 1):**
```tsx
<p className="font-medium text-[#f5f5f5]">Nome do item</p>
```

**Sub-informação abaixo do texto principal (linha 2):**
```tsx
<p className="text-xs text-[#616161]">Detalhe secundário — ex: "Atual: 12.000 km"</p>
```

**Placa / código / dado monoespaçado:**
```tsx
<span className="font-mono font-bold text-[#f5f5f5] tracking-widest">ABC1D23</span>
```

**Dado numérico / valor / KM:**
```tsx
<p className="text-[#f5f5f5]">15.000 km</p>
```

**Dado secundário simples (sem peso especial):**
```tsx
<p className="text-[#c7c7c7]">Honda CG 160</p>
```

**Dado de histórico (concluído, dimmed):**
```tsx
{/* A linha <tr> recebe opacity-70 ou opacity-80, e o texto muda para [#c7c7c7] */}
<p className="text-[#c7c7c7]">Troca de óleo</p>
```

**Valor monetário em destaque (brand):**
```tsx
<span className="font-bold text-[#BAFF1A]">{formatCurrency(value)}</span>
```

**Dado ausente / vazio:**
```tsx
<span className="text-[#9e9e9e]">—</span>
```

**Texto de situação dinâmica (ex: "Faltam 500km", "Vencida há 3 dias"):**
```tsx
{/* Vencida / erro */}
<span className="text-sm font-medium text-[#ff9c9a]">Vencida há 1.000 km</span>

{/* Próxima / urgente (≤ threshold) */}
<span className="text-sm font-medium text-[#e65e24]">Faltam 80 km</span>

{/* Normal / longe do vencimento */}
<span className="text-sm font-medium text-[#9e9e9e]">Faltam 3.500 km</span>

{/* Concluída — exibe texto auxiliar como oficina */}
<span className="text-xs text-[#9e9e9e]">Oficina Central</span>
```

**Dois elementos empilhados na mesma célula (dado + subinfo):**
```tsx
<td className="px-4">
  <div>
    {/* Linha 1: dado principal */}
    <p className="text-[#f5f5f5]">15.000 km</p>
    {/* Linha 2: contexto ou sub-info */}
    <p className="text-xs text-[#616161]">Atual: 12.400 km</p>
  </div>
</td>
```

**Ícone + texto lado a lado (ex: usuário com nome):**
```tsx
<td className="px-4">
  <div className="flex items-center gap-1.5">
    <User className="w-4 h-4 text-[#a880ff] flex-shrink-0" />
    <span className="text-[#f5f5f5] truncate">{customer.name}</span>
  </div>
</td>
```

---

### 19.7 Badges de status dentro das células

**Badge de status de manutenção (ou qualquer status semântico):**
```tsx
{/* Base obrigatória para todos os badges */}
<span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-[#7c1c1c] text-[#ff9c9a]">
  Vencida
</span>
```

| Status | bg | text | Label |
|--------|----|------|-------|
| Vencida / erro | `bg-[#7c1c1c]` | `text-[#ff9c9a]` | "Vencida" |
| Próxima / warning | `bg-[#3a180f]` | `text-[#e65e24]` | "Próxima" |
| Agendada / info | `bg-[#2d0363]` | `text-[#a880ff]` | "Agendada" |
| Concluída / success | `bg-[#0e2f13]` | `text-[#229731]` | "Concluída" |
| Ativo | `bg-[#0e2f13]` | `text-[#229731]` | "Ativo" |
| Inativo / neutro | `bg-[#323232]` | `text-[#c7c7c7]` | "Inativo" |
| Brand / destaque | `bg-[#243300]` | `text-[#BAFF1A]` | contextual |

**Status como texto colorido sem badge (padrão /invoices — Gestão de Cobrança):**
> Na tabela de cobranças o status é texto puro sem fundo — `font-weight: 700`, `font-size: 16px` (no GoMoto usar 13px por preferência)
```tsx
// Recebida
<span className="text-[#a880ff] font-bold">Recebida</span>
// Pendente
<span className="text-[#e65e24] font-bold">Pendente</span>
// Atrasada
<span className="text-[#ff9c9a] font-bold">Atrasada</span>
// Aprovada / Paga
<span className="text-[#229731] font-bold">Paga</span>
```

**Badge com bordas (ex: selo de manutenção em dia):**
```tsx
<span className="flex items-center gap-2 px-3 py-1 rounded-full bg-[#0e2f13] border border-[#229731] text-[#229731] text-xs font-medium">
  <CheckCircle className="w-3.5 h-3.5" />
  Manutenção em Dia
</span>
```

---

### 19.8 Linhas de histórico (dimmed / concluído)

Quando a tabela exibe registros históricos (itens concluídos), a linha inteira recebe opacidade reduzida:

```tsx
{/* Histórico na view direta (aba "Concluídas") */}
<tr className="h-16 transition-colors odd:bg-transparent even:bg-[#323232] hover:bg-[#474747] opacity-80">

{/* Histórico na gaveta colapsável */}
<tr className="h-16 transition-colors odd:bg-transparent even:bg-[#323232] hover:bg-[#474747] opacity-70">
```

O texto dentro dessas linhas usa `text-[#c7c7c7]` em vez de `text-[#f5f5f5]` para reforçar o estado dimmed.

---

### 19.9 Anti-patterns do grid

| Errado | Correto | Motivo |
|--------|---------|--------|
| `<Table columns={...} data={...} />` | `<table>` HTML puro | Componente genérico viola o padrão |
| `<Card>` envolvendo a tabela | `<div className="overflow-hidden rounded-2xl border border-[#474747] bg-[#202020]">` | Card não tem overflow-hidden correto |
| `<div>` grid fake como tabela | `<table><thead><tbody>` HTML semântico | Grid fake não respeita acessibilidade nem padrão |
| `font-medium` no `<td>` | `font-medium` no `<p>` filho | td só recebe px-4, estilo fica nos filhos |
| `text-sm` no `<td>` | `text-sm` nos filhos quando necessário | Herda text-[16px] do `<table>` |
| `py-3` no `<td>` ou `<th>` | `h-16` no `<tr>` | Altura vem da linha, nunca do padding |
| `divide-y` no `<tbody>` | `odd/even` no `<tr>` | Zebra via odd/even, sem borders |
| `border-b` no `<tr>` | `hover:bg-[#474747]` no `<tr>` | Separação visual vem do hover e zebra |
| `text-xs uppercase tracking-wider` no `<th>` | `font-bold` puro | Headers nunca decorados |
| Botão de ação com texto | `h-8 w-8 p-0` só ícone | Botões de ação são sempre icônicos |
| `h-5 w-5` dentro de `h-8 w-8 p-0` | `h-4 w-4` | Ícone 16px em botão 32px compacto |
| `variant="ghost"` nos botões Ver/Editar | `variant="secondary"` | Ghost não tem contraste suficiente |
| Ordem Excluir → Editar | Ver → Editar → (especial) → Excluir | Ordem é imutável |
| `<button>` raw nos botões de ação | `<Button>` component | Component garante hover/scale/transition |
| Busca fora da barra de filtros | Busca dentro do wrapper `justify-between` | Estrutura unificada é obrigatória |
| Filtro com `rounded-lg` | `rounded-full` | Filtros são sempre pílulas |
| `focus:ring` ou `focus:border-[#BAFF1A]/50` nos filtros | `focus:border-[#BAFF1A]` sólido | Sem transparência em borders de foco |
| Transparência `/10` `/20` `/30` em qualquer cor semântica | Cores hex sólidas da seção 1 | Anti-pattern global do design system |

---

## 20. CODE CONVENTIONS

- All code: **English** (variables, functions, types, files, routes, DB columns)
- UI labels: Portuguese Brasil (what users see on screen)
- Comments/JSDoc: Portuguese Brasil
- TypeScript strict — no `any`, always type interfaces
- `'use client'` required on pages with useState/useEffect/event handlers
- Format currency: `formatCurrency(value)` from `src/lib/utils.ts`
- Format dates: `formatDate(date)` from `src/lib/utils.ts`
- Status colors: `getStatusColor(status)` from `src/lib/utils.ts`
- **Grids/tabelas:** seguir OBRIGATORIAMENTE a seção 19 — sem exceções

---

## 21. INFINITEPAY PAGE INVENTORY
> Varredura completa em 2026-04-13 — app.infinitepay.io. 17 páginas + 9 modais/drawers/flows mapeados via browser_evaluate.

### 21.1 Navegação sidebar — URLs e labels

| Rota | Label | Grupo |
|------|-------|-------|
| `/home` | Home | — |
| `/statements` | Seu extrato | Seu banco ▾ |
| `/cards` | Cartões e mais | Seu banco ▾ |
| `/lending` | Empréstimo Inteligente | Seu banco ▾ |
| `/sales` | Suas vendas | — |
| `/invoices` | Gestão de Cobrança | — |
| `/social-shop` | Sua Loja Online | — |
| `/plans` | Planos e Assinaturas | — |
| `/booking` | Agendamentos | — |
| `/external-checkout` | Checkout | — |
| `/products` | Seu catálogo | — |
| `/receivables` | Seus recebimentos | — |
| `/clients` | Seus clientes | — |
| `/das-mei` | DAS MEI | — |
| `/link-na-bio` | Seu Link na Bio | — |
| `/referral` | Indique e ganhe | — |
| `/settings` | Configurações | user menu ▾ |

### 21.2 Padrão de cada página

| Rota | Tipo de layout | Componentes principais |
|------|---------------|----------------------|
| `/home` | Dashboard | Saldo + quick actions, promo cards, extrato preview |
| `/statements` | Extrato | Saldo + quick actions, informe banner, lista de transações por data |
| `/cards` | Cartões | Lista de cartões (card visual), painel lateral de detalhes |
| `/lending` | Promo landing | Imagem + benefícios + CTA |
| `/sales` | List + KPI | Tabs (Visão geral/Gráficos), KPI strip, action bar, tabela |
| `/invoices` | List | Action bar, tabela de cobranças |
| `/social-shop` | Pedidos + modal onboarding | Tabela de pedidos, modal carrossel de boas-vindas |
| `/plans` | List | KPI strip, tabs (Assinaturas/Meus planos), action bar |
| `/booking` | Promo landing | Imagem + benefícios + CTA |
| `/external-checkout` | Config + tabs | Tabs (Seu Checkout/Demonstração/Configurações), promo card |
| `/products` | List | Tabela simples (Produto, Categoria, Inventário, Preço, Loja online, Ações) |
| `/receivables` | Period + list | Period selector cards, tabela de lançamentos |
| `/clients` | List | Action bar com busca + filtros, tabela (Nome, Status, Telefone, E-mail) |
| `/das-mei` | Empty state | Warning icon + mensagem |
| `/link-na-bio` | Editor + preview | Editor esquerda, iframe preview direita |
| `/referral` | Promo landing | Imagem + steps list + CTA |
| `/settings` | Config tabbada | Tabs horizontais + seções de linhas com chevron |
| `/pay/bank-slip` | Form wizard | Input código de barras + upload PDF, CTA continuar |
| `/invoices/create` | Form wizard | Steps: destinatário → valor → descrição → revisão |
| `/plans/create` | Form wizard | Steps: nome → valor → descrição → frequência → revisão |
| `/clients/manage/{id}` | Detail page | Header nome, CTAs, cards de cobranças |
| `?modal=pix-key` | Drawer 620px | QR Code + chave Pix + botão imprimir |
| `?modal=details_{id}` | Drawer 620px | Valor 40px + campos + dividers dotted |
| `?modal=Statement_{id}` | Drawer 620px | Valor 40px + campos + dividers dotted |
| `Filtros drawer` | Drawer 620px | Chips por Status/Tipo/Meio + botão Aplicar |

---

## 22. ACTION BAR — PADRÃO TOPO-DIREITO DE LISTAGENS

> Padrão observado em: `/sales`, `/invoices`, `/cards`, `/receivables`, `/plans`, `/clients`
> Sempre no topo-direito da área de conteúdo, acima da tabela.

### 22.1 Estrutura completa

```tsx
{/* ─── ACTION BAR ────────────────────────────────────────────────────────────
    flex items-center gap-2 — grupo horizontal
    Elementos em ordem: [DatePicker] → [Filtros] → [Relatório]            */}
<div className="flex items-center gap-2">

  {/* Date range button ─────────────────────────────────────────────────────
      Contém: ícone de calendário + texto descritivo do período
      Ex: "Últimas vendas", "Últimas cobranças", "13 Jan, 2026 - 13 Abr, 2026" */}
  <button className="flex items-center gap-1.5 h-10 px-6 rounded-full bg-[#323232] text-[#ffffff] font-medium text-[16px] hover:bg-[#474747] transition-colors">
    <CalendarDays className="w-4 h-4" />
    <span>Últimas vendas</span>
  </button>

  {/* Filtros button ────────────────────────────────────────────────────────
      Contém: ícone de filtro + texto "Filtros"
      Pode ter um contador de filtros ativos: badge numérico */}
  <button className="flex items-center gap-1.5 h-10 px-6 rounded-full bg-[#323232] text-[#ffffff] font-medium text-[16px] hover:bg-[#474747] transition-colors">
    <Filter className="w-4 h-4" />
    <span>Filtros</span>
  </button>

  {/* Relatório/Exportar button ─────────────────────────────────────────────
      Contém: ícone de download + texto "Exportar CSV"
      Pode estar disabled quando não há dados (opacity-50 cursor-not-allowed) */}
  <button
    className="flex items-center gap-1.5 h-10 px-6 rounded-full bg-[#323232] text-[#ffffff] font-medium text-[16px] hover:bg-[#474747] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
  >
    <ArrowDownToLine className="w-4 h-4" />
    <span>Relatório</span>
  </button>

</div>
```

### 22.2 Regras do action bar

| Elemento | Obrigatório | Proibido |
|----------|------------|---------|
| Altura | `h-10` (40px) | `h-9`, `h-8` |
| Formato | `rounded-full` (pílula) | `rounded-md`, `rounded-lg` |
| Fundo | `bg-[#323232]` | `bg-[#202020]`, `bg-transparent`, borda sem bg |
| Texto | `text-[#ffffff] font-medium text-[16px]` | `text-sm`, `text-[#f5f5f5]` |
| Hover | `hover:bg-[#474747]` | `hover:bg-[#BAFF1A]` (esses não são primary) |
| CTA principal | `bg-[#BAFF1A] text-[#000000] h-10 px-6 font-medium` | usar BAFF1A em btns secundários |
| Ícone | `w-4 h-4` | `w-5 h-5` |
| Ordem | DatePicker → Filtros → Exportar → [CTA principal] | qualquer outra ordem |

---

## 23. QUICK ACTIONS NAV — BOTÕES HORIZONTAIS DE AÇÃO RÁPIDA

> Padrão observado em: `/home`, `/statements`
> Botões de ação rápida dispostos em linha horizontal: Pix, Pagar, Cartões, Vendas

```tsx
{/* ─── QUICK ACTIONS NAV ─────────────────────────────────────────────────────
    navigation com role semântico
    Botões: ícone em cima + label em baixo, fundo circle/pill             */}
<nav className="flex items-center gap-1">

  {/* Cada ação: ícone centralizado + label abaixo */}
  {[
    { icon: Zap,       label: 'Pix'     },
    { icon: Barcode,   label: 'Pagar'   },
    { icon: CreditCard,label: 'Cartões' },
    { icon: ShoppingCart, label: 'Vendas' },
  ].map(({ icon: Icon, label }) => (
    <button
      key={label}
      className="flex flex-col items-center gap-1 px-4 py-2 rounded-xl hover:bg-[#323232] transition-colors"
    >
      <div className="w-10 h-10 flex items-center justify-center bg-[#323232] rounded-full">
        <Icon className="w-5 h-5 text-[#BAFF1A]" />
      </div>
      <span className="text-xs text-[#c7c7c7]">{label}</span>
    </button>
  ))}

</nav>
```

**Regras:**
- Ícone em círculo `bg-[#323232] rounded-full w-10 h-10`
- Cor do ícone: sempre `text-[#BAFF1A]`
- Label: `text-xs text-[#c7c7c7]`
- Botão: `hover:bg-[#323232] rounded-xl` (não rounded-full no botão, só no círculo interno)

---

## 24. HORIZONTAL TAB NAVIGATION — TABS DENTRO DE PÁGINA

> Padrão observado em: `/sales` (Visão geral/Gráficos), `/plans` (Assinaturas/Meus planos),
> `/settings` (5 abas), `/external-checkout` (3 abas), `/social-shop` (nav de ações)

### 24.1 Tabs de conteúdo — padrão /sales (Visão geral / Gráficos)

> Font-size: `16px` — confirmado via CSS real. Active: `font-weight: 500`. Inactive: `font-weight: 400`.

```tsx
{/* Tabs tipo underline — fundo transparente, ativa com indicator lime abaixo */}
<div className="flex items-center gap-0 border-b border-[#616161]">
  {['Visão geral', 'Gráficos'].map((tab) => (
    <button
      key={tab}
      onClick={() => setActiveTab(tab)}
      className={`px-4 py-2.5 text-[16px] border-b-2 transition-colors ${
        activeTab === tab
          ? 'border-[#BAFF1A] text-[#f5f5f5] font-medium'
          : 'border-transparent text-[#9e9e9e] font-normal hover:text-[#c7c7c7]'
      }`}
    >
      {tab}
    </button>
  ))}
</div>
```

### 24.2 Tabs grandes — padrão /plans (Assinaturas / Meus planos)

> Font-size: `20px` — confirmado via CSS real. Height: ~70px. Active: `font-weight: 500`. Inactive: `font-weight: 400`.

```tsx
<div className="flex items-center border-b border-[#616161]">
  {tabs.map((tab) => (
    <button
      key={tab}
      onClick={() => setActiveTab(tab)}
      className={`px-6 py-3 text-[20px] border-b-2 transition-colors ${
        activeTab === tab
          ? 'border-[#BAFF1A] text-[#f5f5f5] font-medium'
          : 'border-transparent text-[#9e9e9e] font-normal hover:text-[#c7c7c7]'
      }`}
    >
      {tab}
    </button>
  ))}
</div>
```

### 24.3 Tabs de configuração (Settings — 5 abas)

```tsx
<div className="flex items-center gap-1 border-b border-[#323232]">
  {tabs.map((tab) => (
    <button
      key={tab}
      onClick={() => setActiveTab(tab)}
      className={`px-4 py-3 text-[16px] transition-colors ${
        activeTab === tab
          ? 'text-[#f5f5f5] font-medium border-b-2 border-[#BAFF1A]'
          : 'text-[#9e9e9e] font-normal border-b-2 border-transparent hover:text-[#c7c7c7]'
      }`}
    >
      {tab}
    </button>
  ))}
</div>
```

**Tabs observadas em `/settings`:** Sua conta, Suas Maquininhas, Sua equipe, Segurança, Seus informes

**Regras gerais das tabs:**
- Ativa: `border-b-2 border-[#BAFF1A] text-[#f5f5f5] font-medium`
- Inativa: `border-b-2 border-transparent text-[#9e9e9e] font-normal`
- Tab separator: `border-b border-[#616161]` no wrapper
- NUNCA usar `bg-[#BAFF1A]` como fundo da tab ativa — só border-bottom
- NUNCA `rounded-full` nas tabs — sem border-radius
- Padrão /sales e /settings: `text-[16px]` | Padrão /plans: `text-[20px]`

---

## 25. PERIOD SELECTOR CARDS — SELEÇÃO DE PERÍODO

> Padrão observado em: `/receivables`
> Cards clicáveis para selecionar um período de tempo. Um card é "ativo" por vez.

```tsx
{/* ─── PERIOD SELECTOR ──────────────────────────────────────────────────────
    4 cards em linha: Dia útil anterior | Hoje | Próxima semana | Período livre
    O card ativo tem borda lime (brand), os demais borda padrão             */}
<div className="flex items-stretch gap-3">

  {[
    { id: 'previous', label: 'Dia útil anterior', date: '11 Abr, 2026', sublabel: 'Valor recebido' },
    { id: 'today',    label: 'Hoje',             date: '13 Abr, 2026', sublabel: 'Valor recebido' },
    { id: 'next',     label: 'Próxima semana',   date: '14–20 Abr, 2026', sublabel: 'Valor previsto' },
  ].map((period) => (
    <button
      key={period.id}
      onClick={() => setSelectedPeriod(period.id)}
      className={`flex flex-col gap-0.5 px-5 py-4 rounded-2xl border-2 text-left transition-colors ${
        selectedPeriod === period.id
          ? 'border-[#BAFF1A] bg-[#202020]'
          : 'border-[#474747] bg-[#202020] hover:border-[#616161]'
      }`}
    >
      <h5 className="text-sm font-semibold text-[#f5f5f5]">{period.label}</h5>
      <p className="text-xs text-[#9e9e9e]">{period.date}</p>
      <p className="text-xs text-[#9e9e9e]">{period.sublabel}</p>
      <p className="text-lg font-bold text-[#f5f5f5] mt-1">R$ 0,00</p>
    </button>
  ))}

  {/* Card de período livre — ícone de calendário + heading */}
  <button
    onClick={() => setSelectedPeriod('custom')}
    className={`flex flex-col items-center justify-center gap-2 px-5 py-4 rounded-2xl border-2 text-center transition-colors ${
      selectedPeriod === 'custom'
        ? 'border-[#BAFF1A] bg-[#202020]'
        : 'border-[#474747] bg-[#202020] hover:border-[#616161]'
    }`}
  >
    <CalendarDays className="w-5 h-5 text-[#9e9e9e]" />
    <h6 className="text-sm font-medium text-[#f5f5f5]">Definir novo período</h6>
  </button>

</div>
```

**Regras:**
- Card ativo: `border-2 border-[#BAFF1A]`
- Card inativo: `border-2 border-[#474747]`
- Fundo sempre `bg-[#202020]`
- `rounded-2xl` (não `rounded-xl`)
- Valor monetário no card: `text-lg font-bold text-[#f5f5f5]`
- Data/label: `text-xs text-[#9e9e9e]`

---

## 26. SETTINGS PAGE — PADRÃO DE CONFIGURAÇÕES

> Observado em: `/settings` (abas: Sua conta, Sua equipe, etc.)

### 26.1 Estrutura geral

```tsx
<main>
  {/* Header com título + tabs ─────────────────────────────────────────── */}
  <header className="px-6 pt-6 pb-0 border-b border-[#323232]">
    <h1 className="text-[28px] font-bold text-[#f5f5f5] mb-4">Configurações</h1>
    {/* Tabs — ver seção 24.2 */}
  </header>

  {/* Conteúdo da aba ────────────────────────────────────────────────────── */}
  <div className="px-6 py-6 space-y-6">

    {/* Seção ─────────────────────────────────────────────────────────────
        Heading com ícone Lucide à esquerda (icon prefix pattern)         */}
    <section>
      <h2 className="flex items-center gap-2 text-[16px] font-bold text-[#f5f5f5] mb-3">
        <User className="w-5 h-5 text-[#BAFF1A]" />
        Seus dados
      </h2>

      {/* Linhas de settings ─────────────────────────────────────────────
          Clicáveis → com chevron right
          Não clicáveis → sem chevron (readonly)
          Separador entre grupos de linhas                                */}
      <div className="bg-[#202020] rounded-2xl divide-y divide-[#323232]">

        {/* Linha clicável (editável) */}
        <button className="w-full flex items-center justify-between px-5 py-4 hover:bg-[#323232] transition-colors first:rounded-t-2xl last:rounded-b-2xl">
          <div>
            <p className="text-[13px] text-[#9e9e9e]">InfiniteTag</p>
            <p className="text-[15px] text-[#f5f5f5]">$gomoto</p>
          </div>
          <ChevronRight className="w-4 h-4 text-[#616161]" />
        </button>

        {/* Linha não-clicável (readonly) — sem chevron */}
        <div className="flex items-center justify-between px-5 py-4">
          <div>
            <p className="text-[13px] text-[#9e9e9e]">E-mail</p>
            <p className="text-[15px] text-[#f5f5f5]">user@example.com</p>
          </div>
        </div>

      </div>
    </section>

    <hr className="border-[#323232]" />

    {/* Próxima seção */}
    <section>
      <h2 className="flex items-center gap-2 text-[16px] font-bold text-[#f5f5f5] mb-3">
        <Building className="w-5 h-5 text-[#BAFF1A]" />
        Dados do negócio
      </h2>
      {/* ...mesmas linhas clicáveis/readonly */}
    </section>

  </div>
</main>
```

### 26.2 Padrão de linha de setting

| Tipo | Estrutura | Indicador |
|------|----------|-----------|
| Editável | `<button>` com label + valor + ChevronRight | `ChevronRight` à direita |
| Readonly | `<div>` com label + valor | sem chevron |
| Toggle | `<button>` com label + valor + toggle UI | toggle switch à direita |

**Typography dentro das linhas:**
- Label (rótulo do campo): `text-[13px] text-[#9e9e9e]`
- Value (valor do campo): `text-[15px] text-[#f5f5f5]`
- Padding: `px-5 py-4`
- Separador: `divide-y divide-[#323232]` no container

---

## 27. PROMO / FEATURE LANDING — PÁGINAS DE APRESENTAÇÃO

> Padrão observado em: `/lending`, `/booking`, `/referral`, `/booking/onboarding`
> Páginas que apresentam uma feature com imagem + benefícios + CTA.

```tsx
{/* ─── FEATURE LANDING ─────────────────────────────────────────────────────
    Layout split: imagem à esquerda, conteúdo à direita                    */}
<div className="flex items-center gap-12 px-6 py-12 max-w-4xl">

  {/* Imagem decorativa */}
  <div className="flex-shrink-0">
    <img src="/promo-image.png" alt="Feature" className="w-64 h-auto" />
  </div>

  {/* Conteúdo */}
  <div className="flex flex-col gap-6">
    <h2 className="text-[24px] font-bold text-[#f5f5f5]">Nome da Feature</h2>

    {/* Lista de benefícios com ícone check */}
    <ul className="flex flex-col gap-4">
      {benefits.map((b) => (
        <li key={b} className="flex items-start gap-3">
          <div className="w-6 h-6 rounded-full bg-[#243300] flex items-center justify-center flex-shrink-0 mt-0.5">
            <Check className="w-3.5 h-3.5 text-[#BAFF1A]" />
          </div>
          <div>
            <p className="text-[15px] font-semibold text-[#f5f5f5]">{b.title}</p>
            <p className="text-[13px] text-[#9e9e9e]">{b.description}</p>
          </div>
        </li>
      ))}
    </ul>

    {/* CTAs */}
    <div className="flex items-center gap-3">
      <button className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full bg-[#BAFF1A] text-[#000000] font-medium text-[16px] hover:bg-[#a8e617] transition-colors">
        Começar agora
        <ChevronRight className="w-4 h-4" />
      </button>
      <button className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full border border-[#474747] text-[#f5f5f5] text-sm hover:border-[#BAFF1A] hover:text-[#BAFF1A] transition-colors">
        Saber mais
      </button>
    </div>
  </div>

</div>
```

---

## 28. MODAL WIZARD / CARROSSEL — MODAL MULTI-STEP

> Padrão observado em: `/social-shop` (modal de boas-vindas ao abrir a loja)
> Modal com múltiplas etapas, navegação por indicadores (dots).

```tsx
{/* ─── MODAL WIZARD ────────────────────────────────────────────────────────
    Cada etapa tem: imagem ilustrativa + heading + paragrafo + CTA button
    Navegação por dots (não por back/next explícitos)                       */}
<div className="relative bg-[#202020] rounded-2xl overflow-hidden max-w-md w-full">

  {/* Botão fechar */}
  <button
    onClick={onClose}
    className="absolute top-4 right-4 w-8 h-8 flex items-center justify-center rounded-full hover:bg-[#323232] transition-colors"
  >
    <X className="w-4 h-4 text-[#9e9e9e]" />
  </button>

  {/* Step atual */}
  <div className="p-8 flex flex-col items-center text-center gap-4">
    <img src={steps[currentStep].image} alt="" className="w-32 h-32 object-contain" />
    <h2 className="text-[20px] font-bold text-[#f5f5f5]">{steps[currentStep].heading}</h2>
    <p className="text-[14px] text-[#9e9e9e] leading-relaxed">{steps[currentStep].description}</p>
    <button
      onClick={handleContinue}
      className="w-full py-3 rounded-full bg-[#BAFF1A] text-[#000000] font-medium text-[16px] hover:bg-[#a8e617] transition-colors"
    >
      {currentStep < steps.length - 1 ? 'Continuar' : 'Criar agora'}
    </button>
  </div>

  {/* Dots de navegação */}
  <div className="flex items-center justify-center gap-2 pb-6">
    {steps.map((_, i) => (
      <button
        key={i}
        onClick={() => setCurrentStep(i)}
        className={`rounded-full transition-all ${
          i === currentStep
            ? 'w-4 h-2 bg-[#BAFF1A]'
            : 'w-2 h-2 bg-[#474747] hover:bg-[#616161]'
        }`}
      />
    ))}
  </div>

</div>
```

**Regras do modal wizard:**
- Dot ativa: `w-4 h-2 bg-[#BAFF1A]` (mais largo, não circular)
- Dot inativa: `w-2 h-2 bg-[#474747]`
- Botão de fechar: canto superior direito, `w-8 h-8 rounded-full`
- CTA: full-width, `rounded-full bg-[#BAFF1A]`
- Conteúdo centralizado com `text-center`

---

## 29. SIDEBAR DROPDOWN — SUBMENU COLAPSÁVEL

> Confirmado via CSS real extraído do app.infinitepay.io/home em 2026-04-14.
> Padrão observado em: "Seu banco" (Extrato, Cartões, Empréstimo).

### Estrutura real do InfinitePay

O grupo dropdown é um `<div data-state="open|closed">` com:
1. `<button>` pai com ícone + label + chevron
2. `<ul>` com `max-h-0 opacity-0 → max-h-[...] opacity-100` (animação CSS, não JS condicional)
3. O grupo inteiro tem `border-b border-[#323232] mb-2 pb-2` separando do próximo item

### Wrapper do grupo

```tsx
{/* O data-state controla a animação via CSS — abrir/fechar ao clicar no botão */}
<div
  data-state={expanded ? 'open' : 'closed'}
  className="px-4 mb-2 pb-2 w-[85px] group-hover:w-full
             overflow-x-clip transition-all duration-300 ease-in-out
             border-b border-[#323232]"
>
  {/* ... */}
</div>
```

### Botão pai (trigger)

```tsx
<button
  onClick={() => setExpanded(!expanded)}
  className="flex w-full items-center justify-between gap-2 px-4 py-2
             rounded-lg text-[#c7c7c7] text-[14px] font-normal
             hover:bg-[#323232] hover:text-[#f5f5f5]
             transition-all duration-300"
>
  {/* Ícone + label */}
  <div className="flex items-center gap-2">
    <BankIcon className="w-5 h-5 flex-shrink-0" />
    <span className="whitespace-nowrap">Seu banco</span>
  </div>
  {/* Chevron — rotaciona 180° quando aberto */}
  <ChevronDown
    className={`w-4 h-4 flex-shrink-0 transition-transform duration-300 ${
      expanded ? 'rotate-180' : ''
    }`}
  />
</button>
```

| Propriedade | Valor |
|-------------|-------|
| Altura | `~36px` (py-2 + font = ~36px) |
| Padding | `py-2 px-4` |
| Border radius | `8px` (rounded-lg) |
| Font size | `14px` |
| Font weight | `400` (normal) |
| Cor default | `#c7c7c7` |
| Hover bg | `#323232` |
| Ícone | `w-5 h-5` |
| Chevron | `w-4 h-4`, rota 180° quando expandido |

### Lista de sub-itens (animada via CSS)

```tsx
<ul
  className={`flex flex-col gap-1 overflow-hidden transition-all duration-300 ease-in-out ${
    expanded ? 'max-h-[200px] opacity-100' : 'max-h-0 opacity-0'
  }`}
>
  {[
    { label: 'Seu extrato',           href: '/statements' },
    { label: 'Cartões e mais',        href: '/cards'      },
    { label: 'Empréstimo Inteligente', href: '/lending'  },
  ].map((item, i) => (
    <li key={item.href}>
      <Link
        href={item.href}
        className={`flex items-center h-10 pr-4 pl-11 rounded-lg
                    text-[14px] font-normal transition-all
                    ${i === 0 ? 'mt-2' : ''}
                    ${pathname === item.href
                      ? 'bg-[#BAFF1A] text-[#000000] font-medium'
                      : 'text-[#c7c7c7] hover:bg-[#323232] hover:text-[#f5f5f5]'
                    }`}
      >
        {item.label}
      </Link>
    </li>
  ))}
</ul>
```

| Propriedade sub-item | Valor |
|----------------------|-------|
| Altura | `40px` (h-10) |
| Padding direita | `16px` (pr-4) |
| Indentação (padding esq.) | `44px` (pl-11) — alinha com texto do botão pai |
| Primeiro item | `mt-2` (8px de espaço acima) |
| Border radius | `8px` (rounded-lg) |
| Font size | `14px` |
| Cor default | `#c7c7c7` |
| Hover bg | `#323232` |
| Hover text | `#f5f5f5` |
| **Ativo** bg | `#BAFF1A` |
| **Ativo** text | `#000000` |
| **Ativo** weight | `500` (medium) |
| Animação lista | `max-h-0 opacity-0 → max-h-[200px] opacity-100` via CSS |

**Regras:**
- NUNCA usar `ml-8` para indentar — usar `pl-11` (44px) diretamente no link.
- NUNCA renderizar condicionalmente (`{expanded && <ul>}`) — usar animação CSS com `max-h + opacity`.
- SEMPRE separar o grupo do restante da nav com `border-b border-[#323232] mb-2 pb-2` no wrapper.
- Primeiro sub-item sempre tem `mt-2` para espaçamento visual.

---

## 30. CARDS VISUAIS (FÍSICOS) — CARTÃO BANCÁRIO

> Padrão observado em: `/cards`
> Lista de cartões com visual de cartão físico/virtual.

```tsx
{/* ─── CARD ITEM (lista de cartões) ────────────────────────────────────────
    Selecionado: bg-[#323232] ou borda ativa
    Layout: info do cartão à esquerda, número e bandeira à direita         */}
<div className="flex items-center justify-between px-4 py-3 rounded-xl bg-[#323232] cursor-pointer hover:bg-[#474747] transition-colors">
  <div>
    <h6 className="text-[14px] font-semibold text-[#f5f5f5]">GoMoto</h6>
    <p className="text-[12px] text-[#9e9e9e]">Virtual</p>
  </div>
  <div className="flex items-center gap-2">
    <span className="text-[13px] text-[#c7c7c7]">∙∙∙∙ 5799</span>
    {/* Bandeira do cartão (Mastercard, Visa, etc.) */}
  </div>
</div>
```

**Painel lateral de detalhes do cartão:**
```tsx
<div className="flex flex-col gap-4">
  {/* Saldo */}
  <div className="flex items-center justify-between">
    <div>
      <h6 className="text-[14px] text-[#9e9e9e]">Saldo disponível</h6>
      <p className="text-[24px] font-bold text-[#f5f5f5]">R$ 8.056,89</p>
    </div>
    <button className="px-4 py-2 rounded-full bg-[#BAFF1A] text-[#000000] text-[16px] font-medium">
      Depositar
    </button>
  </div>

  {/* Ações do cartão — botões com ícone à esquerda + chevron à direita */}
  <button className="flex items-center gap-3 px-4 py-3 rounded-xl hover:bg-[#323232] transition-colors">
    <div className="w-8 h-8 flex items-center justify-center bg-[#323232] rounded-full">
      <Lock className="w-4 h-4 text-[#9e9e9e]" />
    </div>
    <span className="text-[14px] text-[#f5f5f5] flex-1">Bloqueio temporário</span>
    {/* Toggle switch aqui */}
  </button>

  <button className="flex items-center gap-3 px-4 py-3 rounded-xl hover:bg-[#323232] transition-colors">
    <div className="w-8 h-8 flex items-center justify-center bg-[#323232] rounded-full">
      <Settings className="w-4 h-4 text-[#9e9e9e]" />
    </div>
    <span className="text-[14px] text-[#f5f5f5] flex-1">Configurações</span>
    <ChevronRight className="w-4 h-4 text-[#616161]" />
  </button>
</div>
```

---

## 31. LINK NA BIO — EDITOR + PREVIEW SPLIT

> Padrão observado em: `/link-na-bio`
> Layout dividido: editor à esquerda (2/3), preview iframe à direita (1/3).

```tsx
<div className="flex gap-6 h-[calc(100vh-80px)]">

  {/* Editor — coluna esquerda */}
  <main className="flex-1 overflow-y-auto px-6 py-6">
    {/* Header com avatar + nome */}
    {/* Seções de links adicionáveis */}
    {/* Toggle "Permitir recebimento" */}
    {/* Botão "Adicionar link" */}
  </main>

  {/* Preview — coluna direita, fixa */}
  <aside className="w-72 flex-shrink-0 border-l border-[#323232] flex items-center justify-center">
    <iframe
      src={previewUrl}
      className="w-[320px] h-[568px] rounded-3xl border-4 border-[#323232]"
    />
  </aside>

</div>
```

**Header com ações flutuantes:**
```tsx
<div className="flex items-center justify-between mb-6">
  <h1 className="text-[28px] font-bold text-[#f5f5f5]">Link na Bio</h1>
  <div className="flex items-center gap-2">
    {/* Personalizar */}
    <button className="flex items-center gap-2 h-10 px-6 rounded-full bg-[#323232] text-[#ffffff] font-medium text-[16px] hover:bg-[#474747]">
      <Palette className="w-4 h-4" />
      Personalizar
    </button>
    {/* Compartilhar — primary */}
    <button className="flex items-center gap-2 h-10 px-6 rounded-full bg-[#BAFF1A] text-[#000000] font-medium text-[16px] hover:bg-[#a8e617]">
      Compartilhar
      <ExternalLink className="w-4 h-4" />
    </button>
  </div>
</div>
```

---

## 32. EMPTY STATE PATTERNS — ESTADOS VAZIOS COMPLETOS

> Padrão observado em múltiplas páginas do InfinitePay.
> Já parcialmente documentado na seção 19.3, aqui o padrão visual completo.

### 32.1 Empty state com ícone de triângulo (aviso/não disponível)

```tsx
{/* Usado em: /das-mei — recurso não configurado */}
<div className="flex flex-col items-center justify-center py-24 gap-4">
  <div className="w-16 h-16 flex items-center justify-center">
    <AlertTriangle className="w-12 h-12 text-[#e65e24]" />
  </div>
  <p className="text-[15px] text-[#9e9e9e] text-center max-w-xs">
    Para acessar os guias DAS, você precisa informar seu CNPJ.
  </p>
</div>
```

### 32.2 Empty state com ícone de círculo (sem dados)

```tsx
{/* Usado em: /invoices — "Sem cobranças no período" */}
<div className="flex flex-col items-center justify-center py-20 gap-3">
  <div className="w-14 h-14 flex items-center justify-center bg-[#323232] rounded-full">
    <MinusCircle className="w-8 h-8 text-[#616161]" />
  </div>
  <h2 className="text-[18px] font-semibold text-[#f5f5f5]">Sem cobranças no período</h2>
  <p className="text-[14px] text-[#9e9e9e]">Tente selecionar outra opção, ou limpar os filtros.</p>
  <button className="px-4 py-2 rounded-full border border-[#474747] text-sm text-[#c7c7c7] hover:border-[#BAFF1A] hover:text-[#BAFF1A] transition-colors">
    Limpar filtros
  </button>
</div>
```

### 32.3 Empty state com CTA de ação (incentivar criação)

```tsx
{/* Usado em: /plans — incentivar criação de plano */}
<div className="flex flex-col items-center justify-center py-20 gap-4">
  <div className="w-14 h-14 flex items-center justify-center bg-[#323232] rounded-full">
    <List className="w-7 h-7 text-[#9e9e9e]" />
  </div>
  <h2 className="text-[18px] font-semibold text-[#f5f5f5] text-center">
    Adicione seus clientes e conheça todas as vantagens disponíveis
  </h2>
  <p className="text-[14px] text-[#9e9e9e]">Gestão de planos eficiente</p>
  <button className="flex items-center gap-2 px-5 py-2.5 rounded-full bg-[#BAFF1A] text-[#000000] font-medium text-[16px] hover:bg-[#a8e617] transition-colors">
    <List className="w-4 h-4" />
    Ver meus planos
  </button>
</div>
```

**Regras de empty states:**
- Ícone do estado de erro/aviso: `text-[#e65e24]` (warning) ou `text-[#ff9c9a]` (error)
- Ícone de "vazio": `text-[#616161]` dentro de `bg-[#323232] rounded-full`
- Heading: `text-[18px] font-semibold text-[#f5f5f5]`
- Descrição: `text-[14px] text-[#9e9e9e]`
- CTA primário: `bg-[#BAFF1A] text-[#000000]` (lime) — só se incentivar ação
- CTA secundário: `border border-[#474747] text-[#c7c7c7]` (outline) — limpar filtros

---

## 33. FILTER DRAWER — GAVETA LATERAL DE FILTROS

Extraído de `/sales` → clique em "Filtros". Drawer desliza da direita.

| Property | Value | Tailwind |
|----------|-------|---------|
| Drawer background | `#202020` | `bg-[#202020]` |
| Drawer width | 620px | `w-[620px]` |
| Drawer title | 28px / font-bold / #f5f5f5 | `text-[28px] font-bold text-[#f5f5f5]` |
| Section headers (Status, Tipo...) | 20px / font-medium / #f5f5f5 | `text-[20px] font-medium text-[#f5f5f5]` |
| Filter chip (inactive) | bg=#000000, text=#f5f5f5, h~40px, 20px, border-2 #323232 | `rounded-full border-2 border-[#323232] bg-[#000000] text-[#f5f5f5] text-[20px] py-1 px-4` |
| Filter chip (active) | bg=#baff1a, text=#000000 | `rounded-full bg-[#BAFF1A] text-[#000000] text-[20px] py-1 px-4` |
| Apply button | bg-white, text-[#121212], h-12, rounded-full | `bg-[#ffffff] text-[#121212] h-12 px-6 font-medium rounded-full` |

**Estrutura JSX do drawer:**
```tsx
<aside className="fixed right-0 top-0 h-full w-[620px] bg-[#202020] z-50 p-6 overflow-y-auto">
  <h1 className="text-[28px] font-bold text-[#f5f5f5] mb-6">Filtros</h1>
  
  {/* Seção de filtro */}
  <div className="mb-6">
    <h2 className="text-[20px] font-medium text-[#f5f5f5] mb-3">Status</h2>
    <div className="flex flex-wrap gap-2">
      {/* Chip inativo */}
      <button className="rounded-full border-2 border-[#323232] bg-[#000000] text-[#f5f5f5] text-[20px] py-1 px-4">
        Aprovada
      </button>
      {/* Chip ativo */}
      <button className="rounded-full bg-[#BAFF1A] text-[#000000] text-[20px] py-1 px-4">
        Pendente
      </button>
    </div>
  </div>
  
  {/* Botão aplicar */}
  <button className="w-full bg-[#ffffff] text-[#121212] h-12 px-6 font-medium rounded-full text-[16px]">
    Aplicar
  </button>
</aside>
```

---

## 34. FORM / CREATE FLOW — PADRÃO DE FORMULÁRIO

Extraído de `/invoices/create`. Usado em fluxos de criação (cobrança, plano, cliente).

### Form Headers
| Element | Font | Tailwind |
|---------|------|---------|
| Page/form title (H1) | 28px / bold / #f5f5f5 | `text-[28px] font-bold text-[#f5f5f5]` |
| Section label (H3) | 14px / medium / #f5f5f5 | `text-[14px] font-medium text-[#f5f5f5]` |
| Hint / sublabel (H4) | 14px / normal / #c7c7c7 | `text-[14px] font-normal text-[#c7c7c7]` |
| Input label | 14px / medium / #f5f5f5 | `text-[14px] font-medium text-[#f5f5f5]` |

### Form Inputs
| Type | Tailwind |
|------|---------|
| Amount input (valor) | `h-11 bg-[#000000] text-[#f5f5f5] text-[16px] border-0 rounded-none placeholder:text-[#9e9e9e]` |
| Autocomplete / search | `h-6 bg-[#000000] text-[#f5f5f5] text-[16px] border-0 rounded-lg` |
| Textarea / description | `bg-[#000000] text-[#ffffff] text-[16px] border-0 rounded-lg p-3 min-h-[120px]` |
| Search bar (inline) | `h-9 bg-transparent text-[#f5f5f5] text-[14px] border-0 rounded-none placeholder:text-[#9e9e9e]` |

### Form CTA
- **"Continuar" / "Salvar"** (wizard step): `bg-[#ffffff] text-[#121212] h-12 px-6 font-medium rounded-full text-[16px]` (white-lg variant)

**Estrutura JSX de campo:**
```tsx
<div className="flex flex-col gap-1.5">
  <label className="text-[14px] font-medium text-[#f5f5f5]">Qual o valor?</label>
  <input
    type="text"
    placeholder="0,00"
    className="h-11 bg-[#000000] text-[#f5f5f5] text-[16px] border-0 rounded-none placeholder:text-[#9e9e9e] focus:outline-none"
  />
</div>
```

---

## 35. DETAIL DRAWER — GAVETA DE DETALHE DE ITEM

Extraído de `/sales` (detalhe de venda) e `/statements` (detalhe de transação). Mesmo componente `drawer-modal-container`, largura 620px.

| Elemento | Font / Tailwind |
|----------|----------------|
| Valor principal (crédito) | `text-[40px] font-bold text-[#229731]` |
| Valor principal (débito/neutro) | `text-[40px] font-bold text-[#f5f5f5]` |
| Nome da transação / título | `text-[16px] font-medium text-[#f5f5f5]` |
| Rótulo de campo (Status, Tipo...) | `text-[16px] font-normal text-[#c7c7c7]` |
| Valor de campo | `text-[16px] font-medium text-[#f5f5f5]` |
| Section title (Venda, Origem...) | `text-[16px] font-medium text-[#f5f5f5]` |
| Data/hora | `text-[16px] font-normal text-[#c7c7c7]` |
| Divisória entre seções | `border-dotted border-[#616161] my-6` |
| Botão fechar | `h-10 w-10 rounded-full bg-[#ffffff]` |
| Background drawer | `bg-[#121212] w-[620px]` |

---

## 36. CLIENT DETAIL PAGE — PÁGINA DE DETALHE DO CLIENTE

Extraído de `/clients/manage/{id}` — página full (não drawer).

| Elemento | Tailwind |
|----------|---------|
| Nome do cliente (H2) | `text-[28px] font-bold text-[#f5f5f5]` |
| Status (ex: "Cliente ativo...") | `text-[14px] font-medium text-[#229731]` |
| CTA primário "Nova cobrança" | `h-10 rounded-full bg-[#ffffff] text-[#121212] px-6 font-medium text-[16px]` |
| CTA secundário "Nova assinatura" | `h-10 rounded-full bg-[#323232] text-[#ffffff] px-6 font-medium text-[16px]` |
| Dropdown "Ações" | `h-8 rounded-full bg-[#323232] text-[#ffffff] px-4 font-normal text-[14px]` |
| Card de cobrança | `bg-[#323232] rounded-xl` |
| Background de seção | `bg-[#202020]` |

---

## 37. PIX MODAL / CHAVES PIX — DRAWER LATERAL

Extraído de `/home?modal=pix-key`.

| Elemento | Tailwind |
|----------|---------|
| Modal title "Chaves Pix" | `text-[28px] font-bold text-[#f5f5f5]` |
| Chave Pix display | `text-[16px] font-medium text-[#f5f5f5]` |
| "Imprimir QR Code" | `h-12 rounded-full bg-[#323232] text-[#ffffff] px-6 font-medium text-[16px]` |
| Background modal | `bg-[#202020]` sobre `bg-[#121212]` |

---

## 38. HOME QUICK ACTIONS — BOTÕES DE AÇÃO RÁPIDA VERTICAL

Extraído de `/home` — barra de ações rápidas (Cobrar, Pix, Pagar, Cartões, Vendas).

Padrão: ícone + label vertical, sem borda, fundo transparente.

| Property | Value |
|----------|-------|
| Height | ~77px (`h-[77px]`) |
| Background | `bg-[#000000]` / `bg-transparent` |
| Text color | `text-[#f5f5f5]` |
| Font size | `text-[14px]` |
| Font weight | `font-medium` |
| Border radius | `rounded-none` (0px) |

**Small white inline link buttons** ("Saiba mais", "Saber mais", "Ver página"):
- `h-8 rounded-full bg-[#ffffff] text-[#121212] px-4 font-medium text-[14px]`
- Mesmo padrão que `neutral-sm` mas com bg-white

---

## 39. SKELETON / LOADING STATES

Pattern de shimmer para tabelas, cards e listas enquanto dados carregam.

- Skeleton base: `bg-[#323232] animate-pulse rounded`
- Skeleton shimmer: usa `bg-gradient-to-r from-[#323232] via-[#474747] to-[#323232] animate-pulse`
- Skeleton text line: `h-4 bg-[#323232] animate-pulse rounded w-3/4`
- Skeleton avatar circle: `w-8 h-8 bg-[#323232] animate-pulse rounded-full`
- Skeleton table row: `h-9 bg-[#323232] animate-pulse` (mantém h-9 da SIZE EXCEPTION)
- Spinner inline (dentro de botão): `w-4 h-4 border-2 border-[#9e9e9e] border-t-[#f5f5f5] rounded-full animate-spin`

Exemplo JSX de skeleton de tabela (3 linhas):
```tsx
{isLoading && Array.from({length: 3}).map((_, i) => (
  <tr key={i} className="h-9">
    <td className="px-4"><div className="h-3 bg-[#323232] animate-pulse rounded w-32" /></td>
    <td className="px-4"><div className="h-3 bg-[#323232] animate-pulse rounded w-20" /></td>
    <td className="px-4"><div className="h-3 bg-[#323232] animate-pulse rounded w-16" /></td>
  </tr>
))}
```

---

## 40. FORM VALIDATION — ESTADOS DE ERRO E SUCESSO

Extrapolado dos tokens InfinitePay + padrões do design system.

### Input com erro:
```tsx
<div className="flex flex-col gap-1.5">
  <label className="text-[14px] font-medium text-[#f5f5f5]">Campo</label>
  <input className="h-10 px-3 bg-[#323232] text-[#f5f5f5] text-[16px] rounded-lg border border-[#ff9c9a] focus:outline-none focus:border-[#ff9c9a]" />
  <span className="text-[12px] text-[#ff9c9a]">Mensagem de erro aqui</span>
</div>
```

### Input com sucesso:
```tsx
<input className="h-10 px-3 bg-[#323232] text-[#f5f5f5] text-[16px] rounded-lg border border-[#229731] focus:outline-none focus:border-[#229731]" />
```

### Required field indicator:
```tsx
<label className="text-[14px] font-medium text-[#f5f5f5]">
  Campo <span className="text-[#ff9c9a]">*</span>
</label>
```

### Character counter:
```tsx
<div className="flex justify-between mt-1">
  <span className="text-[12px] text-[#ff9c9a]">Erro opcional</span>
  <span className="text-[12px] text-[#9e9e9e]">42/200</span>
</div>
```

---

## 41. TOAST / NOTIFICATION — FEEDBACK DE AÇÕES

Padrão de notificação temporária (bottom-right ou top-center).

| Tipo | Classes |
|------|---------|
| Success | `bg-[#0e2f13] border border-[#229731] text-[#229731]` |
| Error | `bg-[#7c1c1c] border border-[#ff9c9a] text-[#ff9c9a]` |
| Warning | `bg-[#3a180f] border border-[#e65e24] text-[#e65e24]` |
| Info | `bg-[#2d0363] border border-[#a880ff] text-[#a880ff]` |

```tsx
<div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2">
  <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-[#0e2f13] border border-[#229731] text-[#229731] text-[14px] font-medium min-w-[280px]">
    <CheckCircle className="w-4 h-4 flex-shrink-0" />
    <span>Cliente adicionado com sucesso</span>
  </div>
</div>
```

---

## 42. OVERLAY / BACKDROP — FUNDO DE MODAIS

| Uso | Classes |
|-----|---------|
| Modal overlay | `fixed inset-0 bg-[#000000]/60 z-40` |
| Drawer overlay | `fixed inset-0 bg-[#000000]/40 z-40` |
| Tooltip bg | `bg-[#323232] text-[#f5f5f5] text-[12px] px-2 py-1 rounded-lg` |

---

## 43. PAGINATION — NAVEGAÇÃO DE PÁGINAS

Padrão de paginação para tabelas longas.

```tsx
<div className="flex items-center justify-between px-4 py-3 border-t border-[#323232]">
  <span className="text-[13px] text-[#9e9e9e]">Mostrando 1–20 de 143</span>
  <div className="flex items-center gap-1">
    <button className="h-8 w-8 rounded-full bg-transparent text-[#c7c7c7] hover:bg-[#323232] disabled:opacity-40 flex items-center justify-center">
      <ChevronLeft className="w-4 h-4" />
    </button>
    <button className="h-8 w-8 rounded-full bg-[#BAFF1A] text-[#000000] font-medium text-[13px] flex items-center justify-center">1</button>
    <button className="h-8 w-8 rounded-full bg-transparent text-[#c7c7c7] hover:bg-[#323232] font-medium text-[13px] flex items-center justify-center">2</button>
    <button className="h-8 w-8 rounded-full bg-transparent text-[#c7c7c7] hover:bg-[#323232] flex items-center justify-center">
      <ChevronRight className="w-4 h-4" />
    </button>
  </div>
</div>
```

---

## 44. DATE PICKER / RANGE SELECTOR — FILTRO DE DATA

Padrão para seleção de período (usado em filtros de /sales, /statements, /receivables).

```tsx
{/* Input de data simples */}
<input
  type="date"
  className="h-10 px-3 bg-[#323232] text-[#f5f5f5] text-[14px] rounded-lg border-0 focus:outline-none focus:ring-1 focus:ring-[#BAFF1A] [color-scheme:dark]"
/>

{/* Range de datas */}
<div className="flex items-center gap-2">
  <input type="date" className="h-10 px-3 bg-[#323232] text-[#f5f5f5] text-[14px] rounded-lg border-0 focus:outline-none [color-scheme:dark]" />
  <span className="text-[#9e9e9e] text-[14px]">até</span>
  <input type="date" className="h-10 px-3 bg-[#323232] text-[#f5f5f5] text-[14px] rounded-lg border-0 focus:outline-none [color-scheme:dark]" />
</div>
```

---

## 45. RESPONSIVE BREAKPOINTS — GUIA DE RESPONSIVIDADE

| Breakpoint | px | Uso principal |
|-----------|-----|--------------|
| default (mobile) | < 640px | 1 coluna, sidebar oculta |
| `sm:` | >= 640px | 2 colunas KPI |
| `md:` | >= 768px | tablet — sidebar colapsada |
| `lg:` | >= 1024px | desktop — sidebar expandida, 4 colunas KPI |
| `xl:` | >= 1280px | wide desktop |

Regras gerais:
- Sidebar: visível apenas em `lg:` — em mobile usa bottom nav ou menu hambúrguer
- Tabelas: scroll horizontal em mobile (`overflow-x-auto`)
- KPI grid: `grid-cols-2 lg:grid-cols-4`
- Modais/Drawers: full-screen em mobile (`w-full` / `inset-0`), 620px em desktop

```tsx
{/* Tabela responsiva */}
<div className="overflow-x-auto">
  <table className="w-full text-left text-[13px] text-[#f5f5f5] min-w-[640px]">
    ...
  </table>
</div>
```
