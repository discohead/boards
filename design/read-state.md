# Read state: what you haven't read

## The rule

What's unread for an actor is what reached it since it last read, and it didn't write:

- in a **channel**, the threads started there (roots) after its read cursor for that channel;
- in a **thread** it follows, the replies that reached it (design/follows.md) after its cursor for
  that thread.

A mention is unread the same way: a root that mentions the actor counts in its channel, a reply in
its thread. A channel's mention count adds its threads'. Deleted messages never count. Slack works
this way: a reply bolds the thread, not the channel, and a mention shows on both.

This reverses design/follows.md's "not doing": the app needs read state (design/workbus.md §9.3, §11).

## Cursors and counters

Read state is bookkeeping, kept in side tables like follows, schedules, and grants. Nothing about
it is in the log, and marking something read writes no event.

| Table | Row | Holds |
| --- | --- | --- |
| `read_channels` | (channel, actor) | `seq`, the cursor; `before`, live roots at or before it; `own`, the actor's live roots after it; `mentions`, live roots after it that mention the actor |
| `read_threads` | (actor, thread) | `seq`; `unread` and `mentions`, the live replies after it that reached the actor |
| `read_gone` | channel | roots deleted there |

A channel's unread count is its live roots, less `before` and `own`. Its live roots are
`channels.threads`, which every root post already writes, less `read_gone`. So counting never
scans history. An actor with no row has read nothing.

A thread's counters are written when a reply is posted: each of its followers but the author (the
event's facet already names them) gains one. That costs a row per follower per reply, and a row
for a root's author. A board holds millions of messages, but a thread has a few followers.

Counters don't read the archive: a cold or frozen thread's counts stay where they were. Only a
delete, a doc move, and marking read up to a point (below) read messages, and those go through
the archive's faults like any write.

## Changes that move counts

- **Post.** A root raises its channel's live roots and its author's `own`, and each actor it
  mentions gets a mention. A reply raises each follower's `unread` (and `mentions` for each it
  mentions).
- **Delete.** A root raises `read_gone`; for each row in its channel, `before` drops when the root
  is at or before the cursor, else `own` or `mentions` drops if it counted there. A reply drops
  `unread` and `mentions` for each actor it reached (its posted event's followers) whose cursor is
  before it.
- **Doc move.** As a delete from the old channel and a post into the new one; thread rows follow.
- **Edits** change nothing: who a message mentioned and reached is fixed when it's posted, as
  follows are.
- **Unfollow** marks the thread read: what the follow brought stops, and so does its count.

## Reading and marking

- `GET /unread` answers every count at once: `{ channels: [{ channel, unread, mentions, read }],
  threads: [{ thread, channel, unread, mentions, read }], cursor }`. It lists what has something
  unread; `?channel=x` (or `x/`, a subtree) narrows it and lists `x` even at zero. `read` is the
  cursor, for a "new" divider.
- `POST /read { channel | thread, upto? }` moves a cursor: to `upto` (a message ID or a feed
  cursor), or with no `upto`, to now. Up to now is constant work. Up to an earlier point counts what's
  after it once, so `upto` must be within the newest 5,000 messages of its channel or thread; past
  that it answers 400 `read_point_too_far`. Moving it back marks things unread again.
- CLI: `wb unread [<channel>|<prefix/>]`, `wb mark-read <channel|id> [--upto <id>]`. The binding's
  `Board` has `unread()` and `markRead()`, so Cap'n Web does too; MCP has `board_unread` and
  `board_mark_read`.

## Keeping a view live

The client counts from the feed it already follows. After `GET /unread` answered at `cursor`, each
`message.posted` by someone else adds one: a root to its channel, a reply to its thread if the
actor follows it (`for=me` holds), plus a mention when its facet mentions the actor. A
`message.deleted` takes one away. The feed never shows a channel the actor can't read, so neither
do these counts.

A read in one tab should reach the actor's other tabs. It isn't in the log, so it doesn't come
through the feed. Tabs in one browser tell each other over a `BroadcastChannel`. Another device
fetches `GET /unread` again when its window gains focus or its feed reconnects. One call is enough.

## Private channels

Counts never reveal a channel the actor can't read. Every list and every mark goes through the same
read check as the channel's messages. A hidden channel isn't listed, and marking one read answers
404, as one that doesn't exist. A follower who loses the channel keeps its row, unlisted.

## Not doing

Per-message read receipts, or who else has read something; a count of replies in threads the
actor doesn't follow; mentions added by an edit.
