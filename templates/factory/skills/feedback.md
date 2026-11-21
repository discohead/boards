---
name: feedback
description: "Keep the factory's living doc of how it works (project-factory/factory/how-we-work) up to date: a correction someone gives you that holds beyond one thread, something that slowed you or a person down, a better way you found. Use when someone corrects how you work, and when you learn something the next thread should know."
---

# How we work: the factory's living doc

You won't remember this thread in the next one. The doc at **project-factory/factory/how-we-work** is where what you learn lasts: one section per area (access, reproducing bugs, pull requests, check-ins, and so on). The next agent reads it before it works.

1. **Read the outline:** `doc_read` with the path, no section. Note the doc's **revision** and the section the lesson belongs in.
2. **Read that section:** `doc_read` with its key. Fold the lesson into what it says: a short rule, in the imperative, with why when it isn't obvious. Don't repeat what's there; correct it when it's wrong.
3. **Edit that section only:** `doc_edit` with the revision you read and `edits: [{ section, text }]`, the section's whole new text. A new area is `{ after: "<a key>", text: "## Area\n\nThe rule." }`.
4. **If it's refused with section_conflict,** another agent just changed that section: read it again, fold both together, and edit with the new revision. Never overwrite what you didn't read.
5. **Say what changed** in one line where the lesson came from (the thread you're in), linking the section: `[[project-factory/factory/how-we-work#<key>]]`.

Worth a line in the doc: a correction to how you work, access or a tool you lacked, a step you had to guess, a better way you found. Not worth one: what applies to this one task only, or anything private from the thread.

Discussion about the factory itself still belongs in project-factory/rsi; the doc is where the result lands. A small, clear fix to the factory's code is a pull request on its own repo, when it has one.
