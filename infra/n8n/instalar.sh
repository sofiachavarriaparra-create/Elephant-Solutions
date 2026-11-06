#!/usr/bin/env bash
# Instala n8n en un VPS Ubuntu/Debian con Docker, PostgreSQL y HTTPS automático (Caddy).
#
# Uso (como root en el VPS):
#   bash instalar.sh n8n.tudominio.cl tu@correo.cl
#
# Antes de correrlo, el dominio debe tener un registro A apuntando a la IP del VPS.
# Se puede volver a correr para actualizar: conserva el .env (y la clave de cifrado).
set -euo pipefail

DIR="${N8N_DIR:-/opt/n8n}"
DOMINIO="${1:-}"
EMAIL="${2:-}"
ZONA="${N8N_TZ:-America/Santiago}"

err() { echo "ERROR: $*" >&2; exit 1; }
info() { echo "==> $*"; }

[ "$(id -u)" -eq 0 ] || err "Corre este script como root (o con sudo)."

if [ -z "$DOMINIO" ]; then read -rp "Dominio para n8n (ej. n8n.tudominio.cl): " DOMINIO; fi
if [ -z "$EMAIL" ]; then read -rp "Correo para el certificado HTTPS: " EMAIL; fi
[ -n "$DOMINIO" ] && [ -n "$EMAIL" ] || err "Faltan dominio o correo."

# 1. Docker
if ! command -v docker >/dev/null 2>&1; then
  info "Instalando Docker..."
  command -v curl >/dev/null 2>&1 || { apt-get update -y && apt-get install -y curl; }
  curl -fsSL https://get.docker.com | sh
fi
docker compose version >/dev/null 2>&1 || err "Falta el plugin 'docker compose'."
systemctl enable --now docker >/dev/null 2>&1 || true

# 2. Revisión de DNS (solo aviso)
IP_VPS="$(curl -fsS https://api.ipify.org 2>/dev/null || true)"
IP_DNS="$(getent ahostsv4 "$DOMINIO" 2>/dev/null | awk 'NR==1{print $1}' || true)"
if [ -n "$IP_VPS" ] && [ "$IP_VPS" != "$IP_DNS" ]; then
  echo "AVISO: $DOMINIO resuelve a '${IP_DNS:-nada}' y este VPS es $IP_VPS."
  echo "       Sin el registro A correcto, el certificado HTTPS no se emitirá."
  read -rp "¿Continuar igual? [s/N] " r; [[ "$r" =~ ^[sS]$ ]] || exit 1
fi

# 3. Archivos
mkdir -p "$DIR"
cd "$DIR"

if [ ! -f .env ]; then
  info "Generando .env con claves nuevas..."
  umask 077
  cat > .env <<EOF
N8N_HOST=$DOMINIO
ACME_EMAIL=$EMAIL
GENERIC_TIMEZONE=$ZONA
POSTGRES_USER=n8n
POSTGRES_DB=n8n
POSTGRES_PASSWORD=$(openssl rand -hex 24)
# No cambies ni pierdas esta clave: cifra las credenciales guardadas en n8n.
N8N_ENCRYPTION_KEY=$(openssl rand -hex 32)
EOF
  umask 022
else
  info ".env ya existe: se conserva (actualizando dominio y correo)."
  sed -i "s|^N8N_HOST=.*|N8N_HOST=$DOMINIO|; s|^ACME_EMAIL=.*|ACME_EMAIL=$EMAIL|" .env
fi

cat > docker-compose.yml <<'EOF'
services:
  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: ${POSTGRES_DB}
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER} -d ${POSTGRES_DB}"]
      interval: 5s
      timeout: 5s
      retries: 10

  n8n:
    image: docker.n8n.io/n8nio/n8n:latest
    restart: unless-stopped
    depends_on:
      postgres:
        condition: service_healthy
    environment:
      DB_TYPE: postgresdb
      DB_POSTGRESDB_HOST: postgres
      DB_POSTGRESDB_PORT: 5432
      DB_POSTGRESDB_DATABASE: ${POSTGRES_DB}
      DB_POSTGRESDB_USER: ${POSTGRES_USER}
      DB_POSTGRESDB_PASSWORD: ${POSTGRES_PASSWORD}
      N8N_ENCRYPTION_KEY: ${N8N_ENCRYPTION_KEY}
      N8N_HOST: ${N8N_HOST}
      N8N_PORT: 5678
      N8N_PROTOCOL: https
      WEBHOOK_URL: https://${N8N_HOST}/
      N8N_PROXY_HOPS: 1
      GENERIC_TIMEZONE: ${GENERIC_TIMEZONE}
      TZ: ${GENERIC_TIMEZONE}
      N8N_RUNNERS_ENABLED: "true"
      N8N_ENFORCE_SETTINGS_FILE_PERMISSIONS: "true"
      EXECUTIONS_DATA_PRUNE: "true"
      EXECUTIONS_DATA_MAX_AGE: 336
    volumes:
      - n8n_data:/home/node/.n8n

  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    depends_on:
      - n8n
    ports:
      - "80:80"
      - "443:443"
      - "443:443/udp"
    environment:
      N8N_HOST: ${N8N_HOST}
      ACME_EMAIL: ${ACME_EMAIL}
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config

volumes:
  postgres_data:
  n8n_data:
  caddy_data:
  caddy_config:
EOF

cat > Caddyfile <<'EOF'
{
	email {$ACME_EMAIL}
}

{$N8N_HOST} {
	encode gzip
	reverse_proxy n8n:5678
}
EOF

# 4. Firewall (si hay UFW)
if command -v ufw >/dev/null 2>&1; then
  info "Abriendo puertos 22, 80 y 443 en UFW..."
  ufw allow OpenSSH >/dev/null; ufw allow 80/tcp >/dev/null; ufw allow 443 >/dev/null
  ufw --force enable >/dev/null
fi

# 5. Levantar
info "Descargando imágenes y levantando n8n..."
docker compose pull
docker compose up -d

echo
echo "Listo. Abre https://$DOMINIO y crea la cuenta de dueño (el primero que entra lo es: hazlo ya)."
echo "Archivos en $DIR  ·  Logs: cd $DIR && docker compose logs -f n8n"
echo "Respalda $DIR/.env: sin N8N_ENCRYPTION_KEY no se pueden recuperar las credenciales."
