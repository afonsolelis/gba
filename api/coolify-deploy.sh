#!/usr/bin/env bash
# Publica uma versão num serviço do Coolify, sem SSH: manda o compose pela API,
# reinicia o serviço e espera cada URL de saúde responder {"versao": "<versao>"}.
#
#   api/coolify-deploy.sh <uuid-do-servico> <compose> <versao> <url-saude>...
#
# Precisa de COOLIFY_URL e COOLIFY_TOKEN no ambiente (secrets do repositório no GitHub).
set -euo pipefail

servico=$1 compose=$2 versao=$3
shift 3
: "${COOLIFY_URL:?faltando COOLIFY_URL}" "${COOLIFY_TOKEN:?faltando COOLIFY_TOKEN}"

api() { curl -fsS --retry 3 --max-time 30 -H "Authorization: Bearer $COOLIFY_TOKEN" "$@"; }

sed "s/__VERSAO__/$versao/g" "$compose" | base64 -w0 \
  | jq -Rn '{docker_compose_raw: input}' \
  | api -X PATCH -H 'Content-Type: application/json' -d @- "$COOLIFY_URL/api/v1/services/$servico" >/dev/null
echo "compose enviado ($versao); reiniciando $servico"
api -X POST "$COOLIFY_URL/api/v1/services/$servico/restart" >/dev/null

prazo=$((SECONDS + 300))
for url in "$@"; do
  until [ "$(curl -fsS --max-time 5 "$url" 2>/dev/null | jq -r '.versao // empty' 2>/dev/null)" = "$versao" ]; do
    if [ "$SECONDS" -ge "$prazo" ]; then
      echo "::error::$url não chegou na versão $versao em 5 min (veja os logs do serviço no Coolify)"
      exit 1
    fi
    sleep 5
  done
  echo "ok: $url está na versão $versao"
done
