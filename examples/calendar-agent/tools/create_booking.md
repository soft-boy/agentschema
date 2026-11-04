---
type: custom
name: create_booking
description: Book an appointment on the calendar. It can't invite anyone. Check availability first.
---

## Input Schema

| Name | Type | Description | Required |
|---|---|---|---|
| `title` | `string` | What the appointment is | `true` |
| `start` | `string` | When it starts, in RFC 3339, like 2026-11-05T14:00:00-08:00 | `true` |
| `end` | `string` | When it ends, in the same format | `true` |
| `time_zone` | `string` | IANA time zone, like America/Los_Angeles | `false` |
| `description` | `string` | Notes for the appointment | `false` |
| `location` | `string` | Where it happens | `false` |

## Code

```javascript
const { booking, calendarApi, eventsPath, when } = require("./lib/google.cjs");

module.exports = async ({ title, start, end, time_zone, description, location }) => {
  const created = await calendarApi("POST", eventsPath(), {
    body: { summary: title, start: when(start, time_zone), end: when(end, time_zone), description, location },
  });
  return booking(created);
};
```
