// The Seat's wake queue, as SQL (seat.ts): its table, and which wakes hold a session slot. Kept apart
// from the Durable Object so a check can run the same statements in node (scripts/seat-check.ts).

export const WAKES_DDL = 'create table if not exists wakes (id text primary key, thread text not null, task text, input text not null, state text not null, attempts integer not null default 0, error text, at integer not null, started integer, ended integer, request text)'

/**
 * Threads with a wake running and no session parked on a hold. A wake that runs in a parked thread
 * waits behind the parked operation in its session: that thread is waiting, not working, and holds
 * no slot.
 */
/**
 * Deliveries the Seat acks without queuing a turn. A deleted message, moderated or not, from any
 * rule (a tail's, say): there's nothing to do about one vanishing, and each turn is a model call. A
 * deleted task's root still comes as its task.canceled. And a doc made, edited, or moved, unless a
 * docs rule matched it: a mention or a follow in a doc's body isn't a message to the seat.
 */
export const takesNoTurn = (event: { type: string }, rules: readonly string[]) => event.type === 'message.deleted' || (event.type.startsWith('doc.') && !rules.includes('docs'))

export const RUNNING_UNHELD = "select distinct thread from wakes where state = 'running' and thread not in (select thread from wakes where state = 'held')"
