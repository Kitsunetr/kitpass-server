# KitPass Server

Zero-Knowledge encrypted password manager API — Node.js/Fastify backend with PostgreSQL and Redis. If you use it updated-server.sh you must create updated-server.zip file include in "root/server/updated-server.zip"

[Chrome Web Store](https://chromewebstore.google.com/detail/ecdkkkcddldncfhpphnoggkijligoile?utm_source=item-share-cb)
---

## Prerequisites

| Tool | Minimum Version |
|------|----------------|
| [Docker](https://docs.docker.com/get-docker/) | 24.0+ |
| [Docker Compose](https://docs.docker.com/compose/install/) | v2.20+ |
| [Git](https://git-scm.com/) | 2.40+ |

### Installing Docker

#### Ubuntu / Debian

```bash
# Remove old versions
sudo apt-get remove docker docker-engine docker.io containerd runc 2>/dev/null

# Install prerequisites
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg

# Add Docker's official GPG key
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg

# Add the repository
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

# Install Docker Engine + Compose plugin
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# (Optional) Run Docker without sudo
sudo usermod -aG docker $USER
newgrp docker

# Verify
docker --version
docker compose version
```

#### Verify Installation

```bash
docker --version          # Should show 24.0+
docker compose version    # Should show v2.20+
```

> **Note:** If you already have Docker installed, skip the installation above and just verify your version meets the requirements.

---

## Environment Configuration

Copy the example and fill in your secrets:

```bash
cp .env.example .env
```

### Required Values

Generate each secret with `openssl`:

```bash
# 1. Database password
openssl rand -hex 32

# 2. JWT signing secret
openssl rand -hex 32

# 3. Server-side envelope encryption key (exactly 64 hex chars = 256 bits)
openssl rand -hex 32

# 4. Redis authentication password
openssl rand -hex 32
```

Paste the generated values into your `.env` file:

```env
# === Project ===
COMPOSE_PROJECT_NAME=myproject     # Docker prefix for volumes/networks

# === Required ===
DOMAIN=example.com
DB_PASSWORD=<paste-value-1>
JWT_SECRET=<paste-value-2>
SERVER_ENCRYPTION_KEY=<paste-value-3>
REDIS_PASSWORD=<paste-value-4>
```

> **Tip:** `COMPOSE_PROJECT_NAME` controls Docker resource naming. If you set it to `kitpass`, your volume will be `kitpass_pgdata`, your networks `kitpass_internal`, etc.

### Optional Values (defaults shown)

```env
NODE_ENV=production
PORT=3000
DB_HOST=db
DB_PORT=5432
DB_NAME=myproject
DB_USER=myproject
REDIS_URL=redis://:${REDIS_PASSWORD}@redis:6379
LOGIN_RATE_LIMIT=5
LOGIN_RATE_WINDOW=900
GLOBAL_RATE_LIMIT=100
GLOBAL_RATE_WINDOW=60
ACCESS_TOKEN_EXPIRY=900
REFRESH_TOKEN_EXPIRY=604800
```

| Variable | Description | Default |
|----------|-------------|---------|
| `COMPOSE_PROJECT_NAME` | Docker prefix for volumes/networks | `myproject` |
| `DOMAIN` | Your domain for CORS and Nginx | `example.com` |
| `DB_PASSWORD` | PostgreSQL password | **(auto-generated)** |
| `JWT_SECRET` | JWT signing key (≥32 chars) | **(auto-generated)** |
| `SERVER_ENCRYPTION_KEY` | AES-256 key (64 hex chars) | **(auto-generated)** |
| `REDIS_PASSWORD` | Redis `requirepass` value | **(auto-generated)** |
| `DB_NAME` | PostgreSQL database name | `myproject` |
| `DB_USER` | PostgreSQL user | `myproject` |
| `LOGIN_RATE_LIMIT` | Max login attempts per window | `5` |
| `LOGIN_RATE_WINDOW` | Login rate window (seconds) | `900` |
| `GLOBAL_RATE_LIMIT` | Max requests per IP per window | `100` |
| `GLOBAL_RATE_WINDOW` | Global rate window (seconds) | `60` |
| `ACCESS_TOKEN_EXPIRY` | JWT access token TTL (seconds) | `900` |
| `REFRESH_TOKEN_EXPIRY` | Refresh token TTL (seconds) | `604800` |

---

## Quick Start — Development

```bash
# Start PostgreSQL + Redis only
docker compose up -d

# Install Node.js dependencies
npm install

# Run database migrations
npm run migrate

# Start dev server (hot-reload)
npm run dev
```

The API will be available at `http://localhost:3000`.

---

## Production Deployment

### 1. SSL Certificates

Place your TLS certificates in `nginx/ssl/`:

```bash
mkdir -p nginx/ssl
# Copy your certificate files:
cp /path/to/origin.pem nginx/ssl/origin.pem
cp /path/to/origin-key.pem nginx/ssl/origin-key.pem
```

> **Cloudflare Origin Certificates** are recommended. Generate them in the Cloudflare dashboard under SSL/TLS → Origin Server.

### 2. Build & Launch

```bash
# Build and start all services (API, PostgreSQL, Redis, Nginx)
docker compose -f docker-compose.prod.yml up -d --build
```

### 3. Verify

```bash
# Check service health
docker compose -f docker-compose.prod.yml ps

# Check API health endpoint
curl -s https://your-domain.com/api/health
# → {"status":"ok","timestamp":"..."}

# View logs
docker compose -f docker-compose.prod.yml logs -f api
```

---

## Stopping & Restarting

```bash
# Stop all services
docker compose -f docker-compose.prod.yml down

# Stop and remove data volumes (⚠️ destroys database!)
docker compose -f docker-compose.prod.yml down -v

# Restart a single service
docker compose -f docker-compose.prod.yml restart api
```

---

## Updating an Existing Installation

The update script detects an `update_server.zip` file, extracts it, and applies only the changed files while **protecting** your `.env`, SSL certificates, and database.

### Step 1 — Create the update zip (on your dev machine)

```bash
cd kitsune-chrome-ext
zip -r update_server.zip server/ \
  -x 'server/node_modules/*' \
  -x 'server/.env' \
  -x 'server/nginx/ssl/*' \
  -x 'server/.backups/*' \
  -x 'server/dist/*'
```

### Step 2 — Upload to your server

```bash
scp update_server.zip user@yourserver:/path/to/server/
```

### Step 3 — Run the update script

```bash
cd /path/to/server
chmod +x update-server.sh
./update-server.sh
```

The script automatically:
- **Detects** `update_server.zip` and extracts to a temp directory
- **Backs up** all current files to `.backups/<timestamp>/`
- **Updates** only files that actually changed (md5 comparison)
- **Protects** `.env`, `nginx/ssl/`, `node_modules/` — never overwrites
- **Patches `.env`** — adds missing vars (`REDIS_PASSWORD`, `GLOBAL_RATE_LIMIT`, etc.)
- **Migrates** old Docker volumes (`pgdata` → `<project>_pgdata`)
- **Rebuilds and restarts** all Docker containers
- **Health checks** the API before finishing

> ⚠️ **Rollback:** If something goes wrong, restore from the backup:
> ```bash
> tar xf .backups/<timestamp>/server_backup.tar -C .
> ```

---

## Architecture

```
┌─────────────┐     HTTPS     ┌─────────┐     HTTP     ┌──────────┐
│   Client    │──────────────▶│  Nginx  │────────────▶│  Fastify │
│  (Chrome)   │               │ :80/443 │              │  API     │
└─────────────┘               └─────────┘              │  :3000   │
                                                       └────┬─────┘
                                                            │
                                          ┌─────────────────┼────────────────┐
                                          │                                  │
                                    ┌─────▼──────┐                   ┌──────▼─────┐
                                    │ PostgreSQL │                   │   Redis    │
                                    │   :5432    │                   │   :6379    │
                                    └────────────┘                   └────────────┘
```

- **Nginx** — TLS termination, reverse proxy, security headers
- **Fastify API** — Authentication, vault CRUD, family sharing (zero-knowledge)
- **PostgreSQL** — Persistent storage (encrypted blobs only)
- **Redis** — Rate limiting, session caching

All services communicate over the `<project>_internal` Docker network (isolated, named by `COMPOSE_PROJECT_NAME`). Only Nginx is exposed on ports 80/443.
