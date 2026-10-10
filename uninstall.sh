#!/usr/bin/env bash
# Flyleaf uninstaller – removes everything install.sh created.
#
#   sudo ./uninstall.sh [--keep-data] [--yes]
#
#   --keep-data   keep the database, covers and logs (default: ask)
#   --yes         don't ask questions (removes data unless --keep-data)
#
# Your book/manga/comic folders are never touched.

set -euo pipefail

APP=flyleaf
CONF_DIR=/etc/flyleaf
MANIFEST=$CONF_DIR/install.manifest
KEEP_DATA=ask
ASSUME_YES=0

c_blue=$'\e[1;34m'; c_green=$'\e[1;32m'; c_yellow=$'\e[1;33m'; c_red=$'\e[1;31m'; c_off=$'\e[0m'
info() { printf '%s==>%s %s\n' "$c_blue" "$c_off" "$*"; }
ok() { printf '%s ✓%s %s\n' "$c_green" "$c_off" "$*"; }
warn() { printf '%s !%s %s\n' "$c_yellow" "$c_off" "$*"; }
die() { printf '%s ✗ %s%s\n' "$c_red" "$*" "$c_off" >&2; exit 1; }
ask() {
  local q=$1 d=${2:-y} a
  if [[ $ASSUME_YES == 1 || ! -t 0 ]]; then [[ $d == y ]]; return; fi
  read -r -p "$q [$( [[ $d == y ]] && echo Y/n || echo y/N )] " a
  a=${a:-$d}
  [[ $a =~ ^[Yy] ]]
}

while [[ $# -gt 0 ]]; do
  case $1 in
    --keep-data) KEEP_DATA=yes; shift ;;
    -y|--yes) ASSUME_YES=1; shift ;;
    -h|--help) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "Unknown option: $1" ;;
  esac
done

[[ $EUID -eq 0 ]] || die "Please run with sudo: sudo $0 $*"
[[ -f $MANIFEST ]] || die "No Flyleaf installation found ($MANIFEST is missing)."

# Read the manifest (KEY=value lines written by install.sh).
declare -A M
while IFS='=' read -r k v; do [[ -n $k ]] && M[$k]=$v; done < "$MANIFEST"

cat <<EOF

  ${c_yellow}🗑   Flyleaf uninstaller${c_off}

  This removes the Flyleaf service, app files and configuration.
  Your library folders are not touched.

EOF
ask "Uninstall Flyleaf?" n || exit 1

# 1. Service
if systemctl list-unit-files "$APP.service" >/dev/null 2>&1; then
  info "Stopping and disabling the service"
  systemctl disable --now "$APP.service" >/dev/null 2>&1 || true
fi
if [[ -n ${M[UNIT]:-} && -f ${M[UNIT]} ]]; then
  rm -f "${M[UNIT]}"
  systemctl daemon-reload
  systemctl reset-failed "$APP.service" >/dev/null 2>&1 || true
  ok "Removed ${M[UNIT]}"
fi

# 2. Firewall rules
if [[ -n ${M[FIREWALLD_PORT]:-} ]] && command -v firewall-cmd >/dev/null; then
  firewall-cmd --quiet --permanent --remove-port="${M[FIREWALLD_PORT]}" 2>/dev/null && firewall-cmd --quiet --reload || true
  ok "Closed ${M[FIREWALLD_PORT]} in firewalld"
fi
if [[ -n ${M[UFW_PORT]:-} ]] && command -v ufw >/dev/null; then
  ufw delete allow "${M[UFW_PORT]}" >/dev/null 2>&1 || true
  ok "Removed ufw rule for ${M[UFW_PORT]}"
fi

# 3. App files and private Node runtime
if [[ -n ${M[INSTALL_DIR]:-} && -d ${M[INSTALL_DIR]} ]]; then
  rm -rf "${M[INSTALL_DIR]}"
  ok "Removed ${M[INSTALL_DIR]}"
fi
if [[ -n ${M[SAFE_DIRECTORY]:-} ]]; then
  git config --system --unset-all safe.directory "${M[SAFE_DIRECTORY]}" 2>/dev/null || true
fi
if [[ -n ${M[RUNTIME_DIR]:-} && -d ${M[RUNTIME_DIR]} ]]; then
  rm -rf "${M[RUNTIME_DIR]}"
  ok "Removed Node.js runtime ${M[RUNTIME_DIR]}"
fi

if [[ -n ${M[CLI]:-} && -f ${M[CLI]} ]]; then
  rm -f "${M[CLI]}"
  ok "Removed ${M[CLI]}"
fi

# 4. Data (database, covers, logs)
DATA=${M[DATA_DIR]:-}
if [[ -n $DATA && -d $DATA ]]; then
  remove_data=no
  if [[ $KEEP_DATA == ask ]]; then
    ask "Also delete the database, covers and logs in $DATA? (reading progress, users, collections)" n && remove_data=yes
  elif [[ $KEEP_DATA != yes ]]; then
    remove_data=yes
  fi
  if [[ $ASSUME_YES == 1 && $KEEP_DATA == ask ]]; then remove_data=yes; fi
  if [[ $remove_data == yes ]]; then
    rm -rf "$DATA"
    ok "Removed $DATA"
  else
    warn "Kept your data in $DATA (delete it yourself when you no longer need it)"
  fi
fi

# 5. System user created by the installer
if [[ -n ${M[CREATED_USER]:-} ]] && id "${M[CREATED_USER]}" >/dev/null 2>&1; then
  userdel "${M[CREATED_USER]}" 2>/dev/null || true
  ok "Removed system user ${M[CREATED_USER]}"
fi

# 6. Packages installed by the installer (only those that weren't there before)
if [[ -n ${M[PACKAGES]:-} ]]; then
  if ask "Remove packages the installer added (${M[PACKAGES]})? Other software may use them." n; then
    read -r -a pkgs <<< "${M[PACKAGES]}"
    case ${M[FAMILY]:-} in
      fedora) dnf remove -y "${pkgs[@]}" || true ;;
      debian) apt-get remove -y "${pkgs[@]}" || true ;;
      arch) pacman -Rns --noconfirm "${pkgs[@]}" || true ;;
    esac
  fi
fi

# 7. Config (last, it holds the manifest)
rm -rf "$CONF_DIR"
ok "Removed $CONF_DIR"

printf '\n  %s👋  Flyleaf has been uninstalled.%s\n\n' "$c_green" "$c_off"
