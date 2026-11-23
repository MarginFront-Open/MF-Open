import ContentSection from '../components/content-section'
import ProfileForm from './profile-form'

export default function SettingsProfile() {
  return (
    <ContentSection
      title='Profile'
      desc='Your name and email, as your teammates see them across MarginFront.'
    >
      <ProfileForm />
    </ContentSection>
  )
}
