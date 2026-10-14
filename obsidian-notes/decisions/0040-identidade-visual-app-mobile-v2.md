# ADR 0040 — Identidade visual do app mobile v2 (paleta + kit de componentes)

- **Status:** Implementada (2026-10-14) — kit aprovado pelo stakeholder; todas as telas do app migradas
- **Data:** 2026-10-14
- **Autores:** Stakeholder + agente IA
- **Substitui:** a paleta de [[decisions/0021-tema-app-mobile-cliente|ADR 0021]] §1 (o mecanismo de tema — `ThemeProvider`, claro/escuro/auto, `useTheme()` — continua igual)
- **Substituída por:** —

## Contexto

O stakeholder achou o app "feio" e pediu um visual **moderno, confiável e profissional**, sem mexer no web. Problemas concretos da v1:

- Tab bar com **caracteres de texto** no lugar de ícone (`⌂`, `$`, `M`, `V`, `☰`).
- Paleta copiada do web (azul Tailwind `#2563EB` sobre slate), sem hierarquia: tudo era cartão branco com borda igual, e nada se destacava.
- Status saturados em fundo pastel, todos com o mesmo peso visual.
- Cada tela reimplementava cartão, botão, selo e cabeçalho com medidas diferentes (raio 10/12/14, títulos 11px em caixa alta).

## Decisão

### 1. Paleta "banco digital" (`apps/mobile/src/theme/tokens.ts`)

- **Neutros frios de alto contraste:** fundo `#F3F5F9` / `#080C15`, texto `#0C1424` / `#EEF2F8`.
- **Azul royal mais denso** como cor de ação: `#2251D1` no claro, `#4D76F5` no escuro. Continua da família "Frota Confiável" (mesma marca do cockpit), só que menos "Tailwind padrão".
- **Superfície de marca** (`brand`, azul-marinho `#0E1A36`) com `brandText`, `brandTextSoft`, `brandAccent`, `brandPositive` e `brandNegative`: o "cartão" do app. No máximo uma por tela, para o dado mais importante (resumo financeiro, veículo locado).
- **Status com saturação contida.** `critical` não muda (ADR 0020).
- **Sombra só no claro** (`shadowColor`/`shadowOpacity`). No escuro, a profundidade vem da borda.

Os nomes de token da v1 foram mantidos, só se acrescentaram tokens. Toda tela ainda não redesenhada ganha a paleta nova sem mudar nenhuma linha.

### 2. Kit de componentes (`apps/mobile/src/components/ui/`)

`Card` (default / brand / outline, opcionalmente pressionável), `Button` (primary / secondary / danger / success / ghost / onBrand, com loading e ícone, altura mínima 52), `Badge`, `Icon`, `IconCircle`, `SectionHeader`, `ScreenHeader` (título grande no estilo iOS), `EmptyState`, `TextField` (rótulo, ícone, foco, erro, mostrar senha), `ModalHeader` (fechar redondo), `Notice`, `SegmentedControl`, `ListItem` (linha agrupada estilo Ajustes do iOS), mais `radius`, `space`, `elevation()` e `toneColors()`.

Telas de acesso (login, definir senha, escolher locadora) usam `AuthShell` (`src/components/AuthShell.tsx`): faixa azul-marinho com o ícone do app como logo e a folha do formulário por cima. Elas continuam sempre no tema claro, agora via `LightThemeScope` (`src/theme/ThemeProvider.tsx`). Um `lightTheme` local não basta mais, porque os componentes do kit leem o tema do contexto. Por isso o layout das abas fixa o `StatusBar` pelo tema: o `AuthShell` deixa a barra clara, e os ícones sumiriam no fundo claro.

### 3. Ícones: `@expo/vector-icons` (Ionicons)

Ícone vazado quando inativo e preenchido quando ativo, na tab bar e em todo o app. A dependência é oficial do Expo e já vem no Expo Go, então não exige build nativo.

## Consequências

- Todas as telas no padrão novo: login, definir senha, escolher locadora, tab bar, Início, Cobranças (+ detalhe e pagamento), Manutenção (+ registro de conclusão), Vistorias (+ envio, com barra de progresso) e Conta.
- Tela nova deve montar com o kit (`src/components/ui`) e nunca com hex local. Exceções propositais: a placa Mercosul, o fundo branco do QR e o texto branco sobre botões coloridos.
- O web não muda (ADR 0019 segue valendo lá).

## Quando reavaliar

Se o app ganhar marca por locadora (white-label), `brand` deixa de ser fixo e passa a vir do tenant.
