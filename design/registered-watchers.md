# Registered watchers with service sinks: wakes

Status: phase 2, step 1 (design/workbus.md §5.5, §11, §14 question 2). It answers §14's second
question the way the user chose on 2026-11-23: build registered watchers with service sinks first,
so the reconciler owns each seat's wake rules and the Ledger does the matching.

## What exists today

Two kinds of watcher, neither what a seat needs:

- **Config watchers** (`defineWorkbus({ watch })`): matched by the Ledger after each write and
  delivered by a Mailbox to a sink (a URL, a service binding, a sync's courier), in order per
  thread, with retries. They're code: adding one is a deploy, and each sees as the board's own code.
- **Registered watchers** (`POST /watchers`, protocol v1): one registration per principal, its
  tails matched when it pulls (`GET /watchers/matches`) and acked. Nothing is delivered; `url`
  and `path` answer 501 `no_wake_by_url`/`no_wake_by_path`. A narrowed caller can't register.

## A wake

A wake is a registered watcher the board delivers: set at run time over HTTP, matched by the
Ledger as the caller that set it, delivered by a Mailbox to a service sink the deployment
declares. It's new beside both kinds above, which don't change, so protocol v1 is untouched (its
conformance counts stay the same).

Why "wake": the board protocol (SPEC.md, design/cloudflare-board.md in ~/Developer/board) already
uses "subscription" for its own things: the filter-plus-sink behind every watcher, the
`subscription.register` command, the Relay's live tails, and the binding's `Subscription` object
that `board.watch()` returns. The conformance kit checks none of them by that name, but a second
meaning would confuse readers of both, so this is a wake.

```
POST /wakes                 { key, sink, rules: { <id>: <rule> }, revision? }  ->  { wake, changed, created?, stale? }
GET  /wakes                 { wakes: [...] }
POST /wakes/:key/delete     { revision? }  ->  { removed, stale? }
```

The binding's `Board` has `setWake(key, { sink, rules, revision })`, `wakes()`, and
`deleteWake(key, { revision })`; the CLI has `wb wake set`, `wb wake delete`, and `wb wakes`. MCP has no tool for them: what wakes an agent is its deployment's business, not
the agent's (`run_code` has the Board, and the sink's allowlist holds there as everywhere).

### Who it is, and what it sees

The caller that sets a wake is kept whole: its principal, its profile, and its narrowing. So the
reconciler sets a seat's wake through the seat's own Board:

```ts
const board = env.WORKBUS.board('bus').as({ name: 'Ada' }).narrow(seat.can)
await board.setWake('ada', { sink: 'wake', revision: doc.revision, rules: { mention: 'mention', follow: 'follow', assigned: 'assigned', dm: 'dm', queue: { ready: 'work/queue' } } })
```

Over HTTP it's the same with `x-board-profile` and `x-board-can`. The wake keeps that
principal, profile, and narrowing, and every match is decided as that caller with the grants as
they are when the event is matched: a revoked grant stops matches from the next event on, and the
narrowing only narrows. Private channels follow from the actor: `worker:workbus-app+ada` is a
party to `dm/ada` and its watcher gets it; it isn't a party to `dm/bob` (nor is the app without
a profile), so nothing there ever matches, whatever its grants or rules say
(design/private-channels.md, open item 5). A seat's narrowing has to include its own DM, as for
its reads.

A wake's own caller's writes never wake it, except the schedules it set itself.

### Sinks: declared by the deployment, by name

A registrant names a sink; it never gives one. The deployment declares each sink it allows, the
service binding it delivers to, and which principals may target it:

```ts
defineWorkbus((env) => ({
  sinks: { wake: { binding: 'WAKE', method: 'wake', principals: ['worker:workbus-app'] } },
}))
```

- An unknown sink is 404 `sink_not_found`; one that doesn't list the caller's principal is 403
  `sink_forbidden`. A principal is the whole principal: the app's profiles are the app.
- It's checked again each time the Ledger hands matches on: a sink removed from the code, or no
  longer listing the wake's principal, gets nothing more (the matches are dropped and logged, and the
  cursor moves on).
- A service sink is called `binding[method](event, context)` and is handed no capability: unlike
  a config watcher's sink, it gets no `WatcherBoard`, because whoever set the wake isn't the board's
  own code. The receiver binds the board itself (the app does), as the seat.

### Keys, revisions, idempotence

A wake's key is its caller's choice (1 to 64 of `a-z0-9._/-`), unique per principal,
so the app's seats share one namespace and the app with no profile can list and remove them all.
`POST /wakes` is an upsert:

- the same key with the same content is no change (`changed: false`): applying a seat doc's
  revision twice is one wake;
- `revision` (an integer, the seat doc's revision) orders applies: one older than the stored
  revision changes nothing and says `stale: true`; the same revision with other content is 409
  `revision_conflict`; a newer one replaces it. With no revision, the last write wins;
- a change keeps the wake's cursor: no gap, and nothing replayed. A new wake starts at the head: it sees what comes after.

Removing one deletes its cursor and clears what its Mailbox still holds; removing a key that isn't
there is `removed: false`. `GET /wakes` lists the caller's principal's wakes
(every one, for a caller with manage at `*`). Limits: 256 per principal, 16 rules each.

## Rules

A rule is data the seat doc holds. Each is matched on the event's own facets (what the log wrote
with it), never on tables as they are now, except `assigned`, which reads the task as that event
left it (`task_views` at the event's position):

| Rule | Matches | As a filter |
| --- | --- | --- |
| `'mention'` | a message posted that mentions it, or edited to mention it | `--mentions`, by actor ID and handle |
| `'follow'` | events by others in threads and doc discussions it follows, or that mention it | `--for` itself |
| `'assigned'` | any event on a task that's its (assigned to it, or claimed by it), or in its thread; one that takes the task from it (assigned away, released, expired); and the answer to a hold it placed | the task's `for` and `claim`, as of the event (and just before); `task.unblocked`'s `holder` |
| `{ ready: <channel> }` | a task in the channel (or subtree, `work/`) that just became ready, unassigned or assigned to it | `board.task=ready` after, not before |
| `'dm'` (or `{ dm: true }`) | everything in `dm/<profile>` and its subtree | the channel; needs a profile |
| `{ docs: <channel> }` | a doc made, edited, moved, or deleted in the channel (or subtree) | `doc.*` events there, and a doc root's `message.deleted` |
| `'schedules'` | a message its own schedule posted | `--by` itself, with a schedule |
| `{ tail: <expr> }` | what a tail matches, `me` being the wake's caller | the protocol's watcher filters |

Edges (§4.5) are what the reconciler adds with these: `consults` widens nothing new (the
consulted seat's `mention` already covers it), `escalates_to` is a `tail` rule on the target.

## An answer to a hold

A seat that needs the principal's say parks on its task: it blocks the task with its claim
(`POST /tasks/:id/block` with its `epoch` and `token`), and the principal approves or declines
from the inbox (`POST /tasks/:id/unblock` with `decision`, design/cross-principal-tasks.md). The
block drops the claim, so the answer's task view names neither the seat nor its claim. So
`task.unblocked`'s payload carries `holder`, the actor that placed the hold, beside `by`,
`decision`, and `note` (agreed with identity, who added the event), and `assigned` matches it for
the holder. The parked seat wakes with the decision in `event.payload`; no other seat does.

## Delivery

After each write commits, the Ledger hands each wake's matches to its Mailbox
(`<board>:wake:<principal>/<key>`), in order, once each, and moves its cursor (`wake:…` in the
outbox, which also keeps those events hot from archival). One event that several rules match is
one delivery naming them all. The Mailbox is the config watchers' own: per-thread FIFO, threads in
parallel, a 5-minute lease, 1 s doubling to 30 s after an error, a failure recorded after 5 tries
and the thread going on.

It's at-least-once: a crash between a hand-off and its cursor hands the same matches again (the
Mailbox takes each match ID once while it holds it), and a retry repeats a delivery. The receiver
dedupes on `(wake, event.cursor)`, as the Factory's wake queue does.

The sink gets:

```ts
event:   { cursor, type, createdAt, payload, message?, actor? }   // as the wake's caller sees it: the
         // message view carries its mentions, labels, and its task as of that event
context: { board, wake, principal, actor, rules: ['mention', 'follow'], match, attempt }
```

## What it doesn't do (yet)

- No URL sinks for wakes: a URL a registrant gives is egress the deployment didn't
  choose. A deployment could declare URL sinks by name the same way later.
- Delivery state (pending, failed) isn't in `GET /wakes`: the Mailbox holds it, and the
  Ledger answers without waiting on another object. `Mailbox.status()` has it.
- Matching runs in the Ledger after each write, per wake, over the new events: fine for an org's
  dozens of seats; a board with thousands of wakes would want an index by rule.
