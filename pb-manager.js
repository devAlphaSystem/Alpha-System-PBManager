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
const dns = require("node:dns/promises");

let NGINX_SITES_AVAILABLE = "/etc/nginx/sites-available";
let NGINX_SITES_ENABLED = "/etc/nginx/sites-enabled";
let NGINX_DISTRO_MODE = "debian";

const pbManagerVersion = "0.4.0";

function detectDistro() {
  if (shell.which("apt-get")) {
    NGINX_SITES_AVAILABLE = "/etc/nginx/sites-available";
    NGINX_SITES_ENABLED = "/etc/nginx/sites-enabled";
    NGINX_DISTRO_MODE = "debian";

    if (!fs.existsSync(NGINX_SITES_AVAILABLE)) {
      shell.exec(`sudo mkdir -p ${NGINX_SITES_AVAILABLE}`, { silent: true });
    }

    if (!fs.existsSync(NGINX_SITES_ENABLED)) {
      shell.exec(`sudo mkdir -p ${NGINX_SITES_ENABLED}`, { silent: true });
    }

    return "apt";
  }

  if (shell.which("dnf")) {
    NGINX_SITES_AVAILABLE = "/etc/nginx/conf.d";
    NGINX_SITES_ENABLED = "/etc/nginx/conf.d";
    NGINX_DISTRO_MODE = "rhel";

    if (!fs.existsSync(NGINX_SITES_AVAILABLE)) {
      shell.exec(`sudo mkdir -p ${NGINX_SITES_AVAILABLE}`, { silent: true });
    }

    if (!fs.existsSync(NGINX_SITES_ENABLED)) {
      shell.exec(`sudo mkdir -p ${NGINX_SITES_ENABLED}`, { silent: true });
    }

    return "dnf";
  }

  if (shell.which("pacman")) {
    NGINX_SITES_AVAILABLE = "/etc/nginx/sites-available";
    NGINX_SITES_ENABLED = "/etc/nginx/sites-enabled";
    NGINX_DISTRO_MODE = "arch";

    if (!fs.existsSync(NGINX_SITES_AVAILABLE)) {
      shell.exec(`sudo mkdir -p ${NGINX_SITES_AVAILABLE}`, { silent: true });
    }

    if (!fs.existsSync(NGINX_SITES_ENABLED)) {
      shell.exec(`sudo mkdir -p ${NGINX_SITES_ENABLED}`, { silent: true });
    }

    return "pacman";
  }

  return null;
}

const CONFIG_DIR = path.join(process.env.HOME || os.homedir(), ".pb-manager");
const CLI_CONFIG_PATH = path.join(CONFIG_DIR, "cli-config.json");
const INSTANCES_CONFIG_PATH = path.join(CONFIG_DIR, "instances.json");
const POCKETBASE_BIN_DIR = path.join(CONFIG_DIR, "bin");
const POCKETBASE_EXEC_PATH = path.join(POCKETBASE_BIN_DIR, "pocketbase");
const INSTANCES_DATA_BASE_DIR = path.join(CONFIG_DIR, "instances_data");
const PM2_ECOSYSTEM_FILE = path.join(CONFIG_DIR, "ecosystem.config.js");
const VERSION_CACHE_PATH = path.join(CONFIG_DIR, "version-cache.json");

let completeLogging = false;

let _latestPocketBaseVersionCache = null;
const FALLBACK_POCKETBASE_VERSION = "0.28.1";

let currentCommandNameForAudit = "pb-manager";
let currentCommandArgsForAudit = "";

async function appendAuditLog(command, details, error = null) {
  const auditLogPath = path.join(CONFIG_DIR, "audit.log");
  const timestamp = new Date().toISOString();

  let logEntry;

  if (error) {
    const errorMessage = String(error.message || error).replace(/\n/g, " ");

    logEntry = `${timestamp} - ERROR during command: ${command} (Args: ${details || "N/A"}) - Message: ${errorMessage}\n`;
  } else {
    logEntry = `${timestamp} - Command: ${command}; Args: ${details || "N/A"}\n`;
  }

  try {
    await fs.ensureDir(CONFIG_DIR);
    await fs.appendFile(auditLogPath, logEntry);
  } catch (e) {
    if (completeLogging) {
      console.log(chalk.red(`Failed to append to audit log: ${e.message}`));
    }
  }
}

async function validateDnsRecords(domain) {
  try {
    const publicIpRes = await axios.get("https://api.ipify.org?format=json", { timeout: 5000 }).catch(() => null);
    if (!publicIpRes || !publicIpRes.data || !publicIpRes.data.ip) {
      console.log(chalk.yellow("Could not fetch server's public IP. Skipping DNS validation."));

      return true;
    }

    const serverIp = publicIpRes.data.ip;

    let domainResolved = false;
    let pointsToServer = false;

    try {
      const aRecords = await dns.resolve4(domain);

      domainResolved = true;

      for (let i = 0; i < aRecords.length; i++) {
        if (aRecords[i] === serverIp) {
          pointsToServer = true;

          break;
        }
      }
    } catch (e) {
      if (completeLogging) {
        console.log(chalk.blue(`No A records found or error resolving A records for ${domain}: ${e.message}`));
      }
    }

    if (!pointsToServer) {
      try {
        const aaaaRecords = await dns.resolve6(domain);

        domainResolved = domainResolved || aaaaRecords.length > 0;

        for (let i = 0; i < aaaaRecords.length; i++) {
          if (aaaaRecords[i] === serverIp) {
            pointsToServer = true;

            break;
          }
        }
      } catch (e) {
        if (completeLogging) {
          console.log(chalk.blue(`No AAAA records found or error resolving AAAA records for ${domain}: ${e.message}`));
        }
      }
    }

    if (!domainResolved) {
      console.log(chalk.red(`Domain ${domain} could not be resolved. It might not exist or DNS propagation is pending.`));

      return false;
    }

    if (!pointsToServer) {
      console.log(chalk.yellow(`Domain ${domain} exists but does not seem to point to this server's IP (${serverIp}). Please check your DNS A/AAAA records.`));
    }

    return pointsToServer;
  } catch (e) {
    console.log(chalk.red(`Error validating DNS records for ${domain}: ${e.message}`));

    return false;
  }
}

async function getCachedLatestVersion() {
  const now = Date.now();

  try {
    if (await fs.pathExists(VERSION_CACHE_PATH)) {
      try {
        const cache = await fs.readJson(VERSION_CACHE_PATH);
        if (cache && typeof cache.timestamp === "number" && typeof cache.latestVersion === "string" && now - cache.timestamp < 24 * 60 * 60 * 1000) {
          return cache.latestVersion;
        }
      } catch (e) {}
    }

    const latestVersion = await getLatestPocketBaseVersion(true);

    await fs.ensureDir(path.dirname(VERSION_CACHE_PATH));
    await fs.writeJson(VERSION_CACHE_PATH, {
      timestamp: now,
      latestVersion,
    });

    return latestVersion;
  } catch (e) {
    if (completeLogging) {
      console.log(chalk.yellow(`Error with version cache: ${e.message}. Fetching directly.`));
    }

    return await getLatestPocketBaseVersion(false);
  }
}

async function getLatestPocketBaseVersion(forceRefresh = false) {
  if (_latestPocketBaseVersionCache && !forceRefresh) {
    return _latestPocketBaseVersionCache;
  }

  try {
    const res = await axios.get("https://api.github.com/repos/pocketbase/pocketbase/releases/latest", { headers: { "User-Agent": "pb-manager" }, timeout: 5000 });
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
    api: {
      enabled: false,
      secret: `pbmanager-internal-secret-${Date.now().toString(36)}${Math.random().toString(36).substring(2)}`,
    },
  };

  if (await fs.pathExists(CLI_CONFIG_PATH)) {
    try {
      const config = await fs.readJson(CLI_CONFIG_PATH);
      if (!config.defaultPocketBaseVersion || typeof config.defaultPocketBaseVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(config.defaultPocketBaseVersion)) {
        config.defaultPocketBaseVersion = latestVersion;
      }

      const mergedConfig = {
        ...defaults,
        ...config,
        api: { ...defaults.api, ...(config.api || {}) },
      };

      return mergedConfig;
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
  if (!(await fs.pathExists(INSTANCES_CONFIG_PATH))) {
    await fs.writeJson(INSTANCES_CONFIG_PATH, { instances: {} });
  }

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

    return { success: true, message: "PocketBase executable already exists." };
  }

  if (await fs.pathExists(POCKETBASE_EXEC_PATH)) {
    const { confirmOverwrite } = await inquirer.prompt([
      {
        type: "confirm",
        name: "confirmOverwrite",
        message: `PocketBase executable already exists at ${POCKETBASE_EXEC_PATH}. Do you want to remove it and download version ${versionToDownload}?`,
        default: false,
      },
    ]);

    if (!confirmOverwrite) {
      console.log(chalk.yellow("Download cancelled by user."));

      return { success: false, message: "Download cancelled by user." };
    }

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

    return {
      success: true,
      message: `PocketBase v${versionToDownload} downloaded.`,
    };
  } catch (error) {
    console.error(chalk.red(`Error downloading or extracting PocketBase v${versionToDownload}:`), error.message);

    if (error.response && error.response.status === 404) {
      console.error(chalk.red(`Version ${versionToDownload} not found. Please check the version number.`));
    }

    if (program.runningCommand && program.runningCommand.name() === "_internal-api-request") {
      return { success: false, message: error.message, error };
    }

    throw error;
  }
}

function runCommand(command, errorMessage, ignoreError = false, options = {}) {
  if (completeLogging) {
    console.log(chalk.yellow(`Executing: ${command}`));
  }

  const result = shell.exec(command, { silent: !completeLogging, ...options });
  if (result.code !== 0 && !ignoreError) {
    console.error(chalk.red(errorMessage || `Error executing command: ${command}`));

    if (completeLogging || !options.silent) {
      console.error(chalk.red(result.stderr));
    }

    throw new Error(`${errorMessage} - Stderr: ${result.stderr}`);
  }

  return result;
}

async function updatePm2EcosystemFile() {
  const config = await getInstancesConfig();
  const apps = [];

  for (const instName in config.instances) {
    const inst = config.instances[instName];
    const migrationsDir = path.join(inst.dataDir, "pb_migrations");

    apps.push({
      name: `pb-${inst.name}`,
      script: POCKETBASE_EXEC_PATH,
      args: `serve --http "127.0.0.1:${inst.port}" --dir "${inst.dataDir}" --migrationsDir "${migrationsDir}"`,
      cwd: inst.dataDir,
      autorestart: true,
      watch: false,
      max_memory_restart: "200M",
      env: { NODE_ENV: "production" },
    });
  }

  const ecosystemContent = `module.exports = { apps: ${JSON.stringify(apps, null, 2)} };`;

  await fs.writeFile(PM2_ECOSYSTEM_FILE, ecosystemContent);

  if (!program.runningCommand || program.runningCommand.name() !== "_internal-api-request") {
    console.log(chalk.green("PM2 ecosystem file updated."));
  }

  return { success: true, message: "PM2 ecosystem file updated." };
}

async function reloadPm2(specificInstanceName = null) {
  try {
    if (specificInstanceName) {
      runCommand(`pm2 restart pb-${specificInstanceName}`);
    } else {
      runCommand(`pm2 reload ${PM2_ECOSYSTEM_FILE}`);
    }

    runCommand("pm2 save");

    const message = specificInstanceName ? `PM2 process pb-${specificInstanceName} restarted and PM2 state saved.` : "PM2 ecosystem reloaded and PM2 state saved.";

    if (!program.runningCommand || program.runningCommand.name() !== "_internal-api-request") {
      console.log(chalk.green(message));
    }

    return { success: true, message };
  } catch (error) {
    const message = `Failed to reload PM2: ${error.message}`;

    if (!program.runningCommand || program.runningCommand.name() !== "_internal-api-request") {
      console.error(chalk.red(message));
    }

    return { success: false, message };
  }
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

  let nginxConfPath;
  let nginxEnabledPath;

  if (NGINX_DISTRO_MODE === "rhel") {
    nginxConfPath = path.join(NGINX_SITES_AVAILABLE, `${instanceName}.conf`);
    nginxEnabledPath = nginxConfPath;
  } else {
    nginxConfPath = path.join(NGINX_SITES_AVAILABLE, instanceName);
    nginxEnabledPath = path.join(NGINX_SITES_ENABLED, instanceName);
  }

  if (completeLogging) {
    console.log(chalk.blue(`Generating Nginx config for ${instanceName} at ${nginxConfPath}`));
  }

  await fs.writeFile(nginxConfPath, configContent.trim());

  if (NGINX_DISTRO_MODE !== "rhel") {
    if (completeLogging) {
      console.log(chalk.blue(`Creating Nginx symlink: ${nginxEnabledPath}`));
    }

    try {
      runCommand(`sudo ln -sfn ${nginxConfPath} ${nginxEnabledPath}`);
    } catch (error) {
      const errorMsg = `Failed to create Nginx symlink for ${nginxConfPath} to ${nginxEnabledPath}: ${error.message}. Please try running this command with sudo, or create the symlink manually.`;

      if (!program.runningCommand || program.runningCommand.name() !== "_internal-api-request") {
        console.error(chalk.red(errorMsg));
        console.log(chalk.yellow(`Manually run: sudo ln -sfn ${nginxConfPath} ${nginxEnabledPath}`));
      }

      throw new Error(errorMsg);
    }
  }

  return {
    success: true,
    message: `Nginx config generated for ${instanceName} at ${nginxConfPath}`,
    path: nginxConfPath,
  };
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

    let reloaded = false;

    if (shell.which("systemctl")) {
      try {
        runCommand("sudo systemctl reload nginx");

        reloaded = true;
      } catch (e) {}
    }

    if (!reloaded && shell.which("service")) {
      try {
        runCommand("sudo service nginx reload");

        reloaded = true;
      } catch (e) {}
    }

    if (!reloaded) {
      try {
        runCommand("sudo nginx -s reload");

        reloaded = true;
      } catch (e) {}
    }

    if (!reloaded) {
      throw new Error("Could not reload Nginx with systemctl, service, or nginx -s reload.");
    }

    if (!program.runningCommand || program.runningCommand.name() !== "_internal-api-request") {
      console.log(chalk.green("Nginx reloaded successfully."));
    }

    return { success: true, message: "Nginx reloaded successfully." };
  } catch (error) {
    const errorMsg = `Nginx test failed or reload failed: ${error.message}. Please check Nginx configuration.`;

    if (!program.runningCommand || program.runningCommand.name() !== "_internal-api-request") {
      console.error(chalk.red(errorMsg));
      console.log(chalk.yellow("You can try to diagnose Nginx issues by running: sudo nginx -t"));
      console.log(chalk.yellow("Check Nginx error logs, typically found in /var/log/nginx/error.log"));
    }

    return { success: false, message: errorMsg, error };
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

      return {
        success: true,
        message: `${dhParamPath} generated successfully.`,
      };
    } catch (error) {
      const errorMsg = `Error generating ${dhParamPath}: ${error.message}`;
      console.error(chalk.red(errorMsg));

      return { success: false, message: errorMsg };
    }
  } else {
    if (completeLogging) {
      console.log(chalk.green(`${dhParamPath} already exists.`));
    }

    return { success: true, message: `${dhParamPath} already exists.` };
  }
}

async function runCertbot(domain, email, isCliCall = true) {
  if (!shell.which("certbot")) {
    const msg = "Certbot command not found. Please install Certbot first.";

    if (isCliCall) console.error(chalk.red(msg));

    return { success: false, message: msg };
  }

  if (completeLogging && isCliCall) {
    console.log(chalk.blue(`Attempting to obtain SSL certificate for ${domain} using Certbot...`));
  }

  try {
    runCommand("sudo mkdir -p /var/www/html", "Creating /var/www/html for Certbot", true);
  } catch (e) {}

  let certbotCommand;

  if (NGINX_DISTRO_MODE === "rhel") {
    certbotCommand = `sudo certbot --nginx -d ${domain} --non-interactive --agree-tos -m "${email}" --redirect --nginx-server-root /etc/nginx/`;
  } else {
    certbotCommand = `sudo certbot --nginx -d ${domain} --non-interactive --agree-tos -m "${email}" --redirect`;
  }

  if (isCliCall) {
    const { confirmCertbotRun } = await inquirer.prompt([
      {
        type: "confirm",
        name: "confirmCertbotRun",
        message: `Ready to run Certbot for domain ${domain} with email ${email}. Command: ${certbotCommand}. Proceed?`,
        default: true,
      },
    ]);

    if (!confirmCertbotRun) {
      console.log(chalk.yellow("Certbot execution cancelled by user."));

      return {
        success: false,
        message: "Certbot execution cancelled by user.",
      };
    }
  }

  try {
    runCommand(certbotCommand, "Certbot command failed.");

    const successMsg = `Certbot successfully obtained and installed certificate for ${domain}.`;

    if (completeLogging && isCliCall) console.log(chalk.green(successMsg));

    return { success: true, message: successMsg };
  } catch (error) {
    const errorMsg = `Certbot failed for ${domain}: ${error.message}. Check Certbot logs.`;

    if (isCliCall) {
      console.error(chalk.red(errorMsg));
      console.log(chalk.yellow("You can try running Certbot manually or check logs in /var/log/letsencrypt/"));
    }

    return { success: false, message: errorMsg, error };
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

    for (let i = 0; i < pm2List.length; i++) {
      if (pm2List[i].name === `pb-${name}`) {
        pm2Proc = pm2List[i];
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
  for (let i = 0; i < files.length; i++) {
    const filePath = path.join(dir, files[i]);
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

async function getCertExpiryDays(domain) {
  return new Promise((resolve) => {
    const tls = require("node:tls");
    const options = {
      host: domain,
      port: 443,
      servername: domain,
      rejectUnauthorized: false,
      timeout: 5000,
    };

    const socket = tls.connect(options, () => {
      const cert = socket.getPeerCertificate();

      socket.end();

      if (!cert || !cert.valid_to) {
        resolve("-");
      } else {
        const expiryDate = new Date(cert.valid_to);
        const now = new Date();
        const diff = expiryDate.getTime() - now.getTime();
        const daysLeft = Math.ceil(diff / (1000 * 60 * 60 * 24));

        resolve(daysLeft);
      }
    });

    socket.on("error", () => {
      resolve("-");
    });

    socket.setTimeout(5000, () => {
      socket.destroy();

      resolve("-");
    });
  });
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
    columnWidth: [25, 25, 8, 10, 8, 10, 10, 8, 8, 8],
  });

  const help = grid.set(10, 0, 2, 12, blessed.box, {
    content: " [q] Quit  [r] Refresh  [l] Logs  [s] Start/Stop  [d] Delete",
    tags: true,
    style: { fg: "yellow" },
  });

  function truncateText(text, maxLength) {
    return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
  }

  let currentData = [];
  let selectedIndex = 0;

  async function refreshTable() {
    const usage = await getInstanceUsageAnalytics(config.instances);
    currentData = usage;

    const data = [];

    for (let i = 0; i < usage.length; i++) {
      const u = usage[i];
      data.push([truncateText(u.name, 25), truncateText(u.domain, 25), u.port, u.status, u.httpStatus, u.ssl, `${u.cpu}%`, prettyBytes(u.mem), formatUptime(u.uptime), prettyBytes(u.dataSize)]);
    }

    table.setData({
      headers: ["Name", "Domain", "Port", "Status", "HTTP", "SSL", "CPU", "Mem", "Uptime", "Data"],
      data,
    });

    if (data.length > 0) {
      if (selectedIndex >= data.length) selectedIndex = data.length - 1;
      if (selectedIndex < 0) selectedIndex = 0;

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

      console.log(chalk.yellow(`To delete instance "${name}", please run: pb-manager remove ${name}`));

      process.exit(0);
    }
  });

  screen.render();
}

async function _internalGetGlobalStats() {
  try {
    const cliConfig = await getCliConfig();

    return {
      success: true,
      data: {
        pbManagerVersion,
        defaultPocketBaseVersion: cliConfig.defaultPocketBaseVersion,
        pocketBaseExecutablePath: POCKETBASE_EXEC_PATH,
        configDirectory: CONFIG_DIR,
        nginxSitesAvailable: NGINX_SITES_AVAILABLE,
        nginxSitesEnabled: NGINX_SITES_ENABLED,
        nginxDistroMode: NGINX_DISTRO_MODE,
        completeLoggingEnabled: completeLogging,
      },
    };
  } catch (error) {
    return { success: false, error: error.message, messages: [error.message] };
  }
}

async function _internalGetInstanceLogs(payload) {
  const { name, lines = 100 } = payload;
  if (!name) {
    return { success: false, error: "Instance name is required for logs.", messages: ["Instance name is required for logs."] };
  }
  const instancePM2Name = `pb-${name}`;
  try {
    const config = await getInstancesConfig();
    if (!config.instances[name]) {
      return { success: false, error: `Instance "${name}" not found in configuration.`, messages: [`Instance "${name}" not found in configuration.`] };
    }

    const logCommand = `pm2 logs ${instancePM2Name} --lines ${lines} --nostream --raw`;
    const result = shell.exec(logCommand, { silent: true });

    let logs = result.stdout || "";
    if (result.stderr && !result.stderr.includes("process name not found")) {
      logs += `\n--- STDERR ---\n${result.stderr}`;
    }
    if (result.stderr?.includes("process name not found") && result.stdout.trim() === "") {
      return { success: false, error: `PM2 process ${instancePM2Name} not found or no logs available.`, details: result.stderr, messages: [`PM2 process ${instancePM2Name} not found or no logs available.`] };
    }

    return { success: true, data: { name, logs: logs.trim() || "No log output." }, messages: ["Logs retrieved."] };
  } catch (error) {
    return { success: false, error: `Failed to get logs for ${instancePM2Name}: ${error.message}`, messages: [`Failed to get logs for ${instancePM2Name}: ${error.message}`] };
  }
}

async function _internalListInstances() {
  const config = await getInstancesConfig();
  if (Object.keys(config.instances).length === 0) {
    return [];
  }

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
  } catch (e) {}

  const output = [];
  for (const name in config.instances) {
    const inst = config.instances[name];

    let certExpiry = "-";

    if (inst.useHttps) {
      certExpiry = await getCertExpiryDays(inst.domain);
    }

    const status = pm2Statuses[name] || "UNKNOWN";
    const protocol = inst.useHttps ? "https" : "http";
    const publicUrl = `${protocol}://${inst.domain}`;

    output.push({
      name,
      domain: inst.domain,
      protocol,
      publicUrl: `${publicUrl}/_/`,
      internalPort: inst.port,
      dataDirectory: inst.dataDir,
      pm2Status: status,
      adminURL: `http://127.0.0.1:${inst.port}/_/`,
      certExpiryDays: certExpiry,
    });
  }

  return output;
}

async function _internalAddInstance(payload) {
  const { name, domain, port, useHttps = true, emailForCertbot, useHttp2 = true, maxBody20Mb = true, autoRunCertbot = true } = payload;

  const results = {
    success: false,
    messages: [],
    instance: null,
    nginxConfigPath: null,
    certbotSuccess: null,
    error: null,
  };

  try {
    await ensureBaseSetup();

    const pbDownloadResult = await downloadPocketBaseIfNotExists();
    if (pbDownloadResult && pbDownloadResult.success === false && !(await fs.pathExists(POCKETBASE_EXEC_PATH))) {
      results.messages.push(`PocketBase executable not found and download failed: ${pbDownloadResult.message}`);
      results.error = "PocketBase download failed";

      return results;
    }

    const config = await getInstancesConfig();
    if (config.instances[name]) {
      results.messages.push(`Instance "${name}" already exists.`);
      results.error = "Instance already exists";

      return results;
    }

    for (const instName in config.instances) {
      if (config.instances[instName].port === port) {
        results.messages.push(`Port ${port} is already in use by instance "${instName}".`);
        results.error = "Port in use";

        return results;
      }

      if (config.instances[instName].domain === domain) {
        results.messages.push(`Domain ${domain} is already in use by instance "${instName}".`);
        results.error = "Domain in use";

        return results;
      }
    }

    if (useHttps && !emailForCertbot) {
      results.messages.push("Email for Certbot is required when HTTPS is enabled.");
      results.error = "Missing Certbot email";

      return results;
    }

    const instanceDataDir = path.join(INSTANCES_DATA_BASE_DIR, name);
    await fs.ensureDir(instanceDataDir);

    const newInstanceConfig = {
      name,
      domain,
      port,
      dataDir: instanceDataDir,
      useHttps,
      emailForCertbot: useHttps ? emailForCertbot : null,
      useHttp2,
      maxBody20Mb,
    };

    config.instances[name] = newInstanceConfig;

    await saveInstancesConfig(config);

    results.messages.push(`Instance "${name}" configuration saved.`);
    results.instance = newInstanceConfig;

    let certbotRanSuccessfully = false;

    const nginxResult = await generateNginxConfig(name, domain, port, false, false, maxBody20Mb);
    results.nginxConfigPath = nginxResult.path;
    results.messages.push(nginxResult.message);

    const nginxReload1 = await reloadNginx();
    results.messages.push(nginxReload1.message);
    if (!nginxReload1.success) throw nginxReload1.error || new Error(nginxReload1.message);

    if (useHttps) {
      await ensureDhParamExists();
      if (autoRunCertbot) {
        const certbotResult = await runCertbot(domain, emailForCertbot, false);
        results.certbotSuccess = certbotResult.success;
        results.messages.push(`Certbot for ${domain}: ${certbotResult.message}`);

        certbotRanSuccessfully = certbotResult.success;

        if (certbotResult.success) {
          const httpsNginxResult = await generateNginxConfig(name, domain, port, true, useHttp2, maxBody20Mb);
          results.messages.push(httpsNginxResult.message);
        } else {
          results.messages.push("Certbot failed. Nginx remains HTTP-only.");
        }
      } else {
        const httpsNginxResult = await generateNginxConfig(name, domain, port, true, useHttp2, maxBody20Mb);
        results.messages.push(httpsNginxResult.message);
        results.messages.push("HTTPS Nginx config generated, Certbot not run automatically. Manual run needed.");
      }
    } else {
      results.messages.push("HTTP-only Nginx config generated (or updated).");
    }

    const nginxReload2 = await reloadNginx();
    results.messages.push(nginxReload2.message);
    if (!nginxReload2.success) throw nginxReload2.error || new Error(nginxReload2.message);

    const pm2UpdateResult = await updatePm2EcosystemFile();
    results.messages.push(pm2UpdateResult.message);
    if (!pm2UpdateResult.success) throw new Error(pm2UpdateResult.message);

    const pm2ReloadResult = await reloadPm2();
    results.messages.push(pm2ReloadResult.message);
    if (!pm2ReloadResult.success) throw new Error(pm2ReloadResult.message);

    results.success = true;

    const finalProtocol = useHttps && certbotRanSuccessfully ? "https" : "http";
    results.instance.url = `${finalProtocol}://${domain}/_/`;
    results.messages.push(`Instance "${name}" added and started. Access at ${results.instance.url}`);
  } catch (error) {
    results.messages.push(`Error during internal add instance: ${error.message}`);
    results.error = error.message;

    if (completeLogging) console.error(error.stack);
  }

  return results;
}

async function _internalRemoveInstance(payload) {
  const { name } = payload;
  const results = { success: false, messages: [], error: null };

  try {
    const config = await getInstancesConfig();
    if (!config.instances[name]) {
      results.error = `Instance "${name}" not found.`;

      results.messages.push(results.error);

      return results;
    }

    const instanceDataDir = config.instances[name].dataDir;

    try {
      runCommand(`pm2 stop pb-${name}`, `Stopping pb-${name}`, true);

      results.messages.push(`Attempted to stop PM2 process pb-${name}.`);

      runCommand(`pm2 delete pb-${name}`, `Deleting pb-${name}`, true);

      results.messages.push(`Attempted to delete PM2 process pb-${name}.`);
    } catch (e) {
      results.messages.push(`Warning: Could not stop/delete PM2 process pb-${name} (maybe not running/exists): ${e.message}`);
    }

    const nginxConfPathBase = NGINX_DISTRO_MODE === "rhel" ? `${name}.conf` : name;
    const nginxConfPath = path.join(NGINX_SITES_AVAILABLE, nginxConfPathBase);
    const nginxEnabledPath = NGINX_DISTRO_MODE === "rhel" ? nginxConfPath : path.join(NGINX_SITES_ENABLED, name);

    if (NGINX_DISTRO_MODE !== "rhel" && (await fs.pathExists(nginxEnabledPath))) {
      try {
        runCommand(`sudo rm ${nginxEnabledPath}`);

        results.messages.push(`Removed Nginx symlink ${nginxEnabledPath}.`);
      } catch (e) {
        results.messages.push(`Warning: Failed to remove Nginx symlink ${nginxEnabledPath}: ${e.message}`);
      }
    }

    if (await fs.pathExists(nginxConfPath)) {
      try {
        runCommand(`sudo rm ${nginxConfPath}`);

        results.messages.push(`Removed Nginx config ${nginxConfPath}.`);
      } catch (e) {
        results.messages.push(`Warning: Failed to remove Nginx config ${nginxConfPath}: ${e.message}`);
      }
    }

    delete config.instances[name];

    await saveInstancesConfig(config);

    results.messages.push(`Instance "${name}" removed from configuration.`);

    await updatePm2EcosystemFile();

    try {
      runCommand("pm2 save");
      results.messages.push("PM2 state saved.");
    } catch (e) {}

    await reloadNginx();

    results.messages.push(`Data directory at ${instanceDataDir} was NOT deleted. Manual deletion required if desired.`);
    results.success = true;
  } catch (error) {
    results.messages.push(`Error during internal remove instance: ${error.message}`);
    results.error = error.message;
  }

  return results;
}

async function _internalCloneInstance(payload) {
  const { sourceName, newName, domain, port, useHttps = true, emailForCertbot, useHttp2 = true, maxBody20Mb = true, autoRunCertbot = true } = payload;

  const results = { success: false, messages: [], instance: null, nginxConfigPath: null, certbotSuccess: null, error: null };

  try {
    await ensureBaseSetup();

    if (!(await fs.pathExists(POCKETBASE_EXEC_PATH))) {
      results.messages.push("PocketBase executable not found. Attempting download.");
      const dlResult = await downloadPocketBaseIfNotExists();
      if (dlResult && dlResult.success === false) {
        results.error = `PocketBase executable not found and download failed: ${dlResult.message}`;
        results.messages.push(results.error);
        return results;
      }
      if (!(await fs.pathExists(POCKETBASE_EXEC_PATH))) {
        results.error = "PocketBase download failed after attempt. Cannot clone instance.";
        results.messages.push(results.error);
        return results;
      }
    }

    const config = await getInstancesConfig();
    const sourceInstance = config.instances[sourceName];

    if (!sourceInstance) {
      results.error = `Source instance "${sourceName}" not found.`;
      results.messages.push(results.error);
      return results;
    }

    if (config.instances[newName]) {
      results.error = `Target instance "${newName}" already exists.`;
      results.messages.push(results.error);
      return results;
    }

    for (const instName in config.instances) {
      if (config.instances[instName].port === port) {
        results.error = `Port ${port} is already in use by instance "${instName}".`;
        results.messages.push(results.error);
        return results;
      }
      if (config.instances[instName].domain === domain) {
        results.error = `Domain ${domain} is already in use by instance "${instName}".`;
        results.messages.push(results.error);
        return results;
      }
    }

    if (useHttps && !emailForCertbot) {
      results.error = "Email for Certbot is required when HTTPS is enabled for the clone.";
      results.messages.push(results.error);
      return results;
    }

    if (useHttps && autoRunCertbot) {
      const dnsValid = await validateDnsRecords(domain);
      if (!dnsValid) {
        results.messages.push(chalk.yellow(`DNS validation failed for ${domain}. Certbot will likely fail. Proceeding, but manual intervention may be needed.`));
      }
    }

    const newInstanceDataDir = path.join(INSTANCES_DATA_BASE_DIR, newName);
    await fs.ensureDir(path.dirname(newInstanceDataDir));

    results.messages.push(`Copying data from ${sourceInstance.dataDir} to ${newInstanceDataDir}...`);
    try {
      await fs.copy(sourceInstance.dataDir, newInstanceDataDir);
      results.messages.push("Data copied successfully.");
    } catch (err) {
      results.error = `Error copying data: ${err.message}`;
      results.messages.push(results.error);
      return results;
    }

    const newInstanceConfig = { name: newName, domain, port, dataDir: newInstanceDataDir, useHttps, emailForCertbot: useHttps ? emailForCertbot : null, useHttp2, maxBody20Mb };
    config.instances[newName] = newInstanceConfig;
    await saveInstancesConfig(config);
    results.messages.push(`Instance "${newName}" configuration saved.`);
    results.instance = newInstanceConfig;

    let certbotRanSuccessfully = false;

    const nginxResultHttp = await generateNginxConfig(newName, domain, port, false, false, maxBody20Mb);
    results.messages.push(nginxResultHttp.message);
    if (nginxResultHttp.path) results.nginxConfigPath = nginxResultHttp.path;

    const nginxReload1 = await reloadNginx();
    results.messages.push(nginxReload1.message);
    if (!nginxReload1.success) {
      results.error = nginxReload1.error?.message || nginxReload1.message || "Nginx reload after HTTP config failed.";
      return results;
    }

    if (useHttps) {
      await ensureDhParamExists();
      if (autoRunCertbot) {
        const certbotResult = await runCertbot(domain, emailForCertbot, false);
        results.certbotSuccess = certbotResult.success;
        results.messages.push(`Certbot for ${domain}: ${certbotResult.message}`);
        certbotRanSuccessfully = certbotResult.success;

        if (certbotResult.success) {
          const httpsNginxResult = await generateNginxConfig(newName, domain, port, true, useHttp2, maxBody20Mb);
          results.messages.push(httpsNginxResult.message);
          if (httpsNginxResult.path) results.nginxConfigPath = httpsNginxResult.path;
        } else {
          results.messages.push("Certbot failed. Nginx may remain HTTP-only.");
        }
      } else {
        const httpsNginxResult = await generateNginxConfig(newName, domain, port, true, useHttp2, maxBody20Mb);
        results.messages.push(httpsNginxResult.message);
        if (httpsNginxResult.path) results.nginxConfigPath = httpsNginxResult.path;
        results.messages.push("HTTPS Nginx config generated, Certbot not run automatically. Manual run needed for SSL.");
      }
    } else {
      results.messages.push("HTTP-only Nginx config generated.");
    }

    const nginxReload2 = await reloadNginx();
    results.messages.push(nginxReload2.message);
    if (!nginxReload2.success) {
      results.error = nginxReload2.error?.message || nginxReload2.message || "Final Nginx reload failed.";
      return results;
    }

    const pm2UpdateResult = await updatePm2EcosystemFile();
    results.messages.push(pm2UpdateResult.message);
    if (!pm2UpdateResult.success) {
      results.error = pm2UpdateResult.message || "PM2 ecosystem update failed.";
      return results;
    }

    const pm2ReloadResult = await reloadPm2();
    results.messages.push(pm2ReloadResult.message);
    if (!pm2ReloadResult.success) {
      results.error = pm2ReloadResult.message || "PM2 reload failed.";
      return results;
    }

    results.success = true;
    const finalProtocol = useHttps && certbotRanSuccessfully ? "https" : "http";
    results.instance.url = `${finalProtocol}://${domain}/_/`;
    results.messages.push(`Instance "${newName}" cloned and services reloaded. Access at ${results.instance.url}`);
  } catch (error) {
    results.messages.push(`Error during internal clone instance: ${error.message}`);
    results.error = error.message;
    if (completeLogging) console.error(error.stack);
  }
  return results;
}

async function _internalResetInstance(payload) {
  const { name, createAdmin = false, adminEmail, adminPassword } = payload;
  const results = { success: false, messages: [], error: null };

  try {
    const config = await getInstancesConfig();
    if (!config.instances[name]) {
      results.error = `Instance "${name}" not found.`;
      results.messages.push(results.error);
      return results;
    }

    const instance = config.instances[name];
    const dataDir = instance.dataDir;

    results.messages.push(`Stopping and deleting PM2 process for pb-${name}...`);
    try {
      runCommand(`pm2 stop pb-${name}`, `Stopping pb-${name}`, true);
      runCommand(`pm2 delete pb-${name}`, `Deleting pb-${name}`, true);
    } catch (e) {
      results.messages.push(`Warning: Could not stop/delete PM2 process pb-${name} (maybe not running/exists): ${e.message}`);
    }

    results.messages.push(`Deleting data directory ${dataDir}...`);
    if (await fs.pathExists(dataDir)) {
      try {
        await fs.remove(dataDir);
        results.messages.push(`Data directory ${dataDir} deleted.`);
      } catch (e) {
        results.error = `Failed to delete data directory: ${e.message}`;
        results.messages.push(results.error);
        return results;
      }
    }
    await fs.ensureDir(dataDir);
    results.messages.push(`Data directory ${dataDir} recreated.`);

    await updatePm2EcosystemFile();
    await reloadPm2();
    results.messages.push(`Instance "${name}" has been reset and PM2 reloaded.`);

    if (createAdmin) {
      if (!adminEmail || !adminPassword) {
        results.messages.push("Admin email and password required for admin creation during reset, but not provided. Skipping admin creation.");
      } else {
        const migrationsDir = path.join(dataDir, "pb_migrations");
        const adminCreateCommand = `${POCKETBASE_EXEC_PATH} superuser create "${adminEmail}" "${adminPassword}" --dir "${dataDir}" --migrationsDir "${migrationsDir}"`;
        results.messages.push(`Attempting to create superuser (admin) account: ${adminEmail}`);
        try {
          const adminResult = runCommand(adminCreateCommand, "Failed to create superuser (admin) account via CLI.");
          if (adminResult?.stdout?.includes("Successfully created new superuser")) {
            results.messages.push(adminResult.stdout.trim());
            results.messages.push(`Superuser (admin) account for ${adminEmail} created successfully!`);
          } else {
            results.messages.push(`Admin creation output: ${adminResult.stdout} ${adminResult.stderr}`);
          }
        } catch (e) {
          results.messages.push(`Superuser (admin) account creation via CLI failed: ${e.message}`);
        }
      }
    }

    results.messages.push(`Starting instance pb-${name}...`);
    runCommand(`pm2 start pb-${name}`, `Starting pb-${name}`, true);
    results.success = true;
    results.messages.push(`Instance "${name}" reset and started.`);
  } catch (error) {
    results.messages.push(`Error during internal reset instance: ${error.message}`);
    results.error = error.message;
    if (completeLogging) console.error(error.stack);
  }
  return results;
}

async function _internalResetAdminPassword(payload) {
  const { name, adminEmail, adminPassword } = payload;
  const results = { success: false, messages: [], error: null };

  try {
    const config = await getInstancesConfig();
    if (!config.instances[name]) {
      results.error = `Instance "${name}" not found.`;
      results.messages.push(results.error);
      return results;
    }
    if (!adminEmail || !adminPassword) {
      results.error = "Admin email and new password are required.";
      results.messages.push(results.error);
      return results;
    }

    const instance = config.instances[name];
    const dataDir = instance.dataDir;
    const adminUpdateCommand = `${POCKETBASE_EXEC_PATH} superuser update "${adminEmail}" "${adminPassword}" --dir "${dataDir}"`;

    results.messages.push(`Attempting to reset admin password for ${adminEmail} on instance ${name}...`);
    const result = runCommand(adminUpdateCommand, "Failed to reset superuser (admin) password via CLI.");
    if (result?.stdout?.includes("Successfully updated superuser")) {
      results.messages.push(result.stdout.trim());
      results.messages.push(`Superuser (admin) password for ${adminEmail} reset successfully!`);
      results.success = true;
    } else {
      results.error = "Admin password reset command did not confirm success.";
      results.messages.push(results.error);
      if (result.stdout) results.messages.push(`Stdout: ${result.stdout}`);
      if (result.stderr) results.messages.push(`Stderr: ${result.stderr}`);
    }
  } catch (error) {
    results.messages.push(`Error during internal admin password reset: ${error.message}`);
    results.error = error.message;
    if (completeLogging) console.error(error.stack);
  }
  return results;
}

async function _internalRenewCertificates(payload) {
  const { instanceName, force } = payload;
  const results = { success: false, messages: [], error: null };

  if (!shell.which("certbot")) {
    results.error = "Certbot command not found. Please install Certbot first.";
    results.messages.push(results.error);
    return results;
  }

  let commandToRun;
  let baseMessage;

  if (instanceName && instanceName.toLowerCase() !== "all") {
    const config = await getInstancesConfig();
    const instance = config.instances[instanceName];
    if (!instance || !instance.useHttps) {
      results.error = `Instance "${instanceName}" not found or does not use HTTPS.`;
      results.messages.push(results.error);
      return results;
    }
    commandToRun = `sudo certbot renew --cert-name ${instance.domain}`;
    baseMessage = `Attempted certificate renewal for ${instance.domain}.`;
  } else {
    commandToRun = "sudo certbot renew";
    baseMessage = "Attempted renewal for all managed certificates.";
  }

  if (force) {
    commandToRun += " --force-renewal";
  }

  try {
    results.messages.push(`Executing: ${commandToRun}`);
    runCommand(commandToRun, "Certbot renewal command failed.");
    results.messages.push(baseMessage);
    results.messages.push("Reloading Nginx to apply any changes...");
    const nginxReloadResult = await reloadNginx();
    results.messages.push(nginxReloadResult.message);
    if (!nginxReloadResult.success) {
      throw nginxReloadResult.error || new Error(nginxReloadResult.message);
    }
    results.success = true;
  } catch (error) {
    results.error = `Certificate renewal process failed: ${error.message}`;
    results.messages.push(results.error);
    results.messages.push("Check Certbot logs in /var/log/letsencrypt/ for more details.");
    if (completeLogging) console.error(error.stack);
  }
  return results;
}

async function _internalUpdatePocketBaseExecutable() {
  const results = { success: false, messages: [], error: null };
  try {
    if (!(await fs.pathExists(POCKETBASE_EXEC_PATH))) {
      results.error = "PocketBase executable not found. Run 'setup' or 'configure' first.";
      results.messages.push(results.error);
      return results;
    }

    results.messages.push(`Running: ${POCKETBASE_EXEC_PATH} update`);
    const updateResult = shell.exec(`${POCKETBASE_EXEC_PATH} update`, { cwd: POCKETBASE_BIN_DIR, silent: !completeLogging });

    if (updateResult.code !== 0) {
      results.error = "PocketBase update command failed.";
      results.messages.push(results.error);
      if (updateResult.stderr) results.messages.push(`Stderr: ${updateResult.stderr}`);
      return results;
    }
    results.messages.push("PocketBase executable update process finished.");
    if (updateResult.stdout) results.messages.push(`Stdout: ${updateResult.stdout}`);

    results.messages.push("Restarting all PocketBase instances via PM2...");
    const instancesConf = await getInstancesConfig();
    let allRestarted = true;
    for (const instName in instancesConf.instances) {
      try {
        runCommand(`pm2 restart pb-${instName}`);
        results.messages.push(`Instance pb-${instName} restarted.`);
      } catch (e) {
        results.messages.push(`Failed to restart instance pb-${instName}: ${e.message}`);
        allRestarted = false;
      }
    }
    if (allRestarted) {
      results.messages.push("All instances processed for restarting.");
    } else {
      results.messages.push("Some instances may not have restarted correctly. Check PM2 logs.");
    }
    results.success = true;
  } catch (error) {
    results.error = `Failed to run PocketBase update process: ${error.message}`;
    results.messages.push(results.error);
    if (completeLogging) console.error(error.stack);
  }
  return results;
}

async function _internalUpdateEcosystemAndReloadPm2() {
  try {
    await updatePm2EcosystemFile();
    const reloadResult = await reloadPm2();
    if (!reloadResult.success) {
      return { success: false, error: "Failed to reload PM2 after ecosystem update.", messages: ["PM2 ecosystem file updated, but PM2 reload failed.", reloadResult.message] };
    }
    return { success: true, messages: ["PM2 ecosystem file updated and PM2 reloaded successfully."] };
  } catch (error) {
    return { success: false, error: error.message, messages: [`Error updating ecosystem/reloading PM2: ${error.message}`] };
  }
}

async function _internalSetDefaultCertbotEmail(payload) {
  const { email } = payload;
  if (email !== null && typeof email !== "string" && email !== "") {
    return { success: false, error: "Invalid payload: 'email' must be a valid email string, empty string, or null.", messages: ["Invalid payload for setting Certbot email."] };
  }
  if (typeof email === "string" && email !== "" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { success: false, error: "Invalid payload: 'email' must be a valid email format.", messages: ["Invalid email format for Certbot email."] };
  }
  try {
    const cliConfig = await getCliConfig();
    cliConfig.defaultCertbotEmail = email || null;
    await saveCliConfig(cliConfig);
    return { success: true, messages: [`Default Certbot email set to ${cliConfig.defaultCertbotEmail || "not set"}.`] };
  } catch (error) {
    return { success: false, error: error.message, messages: [`Error setting default Certbot email: ${error.message}`] };
  }
}

program
  .command("dashboard")
  .description("Show interactive dashboard for all PocketBase instances")
  .action(async () => {
    await showDashboard();
  });

program
  .command("configure")
  .description("Set or view CLI configurations (e.g., default Certbot email, PocketBase version, API settings).")
  .action(async () => {
    await ensureBaseSetup();

    const cliConfig = await getCliConfig();

    const choices = [
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
      new inquirer.Separator("API Settings"),
      {
        name: `Enable API Communication: ${cliConfig.api.enabled ? chalk.green("Yes") : chalk.red("No")}`,
        value: "setApiEnabled",
      },
      {
        name: `API Internal Secret: ${cliConfig.api.secret ? `${cliConfig.api.secret.substring(0, 8)}...` : "Not Set"}`,
        value: "setApiSecret",
      },
      new inquirer.Separator(),
      { name: "View current JSON config", value: "viewConfig" },
      { name: "Exit", value: "exit" },
    ];

    const { action } = await inquirer.prompt([{ type: "list", name: "action", message: "CLI Configuration:", choices }]);

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

        completeLogging = enableLogging;

        console.log(chalk.green(`Complete logging is now ${enableLogging ? "enabled" : "disabled"}.`));

        break;
      }
      case "setApiEnabled": {
        const { apiEnabled } = await inquirer.prompt([
          {
            type: "confirm",
            name: "apiEnabled",
            message: "Enable API communication mode (allows external API server to call internal functions)?",
            default: cliConfig.api.enabled,
          },
        ]);

        cliConfig.api.enabled = apiEnabled;

        console.log(chalk.green(`API communication mode is now ${apiEnabled ? "enabled" : "disabled"}.`));

        break;
      }
      case "setApiSecret": {
        const { newSecret } = await inquirer.prompt([
          {
            type: "password",
            mask: "*",
            name: "newSecret",
            message: "Enter new API internal secret (min 16 chars, leave blank to generate):",
            validate: (input) => input === "" || input.length >= 16 || "Secret must be at least 16 characters or blank to auto-generate.",
          },
        ]);

        if (newSecret) {
          cliConfig.api.secret = newSecret;
        } else {
          cliConfig.api.secret = `pbmanager-internal-secret-${Date.now().toString(36)}${Math.random().toString(36).substring(2)}`;

          console.log(chalk.blue("New API internal secret generated."));
        }

        console.log(chalk.green("API internal secret updated."));

        break;
      }
      case "viewConfig":
        console.log(chalk.cyan("Current CLI Configuration:"));
        console.log(JSON.stringify(cliConfig, null, 2));

        return;
      case "exit":
        console.log(chalk.blue("Exiting configuration."));

        return;
    }

    await saveCliConfig(cliConfig);

    if (action !== "setLogging" && action !== "viewConfig" && action !== "exit") {
      console.log(chalk.green("Configuration updated."));
    }
  });

program
  .command("setup")
  .description("Initial setup: creates directories and downloads PocketBase.")
  .option("-v, --version <version>", "Specify PocketBase version to download for setup")
  .action(async (options) => {
    console.log(chalk.bold.cyan("Starting PocketBase Manager Setup..."));

    await ensureBaseSetup();

    const dlResult = await downloadPocketBaseIfNotExists(options.version);
    if (dlResult && dlResult.success === false) {
      console.error(chalk.red(`PocketBase download failed: ${dlResult.message}`));
    } else {
      console.log(chalk.bold.green("Setup complete!"));
      console.log(chalk.blue("You can now add your first PocketBase instance using: sudo pb-manager add"));
    }
  });

program
  .command("add")
  .alias("create")
  .description("Add a new PocketBase instance")
  .action(async () => {
    const cliConfig = await getCliConfig();

    await ensureBaseSetup();

    if (!(await fs.pathExists(POCKETBASE_EXEC_PATH))) {
      if (completeLogging) {
        console.log(chalk.yellow("PocketBase executable not found. Running setup..."));
      }

      const dlResult = await downloadPocketBaseIfNotExists();
      if (dlResult && dlResult.success === false) {
        console.error(chalk.red(`PocketBase download failed: ${dlResult.message}. Cannot add instance.`));

        return;
      }

      if (!(await fs.pathExists(POCKETBASE_EXEC_PATH))) {
        console.error(chalk.red("PocketBase download failed after attempt. Cannot add instance."));

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
      const dnsValid = await validateDnsRecords(initialAnswers.domain);
      if (!dnsValid) {
        const { proceedAnyway } = await inquirer.prompt([
          {
            type: "confirm",
            name: "proceedAnyway",
            message: chalk.yellow(`DNS validation failed for ${initialAnswers.domain}. Certbot will likely fail. Do you want to proceed with the setup (you might need to fix DNS and run Certbot manually later, or use HTTP only)?`),
            default: false,
          },
        ]);

        if (!proceedAnyway) {
          console.log(chalk.yellow("Instance setup aborted by user due to DNS issues."));

          return;
        }

        console.log(chalk.yellow("Proceeding with setup despite DNS validation issues. HTTPS/Certbot might fail."));
      }

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
          console.log(chalk.yellow("Certbot failed. Reverting Nginx to HTTP-only for now."));

          await generateNginxConfig(nginxConfigParams.instanceName, nginxConfigParams.domain, nginxConfigParams.port, false, nginxConfigParams.useHttp2, nginxConfigParams.maxBody20Mb);
        }
      } else {
        await generateNginxConfig(nginxConfigParams.instanceName, nginxConfigParams.domain, nginxConfigParams.port, true, nginxConfigParams.useHttp2, nginxConfigParams.maxBody20Mb);

        console.log(chalk.yellow(`HTTPS Nginx config generated, but Certbot was not run automatically. To obtain a certificate, you can try running: sudo certbot --nginx -d ${initialAnswers.domain} -m ${emailToUseForCertbot}`));
      }
    } else {
      await generateNginxConfig(nginxConfigParams.instanceName, nginxConfigParams.domain, nginxConfigParams.port, false, nginxConfigParams.useHttp2, nginxConfigParams.maxBody20Mb);
    }

    const { confirmReloadServices } = await inquirer.prompt([
      {
        type: "confirm",
        name: "confirmReloadServices",
        message: "Nginx configuration has been updated. Do you want to reload Nginx and PM2 services now to apply changes and start the instance?",
        default: true,
      },
    ]);

    if (confirmReloadServices) {
      await reloadNginx();
      await updatePm2EcosystemFile();
      await reloadPm2();
    } else {
      console.log(chalk.yellow("Skipped Nginx/PM2 reload. Please do it manually to start the instance and apply Nginx changes."));
      console.log(chalk.yellow("You may need to run: sudo pb-manager update-ecosystem && sudo nginx -s reload"));
    }

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

      const migrationsDir = path.join(instanceDataDir, "pb_migrations");
      const adminCreateCommand = `${POCKETBASE_EXEC_PATH} superuser create "${adminCredentials.adminEmail}" "${adminCredentials.adminPassword}" --dir "${instanceDataDir}" --migrationsDir "${migrationsDir}"`;

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

    console.log(chalk.bold.green(`\nInstance "${initialAnswers.name}" added${confirmReloadServices ? " and started" : ""}!`));

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
      console.log(chalk.red(`Try: sudo certbot --nginx -d ${initialAnswers.domain} -m ${emailToUseForCertbot}`));
    }

    console.log(chalk.yellow("\nOnce logged in, you can manage your collections and settings."));
  });

program
  .command("clone <sourceName> <newName>")
  .description("Clone an existing PocketBase instance's data and configuration to a new instance.")
  .action(async (sourceName, newName) => {
    const cliConfig = await getCliConfig();

    await ensureBaseSetup();

    if (!(await fs.pathExists(POCKETBASE_EXEC_PATH))) {
      console.log(chalk.yellow("PocketBase executable not found. Running initial setup..."));

      await downloadPocketBaseIfNotExists();

      if (!(await fs.pathExists(POCKETBASE_EXEC_PATH))) {
        console.error(chalk.red("PocketBase download failed. Cannot clone instance."));

        return;
      }
    }

    const config = await getInstancesConfig();
    const sourceInstance = config.instances[sourceName];

    if (!sourceInstance) {
      console.error(chalk.red(`Source instance "${sourceName}" not found.`));

      return;
    }

    if (config.instances[newName]) {
      console.error(chalk.red(`Target instance "${newName}" already exists.`));

      return;
    }

    console.log(chalk.blue(`Cloning instance "${sourceName}" to "${newName}"...`));

    const cloneAnswers = await inquirer.prompt([
      {
        type: "input",
        name: "domain",
        message: `Domain/subdomain for new instance "${newName}":`,
        default: `cloned-${sourceInstance.domain}`,
        validate: (input) => (input.length > 0 ? true : "Domain cannot be empty."),
      },
      {
        type: "number",
        name: "port",
        message: `Internal port for new instance "${newName}":`,
        default: sourceInstance.port + 1,
        validate: (input) => (Number.isInteger(input) && input > 1024 && input < 65535 ? true : "Invalid port."),
      },
      {
        type: "confirm",
        name: "useHttp2",
        message: "Enable HTTP/2 in Nginx config for new instance?",
        default: sourceInstance.useHttp2,
      },
      {
        type: "confirm",
        name: "maxBody20Mb",
        message: "Set 20Mb max body size in Nginx config for new instance?",
        default: sourceInstance.maxBody20Mb,
      },
    ]);

    for (const instName in config.instances) {
      if (config.instances[instName].port === cloneAnswers.port) {
        console.error(chalk.red(`Port ${cloneAnswers.port} is already in use by another managed instance.`));

        return;
      }

      if (config.instances[instName].domain === cloneAnswers.domain) {
        console.error(chalk.red(`Domain ${cloneAnswers.domain} is already in use by another managed instance.`));

        return;
      }
    }

    let emailToUseForCertbot = cliConfig.defaultCertbotEmail;

    const httpsAnswers = await inquirer.prompt([
      {
        type: "confirm",
        name: "useHttps",
        message: `Configure HTTPS (Certbot) for "${newName}"?`,
        default: sourceInstance.useHttps,
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
        default: (answers) => (!cliConfig.defaultCertbotEmail || !answers.useDefaultEmail ? sourceInstance.emailForCertbot : cliConfig.defaultCertbotEmail),
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
      const dnsValid = await validateDnsRecords(cloneAnswers.domain);
      if (!dnsValid) {
        const { proceedAnyway } = await inquirer.prompt([
          {
            type: "confirm",
            name: "proceedAnyway",
            message: chalk.yellow(`DNS validation failed for ${cloneAnswers.domain}. Certbot will likely fail. Do you want to proceed with cloning (you might need to fix DNS and run Certbot manually later, or use HTTP only)?`),
            default: false,
          },
        ]);

        if (!proceedAnyway) {
          console.log(chalk.yellow("Instance cloning aborted by user due to DNS issues."));

          return;
        }

        console.log(chalk.yellow("Proceeding with cloning despite DNS validation issues. HTTPS/Certbot might fail."));
      }

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

    const newInstanceDataDir = path.join(INSTANCES_DATA_BASE_DIR, newName);

    await fs.ensureDir(path.dirname(newInstanceDataDir));

    console.log(chalk.blue(`Copying data from ${sourceInstance.dataDir} to ${newInstanceDataDir}...`));

    try {
      await fs.copy(sourceInstance.dataDir, newInstanceDataDir);

      console.log(chalk.green("Data copied successfully."));
    } catch (err) {
      console.error(chalk.red(`Error copying data: ${err.message}`));

      return;
    }

    config.instances[newName] = {
      name: newName,
      domain: cloneAnswers.domain,
      port: cloneAnswers.port,
      dataDir: newInstanceDataDir,
      useHttps: httpsAnswers.useHttps,
      emailForCertbot: httpsAnswers.useHttps ? emailToUseForCertbot : null,
      useHttp2: cloneAnswers.useHttp2,
      maxBody20Mb: cloneAnswers.maxBody20Mb,
    };

    await saveInstancesConfig(config);

    console.log(chalk.green(`Instance "${newName}" configuration saved.`));

    let certbotSuccess = false;

    const nginxConfigParams = {
      instanceName: newName,
      domain: cloneAnswers.domain,
      port: cloneAnswers.port,
      useHttp2: cloneAnswers.useHttp2,
      maxBody20Mb: cloneAnswers.maxBody20Mb,
    };

    if (httpsAnswers.useHttps) {
      await ensureDhParamExists();

      if (httpsAnswers.autoRunCertbot) {
        await generateNginxConfig(nginxConfigParams.instanceName, nginxConfigParams.domain, nginxConfigParams.port, false, false, nginxConfigParams.maxBody20Mb);
        await reloadNginx();

        certbotSuccess = await runCertbot(cloneAnswers.domain, emailToUseForCertbot);
        if (certbotSuccess) {
          await generateNginxConfig(nginxConfigParams.instanceName, nginxConfigParams.domain, nginxConfigParams.port, true, nginxConfigParams.useHttp2, nginxConfigParams.maxBody20Mb);
        } else {
          console.log(chalk.yellow("Certbot failed for cloned instance. Reverting Nginx to HTTP-only for now."));

          await generateNginxConfig(nginxConfigParams.instanceName, nginxConfigParams.domain, nginxConfigParams.port, false, nginxConfigParams.useHttp2, nginxConfigParams.maxBody20Mb);
        }
      } else {
        await generateNginxConfig(nginxConfigParams.instanceName, nginxConfigParams.domain, nginxConfigParams.port, true, nginxConfigParams.useHttp2, nginxConfigParams.maxBody20Mb);

        console.log(chalk.yellow(`HTTPS Nginx config generated for cloned instance, but Certbot was not run. Run: sudo certbot --nginx -d ${cloneAnswers.domain} -m ${emailToUseForCertbot}`));
      }
    } else {
      await generateNginxConfig(nginxConfigParams.instanceName, nginxConfigParams.domain, nginxConfigParams.port, false, nginxConfigParams.useHttp2, nginxConfigParams.maxBody20Mb);
    }

    const { confirmReloadServicesClone } = await inquirer.prompt([
      {
        type: "confirm",
        name: "confirmReloadServicesClone",
        message: "Nginx configuration for the cloned instance has been updated. Do you want to reload Nginx and PM2 services now to apply changes and start the new instance?",
        default: true,
      },
    ]);

    if (confirmReloadServicesClone) {
      await reloadNginx();
      await updatePm2EcosystemFile();
      await reloadPm2();
    } else {
      console.log(chalk.yellow("Skipped Nginx/PM2 reload for cloned instance. Please do it manually."));
    }

    let adminCreatedViaCli = false;

    const { createAdminCli } = await inquirer.prompt([
      {
        type: "confirm",
        name: "createAdminCli",
        message: `Data has been cloned. Do you want to create an *additional* superuser (admin) account for "${newName}" via CLI now? (Existing admins from "${sourceName}" are already cloned)`,
        default: false,
      },
    ]);

    if (createAdminCli) {
      const adminCredentials = await inquirer.prompt([
        {
          type: "input",
          name: "adminEmail",
          message: "Enter new admin email:",
          validate: (input) => (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input) ? true : "Please enter a valid email."),
        },
        {
          type: "password",
          name: "adminPassword",
          message: "Enter new admin password (min 8 chars):",
          mask: "*",
          validate: (input) => (input.length >= 8 ? true : "Password must be at least 8 characters."),
        },
      ]);

      const migrationsDir = path.join(newInstanceDataDir, "pb_migrations");
      const adminCreateCommand = `${POCKETBASE_EXEC_PATH} superuser create "${adminCredentials.adminEmail}" "${adminCredentials.adminPassword}" --dir "${newInstanceDataDir}" --migrationsDir "${migrationsDir}"`;

      if (completeLogging) {
        console.log(chalk.blue("\nAttempting to create superuser (admin) account via CLI..."));
        console.log(chalk.yellow(`Executing: ${adminCreateCommand}`));
      }

      try {
        const result = runCommand(adminCreateCommand, "Failed to create superuser (admin) account via CLI.");
        if (result?.stdout?.includes("Successfully created new superuser")) {
          console.log(result.stdout.trim());
        }

        console.log(chalk.green(`Superuser (admin) account for ${adminCredentials.adminEmail} created successfully for "${newName}"!`));

        adminCreatedViaCli = true;
      } catch (e) {
        console.error(chalk.red(`Superuser (admin) account creation for "${newName}" via CLI failed. The user might already exist in the cloned data, or another error occurred.`));
      }
    }

    console.log(chalk.bold.green(`\nInstance "${newName}" cloned${confirmReloadServicesClone ? " and started" : ""}!`));

    const protocol = httpsAnswers.useHttps && certbotSuccess ? "https" : "http";
    const publicBaseUrl = `${protocol}://${cloneAnswers.domain}`;
    const localAdminUrl = `http://127.0.0.1:${cloneAnswers.port}/_/`;

    console.log(chalk.blue("\nNew Cloned Instance Details:"));
    console.log(chalk.blue(`  Public URL: ${publicBaseUrl}/_/`));
    console.log(chalk.yellow("Remember that all data, including users and admins, has been cloned from the source instance."));

    if (!adminCreatedViaCli && !createAdminCli) {
      console.log(chalk.yellow(`You can access the admin panel for "${newName}" using existing credentials from "${sourceName}" or create/reset admins via the UI or 'pb-manager reset-admin ${newName}'.`));
    }

    console.log(chalk.yellow(`   - Public Admin: ${publicBaseUrl}/_/`));
    console.log(chalk.yellow(`   - Local Admin (direct access): ${localAdminUrl}`));

    if (httpsAnswers.useHttps && !certbotSuccess && httpsAnswers.autoRunCertbot) {
      console.log(chalk.red(`\nCertbot failed for "${newName}". The instance might only be available via HTTP.`));
      console.log(chalk.red(`Try: sudo certbot --nginx -d ${cloneAnswers.domain} -m ${emailToUseForCertbot}`));
    }
  });

program
  .command("update-pocketbase")
  .description("Updates the PocketBase executable using 'pocketbase update' and restarts all instances.")
  .action(async () => {
    console.log(chalk.bold.cyan("Attempting to update PocketBase executable..."));

    if (!(await fs.pathExists(POCKETBASE_EXEC_PATH))) {
      console.error(chalk.red("PocketBase executable not found. Run 'setup' or 'configure' to set a version and download."));

      return;
    }

    const { confirmUpdate } = await inquirer.prompt([
      {
        type: "confirm",
        name: "confirmUpdate",
        message: `This will run '${POCKETBASE_EXEC_PATH} update' to fetch the latest PocketBase binary and then restart ALL managed instances. Do you want to proceed?`,
        default: true,
      },
    ]);

    if (!confirmUpdate) {
      console.log(chalk.yellow("PocketBase update cancelled by user."));

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
    const config = await getInstancesConfig();
    if (!config.instances[name]) {
      console.error(chalk.red(`Instance "${name}" not found.`));

      return;
    }

    const { confirm } = await inquirer.prompt([
      {
        type: "confirm",
        name: "confirm",
        message: `Are you sure you want to remove instance "${name}"? This will stop it, remove its PM2 entry, and Nginx config. Data directory will NOT be deleted automatically by this step.`,
        default: false,
      },
    ]);

    if (!confirm) {
      console.log(chalk.yellow("Removal cancelled."));
      return;
    }

    const { confirmTyped } = await inquirer.prompt([
      {
        type: "input",
        name: "confirmTyped",
        message: `To confirm removal of instance "${name}", please type its name again:`,
      },
    ]);

    if (confirmTyped !== name) {
      console.log(chalk.yellow("Instance name did not match. Removal cancelled."));

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

    const nginxConfPathBase = NGINX_DISTRO_MODE === "rhel" ? `${name}.conf` : name;
    const nginxConfPath = path.join(NGINX_SITES_AVAILABLE, nginxConfPathBase);
    const nginxEnabledPath = NGINX_DISTRO_MODE === "rhel" ? nginxConfPath : path.join(NGINX_SITES_ENABLED, name);

    if (completeLogging) {
      console.log(chalk.blue(`Removing Nginx config for ${name}...`));
    }

    if (NGINX_DISTRO_MODE !== "rhel" && (await fs.pathExists(nginxEnabledPath))) {
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

    const instanceDataDir = config.instances[name].dataDir;

    delete config.instances[name];

    await saveInstancesConfig(config);

    console.log(chalk.green(`Instance "${name}" removed from configuration.`));

    await updatePm2EcosystemFile();

    try {
      runCommand("pm2 save");
    } catch (e) {}

    await reloadNginx();

    console.log(chalk.bold.green(`Instance "${name}" removed.`));
    console.log(chalk.yellow(`Data directory at ${instanceDataDir} was NOT deleted.`));

    const { confirmDeleteData } = await inquirer.prompt([
      {
        type: "confirm",
        name: "confirmDeleteData",
        message: `Do you want to permanently delete the data directory ${instanceDataDir} for the removed instance "${name}"? ${chalk.bold.red("THIS CANNOT BE UNDONE.")}`,
        default: false,
      },
    ]);

    if (confirmDeleteData) {
      const { confirmTypedDeleteData } = await inquirer.prompt([
        {
          type: "input",
          name: "confirmTypedDeleteData",
          message: `To confirm PERMANENT DELETION of data for "${name}", type the instance name again:`,
        },
      ]);

      if (confirmTypedDeleteData === name) {
        try {
          await fs.remove(instanceDataDir);

          console.log(chalk.green(`Data directory ${instanceDataDir} deleted successfully.`));
        } catch (err) {
          console.error(chalk.red(`Failed to delete data directory ${instanceDataDir}: ${err.message}`));
          console.log(chalk.yellow(`You may need to remove it manually: sudo rm -rf ${instanceDataDir}`));
        }
      } else {
        console.log(chalk.yellow("Instance name did not match. Data directory NOT deleted."));
      }
    }
  });

program
  .command("list")
  .description("List all managed PocketBase instances")
  .option("--json", "Output in JSON format")
  .action(async (options) => {
    const instancesList = await _internalListInstances();
    if (instancesList.length === 0) {
      if (options.json) {
        console.log(JSON.stringify([], null, 2));
      } else {
        console.log(chalk.yellow("No instances configured yet. Use 'pb-manager add'."));
      }

      return;
    }

    if (options.json) {
      console.log(JSON.stringify(instancesList, null, 2));
      return;
    }

    console.log(chalk.bold.cyan("Managed PocketBase Instances:"));

    for (const inst of instancesList) {
      console.log(`
        ${chalk.bold(inst.name)}:
          Domain: ${chalk.green(inst.domain)} (${inst.protocol})
          Public URL: ${chalk.green(inst.publicUrl)}
          Internal Port: ${chalk.yellow(inst.internalPort)}
          Data Directory: ${inst.dataDirectory}
          PM2 Status: ${inst.pm2Status === "online" ? chalk.green(inst.pm2Status) : chalk.red(inst.pm2Status)}
          Admin URL (local): ${inst.adminURL}
          Certificate expires in: ${inst.certExpiryDays} day(s)
      `);
    }
  });

program
  .command("start [name]")
  .description("Start a specific PocketBase instance or all instances via PM2")
  .action(async (name) => {
    if (name && name.toLowerCase() === "all") {
      const config = await getInstancesConfig();
      const instanceNames = Object.keys(config.instances);
      if (instanceNames.length === 0) {
        console.log(chalk.yellow("No instances configured to start."));
        return;
      }
      console.log(chalk.blue("Starting all managed instances..."));
      let allProcessedSuccessfully = true;
      for (const instanceName of instanceNames) {
        try {
          runCommand(`pm2 start pb-${instanceName}`);
          console.log(chalk.green(`Instance pb-${instanceName} started.`));
        } catch (e) {
          console.error(chalk.red(`Failed to start instance pb-${instanceName}.`));
          allProcessedSuccessfully = false;
        }
      }
      if (allProcessedSuccessfully) {
        console.log(chalk.bold.green("All instances processed for starting."));
      } else {
        console.log(chalk.bold.yellow("Some instances may not have started correctly. Check PM2 logs."));
      }
    } else if (name) {
      try {
        runCommand(`pm2 start pb-${name}`);
        console.log(chalk.green(`Instance pb-${name} started.`));
      } catch (e) {
        console.error(chalk.red(`Failed to start instance pb-${name}. Is it configured?`));
      }
    } else {
      console.log(chalk.yellow("Please specify an instance name or 'all'. Usage: pb-manager start <name|all>"));
    }
  });

program
  .command("stop [name]")
  .description("Stop a specific PocketBase instance or all instances via PM2")
  .action(async (name) => {
    if (name && name.toLowerCase() === "all") {
      const config = await getInstancesConfig();
      const instanceNames = Object.keys(config.instances);
      if (instanceNames.length === 0) {
        console.log(chalk.yellow("No instances configured to stop."));
        return;
      }
      console.log(chalk.blue("Stopping all managed instances..."));
      let allProcessedSuccessfully = true;
      for (const instanceName of instanceNames) {
        try {
          runCommand(`pm2 stop pb-${instanceName}`);
          console.log(chalk.green(`Instance pb-${instanceName} stopped.`));
        } catch (e) {
          console.error(chalk.red(`Failed to stop instance pb-${instanceName}.`));
          allProcessedSuccessfully = false;
        }
      }
      if (allProcessedSuccessfully) {
        console.log(chalk.bold.green("All instances processed for stopping."));
      } else {
        console.log(chalk.bold.yellow("Some instances may not have stopped correctly. Check PM2 logs."));
      }
    } else if (name) {
      try {
        runCommand(`pm2 stop pb-${name}`);
        console.log(chalk.green(`Instance pb-${name} stopped.`));
      } catch (e) {
        console.error(chalk.red(`Failed to stop instance pb-${name}.`));
      }
    } else {
      console.log(chalk.yellow("Please specify an instance name or 'all'. Usage: pb-manager stop <name|all>"));
    }
  });

program
  .command("restart [name]")
  .description("Restart a specific PocketBase instance or all instances via PM2")
  .action(async (name) => {
    if (name && name.toLowerCase() === "all") {
      const config = await getInstancesConfig();
      const instanceNames = Object.keys(config.instances);
      if (instanceNames.length === 0) {
        console.log(chalk.yellow("No instances configured to restart."));
        return;
      }
      console.log(chalk.blue("Restarting all managed instances..."));
      let allProcessedSuccessfully = true;
      for (const instanceName of instanceNames) {
        try {
          runCommand(`pm2 restart pb-${instanceName}`);
          console.log(chalk.green(`Instance pb-${instanceName} restarted.`));
        } catch (e) {
          console.error(chalk.red(`Failed to restart instance pb-${instanceName}.`));
          allProcessedSuccessfully = false;
        }
      }
      if (allProcessedSuccessfully) {
        console.log(chalk.bold.green("All instances processed for restarting."));
      } else {
        console.log(chalk.bold.yellow("Some instances may not have restarted correctly. Check PM2 logs."));
      }
    } else if (name) {
      try {
        runCommand(`pm2 restart pb-${name}`);
        console.log(chalk.green(`Instance pb-${name} restarted.`));
      } catch (e) {
        console.error(chalk.red(`Failed to restart instance pb-${name}.`));
      }
    } else {
      console.log(chalk.yellow("Please specify an instance name or 'all'. Usage: pb-manager restart <name|all>"));
    }
  });

program
  .command("logs <name>")
  .description("Show logs for a specific PocketBase instance from PM2")
  .action((name) => {
    console.log(chalk.blue(`Displaying logs for pb-${name}. Press Ctrl+C to exit.`));

    shell.exec(`pm2 logs pb-${name} --lines 50`);
  });

program
  .command("audit")
  .description("Show the audit log of commands executed by this CLI")
  .action(async () => {
    const auditLogPath = path.join(CONFIG_DIR, "audit.log");
    if (await fs.pathExists(auditLogPath)) {
      const auditLog = await fs.readFile(auditLogPath, "utf-8");

      console.log(chalk.blue("Displaying audit log for this CLI:"));
      console.log(auditLog);
    } else {
      console.log(chalk.yellow("No audit log found. The log will be created as you use commands."));
    }
  });

program
  .command("update-ecosystem")
  .description("Regenerate the PM2 ecosystem file and reload PM2")
  .action(async () => {
    await updatePm2EcosystemFile();
    await reloadPm2();

    console.log(chalk.green("PM2 ecosystem file updated and PM2 reloaded."));
  });

program
  .command("reset <name>")
  .description("Reset a PocketBase instance (delete all data and optionally create a new admin account)")
  .action(async (name) => {
    const config = await getInstancesConfig();
    if (!config.instances[name]) {
      console.error(chalk.red(`Instance "${name}" not found.`));
      return;
    }

    const instance = config.instances[name];
    const dataDir = instance.dataDir;

    const { confirm } = await inquirer.prompt([
      {
        type: "confirm",
        name: "confirm",
        message: `Are you sure you want to reset instance "${name}"? This will ${chalk.red.bold("DELETE ALL DATA")} in ${dataDir} and start from zero. This action cannot be undone.`,
        default: false,
      },
    ]);

    if (!confirm) {
      console.log(chalk.yellow("Reset cancelled."));

      return;
    }

    const { confirmTyped } = await inquirer.prompt([
      {
        type: "input",
        name: "confirmTyped",
        message: `To confirm PERMANENT DELETION of all data for instance "${name}", please type its name again:`,
      },
    ]);

    if (confirmTyped !== name) {
      console.log(chalk.yellow("Instance name did not match. Reset cancelled."));

      return;
    }

    try {
      runCommand(`pm2 stop pb-${name}`, `Stopping pb-${name}`, true);
      runCommand(`pm2 delete pb-${name}`, `Deleting pb-${name}`, true);
    } catch (e) {}

    if (await fs.pathExists(dataDir)) {
      try {
        await fs.remove(dataDir);
        console.log(chalk.green(`Data directory ${dataDir} deleted.`));
      } catch (e) {
        console.error(chalk.red(`Failed to delete data directory: ${e.message}`));
        return;
      }
    }

    await fs.ensureDir(dataDir);

    await updatePm2EcosystemFile();
    await reloadPm2();

    console.log(chalk.green(`Instance "${name}" has been reset. Data directory is now empty.`));

    const { createAdminCli } = await inquirer.prompt([
      {
        type: "confirm",
        name: "createAdminCli",
        message: "Do you want to create a new superuser (admin) account for this reset instance via CLI now?",
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

      const migrationsDir = path.join(dataDir, "pb_migrations");
      const adminCreateCommand = `${POCKETBASE_EXEC_PATH} superuser create "${adminCredentials.adminEmail}" "${adminCredentials.adminPassword}" --dir "${dataDir}" --migrationsDir "${migrationsDir}"`;

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
      } catch (e) {
        console.error(chalk.red("Superuser (admin) account creation via CLI failed. Please try creating it via the web UI."));
      }
    }

    runCommand(`pm2 start pb-${name}`, `Starting pb-${name}`, true);

    console.log(chalk.bold.green(`Instance "${name}" reset and started.`));
  });

program
  .command("reset-admin <name>")
  .description("Reset the admin password for a PocketBase instance")
  .action(async (name) => {
    const config = await getInstancesConfig();
    if (!config.instances[name]) {
      console.error(chalk.red(`Instance "${name}" not found.`));
      return;
    }

    const instance = config.instances[name];
    const dataDir = instance.dataDir;

    const adminCredentials = await inquirer.prompt([
      {
        type: "input",
        name: "adminEmail",
        message: "Enter admin email to reset:",
        validate: (input) => (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input) ? true : "Please enter a valid email."),
      },
      {
        type: "password",
        name: "adminPassword",
        message: "Enter new admin password (min 8 chars):",
        mask: "*",
        validate: (input) => (input.length >= 8 ? true : "Password must be at least 8 characters."),
      },
    ]);

    const adminUpdateCommand = `${POCKETBASE_EXEC_PATH} superuser update "${adminCredentials.adminEmail}" "${adminCredentials.adminPassword}" --dir "${dataDir}"`;

    if (completeLogging) {
      console.log(chalk.blue("\nAttempting to reset superuser (admin) password via CLI..."));
      console.log(chalk.yellow(`Executing: ${adminUpdateCommand}`));
    }

    try {
      const result = runCommand(adminUpdateCommand, "Failed to reset superuser (admin) password via CLI.");

      if (result?.stdout?.includes("Successfully updated superuser")) {
        console.log(result.stdout.trim());
      }

      console.log(chalk.green(`Superuser (admin) password for ${adminCredentials.adminEmail} reset successfully!`));
    } catch (e) {
      console.error(chalk.red("Superuser (admin) password reset via CLI failed. The user may not exist or another error occurred."));
    }
  });

program
  .command("renew-certificates [instanceName]")
  .description("Renew SSL certificates using Certbot. Renews all due certs, or a specific instance's cert.")
  .option("-f, --force", "Force renewal even if the certificate is not yet due for expiry.")
  .action(async (instanceName, options) => {
    if (!shell.which("certbot")) {
      console.error(chalk.red("Certbot command not found. Please install Certbot first."));

      return;
    }

    let commandToRun;
    let successMessage;

    const targetInstanceName = instanceName && instanceName.toLowerCase() !== "all" ? instanceName : null;

    if (targetInstanceName) {
      const config = await getInstancesConfig();

      const instance = config.instances[targetInstanceName];
      if (!instance || !instance.useHttps) {
        console.error(chalk.red(`Instance "${targetInstanceName}" not found or does not use HTTPS.`));

        return;
      }

      const domain = instance.domain;

      commandToRun = `sudo certbot renew --cert-name ${domain}`;

      if (options.force) {
        commandToRun += " --force-renewal";
      }

      successMessage = `Attempted certificate renewal for ${domain}.`;
    } else {
      commandToRun = "sudo certbot renew";

      if (options.force) {
        commandToRun += " --force-renewal";
      }

      successMessage = "Attempted renewal for all managed certificates.";
    }

    const { confirmRenew } = await inquirer.prompt([
      {
        type: "confirm",
        name: "confirmRenew",
        message: `This will run Certbot to renew certificates. Command: ${commandToRun}. Proceed?`,
        default: true,
      },
    ]);

    if (!confirmRenew) {
      console.log(chalk.yellow("Certificate renewal cancelled by user."));

      return;
    }

    try {
      console.log(chalk.blue(`Executing: ${commandToRun}`));

      runCommand(commandToRun, "Certbot renewal command failed.");

      console.log(chalk.green(successMessage));
      console.log(chalk.blue("Reloading Nginx to apply any changes..."));

      await reloadNginx();
    } catch (error) {
      console.error(chalk.red(`Certificate renewal process failed: ${error.message}`));
      console.log(chalk.yellow("Check Certbot logs in /var/log/letsencrypt/ for more details."));
    }
  });

program
  .command("update-pb-manager")
  .description("Update pb-manager itself from the latest version on GitHub")
  .action(async () => {
    const GITHUB_USER = "devAlphaSystem";
    const GITHUB_REPO = "Alpha-System-PBManager";
    const GITHUB_BRANCH = "main";
    const SCRIPT_URL = `https://raw.githubusercontent.com/${GITHUB_USER}/${GITHUB_REPO}/${GITHUB_BRANCH}/pb-manager.js`;

    let installPath = process.argv[1];
    if (!installPath || !installPath.endsWith("pb-manager.js")) {
      installPath = "/opt/pb-manager/pb-manager.js";
    }

    console.log(chalk.cyan(`Attempting to update pb-manager from ${SCRIPT_URL}`));

    const { confirmUpdateSelf } = await inquirer.prompt([
      {
        type: "confirm",
        name: "confirmUpdateSelf",
        message: `This will download the latest version of pb-manager from GitHub and overwrite the current script at ${installPath}. Are you sure you want to proceed?`,
        default: true,
      },
    ]);

    if (!confirmUpdateSelf) {
      console.log(chalk.yellow("pb-manager update cancelled by user."));

      return;
    }

    try {
      const response = await axios.get(SCRIPT_URL, { responseType: "text" });
      await fs.writeFile(installPath, response.data, { mode: 0o755 });

      console.log(chalk.green(`pb-manager.js updated at ${installPath}`));
    } catch (e) {
      console.error(chalk.red("Failed to download or write pb-manager.js:"), e.message);

      process.exit(1);
    }

    const { reinstall } = await inquirer.prompt([
      {
        type: "confirm",
        name: "reinstall",
        message: "Do you want to reinstall Node.js dependencies (npm install) in the install directory? This is recommended if the update included dependency changes.",
        default: true,
      },
    ]);

    if (reinstall) {
      try {
        const installDir = path.dirname(installPath);

        console.log(chalk.cyan("Running npm install..."));

        runCommand("npm install", "Failed to install dependencies", false, { cwd: installDir });

        console.log(chalk.green("Dependencies installed."));
      } catch (e) {
        console.error(chalk.red("Failed to install dependencies:"), e.message);
      }
    }

    console.log(chalk.bold.green("pb-manager has been updated. Please re-run your command if needed."));

    process.exit(0);
  });

program
  .command("_internal-api-request", { hidden: true })
  .description("Internal command for API server communication. Do not use directly.")
  .requiredOption("--secret <secret>", "Internal API secret")
  .requiredOption("--action <action>", "Action to perform (e.g., listInstances, addInstance)")
  .option("--payload <json_payload>", "Base64 encoded JSON payload for the action")
  .action(async (options) => {
    let cliConfigForInternalHandling;

    try {
      cliConfigForInternalHandling = await getCliConfig();
      completeLogging = cliConfigForInternalHandling.completeLogging || false;
    } catch (configError) {
      console.error(JSON.stringify({ success: false, error: "PBManagerInternal: Failed to load CLI config during internal API request execution. Proceeding with caution.", details: configError.message }));

      completeLogging = false;
      cliConfigForInternalHandling = { api: { secret: options.secret, enabled: true }, completeLogging: false, defaultPocketBaseVersion: FALLBACK_POCKETBASE_VERSION };
    }

    if (!options.secret) {
      console.error(JSON.stringify({ success: false, error: "PBManagerInternal: Internal API secret is required for _internal-api-request." }));
      process.exit(1);
    }

    let payload = {};
    if (options.payload) {
      try {
        payload = JSON.parse(Buffer.from(options.payload, "base64").toString("utf-8"));
      } catch (e) {
        console.error(JSON.stringify({ success: false, error: "PBManagerInternal: Invalid JSON payload.", details: e.message }));
        process.exit(1);
      }
    }

    program.runningCommand = { name: () => "_internal-api-request" };

    try {
      let result;
      switch (options.action) {
        case "listInstances":
          result = await _internalListInstances();
          console.log(JSON.stringify({ success: true, data: result }));
          break;
        case "addInstance":
          result = await _internalAddInstance(payload);
          console.log(JSON.stringify(result));
          break;
        case "removeInstance":
          result = await _internalRemoveInstance(payload);
          console.log(JSON.stringify(result));
          break;
        case "getGlobalStats":
          result = await _internalGetGlobalStats();
          console.log(JSON.stringify(result));
          break;
        case "getInstanceLogs":
          result = await _internalGetInstanceLogs(payload);
          console.log(JSON.stringify(result));
          break;
        case "cloneInstance":
          result = await _internalCloneInstance(payload);
          console.log(JSON.stringify(result));
          break;
        case "resetInstance":
          result = await _internalResetInstance(payload);
          console.log(JSON.stringify(result));
          break;
        case "resetAdminPassword":
          result = await _internalResetAdminPassword(payload);
          console.log(JSON.stringify(result));
          break;
        case "renewCertificates":
          result = await _internalRenewCertificates(payload);
          console.log(JSON.stringify(result));
          break;
        case "updatePocketBaseExecutable":
          result = await _internalUpdatePocketBaseExecutable();
          console.log(JSON.stringify(result));
          break;
        case "updateEcosystemAndReloadPm2":
          result = await _internalUpdateEcosystemAndReloadPm2();
          console.log(JSON.stringify(result));
          break;
        case "setDefaultCertbotEmail":
          result = await _internalSetDefaultCertbotEmail(payload);
          console.log(JSON.stringify(result));
          break;
        default:
          console.error(JSON.stringify({ success: false, error: `PBManagerInternal: Unknown internal action: ${options.action}` }));
          process.exit(1);
      }
    } catch (error) {
      console.error(JSON.stringify({ success: false, error: `PBManagerInternal: Error executing internal action ${options.action}: ${error.message}`, stack: completeLogging ? error.stack : undefined }));
      process.exit(1);
    }
  });

program.hook("preAction", async (thisCommand, actionCommand) => {
  currentCommandNameForAudit = actionCommand.name();
  currentCommandArgsForAudit = process.argv.slice(3).join(" ");

  if (actionCommand.name() === "_internal-api-request") {
    return;
  }

  try {
    await fs.ensureDir(CONFIG_DIR);

    const cliConfig = await getCliConfig();
    completeLogging = cliConfig.completeLogging || false;

    const cachedLatestVersion = await getCachedLatestVersion();
    if (cliConfig.defaultPocketBaseVersion && cachedLatestVersion && cliConfig.defaultPocketBaseVersion !== cachedLatestVersion && actionCommand.name() !== "update-pocketbase" && actionCommand.name() !== "setup") {
      console.log(chalk.yellow(`A new version of PocketBase (v${cachedLatestVersion}) has been released. Your default is v${cliConfig.defaultPocketBaseVersion}. Consider running 'pb-manager update-pocketbase'.`));
    }

    await appendAuditLog(currentCommandNameForAudit, currentCommandArgsForAudit);
  } catch (e) {
    if (completeLogging) {
      console.log(chalk.red(`Error in preAction hook: ${e.message}`));
    }
  }
});

program.helpInformation = () => `
  PocketBase Manager (pb-manager)
  A CLI tool to manage multiple PocketBase instances with Nginx, PM2, and Certbot.

  Version: ${pbManagerVersion}

  Usage:
    sudo pb-manager <command> [options]

  Main Commands:
    dashboard                          Show interactive dashboard for all PocketBase instances
    add | create                       Register a new PocketBase instance
    clone <sourceName> <newName>       Clone an existing instance's data and config to a new one
    list [--json]                      List all managed PocketBase instances
    remove <name>                      Remove a PocketBase instance (prompts for data deletion)
    reset <name>                       Reset a PocketBase instance (delete all data, re-confirm needed)
    reset-admin <name>                 Reset the admin password for a PocketBase instance

  Instance Management:
    start <name | all>                 Start a specific PocketBase instance via PM2
    stop <name | all>                  Stop a specific PocketBase instance via PM2
    restart <name | all>               Restart a specific PocketBase instance via PM2
    logs <name>                        Show logs for a specific PocketBase instance from PM2

  Setup & Configuration:
    setup [--version]                  Initial setup: creates directories and downloads PocketBase
    configure                          Set or view CLI configurations (default Certbot email, PB version, logging, API)

  Updates & Maintenance:
    renew-certificates <name | all>   Renew SSL certificates using Certbot (use --force to force renewal)
    update-pocketbase                  Update the PocketBase executable and restart all instances
    update-ecosystem                   Regenerate the PM2 ecosystem file and reload PM2
    update-pb-manager                  Update the pb-manager CLI from GitHub

  Other:
    audit                              Show the history of commands executed by this CLI (includes errors)
    help [command]                     Show help for a specific command

  Run all commands as root or with sudo.
  
`;

async function main() {
  if (process.argv[2] !== "_internal-api-request" && process.geteuid && process.geteuid() !== 0) {
    console.error(chalk.red("You must run this script as root or with sudo. This is required for managing system services and configurations."));

    process.exit(1);
  }

  detectDistro();

  const cliConfig = await getCliConfig();
  completeLogging = cliConfig.completeLogging || false;

  if (process.argv[2] !== "_internal-api-request" && process.argv[2] !== "setup" && process.argv[2] !== "configure" && process.argv[2] !== "update-pb-manager") {
    if (!shell.which("pm2")) {
      console.error(chalk.red("PM2 is not installed or not in PATH. PM2 is essential for managing PocketBase instances."));
      console.log(chalk.blue("Please install PM2 globally by running: npm install -g pm2"));
      console.log(chalk.blue("Then, set it up to start on boot: sudo pm2 startup (and follow instructions)"));

      process.exit(1);
    }

    if (!shell.which("nginx")) {
      console.warn(chalk.yellow("Nginx is not found in PATH. Nginx is required for reverse proxying and HTTPS."));
      console.log(chalk.blue("Please install Nginx (e.g., sudo apt install nginx or sudo dnf install nginx)."));
    }
  }

  await ensureBaseSetup();

  const parsedCommand = program.parseAsync(process.argv);

  if (program.commands.find((cmd) => cmd.name() === process.argv[2])) {
    program.runningCommand = program.commands.find((cmd) => cmd.name() === process.argv[2]);
  }

  await parsedCommand;
}

main().catch(async (err) => {
  if (process.argv[2] !== "_internal-api-request") {
    console.error(chalk.red("An unexpected error occurred:"), err.message);
  }

  await appendAuditLog(currentCommandNameForAudit, currentCommandArgsForAudit, err);

  const cliConfig = await getCliConfig().catch(() => ({
    completeLogging: false,
  }));

  if (err.stack && (cliConfig.completeLogging || process.env.DEBUG) && process.argv[2] !== "_internal-api-request") {
    console.error(err.stack);
  }

  process.exit(1);
});
