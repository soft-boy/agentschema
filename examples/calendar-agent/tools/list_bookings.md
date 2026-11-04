---
type: custom
name: list_bookings
description: List the appointments on the calendar, soonest first, optionally matching some text.
---

## Input Schema

| Name | Type | Description | Required |
|---|---|---|---|
| `from` | `string` | Start of the range, in RFC 3339 with an offset. Defaults to now | `false` |
| `to` | `string` | End of the range, in the same format | `false` |
| `search` | `string` | Only appointments containing this text | `false` |

## Code

```javascript
const { booking, calendarApi, eventsPath } = require("./lib/google.cjs");

module.exports = async ({ from, to, search }) => {
  const result = await calendarApi("GET", eventsPath(), {
    query: {
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: "50",
      timeMin: from ?? new Date().toISOString(),
      timeMax: to,
      q: search,
    },
  });
  return { bookings: result.items.map(booking), more: Boolean(result.nextPageToken) };
};
```
