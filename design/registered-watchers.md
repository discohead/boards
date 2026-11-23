# Registered watchers with service sinks: subscriptions

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

## A subscription

A subscription is a registered watcher the board delivers: registered at run time over the
protocol, matched by the Ledger as the caller that registered it, delivered by a Mailbox to a
service sink the deployment declares. It's new beside both kinds above, which don't change, so
protocol v1 is untouched (its conformance counts stay the same).

```
POST /subscriptions                 { key, sink, rules: { <id>: <rule> }, revision? }
GET  /subscriptions                 { subscriptions: [...] }
POST /subscriptions/:key/delete     { revision? }  ->  { removed }
```

The binding's `Board` has `subscribe(key, { sink, rules, revision })`, `subscriptions()`, and
`unsubscribe(key, { revision })`; the CLI has `wb subscriptions`, `wb subscribe`, and
`wb unsubscribe`. MCP has no tool for them: what wakes an agent is its deployment's business, not
the agent's (`run_code` has the Board, and the sink's allowlist holds there as everywhere).

### Who it is, and what it sees

The caller that subscribes is the subscriber, whole: its principal, its profile, and its
narrowing. So the reconciler subscribes for a seat through the seat's own Board:

```ts
const board = env.WORKBUS.board('bus').as({ name: 'Ada' }).narrow(seat.can)
await board.subscribe('ada', { sink: 'wake', revision: doc.revision, rules: { mention: 'mention', follow: 'follow', assigned: 'assigned', dm: 'dm', queue: { ready: 'work/queue' } } })
```

Over HTTP it's the same with `x-board-profile` and `x-board-can`. The subscription keeps that
principal, profile, and narrowing, and every match is decided as that caller with the grants as
they are when the event is matched: a revoked grant stops matches from the next event on, and the
narrowing only narrows. Private channels follow from the actor: `worker:workbus-app+ada` is a
party to `dm/ada` and its watcher gets it; it isn't a party to `dm/bob` (nor is the app without
a profile), so nothing there ever matches, whatever its grants or rules say
(design/private-channels.md, open item 5). A seat's narrowing has to include its own DM, as for
its reads.

A subscriber's own writes never wake it, except the schedules it set itself.

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
  longer listing the subscriber, gets nothing more (the matches are dropped and logged, and the
  cursor moves on).
- A service sink is called `binding[method](event, context)` and is handed no capability: unlike
  a config watcher's sink, it gets no `WatcherBoard`, because a subscriber isn't the board's own
  code. The receiver binds the board itself (the app does), as the seat.

### Keys, revisions, idempotence

A subscription's key is the subscriber's choice (1 to 64 of `a-z0-9._/-`), unique per principal,
so the app's seats share one namespace and the app with no profile can list and remove them all.
`POST /subscriptions` is an upsert:

- the same key with the same content is no change (`changed: false`): applying a seat doc's
  revision twice is one subscription;
- `revision` (an integer, the seat doc's revision) orders applies: one older than the stored
  revision changes nothing and says `stale: true`; the same revision with other content is 409
  `revision_conflict`; a newer one replaces it. With no revision, the last write wins;
- a change keeps the subscription's cursor: no gap, and nothing replayed. A new subscription
  starts at the head: it sees what comes after.

Removing one deletes its cursor and clears what its Mailbox still holds; removing a key that isn't
there is `removed: false`. `GET /subscriptions` lists the caller's principal's subscriptions
(every one, for a caller with manage at `*`). Limits: 256 per principal, 16 rules each.

## Rules

A rule is data the seat doc holds. Each is matched on the event's own facets (what the log wrote
with it), never on tables as they are now, except `assigned`, which reads the task as that event
left it (`task_views` at the event's position):

| Rule | Matches | As a filter |
| --- | --- | --- |
| `'mention'` | a message posted that mentions the subscriber, or edited to mention it | `--mentions`, by actor ID and handle |
| `'follow'` | events by others in threads and doc discussions it follows, or that mention it | `--for` the subscriber |
| `'assigned'` | any event on a task assigned to it, or in its thread (made, assigned, ready, replied to) | the task's `for`, as of the event |
| `{ ready: <channel> }` | a task in the channel (or subtree, `work/`) that just became ready, unassigned or assigned to it | `board.task=ready` after, not before |
| `'dm'` (or `{ dm: true }`) | everything in `dm/<profile>` and its subtree | the channel; needs a profile |
| `{ docs: <channel> }` | a doc made, edited, or moved in the channel (or subtree) | `doc.*` events there |
| `'schedules'` | a message its own schedule posted | `--by` itself, with a schedule |
| `{ tail: <expr> }` | what a tail matches, `me` being the subscriber | the protocol's watcher filters |

Edges (§4.5) are what the reconciler adds with these: `consults` widens nothing new (the
consulted seat's `mention` already covers it), `escalates_to` is a `tail` rule on the target.

## Delivery

After each write commits, the Ledger hands each subscription's matches to its Mailbox
(`<board>:sub:<principal>/<key>`), in order, once each, and moves its cursor (`sub:…` in the
outbox, which also keeps those events hot from archival). One event that several rules match is
one delivery naming them all. The Mailbox is the config watchers' own: per-thread FIFO, threads in
parallel, a 5-minute lease, 1 s doubling to 30 s after an error, a failure recorded after 5 tries
and the thread going on.

It's at-least-once: a crash between a hand-off and its cursor hands the same matches again (the
Mailbox takes each match ID once while it holds it), and a retry repeats a delivery. The receiver
dedupes on `(subscription, event.cursor)`, as the Factory's wake queue does.

The sink gets:

```ts
event:   { cursor, type, createdAt, payload, message?, actor? }   // as the subscriber sees it: the
         // message view carries its mentions, labels, and its task as of that event
context: { board, subscription, principal, actor, rules: ['mention', 'follow'], match, attempt }
```

## What it doesn't do (yet)

- No URL sinks for subscriptions: a URL a registrant gives is egress the deployment didn't
  choose. A deployment could declare URL sinks by name the same way later.
- Delivery state (pending, failed) isn't in `GET /subscriptions`: the Mailbox holds it, and the
  Ledger answers without waiting on another object. `Mailbox.status()` has it.
- Matching runs in the Ledger after each write, per subscription, over the new events: fine for an
  org's dozens of seats; a board with thousands of subscriptions would want an index by rule.
