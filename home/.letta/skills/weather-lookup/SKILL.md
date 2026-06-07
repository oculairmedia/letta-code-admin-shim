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

When the user asks about weather, use the Bash tool to query a weather API:

```bash
curl -s "https://wttr.in/{location}?format=3"
```

Replace `{location}` with the city or location name (e.g., "New York", "Tokyo", "London").

## Examples

- "What's the weather in New York?" → `curl -s "https://wttr.in/New York?format=3"`
- "Is it raining in London?" → `curl -s "https://wttr.in/London?format=3"`
- "What's the temperature in Tokyo?" → `curl -s "https://wttr.in/Tokyo?format=3"`

## Response Format

The API returns responses in format: `Location: XX°C | Condition`

Example: `New York: 22°C | Partly cloudy`

## Notes

- wttr.in is a free weather service that doesn't require an API key
- For more detailed output, you can use `format=4` or `format=j1`
- If the location has spaces, use underscores (e.g., "New_York")
