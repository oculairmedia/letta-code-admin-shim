#!/bin/bash
# Weather lookup helper script
# Usage: ./weather.sh <location>

LOCATION="${1:-}"
if [ -z "$LOCATION" ]; then
  echo "Usage: weather.sh <location>"
  exit 1
fi

# URL-encode the location so spaces/special characters (e.g. "New York",
# "São Paulo") don't break the request. Iterate byte-by-byte under LC_ALL=C
# so multibyte UTF-8 is percent-encoded correctly (e.g. "ã" -> %C3%A3).
url_encode() {
  local s="$1" out="" c i
  LC_ALL=C
  for (( i = 0; i < ${#s}; i++ )); do
    c="${s:i:1}"
    case "$c" in
      [a-zA-Z0-9.~_-]) out+="$c" ;;
      *) printf -v c '%%%02X' "'$c"; out+="$c" ;;
    esac
  done
  printf '%s' "$out"
}

ENCODED_LOCATION="$(url_encode "$LOCATION")"

# Use wttr.in for weather data
curl -s "https://wttr.in/${ENCODED_LOCATION}?format=3"
