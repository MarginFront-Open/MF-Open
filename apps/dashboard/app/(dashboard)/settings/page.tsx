import Settings from '@/features/settings'
import PersonalSettings from '@/features/settings/personal'

export default function SettingsRoute() {
  return (
    <Settings>
      <PersonalSettings />
    </Settings>
  )
}
