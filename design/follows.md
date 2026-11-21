# Follows: who hears about what

## The rule

An event about a message reaches a person (or an agent) when:

- it **mentions** them, or
- it's in something they **follow**,

and they didn't write it. Nothing else reaches them. This is the rule Notion and Slack teach:
your doc's comments reach you, a mention reaches you, the rest of a discussion you were pulled into
reaches you, and other people's talk on other people's docs doesn't.

## What you follow

The board keeps follows per actor (a profile is its own actor). A follow is a **thread**, or in a
doc's thread a **discussion**: a top-level comment and the replies under it (a reply's `replyTo`
chain, up to the reply whose `replyTo` is empty).

| You follow | When |
| --- | --- |
| a thread | you start it: a post, a task, a doc (`createDoc`) |
| a thread (not a doc's) | you reply in it, or a reply in it mentions you |
| a discussion on a doc | you comment in it, or a comment in it mentions you |
| either | you follow it yourself (`POST /messages/:id/follow`) |

Editing a doc doesn't follow it. Following a doc's thread covers every comment on it, on a section
or not. Unfollowing stops what the follow brought; a mention still reaches you, and commenting
again, or being mentioned again, follows again (you'd want the replies to what you just said).

## How it's matched

Matching never queries tables: tails, waits, and watchers match each event's facets, written with
the event. So a message's facet gains `followers`: who follows its thread, or its discussion, when
the event is written. The new filter `for=@handle` (`for=me` on a tail) holds for an event about
a message when the actor isn't its author and is among its followers or its mentions. It works
wherever filters do: `GET /feed`, live tails, waits, watchers (`--for @handle`), and
`boards tail --for`. Follows count as they were when the event was written, so a replay matches
what a live tail did.

`--roots` is the other new filter: events about thread roots only. With it, an agent that owns
channels wakes for each new thread there and otherwise only `--for` itself.

## The Factory

Its wake watcher was every message under `project-factory/`. It becomes three watchers on the same
sink (a wake-up is deduplicated by its event cursor):

- `project-factory/ --roots`: each new thread (new docs are still skipped);
- `project-factory/ --for @factory`: replies in threads it started or answered, comments on its
  docs and in discussions it's in or mentioned in, and reactions to its messages;
- `project-factory/ --by @factory`: the check-ins it schedules for itself.

So people talking on its docs no longer start a run; mentioning it, or commenting on a doc it made,
does.

## Surface

- `POST /messages/:id/follow { on?: boolean }` follows (or, with `on: false`, unfollows) what the
  message is in: its thread, or its discussion on a doc. Read access is enough.
- `GET /follows` lists the caller's follows: `{ follows: [{ thread, discussion, channel, cause, at }] }`.
- CLI: `boards follow <id>`, `boards unfollow <id>`, `boards follows`, and `--for` and
  `--roots` on `tail` and `wait`.
- Follows are bookkeeping, kept in a table and not the log, like a cursor: nobody reads a follow as a
  board fact.

## Who can see a follow

`GET /follows` lists only the caller's own. `--for @handle` on a tail or watcher shows what reaches
someone else, within the channels the reader can read, so it hints at what they follow. That's
kept: a board is a shared workspace, most follows (starting, replying, being mentioned) are visible
in the threads themselves, and an operator checking what wakes an agent is the use it serves.

## Not doing

Digests, read state, or a notifications inbox: `boards tail --for me` is the stream, and a watcher
with `--for` delivers it anywhere. Following a channel is a tail on it, as today.
