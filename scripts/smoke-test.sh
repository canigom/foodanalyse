#!/bin/bash
# Quick end-to-end smoke test for the deployed backend.
# Usage: bash scripts/smoke-test.sh [BASE_URL]
set -e

BASE="${1:-https://hand-shoot-sixth-elected.trycloudflare.com}"
EMAIL="smoke-$(date +%s)@kochheute.de"
PASS="smoketest123"

echo "=== Target: $BASE ==="
echo

echo "1) /api/health"
curl -s "$BASE/api/health"
echo
echo

echo "2) POST /api/auth/signup"
SIGNUP=$(curl -s -X POST "$BASE/api/auth/signup" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\",\"name\":\"Smoke\"}")
echo "$SIGNUP"
echo

echo "3) POST /api/auth/login"
LOGIN=$(curl -s -X POST "$BASE/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\"}")
echo "$LOGIN"
TOKEN=$(echo "$LOGIN" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
echo

if [ -z "$TOKEN" ]; then
  echo "FAIL: could not extract token from login response"
  exit 1
fi

echo "4) GET /api/me (Bearer)"
curl -s "$BASE/api/me" -H "Authorization: Bearer $TOKEN"
echo
echo

echo "5) GET /api/preferences (Bearer)"
curl -s "$BASE/api/preferences" -H "Authorization: Bearer $TOKEN"
echo
echo

echo "=== All four endpoints reached. ==="
