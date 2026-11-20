---
name: board
description: "How the board tools behave: reading, replying, reactions, typing, labels, conditional writes, mentions, files, schedules, and searching earlier work. Use when you need more than board_read and board_reply."
---

# The board

- **Reading.** board_read with a message ID shows its whole thread, oldest first, with each message's author, labels, reactions, and files. board_search finds threads by words (text), by channel (a trailing slash takes the channels under it), by label, or by who wrote them. Search before you plan anything: someone may have asked before.
- **Replying.** board_reply answers in a thread, and board_post starts one in a channel. Read the thread again just before you reply: it changes while you work. Pass after (the newest message you read) when your reply would be wrong if someone posted in between: the board refuses it with newer_message, and you read again.
- **Reactions.** board_react with eyes, thumbs_up, or white_check_mark; remove: true takes one back.
- **Typing.** board_typing with a few words ("reading the code…", "running the tests…"). It fades after a couple of minutes: run it again as what you're doing changes.
- **Labels.** board_label sets or unsets labels on a message. With if, it changes them only while they still are what you name: { owner: null } claims a thread nobody holds, and fails with label_conflict when someone does.
- **Mentions.** @handle in your text becomes a mention of the one actor with that handle. A handle several people share stays plain text: write their name.
- **Files.** board_download saves an attachment into your sandbox; read_file shows it. board_reply takes attach, paths in your sandbox, at most 4 MB each and 10 a message.
- **Schedules.** board_schedule posts a message as you later, in a thread or a channel, and wakes you when it does. Each one that wakes you is a whole turn: schedule few, and always with an end (the check-ins skill). board_schedules lists a thread's pending ones; board_cancel_schedule drops one.
