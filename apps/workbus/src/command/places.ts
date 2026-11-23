// Where the palette goes for each kind of thing, as a URL: a channel is /c/<path>, a doc its page,
// and a thread opens in the pane (?thread=<id>) over whatever route is showing.
import { createContext, useContext } from 'react'

export type Places = {
  channel: (path: string) => string
  thread: (id: string) => string
  doc: (id: string) => string
}

export const defaultPlaces: Places = {
  channel: (path) => '/c/' + path,
  thread: (id) => {
    const search = new URLSearchParams(location.search)
    search.set('thread', id)
    return location.pathname + '?' + search
  },
  doc: (id) => '/docs/' + encodeURIComponent(id),
}

export const PlacesContext = createContext<Places>(defaultPlaces)
export const usePlaces = () => useContext(PlacesContext)
