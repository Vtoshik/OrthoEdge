#!/usr/bin/env bash
# Local HTTPS cert. Prefers mkcert (trusted by phones once its root CA is installed); falls back to self-signed openssl.
set -euo pipefail
cd "$(dirname "$0")/.."; mkdir -p data/certs
IP=$(hostname -I | awk '{print $1}')
if command -v mkcert >/dev/null; then mkcert -key-file data/certs/key.pem -cert-file data/certs/cert.pem "$IP" localhost 127.0.0.1
else openssl req -x509 -newkey rsa:2048 -nodes -days 7 -keyout data/certs/key.pem -out data/certs/cert.pem -subj "/CN=tele-rehab-demo" -addext "subjectAltName=IP:$IP,DNS:localhost,IP:127.0.0.1" 2>/dev/null
echo "self-signed cert (mkcert not installed): phones must accept the browser warning"; fi
echo "cert for $IP in data/certs"
