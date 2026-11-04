---
type: custom
name: check_availability
description: Find the busy times on the calendar between two moments. Any time not returned is free.
---

## Input Schema

| Name | Type | Description | Required |
|---|---|---|---|
| `from` | `string` | Start of the range, in RFC 3339 with an offset, like 2026-11-05T09:00:00-08:00 | `true` |
| `to` | `string` | End of the range, in the same format | `true` |

## Code

```javascript
const { calendarApi, calendarId } = require("./lib/google.cjs");

module.exports = async ({ from, to }) => {
  const id = calendarId();
  const result = await calendarApi("POST", "/freeBusy", {
    body: { timeMin: from, timeMax: to, items: [{ id }] },
  });

  // A calendar it can't read comes back with errors and no busy times. Reporting that as free
  // would double-book, so it's a failure instead.
  const calendar = result.calendars?.[id];
  if (!calendar || calendar.errors?.length) {
    throw new Error(`couldn't read the calendar's busy times: ${calendar?.errors?.[0]?.reason ?? "no result"}`);
  }
  return { from, to, busy: calendar.busy };
};
```
