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

LOG_FILE="/var/log/pb-manager-installer.log"
PACMAN_SYU_DONE=0
PKG_MANAGER=""
UPDATE_CMD=""
INSTALL_CMD=""

info() {
  echo -e "${GREEN}[INFO]${NC} $1"
}

warn() {
  echo -e "${YELLOW}[WARN]${NC} $1"
}

error() {
  echo -e "${RED}[ERROR]${NC} $1"
  if [ -f "${LOG_FILE}" ]; then
    echo -e "${RED}[ERROR]${NC} Check ${LOG_FILE} for more details."
  fi
  exit 1
}

success() {
  echo -e "${GREEN}[SUCCESS]${NC} $1"
}

init_log_file() {
  echo "pb-manager installation started at $(date)" > "${LOG_FILE}"
  chmod 644 "${LOG_FILE}"
  info "Detailed installation log will be available at ${LOG_FILE}"
}

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

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
  local enable_systemd
  read -p "Do you want this script to attempt to add 'systemd=true' to /etc/wsl.conf for you? [y/N]: " enable_systemd
  if [[ "$enable_systemd" =~ ^[Yy]$ ]]; then
    local wsl_conf_file="/etc/wsl.conf"
    local wsl_conf_updated=0

    if [ ! -f "$wsl_conf_file" ]; then
      touch "$wsl_conf_file"
    fi

    if ! grep -q "^\s*\[boot\]" "$wsl_conf_file" 2>/dev/null; then
      if [ -s "$wsl_conf_file" ] && [ "$(tail -c1 "$wsl_conf_file"; echo x)" != $'\nx' ]; then
        echo >> "$wsl_conf_file"
      fi
      echo -e "\n[boot]" >> "$wsl_conf_file"
      wsl_conf_updated=1
    fi

    if grep -q "^\s*\[boot\]" "$wsl_conf_file" && ! grep -Eq "^\s*systemd\s*=\s*true\s*$" <(awk '/^\s*\[boot\]/{f=1;next} /^\s*\[/{f=0} f' "$wsl_conf_file"); then
      sed -i '/^\s*\[boot\]/,/^\s*\[/s/^\s*systemd\s*=.*/# & (commented by pb-manager installer)/' "$wsl_conf_file"
      sed -i '/^\s*\[boot\]/a systemd=true' "$wsl_conf_file"
      wsl_conf_updated=1
    elif ! grep -q "^\s*\[boot\]" "$wsl_conf_file"; then
      echo "systemd=true" >> "$wsl_conf_file"
      wsl_conf_updated=1
    fi

    if [ "$wsl_conf_updated" -eq 1 ]; then
      success "systemd configuration has been updated in /etc/wsl.conf."
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
    UPDATE_CMD="dnf makecache --timer"
    INSTALL_CMD="dnf install -y"
    info "Detected Fedora/RHEL/Oracle-based system (dnf)."
  elif command_exists pacman; then
    PKG_MANAGER="pacman"
    UPDATE_CMD="pacman -Sy --noconfirm"
    INSTALL_CMD="pacman -S --noconfirm"
    info "Detected Arch-based system (pacman)."
  else
    error "This installation script currently only supports Debian (apt), Fedora/RHEL/Oracle (dnf), or Arch (pacman) based Linux distributions."
  fi
}

update_system_packages() {
  info "Updating package lists and system (this may take a moment for Arch)..."
  if [ "$PKG_MANAGER" = "pacman" ]; then
    if pacman -Sy --noconfirm >> "${LOG_FILE}" 2>&1; then
      PACMAN_SYU_DONE=1
    else
      error "Failed to update system via pacman."
    fi
  else
    if ! ${UPDATE_CMD} >> "${LOG_FILE}" 2>&1; then
      error "Failed to update package lists."
    fi
  fi
}

install_essential_tools() {
  local essential_tools="curl git openssl"
  info "Ensuring essential tools (${essential_tools}) are installed..."
  if ! ${INSTALL_CMD} ${essential_tools} >> "${LOG_FILE}" 2>&1; then
    error "Failed to install essential tools."
  fi
}

install_nodejs() {
  if command_exists node && command_exists npm; then
    local node_version_raw
    node_version_raw=$(node -v)
    local npm_version_raw
    npm_version_raw=$(npm -v)
    info "Node.js and npm are already installed."
    local node_major_version
    node_major_version=$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo "0")
    if [[ "$node_major_version" -lt 20 ]]; then
      warn "Installed Node.js version is $node_version_raw (Major $node_major_version), which is older than v20.x. pb-manager recommends v20.x or newer. Consider upgrading Node.js."
    else
      info "Node version: $node_version_raw, npm version: $npm_version_raw"
    fi
  else
    info "Node.js (v20.x) and npm are not found."
    local install_node
    read -p "Do you want to install Node.js v20.x and npm now? [Y/n]: " install_node
    if [[ "$install_node" =~ ^[Nn]$ ]]; then
      error "Node.js and npm are required. Installation aborted."
    fi
    info "Installing Node.js (v20.x) and npm..."
    if [ "$PKG_MANAGER" = "apt" ]; then
      curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >> "${LOG_FILE}" 2>&1
      if ! apt-get install -y nodejs >> "${LOG_FILE}" 2>&1; then
        error "Failed to install Node.js via apt."
      fi
    elif [ "$PKG_MANAGER" = "dnf" ];then
      curl -fsSL https://rpm.nodesource.com/setup_20.x | bash - >> "${LOG_FILE}" 2>&1
      if ! dnf install -y nodejs >> "${LOG_FILE}" 2>&1; then
        error "Failed to install Node.js via dnf."
      fi
    elif [ "$PKG_MANAGER" = "pacman" ]; then
      if ! pacman -S --noconfirm nodejs npm >> "${LOG_FILE}" 2>&1; then
        error "Failed to install Node.js and npm via pacman."
      fi
      local node_version_raw_pacman
      node_version_raw_pacman=$(node -v 2>/dev/null || echo "v0.0.0")
      local node_major_version_pacman
      node_major_version_pacman=$(echo "$node_version_raw_pacman" | cut -d. -f1 | sed 's/v//' 2>/dev/null || echo "0")
      if [[ "$node_major_version_pacman" -lt 20 ]]; then
        warn "Installed Node.js version on Arch is $node_version_raw_pacman (Major $node_major_version_pacman), which is older than recommended v20.x. pb-manager might have issues. Consider using a Node version manager (like nvm) to install Node v20+."
      fi
    fi
    success "Node.js and npm installed successfully."
    info "Node version: $(node -v), npm version: $(npm -v)"
  fi
}

install_pm2() {
  if command_exists pm2; then
    info "PM2 is already installed."
  else
    info "PM2 is not found."
    local install_pm2
    read -p "Do you want to install PM2 globally via npm now? [Y/n]: " install_pm2
    if [[ "$install_pm2" =~ ^[Nn]$ ]]; then
      error "PM2 is required. Installation aborted."
    fi
    info "Installing PM2 globally..."
    if ! npm install -g pm2 >> "${LOG_FILE}" 2>&1; then
      error "Failed to install PM2."
    fi
    success "PM2 installed successfully."
  fi
}

configure_pm2_startup() {
  info "Configuring PM2 to start on system boot..."
  if command_exists pm2; then
    local pm2_hp="/root"
    local pm2_startup_cmd_output=""
    info "Attempting to configure PM2 startup for user root with home path ${pm2_hp}..."
    
    set +e
    pm2_startup_cmd_output=$(pm2 startup systemd -u root --hp "${pm2_hp}" 2>&1)
    local pm2_exit_code=$?
    set -e

    echo "PM2 Startup Command Output:" >> "${LOG_FILE}"
    echo "${pm2_startup_cmd_output}" >> "${LOG_FILE}"
    echo "PM2 Startup Command Exit Code: ${pm2_exit_code}" >> "${LOG_FILE}"

    if [ ${pm2_exit_code} -ne 0 ]; then
      warn "PM2 startup command failed or produced warnings (exit code ${pm2_exit_code}). Output was:"
      echo -e "${YELLOW}${pm2_startup_cmd_output}${NC}"
    else
      info "PM2 startup command executed."
    fi

    if echo "$pm2_startup_cmd_output" | grep -q "command"; then
      warn "PM2 startup configuration might require you to run a command manually."
      echo -e "${YELLOW}PM2 output (if any relevant command is shown, please execute it):${NC}\n$pm2_startup_cmd_output"
      local continue_key
      read -p "Press [Enter] to continue after reviewing/running the command, or [S] to skip PM2 save..." continue_key
      if [[ "$continue_key" =~ ^[Ss]$ ]]; then
        warn "Skipping pm2 save."
      else
        if ! pm2 save --force >> "${LOG_FILE}" 2>&1; then
          warn "Failed to save PM2 process list. This might be okay if no processes are running yet. Check ${LOG_FILE} for details."
        fi
      fi
    else
      info "PM2 startup command processed. Saving current PM2 process list (if any)..."
      if ! pm2 save --force >> "${LOG_FILE}" 2>&1; then
        warn "Failed to save PM2 process list. Check ${LOG_FILE} for details."
      fi
    fi
    success "PM2 startup configured (or attempted)."
  else
    warn "PM2 not found, skipping PM2 startup configuration."
  fi
}

install_nginx() {
  if command_exists nginx; then
    info "Nginx is already installed."
  else
    info "Nginx is not found."
    local install_nginx
    read -p "Do you want to install Nginx now? [Y/n]: " install_nginx
    if [[ "$install_nginx" =~ ^[Nn]$ ]]; then
      error "Nginx is required. Installation aborted."
    fi
    info "Installing Nginx..."
    if ! ${INSTALL_CMD} nginx >> "${LOG_FILE}" 2>&1; then
      error "Failed to install Nginx."
    fi
    success "Nginx installed successfully."
  fi
}

configure_nginx_service() {
  info "Ensuring Nginx is started and enabled on boot..."
  if command_exists systemctl; then
    if ! systemctl start nginx >> "${LOG_FILE}" 2>&1; then
      warn "Failed to start Nginx. It might already be running or there might be a configuration issue. Check ${LOG_FILE} for details."
    fi
    if ! systemctl enable nginx >> "${LOG_FILE}" 2>&1; then
      warn "Failed to enable Nginx on boot. Check ${LOG_FILE} for details."
    fi
  else
    warn "systemctl not found. Attempting to manage Nginx directly. This might not ensure it starts on boot."
    if nginx -t >> "${LOG_FILE}" 2>&1; then
      if ! (nginx -s reload || nginx) >> "${LOG_FILE}" 2>&1; then
         warn "Tried to reload/start Nginx directly, but it might have failed. Check ${LOG_FILE} for details."
      fi
    else
      warn "Nginx configuration test failed. Nginx not started/reloaded. Check ${LOG_FILE} for details."
    fi
  fi
  success "Nginx service configured."
}

install_certbot() {
  if command_exists certbot; then
    info "Certbot is already installed."
  else
    info "Certbot is not found."
    local install_certbot
    read -p "Do you want to install Certbot and its Nginx plugin now? [Y/n]: " install_certbot
    if [[ "$install_certbot" =~ ^[Nn]$ ]]; then
      warn "Certbot not installed. HTTPS setup via pb-manager will not be available."
    else
      info "Installing Certbot and its Nginx plugin..."
      if [ "$PKG_MANAGER" = "apt" ]; then
        if ! (${INSTALL_CMD} certbot python3-certbot-nginx || ${INSTALL_CMD} certbot certbot-nginx) >> "${LOG_FILE}" 2>&1; then
          error "Failed to install Certbot or its Nginx plugin via apt."
        fi
      elif [ "$PKG_MANAGER" = "dnf" ]; then
        if ! dnf repolist enabled | grep -q -i 'epel'; then
            info "EPEL repository not found or not enabled. Attempting to install epel-release..."
            if ${INSTALL_CMD} epel-release >> "${LOG_FILE}" 2>&1; then
                success "epel-release installed."
                ${UPDATE_CMD} >> "${LOG_FILE}" 2>&1
            else
                warn "Failed to install epel-release. Certbot installation might fail if it depends on EPEL. Check ${LOG_FILE} for details."
            fi
        fi
        if ! (${INSTALL_CMD} certbot python3-certbot-nginx || ${INSTALL_CMD} certbot certbot-nginx) >> "${LOG_FILE}" 2>&1; then
          error "Failed to install Certbot or its Nginx plugin via dnf."
        fi
      elif [ "$PKG_MANAGER" = "pacman" ]; then
        if [ "$PACMAN_SYU_DONE" -eq 0 ]; then
          warn "Full system update before certbot was not performed or failed. This might cause issues."
        fi
        if ! pacman -S --noconfirm certbot certbot-nginx >> "${LOG_FILE}" 2>&1; then
          error "Failed to install Certbot or its Nginx plugin via pacman."
        fi
      fi
      success "Certbot and Nginx plugin installed successfully."
    fi
  fi
}

setup_pbmanager_script() {
  info "Setting up pb-manager CLI script (pb-manager.js)..."
  if [ -f "${PB_MANAGER_INSTALL_DIR}/pb-manager.js" ]; then
    warn "${PB_MANAGER_INSTALL_DIR}/pb-manager.js already exists."
    local overwrite_script
    read -p "Do you want to overwrite it with the latest version from the repository? [Y/n]: " overwrite_script
    if [[ "$overwrite_script" =~ ^[Nn]$ ]]; then
      info "Skipping download of pb-manager.js. Using existing version."
    else
      info "Downloading pb-manager.js from ${PB_MANAGER_SCRIPT_URL}..."
      if ! curl -fsSL "${PB_MANAGER_SCRIPT_URL}" -o "${PB_MANAGER_INSTALL_DIR}/pb-manager.js" >> "${LOG_FILE}" 2>&1; then
        error "Failed to download pb-manager.js."
      fi
      if ! chmod +x "${PB_MANAGER_INSTALL_DIR}/pb-manager.js"; then
        error "Failed to make pb-manager.js executable."
      fi
      success "pb-manager.js downloaded/updated and made executable."
    fi
  else
    if ! mkdir -p "${PB_MANAGER_INSTALL_DIR}"; then
      error "Failed to create directory ${PB_MANAGER_INSTALL_DIR}."
    fi
    info "Downloading pb-manager.js from ${PB_MANAGER_SCRIPT_URL}..."
    if ! curl -fsSL "${PB_MANAGER_SCRIPT_URL}" -o "${PB_MANAGER_INSTALL_DIR}/pb-manager.js" >> "${LOG_FILE}" 2>&1; then
      error "Failed to download pb-manager.js."
    fi
    if ! chmod +x "${PB_MANAGER_INSTALL_DIR}/pb-manager.js"; then
      error "Failed to make pb-manager.js executable."
    fi
    success "pb-manager.js downloaded and made executable."
  fi

  info "Installing Node.js dependencies for pb-manager CLI in ${PB_MANAGER_INSTALL_DIR}..."
  local original_dir
  original_dir=$(pwd)
  if ! cd "${PB_MANAGER_INSTALL_DIR}"; then
    error "Failed to change directory to ${PB_MANAGER_INSTALL_DIR}."
  fi

  local pb_manager_deps="commander inquirer@8.2.4 fs-extra axios chalk@4.1.2 unzipper shelljs blessed blessed-contrib cli-table3 pretty-bytes@5.6.0"
  info "Required CLI dependencies: ${pb_manager_deps}"
  local install_deps
  read -p "Do you want to install/update these CLI dependencies now? [Y/n]: " install_deps
  if [[ "$install_deps" =~ ^[Nn]$ ]]; then
    warn "Skipping CLI dependency installation. pb-manager CLI might not work correctly."
  else
    if [ ! -f "package.json" ]; then
      info "No package.json found for CLI, creating one..."
      if ! npm init -y >> "${LOG_FILE}" 2>&1; then
        warn "npm init -y failed, proceeding with CLI dependency installation. Check ${LOG_FILE} for details."
      fi
    fi
    if ! npm install --save ${pb_manager_deps} >> "${LOG_FILE}" 2>&1; then
      error "Failed to install pb-manager CLI dependencies."
    fi
    success "pb-manager CLI dependencies installed/updated."
  fi
  if ! cd "${original_dir}"; then
    error "Failed to change back to original directory ${original_dir}."
  fi

  info "Creating symlink for pb-manager CLI at ${PB_MANAGER_SYMLINK_PATH}..."
  if ! ln -sfn "${PB_MANAGER_INSTALL_DIR}/pb-manager.js" "${PB_MANAGER_SYMLINK_PATH}"; then
    error "Failed to create symlink for pb-manager."
  fi
  success "Symlink created. You can now use 'pb-manager' command (you might need to open a new terminal session)."
}

configure_firewall() {
  if command_exists ufw; then
    info "Configuring firewall (UFW) to allow Nginx traffic (HTTP/HTTPS)..."
    if ! ufw allow 'Nginx Full' >> "${LOG_FILE}" 2>&1; then
      warn "Failed to set UFW rule for 'Nginx Full'. You may need to configure your firewall manually. Check ${LOG_FILE} for details."
    fi
    success "Firewall rules for Nginx (HTTP/HTTPS) applied/checked."
    info "Current UFW status:"
    ufw status verbose
  elif command_exists firewall-cmd; then
    info "Configuring firewall (firewalld) to allow Nginx traffic (HTTP/HTTPS)..."
    if ! firewall-cmd --permanent --add-service=http >> "${LOG_FILE}" 2>&1; then
      warn "Failed to add HTTP service to firewalld. Check ${LOG_FILE} for details."
    fi
    if ! firewall-cmd --permanent --add-service=https >> "${LOG_FILE}" 2>&1; then
      warn "Failed to add HTTPS service to firewalld. Check ${LOG_FILE} for details."
    fi
    if ! firewall-cmd --reload >> "${LOG_FILE}" 2>&1; then
      warn "Failed to reload firewalld. Check ${LOG_FILE} for details."
    fi
    success "Firewall rules for Nginx (HTTP/HTTPS) applied/checked."
    info "Current firewalld active services:"
    firewall-cmd --list-services
  else
    warn "No UFW or firewalld found. Please configure your firewall manually to allow HTTP (80) and HTTPS (443) traffic if needed."
  fi
}

run_pbmanager_cli_setup() {
  local run_cli_setup
  read -p "Do you want to run pb-manager CLI setup now to download PocketBase binaries? [Y/n]: " run_cli_setup
  if [[ "$run_cli_setup" =~ ^[Nn]$ ]]; then
    info "You can run CLI setup later with: pb-manager setup"
  else
    info "Running pb-manager CLI setup to download PocketBase binaries..."
    set +e
    "${PB_MANAGER_SYMLINK_PATH}" setup
    local cli_setup_exit_code=$?
    set -e
    if [ ${cli_setup_exit_code} -eq 0 ]; then
      success "CLI Setup completed successfully."
    else
      error "CLI Setup encountered errors (exit code ${cli_setup_exit_code}). Please try running it manually later with: pb-manager setup"
    fi
  fi
  return $cli_setup_exit_code
}

main() {
  init_log_file

  if [ "$(id -u)" -ne 0 ]; then
    error "This script must be run as root or with sudo."
  fi

  check_distro

  if is_wsl2; then
    if ! pgrep -x systemd >/dev/null 2>&1 && ! systemctl is-system-running --quiet --wait 2>/dev/null; then
      prompt_enable_systemd_wsl2
    else
      info "WSL2 detected and systemd appears to be running."
    fi
  fi

  update_system_packages
  install_essential_tools
  install_nodejs
  install_pm2
  configure_pm2_startup
  install_nginx
  configure_nginx_service
  install_certbot
  setup_pbmanager_script
  configure_firewall

  local cli_setup_successful=1
  local run_cli_setup_response
  run_pbmanager_cli_setup
  cli_setup_successful=$?

  success "-------------------------------------------------------"
  if [ ${cli_setup_successful} -eq 0 ]; then
    success "pb-manager CLI installation and setup complete!"
  else
    success "pb-manager CLI installation complete!"
    if [[ "$run_cli_setup_response" =~ ^[Yy]$ ]]; then
       warn "CLI setup was attempted but encountered issues."
    fi
  fi
  success "-------------------------------------------------------"

  info "For all commands and options, run: sudo pb-manager help"
  info "A detailed installation log is available at ${LOG_FILE}"
  exit 0
}

main "$@"
