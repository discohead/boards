# Button

Buttons run one action. Use `primary` once per view, for the action the view exists for (Approve, Apply, Hire). Everything else is `secondary`, `outline` or `ghost`.

- The consumer provides the label (a verb: "Approve", "Let Rhea go", never "OK"), and optionally `kbd`, `icon`, `size` and `onClick`.
- Show the shortcut in `kbd` whenever one exists. The app is keyboard first.
- `danger` is a crimson outline, never a fill, so it never looks like the vermilion primary. Its label says exactly what happens.
- Sizes: `md` 28px in the shell, `sm` 24px inside cards and rows, `lg` 34px in dialogs and empty states.
