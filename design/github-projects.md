# GitHub Projects on a board: a design

## Summary

A GitHub Project (v2) is a view over issues, pull requests, and draft items, with fields. On a
board it's neither a board nor a channel: an item is the thread the GitHub sync already makes for
its issue, membership and fields are labels on that thread, and a view is a query over those
labels. One field, usually Status, can drive the item's thread as a board task, by an explicit
mapping. In the Factory, that makes the Project the team's control surface and board tasks the
agent's queue: a card moved to "Ready for agent" becomes a task the agent claims, works, and
completes, and the card follows.

## What GitHub offers (and doesn't)

Checked against GitHub's docs (November 2026):

- **Organization Projects only.** Project webhooks (`projects_v2_item`: `created`, `edited`,
  `deleted`, `archived`, `restored`, `converted`, `reordered`) are delivered for organization
  Projects, to an App with the organization permission **Projects** (`organization_projects`). No
  documented route lets an App reach a user-owned Project, and none of its events are delivered.
  Project webhooks are in public preview.
- **GraphQL only** for reading and writing: `organization.projectV2(number)`, `items` with
  `fieldValues`, `Issue.projectItems`, and the mutations `addProjectV2ItemById`,
  `addProjectV2DraftIssue`, `updateProjectV2ItemFieldValue` (one field a call: text, number,
  date, single-select option ID, or iteration ID), `clearProjectV2ItemFieldValue`,
  `archiveProjectV2Item`, `deleteProjectV2Item`.
- **An `edited` webhook names the field** (`changes.field_value.field_node_id`, `field_name`), but
  the shape of `from` and `to` isn't documented for every type. The sync reads the item instead.
- **Built-in workflows** move Status on their own: by default, an item whose issue closes or whose
  pull request merges goes to Done. Others can be turned on (set Todo when added; close the issue
  when Status changes).
- **Limits:** 50 fields and 50,000 items a Project; 5,000 GraphQL points an hour per installation.

## The model

| GitHub Project | On the board |
| --- | --- |
| a Project (`acme/7`) | a name in the sync's config (`roadmap`), a channel for its draft items, and labels |
| an issue or pull request item | the thread the GitHub sync makes for that issue, wherever its repo's channel is |
| an issue item whose repo isn't synced | a thread in the Project's channel, its first line a link to the issue |
| a draft item | a thread in the Project's channel: its title the first line, its body the rest |
| being in the Project | the label `project.roadmap=yes`, and a sync target `github:project:<project>:<item>` |
| a field value | a label `project.roadmap.<field>`: `project.roadmap.status=In progress`, `project.roadmap.priority=P1` |
| a view | a query: `GET /threads?label=project.roadmap.status=In progress`; not synced |

A field's key is its name in the label alphabet (`Target date` is `target-date`). Values are as
GitHub shows them: an option's name, an iteration's title, a number, an ISO date, text. Label
values are strings, so a number or a date is written as text.

The thread is the item's home: its comments, its claims, its history. The Project holds where it
stands. Neither side copies the other's whole record.

## Both ways

**In.** A `projects_v2_item` webhook for a configured Project lands in the GitHub sync's Inbox,
like issue events. Its import reads the item through GraphQL (stale or out-of-order deliveries
don't matter: the item as it is now is what's written), then:

- finds or makes its thread (the issue's thread, by the existing sync lookup; or a new thread in
  the Project's channel) and attaches the item as a sync target;
- sets `project.<name>` and each field's label, and unsets the labels of fields now empty, as one
  label write from the sync (so its courier doesn't echo it);
- on `archived` or `deleted`, unsets the Project's labels; the thread stays.

**Out.** The courier already receives `labels.changed` for synced threads. For a thread with a
Project target:

- a changed `project.<name>.<field>` label sets that field (`updateProjectV2ItemFieldValue`), or
  clears it when unset. A value the field can't take (an option that doesn't exist, a bad date)
  is refused, and the labels are rewritten from the item, so the board shows what the Project holds;
- setting `project.<name>` on a thread adds it: its issue by node ID when it has one, else as a
  draft item. Unsetting it archives the item (archiving is reversible; deleting isn't).

Who may change a Project from the board is who may label in that channel. The writes go to GitHub
as the App.

## Status as tasks (opt-in)

A Project's Status and a board task's state are two state machines. A task has claims, leases, and
needs; a column is where a card sits. So the mapping is explicit, per Project, and each direction
maps only what it can mean:

```ts
status: { field: 'Status', ready: 'Ready for agent', claimed: 'In progress', blocked: 'Blocked', completed: 'Done', canceled: "Won't do" }
```

| Status moves to | The thread's task |
| --- | --- |
| the `ready` option | becomes a ready task (`createTask { re }`), or reopens a finished one |
| the `completed` option | completes, if it's open |
| the `canceled` option | is canceled, if it's open |
| the `claimed` or `blocked` option, or one not mapped | nothing: a claim is an actor's, and a person dragging a card isn't one |

| The task | Status is set to |
| --- | --- |
| becomes ready, or a claim is released or expires | the `ready` option |
| is claimed | the `claimed` option |
| is blocked | the `blocked` option |
| completes | the `completed` option |
| is canceled | the `canceled` option |

Both directions are idempotent, so the echo of the sync's own write changes nothing. The default
workflows agree with this mapping: a closed issue or a merged pull request moves the card to Done,
which completes the task. Map a dedicated column like "Ready for agent", not Todo: the "set Todo
when added" workflow would otherwise make every new card a ready task.

The courier needs task events for this (`task.ready`, `task.claimed`, `task.released`,
`task.expired`, `task.blocked`, `task.completed`, `task.canceled`), added to the events it
matches for threads with a Project target.

## Configuration

```ts
github: githubProvider({
  webhookSecret, repos, token, docs,
  projects: {
    roadmap: { project: 'acme/7', channel: 'project-factory/roadmap', status: { field: 'Status', ready: 'Ready for agent', claimed: 'In progress', completed: 'Done' } },
  },
})
```

`project` is the organization and the Project's number, as its URL shows them. The provider looks
up the Project's node ID and fields once and keeps them; a field added later is found when an item
names it. The App needs the organization's **Projects** permission (read and write) and the
**Projects v2 item** webhook event, and must be installed on the organization.

## The Factory

Today people steer the Factory by opening issues and talking in threads. With a Project, they also
steer it from the planning board:

1. Someone moves a card to "Ready for agent". Its thread becomes a ready task.
2. The Factory wakes on `task.ready` in its channels (a fourth wake case in `FactoryWake`), and
   the agent claims the task: the card moves to "In progress".
3. It works the thread as now: a branch, a pull request, check-ins. While a turn runs, the runtime
   renews the claim's lease, so a long turn doesn't lose it.
4. The pull request merges. The default workflow moves the card to Done, which completes the task;
   or the agent completes it, and the card moves to Done.

The agent gets task tools (`task_claim`, `task_complete`, `task_release`, `task_block`), and
sets fields with `board_label` (`project.roadmap.estimate=3`), with no Project-specific tool.
What a card says is still the agent's to read and decide; the sync moves no card on its own
judgment.

## Not doing (v1)

- **User-owned Projects:** GitHub gives an App no way in.
- **Backfill:** items already in the Project arrive when they next change. A one-time import
  (`syncBackfill` for a Project, paging `items`) is the first follow-up.
- **Views, ordering (`reordered`), and multi-select fields:** a view is a query, order is
  GitHub's, and a multi-select label would need a list encoding.
- **Status updates** (`projects_v2_status_update`) and Project-level events (`projects_v2`).

## Open questions

1. **Which organization to verify against.** The App is installed on `discohead`, a user. A live
   run needs it installed on one of your organizations with the Projects permission, and a fresh
   Project there. None of your organizations has an open Project except `jaredmcfarland` ("workbus
   tasks", which looks in use, so leave it alone), and you can create Projects in all of them.
   `datspace-ai` fits, since the Factory's Cloudflare account is `datspace-web`. Organization
   Projects can hold issues from repos the organization owns, and possibly others; if
   `discohead/factory-playground` can't be added, a playground repo in that organization is
   needed.
2. **Archive or delete** when `project.<name>` is unset. Archive is proposed.
3. **Webhook preview.** If GitHub changes the payloads, the import still reads the item itself, so
   only the event names matter.

## Build plan

| Step | Ships | Done when |
| --- | --- | --- |
| 1 | the Project config, GraphQL reads, `projects_v2_item` imports (threads, targets, field labels), label writes out (fields, membership) | workerd and node tests against a fake GraphQL API, each mapping broken once and seen failing; a refused value rewrites the labels |
| 2 | Status as tasks, both ways, with the courier's task events | tests for each row of both tables, and the echo of each write changing nothing |
| 3 | the Factory: task tools, the `task.ready` wake, lease renewal in a turn | live on an organization Project: a card moved to "Ready for agent" is claimed by the agent, it opens a PR, the merge moves the card to Done and completes the task |
