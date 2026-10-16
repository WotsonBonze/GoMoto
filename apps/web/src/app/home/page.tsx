/**
 * @file page.tsx (Home institucional)
 * @description Landing page pública do GoMoto — apresentação do produto para
 * potenciais clientes (locadoras de moto). Não faz parte do cockpit autenticado:
 * vive fora de (dashboard)/(auth)/(admin) e é liberada explicitamente no
 * middleware (`isPublicPath`) para ser acessível sem sessão.
 *
 * `/` continua sendo a rota de roteamento pós-login (decisão do usuário: manter
 * o comportamento atual intacto e isolar a landing em `/home`).
 *
 * Sem cadastro self-service ainda (tenants são provisionados manualmente) e sem
 * envio de e-mail transacional configurado — o CTA de contato usa link de
 * WhatsApp, mesmo padrão já usado em Clientes/Cobranças. Não há dado de contato
 * comercial real ainda: número abaixo é mock, ver TODO.
 */

import type { Metadata } from 'next'
import Link from 'next/link'
import {
  Bike,
  Building2,
  ClipboardCheck,
  FileText,
  MessageCircle,
  Smartphone,
  Wallet,
  Wrench,
} from 'lucide-react'

import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'

export const metadata: Metadata = {
  title: 'Locaw — Gestão completa para locadoras de motos',
  description:
    'Frota, locações, financeiro, manutenção preventiva e vistorias em um único sistema — com app próprio para o cliente acompanhar tudo.',
}

// TODO: substituir pelo número real de vendas antes de publicar em produção.
// Sem dado de contato comercial cadastrado ainda — mantido como mock (all-zeros
// não resolve pra nenhum contato real no WhatsApp).
const SALES_WHATSAPP_NUMBER = '5500000000000'
const SALES_WHATSAPP_HREF = `https://wa.me/${SALES_WHATSAPP_NUMBER}`

const FEATURES = [
  {
    icon: Bike,
    title: 'Frota',
    description: 'Cadastro completo das motos, status em tempo real e mapa de localização.',
  },
  {
    icon: FileText,
    title: 'Locações',
    description: 'Contratos vinculando cliente e moto, fila de espera e renovação automática.',
  },
  {
    icon: Wallet,
    title: 'Financeiro',
    description: 'Cobranças, entradas, despesas e multas com cálculo de atraso e descontos.',
  },
  {
    icon: Wrench,
    title: 'Manutenção preventiva',
    description: 'Planos por item, alertas de vencimento e aprovação de conclusões.',
  },
  {
    icon: ClipboardCheck,
    title: 'Vistorias',
    description: 'Check-in, check-out e periódica com checklist de fotos e histórico comparado.',
  },
  {
    icon: Building2,
    title: 'Multi-unidade',
    description: 'Vários operadores no mesmo sistema, cada um com seus dados isolados.',
  },
  {
    icon: Smartphone,
    title: 'App do cliente',
    description: 'O locatário acompanha cobranças e registra manutenções pelo celular.',
  },
] as const

const STEPS = [
  {
    title: 'Cadastre a frota',
    description: 'Motos, clientes e planos de manutenção — a base do sistema.',
  },
  {
    title: 'Gerencie locações e financeiro',
    description: 'Contratos, cobranças e vistorias em um fluxo único, sem planilha solta.',
  },
  {
    title: 'Cliente acompanha pelo app',
    description: 'Cobranças e manutenções ficam visíveis pro locatário, sem ligação nem grupo de WhatsApp.',
  },
] as const

export default function HomePage() {
  return (
    <div className="min-h-screen bg-bg">
      <header className="sticky top-0 z-10 border-b border-divider bg-bg/80 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary">
              <Bike className="h-5 w-5 text-primary-contrast" />
            </div>
            <span className="text-[18px] font-bold text-fg">Locaw</span>
            <Badge variant="warning">Em construção</Badge>
          </div>

          <nav className="hidden items-center gap-8 md:flex">
            <a href="#recursos" className="text-[14px] text-fg-soft hover:text-fg">
              Recursos
            </a>
            <a href="#como-funciona" className="text-[14px] text-fg-soft hover:text-fg">
              Como funciona
            </a>
            <a href="#contato" className="text-[14px] text-fg-soft hover:text-fg">
              Contato
            </a>
          </nav>

          <Link href="/login">
            <Button variant="outline" size="sm">
              Entrar
            </Button>
          </Link>
        </div>
      </header>

      <main>
        <section className="mx-auto max-w-6xl px-4 py-20 text-center sm:px-6 sm:py-28">
          <h1 className="mx-auto max-w-3xl text-[36px] font-bold leading-tight text-fg sm:text-[48px]">
            Gestão completa para locadoras de motos
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-[16px] text-fg-soft sm:text-[18px]">
            Frota, locações, financeiro, manutenção preventiva e vistorias em um único lugar —
            com app próprio para o cliente acompanhar tudo.
          </p>
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Link href="/login">
              <Button size="lg">Entrar</Button>
            </Link>
            <a href={SALES_WHATSAPP_HREF} target="_blank" rel="noopener noreferrer">
              <Button variant="outline" size="lg" className="gap-2">
                <MessageCircle className="h-4 w-4" />
                Falar no WhatsApp
              </Button>
            </a>
          </div>
        </section>

        <section id="recursos" className="border-t border-divider bg-surface py-20">
          <div className="mx-auto max-w-6xl px-4 sm:px-6">
            <div className="mx-auto max-w-2xl text-center">
              <h2 className="text-[28px] font-bold text-fg">Tudo que a operação precisa</h2>
              <p className="mt-3 text-[16px] text-fg-soft">
                Um sistema único pra substituir planilhas, grupos de WhatsApp e controles soltos.
              </p>
            </div>

            <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {FEATURES.map((feature) => (
                <Card key={feature.title} padding="lg">
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary-tint text-primary">
                    <feature.icon className="h-5 w-5" />
                  </div>
                  <h3 className="mt-4 text-[16px] font-semibold text-fg">{feature.title}</h3>
                  <p className="mt-1.5 text-[14px] text-fg-soft">{feature.description}</p>
                </Card>
              ))}
            </div>
          </div>
        </section>

        <section id="como-funciona" className="py-20">
          <div className="mx-auto max-w-6xl px-4 sm:px-6">
            <div className="mx-auto max-w-2xl text-center">
              <h2 className="text-[28px] font-bold text-fg">Como funciona</h2>
            </div>

            <div className="mt-12 grid gap-8 sm:grid-cols-3">
              {STEPS.map((step, index) => (
                <div key={step.title} className="text-center sm:text-left">
                  <span className="text-[13px] font-semibold text-primary">Passo {index + 1}</span>
                  <h3 className="mt-2 text-[18px] font-semibold text-fg">{step.title}</h3>
                  <p className="mt-1.5 text-[14px] text-fg-soft">{step.description}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section id="contato" className="border-t border-divider bg-surface py-20">
          <div className="mx-auto max-w-3xl px-4 text-center sm:px-6">
            <h2 className="text-[28px] font-bold text-fg">Pronto para profissionalizar sua locadora?</h2>
            <p className="mt-3 text-[16px] text-fg-soft">Fale com a gente e conheça o Locaw de perto.</p>
            <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <a href={SALES_WHATSAPP_HREF} target="_blank" rel="noopener noreferrer">
                <Button size="lg" className="gap-2">
                  <MessageCircle className="h-4 w-4" />
                  Falar no WhatsApp
                </Button>
              </a>
              <Link href="/login">
                <Button variant="outline" size="lg">
                  Já sou cliente — Entrar
                </Button>
              </Link>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-divider py-8">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-3 px-4 sm:flex-row sm:px-6">
          <span className="text-[13px] text-fg-mute">Locaw © {new Date().getFullYear()}</span>
          <span className="text-[13px] text-fg-mute">Sistema de gestão para locadoras de motos</span>
        </div>
      </footer>
    </div>
  )
}
