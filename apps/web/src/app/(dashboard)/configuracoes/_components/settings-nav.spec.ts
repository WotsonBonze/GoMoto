import { describe, expect, it } from 'vitest'
import { visibleSettingsNav } from './settings-nav'

const hrefs = (role: Parameters<typeof visibleSettingsNav>[0]) =>
  visibleSettingsNav(role).flatMap((g) => g.items.map((i) => i.href))

describe('visibleSettingsNav', () => {
  it('Owner vê tudo, inclusive gateways e multa/juros', () => {
    expect(hrefs('owner')).toContain('/configuracoes/pagamentos')
    expect(hrefs('owner')).toContain('/configuracoes/encargos')
  })

  it('Admin vê Empresa e Diagnóstico, mas não o que mexe no dinheiro', () => {
    const h = hrefs('admin')
    expect(h).toContain('/configuracoes/usuarios')
    expect(h).toContain('/configuracoes/integracoes')
    expect(h).not.toContain('/configuracoes/pagamentos')
    expect(h).not.toContain('/configuracoes/encargos')
  })

  it('Operator/Viewer só veem a própria conta — e os grupos vazios somem (RNF-003)', () => {
    for (const role of ['operator', 'viewer'] as const) {
      const groups = visibleSettingsNav(role)
      expect(groups.map((g) => g.label)).toEqual(['Minha conta'])
    }
  })
})
