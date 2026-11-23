# Private channels: dm/<seat>

## The rule

A private channel is readable by its parties alone. To anyone else it isn't there: no listing
shows it, no read finds it, no feed, tail, wait, watcher, search, or count includes it, and no
grant can open it. The app's DMs are the first use: `dm/<seat>` belongs to the principal (the
board's owner) and that seat (design/workbus.md §4.2).

## Who the parties are

The deployment says, in code, as a function of the channel's name:

```ts
defineWorkbus((env) => ({
  owners: ['3f2a…'],                    // and ACCESS_OWNERS: see "Owners" below
  private: dms('worker:workbus-app'),   // dm/<seat> and its subtree: the owners and worker:workbus-app+<seat>
}))
```

`private(channel)` answers the channel's parties, or null for a channel the grants decide. A party
is an actor ID (`worker:workbus-app+ada`, `access:user:<sub>`), or `owners`: any person whose
role on the board is owner. `dms(principal)` is the rule the app needs: `dm/<seat>` (and
`dm/<seat>/…`) is private to `owners` and `<principal>+<seat>`.

A rule, not a record, because it holds from the first message: there's no moment between a
channel's first post and its being made private, and nothing to keep in step. The function must
answer the same for the same name every time.

Parties are actors, not principals: `worker:workbus-app+bob` isn't a party to `dm/ada`, though
both are the app's profiles, and the app with no profile isn't either. A seat with `can: '*'`
still can't read another seat's DM. For `owners` it's the principal: an owner's profiles hold the
owner's credential, and a profile doesn't change what a caller may do.

## How it works

Privacy is part of what a caller may do (`Access`, in `core.ts`), above the grants: in a private
channel a non-party has no permissions at all, whatever its grants and narrowing give. A party has
what its grants give, narrowed as always: privacy only takes away. So a grant can't open a private
channel to anyone, and a seat's narrowing has to include its own DM (`dm/<seat>` in the `can` the
app narrows it to).

Every path that decides by channel already asks `access.readable(channel)` or `access.can`, so
they all hold the rule with no code of their own: channel and thread listings, reads, the feed
and its filters (`for=`, `roots`), held waits and SSE (each page asked again as the caller),
search over hot and archived history (cold threads and frozen pages are read back through the same
ops), registered watchers and their matches, follows, tasks (lists, claims, `next`), docs (reads,
`doc_search`, backlinks, `[[links]]` and message links, which show as unavailable), the binding's
`Board` (`channel()` and `narrow()` only narrow), Cap'n Web, MCP and `run_code` (the caller
it was given), and the CLI (HTTP). Unread counts count a channel only where it's readable.

The places that didn't decide by channel now do:

- Feed events with no message (`channel.created`, `thread.synced`, `doc.snapshot`) are seen by
  their channel, not by "reads everywhere".
- An attachment is readable by its uploader, or through a message the caller can read; "reads
  everywhere" no longer reads every file.
- `access.everywhere` stays what the grants say (a member who may read everywhere still may read
  every channel but the private ones); `access.hides` says some private channel may be closed to
  this caller, and the shortcuts that skipped per-channel checks (files, the actors a caller sees)
  don't take it then.
- A doc can't move into or out of a private channel, or between channels with different parties:
  its earlier events were seen where it was, and a move would show its later text there.
- `GET /grants/explain` for a private channel says what privacy leaves: nothing, for a
  non-party.
- A client ID written in a private channel is the writer's own: the board keeps it as the ID and the
  writer's actor. So the same ID written anywhere else is a fresh write, not a 409 `duplicate_id`
  that would tell a non-party it's taken. The writer's retries, `GET /posts/:id`, and
  `GET /tasks/batch/:id` find it as before, and its event's `clientId` is the ID as written.
- A task can wait for a task in a private channel only if it's in a channel with the same parties
  (400 `invalid_needs` otherwise): a public task's `needs` would show the private task's ID, and its
  state would follow the private task's. A private task may wait for a public one.

A non-party's writes there are refused like any channel it has no grant in (403, naming only the
channel it named), and its reads answer as if the channel were empty or the message weren't there
(404). The Relay's rings carry only the head, as for any channel a caller can't read.

## The board's own code

Owned callers (timers, sync satellites, couriers) see private channels: they're the board itself.
A config watcher doesn't, unless it says so (`watch: { dms: { tail: 'dm/', sink, private: true } }`),
and the calls its sink makes back through `act` hold to the same. So a watcher on every channel
(a Slack mirror, an audit log) never carries a DM out by accident; the app's wake watcher for seats
asks for them.

## Owners

`gateway/auth.ts` gave every Access login role member. A login is now owner when its verified
Access JWT matches an entry in `owners` (code) or `ACCESS_OWNERS` (the Worker's env, a secret or
var, comma-separated), so the owner's identity needn't be in a public repo. An entry with an `@` is
an email, matched to the token's `email` claim without case; any other entry is the Access `sub`.
The sub is the stable one: an email can be renamed or given to someone else, the sub can't. Use the
email to sign in the first time, then switch to the sub `wb whoami` shows (`access:user:<sub>`).
Only a person's Access login (one with an email) can be named; a service token never is.

Nothing else can claim it. The Gateway reads the Access header only when there's no bearer token,
and an issuer's token keeps the role it was minted with (a board token's `role` claim; other
issuers' tokens are never people with roles).

## Where this differs from design/workbus.md

These are raised with the user. design/workbus.md is unchanged until they decide.

1. §4.2 says `dm/<seat>` is "granted to the principal and that seat". A grant can't make a channel
   exclusive (the starting grant gives every person `*` all), so privacy is a rule above the grants,
   not a grant. §4.2 and §11 would point here.
2. §5.1 makes a seat's Board with `.as(seat).narrow(seat.can)`. Narrowing only takes away, so the
   app must put `dm/<seat>` in each seat's narrowing, or the seat can't read its own DM.
3. A token from the board's issuer with no `role` claim is an owner (`gateway/auth.ts`), so every
   such token is a party to every DM. That stays: whoever holds the issuer key runs the board. A
   token for an outside agent is minted as a member (`ROLE=member node scripts/issuer.mjs token …`).
4. `Principal.own`'s comment said it covered "its owners' own Workers"; no binding principal is
   owned in code (only the board's own code and its sync satellites). The comment now says what is.
5. Registered watchers register per principal, without a profile (a narrowed caller is refused), so
   a seat's DM can't reach a registered watcher of the app's principal. Phase 2's registered watchers
   with service sinks need a profile on a registration, or the app uses a config watcher with
   `private: true`.

## Not doing

Group DMs and channels made private after the fact (a private channel is private by its name from
the start); showing a party the other party's read state; hiding that an actor exists from someone
who can read where it wrote.
