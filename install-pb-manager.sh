#!/bin/bash

# Exit immediately if a command exits with a non-zero status.
set -e

# --- Configuration ---
# !!! REPLACE THESE WITH YOUR ACTUAL GITHUB REPO DETAILS !!!
PB_MANAGER_GITHUB_USER="devAlphaSystem"
PB_MANAGER_GITHUB_REPO="Alpha-System-PBManager-CLI"
PB_MANAGER_BRANCH="main" # Or your default branch

PB_MANAGER_SCRIPT_URL="https://raw.githubusercontent.com/${PB_MANAGER_GITHUB_USER}/${PB_MANAGER_GITHUB_REPO}/${PB_MANAGER_BRANCH}/pb-manager.js"
PB_MANAGER_INSTALL_DIR="/opt/pb-manager"
PB_MANAGER_SYMLINK_PATH="/usr/local/bin/pb-manager"

# --- Color Codes and Helper Functions ---
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

info() { echo -e "${GREEN}[INFO]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }
success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

# --- Script Start ---

# 1. Check for root privileges
if [ "$(id -u)" -ne 0 ]; then
  error "This script must be run as root or with sudo. Example: curl -fsSL <script_url> | sudo bash"
fi

# 2. Update package lists
info "Updating package lists..."
apt-get update -y || error "Failed to update package lists."

# 3. Install essential dependencies (curl, git)
info "Installing essential tools (curl, git)..."
apt-get install -y curl git || error "Failed to install curl or git."

# 4. Install Node.js and npm
if command_exists node && command_exists npm; then
  info "Node.js and npm are already installed."
  info "Node version: $(node -v), npm version: $(npm -v)"
else
  info "Installing Node.js and npm..."
  # Using NodeSource for a more recent version (e.g., Node.js 18.x)
  # This ensures a consistent Node.js environment.
  curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
  apt-get install -y nodejs || error "Failed to install Node.js."
  success "Node.js and npm installed successfully."
  info "Node version: $(node -v), npm version: $(npm -v)"
fi

# 5. Install PM2 globally
if command_exists pm2; then
    info "PM2 is already installed."
else
    info "Installing PM2 globally..."
    npm install -g pm2 || error "Failed to install PM2."
    success "PM2 installed successfully."
fi

info "Configuring PM2 to start on system boot..."
# Attempt to set up PM2 startup script. This runs PM2 as root.
# The actual PocketBase processes will be managed by this root PM2 instance.
# The `pb-manager` script itself handles user-specific configs in `~/.pb-manager`
if command_exists pm2; then
    pm2 startup systemd -u root --hp /root || warn "PM2 startup command might have had issues. You may need to run 'pm2 startup' manually and follow instructions."
    pm2 save --force || warn "Failed to save PM2 process list. This might be okay if no processes are running yet."
    success "PM2 startup configured (or attempted)."
else
    warn "PM2 not found, skipping PM2 startup configuration."
fi


# 6. Install Nginx
if command_exists nginx; then
    info "Nginx is already installed."
else
    info "Installing Nginx..."
    apt-get install -y nginx || error "Failed to install Nginx."
    success "Nginx installed successfully."
fi

info "Ensuring Nginx is started and enabled on boot..."
systemctl start nginx || warn "Failed to start Nginx. It might already be running."
systemctl enable nginx || warn "Failed to enable Nginx on boot."
success "Nginx service configured."

# 7. Install Certbot and Nginx plugin
if command_exists certbot; then
    info "Certbot is already installed."
else
    info "Installing Certbot and its Nginx plugin..."
    apt-get install -y certbot python3-certbot-nginx || error "Failed to install Certbot or its Nginx plugin."
    success "Certbot and Nginx plugin installed successfully."
fi

# 8. Download and set up pb-manager
info "Setting up pb-manager..."
if [ -f "${PB_MANAGER_INSTALL_DIR}/pb-manager.js" ]; then
    warn "${PB_MANAGER_INSTALL_DIR}/pb-manager.js already exists. Skipping download. Re-run if you need to update it from source."
else
    mkdir -p "${PB_MANAGER_INSTALL_DIR}" || error "Failed to create directory ${PB_MANAGER_INSTALL_DIR}."
    info "Downloading pb-manager.js from ${PB_MANAGER_SCRIPT_URL}..."
    curl -fsSL "${PB_MANAGER_SCRIPT_URL}" -o "${PB_MANAGER_INSTALL_DIR}/pb-manager.js" || error "Failed to download pb-manager.js."
    chmod +x "${PB_MANAGER_INSTALL_DIR}/pb-manager.js" || error "Failed to make pb-manager.js executable."
    success "pb-manager.js downloaded and made executable."
fi

info "Installing Node.js dependencies for pb-manager in ${PB_MANAGER_INSTALL_DIR}..."
# Store current directory and change to pb-manager install directory
ORIGINAL_DIR=$(pwd)
cd "${PB_MANAGER_INSTALL_DIR}" || error "Failed to change directory to ${PB_MANAGER_INSTALL_DIR}."

# Initialize npm package if package.json doesn't exist, then install dependencies
if [ ! -f "package.json" ]; then
    npm init -y || warn "npm init -y failed, proceeding with dependency installation."
fi
npm install commander inquirer fs-extra axios chalk unzipper shelljs || error "Failed to install pb-manager dependencies."
success "pb-manager dependencies installed."

# Change back to the original directory
cd "${ORIGINAL_DIR}"

# 9. Create symlink for pb-manager
info "Creating symlink for pb-manager at ${PB_MANAGER_SYMLINK_PATH}..."
ln -sfn "${PB_MANAGER_INSTALL_DIR}/pb-manager.js" "${PB_MANAGER_SYMLINK_PATH}" || error "Failed to create symlink for pb-manager."
success "Symlink created. You can now use 'pb-manager' command."

# 10. Configure Firewall (UFW example)
if command_exists ufw; then
    info "Configuring firewall (UFW) to allow Nginx traffic..."
    ufw allow 'Nginx Full' || warn "Failed to set UFW rule for 'Nginx Full'. You may need to configure your firewall manually."
    # Optionally enable UFW if it's inactive, but be cautious with this on remote servers.
    # if ! ufw status | grep -q "Status: active"; then
    #    warn "UFW is inactive. Enabling UFW. Ensure you have SSH access allowed if this is a remote server!"
    #    ufw enable
    # fi
    success "Firewall rules for Nginx (HTTP/HTTPS) applied/checked."
    info "Current UFW status:"
    ufw status
else
    warn "UFW command not found. Please configure your firewall manually to allow HTTP (80) and HTTPS (443) traffic."
fi

# --- Completion ---
success "-------------------------------------------------------"
success "pb-manager pre-configuration complete!"
success "-------------------------------------------------------"
info "Next steps:"
info "1. If this is the first time, run: pb-manager configure"
info "   (This can be run as a normal user, not necessarily root)"
info "2. Then, to download the PocketBase binary: pb-manager setup"
info "   (This also can be run as a normal user)"
info "3. To add a new PocketBase instance (this may require sudo for Nginx/Certbot): sudo pb-manager add"
info "Refer to the pb-manager documentation for more commands and usage."

exit 0
