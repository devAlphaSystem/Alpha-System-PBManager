#!/usr/bin/env bash
#
# pb-manager installer
# https://github.com/devAlphaSystem/Alpha-System-PBManager
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/devAlphaSystem/Alpha-System-PBManager/main/install-pb-manager.sh | sudo bash
#

set -e

# ─── Configuration ───────────────────────────────────────────────────────────

REPO="devAlphaSystem/Alpha-System-PBManager"
BRANCH="main"
INSTALL_DIR="/opt/pb-manager"
SYMLINK="/usr/local/bin/pb-manager"
LOG="/var/log/pb-manager-installer.log"
NODE_MAJOR=20
DEPS="commander inquirer@8 fs-extra nlcurl chalk unzipper shelljs"
TOTAL_STEPS=8

# ─── Colors (disabled when not writing to a terminal) ────────────────────────

if [ -t 1 ]; then
  R='\033[0;31m' G='\033[0;32m' Y='\033[1;33m' B='\033[0;34m'
  BOLD='\033[1m' DIM='\033[2m' NC='\033[0m'
else
  R='' G='' Y='' B='' BOLD='' DIM='' NC=''
fi

# ─── Helpers ─────────────────────────────────────────────────────────────────

info()  { printf "  ${B}::${NC} %s\n" "$1"; }
ok()    { printf "  ${G}✓${NC} %s\n" "$1"; }
warn()  { printf "  ${Y}!${NC} %s\n" "$1"; }
step()  { printf "\n${BOLD} [%s/%s] %s${NC}\n" "$1" "$TOTAL_STEPS" "$2"; }
has()   { command -v "$1" >/dev/null 2>&1; }

die() {
  printf "  ${R}✗ %s${NC}\n" "$1" >&2
  [ -f "$LOG" ] && printf "  ${DIM}→ Check %s for details${NC}\n" "$LOG" >&2
  exit 1
}

pkg_install() {
  case $PKG in
    apt)    apt-get install -y "$@" >> "$LOG" 2>&1 ;;
    dnf)    dnf install -y "$@"     >> "$LOG" 2>&1 ;;
    pacman) pacman -S --noconfirm "$@" >> "$LOG" 2>&1 ;;
  esac
}

pkg_update() {
  case $PKG in
    apt)    apt-get update -y      >> "$LOG" 2>&1 ;;
    dnf)    dnf makecache --timer  >> "$LOG" 2>&1 ;;
    pacman) pacman -Sy --noconfirm >> "$LOG" 2>&1 ;;
  esac
}

# ─── Steps ───────────────────────────────────────────────────────────────────

detect_system() {
  step 1 "Detecting system"

  [ "$(id -u)" -eq 0 ] || die "This installer must be run as root (use sudo)"

  if   has apt-get; then PKG=apt
  elif has dnf;     then PKG=dnf
  elif has pacman;  then PKG=pacman
  else die "Unsupported system — only apt, dnf, and pacman are supported"
  fi
  ok "Package manager: ${PKG}"

  if grep -qi microsoft /proc/version 2>/dev/null; then
    if [ -d /run/WSL ] && ! pgrep -x systemd >/dev/null 2>&1; then
      warn "WSL2 detected without systemd enabled"
      warn "Services like Nginx and PM2 may not auto-start on boot"
      info "Fix: add the following to /etc/wsl.conf then run 'wsl --shutdown':"
      printf "  ${DIM}  [boot]${NC}\n"
      printf "  ${DIM}  systemd=true${NC}\n"
    fi
  fi
}

install_essentials() {
  step 2 "Installing essentials"
  pkg_update || die "Failed to update package lists"
  pkg_install curl git openssl || die "Failed to install essential tools"
  ok "curl, git, openssl"
}

install_node() {
  step 3 "Setting up Node.js"

  if has node; then
    local ver
    ver=$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)
    if [ "$ver" -ge "$NODE_MAJOR" ]; then
      ok "Node.js $(node -v) already installed"
      return
    fi
    warn "Node.js $(node -v) is below v${NODE_MAJOR} — upgrading..."
  fi

  info "Installing Node.js v${NODE_MAJOR}.x..."
  case $PKG in
    apt)
      curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >> "$LOG" 2>&1
      apt-get install -y nodejs >> "$LOG" 2>&1
      ;;
    dnf)
      curl -fsSL "https://rpm.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >> "$LOG" 2>&1
      dnf install -y nodejs >> "$LOG" 2>&1
      ;;
    pacman)
      pacman -S --noconfirm nodejs npm >> "$LOG" 2>&1
      ;;
  esac

  has node || die "Node.js installation failed"
  ok "Node.js $(node -v)"
}

install_pm2() {
  step 4 "Setting up PM2"

  if ! has pm2; then
    npm install -g pm2 >> "$LOG" 2>&1 || die "PM2 installation failed"
  fi
  ok "PM2 installed"

  pm2 startup systemd -u root --hp /root >> "$LOG" 2>&1 || true
  pm2 save --force >> "$LOG" 2>&1 || true
  ok "PM2 startup configured"
}

install_nginx() {
  step 5 "Setting up Nginx"

  if ! has nginx; then
    pkg_install nginx || die "Nginx installation failed"
  fi

  if has systemctl; then
    systemctl start nginx  >> "$LOG" 2>&1 || true
    systemctl enable nginx >> "$LOG" 2>&1 || true
  fi
  ok "Nginx running and enabled"
}

install_certbot() {
  step 6 "Setting up Certbot"

  if has certbot; then
    ok "Certbot already installed"
    return
  fi

  info "Installing Certbot with Nginx plugin..."
  case $PKG in
    apt)
      pkg_install certbot python3-certbot-nginx 2>/dev/null \
        || pkg_install certbot certbot-nginx
      ;;
    dnf)
      if ! dnf repolist enabled 2>/dev/null | grep -qi epel; then
        pkg_install epel-release || true
        pkg_update || true
      fi
      pkg_install certbot python3-certbot-nginx 2>/dev/null \
        || pkg_install certbot certbot-nginx
      ;;
    pacman)
      pkg_install certbot certbot-nginx
      ;;
  esac || die "Certbot installation failed"
  ok "Certbot installed"
}

setup_firewall() {
  step 7 "Configuring firewall"

  if has ufw; then
    ufw allow 'Nginx Full' >> "$LOG" 2>&1 \
      && ok "UFW: HTTP/HTTPS allowed" \
      || warn "UFW rule failed — configure manually"
  elif has firewall-cmd; then
    firewall-cmd --permanent --add-service=http  >> "$LOG" 2>&1 || true
    firewall-cmd --permanent --add-service=https >> "$LOG" 2>&1 || true
    firewall-cmd --reload >> "$LOG" 2>&1 || true
    ok "firewalld: HTTP/HTTPS allowed"
  else
    warn "No firewall detected — ensure ports 80 and 443 are open"
  fi
}

setup_pb_manager() {
  step 8 "Installing pb-manager"

  mkdir -p "$INSTALL_DIR"

  info "Downloading pb-manager.js..."
  curl -fsSL "https://raw.githubusercontent.com/${REPO}/${BRANCH}/pb-manager.js" \
    -o "$INSTALL_DIR/pb-manager.js" || die "Failed to download pb-manager.js"
  chmod +x "$INSTALL_DIR/pb-manager.js"

  info "Installing CLI dependencies..."
  cd "$INSTALL_DIR"
  [ -f package.json ] || npm init -y >> "$LOG" 2>&1
  # shellcheck disable=SC2086
  npm install --save $DEPS >> "$LOG" 2>&1 || die "Failed to install CLI dependencies"

  ln -sfn "$INSTALL_DIR/pb-manager.js" "$SYMLINK"
  ok "pb-manager installed → ${SYMLINK}"
}

# ─── Main ────────────────────────────────────────────────────────────────────

main() {
  printf "\n${BOLD}  pb-manager installer${NC}\n"
  printf "  ${DIM}github.com/${REPO}${NC}\n"

  echo "── pb-manager installation $(date) ──" > "$LOG"

  detect_system
  install_essentials
  install_node
  install_pm2
  install_nginx
  install_certbot
  setup_firewall
  setup_pb_manager

  printf "\n${G}${BOLD}  ✓ pb-manager installed successfully${NC}\n\n"
  info "Get started:  sudo pb-manager setup"
  info "All commands: sudo pb-manager help"
  printf "  ${DIM}Full log: ${LOG}${NC}\n\n"
}

main
