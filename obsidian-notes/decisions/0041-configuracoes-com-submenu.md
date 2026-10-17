# ADR 0041 — Configurações divididas em sub-telas com submenu próprio

- **Status:** Implementada (2026-10-16)
- **Data:** 2026-10-16
- **Autores:** Stakeholder + agente IA
- **Substitui:** —
- **Substituída por:** —

## Contexto

`/configuracoes` era uma página client de ~640 linhas com sete assuntos sem relação entre si: aparência, senha e dados da conta (pessoais), gateways de pagamento e multa/juros (dinheiro da empresa), contatos exibidos no app e, como cards de atalho, Usuários e Diagnóstico das integrações. Um único `actions.ts` (~680 linhas) cobria quatro domínios.

Problemas concretos:

- Preferência pessoal misturada com regra da empresa: quem só queria trocar a senha passava pelos gateways.
- O papel era descoberto no navegador (`useEffect` lendo `tenant_members`) e as seções eram escondidas no cliente; as sub-rotas existentes já guardavam no servidor.
- Navegação inconsistente: parte inline, parte card com `ChevronRight` que levava para fora.

## Decisão

1. **Layout próprio com submenu à esquerda** (`configuracoes/layout.tsx`), no padrão de Stripe/Vercel/GitHub. A sidebar principal continua com um único item "Configurações": são telas de uso raro, e sete filhos poluiriam a navegação diária. Descartado: transformar o item em `branch` da sidebar principal.
2. **Agrupamento por escopo:** *Minha conta* (Perfil e segurança, Aparência), *Empresa* (Usuários, Contatos do app), *Financeiro* (Gateways de pagamento, Multa e juros, Diagnóstico).
3. **Uma sub-rota por assunto**, cada uma com `page.tsx` que guarda no servidor (`requireTenantOwner*` + `redirect('/configuracoes/conta')`) e, quando escreve, o seu `actions.ts`. `/configuracoes` só redireciona para `/configuracoes/conta`, a única que todo papel vê.
4. **O menu só decide o que mostrar.** O layout resolve o papel com `getCurrentTenantRole()` e filtra os itens (`settings-nav.ts`, testado); grupos vazios somem. O que barra é a página, e para escrita o banco.

## Consequências

- O callback OAuth dos gateways passou a voltar para `/configuracoes/pagamentos`. O `redirect_uri` registrado nos provedores (`/api/auth/gateway/<provedor>/callback`) não mudou.
- Os E2E de política de encargo e de usuários apontam para as rotas novas.
- **Bug latente exposto:** o formulário de multa/juros copia a política vigente para o próprio estado só ao montar. Na página única, ele montava depois da consulta de papel e, por acaso, já com os dados; isolado, montava vazio. `EncargosClient` agora espera as versões antes de montar o formulário.
- Novos assuntos de configuração entram como item em `SETTINGS_NAV` + sub-rota, sem crescer uma página compartilhada.
