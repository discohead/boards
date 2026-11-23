# SeatState

A seat's live state: a small mark and its name in mono. The five states are fixed by the seat runtime (§5.2).

| state | mark | means |
| --- | --- | --- |
| `active` | faint dot | ready, nothing in hand |
| `working` | `agent` dot | running a session |
| `waiting` | `held` dot | waiting on you |
| `paused` | ring | you paused it |
| `over_budget` | `danger` diamond | stopped at its limit |

Each state differs in shape as well as color, so it reads without color. Always show the word beside the mark, except in the tightest rows, where the word goes in a tooltip.
