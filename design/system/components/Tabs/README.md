# Tabs

The faces of a thread (Conversation, Task, Doc) and the sections of a seat doc. The selected tab gets a 2px `text` underline, and counts are mono.

- A face the thread doesn't have yet shows as an add action ("+ Write it up"), never as an empty tab.
- The consumer provides `tabs` (`id`, `label`, `count`) and `onChange`. Keep the open tab in the URL.
