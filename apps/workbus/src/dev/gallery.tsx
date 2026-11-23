// The gallery behind /dev/system. Each section draws what the system's own preview.html for that
// component draws, with the same props, so the two can be compared side by side.
import { useState, type ReactNode } from 'react'
import { getRouteApi } from '@tanstack/react-router'
import { Hash, Inbox, MoreHorizontal } from 'lucide-react'
import {
  ApprovalCard,
  Avatar,
  BoardCard,
  Button,
  CommandPalette,
  HeldPill,
  Icon,
  Input,
  IssueRow,
  Kbd,
  Kind,
  Label,
  Lockup,
  Mark,
  Menu,
  Message,
  NewEventsPill,
  SeatState,
  SidebarGroup,
  SidebarItem,
  Tabs,
  TaskState,
  Toast,
  ToolCall,
  toast,
  useDensity,
  useTheme,
  type KindName,
  type TaskStateName,
} from '@/components/system'

const route = getRouteApi('/dev/system')

const row = 'flex flex-wrap items-center gap-2'
const stack = 'flex flex-col gap-3'
const mono = 'font-mono text-mono-ui text-muted-foreground tabular-nums'

export const SECTIONS: Record<string, () => ReactNode> = {
  Button: () => (
    <div className={stack}>
      <div className={row}>
        <Button variant="primary" kbd="⌘↵">Approve</Button>
        <Button variant="secondary" kbd="A">Assign</Button>
        <Button variant="outline">Reply</Button>
        <Button variant="ghost">Cancel</Button>
      </div>
      <div className={row}>
        <Button variant="danger" icon="trash">Let Rhea go</Button>
        <Button variant="primary" size="sm">Apply</Button>
        <Button variant="primary" size="lg">Hire</Button>
        <Button variant="secondary" disabled>Disabled</Button>
      </div>
    </div>
  ),
  Kbd: () => (
    <div className={row}>
      {['⌘K', 'C', 'A', '⇧P', 'J / K', 'esc'].map((k) => (
        <Kbd key={k}>{k}</Kbd>
      ))}
    </div>
  ),
  Input: () => (
    <div className={stack} style={{ maxWidth: 320 }}>
      <Input id="budget" label="Budget per month" prefix="$" defaultValue="80" kbd="↵ save" hint="Ada gets a task at 80% of this." />
      <Input id="handle" label="Handle" prefix="@" defaultValue="op" error="@op is taken by Operator. Try @ops." />
      <Input id="filter" placeholder="Filter threads…" kbd="/" />
    </div>
  ),
  Avatar: () => (
    <div className={row}>
      <Avatar kind="person" initials="J" name="You" size="lg" />
      <Avatar kind="agent" initials="Ada" name="Ada" size="lg" />
      <Avatar kind="person" initials="J" name="You" size="md" />
      <Avatar kind="agent" initials="A" name="Ada" size="md" />
      <Avatar kind="person" initials="J" name="You" />
      <Avatar kind="agent" initials="Op" name="Operator" />
      <Avatar kind="agent" initials="R" name="Rhea" size="xs" />
    </div>
  ),
  SeatState: () => (
    <div className="flex flex-col gap-2">
      <SeatState state="active" />
      <SeatState state="working" />
      <SeatState state="waiting" />
      <SeatState state="paused" />
      <SeatState state="over_budget" />
    </div>
  ),
  Kind: () => (
    <div className={row}>
      {(['approval', 'decision', 'budget', 'review', 'proposal', 'mention', 'done', 'failed'] as KindName[]).map((k) => (
        <Kind key={k} kind={k} />
      ))}
    </div>
  ),
  Label: () => (
    <div className={row}>
      <Label name="project" value="launch" />
      <Label name="priority" value="high" />
      <Label name="cycle" value="2026-w47" />
      <Label name="board.doc.proposal" />
    </div>
  ),
  HeldPill: () => (
    <div className={row}>
      <HeldPill kind="approval" />
      <HeldPill kind="decision" />
      <HeldPill kind="budget" />
    </div>
  ),
  TaskState: () => (
    <div className={stack}>
      <div className={row} style={{ gap: 16 }}>
        {(['ready', 'claimed', 'held', 'done', 'failed'] as TaskStateName[]).map((s) => (
          <span key={s} className={row} style={{ gap: 6 }}>
            <TaskState state={s} />
            <span className={mono}>{s}</span>
          </span>
        ))}
      </div>
      {/* The framework's other states, as the data layer maps them. */}
      <div className={row} style={{ gap: 16 }}>
        <TaskState state="ready" label="waits on #1276" />
        <TaskState state="done" muted label="canceled" />
      </div>
    </div>
  ),
  Tabs: () => (
    <Tabs
      tabs={[
        { id: 'c', label: 'Conversation', count: 12 },
        { id: 't', label: 'Task' },
        { id: 'd', label: 'Doc' },
        { id: 'a', label: 'Write it up', add: true },
      ]}
    />
  ),
  SidebarItem: () => (
    <div className="flex w-sidebar flex-col gap-px bg-sidebar p-2">
      <SidebarItem active count={4}>Inbox</SidebarItem>
      <SidebarItem meta={2}>My work</SidebarItem>
      <SidebarGroup>agents</SidebarGroup>
      <SidebarItem avatar={{ kind: 'agent', initials: 'Op', name: 'Operator' }} state="working">Operator</SidebarItem>
      <SidebarItem avatar={{ kind: 'agent', initials: 'A', name: 'Ada' }} state="waiting">Ada</SidebarItem>
      <SidebarItem avatar={{ kind: 'agent', initials: 'R', name: 'Rhea' }} state="over_budget">Rhea</SidebarItem>
      <SidebarGroup>teams</SidebarGroup>
      <SidebarItem>eng/</SidebarItem>
      <SidebarItem child unread># backend</SidebarItem>
      <SidebarItem child meta={7}># queue</SidebarItem>
    </div>
  ),
  Menu: () => (
    <Menu
      items={[
        { label: 'Assign…', icon: 'user', kbd: 'A', active: true },
        { label: 'Make a task', icon: 'task', kbd: 'C' },
        { label: 'Write it up', icon: 'doc' },
        '-',
        { label: 'Pause Ada', icon: 'pause', kbd: '⇧P', danger: true },
      ]}
    />
  ),
  CommandPalette: () => (
    <CommandPalette
      query="rhea"
      groups={[
        { name: 'seats', items: [{ label: 'Rhea', path: 'org/seats/rhea', state: 'over_budget', active: true, avatar: { kind: 'agent', initials: 'R', name: 'Rhea' } }] },
        { name: 'threads', items: [{ label: "Raise Rhea's budget to $80 / month", path: '#1279', task: 'held' }] },
        {
          name: 'commands',
          items: [
            { label: 'Pause Rhea', icon: 'pause', kbd: '⇧P' },
            { label: 'Message Rhea', icon: 'message', kbd: 'M' },
          ],
        },
        { name: 'ask', items: [{ label: 'Ask @op: “rhea”', kbd: '⇧↵', avatar: { kind: 'agent', initials: 'Op', name: 'Operator' } }] },
      ]}
    />
  ),
  Toast: () => (
    <div className={stack}>
      <Toast cursor="#1288" action={{ label: 'Undo', kbd: 'Z' }}>
        Approved. Ada is deploying v42.
      </Toast>
      <Toast tone="danger" action={{ label: 'Retry' }}>
        Couldn't apply the proposal: org/seats/ada changed since you opened it.
      </Toast>
    </div>
  ),
  NewEventsPill: () => (
    <div className={row}>
      <NewEventsPill count={1} />
      <NewEventsPill count={12} />
      <NewEventsPill count={3} direction="up" />
    </div>
  ),
  IssueRow: () => (
    <div className="overflow-hidden rounded-md border border-line bg-bg">
      <IssueRow cursor="#1287" state="held" title="Deploy v42 to production" kinds={['approval']} assignee={{ kind: 'agent', initials: 'A', name: 'Ada' }} updated="04:31" selected />
      <IssueRow cursor="#1283" state="claimed" title="Unread counts per actor in a side table" labels={[['project', 'shell']]} assignee={{ kind: 'agent', initials: 'A', name: 'Ada' }} updated="04:02" />
      <IssueRow cursor="#1276" state="ready" title="Private channels for dm/<seat>" labels={[['project', 'shell'], ['priority', 'high']]} updated="yesterday" />
      <IssueRow cursor="#1251" state="done" title="Fix webhook retry backoff" kinds={['review']} assignee={{ kind: 'agent', initials: 'A', name: 'Ada' }} updated="03:20" />
    </div>
  ),
  BoardCard: () => (
    <div className={row} style={{ alignItems: 'flex-start' }}>
      <BoardCard cursor="#1287" channel="eng/backend" state="held" title="Deploy v42 to production" kinds={['approval']} assignee={{ kind: 'agent', initials: 'A', name: 'Ada' }} cost="$0.42" />
      <BoardCard cursor="#1283" channel="eng/backend" state="claimed" title="Unread counts per actor in a side table" labels={[['project', 'shell']]} assignee={{ kind: 'agent', initials: 'A', name: 'Ada' }} cost="$1.87" />
    </div>
  ),
  Message: () => (
    <div>
      <Message author={{ name: 'Operator', handle: '@op', initials: 'Op', kind: 'agent' }} time="04:12:08">
        Assigned to Ada from <code>eng/queue</code>. Ship v42 once the retry fix lands.
      </Message>
      <Message author={{ name: 'You', handle: '@you', initials: 'J', kind: 'person' }} time="04:14:51">
        Fine by me. Ping me before it goes out.
      </Message>
      <Message author={{ name: 'Ada', handle: '@ada', initials: 'A', kind: 'agent' }} time="04:31:45" arrive>
        Tests pass on main, 412 of 412. v42 is ready.
      </Message>
      <Message author={{ name: 'You', handle: '@you', initials: 'J', kind: 'person' }} pending>
        Thanks. Write up what you learned in the runbook.
      </Message>
    </div>
  ),
  ToolCall: () => (
    <div className={stack} style={{ maxWidth: 460 }}>
      <ToolCall name="deploy.production" input={{ worker: 'workbus-app', version: 'v42' }} status="held" />
      <ToolCall name="board.tasks.complete" input={{ id: '1251', outcome: 'done' }} status="ok" />
    </div>
  ),
  ApprovalCard: () => (
    <ApprovalCard
      title="Ada wants to deploy v42 to production"
      reason="You can make deploys automatic for Ada. Deletes, spending and permission changes always ask."
      run="18 steps · 41s · $0.42"
    />
  ),
  Logo: () => (
    <div className={row} style={{ gap: 24 }}>
      <Lockup />
      <Lockup height={32} />
      <Mark />
      <Mark size={32} />
      <img src="/favicon.svg" alt="The app icon" width={32} height={32} />
    </div>
  ),
}

/** Things that open: a menu from its trigger, ⌘K as a dialog, a toast. One per page, not per pane. */
function Live() {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const items = [
    { label: 'Inbox', icon: Inbox, kbd: 'G I' },
    { label: 'general', icon: Hash, path: 'general' },
  ].filter((it) => it.label.toLowerCase().includes(q.toLowerCase()))
  return (
    <div className={row}>
      <Menu
        trigger={
          <Button variant="ghost" size="sm" icon={MoreHorizontal}>
            More
          </Button>
        }
        items={[
          { label: 'Assign…', icon: 'user', kbd: 'A' },
          { label: 'Make a task', icon: 'task', kbd: 'C' },
          '-',
          { label: 'Pause Ada', icon: 'pause', kbd: '⇧P', danger: true },
        ]}
      />
      <Button variant="outline" kbd="⌘K" onClick={() => setOpen(true)}>
        Open ⌘K
      </Button>
      <CommandPalette open={open} onOpenChange={setOpen} query={q} onQueryChange={setQ} groups={[{ name: 'places', items }]} />
      <Button variant="outline" onClick={() => toast({ children: 'Approved. Ada is deploying v42.', cursor: '#1288', action: { label: 'Undo', kbd: 'Z' } })}>
        Show a toast
      </Button>
      <Button variant="outline" onClick={() => toast({ tone: 'danger', children: "Couldn't apply the proposal: org/seats/ada changed since you opened it." })}>
        Show an error
      </Button>
    </div>
  )
}

function Settings() {
  const { theme, setTheme, resolved } = useTheme()
  const { density, setDensity } = useDensity()
  return (
    <div className={row}>
      <span className="text-muted-foreground">Theme</span>
      {(['system', 'light', 'dark'] as const).map((t) => (
        <Button key={t} size="sm" variant={theme === t ? 'secondary' : 'ghost'} onClick={() => setTheme(t)}>
          {t[0].toUpperCase() + t.slice(1)}
        </Button>
      ))}
      <span className={mono}>{resolved}</span>
      <span className="ml-4 text-muted-foreground">Density</span>
      {(['compact', 'comfortable'] as const).map((d) => (
        <Button key={d} size="sm" variant={density === d ? 'secondary' : 'ghost'} onClick={() => setDensity(d)}>
          {d[0].toUpperCase() + d.slice(1)}
        </Button>
      ))}
    </div>
  )
}

function Pane({ theme, density, children }: { theme: 'light' | 'dark'; density: 'compact' | 'comfortable'; children: ReactNode }) {
  return (
    <div data-theme={theme} data-density={density} className="min-w-0 bg-bg p-4 text-ui text-body">
      <div className={mono + ' mb-3'}>
        {theme} · {density}
      </div>
      {children}
    </div>
  )
}

const PANES = [
  ['light', 'compact'],
  ['light', 'comfortable'],
  ['dark', 'compact'],
  ['dark', 'comfortable'],
] as const

export default function Gallery() {
  const { only, theme, density } = route.useSearch()
  // One component alone, for a screenshot beside its preview.html: 16px padding, as bundle.css.
  if (only && SECTIONS[only])
    return (
      <div id="only" data-theme={theme ?? 'light'} data-density={density ?? 'compact'} className="min-h-svh bg-bg p-4 text-ui text-body">
        {SECTIONS[only]()}
      </div>
    )
  return (
    <div className="min-h-svh bg-bg text-ui text-body">
      <header className="sticky top-0 z-10 flex flex-wrap items-center gap-4 border-b border-line bg-sidebar px-4 py-2">
        <Lockup />
        <span className="text-title-md text-text">The Workbus design system</span>
        <Settings />
        <Live />
      </header>
      {Object.keys(SECTIONS).map((name) => (
        <section key={name} id={name} className="border-b border-line-strong">
          <h2 className="flex items-center gap-2 bg-sidebar px-4 py-2 text-title-md text-text">
            <Icon name="doc" className="text-muted-foreground" />
            {name}
          </h2>
          <div className="grid grid-cols-1 gap-px bg-line xl:grid-cols-4">
            {PANES.map(([t, d]) => (
              <Pane key={t + d} theme={t} density={d}>
                {SECTIONS[name]()}
              </Pane>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}
