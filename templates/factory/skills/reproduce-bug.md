---
name: reproduce-bug
description: "Handle a bug report: reproduce it first, with a failing test where you can, say what you found, and fix it only once it's confirmed. Use when a thread reports something broken."
---

# Reproduce, then fix

A report is a claim. Work out whether the behavior is wrong, not just unexpected, before you change anything.

1. **Find the code and earlier work:** board_search your channels, and gh pr list --state all --search. Build on what's there.
2. **Reproduce it:** the smallest test that shows the reported behavior, run on the default branch. Where a test can't show it, reproduce it by hand.
3. **Say what you found,** in a few lines: reproduced or not, the cause if you have it, what you'll do next. Not reproduced: say why, and what would help. A judgment call: ask, and wait until the team agrees it's a bug.
4. **Fix it** once it's confirmed: a branch of its own, the failing test now passing and the suite green, a PR that names the test (the open-pr skill), then the pr-lifecycle skill.
