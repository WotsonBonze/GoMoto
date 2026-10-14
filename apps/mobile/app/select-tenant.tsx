import { useAuth } from '../src/contexts/auth'
import { AuthShell } from '../src/components/AuthShell'
import { Badge, Button, Card, ListItem } from '../src/components/ui'

// Fluxo de autenticação fica sempre no tema claro padrão — ver login.tsx.
export default function SelectTenantScreen() {
  const { tenants, selectTenant, signOut } = useAuth()

  return (
    <AuthShell
      title="Escolha a locadora"
      subtitle="Você é cliente de mais de uma locadora. Com qual deseja entrar agora?"
    >
      <Card padded={false}>
        {tenants.map((tenant, i) => {
          const suspended = !!tenant.suspended_at
          return (
            <ListItem
              key={tenant.id}
              icon="business-outline"
              iconTone={suspended ? 'neutral' : 'primary'}
              label={tenant.name}
              sublabel={suspended ? 'Temporariamente indisponível' : undefined}
              trailing={suspended ? <Badge label="Indisponível" size="sm" /> : undefined}
              onPress={suspended ? undefined : () => void selectTenant(tenant.id)}
              last={i === tenants.length - 1}
            />
          )
        })}
      </Card>

      <Button label="Sair" variant="ghost" size="md" onPress={signOut} />
    </AuthShell>
  )
}
