# CommandPalette

⌘K runs commands, searches seats, threads and docs, and sends anything that isn't a command to the operator (§9.3). The active row gets a 2px `held` inset bar, the one place a bar marks selection.

- Result groups, in order: seats, threads, docs, commands, then **ask** ("Ask @op: …", ⇧↵).
- Paths and cursors are mono and muted. Seats show their live state.
- The consumer provides `query` and `groups`.
