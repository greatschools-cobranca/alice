#!/bin/sh
# Mantém a ponte rodando sem systemd: reinicia sozinha se o processo cair.
# Use com o supervisor que já cuida do gateway (supervisord, pm2, s6, entrypoint do container...).
#
#   NODE_BIN   caminho do node (padrão: o primeiro "node" do PATH; neste servidor: /usr/local/bin/node)
#   PONTE_DIR  pasta da ponte (padrão: pasta deste script)
#
# Código de saída 2 (configuração faltando) ou 3 (chave recusada pela Torre) NÃO reinicia:
# são erros que exigem correção manual, e reiniciar em laço só encheria o log.
set -u
PONTE_DIR="${PONTE_DIR:-$(cd "$(dirname "$0")" && pwd)}"
NODE_BIN="${NODE_BIN:-$(command -v node || echo /usr/local/bin/node)}"

while true; do
  "$NODE_BIN" "$PONTE_DIR/ponte-torre.mjs"
  code=$?
  if [ "$code" -eq 2 ] || [ "$code" -eq 3 ]; then
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) ponte parou com erro de configuração (código $code); corrija e reinicie" >&2
    exit "$code"
  fi
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) ponte saiu (código $code); reiniciando em 10 s" >&2
  sleep 10
done
