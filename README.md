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
- Enforce that all commands are run as root or with `sudo` for system-level operations.
- Offer an **interactive dashboard** to view instance status, resource usage, and perform quick actions.
- Allow you to enable or disable **complete logging** for more or less verbose output.
- Maintain an **audit log**: Records all `pb-manager` commands executed, with timestamps, for administrative auditing.
- Perform **DNS validation**: Before finalizing HTTPS configuration, validates that the domain's DNS A/AAAA records point to your server.
- Provide **PocketBase version notification**: Notifies you (with a 24h cache) when a new PocketBase version is available, at the start of every command.

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
9.  **Superuser Creation:** When adding a new instance, `pb-manager` offers to create the initial PocketBase superuser (admin) account via the CLI, or guides you to do it via the web UI.
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
8.  **Essential tools:** `curl` and `git` (usually pre-installed or installed by the automated script).

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

**All commands must be run as root or with `sudo`.**

A notification about new PocketBase versions (if available) and audit logging occur automatically before each command.

### `dashboard`

**Purpose:** Shows an interactive terminal-based dashboard for all managed PocketBase instances.

**Usage:**
`sudo pb-manager dashboard`

**Features:**

- Real-time view of:
  - Instance Name, Domain, Port
  - PM2 Status (Online/Offline/etc.)
  - HTTP Health Check Status (OK/ERR)
  - SSL Status (Yes/No)
  - CPU and Memory usage per instance (from PM2)
  - Instance Uptime
  - Data Directory Size
- **Hotkeys for actions:**
  - `q` or `Ctrl+C`: Quit dashboard.
  - `r`: Refresh data immediately.
  - `l`: View logs for the selected instance (exits dashboard).
  - `s`: Start/Stop the selected instance.
  - `d`: Delete the selected instance (exits dashboard and runs the remove command).

### `configure`

**Purpose:** Set or view global CLI configurations for `pb-manager`.

**Usage:**
`sudo pb-manager configure`

**Details:**
This interactive command allows you to:

- Set/View the **Default Certbot Email**.
- Set/View the **Default PocketBase Version** (for `setup` if no version is specified).
- **Enable/disable complete logging:** Toggle verbose output for all commands.
- View the current raw JSON configuration.

### `setup`

**Purpose:** Performs initial setup for `pb-manager`. Creates necessary configuration directories and downloads the PocketBase executable.

**Usage:**
`sudo pb-manager setup [options]`

**Options:**

- `-v, --version <version>`: Specify a particular PocketBase version (e.g., `0.28.1`) to download. If not provided, it uses the version from `cli-config.json` (if set), or fetches the latest available version.

**Example:**

```bash
sudo pb-manager setup
sudo pb-manager setup -v 0.28.1
```

### `add`

**Purpose:** Adds and configures a new PocketBase instance.

**Usage:**
`sudo pb-manager add`

**Details:**
This interactive command will prompt you for:

1.  **Instance name:** A short, unique, alphanumeric name (e.g., `my-blog`).
2.  **Domain/subdomain:** The public domain (e.g., `blog.example.com`).
3.  **Internal port:** A unique internal port (e.g., `8091`).
4.  **Enable HTTP/2 in Nginx config?** (Default: Yes)
5.  **Set 20Mb max body size in Nginx config?** (Default: Yes, for file uploads)
6.  **Configure HTTPS (Certbot)?** (Default: Yes)
7.  **(If HTTPS) Use default email for Let's Encrypt?** (If one is set in `cli-config.json`)
8.  **(If HTTPS and not using default/no default) Enter email for Let's Encrypt.**
9.  **(If HTTPS) Attempt to automatically run Certbot now?** (Default: Yes)
10. **Create superuser (admin) account via CLI now?** (Default: Yes)

**Actions Performed:**

- **DNS Validation:** If HTTPS is enabled, `pb-manager` validates that the domain's A/AAAA records point to your server. Aborts if validation fails.
- Creates a data directory.
- Saves instance configuration.
- Generates and enables a secure Nginx configuration (with HTTP/2, security headers, max body size as chosen).
- Ensures `dhparam.pem` exists for SSL.
- Reloads Nginx.
- (If chosen for HTTPS & auto-Certbot) Runs Certbot. If Certbot succeeds, Nginx config is updated for SSL.
- Updates PM2 ecosystem file and starts/reloads the instance via PM2.
- (If chosen) Creates the PocketBase superuser (admin) account via CLI.
- Provides URLs and guidance for accessing the new instance.

### `list`

**Purpose:** Lists all PocketBase instances managed by `pb-manager`.

**Usage:**
`sudo pb-manager list [--json]`

**Options:**

- `--json`: Output the list in JSON format.

**Details:**
Displays a summary for each instance, including: Name, Domain, Protocol (HTTP/HTTPS), Public Admin URL, Internal Port, Data Directory, PM2 Status, Local Admin URL, and SSL Certificate Expiry Days (if HTTPS).

### `remove <name>`

**Purpose:** Removes a managed PocketBase instance.

**Usage:**
`sudo pb-manager remove <instance-name>`

**Arguments:**

- `<instance-name>`: The name of the instance to remove.

**Details:**

- Asks for confirmation.
- Stops and deletes the instance's PM2 process.
- Removes Nginx configuration files and symlinks.
- Removes the instance's entry from `instances.json`.
- Reloads Nginx and updates/saves PM2 state.
- **Important:** Does **not** delete the instance's data directory (`~/.pb-manager/instances_data/<instance-name>/`). This must be done manually.

### `start <name>`

**Purpose:** Starts a specific PocketBase instance via PM2.

**Usage:**
`sudo pb-manager start <instance-name>`

### `stop <name>`

**Purpose:** Stops a specific PocketBase instance via PM2.

**Usage:**
`sudo pb-manager stop <instance-name>`

### `restart <name>`

**Purpose:** Restarts a specific PocketBase instance via PM2.

**Usage:**
`sudo pb-manager restart <instance-name>`

### `logs <name>`

**Purpose:** Displays logs for a specific PocketBase instance from PM2.

**Usage:**
`sudo pb-manager logs <instance-name>`
(Tails logs, press `Ctrl+C` to exit.)

### `update-pb`

**Purpose:** Updates the core PocketBase executable using PocketBase's built-in `update` command. After updating, it restarts all managed instances.

**Usage:**
`sudo pb-manager update-pb`

**Details:**

- Checks if the PocketBase executable exists.
- Runs `<path-to-pocketbase-executable> update`. This command makes the PocketBase binary update itself in place.
- If the update is successful, it iterates through all managed instances and restarts their PM2 processes.

### `audit`

**Purpose:** Displays the audit log of commands executed by `pb-manager`.

**Usage:**
`sudo pb-manager audit`
(Shows contents of `~/.pb-manager/audit.log`)

### `update-ecosystem`

**Purpose:** Regenerates the PM2 ecosystem file based on current `instances.json` and reloads PM2. Useful if manual changes are needed or to ensure PM2 is in sync.

**Usage:**
`sudo pb-manager update-ecosystem`

## Superuser (Admin) Account Creation

When adding a new instance, `pb-manager` offers to create the initial superuser (admin) account via the CLI. It uses a command similar to:
`pocketbase superuser create "<email>" "<password>" --dir "<instance_data_dir>" --migrationsDir "<instance_data_dir>/pb_migrations"`

If you opt-out or it fails, you can create it via the web admin UI:

- Visit `https://your-domain.com/_/` (if HTTPS is set up) or `http://your-domain.com/_/`.
- Alternatively, for local access/troubleshooting: `http://127.0.0.1:<instance_port>/_/` (may require SSH port forwarding for headless servers: `ssh -L <instance_port>:127.0.0.1:<instance_port> user@your_server_ip`).
- PocketBase will prompt you to create the first admin account.

## Nginx Configuration Features

- **HTTP/2:** Optionally enabled per instance for improved performance.
- **Security Headers:** Includes `Strict-Transport-Security`, `X-Content-Type-Options`, `X-Frame-Options`, `X-XSS-Protection` by default.
- **Upload Limit:** Optionally set `client_max_body_size 20M` (or other values if manually edited later) per instance.
- **HTTPS:** Full Let's Encrypt integration via Certbot.
- **Automatic HTTP to HTTPS redirection** when HTTPS is enabled and Certbot succeeds.

## Logging

- **CLI Verbosity:** Control the amount of output from `pb-manager` commands using the `configure` command (`Enable complete logging`).
  - **Disabled (default):** Concise output.
  - **Enabled:** Shows detailed shell commands, PM2 actions, etc.
- **Instance Logs:** View individual PocketBase instance logs using `pb-manager logs <name>` or `pm2 logs pb-<name>`.

## Audit Log

All `pb-manager` commands are logged to `~/.pb-manager/audit.log` with a timestamp and the full command executed. This provides a trail of administrative actions performed by the tool.

## PocketBase Version Notification

Before executing any command, `pb-manager` checks (with a 24-hour cache) if a newer version of PocketBase is available on GitHub. If so, it displays a notification, prompting you to consider using `pb-manager update-pb`.

## DNS Validation

When adding an instance with HTTPS, `pb-manager` verifies that the provided domain name resolves to the server's public IP address. This proactive check helps prevent Certbot failures due to DNS misconfiguration.

## Potential Issues & Disclaimer

While `pb-manager` aims to automate and simplify, be aware of:

- **Dependency Issues:** Conflicts with system Node.js, PM2, Nginx, or Certbot versions.
- **Nginx Errors:** Incorrect Nginx configurations (by this tool or others) can disrupt web services. Test with `sudo nginx -t`.
- **Certbot Failures:** Can occur due to DNS issues, rate limits, firewall blocks, or Nginx plugin problems.
- **PM2 Problems:** Instances might not start/restart correctly. Check `pm2 logs`.
- **Permissions:** Ensure correct file system permissions. Running with `sudo` generally handles this.
- **PocketBase Updates:** Breaking changes in PocketBase itself could affect instances. Review release notes.
- **Data Loss Risk:** The `remove` command doesn't delete data by default, but **always back up your data independently.**
- **Script Bugs:** The tool may have bugs. Test in non-critical environments first.
- **Network Connectivity:** Required for downloads and API interactions.
- **Resource Limits:** Monitor server resources if running many instances.

**Disclaimer:** This tool is provided as-is, without warranty. The user assumes all responsibility. **Always back up critical data.**

## Important Notes

### Sudo Usage

**All `pb-manager` commands must be run as root or with `sudo`.** This is essential for managing system services (Nginx, PM2) and files.

### DNS Configuration

Correct DNS A (and/or AAAA) records pointing to your server's IP are **critical** for domain access and HTTPS. Ensure propagation before setup.

### Backups

`pb-manager` **does not** handle data backups. Implement your own strategy for `~/.pb-manager/instances_data/<instance-name>/` directories.

### Security

- Secure PocketBase admin accounts with strong passwords.
- Keep your server and all software (OS, Nginx, PM2, Node.js, PocketBase) updated.
- Review Nginx configurations for any site-specific hardening needed.
