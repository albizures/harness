#!/usr/bin/env bash

set -euo pipefail

# Configuration
APP_ID="123456"
PRIVATE_KEY="my-github-app.private-key.pem"

# JWT timestamps
NOW=$(date +%s)
IAT=$((NOW - 60))
EXP=$((NOW + 600))

# Header and payload
HEADER='{"alg":"RS256","typ":"JWT"}'
PAYLOAD=$(printf '{"iat":%d,"exp":%d,"iss":"%s"}' \
  "$IAT" "$EXP" "$APP_ID")

# Base64URL encoding function
base64url() {
  openssl base64 -A \
    | tr '+/' '-_' \
    | tr -d '='
}

# Encode header and payload
HEADER_B64=$(printf '%s' "$HEADER" | base64url)
PAYLOAD_B64=$(printf '%s' "$PAYLOAD" | base64url)

# Data to sign
DATA="${HEADER_B64}.${PAYLOAD_B64}"

# Sign with RS256
SIGNATURE_B64=$(
  printf '%s' "$DATA" \
    | openssl dgst -sha256 -sign "$PRIVATE_KEY" \
    | base64url
)

# Final JWT
JWT="${DATA}.${SIGNATURE_B64}"

echo "$JWT"