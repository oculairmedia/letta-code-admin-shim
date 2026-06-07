#!/bin/bash
# Weather lookup helper script
# Usage: ./weather.sh <location>

LOCATION="${1:-}"
if [ -z "$LOCATION" ]; then
  echo "Usage: weather.sh <location>"
  exit 1
fi

# Use wttr.in for weather data
curl -s "https://wttr.in/${LOCATION}?format=3"
