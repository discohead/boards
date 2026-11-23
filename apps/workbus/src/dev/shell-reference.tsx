// The prototype's first screen (the inbox with a held thread open), drawn with the system's
// components, to compare with the prototype and to show the views how the pieces fit. Fixture data.
import { Activity, Boxes, FileText, Hash, Inbox, LayoutGrid, ListFilter, MessageSquare, Network, Search, Settings, SquareCheck, Users, X, FileCheck } from 'lucide-react'
import { ApprovalCard, Avatar, HeldPill, Kbd, Kind, Label, Lockup, Message, SidebarGroup, SidebarItem, Tabs, ToolCall, type KindName } from '@/components/system'
import { cn } from '@/lib/utils'

const ROWS: { cursor: string; kind: KindName; title: string; who: string; where: string; time: string; unread?: boolean; selected?: boolean }[] = [
  { cursor: '1281', kind: 'approval', title: 'Deploy v42 to production', who: '@ada', where: 'eng/releases', time: '09:42', unread: true, selected: true },
  { cursor: '1275', kind: 'decision', title: 'Choose the onboarding path', who: '@advisor', where: 'product/planning', time: '09:18', unread: true },
  { cursor: '1268', kind: 'proposal', title: 'Review the seat charter', who: '@op', where: 'org/seats', time: '08:54', unread: true },
  { cursor: '1261', kind: 'budget', title: 'November research budget', who: '@rhea', where: 'product/research', time: '08:31', unread: true },
  { cursor: '1254', kind: 'mention', title: 'Your daily brief is ready', who: '@op', where: 'ops/briefs', time: '08:00' },
]

const mono = 'font-mono text-mono-ui text-muted-foreground tabular-nums'

export function ShellReference() {
  return (
    <div className="grid h-svh grid-cols-[var(--spacing-sidebar)_minmax(0,1fr)] overflow-hidden bg-bg text-ui text-body">
      <aside className="flex min-h-0 flex-col border-r border-line bg-sidebar">
        <div className="flex h-[61px] flex-none items-center px-[18px]">
          <Lockup height={22} />
        </div>
        <div className="flex-1 overflow-auto px-2.5">
          <button className="mb-[18px] flex h-[30px] w-full items-center gap-2 rounded-sm border border-line-strong bg-surface px-2 text-muted-foreground">
            <Search size={16} strokeWidth={1.5} aria-hidden />
            Search or ask
            <Kbd className="ml-auto">⌘ K</Kbd>
          </button>
          <SidebarItem icon={Inbox} active count={5}>Inbox</SidebarItem>
          <SidebarItem icon={SquareCheck}>My work</SidebarItem>
          <SidebarGroup>Direct messages</SidebarGroup>
          <SidebarItem avatar={{ kind: 'agent', initials: 'OP', name: 'Operator' }} meta="@op">Operator</SidebarItem>
          <SidebarItem avatar={{ kind: 'agent', initials: 'AV', name: 'Advisor' }} meta="@advisor">Advisor</SidebarItem>
          <SidebarGroup>Teams</SidebarGroup>
          <SidebarItem icon={Users}>Engineering</SidebarItem>
          <SidebarItem icon={Hash} child>releases</SidebarItem>
          <SidebarItem icon={Users}>Product</SidebarItem>
          <SidebarItem icon={Hash} child>planning</SidebarItem>
          <SidebarGroup>Seats</SidebarGroup>
          <SidebarItem avatar={{ kind: 'agent', initials: 'AD', name: 'Ada' }} state="waiting">Ada</SidebarItem>
          <SidebarItem avatar={{ kind: 'agent', initials: 'RH', name: 'Rhea' }} state="working">Rhea</SidebarItem>
          <SidebarGroup>Workspace</SidebarGroup>
          <SidebarItem icon={Network}>Org &amp; seats</SidebarItem>
          <SidebarItem icon={FileText}>Docs</SidebarItem>
          <SidebarItem icon={LayoutGrid}>Apps</SidebarItem>
          <SidebarItem icon={Activity}>Ops</SidebarItem>
        </div>
        <div className="border-t border-line px-2.5 py-2">
          <SidebarItem icon={Settings}>Settings</SidebarItem>
        </div>
        <div className="flex items-center gap-2 border-t border-line px-4 py-3">
          <Avatar kind="person" initials="JM" name="You" size="md" />
          <div>
            <div className="font-semibold text-text">Jared</div>
            <div className="font-mono text-mono-label text-muted-foreground">Principal</div>
          </div>
        </div>
      </aside>
      <main className="flex min-w-0 flex-col">
        <header className="flex h-[47px] flex-none items-center justify-between gap-2 border-b border-line px-[18px]">
          <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
            <Boxes size={14} strokeWidth={1.5} aria-hidden />
            Studio <span className="text-line-control">/</span> <strong className="font-[550] text-text">Inbox</strong>
          </div>
          <div className={cn(mono, 'flex items-center gap-[7px]')}>
            <span className="size-1.5 rounded-full bg-agent" /> Live log / #1287
          </div>
        </header>
        <div className="flex min-h-0 flex-1">
          <section className="flex w-list flex-none flex-col border-r border-line">
            <div className="flex items-center justify-between px-4 pt-[22px] pb-3.5">
              <h1 className="text-title-xl tracking-[-0.035em] text-text">Inbox</h1>
              <ListFilter size={16} strokeWidth={1.5} className="text-muted-foreground" aria-hidden />
            </div>
            <div className="flex gap-[5px] border-b border-line px-4 pb-3.5">
              {[['All', 8, true], ['Held', 5], ['Unread', 4]].map(([label, n, on]) => (
                <span key={label as string} className={cn('rounded-sm border border-transparent px-[9px] py-[3px] text-[12px] font-medium text-muted-foreground', on && 'border-line bg-raised text-text')}>
                  {label} <span className="font-mono text-mono-label">{n}</span>
                </span>
              ))}
            </div>
            <div className="min-h-0 flex-1 overflow-auto">
              <div className="flex justify-between border-b border-line bg-sidebar px-4 py-2 font-mono text-mono-label text-muted-foreground">
                <span>Today</span>
                <span>5</span>
              </div>
              {ROWS.map((r) => (
                <div
                  key={r.cursor}
                  className={cn('relative min-h-[76px] border-b border-line py-[13px] pr-4 pl-[21px]', r.selected && 'bg-selected shadow-[inset_2px_0_var(--wb-held)]')}
                >
                  {r.unread ? <span className="absolute top-[41px] left-2 size-1 rounded-full bg-held" /> : null}
                  <div className="flex items-center justify-between">
                    <Kind kind={r.kind} plain />
                    <span className={mono}>{r.time}</span>
                  </div>
                  <h4 className="mt-1 mb-[3px] text-[13px] leading-5 font-semibold text-text">{r.title}</h4>
                  <div className={cn(mono, 'flex gap-1.5')}>
                    {r.who} · {r.where}
                  </div>
                </div>
              ))}
            </div>
            <div className="flex items-center gap-1.5 border-t border-line px-4 py-[9px] font-mono text-mono-label text-muted-foreground">
              <Kbd>J</Kbd> <Kbd>K</Kbd> navigate <Kbd>↵</Kbd> open
            </div>
          </section>
          <section className="flex min-w-0 flex-1 flex-col">
            <div className="px-6 pt-5">
              <div className="flex items-center justify-between">
                <span className={mono}>eng/releases / #1281</span>
                <X size={16} strokeWidth={1.5} className="text-muted-foreground" aria-hidden />
              </div>
              <h2 className="mt-[11px] mb-2.5 text-title-lg tracking-[-0.03em] text-text">Deploy v42 to production</h2>
              <div className="mb-[17px] flex flex-wrap items-center gap-2">
                <HeldPill>Held for you</HeldPill>
                <Avatar kind="agent" initials="AD" name="Ada" size="xs" />
                <span className={mono}>@ada</span>
                <span className={mono}>·</span>
                <Label name="release" value="v42" />
              </div>
            </div>
            <Tabs
              className="[&_[data-slot=tabs-list]]:px-6"
              tabs={[
                { id: 'conversation', label: 'Conversation', count: 3, icon: MessageSquare },
                { id: 'task', label: 'Task', icon: FileCheck },
                { id: 'doc', label: 'Document', icon: FileText },
              ]}
            />
            <div className="min-h-0 flex-1 overflow-auto">
              <div className="mx-auto w-full max-w-[970px] px-6 py-5">
                <ApprovalCard
                  eyebrow="Deployment approval"
                  title="Ada wants to deploy v42 to production."
                  reason="Staging checks passed. Approving resumes the paused release."
                />
                <div className="my-3.5 flex items-center gap-2.5 font-mono text-mono-label text-muted-foreground after:flex-1 after:border-t after:border-line">
                  Conversation · 3 initial events
                </div>
                <div className="-mx-5">
                  <Message author={{ name: 'Operator', handle: '@op', initials: 'OP', kind: 'agent' }} time="09:38:12" cursor="#1281">
                    Ada, verify the release candidate and hold the production deploy for Jared.
                  </Message>
                  <Message author={{ name: 'Ada', handle: '@ada', initials: 'AD', kind: 'agent' }} time="09:41:05" cursor="#1285">
                    Tests pass on main, 412 of 412. v42 is ready for production.
                    <ToolCall name="release.verify" input={{ build: 'passed', tests: '412/412', deploy: 'held' }} status="held" />
                  </Message>
                  <Message author={{ name: 'Ada', handle: '@ada', initials: 'AD', kind: 'agent' }} time="09:42:18" cursor="#1287">
                    I've paused the deploy at the approval step. I can continue as soon as you sign off.
                  </Message>
                </div>
              </div>
            </div>
            <div className="border-t border-line bg-bg px-6 pt-3 pb-4">
              <div className="mx-auto max-w-[920px] rounded-md border border-line-strong bg-surface px-2.5 py-2 focus-within:border-line-control">
                <textarea placeholder="Reply to thread…" className="block min-h-7 w-full resize-none bg-transparent p-0.5 outline-none focus-visible:outline-none" />
                <div className="flex items-center gap-2">
                  <MessageSquare size={14} strokeWidth={1.5} className="text-muted-foreground" aria-hidden />
                  <span className={mono}>Posting as @you</span>
                  <button className="ml-auto inline-flex min-h-6 items-center gap-2 rounded-sm border border-line-strong bg-surface px-[7px] py-px font-semibold text-text">
                    Send <Kbd>⌘↵</Kbd>
                  </button>
                </div>
              </div>
            </div>
          </section>
        </div>
      </main>
    </div>
  )
}
