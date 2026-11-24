// The Ledger's tables. The log (events) is the truth; every other table is what folding it gives,
// written in the same transaction as the events that change it. Each index earns its place: rows
// written is what a write costs.

export const SCHEMA_VERSION = 1

export const DDL = [
  // The board log: every fact people read, in order. seq is gapless, and a message ID is its post's seq.
  'create table if not exists events (seq integer primary key, type text not null, thread integer, message integer, actor text, at integer not null, payload text not null, facets text not null) strict',
  'create table if not exists messages (id integer primary key, thread integer not null, thread_key text not null, platform_text integer not null default 0, channel text not null, re integer, reply_to integer, actor text not null, principal text not null, profile text, from_key text, origin text, text text not null, text_lower text not null, labels text not null default \'{}\', reactions text not null default \'{}\', attachments text, links text, schedule text, undelivered text, mentioned text, no_sync integer not null default 0, deleted integer not null default 0, blind integer not null default 0, imported_by text, version integer not null, revision integer not null, client_key text unique, created_at integer not null, edited_at integer) strict',
  'create index if not exists messages_thread on messages (thread, id)',
  'create index if not exists messages_channel on messages (channel, id)',
  // One row per root: what /threads lists, by latest activity.
  'create table if not exists threads (root integer primary key, channel text not null, replies integer not null default 0, last integer not null, archived text) strict',
  'create index if not exists threads_activity on threads (channel, last)',
  'create index if not exists threads_last on threads (last)',
  // Labels (k=v), mentions (@term), and files (^id), by message and its root: every filter's index.
  'create table if not exists terms (term text not null, message integer not null, root integer not null, primary key (term, message)) strict, without rowid',
  'create index if not exists terms_root on terms (root, term)',
  'create table if not exists channels (path text primary key, created integer not null, last integer not null, messages integer not null default 0, threads integer not null default 0) strict',
  'create table if not exists actors (id text primary key, principal text not null, profile text, kind text not null, handle text not null, handle_lc text not null, name text not null, avatar text, via text, platform text, verified integer not null default 0, seen integer not null) strict',
  'create index if not exists actors_handle on actors (handle_lc)',
  // A person's display name, set by them (PATCH /me): it wins over the name their token gives.
  'create table if not exists names (principal text primary key, name text not null, at integer not null) strict',
  // Actors an owner hid (#16): left out of GET /actors and mention settling; their history stays.
  'create table if not exists hidden_actors (actor text primary key, by text not null, at integer not null) strict',
  'create table if not exists tasks (root integer primary key, channel text not null, state text not null, owner text not null, by_actor text not null, for_actor text, epoch integer not null default 0, claim_actor text, claim_until integer, claim_hash text, hold_kind text, hold_reason text, result text, reason text, created integer not null) strict',
  'create index if not exists tasks_queue on tasks (state, channel, created)',
  'create table if not exists task_needs (task integer not null, needs integer not null, primary key (needs, task)) strict, without rowid',
  'create index if not exists task_needs_task on task_needs (task)',
  // Side facts: never in the board log.
  'create table if not exists grants (id text primary key, n integer not null, principals text not null, can text not null, by text not null, at integer not null, revoked integer not null default 0) strict',
  'create table if not exists schemas (id text primary key, name text not null, version integer not null, description text, definition text not null, by text not null, at integer not null) strict',
  'create table if not exists files (id text primary key, name text not null, type text not null, size integer not null, sha256 text, uploader text, at integer not null) strict',
  'create table if not exists schedules (id integer primary key, spec text not null, creator text not null, channel text not null, re integer, n integer not null default 0, next integer, state text not null, canceled text, last integer, at integer not null) strict',
  'create table if not exists registrations (owner text primary key, principal text not null, watch text not null, sync text, hash text not null, at integer not null) strict',
  'create table if not exists matches (id text primary key, owner text not null, watcher text not null, thread integer not null, seq integer not null, state text not null, lease text, until integer, attempts integer not null default 0, next_at integer not null, error text) strict',
  'create index if not exists matches_queue on matches (owner, state, thread, seq)',
  'create table if not exists sync_threads (thread integer not null, target text not null, cause text not null, kind text, external text, primary key (thread, target)) strict',
  'create index if not exists sync_threads_external on sync_threads (external)',
  'create table if not exists sync_copies (message integer not null, target text not null, external_thread text not null, external_message text not null, primary key (message, target)) strict',
  'create index if not exists sync_copies_external on sync_copies (external_thread, external_message)',
  'create table if not exists inbox (id text primary key, key text not null, thread text not null, channel text, event text not null, raw text, at integer not null, state text not null, lease text, until integer, attempts integer not null default 0, next_at integer not null) strict',
  'create index if not exists inbox_queue on inbox (key, state, thread, at)',
  'create table if not exists idempotency (key text primary key, result text not null, digest text, at integer not null) strict',
  'create table if not exists timers (kind text not null, ref text not null, due integer not null, primary key (kind, ref)) strict, without rowid',
  'create index if not exists timers_due on timers (due)',
  'create table if not exists outbox (destination text primary key, seq integer not null) strict',
  'create table if not exists segments (first integer primary key, last integer not null, key text not null, bytes integer not null, sha256 text not null, at integer not null) strict',
  'create table if not exists meta (key text primary key, value text not null) strict',
  // Archival (archive.ts). A segment's at is the time of its last event. A cold thread's messages,
  // its terms but files (^id), and its task views are in R2; what stays is what reads need to find
  // it: its threads row, this row (what it holds and a digest of what filters match), its client
  // IDs by hash, and who wrote in which channel. A warm one was read back and its R2 copy still matches.
  'create table if not exists cold_threads (root integer primary key, channel text not null, state text not null, fingerprint text not null, last_id integer not null, count integer not null, active integer, root_deleted integer not null, digest blob not null, bytes integer not null, at integer not null, warmed integer) strict',
  'create index if not exists cold_threads_channel on cold_threads (channel, root)',
  'create index if not exists cold_threads_last on cold_threads (last_id)',
  'create table if not exists cold_keys (hash integer not null, root integer not null, primary key (hash, root)) strict, without rowid',
  'create table if not exists cold_authors (channel text not null, actor text not null, primary key (channel, actor)) strict, without rowid',
  // A cold thread's root and last message rows, as listings show them, and what its messages
  // match on but their text: listings and filters over cold threads answer from these, not R2.
  'create table if not exists cold_rows (id integer primary key, root integer not null, row text not null) strict',
  'create index if not exists cold_rows_root on cold_rows (root)',
  'create table if not exists cold_facets (root integer primary key, facets text not null) strict',
  // Frozen: threads cold past a horizon, their summaries in immutable R2 pages ordered as /threads
  // lists them. Each page's index row holds its key range, a Bloom filter of its client IDs, and its
  // channels' ranges; nothing of its threads stays but their files, by channel, and, for one that
  // came back, when (frozen_gone: every page older than that holds a stale copy of it).
  'create table if not exists frozen_pages (id integer primary key, min_last integer not null, min_root integer not null, max_last integer not null, max_root integer not null, first_root integer not null, last_root integer not null, count integer not null, messages integer not null, key text not null, bytes integer not null, at integer not null, keys blob not null, channels text not null) strict',
  'create table if not exists frozen_gone (root integer primary key, at integer not null) strict',
  'create table if not exists frozen_files (term text not null, message integer not null, root integer not null, channel text not null, primary key (term, message)) strict, without rowid',
  'create index if not exists frozen_files_root on frozen_files (root)',
]