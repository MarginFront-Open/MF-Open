import { notFound } from 'next/navigation'
import { CatalogPreview } from '@/features/dashboard-shell/catalog-preview'

export default function CatalogPreviewPage() {
  if (process.env.NODE_ENV === 'production') notFound()

  return <CatalogPreview />
}
