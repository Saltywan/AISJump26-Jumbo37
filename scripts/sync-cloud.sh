#!/usr/bin/env bash
# ==============================================================================
# sync-cloud.sh - Safe Sync & Deployment Script for JumpAIS Cloud VM
# ==============================================================================
# Usage:
#   ./scripts/sync-cloud.sh              # Sync code safely (no .env, no exports)
#   ./scripts/sync-cloud.sh --dry-run    # Preview what files will be copied
#   ./scripts/sync-cloud.sh --rebuild    # Sync code and rebuild web & worker
#   ./scripts/sync-cloud.sh --restart    # Sync code and restart all containers
#   ./scripts/sync-cloud.sh --pull-media # Pull exports/ from cloud to local
# ==============================================================================

set -euo pipefail

REMOTE_USER="ubuntu"
REMOTE_HOST="168.107.139.50"
REMOTE_DEST="~/jumpais-app/"
SSH_KEY="${HOME}/.ssh/ais_alloy"
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Ensure SSH key exists
if [[ ! -f "$SSH_KEY" ]]; then
    echo "❌ Error: SSH key not found at $SSH_KEY"
    exit 1
fi

ACTION="sync"
DRY_RUN=""
SERVICE_REBUILD=""

for arg in "$@"; do
    case "$arg" in
        --dry-run)
            DRY_RUN="--dry-run"
            ;;
        --rebuild)
            SERVICE_REBUILD="rebuild"
            ;;
        --restart)
            SERVICE_REBUILD="restart"
            ;;
        --pull-media)
            ACTION="pull-media"
            ;;
        --help|-h)
            echo "Usage: $0 [--dry-run] [--rebuild] [--restart] [--pull-media]"
            exit 0
            ;;
        *)
            echo "Unknown option: $arg"
            echo "Usage: $0 [--dry-run] [--rebuild] [--restart] [--pull-media]"
            exit 1
            ;;
    esac
done

if [[ "$ACTION" == "pull-media" ]]; then
    echo "📥 Pulling media exports from cloud ($REMOTE_HOST)..."
    mkdir -p "$PROJECT_ROOT/exports"
    rsync -avz -e "ssh -i $SSH_KEY -o StrictHostKeyChecking=no" \
        "$REMOTE_USER@$REMOTE_HOST:~/jumpais-app/exports/" "$PROJECT_ROOT/exports/"
    echo "✅ Media exports synced to local exports/"
    exit 0
fi

echo "🚀 Preparing safe sync to $REMOTE_USER@$REMOTE_HOST..."
echo "🔒 Safety guards enabled:"
echo "   - .env is PROTECTED (Cloud IP and configs will NOT be overwritten)"
echo "   - exports/ is PROTECTED (Remote animations & videos will NOT be overwritten)"
echo "   - .git, node_modules, and virtualenvs are excluded"
echo "   - docker-compose.override.yml is excluded (dev flags stay local)"

# Rsync flags:
# - NEVER use --delete without explicit confirmation
# - EXCLUDE .env so server config (VITE_API_URL, COOKIE_SAMESITE, etc.) is preserved
RSYNC_EXCLUDES=(
    --exclude '.env'
    --exclude '.env.*'
    --exclude 'exports/'
    --exclude '.git/'
    --exclude 'node_modules/'
    --exclude '.venv/'
    --exclude 'venv/'
    --exclude '__pycache__/'
    --exclude '.DS_Store'
    --exclude 'docker-compose.override.yml'
    --exclude 'tmpimages/'
    --exclude 'storage/'
    --exclude 'published/'
)

rsync -avz $DRY_RUN "${RSYNC_EXCLUDES[@]}" \
    -e "ssh -i $SSH_KEY -o StrictHostKeyChecking=no" \
    "$PROJECT_ROOT/" "$REMOTE_USER@$REMOTE_HOST:$REMOTE_DEST"

if [[ -n "$DRY_RUN" ]]; then
    echo "🔍 Dry run completed. No remote files were changed."
    exit 0
fi

echo "✅ Code synced successfully!"

if [[ "$SERVICE_REBUILD" == "rebuild" ]]; then
    echo "🔄 Rebuilding and updating web & worker containers..."
    ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no "$REMOTE_USER@$REMOTE_HOST" \
        "cd ~/jumpais-app && docker compose up -d --build web worker"
    echo "✅ Web and worker containers rebuilt and live!"
elif [[ "$SERVICE_REBUILD" == "restart" ]]; then
    echo "🔄 Restarting all containers on server..."
    ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no "$REMOTE_USER@$REMOTE_HOST" \
        "cd ~/jumpais-app && docker compose restart"
    echo "✅ Containers restarted!"
else
    echo "ℹ️  To restart containers on remote server, run:"
    echo "   ssh -i $SSH_KEY $REMOTE_USER@$REMOTE_HOST 'cd ~/jumpais-app && docker compose up -d --build web worker'"
fi
