import { redirect } from 'next/navigation'

// Theme switching lives in the header user menu, so this route only
// redirects to the profile settings.
export default function SettingsPreferencesRoute() {
  redirect('/settings/profile')
}
