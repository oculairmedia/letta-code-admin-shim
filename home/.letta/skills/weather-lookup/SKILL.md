---
name: weather-lookup
version: 1.0.0
description: Look up current weather conditions for a location
tags: [weather, utilities, api]
author: community
---

# Weather Lookup Skill

This skill provides weather information for any location. Use it when the user asks about weather conditions, forecasts, or temperature.

## Usage

When the user asks about weather, use the Bash tool. Prefer the bundled
`scripts/weather.sh` helper, which URL-encodes the location for you:

```bash
scripts/weather.sh "New York"
```

If you call the API directly with `curl`, the location must be URL-encoded
(spaces become `%20`):

```bash
curl -s "https://wttr.in/New%20York?format=3"
```

## Examples

- "What's the weather in New York?" → `scripts/weather.sh "New York"`
- "Is it raining in London?" → `scripts/weather.sh "London"`
- "What's the temperature in São Paulo?" → `scripts/weather.sh "São Paulo"`

Equivalent direct calls (note the URL-encoding):

- `curl -s "https://wttr.in/New%20York?format=3"`
- `curl -s "https://wttr.in/London?format=3"`
- `curl -s "https://wttr.in/S%C3%A3o%20Paulo?format=3"`

## Response Format

The API returns responses in format: `Location: XX°C | Condition`

Example: `New York: 22°C | Partly cloudy`

## Notes

- wttr.in is a free weather service that doesn't require an API key
- For more detailed output, you can use `format=4` or `format=j1`
- Always pass the location verbatim to `scripts/weather.sh` (it handles
  encoding); when calling `curl` directly, URL-encode spaces and special
  characters (e.g. `New York` → `New%20York`)
