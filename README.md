# PocketBase Manager CLI (`pb-manager`)

## Introduction

`pb-manager` is a command-line interface (CLI) tool designed to simplify the management of multiple PocketBase instances on a single Linux server. It automates setup, configuration, and ongoing maintenance tasks, including process management with PM2, reverse proxying with Nginx, and SSL certificate handling with Certbot.

### Why pb-manager?

Running multiple web applications, like PocketBase instances, on one server can become complex. Each instance needs:

- Its own isolated data directory.
- To run on a unique internal port.
- A way to be accessed via a public domain/subdomain.
- Process management to ensure it stays running.
- Optionally, HTTPS for secure connections.

`pb-manager` streamlines these processes by providing a single tool to:

- Download and manage the PocketBase executable.
- Create and configure new PocketBase instances with isolated data.
- Automatically generate Nginx reverse proxy configurations.
- Integrate with PM2 for process management (start, stop, restart, logs, auto-restart on crash/boot).
- Optionally, automate SSL certificate acquisition and renewal using Certbot for HTTPS.
- Update the core PocketBase executable and restart instances.
- Guide or automate the creation of the initial superuser (admin) account for each instance.

---

## How It Works

`pb-manager` orchestrates several components:

1. **PocketBase Executable:** Downloads a single PocketBase executable (version can be configured) and stores it in a central location (`~/.pb-manager/bin/`). All managed instances use this single binary.
2. **Instance Configuration:** Details about each managed PocketBase instance (name, domain, port, data directory, HTTPS settings) are stored in a JSON file (`~/.pb-manager/instances.json`).
3. **CLI Configuration:** Global settings for `pb-manager` itself, like default Certbot email and default PocketBase version for setup, are stored in `~/.pb-manager/cli-config.json`.
4. **Data Isolation:** Each instance is given its own data directory under `~/.pb-manager/instances_data/`, ensuring that databases and files are kept separate.
5. **PM2:** For each instance, `pb-manager` generates an entry in a PM2 ecosystem file (`~/.pb-manager/ecosystem.config.js`). PM2 is then used to run, monitor, and manage the lifecycle of these PocketBase processes.
6. **Nginx:** When an instance is added, `pb-manager` generates an Nginx server block configuration file in `/etc/nginx/sites-available/` and creates a symbolic link in `/etc/nginx/sites-enabled/`. This configures Nginx to act as a reverse proxy, forwarding requests from a public domain to the instance's internal port.
7. **Certbot:** If HTTPS is enabled for an instance, `pb-manager` can attempt to run Certbot to obtain and install a Let's Encrypt SSL certificate for the specified domain. Certbot will modify the Nginx configuration to enable HTTPS.
8. **Superuser Creation:** When adding a new instance, `pb-manager` offers to create the initial PocketBase superuser (admin) account via the CLI, or guides you to do it via the web UI.

---

## Prerequisites

Before using `pb-manager`, ensure the following are installed and configured on your Linux server (primarily tested on Ubuntu/Debian):

1. **Node.js and npm:** Required to run the `pb-manager.js` script and install its dependencies.
   - Installation: `sudo apt update && sudo apt install nodejs npm`
2. **PM2:** The process manager.
   - Installation: `sudo npm install -g pm2`
   - Setup for auto-boot: `pm2 startup` (follow instructions) and `pm2 save`.
3. **Nginx:** The web server/reverse proxy.
   - Installation: `sudo apt update && sudo apt install nginx`
   - Ensure it's running and enabled: `sudo systemctl start nginx && sudo systemctl enable nginx`.
4. **Certbot (with Nginx plugin):** For SSL certificate management.
   - Installation: `sudo apt update && sudo apt install certbot python3-certbot-nginx`
5. **`sudo` access:** Many operations require root privileges (Nginx config, Certbot, PM2 global setup).
6. **Firewall:** Ports 80 (HTTP) and 443 (HTTPS) must be open.
   - Example with `ufw`: `sudo ufw allow 'Nginx Full'` or `sudo ufw allow 80/tcp && sudo ufw allow 443/tcp`, then `sudo ufw enable`.
7. **DNS Records:** For each domain/subdomain you intend to use, an A (and/or AAAA) record must point to your server's public IP address. This is crucial for Nginx and Certbot to function correctly.

---

## Installation

### Automated Installation

You can use the provided shell script to install all dependencies and set up `pb-manager`:

```bash
curl -fsSL https://raw.githubusercontent.com/devAlphaSystem/Alpha-System-PBManager-CLI/main/install-pb-manager.sh | sudo bash
```

### Manual Installation

1. **Create a directory for the script:**
   ```bash
   mkdir ~/pocketbase-manager
   cd ~/pocketbase-manager
   ```
2. **Save the `pb-manager.js` script** into this directory.
3. **Initialize npm and install dependencies:**
   ```bash
   npm init -y
   npm install commander inquirer@8.2.4 fs-extra axios chalk@4.1.2 unzipper shelljs
   ```
4. **Make the script executable:**
   ```bash
   chmod +x pb-manager.js
   ```
5. **(Optional) Create a symlink for global access:**
   ```bash
   sudo ln -s $(pwd)/pb-manager.js /usr/local/bin/pb-manager
   ```

---

## Configuration Directory

`pb-manager` stores all its configuration files, the PocketBase binary, and instance data within the `~/.pb-manager/` directory in the user's home directory who runs the script.

- `~/.pb-manager/cli-config.json`: Global settings for the `pb-manager` tool.
- `~/.pb-manager/instances.json`: Configuration for each managed PocketBase instance.
- `~/.pb-manager/ecosystem.config.js`: PM2 ecosystem file.
- `~/.pb-manager/bin/pocketbase`: The downloaded PocketBase executable.
- `~/.pb-manager/instances_data/<instance-name>/`: Data directory for each instance (contains `pb_data`, `pb_migrations`, etc.).

---

## Commands

All commands are run like `pb-manager <command> [options]`. Many commands that interact with system services like Nginx or PM2 may require `sudo`.

---

### `configure`

**Purpose:** Set or view global CLI configurations for `pb-manager`.

**Usage:**  
`pb-manager configure`

**Details:**  
This interactive command allows you to:

- Set/View the **Default Certbot Email**: The email address to be suggested or used by default when setting up HTTPS with Certbot for new instances.
- Set/View the **Default PocketBase Version**: The version of PocketBase that the `setup` command will download by default if no specific version is provided.
- View the current raw JSON configuration.

---

### `setup`

**Purpose:** Performs initial setup for `pb-manager`. This includes creating necessary configuration directories and downloading the PocketBase executable.

**Usage:**  
`pb-manager setup [options]`

**Options:**

- `-v, --version <version>`: Specify a particular PocketBase version (e.g., `0.28.1`) to download. If not provided, it uses the version set via the `configure` command, or a fallback version.

**Example:**

```bash
sudo pb-manager setup
sudo pb-manager setup -v 0.28.1
```

---

### `add`

**Purpose:** Adds and configures a new PocketBase instance.

**Usage:**  
`sudo pb-manager add`

**Details:**  
This interactive command will prompt you for:

1. **Instance name:** A short, unique, alphanumeric name (e.g., `my-blog`, `project-x`). This name is used for Nginx config files and PM2 process names.
2. **Domain/subdomain:** The public domain (e.g., `blog.example.com`) that will point to this instance.
3. **Internal port:** A unique internal port (e.g., `8091`) on which this PocketBase instance will listen.
4. **Configure HTTPS (Certbot)?:** Whether to set up HTTPS using Let's Encrypt.
5. **(If HTTPS) Use default email?:** If a default Certbot email is configured, asks if you want to use it.
6. **(If HTTPS and not using default/no default) Enter email for Let's Encrypt:** Your email address for SSL certificate registration and renewal notices.
7. **(If HTTPS) Attempt to automatically run Certbot?:** Whether the script should try to obtain the SSL certificate immediately.
8. **Create superuser (admin) via CLI?:** Whether to create the initial admin account via the CLI (recommended for headless servers).

**Actions Performed:**

- Creates a data directory for the instance.
- Saves the instance configuration.
- Generates and enables an Nginx configuration file.
- Reloads Nginx.
- (If chosen) Runs Certbot to obtain and install an SSL certificate.
- Updates the PM2 ecosystem file and starts/reloads the PM2 processes.
- Offers to create the initial PocketBase superuser (admin) account via CLI, or guides you to do it via the web UI.

---

### `list`

**Purpose:** Lists all PocketBase instances currently managed by `pb-manager`.

**Usage:**  
`pb-manager list`

**Details:**  
Displays a summary for each instance, including:

- Instance Name
- Domain (and protocol: HTTP/HTTPS)
- Internal Port
- Data Directory Path
- PM2 Status (e.g., `online`, `stopped`, `errored`)
- Local Admin URL (e.g., `http://127.0.0.1:PORT/_/`)

---

### `remove <name>`

**Purpose:** Removes a managed PocketBase instance.

**Usage:**  
`sudo pb-manager remove <instance-name>`

**Arguments:**

- `<instance-name>`: The name of the instance to remove (as shown in `list`).

**Details:**  
This command will:

- Ask for confirmation.
- Stop and delete the instance's process from PM2.
- Remove the Nginx configuration files (from `sites-available` and `sites-enabled`).
- Remove the instance's entry from the `pb-manager` configuration.
- Reload Nginx and save the PM2 process list.

**Important:** This command **does not** delete the instance's data directory (`~/.pb-manager/instances_data/<instance-name>/`). You must do this manually if you wish to remove the data.

---

### `start <name>`

**Purpose:** Starts a specific, already configured PocketBase instance using PM2.

**Usage:**  
`pb-manager start <instance-name>`

---

### `stop <name>`

**Purpose:** Stops a specific PocketBase instance managed by PM2.

**Usage:**  
`pb-manager stop <instance-name>`

---

### `restart <name>`

**Purpose:** Restarts a specific PocketBase instance managed by PM2.

**Usage:**  
`pb-manager restart <instance-name>`

---

### `logs <name>`

**Purpose:** Displays the logs for a specific PocketBase instance from PM2.

**Usage:**  
`pb-manager logs <instance-name>`

**Details:**  
This command tails the logs. Press `Ctrl+C` to exit the log view.

---

### `update-pb`

**Purpose:** Updates the core PocketBase executable to the latest stable version using PocketBase's built-in `update` command. After updating the binary, it restarts all managed PocketBase instances.

**Usage:**  
`sudo pb-manager update-pb`

**Details:**

- Checks if the PocketBase executable exists.
- Runs `<path-to-pocketbase-executable> update`. This command makes the PocketBase binary update itself in place.
- If the update is successful, it iterates through all managed instances and restarts their PM2 processes.

---

## Superuser (Admin) Account Creation

When you add a new PocketBase instance, `pb-manager` will offer to create the initial superuser (admin) account via the CLI using the following command:

```bash
pocketbase superuser create <email> <password> --dir <instance_data_dir>
```

If you choose not to create the superuser via CLI, you can always create it via the web admin UI:

- Visit `https://your-domain/_/` (or `http://127.0.0.1:<port>/_/` if accessing locally or via SSH port forwarding).
- You will be prompted to create the first admin account.

---

## Important Notes

### Sudo Usage

Many commands (`add`, `remove`, `update-pb` for PM2/Nginx interaction, `setup` if it needs to write to restricted areas though unlikely for home dir setup) require `sudo` because they modify system-level configurations (Nginx files, systemd services for PM2 startup) or manage processes that might need elevated privileges.

### DNS Configuration

For Nginx and Certbot (HTTPS) to work correctly, the domain(s) you assign to your PocketBase instances **must** have their DNS A (and/or AAAA) records pointing to your server's public IP address. Ensure DNS propagation has completed before attempting to set up HTTPS.

### Backups

`pb-manager` **does not** automatically back up your PocketBase data. It is crucial to implement your own backup strategy for the instance data directories located at `~/.pb-manager/instances_data/<instance-name>/`. Regularly backing up these directories is highly recommended.

### Security

- **File Permissions:** Be mindful of file permissions, especially for the `~/.pb-manager` directory and its contents.
- **Nginx Configuration:** While `pb-manager` generates a basic Nginx configuration, you might need to customize it further for advanced security hardening (e.g., rate limiting, security headers) based on your specific needs.
- **PocketBase Admin:** Secure your PocketBase admin accounts with strong passwords.
