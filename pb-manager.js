#!/usr/bin/env node

const { program } = require("commander");
const inquirer = require("inquirer");
const fs = require("fs-extra");
const path = require("node:path");
const axios = require("axios");
const chalk = require("chalk");
const unzipper = require("unzipper");
const shell = require("shelljs");
const os = require("node:os");
const Table = require("cli-table3");
const prettyBytes = require("pretty-bytes");
const blessed = require("blessed");
const contrib = require("blessed-contrib");

const CONFIG_DIR = path.join(process.env.HOME || os.homedir(), ".pb-manager");
const CLI_CONFIG_PATH = path.join(CONFIG_DIR, "cli-config.json");
const INSTANCES_CONFIG_PATH = path.join(CONFIG_DIR, "instances.json");
const POCKETBASE_BIN_DIR = path.join(CONFIG_DIR, "bin");
const POCKETBASE_EXEC_PATH = path.join(POCKETBASE_BIN_DIR, "pocketbase");
const INSTANCES_DATA_BASE_DIR = path.join(CONFIG_DIR, "instances_data");
const PM2_ECOSYSTEM_FILE = path.join(CONFIG_DIR, "ecosystem.config.js");

const NGINX_SITES_AVAILABLE = "/etc/nginx/sites-available";
const NGINX_SITES_ENABLED = "/etc/nginx/sites-enabled";

let completeLogging = false;

let _latestPocketBaseVersionCache = null;
const FALLBACK_POCKETBASE_VERSION = "0.28.1";

async function getLatestPocketBaseVersion(forceRefresh = false) {
  if (_latestPocketBaseVersionCache && !forceRefresh) {
    return _latestPocketBaseVersionCache;
  }
  try {
    const res = await axios.get("https://api.github.com/repos/pocketbase/pocketbase/releases/latest", { headers: { "User-Agent": "pb-manager" } });
    if (res.data?.tag_name) {
      _latestPocketBaseVersionCache = res.data.tag_name.replace(/^v/, "");
      return _latestPocketBaseVersionCache;
    }
    if (completeLogging) {
      console.warn(chalk.yellow(`Could not determine latest PocketBase version from GitHub API response. Using fallback ${FALLBACK_POCKETBASE_VERSION}.`));
    }
  } catch (e) {
    if (completeLogging) {
      console.error(chalk.red(`Failed to fetch latest PocketBase version from GitHub: ${e.message}. Using fallback version ${FALLBACK_POCKETBASE_VERSION}.`));
    }
  }
  _latestPocketBaseVersionCache = FALLBACK_POCKETBASE_VERSION;
  return _latestPocketBaseVersionCache;
}

async function getCliConfig() {
  const latestVersion = (await getLatestPocketBaseVersion()) || FALLBACK_POCKETBASE_VERSION;
  const defaults = {
    defaultCertbotEmail: null,
    defaultPocketBaseVersion: latestVersion,
    completeLogging: false,
  };

  if (await fs.pathExists(CLI_CONFIG_PATH)) {
    try {
      const config = await fs.readJson(CLI_CONFIG_PATH);
      if (!config.defaultPocketBaseVersion || typeof config.defaultPocketBaseVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(config.defaultPocketBaseVersion)) {
        config.defaultPocketBaseVersion = latestVersion;
      }
      return { ...defaults, ...config };
    } catch (e) {
      if (completeLogging) {
        console.warn(chalk.yellow("Could not read CLI config, using defaults."));
      }
    }
  }
  return defaults;
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
  const versionToDownload = versionOverride || cliConfig.defaultPocketBaseVersion;

  if (!versionOverride && (await fs.pathExists(POCKETBASE_EXEC_PATH))) {
    if (completeLogging) {
      console.log(chalk.green(`PocketBase executable already exists at ${POCKETBASE_EXEC_PATH}. Skipping download.`));
    }
    return;
  }

  if (await fs.pathExists(POCKETBASE_EXEC_PATH)) {
    if (completeLogging) {
      console.log(chalk.yellow(`Removing existing PocketBase executable at ${POCKETBASE_EXEC_PATH} to download version ${versionToDownload}...`));
    }
    await fs.remove(POCKETBASE_EXEC_PATH);
  }

  const downloadUrl = `https://github.com/pocketbase/pocketbase/releases/download/v${versionToDownload}/pocketbase_${versionToDownload}_linux_amd64.zip`;
  if (completeLogging) {
    console.log(chalk.blue(`Downloading PocketBase v${versionToDownload} from ${downloadUrl}...`));
  }
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

    if (completeLogging) {
      console.log(chalk.blue("Unzipping PocketBase..."));
    }

    await fs
      .createReadStream(zipPath)
      .pipe(unzipper.Extract({ path: POCKETBASE_BIN_DIR }))
      .promise();

    await fs.remove(zipPath);
    await fs.chmod(POCKETBASE_EXEC_PATH, "755");

    if (completeLogging) {
      console.log(chalk.green(`PocketBase v${versionToDownload} downloaded and extracted successfully to ${POCKETBASE_EXEC_PATH}.`));
    }
  } catch (error) {
    console.error(chalk.red(`Error downloading or extracting PocketBase v${versionToDownload}:`), error.message);
    if (error.response && error.response.status === 404) {
      console.error(chalk.red(`Version ${versionToDownload} not found. Please check the version number.`));
    }
    throw error;
  }
}

function runCommand(command, errorMessage, ignoreError = false) {
  if (completeLogging) {
    console.log(chalk.yellow(`Executing: ${command}`));
  }
  const result = shell.exec(command, { silent: !completeLogging });
  if (result.code !== 0 && !ignoreError) {
    console.error(chalk.red(errorMessage || `Error executing command: ${command}`));
    if (completeLogging) {
      console.error(chalk.red(result.stderr));
    }
    throw new Error(errorMessage || `Command failed: ${command}`);
  }
  return result;
}

async function updatePm2EcosystemFile() {
  const config = await getInstancesConfig();
  const apps = [];
  for (const instName in config.instances) {
    const inst = config.instances[instName];
    apps.push({
      name: `pb-${inst.name}`,
      script: POCKETBASE_EXEC_PATH,
      args: `serve --http "127.0.0.1:${inst.port}" --dir "${inst.dataDir}"`,
      cwd: POCKETBASE_BIN_DIR,
      autorestart: true,
      watch: false,
      max_memory_restart: "200M",
      env: { NODE_ENV: "production" },
    });
  }
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

async function generateNginxConfig(instanceName, domain, port, useHttps, useHttp2, maxBody20Mb) {
  const securityHeaders = `
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains; preload" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "DENY" always;
    add_header X-XSS-Protection "1; mode=block" always;`;
  const clientMaxBody = maxBody20Mb ? "client_max_body_size 20M;" : "";
  const http2 = useHttp2 ? " http2" : "";
  let configContent;
  if (useHttps) {
    configContent = `
      server {
        if ($host = ${domain}) {
          return 301 https://$host$request_uri;
        }
        listen 80;
        listen [::]:80;
        server_name ${domain};
        return 404;
      }

      server {
        server_name ${domain};
        ${securityHeaders}
        location / {
          ${clientMaxBody}
          proxy_pass http://127.0.0.1:${port};
          proxy_http_version 1.1;
          proxy_set_header Upgrade $http_upgrade;
          proxy_set_header Connection 'upgrade';
          proxy_set_header Host $host;
          proxy_set_header X-Forwarded-Proto $scheme;
          proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
          proxy_set_header X-Real-IP $remote_addr;
          proxy_cache_bypass $http_upgrade;
        }
        listen 443 ssl${http2};
        listen [::]:443 ssl${http2};
        ssl_certificate /etc/letsencrypt/live/${domain}/fullchain.pem;
        ssl_certificate_key /etc/letsencrypt/live/${domain}/privkey.pem;
        include /etc/letsencrypt/options-ssl-nginx.conf;
        ssl_dhparam /etc/letsencrypt/ssl-dhparam.pem;
      }
    `;
  } else {
    configContent = `
      server {
        server_name ${domain};
        ${securityHeaders}
        location / {
          ${clientMaxBody}
          proxy_pass http://127.0.0.1:${port};
          proxy_http_version 1.1;
          proxy_set_header Upgrade $http_upgrade;
          proxy_set_header Connection 'upgrade';
          proxy_set_header Host $host;
          proxy_set_header X-Forwarded-Proto $scheme;
          proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
          proxy_set_header X-Real-IP $remote_addr;
          proxy_cache_bypass $http_upgrade;
        }
        listen 80${http2};
        listen [::]:80${http2};
      }
    `;
  }

  const nginxConfPath = path.join(NGINX_SITES_AVAILABLE, instanceName);
  const nginxEnabledPath = path.join(NGINX_SITES_ENABLED, instanceName);

  if (completeLogging) {
    console.log(chalk.blue(`Generating Nginx config for ${instanceName} at ${nginxConfPath}`));
    console.log(chalk.blue(`Creating Nginx symlink: ${nginxEnabledPath}`));
  }
  await fs.writeFile(nginxConfPath, configContent.trim());
  try {
    runCommand(`sudo ln -sfn ${nginxConfPath} ${nginxEnabledPath}`);
  } catch (error) {
    if (completeLogging) {
      console.error(chalk.red("Failed to create symlink. Try running with sudo or create it manually."));
      console.log(`Manually run: sudo ln -sfn ${nginxConfPath} ${nginxEnabledPath}`);
    }
  }
}

async function reloadNginx() {
  if (completeLogging) {
    console.log(chalk.blue("Testing Nginx configuration..."));
  }
  try {
    runCommand("sudo nginx -t");
    if (completeLogging) {
      console.log(chalk.blue("Reloading Nginx..."));
    }
    runCommand("sudo systemctl reload nginx");
    console.log(chalk.green("Nginx reloaded successfully."));
  } catch (error) {
    console.error(chalk.red("Nginx test failed or reload failed. Please check Nginx configuration."));
    throw error;
  }
}

async function ensureDhParamExists() {
  const dhParamPath = "/etc/letsencrypt/ssl-dhparam.pem";
  if (!(await fs.pathExists(dhParamPath))) {
    if (completeLogging) {
      console.log(chalk.yellow(`${dhParamPath} not found. Generating... This may take a few minutes.`));
    }
    try {
      await fs.ensureDir("/etc/letsencrypt");
      runCommand(`sudo openssl dhparam -out ${dhParamPath} 2048`, `Failed to generate ${dhParamPath}. Nginx might fail to reload.`);
      if (completeLogging) {
        console.log(chalk.green(`${dhParamPath} generated successfully.`));
      }
    } catch (error) {
      console.error(chalk.red(`Error generating ${dhParamPath}: ${error.message}`));
    }
  } else {
    if (completeLogging) {
      console.log(chalk.green(`${dhParamPath} already exists.`));
    }
  }
}

async function runCertbot(domain, email) {
  if (!shell.which("certbot")) {
    console.error(chalk.red("Certbot command not found. Please install Certbot first."));
    return false;
  }
  if (completeLogging) {
    console.log(chalk.blue(`Attempting to obtain SSL certificate for ${domain} using Certbot...`));
  }
  try {
    runCommand("sudo mkdir -p /var/www/html", "Creating /var/www/html for Certbot", true);
  } catch (e) {}

  const certbotCommand = `sudo certbot --nginx -d ${domain} --non-interactive --agree-tos -m "${email}" --redirect`;
  try {
    runCommand(certbotCommand, "Certbot command failed.");
    if (completeLogging) {
      console.log(chalk.green(`Certbot successfully obtained and installed certificate for ${domain}.`));
    }
    return true;
  } catch (error) {
    console.error(chalk.red(`Certbot failed for ${domain}. Check Certbot logs.`));
    return false;
  }
}

async function getInstanceUsageAnalytics(instances) {
  const pm2ListRaw = shell.exec("pm2 jlist", { silent: true });
  let pm2List = [];
  if (pm2ListRaw.code === 0 && pm2ListRaw.stdout) {
    try {
      pm2List = JSON.parse(pm2ListRaw.stdout);
    } catch (e) {
      if (completeLogging) {
        console.error(chalk.red("Failed to parse pm2 jlist output."));
      }
      pm2List = [];
    }
  }
  const usage = [];
  for (const name in instances) {
    const inst = instances[name];
    let pm2Proc;
    for (const proc of pm2List) {
      if (proc.name === `pb-${name}`) {
        pm2Proc = proc;
        break;
      }
    }
    const status = pm2Proc ? pm2Proc.pm2_env.status : "offline";
    const cpu = pm2Proc?.monit ? pm2Proc.monit.cpu : 0;
    const mem = pm2Proc?.monit ? pm2Proc.monit.memory : 0;
    const uptime = pm2Proc?.pm2_env.pm_uptime ? Date.now() - pm2Proc.pm2_env.pm_uptime : 0;
    const dataDir = inst.dataDir;
    let dataSize = 0;
    try {
      if (await fs.pathExists(dataDir)) {
        dataSize = await getDirectorySize(dataDir);
      }
    } catch (e) {}
    let httpStatus = "-";
    try {
      const url = `http://127.0.0.1:${inst.port}/api/health`;
      const res = await axios.get(url, { timeout: 1000 }).catch(() => null);
      httpStatus = res && res.status === 200 ? "OK" : "ERR";
    } catch (e) {
      httpStatus = "ERR";
    }
    usage.push({
      name,
      domain: inst.domain,
      port: inst.port,
      status,
      cpu,
      mem,
      uptime,
      dataSize,
      httpStatus,
      ssl: inst.useHttps ? "Yes" : "No",
    });
  }
  return usage;
}

async function getDirectorySize(dir) {
  let total = 0;
  const files = await fs.readdir(dir);
  for (const file of files) {
    const filePath = path.join(dir, file);
    const stat = await fs.stat(filePath);
    if (stat.isDirectory()) {
      total += await getDirectorySize(filePath);
    } else {
      total += stat.size;
    }
  }
  return total;
}

function formatUptime(ms) {
  if (!ms || ms < 0) return "-";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

async function showDashboard() {
  await ensureBaseSetup();
  const config = await getInstancesConfig();
  const instanceNames = Object.keys(config.instances);
  if (instanceNames.length === 0) {
    console.log(chalk.yellow("No instances configured yet. Use 'pb-manager add'."));
    return;
  }
  const screen = blessed.screen({
    smartCSR: true,
    title: "PocketBase Manager Dashboard",
  });
  const grid = new contrib.grid({ rows: 12, cols: 12, screen: screen });
  const table = grid.set(0, 0, 10, 12, contrib.table, {
    keys: true,
    fg: "white",
    selectedFg: "white",
    selectedBg: "blue",
    interactive: true,
    label: "PocketBase Instances",
    width: "100%",
    height: "100%",
    border: { type: "line", fg: "cyan" },
    columnSpacing: 2,
    columnWidth: [12, 24, 7, 10, 8, 10, 10, 8, 8, 8],
  });
  const help = grid.set(10, 0, 2, 12, blessed.box, {
    content: " [q] Quit  [r] Refresh  [l] Logs  [s] Start/Stop  [d] Delete",
    tags: true,
    style: { fg: "yellow" },
  });

  let currentData = [];
  let selectedIndex = 0;

  async function refreshTable() {
    const usage = await getInstanceUsageAnalytics(config.instances);
    currentData = usage;
    const data = [];
    for (const u of usage) {
      data.push([u.name, u.domain, u.port, u.status, u.httpStatus, u.ssl, `${u.cpu}%`, prettyBytes(u.mem), formatUptime(u.uptime), prettyBytes(u.dataSize)]);
    }
    table.setData({
      headers: ["Name", "Domain", "Port", "Status", "HTTP", "SSL", "CPU", "Mem", "Uptime", "Data"],
      data,
    });
    if (data.length > 0) {
      if (selectedIndex >= data.length) selectedIndex = data.length - 1;
      if (selectedIndex < 0) selectedIndex = 0; // Ensure not negative
      table.rows.select(selectedIndex);
    }
    screen.render();
  }

  await refreshTable();
  const interval = setInterval(refreshTable, 2000);
  table.focus();

  table.rows.on("select", (_, idx) => {
    selectedIndex = typeof idx === "number" ? idx : table.rows.selected;
  });

  table.rows.on("keypress", (_, key) => {
    if (key && key.name === "up") {
      selectedIndex = Math.max(0, table.rows.selected);
    }
    if (key && key.name === "down") {
      selectedIndex = Math.min(currentData.length - 1, table.rows.selected);
    }
  });

  screen.key(["q", "C-c"], () => {
    clearInterval(interval);
    return process.exit(0);
  });
  screen.key(["r"], async () => {
    await refreshTable();
  });
  screen.key(["l"], () => {
    const idx = table.rows.selected;
    if (idx >= 0 && idx < currentData.length) {
      const name = currentData[idx].name;
      screen.destroy();
      clearInterval(interval);
      shell.exec(`pm2 logs pb-${name} --lines 50`);
      process.exit(0);
    }
  });
  screen.key(["s"], async () => {
    const idx = table.rows.selected;
    if (idx >= 0 && idx < currentData.length) {
      const name = currentData[idx].name;
      const inst = currentData[idx];
      if (inst.status === "online") {
        runCommand(`pm2 stop pb-${name}`);
      } else {
        runCommand(`pm2 start pb-${name}`);
      }
      await refreshTable();
    }
  });
  screen.key(["d"], async () => {
    const idx = table.rows.selected;
    if (idx >= 0 && idx < currentData.length) {
      const name = currentData[idx].name;
      screen.destroy();
      clearInterval(interval);
      shell.exec(`pb-manager remove ${name}`);
      process.exit(0);
    }
  });
  screen.render();
}

program
  .command("dashboard")
  .description("Show interactive dashboard for all PocketBase instances")
  .action(async () => {
    if (process.geteuid && process.geteuid() !== 0) {
      console.error(chalk.red("You must run this script as root or with sudo."));
      process.exit(1);
    }
    await showDashboard();
  });

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
          {
            name: `Enable complete logging: ${cliConfig.completeLogging ? "Yes" : "No"}`,
            value: "setLogging",
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
        cliConfig.defaultPocketBaseVersion = version || (await getLatestPocketBaseVersion());
        await saveCliConfig(cliConfig);
        console.log(chalk.green("Default PocketBase version updated."));
        break;
      }
      case "setLogging": {
        const { enableLogging } = await inquirer.prompt([
          {
            type: "confirm",
            name: "enableLogging",
            message: "Enable complete logging (show all commands and outputs)?",
            default: cliConfig.completeLogging || false,
          },
        ]);
        cliConfig.completeLogging = enableLogging;
        await saveCliConfig(cliConfig);
        completeLogging = enableLogging;
        console.log(chalk.green(`Complete logging is now ${enableLogging ? "enabled" : "disabled"}.`));
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
    if (process.geteuid && process.geteuid() !== 0) {
      console.error(chalk.red("You must run this script as root or with sudo."));
      process.exit(1);
    }
    console.log(chalk.bold.cyan("Starting PocketBase Manager Setup..."));
    await ensureBaseSetup();
    await downloadPocketBaseIfNotExists(options.version);
    console.log(chalk.bold.green("Setup complete!"));
  });

program
  .command("add")
  .description("Add a new PocketBase instance")
  .action(async () => {
    if (process.geteuid && process.geteuid() !== 0) {
      console.error(chalk.red("You must run this script as root or with sudo."));
      process.exit(1);
    }
    const cliConfig = await getCliConfig();
    await ensureBaseSetup();
    if (!(await fs.pathExists(POCKETBASE_EXEC_PATH))) {
      if (completeLogging) {
        console.log(chalk.yellow("PocketBase executable not found. Running setup..."));
      }
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
      {
        type: "confirm",
        name: "useHttp2",
        message: "Enable HTTP/2 in Nginx config?",
        default: true,
      },
      {
        type: "confirm",
        name: "maxBody20Mb",
        message: "Set 20Mb max body size (client_max_body_size 20M) in Nginx config?",
        default: true,
      },
    ]);

    const config = await getInstancesConfig();
    if (config.instances[initialAnswers.name]) {
      console.error(chalk.red(`Instance "${initialAnswers.name}" already exists.`));
      return;
    }
    for (const instName in config.instances) {
      if (config.instances[instName].port === initialAnswers.port) {
        console.error(chalk.red(`Port ${initialAnswers.port} is already in use by another managed instance.`));
        return;
      }
    }

    let emailToUseForCertbot = cliConfig.defaultCertbotEmail;

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
        message: `Use default email (${cliConfig.defaultCertbotEmail}) for Let's Encrypt?`,
        default: true,
        when: (answers) => answers.useHttps && cliConfig.defaultCertbotEmail,
      },
      {
        type: "input",
        name: "emailForCertbot",
        message: "Enter email for Let's Encrypt:",
        when: (answers) => answers.useHttps && (!cliConfig.defaultCertbotEmail || !answers.useDefaultEmail),
        validate: (input) => (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input) ? true : "Valid email required."),
        default: (answers) => (!cliConfig.defaultCertbotEmail || !answers.useDefaultEmail ? undefined : cliConfig.defaultCertbotEmail),
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
      if (cliConfig.defaultCertbotEmail && httpsAnswers.useDefaultEmail) {
        emailToUseForCertbot = cliConfig.defaultCertbotEmail;
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
      useHttp2: initialAnswers.useHttp2,
      maxBody20Mb: initialAnswers.maxBody20Mb,
    };

    await saveInstancesConfig(config);
    console.log(chalk.green(`Instance "${initialAnswers.name}" configuration saved.`));

    let certbotSuccess = false;
    const nginxConfigParams = {
      instanceName: initialAnswers.name,
      domain: initialAnswers.domain,
      port: initialAnswers.port,
      useHttp2: initialAnswers.useHttp2,
      maxBody20Mb: initialAnswers.maxBody20Mb,
    };
    if (httpsAnswers.useHttps) {
      await ensureDhParamExists();
      if (httpsAnswers.autoRunCertbot) {
        await generateNginxConfig(nginxConfigParams.instanceName, nginxConfigParams.domain, nginxConfigParams.port, false, false, nginxConfigParams.maxBody20Mb);
        await reloadNginx();
        certbotSuccess = await runCertbot(initialAnswers.domain, emailToUseForCertbot);
        if (certbotSuccess) {
          await generateNginxConfig(nginxConfigParams.instanceName, nginxConfigParams.domain, nginxConfigParams.port, true, nginxConfigParams.useHttp2, nginxConfigParams.maxBody20Mb);
        } else {
          await generateNginxConfig(nginxConfigParams.instanceName, nginxConfigParams.domain, nginxConfigParams.port, false, nginxConfigParams.useHttp2, nginxConfigParams.maxBody20Mb);
        }
      } else {
        await generateNginxConfig(nginxConfigParams.instanceName, nginxConfigParams.domain, nginxConfigParams.port, true, nginxConfigParams.useHttp2, nginxConfigParams.maxBody20Mb);
        console.log(chalk.yellow(`To obtain a certificate later, you can try running: sudo certbot --nginx -d ${initialAnswers.domain} -m ${emailToUseForCertbot}`));
      }
    } else {
      await generateNginxConfig(nginxConfigParams.instanceName, nginxConfigParams.domain, nginxConfigParams.port, false, nginxConfigParams.useHttp2, nginxConfigParams.maxBody20Mb);
    }

    await reloadNginx();
    await updatePm2EcosystemFile();
    await reloadPm2();

    let adminCreatedViaCli = false;

    const { createAdminCli } = await inquirer.prompt([
      {
        type: "confirm",
        name: "createAdminCli",
        message: "Do you want to create a superuser (admin) account for this instance via CLI now?",
        default: true,
      },
    ]);

    if (createAdminCli) {
      const adminCredentials = await inquirer.prompt([
        {
          type: "input",
          name: "adminEmail",
          message: "Enter admin email:",
          validate: (input) => (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input) ? true : "Please enter a valid email."),
        },
        {
          type: "password",
          name: "adminPassword",
          message: "Enter admin password (min 8 chars):",
          mask: "*",
          validate: (input) => (input.length >= 8 ? true : "Password must be at least 8 characters."),
        },
      ]);

      const adminCreateCommand = `${POCKETBASE_EXEC_PATH} superuser create "${adminCredentials.adminEmail}" "${adminCredentials.adminPassword}" --dir "${instanceDataDir}"`;
      if (completeLogging) {
        console.log(chalk.blue("\nAttempting to create superuser (admin) account via CLI..."));
        console.log(chalk.yellow(`Executing: ${adminCreateCommand}`));
      }
      try {
        const result = runCommand(adminCreateCommand, "Failed to create superuser (admin) account via CLI.");
        if (result?.stdout?.includes("Successfully created new superuser")) {
          console.log(result.stdout.trim());
        }
        console.log(chalk.green(`Superuser (admin) account for ${adminCredentials.adminEmail} created successfully!`));
        adminCreatedViaCli = true;
      } catch (e) {
        console.error(chalk.red("Superuser (admin) account creation via CLI failed. Please try creating it via the web UI."));
      }
    }

    console.log(chalk.bold.green(`\nInstance "${initialAnswers.name}" added and started!`));

    const protocol = httpsAnswers.useHttps && certbotSuccess ? "https" : "http";
    const publicBaseUrl = `${protocol}://${initialAnswers.domain}`;
    const localAdminUrl = `http://127.0.0.1:${initialAnswers.port}/_/`;

    console.log(chalk.blue("\nInstance Details:"));
    console.log(chalk.blue(`  Public URL: ${publicBaseUrl}/_/`));

    if (!adminCreatedViaCli) {
      console.log(chalk.yellow("\nIMPORTANT NEXT STEP: Create your PocketBase Admin Account"));
      console.log(chalk.yellow("1. Visit one of the URLs below in your browser to create the first admin user:"));
      console.log(chalk.yellow(`   - Option A (Recommended if Nginx/HTTPS is working): ${publicBaseUrl}/_/`));
      console.log(chalk.yellow(`   - Option B (Direct access, may require SSH port forwarding for headless servers): ${localAdminUrl}`));
      console.log(chalk.cyan(`     (For SSH port forwarding: ssh -L ${initialAnswers.port}:127.0.0.1:${initialAnswers.port} your_user@your_server_ip then open ${localAdminUrl} in your local browser)`));
    } else {
      console.log(chalk.yellow("\nYou can now access the admin panel at:"));
      console.log(chalk.yellow(`   - ${publicBaseUrl}/_/`));
      console.log(chalk.yellow(`   - Or locally (if needed for direct access): ${localAdminUrl}`));
    }

    if (httpsAnswers.useHttps && !certbotSuccess && httpsAnswers.autoRunCertbot) {
      console.log(chalk.red("\nCertbot failed. The instance might only be available via HTTP or not at all if Nginx config expects SSL."));
      console.log(chalk.red("You might need to use the local URL for admin access or fix the Nginx/Certbot issue."));
    }

    console.log(chalk.yellow("\nOnce logged in, you can manage your collections and settings."));
  });

program
  .command("update-pb")
  .description("Updates the PocketBase executable using 'pocketbase update' and restarts all instances.")
  .action(async () => {
    if (process.geteuid && process.geteuid() !== 0) {
      console.error(chalk.red("You must run this script as root or with sudo."));
      process.exit(1);
    }
    console.log(chalk.bold.cyan("Attempting to update PocketBase executable..."));
    if (!(await fs.pathExists(POCKETBASE_EXEC_PATH))) {
      console.error(chalk.red("PocketBase executable not found. Run 'setup' or 'configure' to set a version and download."));
      return;
    }
    try {
      if (completeLogging) {
        console.log(chalk.yellow(`Running: ${POCKETBASE_EXEC_PATH} update`));
      }
      const updateResult = shell.exec(`${POCKETBASE_EXEC_PATH} update`, {
        cwd: POCKETBASE_BIN_DIR,
        silent: !completeLogging,
      });

      if (updateResult.code !== 0) {
        console.error(chalk.red("PocketBase update command failed."));
        if (completeLogging) {
          console.error(updateResult.stderr);
        }
        return;
      }
      if (completeLogging) {
        console.log(chalk.green("PocketBase executable update process finished."));
        console.log(updateResult.stdout);
      }
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
    if (process.geteuid && process.geteuid() !== 0) {
      console.error(chalk.red("You must run this script as root or with sudo."));
      process.exit(1);
    }
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

    if (completeLogging) {
      console.log(chalk.blue(`Stopping and removing PM2 process for pb-${name}...`));
    }
    try {
      runCommand(`pm2 stop pb-${name}`, `Stopping pb-${name}`, true);
      runCommand(`pm2 delete pb-${name}`, `Deleting pb-${name}`, true);
    } catch (error) {
      if (completeLogging) {
        console.warn(chalk.yellow(`Could not stop/delete PM2 process pb-${name} (maybe not running).`));
      }
    }

    const nginxConfPath = path.join(NGINX_SITES_AVAILABLE, name);
    const nginxEnabledPath = path.join(NGINX_SITES_ENABLED, name);

    if (completeLogging) {
      console.log(chalk.blue(`Removing Nginx config for ${name}...`));
    }
    if (await fs.pathExists(nginxEnabledPath)) {
      try {
        runCommand(`sudo rm ${nginxEnabledPath}`);
      } catch (error) {
        if (completeLogging) {
          console.error(chalk.red(`Failed to remove Nginx symlink. Try: sudo rm ${nginxEnabledPath}`));
        }
      }
    }
    if (await fs.pathExists(nginxConfPath)) {
      try {
        runCommand(`sudo rm ${nginxConfPath}`);
      } catch (error) {
        if (completeLogging) {
          console.error(chalk.red(`Failed to remove Nginx available config. Try: sudo rm ${nginxConfPath}`));
        }
      }
    }

    delete config.instances[name];
    await saveInstancesConfig(config);
    console.log(chalk.green(`Instance "${name}" removed from configuration.`));

    await updatePm2EcosystemFile();
    try {
      runCommand("pm2 save");
    } catch (e) {}

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
      if (completeLogging) {
        console.warn(chalk.yellow("Could not fetch PM2 statuses. Is PM2 running?"));
      }
    }

    for (const name in config.instances) {
      const inst = config.instances[name];
      const status = pm2Statuses[name] || "UNKNOWN";
      const protocol = inst.useHttps ? "https" : "http";
      const publicUrl = `${protocol}://${inst.domain}`;
      console.log(`
        ${chalk.bold(name)}:
          Domain: ${chalk.green(inst.domain)} (${protocol})
          Public URL: ${chalk.green(publicUrl)}/_/
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
    if (process.geteuid && process.geteuid() !== 0) {
      console.error(chalk.red("You must run this script as root or with sudo."));
      process.exit(1);
    }
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
    if (process.geteuid && process.geteuid() !== 0) {
      console.error(chalk.red("You must run this script as root or with sudo."));
      process.exit(1);
    }
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
    if (process.geteuid && process.geteuid() !== 0) {
      console.error(chalk.red("You must run this script as root or with sudo."));
      process.exit(1);
    }
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
    if (process.geteuid && process.geteuid() !== 0) {
      console.error(chalk.red("You must run this script as root or with sudo."));
      process.exit(1);
    }
    console.log(chalk.blue(`Displaying logs for pb-${name}. Press Ctrl+C to exit.`));
    shell.exec(`pm2 logs pb-${name} --lines 50`);
  });

async function main() {
  if (process.geteuid && process.geteuid() !== 0) {
    console.error(chalk.red("You must run this script as root or with sudo."));
    process.exit(1);
  }
  const cliConfig = await getCliConfig();
  completeLogging = cliConfig.completeLogging || false;

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
  if (err.stack && (completeLogging || process.env.DEBUG)) {
    console.error(err.stack);
  }
  process.exit(1);
});
