# PocketBase Manager (`pb-manager`)

## Introduction

`pb-manager` is a command-line interface (CLI) tool designed to simplify the management of multiple PocketBase instances on a single Linux server. It automates setup, configuration, and ongoing maintenance tasks, including process management with PM2, reverse proxying with Nginx, SSL certificate handling with Certbot, and provides an interactive dashboard for instance monitoring.

### Why pb-manager?

Running multiple web applications, like PocketBase instances, on one server can become complex. Each instance needs:

- Its own isolated data directory.
- To run on a unique internal port.
- A way to be accessed via a public domain/subdomain.
- Process management to ensure it stays running.
- Optionally, HTTPS for secure connections.
- Secure and modern Nginx configuration.
- Easy monitoring and management.

`pb-manager` streamlines these processes by providing a single tool to:

- Download and manage the PocketBase executable (uses the latest version by default, with fallback and override options).
- Create and configure new PocketBase instances with isolated data.
- Automatically generate secure, modern Nginx reverse proxy configurations (with optional HTTP/2, security headers, and configurable max body size).
- Integrate with PM2 for process management (start, stop, restart, logs, auto-restart on crash/boot).
- Optionally, automate SSL certificate acquisition and renewal using Certbot for HTTPS.
- Update the core PocketBase executable using its built-in update mechanism and restart instances.
- Guide or automate the creation of the initial superuser (admin) account for each instance.
- **Reset an instance to a clean state, deleting all its data.**
- **Reset the admin password for an instance.**
- Enforce that all commands are run as root or with `sudo` for system-level operations.
- Offer an **interactive dashboard** to view instance status, resource usage, and perform quick actions.
- Allow you to enable or disable **complete logging** for more or less verbose output.
- Maintain an **audit log**: Records all `pb-manager` commands executed, with timestamps, for administrative auditing.
- Perform **DNS validation**: Before finalizing HTTPS configuration, validates that the domain's DNS A/AAAA records point to your server.
- Provide **PocketBase version notification**: Notifies you (with a 24h cache) when a new PocketBase version is available, at the start of every command.
- **Update itself**: Can fetch and install the latest version of `pb-manager` from GitHub.
- Renew SSL certificates for all instances using Certbot, with options to force renewal.

## How It Works

`pb-manager` orchestrates several components:

1.  **PocketBase Executable:** Downloads a PocketBase executable (latest version by default, or a specified version) and stores it in a central location (`~/.pb-manager/bin/`). All managed instances use this single binary.
2.  **Instance Configuration:** Details about each managed PocketBase instance (name, domain, port, data directory, HTTPS settings, HTTP/2, max body size) are stored in a JSON file (`~/.pb-manager/instances.json`).
3.  **CLI Configuration:** Global settings for `pb-manager` itself, like default Certbot email, default PocketBase version for setup, and logging verbosity, are stored in `~/.pb-manager/cli-config.json`.
4.  **Version Cache:** The latest fetched PocketBase version from GitHub is cached for 24 hours in `~/.pb-manager/version-cache.json` to reduce API calls.
5.  **Data Isolation:** Each instance is given its own data directory under `~/.pb-manager/instances_data/`, ensuring that databases and files are kept separate.
6.  **PM2:** For each instance, `pb-manager` generates an entry in a PM2 ecosystem file (`~/.pb-manager/ecosystem.config.js`). PM2 is then used to run, monitor, and manage the lifecycle of these PocketBase processes.
7.  **Nginx:** When an instance is added, `pb-manager` generates a secure Nginx server block configuration file in `/etc/nginx/sites-available/` and creates a symbolic link in `/etc/nginx/sites-enabled/`. This configures Nginx to act as a reverse proxy, forwarding requests from a public domain to the instance's internal port.
8.  **Certbot:** If HTTPS is enabled for an instance, `pb-manager` can attempt to run Certbot to obtain and install a Let's Encrypt SSL certificate for the specified domain. Certbot will modify the Nginx configuration to enable HTTPS. `pb-manager` also ensures a `dhparam.pem` file exists for stronger SSL.
9.  **Superuser Creation/Management:** When adding a new instance, `pb-manager` offers to create the initial PocketBase superuser (admin) account via the CLI, or guides you to do it via the web UI. It also provides a command to reset an admin's password.
10. **Interactive Dashboard:** Uses `blessed` and `blessed-contrib` to render a terminal-based UI for real-time monitoring and management of instances.
11. **Audit Log:** Every command run through `pb-manager` is recorded in an audit log (`~/.pb-manager/audit.log`) with a timestamp and details.
12. **DNS Validation:** When adding an instance with HTTPS, `pb-manager` checks that the domain resolves and points to your server's public IP before proceeding with Certbot.
13. **PocketBase Version Notification:** At the start of every command, `pb-manager` checks (using the version cache) if a new PocketBase version is available and notifies you.

## Prerequisites

Before using `pb-manager`, ensure the following are installed and configured on your Linux server (primarily tested on Ubuntu/Debian):

1.  **Node.js and npm:** Node.js v18.x or newer is recommended. Required to run the `pb-manager.js` script and install its dependencies.
    - Installation (if not present or older version): The automated installer handles this. Manually: `sudo apt update && sudo apt install nodejs npm` (check version after).
2.  **PM2:** The process manager.
    - Installation: `sudo npm install -g pm2`
    - Setup for auto-boot: `sudo pm2 startup` (follow instructions) and `sudo pm2 save`.
3.  **Nginx:** The web server/reverse proxy.
    - Installation: `sudo apt update && sudo apt install nginx`
    - Ensure it's running and enabled: `sudo systemctl start nginx && sudo systemctl enable nginx`.
4.  **Certbot (with Nginx plugin):** For SSL certificate management.
    - Installation: `sudo apt update && sudo apt install certbot python3-certbot-nginx`
5.  **`sudo` access:** All `pb-manager` commands require root privileges.
6.  **Firewall:** Ports 80 (HTTP) and 443 (HTTPS) must be open.
    - Example with `ufw`: `sudo ufw allow 'Nginx Full'` or `sudo ufw allow 80/tcp && sudo ufw allow 443/tcp`, then `sudo ufw enable`.
7.  **DNS Records:** For each domain/subdomain you intend to use, an A (and/or AAAA) record must point to your server's public IP address. This is crucial for Nginx and Certbot to function correctly. `pb-manager` will attempt to validate this.
8.  **Essential tools:** `curl` and `git` (usually pre-installed or installed by the automated script). `openssl` (for `dhparam` generation).

## Installation

### Automated Installation (Recommended)

The provided shell script installs `pb-manager`, all its dependencies, and configures necessary services on Debian-based systems (like Ubuntu).

1.  Ensure `curl` and `git` are installed:
    ```bash
    sudo apt update && sudo apt upgrade -y && sudo apt install -y curl git sudo
    ```
2.  Run the installer:
    ```bash
    curl -fsSL https://raw.githubusercontent.com/devAlphaSystem/Alpha-System-PBManager/main/install-pb-manager.sh | sudo bash
    ```

The installer will:

- Check for a Debian-based system.
- Update package lists.
- Install/verify Node.js (v18.x), npm, PM2, Nginx, and Certbot.
- Configure PM2 to start on boot.
- Download `pb-manager.js` to `/opt/pb-manager/`.
- Install Node.js dependencies for `pb-manager` in `/opt/pb-manager/`.
- Create a symlink `pb-manager` at `/usr/local/bin/pb-manager`.
- Attempt to configure UFW for Nginx traffic.

### Manual Installation

1.  **Create a directory for the script (e.g., in your home directory or `/opt` for system-wide):**
    ```bash
    sudo mkdir -p /opt/pb-manager # Or a path like ~/pocketbase-manager
    cd /opt/pb-manager
    ```
2.  **Download the `pb-manager.js` script** into this directory from the repository.
    ```bash
    sudo curl -fsSL https://raw.githubusercontent.com/devAlphaSystem/Alpha-System-PBManager/main/pb-manager.js -o pb-manager.js
    ```
3.  **Initialize npm and install dependencies:**
    ```bash
    sudo npm init -y
    sudo npm install commander inquirer@8.2.4 fs-extra axios chalk@4.1.2 unzipper shelljs blessed blessed-contrib cli-table3 pretty-bytes@5.6.0
    ```
4.  **Make the script executable:**
    ```bash
    sudo chmod +x pb-manager.js
    ```
5.  **(Optional but Recommended) Create a symlink for global access:**
    ```bash
    sudo ln -sfn /opt/pb-manager/pb-manager.js /usr/local/bin/pb-manager
    ```
    (Adjust the source path if you installed it elsewhere).

## Configuration Directory

`pb-manager` stores all its configuration files, the PocketBase binary, instance data, and logs within the `~/.pb-manager/` directory (relative to the home directory of the user running the script, typically root if using `sudo`).

- `~/.pb-manager/cli-config.json`: Global settings for the `pb-manager` tool (default Certbot email, default PB version, logging preference).
- `~/.pb-manager/instances.json`: Configuration for each managed PocketBase instance.
- `~/.pb-manager/ecosystem.config.js`: PM2 ecosystem file.
- `~/.pb-manager/bin/pocketbase`: The downloaded PocketBase executable.
- `~/.pb-manager/instances_data/<instance-name>/`: Data directory for each instance (contains `pb_data`, `pb_migrations`, etc.).
- `~/.pb-manager/audit.log`: Audit log of all `pb-manager` commands executed.
- `~/.pb-manager/version-cache.json`: Caches the latest PocketBase version information for 24 hours.

## Commands

```
  PocketBase Manager (pb-manager)
  A CLI tool to manage multiple PocketBase instances with Nginx, PM2, and Certbot.

  Version: 0.2.5

  Usage:
    sudo pb-manager <command> [options]

  Main Commands:
    dashboard                       Show interactive dashboard for all PocketBase instances
    add | create                    Register a new PocketBase instance
    clone <sourceName> <newName>    Clone an existing instance's data and config to a new one
    list [--json]                   List all managed PocketBase instances
    remove <name>                   Remove a PocketBase instance
    reset <name>                    Reset a PocketBase instance (delete all data and optionally create a new admin account)
    reset-admin <name>              Reset the admin password for a PocketBase instance

  Instance Management:
    start <name>                    Start a specific PocketBase instance via PM2
    stop <name>                     Stop a specific PocketBase instance via PM2
    restart <name>                  Restart a specific PocketBase instance via PM2
    logs <name>                     Show logs for a specific PocketBase instance from PM2

  Setup & Configuration:
    setup [--version]               Initial setup: creates directories and downloads PocketBase
    configure                       Set or view CLI configurations (default Certbot email, PB version, logging)

  Updates & Maintenance:
    renew-certificates [name|all]   Renew SSL certificates using Certbot (use --force to force renewal)
    update-pocketbase               Update the PocketBase executable and restart all instances
    update-ecosystem                Regenerate the PM2 ecosystem file and reload PM2
    update-pb-manager               Update the pb-manager CLI from GitHub

  Other:
    audit                           Show the history of commands executed by this CLI (includes errors)
    help [command]                  Show help for a specific command

  Run all commands as root or with sudo.
```

A notification about new PocketBase versions (if available) and audit logging occur automatically before each command.

### Main Commands

#### `dashboard`

**Purpose:** Shows an interactive terminal-based dashboard for all managed PocketBase instances.
**Usage:** `sudo pb-manager dashboard`
**Features:**

- Real-time view of: Instance Name, Domain, Port, PM2 Status, HTTP Health Check, SSL Status, CPU/Memory usage, Uptime, Data Directory Size.
- **Hotkeys:** `q` (Quit), `r` (Refresh), `l` (Logs), `s` (Start/Stop), `d` (Delete instance - will prompt for confirmation via `pb-manager remove`).

#### `add` (alias: `create`)

**Purpose:** Adds and configures a new PocketBase instance.
**Usage:** `sudo pb-manager add`
**Details:** Interactive prompts for instance name, domain, port, HTTP/2, max body size, HTTPS (Certbot), and initial admin creation.
**Actions:** DNS validation, data directory creation, Nginx config generation (including `dhparam.pem` check), Certbot (optional), PM2 setup, admin creation (optional).

#### `clone <sourceName> <newName>`

**Purpose:** Clones an existing PocketBase instance's data and configuration to a new instance.
**Usage:** `sudo pb-manager clone <source-instance-name> <new-instance-name>`
**Arguments:**

- `<source-instance-name>`: The name of the existing instance to clone.
- `<new-instance-name>`: The name for the new cloned instance.
  **Details:**
- Copies the entire data directory from the source instance.
- Prompts for new domain, port, and other configuration details for the cloned instance, similar to the `add` command.
- Sets up Nginx, PM2, and optionally Certbot for the new instance.
- Offers to create an _additional_ superuser for the cloned instance (existing users are cloned).

#### `list [--json]`

**Purpose:** Lists all PocketBase instances managed by `pb-manager`.
**Usage:** `sudo pb-manager list` or `sudo pb-manager list --json`
**Options:**

- `--json`: Output the list in JSON format.
  **Details:** Displays Name, Domain, Protocol, Public URL, Internal Port, Data Directory, PM2 Status, Local Admin URL, SSL Expiry (in days).

#### `remove <name>`

**Purpose:** Removes a managed PocketBase instance.
**Usage:** `sudo pb-manager remove <instance-name>`
**Arguments:**

- `<instance-name>`: The name of the instance to remove.
  **Details:** Confirms action, stops/deletes PM2 process, removes Nginx config. **Data directory is NOT deleted automatically.**

#### `reset <name>`

**Purpose:** Resets a PocketBase instance to its initial state. **This is a destructive operation.**
**Usage:** `sudo pb-manager reset <instance-name>`
**Arguments:**

- `<instance-name>`: The name of the instance to reset.
  **Details:**
- Asks for explicit confirmation.
- Stops and removes the instance's PM2 process.
- **Deletes the entire data directory** for the instance (e.g., `~/.pb-manager/instances_data/<instance-name>/`).
- Recreates an empty data directory.
- Updates PM2 and restarts the instance.
- Prompts to create a new superuser (admin) account.

#### `reset-admin <name>`

**Purpose:** Resets the password for a superuser (admin) account of a specific PocketBase instance.
**Usage:** `sudo pb-manager reset-admin <instance-name>`
**Arguments:**

- `<instance-name>`: The name of the instance.
  **Details:**
- Prompts for the admin email and the new password.
- Uses the PocketBase `superuser update` command.

### Instance Management

#### `start <name>`

**Purpose:** Starts a specific PocketBase instance via PM2.
**Usage:** `sudo pb-manager start <instance-name>`

#### `stop <name>`

**Purpose:** Stops a specific PocketBase instance via PM2.
**Usage:** `sudo pb-manager stop <instance-name>`

#### `restart <name>`

**Purpose:** Restarts a specific PocketBase instance via PM2.
**Usage:** `sudo pb-manager restart <instance-name>`

#### `logs <name>`

**Purpose:** Displays logs for a specific PocketBase instance from PM2.
**Usage:** `sudo pb-manager logs <instance-name>` (Tails logs, `Ctrl+C` to exit.)

### Setup & Configuration

#### `setup [--version]`

**Purpose:** Performs initial setup. Creates directories and downloads the PocketBase executable.
**Usage:** `sudo pb-manager setup` or `sudo pb-manager setup -v <version>`
**Options:**

- `-v, --version <version>`: Specify PocketBase version (e.g., `0.28.1`). Defaults to latest or configured version.

#### `configure`

**Purpose:** Set or view global CLI configurations.
**Usage:** `sudo pb-manager configure`
**Details:** Interactive command for Default Certbot Email, Default PocketBase Version for new setups, and complete logging preference.

### Updates & Maintenance

#### `update-pocketbase`

**Purpose:** Updates the core PocketBase executable and restarts all instances.
**Usage:** `sudo pb-manager update-pocketbase`
**Details:** Runs PocketBase's built-in `update` command using the executable in `~/.pb-manager/bin/pocketbase`, then restarts all managed instances via PM2.

#### `renew-certificates [instanceName|all]`

**Purpose:** Renews SSL certificates using Certbot.
**Usage:** `sudo pb-manager renew-certificates [instance-name|all] [--force]`
**Arguments:**

- `[instance-name]`: (Optional) The name of a specific instance whose certificate should be renewed.
- `all`: (Optional, default if no name provided) Attempts to renew all certificates managed by Certbot that are due.
  **Options:**
- `-f, --force`: Force Certbot to attempt renewal even if the certificate is not yet due for expiry.
  **Details:** Reloads Nginx after renewal attempts.

#### `update-ecosystem`

**Purpose:** Regenerates the PM2 ecosystem file and reloads PM2.
**Usage:** `sudo pb-manager update-ecosystem`
**Details:** Useful if the `ecosystem.config.js` file needs to be rebuilt from the current `instances.json`.

#### `update-pb-manager`

**Purpose:** Update `pb-manager` itself from the latest version on GitHub.
**Usage:** `sudo pb-manager update-pb-manager`
**Details:**

- Downloads the latest `pb-manager.js` script from the `devAlphaSystem/Alpha-System-PBManager` repository (main branch).
- Overwrites the currently installed script (e.g., at `/opt/pb-manager/pb-manager.js`).
- Prompts if you want to reinstall Node.js dependencies (`npm install`) in the script's directory.

### Other

#### `audit`

**Purpose:** Displays the audit log of commands executed by `pb-manager`, including any errors that occurred during command execution.
**Usage:** `sudo pb-manager audit` (Shows `~/.pb-manager/audit.log`)

#### `help [command]`

**Purpose:** Show help for `pb-manager` or a specific command.
**Usage:** `sudo pb-manager help` or `sudo pb-manager help <command-name>`

## Superuser (Admin) Account Creation

When adding a new instance (`pb-manager add`), cloning an instance (`pb-manager clone`), or resetting an instance (`pb-manager reset`), `pb-manager` offers to create the initial/additional superuser (admin) account via the CLI. It uses a command similar to:
`pocketbase superuser create "<email>" "<password>" --dir "<instance_data_dir>" --migrationsDir "<instance_data_dir>/pb_migrations"`

If you opt-out or it fails, you can create it via the web admin UI:

- Visit `https://your-domain.com/_/` (if HTTPS is set up) or `http://your-domain.com/_/`.
- Alternatively, for local access/troubleshooting: `http://127.0.0.1:<instance_port>/_/` (may require SSH port forwarding for headless servers: `ssh -L <instance_port>:127.0.0.1:<instance_port> user@your_server_ip`).
- PocketBase will prompt you to create the first admin account if none exist. For cloned instances, existing admin accounts from the source will be available.

If you need to reset an existing admin password, you can use the `pb-manager reset-admin <instance-name>` command.

## Nginx Configuration Features

- **HTTP/2:** Optionally enabled per instance for improved performance.
- **Security Headers:** Includes `Strict-Transport-Security`, `X-Content-Type-Options`, `X-Frame-Options`, `X-XSS-Protection` by default.
- **Upload Limit:** Optionally set `client_max_body_size 20M` per instance.
- **HTTPS:** Full Let's Encrypt integration via Certbot.
- **Automatic HTTP to HTTPS redirection** when HTTPS is enabled and Certbot succeeds.
- **Diffie-Hellman Parameters:** Ensures `ssl-dhparam.pem` (e.g., `/etc/letsencrypt/ssl-dhparam.pem`) exists for stronger SSL/TLS, generating it if necessary.

## Logging

- **CLI Verbosity:** Control the amount of output from `pb-manager` commands using the `configure` command (`Enable complete logging`).
  - **Disabled (default):** Concise output.
  - **Enabled:** Shows detailed shell commands, PM2 actions, etc.
- **Instance Logs:** View individual PocketBase instance logs using `pb-manager logs <name>` or `pm2 logs pb-<name>`.

## Audit Log

All `pb-manager` commands are logged to `~/.pb-manager/audit.log` with a timestamp, the full command executed, and any errors that occurred during the command's execution. This provides a trail of administrative actions performed by the tool.

## PocketBase Version Notification

Before executing any command, `pb-manager` checks (with a 24-hour cache) if a newer version of PocketBase is available on GitHub. If so, it displays a notification, prompting you to consider using `pb-manager update-pocketbase`.

## DNS Validation

When adding an instance with HTTPS, `pb-manager` verifies that the provided domain name resolves to the server's public IP address (IPv4 or IPv6). This proactive check helps prevent Certbot failures due to DNS misconfiguration.

## Potential Issues & Disclaimer

While `pb-manager` aims to automate and simplify, be aware of:

- **Dependency Issues:** Conflicts with system Node.js, PM2, Nginx, or Certbot versions.
- **Nginx Errors:** Incorrect Nginx configurations (by this tool or others) can disrupt web services. Test with `sudo nginx -t`.
- **Certbot Failures:** Can occur due to DNS issues, rate limits, firewall blocks, or Nginx plugin problems.
- **PM2 Problems:** Instances might not start/restart correctly. Check `pm2 logs`.
- **Permissions:** Ensure correct file system permissions. Running with `sudo` generally handles this.
- **PocketBase Updates:** Breaking changes in PocketBase itself could affect instances. Review release notes.
- **Data Loss Risk:**
  - The `remove` command doesn't delete data by default, but **always back up your data independently.**
  - The `reset <name>` command is **highly destructive** and will permanently delete all data for the specified instance. Use with extreme caution.
  - The `clone <sourceName> <newName>` command copies data. Ensure the source data is what you intend to replicate.
- **Script Bugs:** The tool may have bugs. Test in non-critical environments first.
- **Network Connectivity:** Required for downloads and API interactions.
- **Resource Limits:** Monitor server resources if running many instances.

**Disclaimer:** This tool is provided as-is, without warranty. The user assumes all responsibility. **Always back up critical data.**

## Important Notes

### Sudo Usage

**All `pb-manager` commands must be run as root or with `sudo`.** This is essential for managing system services (Nginx, PM2), files in protected locations, and network configurations.

### DNS Configuration

Correct DNS A (and/or AAAA) records pointing to your server's IP are **critical** for domain access and HTTPS. Ensure propagation before setup. `pb-manager` attempts to validate this for HTTPS setups.

### Backups

`pb-manager` **does not** handle data backups. Implement your own strategy for backing up the `~/.pb-manager/instances_data/<instance-name>/` directories and potentially the `~/.pb-manager/` configuration directory itself.

### Security

- Secure PocketBase admin accounts with strong passwords.
- Keep your server and all software (OS, Nginx, PM2, Node.js, PocketBase) updated.
- Review Nginx configurations for any site-specific hardening needed beyond the defaults provided.
- Regularly review the audit log (`pb-manager audit`).
