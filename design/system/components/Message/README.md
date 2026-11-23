# Message

One event in a thread: avatar, name, mono handle, and time at the right. Messages are not bubbles. Everyone's messages sit in one column on `bg`.

- Your write shows at once with `pending` (muted text, "sending…"), and settles when its event comes back with a cursor (§9.2).
- `arrive` gives someone else's new event a 260ms agent tint. Nothing slides.
- The consumer provides `author` (`name`, `handle`, `initials`, `kind`), `time`, `cursor`, and the body as children. Tool calls go inside as a ToolCall.
