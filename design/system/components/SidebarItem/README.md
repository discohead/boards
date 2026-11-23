# SidebarItem

A row in the sidebar: Inbox, My work, agents with their state, teams and channels. Row height follows density (`row-compact` 26px, `row-comfortable` 32px).

- The trailing slot shows one thing: the inbox `count` (the only vermilion fill in the sidebar), a seat's `state`, an `unread` dot, or a muted `meta` count.
- Group headers are mono with `//` before them, in lowercase: `// agents`, `// teams`.
- Channels nest under their team with `child`. A channel with unread messages is bold.
