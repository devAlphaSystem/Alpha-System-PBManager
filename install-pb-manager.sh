#!/bin/bash

set -e

PB_MANAGER_GITHUB_USER="devAlphaSystem"
PB_MANAGER_GITHUB_REPO="Alpha-System-PBManager-CLI"
PB_MANAGER_BRANCH="main"

PB_MANAGER_SCRIPT_URL="https://raw.githubusercontent.com/${PB_MANAGER_GITHUB_USER}/${PB_MANAGER_GITHUB_REPO}/${PB_MANAGER_BRANCH}/pb-manager.js"
PB_MANAGER_INSTALL_DIR="/opt/pb-manager"
PB_MANAGER_SYMLINK_PATH="/usr/local/bin/pb-manager"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

info() { echo -e "${GREEN}[INFO]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }
success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }

command_exists() { command -v "$1" >/dev/null 2>&1; }

check_distro() {
  if ! command_exists apt-get; then
    error "This installation script currently only supports Debian-based Linux distributions (e.g., Ubuntu, Debian) that use 'apt' as their package manager. Please install dependencies manually if you are on a different system."
  fi
  info "Detected Debian-based system (apt)."
}

if [ "$(id -u)" -ne 0 ]; then
  error "This script must be run as root or with sudo."
fi

check_distro

info "Updating package lists..."
sudo apt-get update -y || error "Failed to update package lists."

info "Installing essential tools (curl, git)..."
sudo apt-get install -y curl git || error "Failed to install curl or git."

if command_exists node && command_exists npm; then
  NODE_VERSION_RAW=$(node -v)
  NPM_VERSION_RAW=$(npm -v)
  info "Node.js and npm are already installed."
  if [[ "$(echo "$NODE_VERSION_RAW" | cut -d. -f1 | sed 's/v//')" -lt 18 ]]; then
    warn "Installed Node.js version is $NODE_VERSION_RAW, which is older than v18.x. pb-manager might require a newer version. Consider upgrading Node.js."
  else
    info "Node version: $NODE_VERSION_RAW, npm version: $NPM_VERSION_RAW"
  fi
else
  info "Installing Node.js (v18.x) and npm..."
  curl -fsSL https://deb.nodesource.com/setup_18.x | sudo bash -
  sudo apt-get install -y nodejs || error "Failed to install Node.js."
  success "Node.js and npm installed successfully."
  info "Node version: $(node -v), npm version: $(npm -v)"
fi

if command_exists pm2; then
  info "PM2 is already installed. Version: $(pm2 -V)"
else
  info "Installing PM2 globally..."
  sudo npm install -g pm2 || error "Failed to install PM2."
  success "PM2 installed successfully."
fi

info "Configuring PM2 to start on system boot..."
if command_exists pm2; then
  sudo pm2 startup systemd -u root --hp /root || warn "PM2 startup command might have had issues. You may need to run 'sudo pm2 startup' manually and follow instructions."
  sudo pm2 save --force || warn "Failed to save PM2 process list. This might be okay if no processes are running yet."
  success "PM2 startup configured (or attempted)."
else
  warn "PM2 not found, skipping PM2 startup configuration."
fi

if command_exists nginx; then
  info "Nginx is already installed."
else
  info "Installing Nginx..."
  sudo apt-get install -y nginx || error "Failed to install Nginx."
  success "Nginx installed successfully."
fi

info "Ensuring Nginx is started and enabled on boot..."
sudo systemctl start nginx || warn "Failed to start Nginx. It might already be running or there might be a configuration issue."
sudo systemctl enable nginx || warn "Failed to enable Nginx on boot."
success "Nginx service configured."

if command_exists certbot; then
  info "Certbot is already installed."
else
  info "Installing Certbot and its Nginx plugin..."
  sudo apt-get install -y certbot python3-certbot-nginx || error "Failed to install Certbot or its Nginx plugin."
  success "Certbot and Nginx plugin installed successfully."
fi

info "Setting up pb-manager script..."
if [ -f "${PB_MANAGER_INSTALL_DIR}/pb-manager.js" ]; then
  warn "${PB_MANAGER_INSTALL_DIR}/pb-manager.js already exists. Overwriting with the version from the repository."
fi

sudo mkdir -p "${PB_MANAGER_INSTALL_DIR}" || error "Failed to create directory ${PB_MANAGER_INSTALL_DIR}."
info "Downloading pb-manager.js from ${PB_MANAGER_SCRIPT_URL}..."
sudo curl -fsSL "${PB_MANAGER_SCRIPT_URL}" -o "${PB_MANAGER_INSTALL_DIR}/pb-manager.js" || error "Failed to download pb-manager.js."
sudo chmod +x "${PB_MANAGER_INSTALL_DIR}/pb-manager.js" || error "Failed to make pb-manager.js executable."
success "pb-manager.js downloaded and made executable."

info "Installing Node.js dependencies for pb-manager in ${PB_MANAGER_INSTALL_DIR}..."
ORIGINAL_DIR=$(pwd)
cd "${PB_MANAGER_INSTALL_DIR}" || error "Failed to change directory to ${PB_MANAGER_INSTALL_DIR}."
if [ ! -f "package.json" ]; then
  sudo npm init -y || warn "npm init -y failed, proceeding with dependency installation."
fi
sudo npm install commander inquirer@8.2.4 fs-extra axios chalk@4.1.2 unzipper shelljs blessed blessed-contrib cli-table3 pretty-bytes@5.6.0 || error "Failed to install pb-manager dependencies."
success "pb-manager dependencies installed."
cd "${ORIGINAL_DIR}"

info "Creating symlink for pb-manager at ${PB_MANAGER_SYMLINK_PATH}..."
sudo ln -sfn "${PB_MANAGER_INSTALL_DIR}/pb-manager.js" "${PB_MANAGER_SYMLINK_PATH}" || error "Failed to create symlink for pb-manager."
success "Symlink created. You can now use 'pb-manager' command."

if command_exists ufw; then
  info "Configuring firewall (UFW) to allow Nginx traffic..."
  sudo ufw allow 'Nginx Full' || warn "Failed to set UFW rule for 'Nginx Full'. You may need to configure your firewall manually."
  success "Firewall rules for Nginx (HTTP/HTTPS) applied/checked."
  info "Current UFW status:"
  sudo ufw status
else
  warn "UFW command not found. Please configure your firewall manually to allow HTTP (80) and HTTPS (443) traffic."
fi

success "-------------------------------------------------------"
success "pb-manager pre-configuration complete!"
success "-------------------------------------------------------"
info "Next steps:"
info "1. If this is the first time, run: sudo pb-manager configure"
info "2. Then, to download the PocketBase binary: sudo pb-manager setup"
info "3. To add a new PocketBase instance: sudo pb-manager add"
info "4. To view the dashboard: sudo pb-manager dashboard"
info "Refer to the pb-manager documentation for more commands and usage."

exit 0
