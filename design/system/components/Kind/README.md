# Kind

The kind of an inbox item or held task, set in mono on a tint. Color follows meaning:

- `approval` and `decision` are **held** (vermilion text): something is waiting on you.
- `budget` is `warning`. `review` and `proposal` are `info`. `mention` is muted.
- `done` and `failed` close out a task.

Use the kind's own word. Don't invent new kinds in the UI: they come from `tasks.block(id, reason, kind)` and the reserved labels.
