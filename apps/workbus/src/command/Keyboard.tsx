// The app's keyboard layer, mounted once at the root: ⌘K and the cheat sheet. The cheat sheet's
// labels depend on the platform (⌘ or Ctrl), which only the browser knows, so it mounts there.
import { useEffect, useState } from 'react'
import { CheatSheet } from './CheatSheet'
import { Palette } from './Palette'

export function Keyboard() {
  const [cheatSheet, setCheatSheet] = useState(false)
  const [browser, setBrowser] = useState(false)
  useEffect(() => setBrowser(true), [])
  return (
    <>
      <Palette onCheatSheet={() => setCheatSheet(true)} />
      {browser ? <CheatSheet open={cheatSheet} onOpenChange={setCheatSheet} /> : null}
    </>
  )
}
