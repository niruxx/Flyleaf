#!/usr/bin/env bash
# Flyleaf updater – pulls the latest code from git and restarts the service.
# Your database, covers and settings are kept (they live outside the code folder),
# and a backup of the database is taken before updating.
#
#   sudo ./update.sh            # installed with install.sh (systemd service)
#   ./update.sh                 # a manual checkout run with `npm start`
#   sudo ./update.sh --stash    # set aside files you changed by hand (git stash), then update

set -euo pipefail

STASH=no
for arg in "$@"; do
  case $arg in
    --stash) STASH=yes ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) printf 'Unknown option: %s (try --help)\n' "$arg" >&2; exit 2 ;;
  esac
done

APP=flyleaf
CONF_DIR=/etc/flyleaf
MANIFEST=$CONF_DIR/install.manifest

c_blue=$'\e[1;34m'; c_green=$'\e[1;32m'; c_yellow=$'\e[1;33m'; c_red=$'\e[1;31m'; c_off=$'\e[0m'
info() { printf '%s==>%s %s\n' "$c_blue" "$c_off" "$*"; }
ok() { printf '%s ✓%s %s\n' "$c_green" "$c_off" "$*"; }
warn() { printf '%s !%s %s\n' "$c_yellow" "$c_off" "$*"; }
die() { printf '%s ✗ %s%s\n' "$c_red" "$*" "$c_off" >&2; exit 1; }

declare -A M
if [[ -f $MANIFEST ]]; then
  while IFS='=' read -r k v; do [[ -n $k ]] && M[$k]=$v; done < "$MANIFEST"
fi

SELF_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
APP_DIR=${M[INSTALL_DIR]:-$SELF_DIR}
[[ -d $APP_DIR/.git ]] || die "$APP_DIR is not a git checkout – can't pull updates."

SERVICE=no
if [[ -f $MANIFEST ]] && systemctl list-unit-files "$APP.service" >/dev/null 2>&1; then
  SERVICE=yes
  [[ $EUID -eq 0 ]] || die "Please run with sudo: sudo $0"
fi
RUN_AS=${M[SERVICE_USER]:-$(stat -c %U "$APP_DIR")}
as_owner() {
  if [[ $EUID -eq 0 && $RUN_AS != root ]]; then runuser -u "$RUN_AS" -- env HOME="${M[DATA_DIR]:-$APP_DIR}" PATH="$PATH" "$@"; else "$@"; fi
}

# Data directory: the installer's, or FLYLEAF_DATA_DIR from .env, or ./data.
DATA_DIR=${M[DATA_DIR]:-}
if [[ -z $DATA_DIR ]]; then
  DATA_DIR=$(grep -E '^FLYLEAF_DATA_DIR=' "$APP_DIR/.env" 2>/dev/null | cut -d= -f2- || true)
  DATA_DIR=${DATA_DIR:-data}
  [[ $DATA_DIR = /* ]] || DATA_DIR=$APP_DIR/$DATA_DIR
fi

NODE_BIN=${M[NODE_BIN]:-$(command -v node || true)}
[[ -n $NODE_BIN ]] || die "Node.js not found."
NPM_BIN=$(dirname "$NODE_BIN")/npm
[[ -x $NPM_BIN ]] || NPM_BIN=$(command -v npm)
export PATH="$(dirname "$NODE_BIN"):$PATH"

printf '\n  %s🔄  Updating Flyleaf%s in %s\n\n' "$c_blue" "$c_off" "$APP_DIR"

# 1. Make sure there's something to update (and no local edits in the way).
cd "$APP_DIR"
git config --global --add safe.directory "$APP_DIR" 2>/dev/null || true
# Things the install itself changes aren't local edits: npm rewrites package-lock.json on every
# install, and the scripts' executable bits get set. Put them back / ignore them.
as_owner git config core.fileMode false
as_owner git checkout --quiet -- package-lock.json 2>/dev/null || true
changes=$(as_owner git status --porcelain --untracked-files=no)
if [[ -n $changes ]]; then
  if [[ $STASH == yes ]]; then
    as_owner git stash push --quiet --message "update.sh $(date +%F_%T)"
    warn "Your local changes were stashed – bring them back with: git -C $APP_DIR stash pop"
  else
    printf '%s\n' "$changes" | sed 's/^/     /' >&2
    die "These files in $APP_DIR were changed by hand. Run 'sudo $0 --stash' to set them aside and update, or undo them with: git -C $APP_DIR checkout -- ."
  fi
fi
before=$(git rev-parse HEAD)
info "Fetching updates…"
as_owner git fetch --quiet --tags origin
upstream=$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || echo "origin/$(git rev-parse --abbrev-ref HEAD)")
if [[ $(git rev-parse "$upstream") == "$before" ]]; then
  ok "Already up to date ($(git rev-parse --short HEAD))"
  exit 0
fi

# 2. Stop the service and back up the database.
if [[ $SERVICE == yes ]]; then
  info "Stopping the service"
  systemctl stop "$APP.service"
fi
if [[ -f $DATA_DIR/flyleaf.db ]]; then
  backup_dir=$DATA_DIR/backups
  mkdir -p "$backup_dir"
  stamp=$(date +%Y%m%d-%H%M%S)
  for f in flyleaf.db flyleaf.db-wal flyleaf.db-shm; do
    [[ -f $DATA_DIR/$f ]] && cp -p "$DATA_DIR/$f" "$backup_dir/${f/flyleaf.db/flyleaf-$stamp.db}"
  done
  [[ $EUID -eq 0 && $RUN_AS != root ]] && chown -R "$RUN_AS:" "$backup_dir"
  # Keep the five most recent backups.
  ls -1t "$backup_dir"/flyleaf-*.db 2>/dev/null | tail -n +6 | while read -r old; do rm -f "$old" "$old-wal" "$old-shm"; done
  ok "Database backed up to $backup_dir/flyleaf-$stamp.db"
fi

restore_service() {
  if [[ $SERVICE == yes ]]; then systemctl start "$APP.service" || true; fi
}
trap 'warn "Update failed – restarting the previous version"; as_owner git reset --quiet --hard "$before"; restore_service' ERR

# 3. Pull and install dependencies.
info "Pulling $(git rev-parse --short "$upstream")…"
as_owner git merge --quiet --ff-only "$upstream"
info "Installing npm packages…"
# --allow-git: the EPUB reader (foliate-js) is installed straight from GitHub.
as_owner "$NPM_BIN" install --allow-git=all --omit=dev --no-audit --no-fund --loglevel=error
# npm rewrites the lock file; keep the checkout clean so the next update can pull.
as_owner git checkout --quiet -- package-lock.json 2>/dev/null || true
trap - ERR

# 4. Restart.
if [[ $SERVICE == yes ]]; then
  systemctl daemon-reload
  systemctl start "$APP.service"
  sleep 2
  if systemctl is-active --quiet "$APP.service"; then
    ok "Service restarted"
  else
    warn "The service didn't start – check: journalctl -u $APP -e"
  fi
else
  warn "Restart Flyleaf yourself (npm start) to run the new version."
fi

printf '\n  %s✨  Updated %s → %s%s\n' "$c_green" "$(git rev-parse --short "$before")" "$(git rev-parse --short HEAD)" "$c_off"
git --no-pager log --oneline "$before..HEAD" | head -15 | sed 's/^/     /'
echo
