---
name: review-pr
description: "Review someone's pull request: check it out, read and run it, try the change, and submit one GitHub review. Use when a thread's root is labeled pr=<owner/repo>#<N>, and again when new commits land."
---

# Review a pull request

1. **Check it out and read it:** gh pr checkout <N> --repo <owner/repo>, then the diff, the description, and the repo's AGENTS.md or README for what it touches.
2. **Run it:** the checks the repo uses, and the tests nearest the change.
3. **Try it,** where you can, the way a person would.
4. **Review once, on GitHub:** write review.json and submit it with gh api repos/<owner/repo>/pulls/<N>/reviews --input review.json. Its event is APPROVE, REQUEST_CHANGES, or COMMENT; its comments go on lines the diff touches, each saying what's wrong, why, and what would fix it.

The review reaches the board thread on its own: don't restate it there. When new commits land, review what changed.
