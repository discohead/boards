# Tasks across people and seats

## The rule

A task can be for anyone on the board, and finished by more than the claim that holds it. Who may
do each thing comes from **grants** (`manage` in the task's channel) and from **owning the task**
(its owner as itself, or the profile that made it, as `owns()` has it). It never comes from the
org's graph: who reports to whom, who consults whom, or which seat a task was routed to.

Phase 2 needs four things the board refused before (#10):

- the principal, a person, hands work to a seat (`worker:workbus-app+eng`);
- the operator (`worker:workbus-app+op`) hands its tasks to another seat;
- a seat holds a task for the principal with a kind, and the principal answers it from the inbox;
- the principal finishes or fails a task a seat holds, when it has to.

## Who may do what

| Write | Who | Before |
| --- | --- | --- |
| `for` (create, assign) | the task's owner (or `manage`): any actor the board knows, not an imported platform user; or a profile of a principal the board knows | one of the owner's profiles |
| claim an assigned task | its assignee, whoever owns it, with `label` in the channel | the assignee, if a profile of the owner |
| hold (`block`) | its claim, with a kind; or the owner, when no one holds it | the same |
| answer a hold its claim placed (`unblock`) | `manage` in the channel, or the task's owner when that's a person as themselves | the owner |
| answer a hold the owner placed | the owner (`owns()`) | the same |
| complete, fail, release without the claim | the owner (`owns()`), on a ready or claimed task | no one |

Being assigned gives nothing. The assignee still claims only where its own grants let it label,
and a seat's narrowing (its seat doc's `can`) still bounds it. Nobody else claims an assigned
task, its owner included: the owner reassigns it first.

## Answering a hold

A hold its claim placed is the holder asking someone else: an approval before a side effect, a
decision, a review (design/workbus.md §6). `POST /tasks/{id}/unblock` takes
`{ decision: 'approved' | 'declined', note? }`. Either way the task is given back (ready, or
waiting if it still needs something), and its view carries `answer: { decision, note, by }`
until it's held again. The seat's session was parked on the task, and it wakes on
`task.unblocked`, claims the task again, and reads the answer. A decline doesn't end the task: the
seat goes on without that step. Ending the task is `cancel` or `fail`.

Only `manage`, or the task's owner as a person, answers such a hold, because the one that made
the task is often an agent. The operator makes most tasks and hands them out. If making a task
were enough to answer its holds, the operator could approve its own seats' side effects. A plain
`unblock` with no decision still works, under the same rule.

A hold the owner placed without a claim (or the board's `edited` hold) is the owner's to lift,
as before: `owns()`.

## Finishing without the claim

`complete`, `fail`, and `release` take the claim's `epoch` and `token` as before, or neither.
With neither, it's the owner's write (`owns()`). It ends whatever claim holds the task, and the
holder's next write gets `claim_lost`, as for an expired lease. A completion readies the tasks that
need it, in the same write. A task that still waits for others refuses (`task_waiting`), and so
does a held one (`task_blocked`): a hold is answered or canceled, not finished over the person it
waits for. Half a proof is a 400.

The operator supervising a stalled seat (§5.8) takes its task back with `release`, or fails it.
The principal finishes one by hand from the issue view.

## Surface

- HTTP: `for` on `POST /tasks`, `/tasks/batch`, and `/tasks/{id}/assign` takes any known actor;
  `/complete`, `/fail`, `/release` take an optional `epoch` and `token`; `/unblock` takes
  `decision` and `note`. The task view gains `answer`; `task.unblocked` carries `decision` and
  `note`.
- Binding and Cap'n Web: `tasks.approve(id, note)`, `tasks.decline(id, note)`,
  `tasks.unblock(id, answer)`, and `tasks.complete`, `tasks.fail`, `tasks.release` as the owner.
- CLI: `wb tasks approve|decline <id> [note]`, and `--owner` on `complete`, `fail`, `release`.
- Who held a task, and whether through its claim, is kept beside the tasks table
  (`task_holds`), not on the view.

## Known gap

The handles in this note are profiles' claims (design/workbus.md §5.1). A person's handle comes
from their token, so a person who signs in later can still have a handle a profile claimed. The
board can't refuse a sign-in over it: a mention of that handle then offers both as candidates, as
it does for any two actors with one handle.

## Not doing

An answer from a person other than the owner or a manager: delegating approvals is a grant
(`manage` in the channel), not a new rule. Making a kind automatic for a seat (§6.2) is the app's
job, in the seat's tools, not the board's. Tasks assigned to several actors, or to a team, are a
queue (`{ ready: <channel> }`) and need no assignment.
