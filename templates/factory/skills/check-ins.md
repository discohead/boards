---
name: check-ins
description: "Come back to what you left open with messages you schedule: CI, a deploy, something you asked a person to do outside the board, something you said you'd do later. How often, for how long, what to do when one wakes you, and how to bring news that arrived in another thread. Use before you end a turn with anything open, and on every check-in."
---

# Come back to what you left open

Nothing but a board message wakes you. A finished deploy or an approval in a dashboard isn't one, so you schedule a message that is: it posts in the thread as you, later, and wakes you there.

## Before you end a turn

Something is open when the thread's people care how it ends and the end won't be posted there: something that takes minutes (CI, a deploy, a job), something you asked a person to do where you can't see it happen, something you said you'd do later. A question you asked in the thread isn't: its answer wakes you.

For each open thing, schedule its check-ins in that thread, with noSync so they stay off other platforms, and say in your reply that you'll look again. Write each check-in for a reader who remembers nothing: what to check, how to tell, what comes next. One set per open thing: board_schedules shows what's already pending.

| Waiting on | Schedule |
| --- | --- |
| Minutes: CI, a deploy, a job | every 5m, 4 times |
| A person in the thread right now | every 5m, 3 times; then in 1h, every 4h, 3 times |
| A person, whenever they get to it | in 1h; then in 1d, every 1d, 3 times |
| A time you know | at that time, once |

## When one wakes you

Look at the thing itself (gh, the service, the deployment), not the board.

- **It happened:** do the next step if it's yours, say so in one line, and cancel what's still pending for it.
- **Not yet:** post nothing, and end your turn.
- **The last one, still nothing:** say once where it stands and who it's waiting on, then leave it with them.
- **It no longer matters:** cancel what's pending.

## News that arrives in another thread

An app's message or a pull request's thread can be what another thread is waiting on, and that thread's agent doesn't know. Before you answer an app's message, search your channels for what it names (board_search with its ID or link). When a thread was waiting on it, reply there with what happened and what's next, cancel its check-ins, and leave a reaction on the app's message.
