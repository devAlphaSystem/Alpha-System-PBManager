# PocketBase Manager (`pb-manager`)

`pb-manager` is a command-line interface (CLI) tool designed to simplify the management of multiple PocketBase instances on a single Linux server. It automates setup, configuration, and ongoing maintenance tasks, including process management with PM2, reverse proxying with Nginx, SSL certificate handling with Certbot, and provides an interactive dashboard for instance monitoring.

It supports Debian-based (like Ubuntu), RHEL-based (like Fedora, CentOS, Oracle Linux), and Arch-based Linux distributions.

**Version: 0.5.0**

## Key Features

- **Simplified Instance Management:** Add, remove, clone, reset, start, stop, and restart PocketBase instances.
- **Automated Setup:** Downloads PocketBase, sets up data directories, and configures system services.
- **Nginx Integration:** Automatically generates secure Nginx reverse proxy configurations with HTTP/2, security headers, and custom upload limits. Adapts to different Linux distributions (Debian, RHEL, Arch).
- **PM2 Integration:** Manages PocketBase processes, ensuring they run continuously and restart on boot/crash.
- **Certbot for HTTPS:** Automates SSL certificate acquisition and renewal with Let's Encrypt.
- **Interactive Dashboard:** Monitor instance status, resource usage, and perform quick actions from a terminal UI.
- **Cloning & Reset:** Easily clone instances (data and config) or reset instances to a clean state.
- **Admin Management:** Assists with initial admin creation and provides a command to reset admin passwords.
- **Self-Update:** The CLI can update itself to the latest version from GitHub.
- **Audit Logging:** Keeps a log of all commands executed by the CLI.
- **DNS Validation & Version Notifications:** Proactive checks and helpful information.
- **WSL2 Support:** Includes prompts to help enable `systemd` on WSL2 for full service functionality.

## Prerequisites (Brief)

- A supported Linux distribution (Debian, RHEL, Arch based).
- Node.js v20.x+ and npm.
- PM2, Nginx, Certbot (with Nginx plugin).
- `curl`, `git`, `openssl`.
- `sudo` access.
- Firewall configured for HTTP/HTTPS.
- DNS records pointing to your server.

The automated installer attempts to install/verify most of these.

## Quick Installation (Recommended)

1.  Ensure `curl` and `git` are installed.
    #### For Debian/Ubuntu
    ```bash
    sudo apt update && sudo apt upgrade -y && sudo apt install -y curl git sudo
    ```
    #### For RHEL/Fedora
    ```bash
    sudo dnf install -y curl git sudo
    ```
    #### For Arch
    ```bash
    sudo pacman -Syu --noconfirm curl git sudo
    ```
2.  Run the installer:
    ```bash
    sudo curl -fsSL https://raw.githubusercontent.com/devAlphaSystem/Alpha-System-PBManager/main/install-pb-manager.sh -o /tmp/install-pb-manager.sh && sudo bash /tmp/install-pb-manager.sh && sudo rm /tmp/install-pb-manager.sh
    ```
    This script will guide you through the installation of `pb-manager` and its dependencies.

## Documentation

For detailed information on commands, features, manual installation, and troubleshooting, please refer to the full documentation:

➡️ **[DOCUMENTATION](https://docs.alphasystem.dev/view/5hnk7504ca02hpu)**

## Disclaimer

This tool is provided as-is, without warranty. The user assumes all responsibility. **Always back up critical data before performing operations like `remove` or `reset`.**
