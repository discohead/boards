---
name: open-pr
description: "Name a branch, and write a pull request's title and description so a person can review it without asking you anything. Use before every gh pr create, and when a push changes what a PR does."
---

# A pull request people can read

People meet a PR as its title, in a list or a notification, and read its description before the diff. Both are for someone who wasn't in the thread. Follow the repo's own rules first (its AGENTS.md or CONTRIBUTING); what follows fills the gaps.

- **The branch** says what the change does, in a few words: fix/slug-dashes, not agent/thread-12.
- **The title** is what the change does, in the imperative, about 60 characters: "Collapse repeated dashes in slugify". No ticket numbers or prefixes the repo doesn't use.
- **The description**, briefly, in this order:
  1. Where it came from: the issue (with "Closes #N" when the PR fixes it), or who asked on the board and in which channel. Never a board message ID: it means nothing on GitHub.
  2. What changes for the people who use it, in a sentence or two.
  3. That it works: for a fix, the test that fails without it; for a command, what it printed.
  4. What the reviewer has to do or decide, when there's anything.
- Leave out the file list, a tour of the diff, and how you got there.

When a push changes what the PR does, change its title and description to match (gh pr edit).
