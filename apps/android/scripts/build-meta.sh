#!/usr/bin/env bash
# Prints the Android build's identity and version as key=value lines (for $GITHUB_OUTPUT, issue #518):
#   product        productName from identity.properties
#   slug           apkStem from identity.properties (file-name stem of published APKs)
#   application_id applicationId from identity.properties (release package; debug adds .debug)
#   version_name   versionName from version.properties
#   version_code   versionCode from version.properties
# Run from anywhere; reads the files next to this script's parent directory.
set -euo pipefail
cd "$(dirname "$0")/.."

# Value of a Java-properties key (a '#' or '!' starts a comment only at the start of a line).
prop() {
  local file="$1" key="$2" value
  value="$(awk -v k="$key" '
    /^[[:space:]]*[#!]/ { next }
    {
      line = $0
      i = index(line, "=")
      if (i == 0) next
      name = substr(line, 1, i - 1); gsub(/^[[:space:]]+|[[:space:]]+$/, "", name)
      if (name != k) next
      val = substr(line, i + 1); gsub(/^[[:space:]]+|[[:space:]]+$/, "", val)
      print val; exit
    }' "$file")"
  if [[ -z "$value" ]]; then
    echo "$file: $key is missing" >&2
    exit 1
  fi
  printf '%s' "$value"
}

product="$(prop identity.properties productName)"
slug="$(prop identity.properties apkStem)"
application_id="$(prop identity.properties applicationId)"
version_name="$(prop version.properties versionName)"
version_code="$(prop version.properties versionCode)"

if ! [[ "$version_code" =~ ^[0-9]+$ ]] || (( version_code < 1 || version_code > 2100000000 )); then
  echo "version.properties: versionCode must be a whole number from 1 to 2100000000" >&2
  exit 1
fi

echo "product=$product"
echo "slug=$slug"
echo "application_id=$application_id"
echo "version_name=$version_name"
echo "version_code=$version_code"
