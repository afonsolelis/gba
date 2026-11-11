#!/usr/bin/env bash
# Copia o server.mjs para a VPS e reinicia o serviço gba-api no Coolify.
# Credenciais vêm de ~/repos/hostinger/.env (HOSTINGER_*, COOLIFY_*, GBA_COOLIFY_SERVICE).
set -euo pipefail
cd "$(dirname "$0")"
set -a; . ~/repos/hostinger/.env; set +a
node --check server.mjs
scp -q -P "$HOSTINGER_PORT" -i "${HOSTINGER_SSH_KEY/#\~/$HOME}" server.mjs "$HOSTINGER_USER@$HOSTINGER_HOST:/data/gba/api/server.mjs"
curl -fsS -X POST -H "Authorization: Bearer $COOLIFY_TOKEN" "$COOLIFY_URL/api/v1/services/$GBA_COOLIFY_SERVICE/restart" >/dev/null
echo "reiniciando… https://gba-api.afonsolelis.tech/health"
