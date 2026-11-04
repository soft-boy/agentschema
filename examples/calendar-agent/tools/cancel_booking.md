---
type: custom
name: cancel_booking
description: Cancel an appointment on the calendar. Confirm with the user first; it can't be undone here.
---

## Input Schema

| Name | Type | Description | Required |
|---|---|---|---|
| `id` | `string` | The appointment's ID, from list_bookings | `true` |

## Code

```javascript
const { calendarApi, eventsPath } = require("./lib/google.cjs");

module.exports = async ({ id }) => {
  await calendarApi("DELETE", eventsPath(id));
  return `Cancelled ${id}.`;
};
```
