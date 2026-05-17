#!/usr/bin/env bash
# ============================================================================
#  KitPass Server — Update & Deploy Script (Ubuntu/Debian)
#
#  HOW IT WORKS:
#    1. Upload "update_server.zip" to the server/ directory
#    2. Run this script — it detects the zip, extracts new files,
#       backs up old ones, and updates everything safely.
#    3. Your .env, SSL certs, and database are NEVER overwritten.
#    4. Missing .env variables are auto-generated (no prompts).
#
#  Usage:
#    chmod +x update-server.sh
#    ./update-server.sh
# ============================================================================

set -euo pipefail

# ── Colors ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

log()   { echo -e "${GREEN}[✔]${NC} $1"; }
warn()  { echo -e "${YELLOW}[!]${NC} $1"; }
err()   { echo -e "${RED}[✘]${NC} $1"; }
info()  { echo -e "${CYAN}[→]${NC} $1"; }
header(){ echo -e "\n${BOLD}━━━ $1 ━━━${NC}"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

ZIP_NAME="update_server.zip"
BACKUP_DIR="$SCRIPT_DIR/.backups/$(date +%Y%m%d_%H%M%S)"
EXTRACT_DIR=$(mktemp -d)

# Files/dirs that will NEVER be overwritten
PROTECTED=(
    ".env"
    "nginx/ssl"
    "node_modules"
    ".backups"
    "update-server.sh"
)

# Cleanup temp dir on exit
trap "rm -rf '$EXTRACT_DIR'" EXIT

# ── 0. Pre-flight checks ───────────────────────────────────────────────────
header "Pre-flight Checks"

if ! command -v docker &>/dev/null; then
    err "Docker is not installed. Install it first:"
    echo "  sudo apt-get update && sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin"
    exit 1
fi
log "Docker: $(docker --version | head -1)"

if ! docker compose version &>/dev/null; then
    err "Docker Compose v2 plugin not found."
    echo "  sudo apt-get install -y docker-compose-plugin"
    exit 1
fi
log "Compose: $(docker compose version --short)"

if ! command -v unzip &>/dev/null; then
    err "unzip is not installed."
    echo "  sudo apt-get install -y unzip"
    exit 1
fi
log "unzip available"

# ── 1. Detect update_server.zip ────────────────────────────────────────────
header "Detecting Update Package"

if [ ! -f "$SCRIPT_DIR/$ZIP_NAME" ]; then
    err "No $ZIP_NAME found in $SCRIPT_DIR"
    echo ""
    info "To update, upload your new server files as a zip:"
    echo "    1. Zip your updated server/ folder → $ZIP_NAME"
    echo "    2. Upload it to: $SCRIPT_DIR/$ZIP_NAME"
    echo "    3. Run this script again"
    echo ""
    echo "  Example (from dev machine):"
    echo "    cd kitsune-chrome-ext"
    echo "    zip -r update_server.zip server/ -x 'server/node_modules/*' 'server/.env' 'server/nginx/ssl/*' 'server/.backups/*'"
    echo "    scp update_server.zip user@yourserver:$SCRIPT_DIR/"
    exit 1
fi

log "Found $ZIP_NAME ($(du -h "$SCRIPT_DIR/$ZIP_NAME" | cut -f1))"

# ── 2. Extract to temp directory ────────────────────────────────────────────
header "Extracting Update Package"

unzip -qo "$SCRIPT_DIR/$ZIP_NAME" -d "$EXTRACT_DIR"

# Detect the root folder inside the zip
if [ -d "$EXTRACT_DIR/server" ]; then
    SOURCE_DIR="$EXTRACT_DIR/server"
    log "Detected zip structure: server/ subfolder"
elif [ -d "$EXTRACT_DIR/src" ]; then
    SOURCE_DIR="$EXTRACT_DIR"
    log "Detected zip structure: flat (files at root)"
else
    FOUND_SRC=$(find "$EXTRACT_DIR" -type d -name "src" -maxdepth 3 | head -1)
    if [ -n "$FOUND_SRC" ]; then
        SOURCE_DIR="$(dirname "$FOUND_SRC")"
        log "Detected zip structure: nested in $(basename "$SOURCE_DIR")/"
    else
        err "Cannot find server source files in the zip. Expected a src/ directory."
        ls -la "$EXTRACT_DIR/"
        exit 1
    fi
fi

# List what we found
echo ""
info "Files found in update package:"
find "$SOURCE_DIR" -type f | sed "s|$SOURCE_DIR/|    |" | head -40
TOTAL_FILES=$(find "$SOURCE_DIR" -type f | wc -l)
echo "    ... ($TOTAL_FILES files total)"

# ── 3. Create backup of current files ──────────────────────────────────────
header "Backing Up Current Files"

mkdir -p "$BACKUP_DIR"

EXCLUDE_ARGS=""
for P in "${PROTECTED[@]}"; do
    EXCLUDE_ARGS="$EXCLUDE_ARGS --exclude=$P"
done

tar cf "$BACKUP_DIR/server_backup.tar" $EXCLUDE_ARGS \
    --exclude="*.zip" \
    --exclude="dist" \
    -C "$SCRIPT_DIR" . 2>/dev/null || true

log "Backup → $BACKUP_DIR/server_backup.tar"

if [ -f "$SCRIPT_DIR/.env" ]; then
    cp "$SCRIPT_DIR/.env" "$BACKUP_DIR/.env.bak"
    log "Separate .env backup saved"
fi

# ── 3.5 Stop Existing Containers ───────────────────────────────────────────
header "Cleaning Up Old Containers"

# Find our explicit ENV file if it exists
ENV_ARGS=""
if [ -f "$SCRIPT_DIR/.env" ]; then
    ENV_ARGS="--env-file $SCRIPT_DIR/.env"
fi

if [ -f "docker-compose.prod.yml" ]; then
    docker compose $ENV_ARGS -f docker-compose.prod.yml down --remove-orphans 2>/dev/null && log "Stopped old production stack" || true
fi
docker compose $ENV_ARGS down --remove-orphans 2>/dev/null && log "Stopped old dev stack" || true

# Aggressive cleanup: Force kill ANY container currently holding our ports
# This permanently fixes the "Bind for 0.0.0.0:80 failed" error
for port in 80 443 3000; do
    BLOCKING=$(docker ps -q --filter "publish=$port" 2>/dev/null || true)
    if [ -n "$BLOCKING" ]; then
        warn "Port $port is locked by an old container. Forcing removal..."
        docker rm -f $BLOCKING >/dev/null 2>&1 || true
        log "Freed port $port"
    fi
done

# ── 4. Apply file updates ──────────────────────────────────────────────────
header "Applying Updates"

UPDATED=0
SKIPPED=0
ADDED=0

while IFS= read -r -d '' file; do
    REL_PATH="${file#$SOURCE_DIR/}"

    # Skip protected files
    SKIP=false
    for P in "${PROTECTED[@]}"; do
        if [[ "$REL_PATH" == "$P" ]] || [[ "$REL_PATH" == "$P/"* ]]; then
            SKIP=true
            break
        fi
    done

    if $SKIP; then
        warn "Protected — skipped: $REL_PATH (This is normal so we don't overwrite your existing data/config)"
        SKIPPED=$((SKIPPED + 1))
        continue
    fi

    TARGET="$SCRIPT_DIR/$REL_PATH"
    TARGET_DIR=$(dirname "$TARGET")
    mkdir -p "$TARGET_DIR"

    if [ -f "$TARGET" ]; then
        OLD_HASH=$(md5sum "$TARGET" 2>/dev/null | cut -d' ' -f1 || echo "none")
        NEW_HASH=$(md5sum "$file" | cut -d' ' -f1)

        if [ "$OLD_HASH" = "$NEW_HASH" ]; then
            continue
        fi

        cp "$file" "$TARGET"
        log "Updated: $REL_PATH"
        UPDATED=$((UPDATED + 1))
    else
        cp "$file" "$TARGET"
        log "Added:   $REL_PATH"
        ADDED=$((ADDED + 1))
    fi
done < <(find "$SOURCE_DIR" -type f -print0)

echo ""
info "Summary: ${UPDATED} updated, ${ADDED} added, ${SKIPPED} protected (skipped)"

# Ensure scripts are executable
[ -f "$SCRIPT_DIR/entrypoint.sh" ] && chmod +x "$SCRIPT_DIR/entrypoint.sh"

# ── 5. Auto-patch .env — add ALL missing variables ─────────────────────────
header "Auto-Patching .env"

# If no .env exists at all, create from .env.example or from scratch
if [ ! -f "$SCRIPT_DIR/.env" ]; then
    if [ -f "$SCRIPT_DIR/.env.example" ]; then
        cp "$SCRIPT_DIR/.env.example" "$SCRIPT_DIR/.env"
        log "Created .env from .env.example"
    else
        touch "$SCRIPT_DIR/.env"
        log "Created empty .env"
    fi
fi

# Fix Windows line endings (CRLF -> LF) to prevent variable parsing bugs
sed -i 's/\r$//' "$SCRIPT_DIR/.env" 2>/dev/null || true

# ── Helper: add a variable if it doesn't exist ──────────────────────────────
add_env_var() {
    local KEY="$1"
    local DEFAULT="$2"
    local COMMENT="${3:-}"

    if ! grep -q "^${KEY}=" "$SCRIPT_DIR/.env"; then
        if [ -n "$COMMENT" ]; then
            echo "${KEY}=${DEFAULT}     ${COMMENT}" >> "$SCRIPT_DIR/.env"
        else
            echo "${KEY}=${DEFAULT}" >> "$SCRIPT_DIR/.env"
        fi
        log "Added: ${KEY}=${DEFAULT}"
    fi
}

GENERATED_SECRETS=""

# ── Helper: auto-generate a secret if the value is empty ────────────────────
ensure_secret() {
    local KEY="$1"
    local VAL

    # Add the key if it doesn't exist at all
    if ! grep -q "^${KEY}=" "$SCRIPT_DIR/.env"; then
        local GENERATED
        GENERATED=$(openssl rand -hex 32)
        echo "${KEY}=${GENERATED}" >> "$SCRIPT_DIR/.env"
        log "Generated: ${KEY} (new)"
        GENERATED_SECRETS="${GENERATED_SECRETS}\n      ${KEY}=${GENERATED}"
        return
    fi

    # If it exists but is empty, fill it. We tr -d '\r' to prevent invisible carriage returns from breaking the check.
    VAL=$(grep "^${KEY}=" "$SCRIPT_DIR/.env" | cut -d'=' -f2- | sed 's/#.*//' | tr -d '\r' | xargs 2>/dev/null || echo "")
    
    if [ -z "$VAL" ]; then
        local GENERATED
        GENERATED=$(openssl rand -hex 32)
        sed -i "s|^${KEY}=.*|${KEY}=${GENERATED}|" "$SCRIPT_DIR/.env"
        log "Generated: ${KEY} (was empty)"
        GENERATED_SECRETS="${GENERATED_SECRETS}\n      ${KEY}=${GENERATED}"
    else
        log "OK: ${KEY} already set"
    fi
}

echo ""

# ── Project name (drives Docker prefix) ─────────────────────────────────────
add_env_var "COMPOSE_PROJECT_NAME" "kitpass" "# Docker prefix for volumes/networks"

# ── Required secrets — auto-generate if missing or empty ─────────────────────
ensure_secret "DB_PASSWORD"
ensure_secret "JWT_SECRET"
ensure_secret "SERVER_ENCRYPTION_KEY"
ensure_secret "REDIS_PASSWORD"

# ── Optional vars with defaults ──────────────────────────────────────────────
add_env_var "DOMAIN" "localhost"
add_env_var "NODE_ENV" "production"
add_env_var "PORT" "3000"
add_env_var "DB_HOST" "db"
add_env_var "DB_PORT" "5432"
add_env_var "DB_NAME" "kitpass"
add_env_var "DB_USER" "kitpass"
add_env_var "LOGIN_RATE_LIMIT" "5"
add_env_var "LOGIN_RATE_WINDOW" "900"
add_env_var "GLOBAL_RATE_LIMIT" "100"
add_env_var "GLOBAL_RATE_WINDOW" "60"
add_env_var "ACCESS_TOKEN_EXPIRY" "900"
add_env_var "REFRESH_TOKEN_EXPIRY" "604800"
add_env_var "ARGON2_TIME_COST" "3"
add_env_var "ARGON2_MEMORY" "65536"
add_env_var "ARGON2_PARALLELISM" "4"

# ── Fix REDIS_URL if it doesn't include password ────────────────────────────
if ! grep -q "^REDIS_URL=" "$SCRIPT_DIR/.env"; then
    echo 'REDIS_URL=redis://:${REDIS_PASSWORD}@redis:6379' >> "$SCRIPT_DIR/.env"
    log "Added: REDIS_URL (with password)"
else
    CURRENT_REDIS_URL=$(grep "^REDIS_URL=" "$SCRIPT_DIR/.env" | cut -d'=' -f2-)
    if [[ "$CURRENT_REDIS_URL" == "redis://redis:6379" ]]; then
        sed -i 's|^REDIS_URL=.*|REDIS_URL=redis://:${REDIS_PASSWORD}@redis:6379|' "$SCRIPT_DIR/.env"
        log "Fixed: REDIS_URL (added password)"
    else
        log "OK: REDIS_URL"
    fi
fi

# ── 6. Migrate old Docker volumes ──────────────────────────────────────────
header "Docker Volume Migration Check"

# Read COMPOSE_PROJECT_NAME without evaluating the rest of the file
PROJECT=$(grep "^COMPOSE_PROJECT_NAME=" "$SCRIPT_DIR/.env" 2>/dev/null | head -n 1 | cut -d'=' -f2 | sed 's/#.*//' | awk '{print $1}' | tr -d '"'\''\r')
PROJECT="${PROJECT:-kitpass}"
NEW_VOLUME="${PROJECT}_pgdata"

# Find old volumes from any previous project name
OLD_VOLUME_FOUND=""
for CANDIDATE in "server_pgdata" "server_kitpass_pgdata" "kitpass_pgdata" "pgdata"; do
    if docker volume inspect "$CANDIDATE" &>/dev/null; then
        if [ "$CANDIDATE" != "$NEW_VOLUME" ]; then
            OLD_VOLUME_FOUND="$CANDIDATE"
            break
        fi
    fi
done

if [ -n "$OLD_VOLUME_FOUND" ]; then
    if docker volume inspect "$NEW_VOLUME" &>/dev/null; then
        warn "Both $OLD_VOLUME_FOUND and $NEW_VOLUME exist — skipping (manual check needed)"
    else
        info "Migrating volume: $OLD_VOLUME_FOUND → $NEW_VOLUME"
        docker volume create "$NEW_VOLUME" >/dev/null
        docker run --rm \
            -v "$OLD_VOLUME_FOUND":/from \
            -v "$NEW_VOLUME":/to \
            alpine sh -c "cp -a /from/. /to/"
        log "Volume data copied: $OLD_VOLUME_FOUND → $NEW_VOLUME"
        warn "Old volume preserved. Remove after verifying: docker volume rm $OLD_VOLUME_FOUND"
    fi
else
    log "No old volumes to migrate"
fi

# ── 7. Rebuild → Start ──────────────────────────────────────────────────
header "Rebuilding Containers"

# Ensure docker-compose sees our newly generated variables from .env
# by explicitly passing it during the up command.
ENV_ARGS="--env-file $SCRIPT_DIR/.env"

# Choose stack based on SSL certs
if [ -f "nginx/ssl/origin.pem" ] && [ -f "nginx/ssl/origin-key.pem" ]; then
    info "SSL certificates detected → Production mode"
    docker compose $ENV_ARGS -f docker-compose.prod.yml up -d --build
    COMPOSE_FILE="docker-compose.prod.yml"
else
    warn "No SSL certs → Development mode"
    docker compose $ENV_ARGS up -d
    COMPOSE_FILE="docker-compose.yml"
fi

log "Containers started"

# ── 8. Health check ─────────────────────────────────────────────────────────
header "Waiting for Services"

MAX_WAIT=60
WAITED=0
ALL_HEALTHY=false

while [ $WAITED -lt $MAX_WAIT ]; do
    UNHEALTHY=$(docker compose -f "$COMPOSE_FILE" ps --format json 2>/dev/null | grep -c '"unhealthy"\|"starting"' || true)
    if [ "$UNHEALTHY" -eq 0 ] 2>/dev/null; then
        ALL_HEALTHY=true
        break
    fi
    sleep 2
    WAITED=$((WAITED + 2))
    printf "\r  Waiting... %ds / %ds" "$WAITED" "$MAX_WAIT"
done
echo ""

if $ALL_HEALTHY; then
    log "All services healthy"
else
    warn "Timeout — some services may still be starting"
fi

# ── 9. Show results ───────────────────────────────────────────────────────
header "Service Status"
docker compose -f "$COMPOSE_FILE" ps
echo ""

sleep 2
if curl -sf http://localhost:3000/api/health >/dev/null 2>&1; then
    HEALTH=$(curl -s http://localhost:3000/api/health)
    log "API health: $HEALTH"
elif [ "$COMPOSE_FILE" = "docker-compose.prod.yml" ]; then
    info "API behind Nginx — try: curl -k https://localhost/api/health"
fi

# ── 10. Cleanup zip ────────────────────────────────────────────────────────
header "Cleanup"

rm -f "$SCRIPT_DIR/$ZIP_NAME"
log "Deleted $ZIP_NAME"

# ── Done ────────────────────────────────────────────────────────────────────
header "Update Complete ✓"
echo ""
info "Project name:    ${PROJECT}"
info "Files updated:   ${UPDATED}"
info "Files added:     ${ADDED}"
info "Files skipped:   ${SKIPPED} (protected)"
info "Backup location: ${BACKUP_DIR}/"
info "Compose file:    ${COMPOSE_FILE}"
echo ""
info "Docker resources:"
echo "    Volume:  ${NEW_VOLUME}"
echo "    Network: ${PROJECT}_internal"
echo ""
info "Commands:"
echo "    docker compose -f $COMPOSE_FILE logs -f api      # View logs"
echo "    docker compose -f $COMPOSE_FILE ps                # Status"
echo "    docker compose -f $COMPOSE_FILE restart api       # Restart API"
echo ""

if [ -n "$GENERATED_SECRETS" ]; then
    echo -e "${YELLOW}========================================================================${NC}"
    echo -e "${BOLD}                     NEW SECRETS GENERATED!                             ${NC}"
    echo -e "${YELLOW}========================================================================${NC}"
    echo -e "We noticed some required passwords were empty or missing."
    echo -e "We auto-generated them for you. They are saved in your .env file."
    echo -e "Please keep these safe!"
    echo -e "${CYAN}${GENERATED_SECRETS}${NC}"
    echo -e "${YELLOW}========================================================================${NC}"
fi

echo ""
info "Rollback: tar xf $BACKUP_DIR/server_backup.tar -C $SCRIPT_DIR"
