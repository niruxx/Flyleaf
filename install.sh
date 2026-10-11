#!/usr/bin/env bash
# Flyleaf installer – Fedora / RHEL, Debian / Ubuntu, Arch (and derivatives).
#
#   sudo ./install.sh [--port 7878] [--user NAME] [--dir /opt/flyleaf] [--data /opt/flyleaf_data] [--yes]
#
# Installs dependencies, puts Flyleaf in a git checkout (so update.sh can pull),
# installs npm packages, and sets up a systemd service that starts on boot.
# Everything created is recorded in /etc/flyleaf/install.manifest for uninstall.sh.

set -euo pipefail

APP=flyleaf
INSTALL_DIR=/opt/flyleaf
DATA_DIR=/opt/flyleaf_data
CONF_DIR=/etc/flyleaf
RUNTIME_DIR=/opt/flyleaf-runtime
PORT=7878
SERVICE_USER="${SUDO_USER:-}"
ASSUME_YES=0
NODE_MIN_MAJOR=22
NODE_MIN_MINOR=13
NODE_VERSION=22.20.0 # used only when the distro's Node is too old

c_blue=$'\e[1;34m'; c_green=$'\e[1;32m'; c_yellow=$'\e[1;33m'; c_red=$'\e[1;31m'; c_off=$'\e[0m'
info() { printf '%s==>%s %s\n' "$c_blue" "$c_off" "$*"; }
ok() { printf '%s ✓%s %s\n' "$c_green" "$c_off" "$*"; }
warn() { printf '%s !%s %s\n' "$c_yellow" "$c_off" "$*"; }
die() { printf '%s ✗ %s%s\n' "$c_red" "$*" "$c_off" >&2; exit 1; }
ask() { # ask "question" default(y/n)
  local q=$1 d=${2:-y} a
  if [[ $ASSUME_YES == 1 || ! -t 0 ]]; then [[ $d == y ]]; return; fi
  read -r -p "$q [$( [[ $d == y ]] && echo Y/n || echo y/N )] " a
  a=${a:-$d}
  [[ $a =~ ^[Yy] ]]
}

usage() {
  sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
}

while [[ $# -gt 0 ]]; do
  case $1 in
    --port) PORT=$2; shift 2 ;;
    --user) SERVICE_USER=$2; shift 2 ;;
    --dir) INSTALL_DIR=$2; shift 2 ;;
    --data) DATA_DIR=$2; shift 2 ;;
    -y|--yes) ASSUME_YES=1; shift ;;
    -h|--help) usage ;;
    *) die "Unknown option: $1 (see --help)" ;;
  esac
done

[[ $EUID -eq 0 ]] || die "Please run with sudo: sudo $0 $*"
command -v systemctl >/dev/null || die "systemd is required."
[[ $PORT =~ ^[0-9]+$ ]] || die "Port must be a number."

SRC_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
[[ -f $SRC_DIR/package.json && -d $SRC_DIR/server ]] || die "Run install.sh from the Flyleaf source folder."
[[ -f $CONF_DIR/install.manifest ]] && die "Flyleaf is already installed. Use ./update.sh to update, or ./uninstall.sh first."

MANIFEST_TMP=$(mktemp)
record() { echo "$1=$2" >> "$MANIFEST_TMP"; }

cat <<EOF

  ${c_blue}📖  Flyleaf installer${c_off}

  App folder    $INSTALL_DIR
  Data folder   $DATA_DIR   (database, covers, logs)
  Config        $CONF_DIR/flyleaf.env
  Port          $PORT
  Runs as       ${SERVICE_USER:-a new 'flyleaf' system user}

EOF
ask "Continue?" y || exit 1

# ---------------------------------------------------------------------------
# 1. Packages

. /etc/os-release
FAMILY=""
case " ${ID:-} ${ID_LIKE:-} " in
  *" fedora "*|*" rhel "*|*" centos "*|*" rocky "*|*" almalinux "*) FAMILY=fedora ;;
  *" debian "*|*" ubuntu "*|*" linuxmint "*|*" pop "*) FAMILY=debian ;;
  *" arch "*|*" manjaro "*|*" endeavouros "*) FAMILY=arch ;;
esac
[[ -n $FAMILY ]] || die "Unsupported distribution: ${PRETTY_NAME:-unknown}. Supported: Fedora/RHEL, Debian/Ubuntu, Arch."
info "Detected ${PRETTY_NAME:-$ID} ($FAMILY family)"

installed_pkgs=()
pkg_present() {
  case $FAMILY in
    fedora) rpm -q "$1" >/dev/null 2>&1 ;;
    debian) dpkg -s "$1" >/dev/null 2>&1 ;;
    arch) pacman -Qi "$1" >/dev/null 2>&1 ;;
  esac
}
pkg_install() {
  local missing=()
  for p in "$@"; do pkg_present "$p" || missing+=("$p"); done
  [[ ${#missing[@]} -eq 0 ]] && return 0
  info "Installing packages: ${missing[*]}"
  case $FAMILY in
    fedora) dnf install -y "${missing[@]}" ;;
    debian) apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y "${missing[@]}" ;;
    arch) pacman -Sy --noconfirm --needed "${missing[@]}" ;;
  esac
  installed_pkgs+=("${missing[@]}")
}

case $FAMILY in
  fedora) pkg_install git curl ca-certificates tar xz ;;
  debian) pkg_install git curl ca-certificates tar xz-utils ;;
  arch) pkg_install git curl ca-certificates tar xz ;;
esac

# ---------------------------------------------------------------------------
# 2. Node.js ≥ 22.13 (distro package if new enough, otherwise the official build)

node_ok() {
  local v
  v=$("$1" -v 2>/dev/null | sed 's/^v//') || return 1
  local major=${v%%.*} rest=${v#*.}
  local minor=${rest%%.*}
  (( major > NODE_MIN_MAJOR || (major == NODE_MIN_MAJOR && minor >= NODE_MIN_MINOR) ))
}

NODE_BIN=""
if command -v node >/dev/null && node_ok "$(command -v node)"; then
  NODE_BIN=$(command -v node)
else
  # Try the distro package first (Fedora 41+, Arch and recent Ubuntu ship Node 22).
  case $FAMILY in
    fedora) pkg_install nodejs npm || true ;;
    arch) pkg_install nodejs npm || true ;;
    debian) : ;; # Debian/Ubuntu Node is usually too old – use the official build.
  esac
  if command -v node >/dev/null && node_ok "$(command -v node)"; then
    NODE_BIN=$(command -v node)
  fi
fi

if [[ -z $NODE_BIN ]]; then
  arch=$(uname -m)
  case $arch in
    x86_64) narch=x64 ;;
    aarch64|arm64) narch=arm64 ;;
    armv7l) narch=armv7l ;;
    *) die "No official Node.js build for $arch – install Node ≥ $NODE_MIN_MAJOR.$NODE_MIN_MINOR manually and re-run." ;;
  esac
  tarball="node-v$NODE_VERSION-linux-$narch.tar.xz"
  info "Downloading Node.js $NODE_VERSION ($narch)…"
  tmp=$(mktemp -d)
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/$tarball" -o "$tmp/$tarball"
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"
  (cd "$tmp" && grep " $tarball\$" SHASUMS256.txt | sha256sum -c - >/dev/null) || die "Node.js download failed its checksum."
  mkdir -p "$RUNTIME_DIR"
  tar -xJf "$tmp/$tarball" -C "$RUNTIME_DIR" --strip-components=1
  rm -rf "$tmp"
  NODE_BIN=$RUNTIME_DIR/bin/node
  record RUNTIME_DIR "$RUNTIME_DIR"
  ok "Node.js $NODE_VERSION installed to $RUNTIME_DIR"
fi
NPM_BIN=$(dirname "$NODE_BIN")/npm
[[ -x $NPM_BIN ]] || NPM_BIN=$(command -v npm || true)
[[ -n $NPM_BIN ]] || die "npm not found."
ok "Using Node $("$NODE_BIN" -v) at $NODE_BIN"

# ---------------------------------------------------------------------------
# 3. Service user

if [[ -z $SERVICE_USER ]]; then
  SERVICE_USER=$APP
fi
if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  info "Creating system user '$SERVICE_USER'"
  useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin "$SERVICE_USER" 2>/dev/null \
    || useradd --system --home-dir "$DATA_DIR" --shell /sbin/nologin "$SERVICE_USER"
  record CREATED_USER "$SERVICE_USER"
fi
SERVICE_GROUP=$(id -gn "$SERVICE_USER")

# ---------------------------------------------------------------------------
# 4. App files (a git checkout so update.sh can pull)

info "Installing Flyleaf to $INSTALL_DIR"
if [[ $SRC_DIR != "$INSTALL_DIR" ]]; then
  [[ -e $INSTALL_DIR ]] && die "$INSTALL_DIR already exists. Remove it or choose --dir."
  if git -C "$SRC_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    git clone --quiet "$SRC_DIR" "$INSTALL_DIR"
    upstream=$(git -C "$SRC_DIR" remote get-url origin 2>/dev/null || true)
    branch=$(git -C "$SRC_DIR" rev-parse --abbrev-ref HEAD)
    if [[ -n $upstream ]]; then
      git -C "$INSTALL_DIR" remote set-url origin "$upstream"
      git -C "$INSTALL_DIR" fetch --quiet origin || warn "Couldn't reach $upstream – update.sh will need network access."
      git -C "$INSTALL_DIR" branch --quiet --set-upstream-to="origin/$branch" "$branch" 2>/dev/null || true
    fi
  else
    mkdir -p "$INSTALL_DIR"
    tar -C "$SRC_DIR" --exclude=node_modules --exclude=data --exclude=.git -cf - . | tar -C "$INSTALL_DIR" -xf -
    warn "Source folder isn't a git checkout – update.sh won't be able to pull updates."
  fi
  record INSTALL_DIR "$INSTALL_DIR"
fi
git config --system --add safe.directory "$INSTALL_DIR" 2>/dev/null || true
record SAFE_DIRECTORY "$INSTALL_DIR"

mkdir -p "$DATA_DIR" "$CONF_DIR"
record DATA_DIR "$DATA_DIR"
record CONF_DIR "$CONF_DIR"
chown -R "$SERVICE_USER:$SERVICE_GROUP" "$INSTALL_DIR" "$DATA_DIR"

info "Installing npm packages (this can take a minute)…"
sudo -u "$SERVICE_USER" env HOME="$DATA_DIR" PATH="$(dirname "$NODE_BIN"):$PATH" \
  "$NPM_BIN" --prefix "$INSTALL_DIR" install --allow-git=all --omit=dev --no-audit --no-fund --loglevel=error
ok "Dependencies installed"

# ---------------------------------------------------------------------------
# 5. Config + systemd service

if [[ ! -f $CONF_DIR/flyleaf.env ]]; then
  cat > "$CONF_DIR/flyleaf.env" <<EOF
# Flyleaf configuration – restart after editing: sudo systemctl restart flyleaf
PORT=$PORT
HOST=0.0.0.0
FLYLEAF_DATA_DIR=$DATA_DIR
SCAN_INTERVAL_MINUTES=60
SESSION_DAYS=30
# Set both to true when Flyleaf sits behind an HTTPS reverse proxy:
TRUST_PROXY=false
SECURE_COOKIES=false
LOG_LEVEL=info
EOF
  chmod 640 "$CONF_DIR/flyleaf.env"
  chgrp "$SERVICE_GROUP" "$CONF_DIR/flyleaf.env"
fi

UNIT=/etc/systemd/system/$APP.service
cat > "$UNIT" <<EOF
[Unit]
Description=Flyleaf – self-hosted books, manga & comics
Documentation=file://$INSTALL_DIR/README.md
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_GROUP
WorkingDirectory=$INSTALL_DIR
EnvironmentFile=$CONF_DIR/flyleaf.env
ExecStart=$NODE_BIN --disable-warning=ExperimentalWarning $INSTALL_DIR/server/index.js
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ReadWritePaths=$DATA_DIR

[Install]
WantedBy=multi-user.target
EOF
record UNIT "$UNIT"
record SERVICE_USER "$SERVICE_USER"
record NODE_BIN "$NODE_BIN"
record PORT "$PORT"

systemctl daemon-reload
systemctl enable --now "$APP.service" >/dev/null
ok "Service enabled – Flyleaf starts automatically on boot"

# ---------------------------------------------------------------------------
# 6. Firewall (optional)

if command -v firewall-cmd >/dev/null && systemctl is-active --quiet firewalld; then
  if ask "Open port $PORT in firewalld so other devices can connect?" y; then
    firewall-cmd --quiet --permanent --add-port="$PORT/tcp" && firewall-cmd --quiet --reload
    record FIREWALLD_PORT "$PORT/tcp"
    ok "firewalld: port $PORT/tcp open"
  fi
elif command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q "Status: active"; then
  if ask "Allow port $PORT through ufw so other devices can connect?" y; then
    ufw allow "$PORT/tcp" >/dev/null
    record UFW_PORT "$PORT/tcp"
    ok "ufw: port $PORT/tcp allowed"
  fi
fi

# ---------------------------------------------------------------------------
# 7. `flyleaf` helper command

CLI=/usr/local/bin/flyleaf
cat > "$CLI" <<CLIEOF
#!/usr/bin/env bash
# Flyleaf helper – installed by install.sh
set -e
case "\${1:-help}" in
  status) systemctl status $APP --no-pager ;;
  logs) journalctl -u $APP -f ;;
  restart) sudo systemctl restart $APP && echo "Flyleaf restarted" ;;
  update) sudo $INSTALL_DIR/update.sh ;;
  uninstall) sudo $INSTALL_DIR/uninstall.sh ;;
  reset-password)
    [[ -n "\$2" && -n "\$3" ]] || { echo "Usage: flyleaf reset-password <username> <new-password>"; exit 1; }
    sudo -u $SERVICE_USER env FLYLEAF_DATA_DIR=$DATA_DIR $NODE_BIN --disable-warning=ExperimentalWarning $INSTALL_DIR/scripts/reset-password.js "\$2" "\$3"
    sudo systemctl restart $APP ;;
  *) echo "Usage: flyleaf {status|logs|restart|update|reset-password|uninstall}" ;;
esac
CLIEOF
chmod 755 "$CLI"
record CLI "$CLI"

[[ ${#installed_pkgs[@]} -gt 0 ]] && record PACKAGES "${installed_pkgs[*]}"
record FAMILY "$FAMILY"
install -m 644 "$MANIFEST_TMP" "$CONF_DIR/install.manifest"
rm -f "$MANIFEST_TMP"

# ---------------------------------------------------------------------------

for _ in $(seq 1 20); do
  curl -fs "http://127.0.0.1:$PORT/api/status" >/dev/null 2>&1 && break
  sleep 0.5
done
lan_ip=$(hostname -I 2>/dev/null | awk '{print $1}')
if curl -fs "http://127.0.0.1:$PORT/api/status" >/dev/null 2>&1; then
  ok "Flyleaf is running"
else
  warn "Flyleaf didn't respond yet – check: journalctl -u $APP -e"
fi
cat <<EOF

  ${c_green}🎉  All done!${c_off}

  Open  ${c_blue}http://localhost:$PORT${c_off}${lan_ip:+   or   ${c_blue}http://$lan_ip:$PORT${c_off} from other devices}
  and create your admin account.

  Status   flyleaf status
  Logs     flyleaf logs               (details: $DATA_DIR/logs/flyleaf.log)
  Config   $CONF_DIR/flyleaf.env      (then: flyleaf restart)
  Update   flyleaf update
  Remove   flyleaf uninstall

  The service runs as '$SERVICE_USER' – make sure that user can read your library folders.

EOF
