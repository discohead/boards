# Input

A single-line text field. Borders use `line-control` (3:1), and focus shows a `focus` border with a `held-soft` halo.

- The consumer provides `id`, a `label`, and either `value` with `onChange` or `defaultValue`.
- Put units and sigils in `prefix` (`$`, `@`), set in mono.
- `error` says what went wrong and how to fix it: "@op is taken by Operator. Try @ops." Never just "Invalid".
- Saving is explicit (↵) or debounced. Never discard what someone is typing because a live update arrived.
