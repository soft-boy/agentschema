---
type: custom
name: get_weather
description: Get current weather for a location
---

## Input Schema

| Name | Type | Description | Required |
|---|---|---|---|
| `location` | `string` | City name | `true` |

## Code

```javascript
module.exports = async ({ location }) => {
  const geo = await fetch(
    `https://geocoding-api.open-meteo.com/v1/search?count=1&name=${encodeURIComponent(location)}`
  ).then((r) => r.json());
  const place = geo.results?.[0];
  if (!place) return `No place called "${location}" was found.`;

  const fields = "temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weather_code";
  const { current, current_units: units } = await fetch(
    `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}&current=${fields}`
  ).then((r) => r.json());

  return JSON.stringify({
    location: [place.name, place.admin1, place.country].filter(Boolean).join(", "),
    time: current.time,
    temperature: `${current.temperature_2m}${units.temperature_2m}`,
    feels_like: `${current.apparent_temperature}${units.apparent_temperature}`,
    humidity: `${current.relative_humidity_2m}${units.relative_humidity_2m}`,
    wind: `${current.wind_speed_10m} ${units.wind_speed_10m}`,
    conditions: describe(current.weather_code),
  });
};

// WMO weather codes, as Open-Meteo reports them.
function describe(code) {
  if (code === 0) return "clear";
  if (code <= 3) return "partly cloudy";
  if (code <= 48) return "fog";
  if (code <= 57) return "drizzle";
  if (code <= 67) return "rain";
  if (code <= 77) return "snow";
  if (code <= 82) return "rain showers";
  if (code <= 86) return "snow showers";
  return "thunderstorm";
}
```
