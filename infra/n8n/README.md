# n8n en el VPS

Instala n8n con PostgreSQL y HTTPS automático (Caddy + Let's Encrypt) usando Docker.
Probado para Ubuntu 22.04/24.04 y Debian 12. Mínimo recomendado: 2 GB de RAM.

## 1. Antes

- En tu DNS, crea un registro **A** `n8n.tudominio.cl` → IP del VPS.
- Tener acceso SSH como root (o un usuario con `sudo`).

## 2. Instalar

Desde tu computador, copia el script al VPS:

```bash
scp infra/n8n/instalar.sh root@IP_DEL_VPS:/root/
```

Luego, en el VPS:

```bash
ssh root@IP_DEL_VPS
bash /root/instalar.sh n8n.tudominio.cl tu@correo.cl
```

Al terminar, abre `https://n8n.tudominio.cl` y **crea de inmediato la cuenta de dueño**
(quien entra primero queda como dueño).

## Qué hace

1. Instala Docker si no está.
2. Avisa si el dominio todavía no apunta al VPS.
3. Crea `/opt/n8n` con `docker-compose.yml`, `Caddyfile` y `.env` (contraseñas y clave de cifrado generadas al azar).
4. Abre los puertos 22, 80 y 443 si hay UFW.
5. Levanta `postgres`, `n8n` y `caddy`.

Zona horaria por defecto: `America/Santiago` (cámbiala con `N8N_TZ=... bash instalar.sh ...`).

## Mantenimiento

```bash
cd /opt/n8n && docker compose pull && docker compose up -d   # actualizar
cd /opt/n8n && docker compose logs -f n8n                    # ver logs
```

Respaldo de la base de datos:

```bash
cd /opt/n8n && docker compose exec -T postgres pg_dump -U n8n n8n > respaldo-$(date +%F).sql
```

**Guarda una copia de `/opt/n8n/.env` fuera del VPS.** Sin `N8N_ENCRYPTION_KEY` no se pueden
descifrar las credenciales guardadas en n8n.

## Pasar los flujos desde n8n Cloud

En la instancia Cloud: abre cada flujo → menú `⋯` → *Download* (JSON) y, en el VPS, *Import from file*.
Las credenciales no viajan con el JSON: hay que volver a crearlas en la instancia nueva.
