# Toast

A short confirmation of what you just did, with its log position and, where it can be reversed, Undo. Bottom-left, gone after 5 seconds, paused on hover.

- Say what happened, in the past tense: "Approved. Ada is deploying v42."
- `cursor` is the event your action wrote (`#1288`).
- Errors use `tone="danger"`, say what failed and what to do, and stay until dismissed.
