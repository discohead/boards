// A doc by its ID (links, the tree): the docs list with that doc open on its Document face.
import { createFileRoute, redirect } from '@tanstack/react-router'

export const Route = createFileRoute('/docs/$id')({
  beforeLoad: ({ params, location }) => {
    throw redirect({ to: '/docs', search: { thread: Number(params.id), face: 'doc' }, hash: location.hash, replace: true })
  },
})
