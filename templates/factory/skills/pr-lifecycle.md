---
name: pr-lifecycle
description: "See a pull request you opened through to merged or closed, with check-ins you schedule. Use right after gh pr create, and on every check-in about one of your PRs."
---

# See your PR through

A PR you open is yours until it's merged or closed, and nothing GitHub does on it wakes you. Right after gh pr create, schedule its check-ins in the thread you built it for, each with noSync:

- while its checks run: every 10m, 6 times ("Check on <owner/repo>#<N>")
- its first day: in 2h, every 4h, 6 times
- the week after: in 2d, every 1d, 6 times

## On each check-in

Start on GitHub: gh pr view <N> --repo <owner/repo> --json state,reviewDecision,reviews,comments,statusCheckRollup, and gh api repos/<owner/repo>/pulls/<N>/comments for inline comments. Then:

- **Checks finished:** cancel the rest of the first set.
- **A failing check:** read why. Fix and push when your change broke it; re-run once when it's flaky; say which check and why when it fails the same way again.
- **Review comments:** address each, with a fix pushed or a reply on GitHub where you disagree.
- **No review after a day:** ask once in the thread, naming who should review it.
- **Approved, green, nothing open:** merge it if the repo lets you and the person who asked wants it merged; otherwise say it's ready and who can merge it.
- **Merged or closed:** say so in one line, cancel its check-ins, and when that settles the thread, react white_check_mark on its root.

A check-in that finds nothing new posts nothing.
