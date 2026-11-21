# Docs on a board: a design

Boards covers chat (threads in channels) and issues (tasks). This section adds the third piece of a
team's stack, docs, the way tasks were added: not as a new kind of thing, but as a thread that does
more. **A task is a thread with a state. A doc is a thread with a body.**

Status: proposed, with its open questions decided (§14). Nothing here is built. Section numbers
refer to this document.

## 0. Summary

- A doc is a thread whose root holds a long, structured Markdown body, edited in place many times.
  Its replies are its comments. Its channel is its folder. Its labels are its properties.
- One side table, `docs`, keyed by the root, as `tasks` is. One reserved label, `board.doc`.
  Three hooks, as tasks use.
- Edits address **sections** (by heading) and are checked per section, so two agents editing
  different sections never conflict, and an agent never rewrites a whole document to change a
  paragraph.
- The log stores an edit as the sections it changed, not the whole body three times, with a
  snapshot every so often, so a doc edited a thousand times stays small.
- Docs are in the same log as chat and tasks: watchers wake on doc changes, threads and docs link
  both ways, and grants on `docs/` work like grants anywhere.
- Notion and Markdown files in a GitHub repo sync through `SyncProvider`, like Slack and Linear.
- Not in scope: real-time co-editing, blocks and databases, a rich editor (§12).

## 1. Why a board needs docs

People keep docs so knowledge outlives the conversation that produced it. Agents need that more
than people do: they remember nothing between threads. Today an agent on a board has two places
for durable knowledge, and both are wrong for it:

- **Threads.** Append-only conversation. A decision lands in reply 40; the next agent re-derives
  it or never finds it.
- **A repo.** `AGENTS.md` works for code, and for nothing else: runbooks, specs, decisions,
  anything a person outside engineering edits.

The Factory shows the gap. Its feedback skill posts lessons as threads in `project-factory/rsi`.
They accumulate; nothing folds them into one current description of how the factory works.

What a board can offer that a docs tool can't is **the same log**. A spec edit is an event like a
message or a claim:

- a watcher on `docs/specs/` wakes the agents implementing a spec when it changes;
- a doc links the thread that decided it, and the thread shows the doc it changed (backlinks);
- a task can wait on a doc, and an edit can close a task;
- a grant on `docs/runbooks/` is a grant like any other, and `x-board-can` narrows it.

Syncing Notion alone would bring the documents without any of that.

## 2. The model

### 2.1 A doc is a thread with a body

| Doc | On the board |
| --- | --- |
| the document | a thread's root message, `text` holding the body |
| version | the root's `revision` (already the seq of its last edit) |
| history | `doc.edited` and `doc.snapshot` events (§4) |
| comments | replies; a comment on a section carries `board.doc.section=<key>` (§3.5) |
| folder | the channel (`docs/runbooks`); channels are already paths |
| properties | labels (`status=draft`, `owner=ada`) |
| a "database view" | `GET /threads?channel=docs/specs/&label=status=review` |
| permissions | grants on channel patterns |
| who changed what | `by` on each edit, as on every write |

### 2.2 The docs table

The way `tasks` holds what makes a thread a task, `docs` holds what makes it a doc:

```sql
create table docs (
  root      integer primary key,   -- the thread's root message
  channel   text not null,
  slug      text not null,         -- unique in its channel: docs/runbooks + deploy
  title     text not null,         -- the body's first H1, or the slug
  size      integer not null,      -- bytes of the body
  sections  text not null,         -- JSON: [{ key, title, level, hash, changed, subtree }]
  snapshot  integer not null,      -- seq of the latest doc.snapshot
  unique (channel, slug)
) strict;
```

Each section keeps two revisions (§2.4): `changed`, when its own text last changed, and `subtree`,
when it or anything under it last changed. They are the whole of §3.2's conflict check. The root's view gains a `doc` field, as a task root gains `task`:

```ts
doc: { path: 'docs/runbooks/deploy', title: 'Deploy', revision: '812', size: 18342,
       sections: [{ key: 'rollback', title: 'Rollback', level: 2, changed: '799' }, ...] }
```

### 2.3 Identity and paths

A doc's **path** is `<channel>/<slug>`. Its **ID** is its root's message ID and never changes, so
links survive a rename or a move (§6). `board.doc` (reserved, like `board.task`) marks the root, so
every existing filter finds docs: `?label=board.doc`.

### 2.4 The body and its sections

The body is Markdown, at most `DOC_BODY_MAX` (512 KiB; a message stays at 10,000 characters). Its
**sections** come from its ATX headings:

- the text before the first heading is the section `""` (the preamble);
- every heading level counts, H1 to H6, and sections nest: a section's **subtree** runs to the next
  heading of the same or a higher level, and its **own text** runs only to its first subheading;
  so `Deploy` (H2) owns its intro paragraph, and `Rollback` and `Canary` (H3) are inside it;
- a section's **key** is its heading path, slugged: `rollback`, or `deploy/rollback` under an H2
  `Deploy`; a repeated key gets `-2`, `-3` in order;
- headings inside code fences don't count.

Sections are what edits address, what comments anchor to, and what the log stores (§4). Views
show the outline to H3 by default (`?depth=` for more); edits and comments may target any level.

## 3. Writes

Each is an `op` in `src/ledger/docs.ts`, one transaction, as every write is.

### 3.1 `createDoc`

`POST /docs { channel, slug, body?, from?, labels?, id? }` → 201 `{ message }`. It posts the root through
`postMessage` (so mentions, terms, sync targets, and the client-ID replay all hold), writes the
`docs` row, sets `board.doc`, and appends `doc.created` and a first `doc.snapshot`. A taken
slug is 409 `slug_taken`. It needs `post` and `edit` in the channel.

**From a template.** With `from: <doc id>` instead of `body`, the new doc starts as a copy of that
doc's body at its current revision (the caller needs `read` on it):

- any doc can be a source; a team marks its templates with an ordinary label (`template=true`) or
  keeps them in a channel (`docs/templates/`), so finding templates is a filter, not a feature;
- the source's labels come too, except `template`, and `labels` in the request overrides them;
- three placeholders are filled at creation: `{{title}}` (the new doc's title, from its slug when
  the body names none), `{{author}}` (the creator's name), and `{{date}}` (today, `YYYY-MM-DD`);
  anything else in braces is left for the author or agent to fill;
- the new doc records its source as the reserved label `board.doc.from=<id>`, so
  `?label=board.doc.from=<id>` lists every doc made from a template, and the template's backlinks
  include them (§6);
- comments aren't copied.

### 3.2 `editDoc`: section edits, checked per section

```ts
POST /docs/:id/edit
{ revision: string,                       // the revision the editor read
  edits: Array<
    | { section: string, text: string }   // replace a section's content (its heading stays)
    | { after: string, text: string }     // insert a new section after one ("" = at the top)
    | { remove: string }                  // remove a section
  > | { body: string, merge?: boolean, base?: string } } // or the whole body (§3.2, merging)
```

The check, per section, against `docs.sections[].changed`:

- A section edit replaces that section's **own text** (its subsections stay), and is refused (409
  `section_conflict`, naming the section and its current revision) only if that section's own text
  changed after `revision` (`changed`). Edits to any other section since then, its own subsections
  included, don't matter: the edit applies to the current body.
- An edit that replaces a section **with everything under it** (`{ section, text, subtree: true }`)
  is refused if anything in that subtree changed after `revision` (`subtree`). Removing a section
  removes its subtree and checks the same way.
- So, under `Deploy` with `Rollback` and `Canary` inside it: edits to `Rollback` and `Canary` both
  land; an edit to `Deploy`'s intro and one to `Rollback` both land; a rewrite of all of `Deploy`
  conflicts with an edit to `Rollback` made since the revision it read.
- A whole-body edit is refused if **any** section changed after `revision` (today's
  `revision_conflict`), unless `merge: true`. Then the board three-way merges by section: a base,
  the editor's body, and the current body. A section changed on one side only takes that side; a
  section changed differently on both is a conflict, and the answer names every conflicting
  section. Nothing is half-applied.
- The base is the body at `revision` (§4.2) for an editor that read the doc from the board, or the
  text in `base` for one that started from a copy kept elsewhere (a file in a repo, a local editor)
  and holds no board revision. A `base` text is split into sections and merged against as given:
  the board doesn't assume it equals any revision, so a stale or slightly different base can only
  produce more conflicts, never drop an edit. One of `revision` and `base` is required.

This is optimistic concurrency at the granularity agents work at. Two agents editing `Rollback`
and `Monitoring` at once both land. Two editing `Rollback` at once get exactly one winner, as two
claims do.

**Who may edit.** Editing a message today is its author's alone (`own(ctx, id, 'edit')`). A doc is
shared, so `editDoc` takes a new permission, `edit`, in the doc's channel (§8). Replying to a doc
(commenting) stays `post`, so "anyone can comment, the team edits" is two grants. Someone without
`edit` can still propose a change (§3.6). This is the one place docs change an existing rule, and
only for doc roots: the `edit` op on a doc root answers 400 `use_edit_doc`, and editing any other
message stays its author's.

### 3.3 `moveDoc`

`POST /docs/:id/move { channel?, slug? }`. It changes the path, not the ID. It needs `edit` in both
channels. Links by ID keep working; links by path resolve through the new path (§6).

### 3.4 Delete

`delete` on the root tombstones the doc like any root: its `docs` row goes, its history stays in
the log, its replies stay as they are.

### 3.5 Comments

A comment is a reply. A comment on a section is a reply carrying `board.doc.section=<key>`, set by
`POST /messages { re, text, section }` (the board sets the reserved label; nobody else may). When
a section is renamed or removed, its comments keep the key and the view marks them `detached`.
Resolving a comment is a label (`resolved=true`) or a reaction, as the team likes.

### 3.6 Proposals

A caller with `post` but not `edit` in the doc's channel sends the same `editDoc` body with
`propose: true`. Nothing in the doc changes. Instead the board makes a **task** in the doc's thread
(the thread is a doc, and the proposal is a reply that's a task, as any reply can be adopted as one):

- its text says what changes, in a few lines, and `board.doc.proposal` carries the edit and the
  `revision` (or `base`) it was proposed against;
- completing the task applies the edit, and needs `edit` in the channel; the edit is checked as any
  `editDoc` is (§3.2), against the revision it was proposed at, so a proposal overtaken by later
  edits to the same sections fails with `section_conflict` and stays open for its author to redo;
- failing or canceling the task drops the proposal; the edit never lands.

Approval is therefore a task like any other: it shows in `boards tasks`, a watcher can wake a
reviewer, and an agent proposes while a person approves without a review system of its own.
Proposing with `edit` is allowed too, for a change its author wants reviewed.

## 4. The log

### 4.1 Events

| Event | Payload | Facets |
| --- | --- | --- |
| `doc.created` | `{ id, path, title, by }` | the root's |
| `doc.edited` | `{ id, revision, base, changes: [{ section, op, text? }], by }` | the root's (§4.3) |
| `doc.moved` | `{ id, from, to, by }` | the root's |
| `doc.snapshot` | `{ id, revision, body }` | none; hidden from the feed, like other bookkeeping |

`doc.edited` carries only the sections that changed: the replacement text of each, an insert's
text, a removal's key. A one-paragraph fix to an 18 KB doc writes a few hundred bytes, not 54 KB
(today's `message.edited` stores the body in its payload and in both facets). An edit whose changes
pass 64 KiB stores `{ large: true }` with the section keys, and a `doc.snapshot` follows it.

### 4.2 Snapshots and history

A `doc.snapshot` follows the creation, every 64 edits, and any large edit. The body at revision
*r* is the latest snapshot at or before *r*, plus the `doc.edited` changes after it, in order. That
is what `GET /docs/:id?revision=` reads, what `merge` uses as its base, and what history and diffs
show. An old snapshot or edit that archival has sealed into a segment comes back through the
Ledger's existing fault-and-rerun path (Archival tiers, in the docs site's architecture section),
like any sealed event.

### 4.3 Facets: what tails and watchers match

A message's facet holds its full text and terms, which is right for a message and wrong for a 512
KiB body. A doc root's facet holds its **title and its changed sections' headings** as `text`, and
its labels and mentions as terms. So:

- `boards tail docs/` shows every doc change;
- a watcher on `docs/specs/ --label status=approved` wakes when an approved spec changes;
- a watcher on `docs/ --text Rollback` wakes when a section titled Rollback changes.

Full-text search over bodies goes through the messages' text index (and the planned full-text
search), not through facets.

## 5. Reads

| Route | Answer |
| --- | --- |
| `GET /docs/:id` | the root view with `doc`, and `body` |
| `GET /docs/:id?section=rollback` | that section only, with its `changed` revision |
| `GET /docs/:id?revision=799` | the body as it was |
| `GET /docs/:id/history?after=&limit=` | `doc.edited` events: who, when, which sections |
| `GET /docs/:id/diff?from=&to=` | the changed sections, before and after |
| `GET /docs/:id/backlinks` | threads and docs that link it (§6) |
| `GET /docs?path=docs/runbooks/deploy` | the doc at a path |
| `GET /threads?label=board.doc&channel=docs/` | docs as threads, with every existing filter |

A section read is what an agent should do by default: read the outline from `doc.sections`, then
the section it needs.

## 6. Links and backlinks

- A link to a doc is `[[docs/runbooks/deploy]]`, `[[docs/runbooks/deploy#rollback]]`, or the
  doc's board URL. At write time the board resolves each to the doc's ID and records it.
- Every write (message, reply, doc edit) indexes the docs and messages it links as terms `k:<id>`,
  beside the `l:` label and `^` file terms `writeTerms` already keeps. Backlinks are a terms
  lookup, and `?links=<id>` becomes a thread filter.
- Because a link records the ID, a move doesn't break it; views render the doc's current path.

## 7. Size and storage

- The body lives in `messages.text`, so every read path, permission check, and sync path that
  knows a root knows a doc. `text_lower` doubles it: a 512 KiB doc is about 1 MiB of row.
- The log grows by edits, not by body size (§4.1). Snapshots every 64 edits bound replay.
- Archival needs no new tier. A doc unedited past the cold horizon goes cold like any thread, its
  outline kept in the summary row, and comes back on its next read or edit. A doc with pending
  sync stays hot, as synced threads do.

## 8. Access

One new permission, `edit`, beside `read`, `post`, `react`, `label`, `sync`, and `manage` in
`PERMISSIONS`. Like every permission that addresses an existing message, it implies `read`; `all`
includes it.

| Doing | Needs, in the doc's channel |
| --- | --- |
| read a doc, its history, its backlinks | `read` |
| comment (reply), propose a change (§3.6) | `post` |
| create a doc | `post` and `edit` |
| edit, or complete a proposal | `edit` |
| move | `edit` in both channels |
| set its labels | `label` |

The starting grants need no change: every person has `all` (`g1`), so people can edit docs out of
the box, and Workers have `read, post, react, label, sync` (`g2`), so a Worker or agent proposes
until a grant gives it `edit`. Narrowed tokens hold:
`x-board-can: docs/runbooks/=read,post,edit` can edit runbooks and nothing else, and
`docs/=read,post` can comment and propose anywhere under `docs/` but edit nothing.

## 9. Interfaces

- **HTTP:** the routes in §3 and §5, in `src/protocol/docs.ts`, with their zod schemas, so the
  Gateway, the `Board` capability, and `openapi.json` share them.
- **Binding and Cap'n Web:** `board.docs.create`, `read`, `edit`, `move`, `history`, and
  `backlinks`, on `Board`, checked against the same route schemas.
- **MCP:** `doc_read` (outline, section, or whole), `doc_edit` (section edits with `revision`;
  `propose: true` without `edit`), `doc_create`, and `doc_search`. `run_code` gets `BOARD.docs`.
- **CLI:** `boards doc read <path|id> [--section k]`, `boards doc edit <path> --section k` (the new
  text from stdin, the revision read first and sent back), `boards doc history`, `boards doc diff`.
- **Feed:** `doc.*` events in `GET /events` and `boards tail`, as `task.*` are.

## 10. Sync

Both providers implement `SyncProvider`. Inbound runs through the sync's Inbox; outbound through
its courier, with receipts as the retry guard.

- **Markdown in a GitHub repo** (`docs/**/*.md` ↔ `docs/...` channels). This is the natural first
  one: the body is already Markdown, a push webhook gives each changed file, and a section edit
  becomes a commit by the app. Inbound, a push imports the file's new body as a whole-body edit
  with `merge: true`, its `base` the file's contents before the push. A conflict leaves both versions
  and opens a task on the doc.
- **Notion.** A page is a doc; a Notion comment is a reply. Notion keeps blocks, not Markdown, so
  round-tripping section edits to blocks is the hard part. Version 1 is one-way, Notion to the
  board: the doc mirrors the page, with `board.doc.source=notion`, and `editDoc` on it answers
  409 `doc_mirrored`. Version 2 maps headings to heading blocks and writes a section edit back as
  the blocks between two headings.

## 11. The Factory as the first user

The feedback skill changes from posting a thread per lesson to keeping one doc,
`project-factory/factory/how-we-work`, with a section per area (access, reproducing bugs, pull
requests, check-ins). An agent that learns something reads that section, and edits it with the
revision it read. A conflicting edit means another agent just changed that section: it reads
again and folds the two together. A watcher on the doc tells the team when it changes. The
`project-factory/rsi` channel stays for discussion; the doc is where the result lands.

## 12. What this doesn't do

- **Real-time co-editing** (presence, cursors, character-level merging). It's the most expensive part
  of a docs product and the least useful to agents, which do better with explicit, checked section
  edits. If people need it, it layers on top: a Durable Object per open doc running a CRDT (Yjs) for
  the people in it, writing checkpoints to the board as `editDoc` calls with the revision it
  started from. The board's model doesn't change.
- **Blocks, databases, and embeds.** Labels and thread filters are the database for agents. People
  who want rich pages keep them in Notion and sync.
- **A docs UI.** Boards has no web UI yet for anything. A reader (rendered Markdown, outline,
  history, backlinks) is worth building, and it belongs with the board's UI, not here.

## 13. Build plan

| Step | Ships | Done when |
| --- | --- | --- |
| 1 | `docs` table, `board.doc`, the `edit` permission, `createDoc`, `editDoc` (section and whole-body, with merge), proposals as tasks, `doc.*` events, snapshots, reads at a revision | the workerd suite covers each conflict case, and breaking any of them fails a test; a property test of random concurrent section edits against a sequential model never diverges; an 18 KB doc edited 1,000 times grows the log by edits, not by body size (measured) |
| 2 | sections in views, history, diffs, comments on sections, `k:` link terms and backlinks, `moveDoc` | backlinks survive a move; `archive-check.mjs` covers docs (cold docs read and edit the same) |
| 3 | the `Board` capability, MCP tools, CLI commands, the docs site's guide | the Factory's feedback skill keeps its doc, verified live |
| 4 | GitHub Markdown sync, then Notion (one-way, then two-way) | live, against a real repo and a real workspace |

The conformance kit is unaffected: docs are new routes, and an `edit` on a non-doc message behaves
exactly as before.

## 14. Decisions

- **Section granularity** (decided). Every heading level is a section. A section edit replaces its
  own text and checks only that; a subtree edit checks everything under it. Each section keeps
  `changed` and `subtree` revisions. Views show the outline to H3 by default. See §2.4 and §3.2.
- **Merge base** (decided). A whole-body merge takes either the `revision` the editor read or a
  `base` text it started from; a `base` is merged against as given, so it can add conflicts but
  never lose an edit. The GitHub Markdown sync uses `base` (§10). See §3.2.
- **Edit permission** (decided). Editing a doc takes a new `edit` permission (implies `read`,
  included in `all`); commenting stays `post`. A caller without `edit` proposes, and the proposal
  is a task on the doc whose completion applies the edit. People can edit out of the box; Workers
  propose until granted `edit`. See §3.2, §3.6, and §8.
- **Templates** (decided). `createDoc { from }` copies any doc's body and labels (not `template`),
  fills `{{title}}`, `{{author}}`, and `{{date}}`, and records `board.doc.from`. A template is an
  ordinary doc, marked by a label or a channel. No variables language. See §3.1.
