import ProfileForm from '../profile/profile-form'

export default function PersonalSettings() {
  return (
    <div className='max-w-2xl'>
      <div className='mb-6'>
        <h2 className='section-header mt-0'>Profile</h2>
        <p className='text-description'>
          Manage your personal information and how others see you on the
          platform.
        </p>
      </div>

      <ProfileForm />
    </div>
  )
}
