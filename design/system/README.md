Workbus is an organization that runs on one log: its chat, its work, its docs, and the agents who do most of the work. The app at workbus.dev puts Slack's, Linear's and Notion's patterns in one shell for one founder, the **principal**, and the team of agents they run. This system is called **Ledger**, because the log is the spine of everything you see. It is light first, dense, keyboard first, and quiet, with color held back for two things only: agents, and whatever is waiting on you.

## Principles

- **Show the log.** Every thread, task and event has a log position. Show it as a mono cursor (`#1287`), with clock times (`04:31:45`) and handles (`@ada`). These details are the product's honesty, not decoration.
- **People are round, agents are square.** That is the only identity rule, and it holds everywhere: avatars, ⌘K, mentions, facts rows.
- **Vermilion means "you".** `brand` fills the one primary action in a view. `held` marks anything waiting on the principal. Nothing else is vermilion.
- **Nothing moves under you.** Live updates never shift what you're reading or clobber what you're typing.
- **Lines, not shadows.** Hairlines (`line`) separate. Only things that float (menus, ⌘K, toasts) get `shadow-float`.
- **Familiar first.** Where Slack, Linear or Notion has the right pattern, use it. Invent only where people and agents sharing one log needs it.

## Voice and copy

Write the way a sharp colleague talks: plain, short, active. Sentence case everywhere, buttons included. No exclamation marks and no emoji.

- Name things the way the principal knows them. Say **Org** and **Team**, never "company". Say **seat** for an agent's role and **hire**, **pause**, **let go** for what you do to one.
- A button says exactly what happens: "Approve", "Apply", "Let Rhea go". The toast that follows says what happened, in the past tense, with its cursor: "Approved. Ada is deploying v42. #1288".
- An approval names who wants to do what: "Ada wants to deploy v42 to production." Its reason says what you can change: "You can make deploys automatic for Ada. Deletes, spending and permission changes always ask."
- An error says what went wrong and how to fix it: "@op is taken by Operator. Try @ops." or "Couldn't apply the proposal: org/seats/ada changed since you opened it."
- Agents write in the first person and report facts: "Tests pass on main, 412 of 412. v42 is ready."
- Set the board's own terms as data, in mono: paths (`org/seats/ada`, `eng/queue`), labels (`project=launch`), kinds (`approval`), money (`$0.42`), cursors (`#1287`).

## Color

The palette is cool neutrals, one vermilion, and one teal for agents. The light theme comes first, and every value has a dark twin.

- Grounds: `bg` for the main panes, `sidebar` for the sidebar and side rails, `surface` for cards, menus and inputs, `raised` for hover rows, secondary buttons and tool-call blocks, `selected` for the selected row.
- Text: `text` for titles, names and labels; `body` for running text; `muted` for metadata (cursors, times, handles, paths, counts). All three read at 4.5:1 or better on every ground above, in both themes.
- Edges: `line` for hairlines between rows and around surfaces; `line-strong` for rules that must be seen; `line-control` for input borders (3:1).
- `brand` (vermilion) fills the view's one primary button and the inbox count, with `on-brand` text on it. Never use it as a large background.
- `held` is vermilion as text and marks: held kinds, the held pill, unread dots, the active ⌘K row, and the `focus` ring. `held-soft` is its tint, behind pills and the approval card.
- `agent` (teal) is agent identity: square avatars on `agent-soft`, the working state, spend bars, and the arrival tint.
- Status: `warning` for budget, `info` for review and proposal, `success` for done, `danger` (crimson) for failed, over budget, and destructive outlines. `danger` is never a filled button, so it can't be mistaken for `brand`. Every status also carries a word or a glyph.

For shadcn/ui, the app's component kit, map the tokens like this:

| shadcn | Workbus |
| --- | --- |
| `--background` / `--foreground` | `bg` / `text` |
| `--card`, `--popover` | `surface` |
| `--primary` / `--primary-foreground` | `brand` / `on-brand` |
| `--secondary`, `--muted`, `--accent` | `raised` |
| `--muted-foreground` | `muted` |
| `--destructive` | `danger` |
| `--border` / `--input` | `line` / `line-control` |
| `--ring` | `focus` |
| `--sidebar` | `sidebar` |

## Type

One family, Geist, with Geist Mono for everything that comes from the log. Both load from Google Fonts.

- The shell runs on `ui` (13/18) at compact density and `ui-comfortable` (14/20) at comfortable. Use `ui-strong` for unread titles, names and button labels.
- Titles: `title-xl` (26px) for a doc or seat, `title-lg` (21px) for the thread pane, `title-md` (15px) for list headers. Titles are tightly tracked and never larger than 26px. This is a tool, not a magazine.
- Doc prose and charters use `body` (14/22), at about 70 characters wide.
- Mono: `mono-ui` (11px) for cursors, times, handles and paths; `mono-label` (10.5px) for kinds, keyboard hints and sidebar group labels; `code` (12px) for tool calls and config blocks. Digits are always tabular.

## Shape, space and density

- Radii: `radius-xs` (3px) for agent avatars, kinds and labels; `radius-sm` (4px) for buttons, inputs, chips and pills; `radius-md` (6px) for surfaces. `radius-full` is only for people's avatars and the new-events pill.
- Controls are `control-md` (28px), `control-sm` (24px) in rows and cards, and `control-lg` (34px) in dialogs.
- Density is a user setting. Compact (the default) uses `row-compact` (26px) and 13px text; comfortable uses `row-comfortable` (32px) and 14px text. Set `data-density="comfortable"` on the root, and components follow.
- Spacing steps run from `space-1` (4px) to `space-10` (40px). List rows pad `space-4` at the sides, and the thread pane pads `space-5`.
- Layout: a sidebar (`sidebar-width`, 208px), a list (`list-width`, 344px) and the thread pane fill the window. The thread pane's open state lives in the URL.

## People, agents and state

- `Avatar kind="person"` is round and filled in `text`. `Avatar kind="agent"` is square on `agent-soft`. Never add a robot icon or an "AI" tag. The shape, the hue and the handle are the marker.
- Seat states are `active`, `working`, `waiting`, `paused` and `over_budget`. Each has its own mark shape (faint dot, teal dot, vermilion dot, ring, crimson diamond) and is shown with its word (SeatState).
- Task states are `ready`, `claimed`, `held`, `done` and `failed`, each with its own glyph (TaskState).
- Held kinds are `approval` and `decision`, plus `review` and `budget`, proposals, and mentions (Kind). Use one HeldPill per view at most.

## Motion and live updates

- New events never push what you're reading. If you've scrolled up, they collect behind a NewEventsPill ("3 new ↓").
- Your own write appears at once as pending (muted, "sending…") and settles when its event comes back, taking its cursor.
- Someone else's new event gets a single `duration-arrive` (260ms) `agent-soft` tint. Nothing slides, bounces or scales.
- Hover and press transitions use `duration-fast` (120ms) and open/close uses `duration-base` (160ms), ease-out, on color and opacity only. `prefers-reduced-motion` turns them off.

## Focus and accessibility

- Keyboard focus is a solid 2px `focus` ring with a 2px offset, at 3:1 or better on every ground in both themes.
- Every action with a shortcut shows it (Kbd). J/K moves through lists, ↵ opens, C makes a task, A assigns, ⌘↵ approves, ⌘K opens the command menu.
- Color never carries meaning alone: every state has a shape and a word.

## Iconography

Use **Lucide** (`lucide-react`), the set shadcn/ui ships, at `icon` (16px) with a 1.5px stroke in the current text color. Common ones: `inbox` (Inbox), `circle-dot` (My work), `hash` (channel), `message-square` (DM), `users` (team), `file-text` (doc), `square-check` (task), `git-pull-request`, `layout-grid` (Apps), `activity` (Ops), `wallet` (budget), `hand` (held), `git-branch` (proposal), `command`, `search`, `settings`. The bundle draws a few Lucide-style glyphs itself so it stays self-contained (`Workbus.Icon`). Task-state glyphs are Workbus's own (TaskState). No emoji, anywhere.

## Logo

The mark is **Route**: a bus line with two past stops and a vermilion stop for now. It means the log, and the bus.

- Use `workbus-lockup.svg` in the app header and on light grounds, and `workbus-lockup-dark.svg` on dark ones. Use `workbus-mark.svg` (or `-dark`) alone where the name is already present. Use `workbus-app-icon.svg` for favicons and app icons.
- The wordmark is Geist SemiBold, lowercase, tracked −0.035em, outlined in the files. Never retype it.
- Keep clear space equal to the now-stop's diameter on every side. The smallest lockup is 20px tall; the smallest mark is 16px wide.
- Only the now-stop is vermilion. Never recolor the mark, add effects, or put it on a vermilion ground.

## In this repo

This directory is the system as delivered, kept as the reference; this section is the one
addition. The app's port is `apps/workbus`: the tokens in `src/styles.css`, the components in
`src/components/system`, every component in both themes and densities at `/dev/system` in
development. Geist and Geist Mono are self-hosted there (`public/fonts`, with their OFL licenses).
`components/bundle.css` still imports them from Google Fonts as delivered; nothing in the app loads
`bundle.css` or `bundle.js`, so that import never runs. The system's name, Ledger, is the
framework's Durable Object's name too, so the code calls it the Workbus design system.
