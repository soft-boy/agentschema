# `scheduled/`

A scheduled task runs the agent on a timetable, starting each run with the same message, like saying good morning in a channel every weekday at 8. Each `.md` file directly inside `scheduled/` is one task, named after its file. `deploy` turns each one into a Managed Agents deployment, so Anthropic starts every run, and nothing has to keep running on your side.

```markdown path=scheduled/good-morning.md
---
schedule: "0 8 * * 1-5"
timezone: America/Los_Angeles
budget: 0.50
---

Say good morning in #gm, and mention anything on today's calendar.
```

The body is the message each run starts with, and it's required. Every run is a new session, so the agent doesn't remember the one before.

## Fields

| Field | Required | Default | What it does |
|---|---|---|---|
| `schedule` | Yes | | When it runs, as a cron expression in quotes |
| `timezone` | Yes | | The time zone `schedule` is in, like `America/Los_Angeles` or `UTC` |
| `enabled` | No | `true` | `false` pauses it without deleting it |
| `budget` | No | None | The most a run can spend, in US dollars, like `0.50` |
| `description` | No | | What it's for, shown in the Console, up to 2,048 characters |

Any other field is an error, so a typo like `scedule` doesn't silently do nothing.

### `schedule`

Five parts, separated by spaces: the minute, hour, day of the month, month and day of the week. Each part takes a number, a range like `1-5`, a list like `1,3,5`, a step like `*/15`, or `*` for every one. The day of the week goes from 0 to 7, where both 0 and 7 are Sunday.

| `schedule` | Runs |
|---|---|
| `"0 8 * * 1-5"` | At 8:00 every weekday |
| `"0 9 * * 1"` | At 9:00 every Monday |
| `"*/30 * * * *"` | Every 30 minutes |
| `"0 18 1 * *"` | At 18:00 on the first of every month |

Names like `MON` or `JAN`, shortcuts like `@daily`, and a sixth part for seconds or years aren't allowed. Put the expression in quotes, because YAML reads a leading `*` as something else.

A run can start a few minutes after its time. Anthropic spreads runs out by up to 15% of the time between them, and at most 9 minutes, so don't count on the exact minute.

### `timezone`

A name from the IANA time zone database, such as `America/New_York`, `Europe/London` or `UTC`. The schedule follows the wall clock there, so `"0 8 * * *"` runs at 8:00 local time all year round.

Daylight saving time has two edges. A time that doesn't exist on the day the clocks go forward is skipped, and one that happens twice on the day they go back runs twice. To avoid both, don't schedule between 1:00 and 3:00, or use `UTC`.

### `budget`

The most one run can spend at list prices, in US dollars, with at most two decimals. A run stops once it reaches this, although it can go over by up to one turn. Without a budget, a run isn't capped.

### `enabled`

`enabled: false` pauses the task. Setting it back to `true` starts it again from its next time, and the runs it missed while paused aren't made up.

## What a run gets

Each run is a new session with:

- **The agent,** pinned to the version last deployed. Deploying a change to the agent moves every task onto the new version.
- **Its environment.**
- **Every deployed vault** in `vaults/`, in name order, the same as `agentschema run`.

Runs are billed to the API key's workspace, like any other session.

## Nobody's there to answer

During a scheduled run, nothing is watching the session, so a tool call that waits for an answer waits until the run is stopped. That's:

- **Tools set to `always_ask`,** which wait for someone to approve them.
- **Custom tools,** which run on the machine running `agentschema run`, and that isn't involved here.
- **Agentbook tools,** which run on their host.

`check` warns about these, unless the task is turned off:

```
scheduled/good-morning.md: nobody's there to answer during a scheduled run, so a run
that calls one of these waits until it's stopped: bash, get_weather
```

For the tools a task needs, use `always_allow`, or `auto`, which only asks when Anthropic can't decide. A host that's always on can answer the others itself, by listening for the run's session.

## Deploying

`deploy` handles tasks last, because they refer to everything else. For each task, it creates or updates a deployment, then pauses or unpauses it to match `enabled`. The lock keeps each one under its file:

```json
"./scheduled/good-morning.md": { "kind": "deployment", "id": "depl_…", "hash": "…", "paused": false }
```

```
created   deployment depl_… (next run 2026-11-09T16:00:00Z)
unpaused  deployment depl_… (next run 2026-11-09T16:00:00Z)
archived  deployment depl_… (scheduled/weekly.md is gone)
```

The next run time comes from Anthropic, in UTC, so it shows whether the schedule means what you meant.

- **Removing** a task's file archives its deployment, so that it stops running. This is the one thing `deploy` removes from the runtime, because a schedule left behind would keep running, and costing money. Archiving can't be undone, but deploying the file again makes a new one.
- **Renaming** a task's file archives the old deployment, and makes a new one.
- **A deployment archived elsewhere,** such as in the Console, is replaced with a new one on the next deploy.
- **Archiving the agent** with `agentschema delete` archives its deployments too.

To try a task without waiting, use **Run now** on its deployment in the Console. Each run shows up there, with its session.

## Notes for hosts

- `deployFiles({ …, scheduled: false })` leaves tasks alone. Use it for a copy of the agent that's only for trying it out, so that testing never schedules anything.
- `pauseScheduled({ lock, client, saveLock })` pauses every task in a lock, such as when the agent goes offline. The next deploy unpauses the ones whose files say they're enabled.
- `archiveScheduled({ lock, client, saveLock })` archives them all, such as before deleting the agent.
- `taskSettings(task)` gives a task's settings with the defaults filled in, and `taskBody(task)` gives the parts of its deployment that come from the file.

See [Library](library.md).
