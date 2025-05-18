#!/bin/bash

set -e

PB_MANAGER_GITHUB_USER="devAlphaSystem"
PB_MANAGER_GITHUB_REPO="Alpha-System-PBManager"
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

is_wsl() {
  grep -qi microsoft /proc/version 2>/dev/null
}

is_wsl2() {
  if is_wsl && [ -d /run/WSL ]; then
    return 0
  fi
  return 1
}

prompt_enable_systemd_wsl2() {
  echo -e "${YELLOW}You are running under WSL2 and systemd does not appear to be enabled.${NC}"
  echo -e "${YELLOW}For services like Nginx and PM2 to start automatically on boot within WSL2, systemd is recommended.${NC}"
  echo -e "${YELLOW}To enable systemd in WSL2, you typically add the following to /etc/wsl.conf:${NC}"
  echo -e "${YELLOW}\n[boot]\nsystemd=true\n${NC}"
  echo -e "${YELLOW}After creating or modifying /etc/wsl.conf, you must fully shut down your WSL instance from PowerShell/CMD (e.g., 'wsl --shutdown') and then restart it.${NC}"
  read -p "Do you want this script to attempt to add 'systemd=true' to /etc/wsl.conf for you? [y/N]: " enable_systemd
  if [[ "$enable_systemd" =~ ^[Yy]$ ]]; then
    if [ ! -f /etc/wsl.conf ] || ! grep -q "\[boot\]" /etc/wsl.conf; then
      echo -e "\n[boot]" | sudo tee -a /etc/wsl.conf > /dev/null
    fi
    if ! grep -q "systemd=true" /etc/wsl.conf; then
      echo "systemd=true" | sudo tee -a /etc/wsl.conf > /dev/null
      success "systemd has been enabled in /etc/wsl.conf."
      warn "IMPORTANT: Now exit WSL, run \"wsl --shutdown\" in your Windows terminal, then restart your WSL2 instance and run this script again."
      exit 0
    else
      info "systemd already appears to be configured in /etc/wsl.conf."
    fi
  else
    warn "Skipping automatic systemd configuration for WSL2. Services might not start on boot correctly."
  fi
}

check_distro() {
  if command_exists apt-get; then
    PKG_MANAGER="apt"
    UPDATE_CMD="apt-get update -y"
    INSTALL_CMD="apt-get install -y"
    info "Detected Debian-based system (apt)."
  elif command_exists dnf; then
    PKG_MANAGER="dnf"
    UPDATE_CMD="dnf check-update -y || true"
    INSTALL_CMD="dnf install -y"
    info "Detected Fedora/RHEL/Oracle-based system (dnf)."
  elif command_exists pacman; then
    PKG_MANAGER="pacman"
    UPDATE_CMD="pacman -Sy"
    INSTALL_CMD="pacman -S --noconfirm"
    info "Detected Arch-based system (pacman)."
  else
    error "This installation script currently only supports Debian (apt), Fedora/RHEL/Oracle (dnf), or Arch (pacman) based Linux distributions. Please install dependencies manually if you are on a different system."
  fi
}

if [ "$(id -u)" -ne 0 ]; then
  error "This script must be run as root or with sudo."
fi

check_distro

if is_wsl2; then
  if ! pgrep -x systemd >/dev/null 2>&1 && ! systemctl is-system-running --quiet --wait; then
    prompt_enable_systemd_wsl2
  else
    info "WSL2 detected and systemd appears to be running."
  fi
fi

info "Updating package lists (this may take a moment)..."
if [ "$PKG_MANAGER" = "pacman" ]; then
  sudo pacman -Syu --noconfirm > /dev/null 2>&1 || error "Failed to update package lists."
else
  sudo ${UPDATE_CMD} > /dev/null 2>&1 || error "Failed to update package lists."
fi

ESSENTIAL_TOOLS="curl git openssl"
info "Ensuring essential tools (${ESSENTIAL_TOOLS}) are installed..."
sudo ${INSTALL_CMD} ${ESSENTIAL_TOOLS} > /dev/null 2>&1 || error "Failed to install essential tools."

if command_exists node && command_exists npm; then
  NODE_VERSION_RAW=$(node -v)
  NPM_VERSION_RAW=$(npm -v)
  info "Node.js and npm are already installed."
  if [[ "$(echo "$NODE_VERSION_RAW" | cut -d. -f1 | sed 's/v//')" -lt 18 ]]; then
    warn "Installed Node.js version is $NODE_VERSION_RAW, which is older than v18.x. pb-manager recommends v18.x or newer. Consider upgrading Node.js."
  else
    info "Node version: $NODE_VERSION_RAW, npm version: $NPM_VERSION_RAW"
  fi
else
  info "Node.js (v18.x) and npm are not found."
  read -p "Do you want to install Node.js v18.x and npm now? [Y/n]: " install_node
  if [[ "$install_node" =~ ^[Nn]$ ]]; then
    error "Node.js and npm are required. Installation aborted."
  fi
  info "Installing Node.js (v18.x) and npm..."
  if [ "$PKG_MANAGER" = "apt" ]; then
    curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash - > /dev/null 2>&1
    sudo apt-get install -y nodejs > /dev/null 2>&1 || error "Failed to install Node.js."
  elif [ "$PKG_MANAGER" = "dnf" ]; then
    curl -fsSL https://rpm.nodesource.com/setup_18.x | sudo -E bash - > /dev/null 2>&1
    sudo dnf install -y nodejs > /dev/null 2>&1 || error "Failed to install Node.js."
  elif [ "$PKG_MANAGER" = "pacman" ]; then
    sudo pacman -S --noconfirm nodejs npm > /dev/null 2>&1 || error "Failed to install Node.js and npm."
  fi
  success "Node.js and npm installed successfully."
  info "Node version: $(node -v), npm version: $(npm -v)"
fi

if command_exists pm2; then
  info "PM2 is already installed."
else
  info "PM2 is not found."
  read -p "Do you want to install PM2 globally via npm now? [Y/n]: " install_pm2
  if [[ "$install_pm2" =~ ^[Nn]$ ]]; then
    error "PM2 is required. Installation aborted."
  fi
  info "Installing PM2 globally..."
  sudo npm install -g pm2 > /dev/null 2>&1 || error "Failed to install PM2."
  success "PM2 installed successfully."
fi

info "Configuring PM2 to start on system boot..."
if command_exists pm2; then
  PM2_STARTUP_CMD_OUTPUT=$(sudo pm2 startup systemd -u root --hp "$HOME" 2>&1) || PM2_STARTUP_CMD_OUTPUT=$(sudo pm2 startup systemd -u root --hp /root 2>&1)

  if echo "$PM2_STARTUP_CMD_OUTPUT" | grep -q "command"; then
    warn "PM2 startup configuration might require you to run a command manually."
    echo -e "${YELLOW}PM2 output:${NC}\n$PM2_STARTUP_CMD_OUTPUT"
    echo -e "${YELLOW}Please copy and run the command provided by PM2 if necessary.${NC}"
    read -p "Press [Enter] to continue after reviewing/running the command, or [S] to skip PM2 save..." continue_key
    if [[ "$continue_key" =~ ^[Ss]$ ]]; then
      warn "Skipping pm2 save."
    else
      sudo pm2 save --force > /dev/null 2>&1 || warn "Failed to save PM2 process list. This might be okay if no processes are running yet."
    fi
  else
    info "PM2 startup command executed."
    sudo pm2 save --force > /dev/null 2>&1 || warn "Failed to save PM2 process list."
  fi
  success "PM2 startup configured (or attempted)."
else
  warn "PM2 not found, skipping PM2 startup configuration."
fi

if command_exists nginx; then
  info "Nginx is already installed."
else
  info "Nginx is not found."
  read -p "Do you want to install Nginx now? [Y/n]: " install_nginx
  if [[ "$install_nginx" =~ ^[Nn]$ ]]; then
    error "Nginx is required. Installation aborted."
  fi
  info "Installing Nginx..."
  sudo ${INSTALL_CMD} nginx > /dev/null 2>&1 || error "Failed to install Nginx."
  success "Nginx installed successfully."
fi

info "Ensuring Nginx is started and enabled on boot..."
if command_exists systemctl; then
  sudo systemctl start nginx > /dev/null 2>&1 || warn "Failed to start Nginx. It might already be running or there might be a configuration issue."
  sudo systemctl enable nginx > /dev/null 2>&1 || warn "Failed to enable Nginx on boot."
else
  warn "systemctl not found. Attempting to manage Nginx directly. This might not ensure it starts on boot."
  if sudo nginx -t > /dev/null 2>&1; then
    sudo nginx -s reload > /dev/null 2>&1 || sudo nginx > /dev/null 2>&1 || warn "Tried to reload/start Nginx directly, but it might have failed."
  else
    warn "Nginx configuration test failed. Nginx not started/reloaded."
  fi
fi
success "Nginx service configured."

if command_exists certbot; then
  info "Certbot is already installed."
else
  info "Certbot is not found."
  read -p "Do you want to install Certbot and its Nginx plugin now? [Y/n]: " install_certbot
  if [[ "$install_certbot" =~ ^[Nn]$ ]]; then
    warn "Certbot not installed. HTTPS setup via pb-manager will not be available."
  else
    info "Installing Certbot and its Nginx plugin..."
    if [ "$PKG_MANAGER" = "apt" ]; then
      sudo ${INSTALL_CMD} certbot python3-certbot-nginx > /dev/null 2>&1 || sudo ${INSTALL_CMD} certbot certbot-nginx > /dev/null 2>&1 || error "Failed to install Certbot or its Nginx plugin."
    elif [ "$PKG_MANAGER" = "dnf" ]; then
      sudo ${INSTALL_CMD} epel-release > /dev/null 2>&1 || true 
      sudo ${INSTALL_CMD} certbot python3-certbot-nginx > /dev/null 2>&1 || sudo ${INSTALL_CMD} certbot certbot-nginx > /dev/null 2>&1 || error "Failed to install Certbot or its Nginx plugin."
    elif [ "$PKG_MANAGER" = "pacman" ]; then
      sudo pacman -Syu --noconfirm > /dev/null 2>&1 || true
      sudo pacman -S --noconfirm certbot certbot-nginx > /dev/null 2>&1 || error "Failed to install Certbot or its Nginx plugin."
    fi
    success "Certbot and Nginx plugin installed successfully."
  fi
fi

info "Setting up pb-manager script..."
if [ -f "${PB_MANAGER_INSTALL_DIR}/pb-manager.js" ]; then
  warn "${PB_MANAGER_INSTALL_DIR}/pb-manager.js already exists."
  read -p "Do you want to overwrite it with the latest version from the repository? [Y/n]: " overwrite_script
  if [[ "$overwrite_script" =~ ^[Nn]$ ]]; then
    info "Skipping download of pb-manager.js. Using existing version."
  else
    info "Downloading pb-manager.js from ${PB_MANAGER_SCRIPT_URL}..."
    sudo curl -fsSL "${PB_MANAGER_SCRIPT_URL}" -o "${PB_MANAGER_INSTALL_DIR}/pb-manager.js" || error "Failed to download pb-manager.js."
    sudo chmod +x "${PB_MANAGER_INSTALL_DIR}/pb-manager.js" || error "Failed to make pb-manager.js executable."
    success "pb-manager.js downloaded/updated and made executable."
  fi
else
  sudo mkdir -p "${PB_MANAGER_INSTALL_DIR}" || error "Failed to create directory ${PB_MANAGER_INSTALL_DIR}."
  info "Downloading pb-manager.js from ${PB_MANAGER_SCRIPT_URL}..."
  sudo curl -fsSL "${PB_MANAGER_SCRIPT_URL}" -o "${PB_MANAGER_INSTALL_DIR}/pb-manager.js" || error "Failed to download pb-manager.js."
  sudo chmod +x "${PB_MANAGER_INSTALL_DIR}/pb-manager.js" || error "Failed to make pb-manager.js executable."
  success "pb-manager.js downloaded and made executable."
fi

info "Installing Node.js dependencies for pb-manager in ${PB_MANAGER_INSTALL_DIR}..."
ORIGINAL_DIR=$(pwd)
cd "${PB_MANAGER_INSTALL_DIR}" || error "Failed to change directory to ${PB_MANAGER_INSTALL_DIR}."

PB_MANAGER_DEPS="commander inquirer@8.2.4 fs-extra axios chalk@4.1.2 unzipper shelljs blessed blessed-contrib cli-table3 pretty-bytes@5.6.0"
info "Required dependencies: ${PB_MANAGER_DEPS}"
read -p "Do you want to install/update these dependencies now? [Y/n]: " install_deps
if [[ "$install_deps" =~ ^[Nn]$ ]]; then
  warn "Skipping dependency installation. pb-manager might not work correctly."
else
  if [ ! -f "package.json" ]; then
    info "No package.json found, creating one..."
    sudo npm init -y > /dev/null 2>&1 || warn "npm init -y failed, proceeding with dependency installation."
  fi
  sudo npm install ${PB_MANAGER_DEPS} > /dev/null 2>&1 || error "Failed to install pb-manager dependencies."
  success "pb-manager dependencies installed/updated."
fi
cd "${ORIGINAL_DIR}"

info "Creating symlink for pb-manager at ${PB_MANAGER_SYMLINK_PATH}..."
sudo ln -sfn "${PB_MANAGER_INSTALL_DIR}/pb-manager.js" "${PB_MANAGER_SYMLINK_PATH}" || error "Failed to create symlink for pb-manager."
success "Symlink created. You can now use 'pb-manager' command (you might need to open a new terminal session)."

if command_exists ufw; then
  info "Configuring firewall (UFW) to allow Nginx traffic (HTTP/HTTPS)..."
  sudo ufw allow 'Nginx Full' > /dev/null 2>&1 || warn "Failed to set UFW rule for 'Nginx Full'. You may need to configure your firewall manually."
  success "Firewall rules for Nginx (HTTP/HTTPS) applied/checked."
  info "Current UFW status:"
  sudo ufw status verbose
elif command_exists firewall-cmd; then
  info "Configuring firewall (firewalld) to allow Nginx traffic (HTTP/HTTPS)..."
  sudo firewall-cmd --permanent --add-service=http > /dev/null 2>&1 || warn "Failed to add HTTP service to firewalld."
  sudo firewall-cmd --permanent --add-service=https > /dev/null 2>&1 || warn "Failed to add HTTPS service to firewalld."
  sudo firewall-cmd --reload > /dev/null 2>&1 || warn "Failed to reload firewalld."
  success "Firewall rules for Nginx (HTTP/HTTPS) applied/checked."
  info "Current firewalld active services:"
  sudo firewall-cmd --list-services
else
  warn "No UFW or firewalld found. Please configure your firewall manually to allow HTTP (80) and HTTPS (443) traffic if needed."
fi

read -p "Do you want to run setup now to download PocketBase binaries? [Y/n]: " run_setup
if [[ "$run_setup" =~ ^[Nn]$ ]]; then
  info "You can run setup later with: cd ${PB_MANAGER_INSTALL_DIR} && sudo node pb-manager.js setup"
else
  info "Running setup to download PocketBase binaries..."
  cd "${PB_MANAGER_INSTALL_DIR}" || error "Failed to change directory to ${PB_MANAGER_INSTALL_DIR}."
  sudo node pb-manager.js setup > /dev/null 2>&1 || error "Setup failed. Please try running it manually later with: cd ${PB_MANAGER_INSTALL_DIR} && sudo node pb-manager.js setup"
  if [ $? -eq 0 ]; then
    success "Setup completed successfully."
  else
    error "Setup encountered errors."
  fi
fi

success "-------------------------------------------------------"
if [[ "$run_setup" =~ ^[Yy]$ ]]; then
  success "pb-manager installation and setup complete!"
else
  success "pb-manager installation complete!"
fi
success "-------------------------------------------------------"

info "For all commands and options, run: sudo pb-manager help"

exit 0
