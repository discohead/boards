import { createFileRoute } from '@tanstack/react-router'
import { DocView } from '@/docs/DocView'

export const Route = createFileRoute('/docs/$id')({ component: OpenDoc })

function OpenDoc() {
  const { id } = Route.useParams()
  return <DocView key={id} id={id} />
}
