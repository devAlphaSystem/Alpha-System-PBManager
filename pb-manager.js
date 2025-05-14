#!/usr/bin/env node

const { program } = require("commander");
const inquirer = require("inquirer");
const fs = require("fs-extra");
const path = require("node:path");
const axios = require("axios");
const chalk = require("chalk");
const unzipper = require("unzipper");
const shell = require("shelljs");

const POCKETBASE_VERSION_FALLBACK = "0.28.1";

const CONFIG_DIR = path.join(process.env.HOME, ".pb-manager");
const CLI_CONFIG_PATH = path.join(CONFIG_DIR, "cli-config.json");
const INSTANCES_CONFIG_PATH = path.join(CONFIG_DIR, "instances.json");
const POCKETBASE_BIN_DIR = path.join(CONFIG_DIR, "bin");
const POCKETBASE_EXEC_PATH = path.join(POCKETBASE_BIN_DIR, "pocketbase");
const INSTANCES_DATA_BASE_DIR = path.join(CONFIG_DIR, "instances_data");
const PM2_ECOSYSTEM_FILE = path.join(CONFIG_DIR, "ecosystem.config.js");

const NGINX_SITES_AVAILABLE = "/etc/nginx/sites-available";
const NGINX_SITES_ENABLED = "/etc/nginx/sites-enabled";

async function getCliConfig() {
  if (await fs.pathExists(CLI_CONFIG_PATH)) {
    try {
      const config = await fs.readJson(CLI_CONFIG_PATH);
      return {
        defaultCertbotEmail: null,
        defaultPocketBaseVersion: POCKETBASE_VERSION_FALLBACK,
        ...config,
      };
    } catch (e) {
      console.warn(chalk.yellow("Could not read CLI config, using defaults."));
    }
  }
  return {
    defaultCertbotEmail: null,
    defaultPocketBaseVersion: POCKETBASE_VERSION_FALLBACK,
  };
}

async function saveCliConfig(config) {
  await fs.ensureDir(CONFIG_DIR);
  await fs.writeJson(CLI_CONFIG_PATH, config, { spaces: 2 });
}

async function ensureBaseSetup() {
  await fs.ensureDir(CONFIG_DIR);
  await fs.ensureDir(POCKETBASE_BIN_DIR);
  await fs.ensureDir(INSTANCES_DATA_BASE_DIR);
  if (!(await fs.pathExists(INSTANCES_CONFIG_PATH))) {
    await fs.writeJson(INSTANCES_CONFIG_PATH, { instances: {} });
  }
  if (!(await fs.pathExists(PM2_ECOSYSTEM_FILE))) {
    await fs.writeFile(PM2_ECOSYSTEM_FILE, "module.exports = { apps: [] };");
  }
  const currentCliConfig = await getCliConfig();
  await saveCliConfig(currentCliConfig);
}

async function getInstancesConfig() {
  return fs.readJson(INSTANCES_CONFIG_PATH);
}

async function saveInstancesConfig(config) {
  await fs.writeJson(INSTANCES_CONFIG_PATH, config, { spaces: 2 });
}

async function downloadPocketBaseIfNotExists(versionOverride = null) {
  const cliConfig = await getCliConfig();
  const versionToDownload = versionOverride || cliConfig.defaultPocketBaseVersion || POCKETBASE_VERSION_FALLBACK;

  if (!versionOverride && (await fs.pathExists(POCKETBASE_EXEC_PATH))) {
    console.log(chalk.green(`PocketBase executable already exists at ${POCKETBASE_EXEC_PATH}. Skipping download.`));
    return;
  }

  if (await fs.pathExists(POCKETBASE_EXEC_PATH)) {
    console.log(chalk.yellow(`Removing existing PocketBase executable at ${POCKETBASE_EXEC_PATH} to download version ${versionToDownload}...`));
    await fs.remove(POCKETBASE_EXEC_PATH);
  }

  const downloadUrl = `https://github.com/pocketbase/pocketbase/releases/download/v${versionToDownload}/pocketbase_${versionToDownload}_linux_amd64.zip`;
  console.log(chalk.blue(`Downloading PocketBase v${versionToDownload} from ${downloadUrl}...`));

  try {
    const response = await axios({
      url: downloadUrl,
      method: "GET",
      responseType: "stream",
    });
    const zipPath = path.join(POCKETBASE_BIN_DIR, "pocketbase.zip");
    const writer = fs.createWriteStream(zipPath);
    response.data.pipe(writer);

    await new Promise((resolve, reject) => {
      writer.on("finish", resolve);
      writer.on("error", reject);
    });

    console.log(chalk.blue("Unzipping PocketBase..."));
    await fs
      .createReadStream(zipPath)
      .pipe(unzipper.Extract({ path: POCKETBASE_BIN_DIR }))
      .promise();

    await fs.remove(zipPath);
    await fs.chmod(POCKETBASE_EXEC_PATH, "755");
    console.log(chalk.green(`PocketBase v${versionToDownload} downloaded and extracted successfully to ${POCKETBASE_EXEC_PATH}.`));
  } catch (error) {
    console.error(chalk.red(`Error downloading or extracting PocketBase v${versionToDownload}:`), error.message);
    if (error.response && error.response.status === 404) {
      console.error(chalk.red(`Version ${versionToDownload} not found. Please check the version number.`));
    }
    throw error;
  }
}

function runCommand(command, errorMessage, ignoreError = false) {
  console.log(chalk.yellow(`Executing: ${command}`));
  const result = shell.exec(command, { silent: false });
  if (result.code !== 0 && !ignoreError) {
    console.error(chalk.red(errorMessage || `Error executing command: ${command}`));
    console.error(chalk.red(result.stderr));
    throw new Error(errorMessage || `Command failed: ${command}`);
  }
  return result;
}

async function updatePm2EcosystemFile() {
  const config = await getInstancesConfig();
  const apps = Object.values(config.instances).map((inst) => ({
    name: `pb-${inst.name}`,
    script: POCKETBASE_EXEC_PATH,
    args: `serve --http "127.0.0.1:${inst.port}" --dir "${inst.dataDir}"`,
    cwd: POCKETBASE_BIN_DIR,
    autorestart: true,
    watch: false,
    max_memory_restart: "200M",
    env: {
      NODE_ENV: "production",
    },
  }));
  const ecosystemContent = `module.exports = { apps: ${JSON.stringify(apps, null, 2)} };`;
  await fs.writeFile(PM2_ECOSYSTEM_FILE, ecosystemContent);
  console.log(chalk.green("PM2 ecosystem file updated."));
}

async function reloadPm2(specificInstanceName = null) {
  if (specificInstanceName) {
    runCommand(`pm2 restart pb-${specificInstanceName}`);
  } else {
    runCommand(`pm2 reload ${PM2_ECOSYSTEM_FILE}`);
  }
  runCommand("pm2 save");
  console.log(chalk.green(specificInstanceName ? `PM2 process pb-${specificInstanceName} restarted and PM2 state saved.` : "PM2 ecosystem reloaded and PM2 state saved."));
}

async function generateNginxConfig(instanceName, domain, port, useHttps) {
  let configContent;
  if (useHttps) {
    configContent = `
server {
    listen 80;
    listen [::]:80;
    server_name ${domain};

    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }

    location / {
        return 301 https://$host$request_uri;
    }
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name ${domain};

    ssl_certificate /etc/letsencrypt/live/${domain}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${domain}/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    location / {
        proxy_pass http://127.0.0.1:${port};
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_buffering off;
        proxy_read_timeout 300s;
    }
}`;
  } else {
    configContent = `
server {
    listen 80;
    listen [::]:80;
    server_name ${domain};

    location / {
        proxy_pass http://127.0.0.1:${port};
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_buffering off;
        proxy_read_timeout 300s;
    }
}`;
  }

  const nginxConfPath = path.join(NGINX_SITES_AVAILABLE, instanceName);
  const nginxEnabledPath = path.join(NGINX_SITES_ENABLED, instanceName);

  console.log(chalk.blue(`Generating Nginx config for ${instanceName} at ${nginxConfPath}`));
  await fs.writeFile(nginxConfPath, configContent.trim());
  console.log(chalk.blue(`Creating Nginx symlink: ${nginxEnabledPath}`));
  try {
    runCommand(`sudo ln -sfn ${nginxConfPath} ${nginxEnabledPath}`);
  } catch (error) {
    console.error(chalk.red("Failed to create symlink. Try running with sudo or create it manually."));
    console.log(`Manually run: sudo ln -sfn ${nginxConfPath} ${nginxEnabledPath}`);
  }
}

async function reloadNginx() {
  console.log(chalk.blue("Testing Nginx configuration..."));
  try {
    runCommand("sudo nginx -t");
    console.log(chalk.blue("Reloading Nginx..."));
    runCommand("sudo systemctl reload nginx");
    console.log(chalk.green("Nginx reloaded successfully."));
  } catch (error) {
    console.error(chalk.red("Nginx test failed or reload failed. Please check Nginx configuration."));
    throw error;
  }
}

async function runCertbot(domain, email) {
  if (!shell.which("certbot")) {
    console.error(chalk.red("Certbot command not found. Please install Certbot first."));
    return false;
  }
  console.log(chalk.blue(`Attempting to obtain SSL certificate for ${domain} using Certbot...`));
  try {
    runCommand("sudo mkdir -p /var/www/html", "Creating /var/www/html for Certbot", true);
  } catch (e) {
    /* ignore */
  }

  const certbotCommand = `sudo certbot --nginx -d ${domain} --non-interactive --agree-tos -m "${email}" --redirect`;
  try {
    runCommand(certbotCommand, "Certbot command failed.");
    console.log(chalk.green(`Certbot successfully obtained and installed certificate for ${domain}.`));
    return true;
  } catch (error) {
    console.error(chalk.red(`Certbot failed for ${domain}. Check Certbot logs.`));
    return false;
  }
}

program
  .command("configure")
  .description("Set or view CLI configurations (e.g., default Certbot email, PocketBase version).")
  .action(async () => {
    await ensureBaseSetup();
    const cliConfig = await getCliConfig();

    const { action } = await inquirer.prompt([
      {
        type: "list",
        name: "action",
        message: "CLI Configuration:",
        choices: [
          {
            name: `Default Certbot Email: ${cliConfig.defaultCertbotEmail || "Not set"}`,
            value: "setEmail",
          },
          {
            name: `Default PocketBase Version (for setup): ${cliConfig.defaultPocketBaseVersion}`,
            value: "setPbVersion",
          },
          new inquirer.Separator(),
          { name: "View current JSON config", value: "viewConfig" },
          { name: "Exit", value: "exit" },
        ],
      },
    ]);

    switch (action) {
      case "setEmail": {
        const { email } = await inquirer.prompt([
          {
            type: "input",
            name: "email",
            message: "Enter new default Certbot email (leave blank to clear):",
            default: cliConfig.defaultCertbotEmail,
          },
        ]);
        cliConfig.defaultCertbotEmail = email || null;
        await saveCliConfig(cliConfig);
        console.log(chalk.green("Default Certbot email updated."));
        break;
      }
      case "setPbVersion": {
        const { version } = await inquirer.prompt([
          {
            type: "input",
            name: "version",
            message: "Enter new default PocketBase version (e.g., 0.22.10):",
            default: cliConfig.defaultPocketBaseVersion,
            validate: (input) => (/^(\d+\.\d+\.\d+)$/.test(input) || input === "" ? true : "Please enter a valid version (x.y.z) or leave blank."),
          },
        ]);
        cliConfig.defaultPocketBaseVersion = version || POCKETBASE_VERSION_FALLBACK;
        await saveCliConfig(cliConfig);
        console.log(chalk.green("Default PocketBase version updated."));
        break;
      }
      case "viewConfig":
        console.log(chalk.cyan("Current CLI Configuration:"));
        console.log(JSON.stringify(cliConfig, null, 2));
        break;
      case "exit":
        console.log(chalk.blue("Exiting configuration."));
        break;
    }
  });

program
  .command("setup")
  .description("Initial setup: creates directories and downloads PocketBase.")
  .option("-v, --version <version>", "Specify PocketBase version to download for setup")
  .action(async (options) => {
    console.log(chalk.bold.cyan("Starting PocketBase Manager Setup..."));
    await ensureBaseSetup();
    await downloadPocketBaseIfNotExists(options.version);
    console.log(chalk.bold.green("Setup complete!"));
  });

program
  .command("add")
  .description("Add a new PocketBase instance")
  .action(async () => {
    await ensureBaseSetup();
    if (!(await fs.pathExists(POCKETBASE_EXEC_PATH))) {
      console.log(chalk.yellow("PocketBase executable not found. Running setup..."));
      await downloadPocketBaseIfNotExists();
      if (!(await fs.pathExists(POCKETBASE_EXEC_PATH))) {
        console.error(chalk.red("PocketBase download failed. Cannot add instance."));
        return;
      }
    }

    const initialAnswers = await inquirer.prompt([
      {
        type: "input",
        name: "name",
        message: "Instance name (e.g., my-app, no spaces):",
        validate: (input) => (/^[a-zA-Z0-9-]+$/.test(input) ? true : "Invalid name format."),
      },
      {
        type: "input",
        name: "domain",
        message: "Domain/subdomain for this instance (e.g., app.example.com):",
        validate: (input) => (input.length > 0 ? true : "Domain cannot be empty."),
      },
      {
        type: "number",
        name: "port",
        message: "Internal port for this instance (e.g., 8091):",
        default: 8090 + Math.floor(Math.random() * 100),
        validate: (input) => (Number.isInteger(input) && input > 1024 && input < 65535 ? true : "Invalid port."),
      },
    ]);

    const config = await getInstancesConfig();
    if (config.instances[initialAnswers.name]) {
      console.error(chalk.red(`Instance "${initialAnswers.name}" already exists.`));
      return;
    }
    if (Object.values(config.instances).some((inst) => inst.port === initialAnswers.port)) {
      console.error(chalk.red(`Port ${initialAnswers.port} is already in use by another managed instance.`));
      return;
    }

    const cliConf = await getCliConfig();
    let emailToUseForCertbot = cliConf.defaultCertbotEmail;

    const httpsAnswers = await inquirer.prompt([
      {
        type: "confirm",
        name: "useHttps",
        message: "Configure HTTPS (Certbot)?",
        default: true,
      },
      {
        type: "confirm",
        name: "useDefaultEmail",
        message: `Use default email (${cliConf.defaultCertbotEmail}) for Let's Encrypt?`,
        default: true,
        when: (answers) => answers.useHttps && cliConf.defaultCertbotEmail,
      },
      {
        type: "input",
        name: "emailForCertbot",
        message: "Enter email for Let's Encrypt:",
        when: (answers) => answers.useHttps && (!cliConf.defaultCertbotEmail || !answers.useDefaultEmail),
        validate: (input) => (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input) ? true : "Valid email required."),
        default: (answers) => (!cliConf.defaultCertbotEmail || !answers.useDefaultEmail ? undefined : cliConf.defaultCertbotEmail),
      },
      {
        type: "confirm",
        name: "autoRunCertbot",
        message: "Attempt to automatically run Certbot now to obtain the SSL certificate?",
        default: true,
        when: (answers) => answers.useHttps,
      },
    ]);

    if (httpsAnswers.useHttps) {
      if (cliConf.defaultCertbotEmail && httpsAnswers.useDefaultEmail) {
        emailToUseForCertbot = cliConf.defaultCertbotEmail;
      } else {
        emailToUseForCertbot = httpsAnswers.emailForCertbot;
      }
      if (!emailToUseForCertbot) {
        console.error(chalk.red("Certbot email is required for HTTPS setup. Aborting."));
        return;
      }
    }

    const instanceDataDir = path.join(INSTANCES_DATA_BASE_DIR, initialAnswers.name);
    await fs.ensureDir(instanceDataDir);

    config.instances[initialAnswers.name] = {
      name: initialAnswers.name,
      domain: initialAnswers.domain,
      port: initialAnswers.port,
      dataDir: instanceDataDir,
      useHttps: httpsAnswers.useHttps,
      emailForCertbot: httpsAnswers.useHttps ? emailToUseForCertbot : null,
    };

    await saveInstancesConfig(config);
    console.log(chalk.green(`Instance "${initialAnswers.name}" configuration saved.`));

    await generateNginxConfig(initialAnswers.name, initialAnswers.domain, initialAnswers.port, httpsAnswers.useHttps);
    await reloadNginx();

    let certbotSuccess = false;
    if (httpsAnswers.useHttps && httpsAnswers.autoRunCertbot) {
      certbotSuccess = await runCertbot(initialAnswers.domain, emailToUseForCertbot);
    } else if (httpsAnswers.useHttps && !httpsAnswers.autoRunCertbot) {
      console.log(chalk.yellow("Skipping automatic Certbot execution."));
      console.log(chalk.yellow(`To obtain a certificate later, you can try running: sudo certbot --nginx -d ${initialAnswers.domain} -m ${emailToUseForCertbot}`));
    }

    await updatePm2EcosystemFile();
    await reloadPm2();

    console.log(chalk.bold.green(`Instance "${initialAnswers.name}" added and started!`));
    const protocol = httpsAnswers.useHttps && certbotSuccess ? "https" : "http";
    console.log(chalk.blue(`Access it at: ${protocol}://${initialAnswers.domain}`));
    console.log(chalk.blue(`Admin UI (via internal port, if not firewalled): http://127.0.0.1:${initialAnswers.port}/_/`));
    if (httpsAnswers.useHttps && !certbotSuccess && httpsAnswers.autoRunCertbot) {
      console.log(chalk.red("Certbot failed. The instance might only be available via HTTP or not at all if Nginx config expects SSL."));
    }
  });

program
  .command("update-pb")
  .description("Updates the PocketBase executable using 'pocketbase update' and restarts all instances.")
  .action(async () => {
    console.log(chalk.bold.cyan("Attempting to update PocketBase executable..."));
    if (!(await fs.pathExists(POCKETBASE_EXEC_PATH))) {
      console.error(chalk.red("PocketBase executable not found. Run 'setup' or 'configure' to set a version and download."));
      return;
    }
    try {
      console.log(chalk.yellow(`Running: ${POCKETBASE_EXEC_PATH} update`));
      const updateResult = shell.exec(`${POCKETBASE_EXEC_PATH} update`, { cwd: POCKETBASE_BIN_DIR });

      if (updateResult.code !== 0) {
        console.error(chalk.red("PocketBase update command failed."));
        console.error(updateResult.stderr);
        return;
      }
      console.log(chalk.green("PocketBase executable update process finished."));
      console.log(updateResult.stdout);
    } catch (error) {
      console.error(chalk.red("Failed to run PocketBase update command:"), error.message);
      return;
    }

    console.log(chalk.blue("Restarting all PocketBase instances via PM2..."));
    const instancesConf = await getInstancesConfig();
    let allRestarted = true;
    for (const instanceName in instancesConf.instances) {
      try {
        runCommand(`pm2 restart pb-${instanceName}`);
        console.log(chalk.green(`Instance pb-${instanceName} restarted.`));
      } catch (e) {
        console.error(chalk.red(`Failed to restart instance pb-${instanceName}.`));
        allRestarted = false;
      }
    }
    if (allRestarted) {
      console.log(chalk.bold.green("All instances restarted."));
    } else {
      console.log(chalk.bold.yellow("Some instances may not have restarted correctly. Check PM2 logs."));
    }
  });

program
  .command("remove <name>")
  .description("Remove a PocketBase instance")
  .action(async (name) => {
    const config = await getInstancesConfig();
    if (!config.instances[name]) {
      console.error(chalk.red(`Instance "${name}" not found.`));
      return;
    }

    const { confirm } = await inquirer.prompt([
      {
        type: "confirm",
        name: "confirm",
        message: `Are you sure you want to remove instance "${name}"? This will stop it, remove its PM2 entry, and Nginx config. Data directory will NOT be deleted automatically.`,
        default: false,
      },
    ]);

    if (!confirm) {
      console.log(chalk.yellow("Removal cancelled."));
      return;
    }

    console.log(chalk.blue(`Stopping and removing PM2 process for pb-${name}...`));
    try {
      runCommand(`pm2 stop pb-${name}`, `Stopping pb-${name}`, true);
      runCommand(`pm2 delete pb-${name}`, `Deleting pb-${name}`, true);
    } catch (error) {
      console.warn(chalk.yellow(`Could not stop/delete PM2 process pb-${name} (maybe not running).`));
    }

    const nginxConfPath = path.join(NGINX_SITES_AVAILABLE, name);
    const nginxEnabledPath = path.join(NGINX_SITES_ENABLED, name);

    console.log(chalk.blue(`Removing Nginx config for ${name}...`));
    if (await fs.pathExists(nginxEnabledPath)) {
      try {
        runCommand(`sudo rm ${nginxEnabledPath}`);
      } catch (error) {
        console.error(chalk.red(`Failed to remove Nginx symlink. Try: sudo rm ${nginxEnabledPath}`));
      }
    }
    if (await fs.pathExists(nginxConfPath)) {
      try {
        runCommand(`sudo rm ${nginxConfPath}`);
      } catch (error) {
        console.error(chalk.red(`Failed to remove Nginx available config. Try: sudo rm ${nginxConfPath}`));
      }
    }

    delete config.instances[name];
    await saveInstancesConfig(config);
    console.log(chalk.green(`Instance "${name}" removed from configuration.`));

    await updatePm2EcosystemFile();
    try {
      runCommand("pm2 save");
    } catch (e) {
      /* ignore */
    }

    await reloadNginx();

    console.log(chalk.bold.green(`Instance "${name}" removed.`));
    console.log(chalk.yellow(`Data directory at ${path.join(INSTANCES_DATA_BASE_DIR, name)} was NOT deleted.`));
  });

program
  .command("list")
  .description("List all managed PocketBase instances")
  .action(async () => {
    const config = await getInstancesConfig();
    if (Object.keys(config.instances).length === 0) {
      console.log(chalk.yellow("No instances configured yet. Use 'pb-manager add'."));
      return;
    }
    console.log(chalk.bold.cyan("Managed PocketBase Instances:"));
    const pm2Statuses = {};
    try {
      const pm2ListRaw = shell.exec("pm2 jlist", { silent: true });
      if (pm2ListRaw.code === 0 && pm2ListRaw.stdout) {
        const pm2List = JSON.parse(pm2ListRaw.stdout);
        for (const proc of pm2List) {
          if (proc.name.startsWith("pb-")) {
            pm2Statuses[proc.name.substring(3)] = proc.pm2_env.status;
          }
        }
      }
    } catch (e) {
      console.warn(chalk.yellow("Could not fetch PM2 statuses. Is PM2 running?"));
    }

    for (const name in config.instances) {
      const inst = config.instances[name];
      const status = pm2Statuses[name] || "UNKNOWN";
      const protocol = inst.useHttps ? "https" : "http";
      console.log(`
  ${chalk.bold(name)}:
    Domain: ${chalk.green(inst.domain)} (${protocol})
    Internal Port: ${chalk.yellow(inst.port)}
    Data Directory: ${inst.dataDir}
    PM2 Status: ${status === "online" ? chalk.green(status) : chalk.red(status)}
    Admin URL (local): http://127.0.0.1:${inst.port}/_/
      `);
    }
  });

program
  .command("start <name>")
  .description("Start a specific PocketBase instance via PM2")
  .action(async (name) => {
    try {
      runCommand(`pm2 start pb-${name}`);
      console.log(chalk.green(`Instance pb-${name} started.`));
    } catch (e) {
      console.error(chalk.red(`Failed to start instance pb-${name}. Is it configured?`));
    }
  });

program
  .command("stop <name>")
  .description("Stop a specific PocketBase instance via PM2")
  .action(async (name) => {
    try {
      runCommand(`pm2 stop pb-${name}`);
      console.log(chalk.green(`Instance pb-${name} stopped.`));
    } catch (e) {
      console.error(chalk.red(`Failed to stop instance pb-${name}.`));
    }
  });

program
  .command("restart <name>")
  .description("Restart a specific PocketBase instance via PM2")
  .action(async (name) => {
    try {
      runCommand(`pm2 restart pb-${name}`);
      console.log(chalk.green(`Instance pb-${name} restarted.`));
    } catch (e) {
      console.error(chalk.red(`Failed to restart instance pb-${name}.`));
    }
  });

program
  .command("logs <name>")
  .description("Show logs for a specific PocketBase instance from PM2")
  .action((name) => {
    console.log(chalk.blue(`Displaying logs for pb-${name}. Press Ctrl+C to exit.`));
    shell.exec(`pm2 logs pb-${name} --lines 50`, { async: false });
  });

async function main() {
  if (process.argv.some((arg) => ["add", "remove", "update-pb"].includes(arg))) {
    if (process.geteuid && process.geteuid() !== 0 && !shell.which("sudo")) {
      console.warn(chalk.yellow("Some operations require sudo. Please run with sudo or ensure Nginx/Certbot commands can be run passwordlessly."));
    }
  }
  if (!shell.which("pm2")) {
    console.error(chalk.red("PM2 is not installed or not in PATH. Please install PM2: npm install -g pm2"));
    process.exit(1);
  }
  if (!shell.which("nginx")) {
    console.warn(chalk.yellow("Nginx is not found. Nginx related commands might fail."));
  }

  await ensureBaseSetup();
  await program.parseAsync(process.argv);
}

main().catch((err) => {
  console.error(chalk.red("An unexpected error occurred:"), err.message);
  if (err.stack && process.env.DEBUG) {
    console.error(err.stack);
  }
  process.exit(1);
});
