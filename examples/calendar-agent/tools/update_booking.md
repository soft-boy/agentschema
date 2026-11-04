---
type: custom
name: update_booking
description: Move or change an appointment on the calendar. Only the fields you pass change. It can't invite anyone.
---

## Input Schema

| Name | Type | Description | Required |
|---|---|---|---|
| `id` | `string` | The appointment's ID, from list_bookings | `true` |
| `title` | `string` | What the appointment is | `false` |
| `start` | `string` | When it starts, in RFC 3339, like 2026-11-05T14:00:00-08:00 | `false` |
| `end` | `string` | When it ends, in the same format | `false` |
| `time_zone` | `string` | IANA time zone, like America/Los_Angeles | `false` |
| `description` | `string` | Notes for the appointment | `false` |
| `location` | `string` | Where it happens | `false` |

## Code

```javascript
const { booking, calendarApi, eventsPath, when } = require("./lib/google.cjs");

module.exports = async ({ id, title, start, end, time_zone, description, location }) => {
  const body = { summary: title, description, location };
  if (start) body.start = when(start, time_zone);
  if (end) body.end = when(end, time_zone);
  return booking(await calendarApi("PATCH", eventsPath(id), { body }));
};
```
