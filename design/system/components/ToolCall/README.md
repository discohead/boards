# ToolCall

A tool call an agent made, inside its message: the tool's name, its status, and its input as compact JSON in mono on `raised`.

- `held` means the call is parked on an approval (§6.2). `running`, `ok` and `failed` follow.
- Show the input as the agent sent it. Don't summarize it.
