---
type: custom
name: get_booking
description: Get one appointment on the calendar by its ID.
---

## Input Schema

| Name | Type | Description | Required |
|---|---|---|---|
| `id` | `string` | The appointment's ID, from list_bookings | `true` |

## Code

```javascript
const { booking, calendarApi, eventsPath } = require("./lib/google.cjs");

module.exports = async ({ id }) => booking(await calendarApi("GET", eventsPath(id)));
```
