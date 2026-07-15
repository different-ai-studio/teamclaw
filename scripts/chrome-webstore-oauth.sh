#!/usr/bin/env bash
# One-off manual OAuth flow for Chrome Web Store API — no 3rd-party CLI needed.
# Run this on YOUR local machine (needs a real browser), not in any sandbox.
#
# Usage:
#   ./chrome-webstore-oauth.sh <CLIENT_ID> <CLIENT_SECRET>
#
# Steps it walks you through:
#   1. Prints an authorization URL — open it, log in with the Google account
#      that owns the Chrome Web Store listing, click Allow.
#   2. Google redirects to http://localhost/?code=XXXX — the page will fail
#      to load (nothing is listening on localhost), that's expected. Copy the
#      `code` value out of the browser's address bar and paste it back here.
#   3. Script exchanges the code for a refresh_token via curl.

set -euo pipefail

CLIENT_ID="${1:?Usage: $0 <CLIENT_ID> <CLIENT_SECRET>}"
CLIENT_SECRET="${2:?Usage: $0 <CLIENT_ID> <CLIENT_SECRET>}"
REDIRECT_URI="http://localhost"
SCOPE="https://www.googleapis.com/auth/chromewebstore"

encoded_scope=$(printf '%s' "$SCOPE" | sed 's/:/%3A/g; s#/#%2F#g')
auth_url="https://accounts.google.com/o/oauth2/v2/auth?client_id=${CLIENT_ID}&redirect_uri=${REDIRECT_URI}&response_type=code&scope=${encoded_scope}&access_type=offline&prompt=consent"

echo "1) Open this URL in your browser and authorize with the Web Store account:"
echo
echo "   $auth_url"
echo
echo "2) After clicking Allow, the browser will try to load http://localhost/?code=...."
echo "   and fail to connect — that's expected. Copy the value of the 'code' query"
echo "   param from the address bar."
echo
read -r -p "Paste the code here: " AUTH_CODE

echo
echo "3) Exchanging code for tokens..."
response=$(curl -s -X POST https://oauth2.googleapis.com/token \
  -d "code=${AUTH_CODE}" \
  -d "client_id=${CLIENT_ID}" \
  -d "client_secret=${CLIENT_SECRET}" \
  -d "redirect_uri=${REDIRECT_URI}" \
  -d "grant_type=authorization_code")

echo "$response" | python3 -m json.tool 2>/dev/null || echo "$response"

refresh_token=$(echo "$response" | python3 -c "import sys,json; print(json.load(sys.stdin).get('refresh_token',''))" 2>/dev/null || true)

if [ -n "$refresh_token" ]; then
  echo
  echo "✅ CHROME_REFRESH_TOKEN=$refresh_token"
  echo "   Save this into the GitHub repo secret CHROME_REFRESH_TOKEN."
else
  echo
  echo "⚠️ No refresh_token in the response above — check for an 'error' field."
  echo "   Common causes: code already used/expired (codes are single-use, get a"
  echo "   fresh one by re-running from step 1), or client_id/secret mismatch."
fi
