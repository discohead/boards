// The app's keyboard layer, mounted once at the root: ⌘K and the cheat sheet.
import { useState } from 'react'
import { CheatSheet } from './CheatSheet'
import { Palette } from './Palette'

export function Keyboard() {
  const [cheatSheet, setCheatSheet] = useState(false)
  return (
    <>
      <Palette onCheatSheet={() => setCheatSheet(true)} />
      <CheatSheet open={cheatSheet} onOpenChange={setCheatSheet} />
    </>
  )
}
