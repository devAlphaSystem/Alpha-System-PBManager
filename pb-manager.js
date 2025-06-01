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
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");

const PM2_INSTANCE_PREFIX = "pb-";
const PM2_STATUS_ONLINE = "online";
const NGINX_DEFAULT_MAX_BODY_SIZE = "20M";
const POCKETBASE_FALLBACK_VERSION = "0.28.2";
const AUDIT_LOG_FILE = "audit.log";
const CLI_CONFIG_FILE = "cli-config.json";
const INSTANCES_CONFIG_FILE = "instances.json";
const POCKETBASE_BIN_SUBDIR = "bin";
const POCKETBASE_EXEC_NAME = "pocketbase";
const INSTANCES_DATA_SUBDIR = "instances_data";
const PM2_ECOSYSTEM_FILENAME = "ecosystem.config.js";
const VERSION_CACHE_FILENAME = "version-cache.json";
const GITHUB_API_POCKETBASE_RELEASES = "https://api.github.com/repos/pocketbase/pocketbase/releases/latest";
const IPFY_URL = "https://api.ipify.org?format=json";
const PB_MANAGER_UPDATE_SCRIPT_URL_BASE = "https://raw.githubusercontent.com/devAlphaSystem/Alpha-System-PBManager/main/";
const PB_MANAGER_SCRIPT_NAME = "pb-manager.js";
const DEFAULT_INSTALL_PATH_PB_MANAGER = "/opt/pb-manager/pb-manager.js";
const POCKETBASE_DOWNLOAD_LOCK_FILENAME = ".download.lock";

let NGINX_SITES_AVAILABLE = "/etc/nginx/sites-available";
let NGINX_SITES_ENABLED = "/etc/nginx/sites-enabled";
let NGINX_DISTRO_MODE = "debian";

const pbManagerVersion = "0.5.0";

async function safeRunCommand(command, args = [], errorMessage, ignoreError = false, options = {}) {
  return new Promise((resolve, reject) => {
    if (completeLogging) {
      console.log(chalk.yellow(`Executing: ${command} ${args.join(" ")}`));
    }

    const effectiveOptions = {
      stdio: completeLogging && !options.silent ? "inherit" : "pipe",
      shell: false,
      ...options,
    };

    const proc = spawn(command, args, effectiveOptions);

    let stdout = "";
    let stderr = "";

    if (proc.stdout) {
      proc.stdout.on("data", (data) => (stdout += data.toString()));
    }
    if (proc.stderr) {
      proc.stderr.on("data", (data) => (stderr += data.toString()));
    }

    proc.on("close", (code) => {
      if (code !== 0 && !ignoreError) {
        const fullErrorMsg = errorMessage || `Error executing command: ${command} ${args.join(" ")}`;
        if (completeLogging || !options.silent) {
          console.error(chalk.red(stderr || stdout));
        }
        const error = new Error(`${fullErrorMsg} - Exit Code: ${code} - Stderr: ${stderr.trim()} - Stdout: ${stdout.trim()}`);
        error.exitCode = code;
        error.stderr = stderr;
        error.stdout = stdout;
        reject(error);
      } else {
        resolve({ code, stdout, stderr });
      }
    });

    proc.on("error", (err) => {
      const fullErrorMsg = errorMessage || `Failed to start command: ${command}`;
      const error = new Error(`${fullErrorMsg} - OS Error: ${err.message}`);
      error.osError = err;
      reject(error);
    });
  });
}

async function detectDistro() {
  if (shell.which("apt-get")) {
    NGINX_SITES_AVAILABLE = "/etc/nginx/sites-available";
    NGINX_SITES_ENABLED = "/etc/nginx/sites-enabled";
    NGINX_DISTRO_MODE = "debian";
    if (!fs.existsSync(NGINX_SITES_AVAILABLE)) {
      await safeRunCommand("sudo", ["mkdir", "-p", NGINX_SITES_AVAILABLE], "Failed to create Nginx sites-available directory", true).catch((e) => {
        if (completeLogging) console.error(e);
      });
    }
    if (!fs.existsSync(NGINX_SITES_ENABLED)) {
      await safeRunCommand("sudo", ["mkdir", "-p", NGINX_SITES_ENABLED], "Failed to create Nginx sites-enabled directory", true).catch((e) => {
        if (completeLogging) console.error(e);
      });
    }
    return "apt";
  }

  if (shell.which("dnf")) {
    NGINX_SITES_AVAILABLE = "/etc/nginx/conf.d";
    NGINX_SITES_ENABLED = "/etc/nginx/conf.d";
    NGINX_DISTRO_MODE = "rhel";
    if (!fs.existsSync(NGINX_SITES_AVAILABLE)) {
      await safeRunCommand("sudo", ["mkdir", "-p", NGINX_SITES_AVAILABLE], "Failed to create Nginx conf.d directory", true).catch((e) => {
        if (completeLogging) console.error(e);
      });
    }
    return "dnf";
  }

  if (shell.which("pacman")) {
    NGINX_SITES_AVAILABLE = "/etc/nginx/sites-available";
    NGINX_SITES_ENABLED = "/etc/nginx/sites-enabled";
    NGINX_DISTRO_MODE = "arch";
    if (!fs.existsSync(NGINX_SITES_AVAILABLE)) {
      await safeRunCommand("sudo", ["mkdir", "-p", NGINX_SITES_AVAILABLE], "Failed to create Nginx sites-available directory", true).catch((e) => {
        if (completeLogging) console.error(e);
      });
    }
    if (!fs.existsSync(NGINX_SITES_ENABLED)) {
      await safeRunCommand("sudo", ["mkdir", "-p", NGINX_SITES_ENABLED], "Failed to create Nginx sites-enabled directory", true).catch((e) => {
        if (completeLogging) console.error(e);
      });
    }
    return "pacman";
  }
  return null;
}

const CONFIG_DIR = path.join(process.env.HOME || os.homedir(), ".pb-manager");
const CLI_CONFIG_PATH = path.join(CONFIG_DIR, CLI_CONFIG_FILE);
const INSTANCES_CONFIG_PATH = path.join(CONFIG_DIR, INSTANCES_CONFIG_FILE);
const POCKETBASE_BIN_DIR = path.join(CONFIG_DIR, POCKETBASE_BIN_SUBDIR);
const POCKETBASE_EXEC_PATH = path.join(POCKETBASE_BIN_DIR, POCKETBASE_EXEC_NAME);
const INSTANCES_DATA_BASE_DIR = path.join(CONFIG_DIR, INSTANCES_DATA_SUBDIR);
const PM2_ECOSYSTEM_FILE = path.join(CONFIG_DIR, PM2_ECOSYSTEM_FILENAME);
const VERSION_CACHE_PATH = path.join(CONFIG_DIR, VERSION_CACHE_FILENAME);
const POCKETBASE_DOWNLOAD_LOCK_PATH = path.join(POCKETBASE_BIN_DIR, POCKETBASE_DOWNLOAD_LOCK_FILENAME);

let completeLogging = false;
let _latestPocketBaseVersionCache = null;
let currentCommandNameForAudit = "pb-manager";
let currentCommandArgsForAudit = "";

async function appendAuditLog(command, details, error = null) {
  const auditLogPath = path.join(CONFIG_DIR, AUDIT_LOG_FILE);
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
    const publicIpRes = await axios.get(IPFY_URL, { timeout: 5000 }).catch(() => null);
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
      for (const record of aRecords) {
        if (record === serverIp) {
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
        for (const record of aaaaRecords) {
          if (record === serverIp) {
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
    await fs.writeJson(VERSION_CACHE_PATH, { timestamp: now, latestVersion });
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
    const res = await axios.get(GITHUB_API_POCKETBASE_RELEASES, { headers: { "User-Agent": "pb-manager" }, timeout: 5000 });
    if (res.data?.tag_name) {
      _latestPocketBaseVersionCache = res.data.tag_name.replace(/^v/, "");
      return _latestPocketBaseVersionCache;
    }
    if (completeLogging) {
      console.warn(chalk.yellow(`Could not determine latest PocketBase version from GitHub API response. Using fallback ${POCKETBASE_FALLBACK_VERSION}.`));
    }
  } catch (e) {
    if (completeLogging) {
      console.error(chalk.red(`Failed to fetch latest PocketBase version from GitHub: ${e.message}. Using fallback version ${POCKETBASE_FALLBACK_VERSION}.`));
    }
  }
  _latestPocketBaseVersionCache = POCKETBASE_FALLBACK_VERSION;
  return _latestPocketBaseVersionCache;
}

async function getCliConfig() {
  const latestVersion = (await getLatestPocketBaseVersion()) || POCKETBASE_FALLBACK_VERSION;
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
      const mergedConfig = { ...defaults, ...config };
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
  await fs.writeJson(CLI_CONFIG_PATH, config, { spaces: 2, mode: 0o600 });
}

async function ensureBaseSetup() {
  await fs.ensureDir(CONFIG_DIR);
  try {
    await fs.chmod(CONFIG_DIR, 0o700);
  } catch (e) {
    if (completeLogging) {
      console.warn(chalk.yellow(`Could not set permissions for ${CONFIG_DIR}. Please check manually.`));
    }
  }
  await fs.ensureDir(POCKETBASE_BIN_DIR);
  await fs.ensureDir(INSTANCES_DATA_BASE_DIR);
  if (!(await fs.pathExists(INSTANCES_CONFIG_PATH))) {
    await fs.writeJson(INSTANCES_CONFIG_PATH, { instances: {} }, { mode: 0o600 });
  }
  if (!(await fs.pathExists(PM2_ECOSYSTEM_FILE))) {
    await fs.writeFile(PM2_ECOSYSTEM_FILE, "module.exports = { apps: [] };");
  }
  const currentCliConfig = await getCliConfig();
  await saveCliConfig(currentCliConfig);
}

async function getInstancesConfig() {
  if (!(await fs.pathExists(INSTANCES_CONFIG_PATH))) {
    await fs.writeJson(INSTANCES_CONFIG_PATH, { instances: {} }, { mode: 0o600 });
  }
  return fs.readJson(INSTANCES_CONFIG_PATH);
}

async function saveInstancesConfig(config) {
  await fs.writeJson(INSTANCES_CONFIG_PATH, config, { spaces: 2, mode: 0o600 });
}

async function downloadPocketBaseIfNotExists(versionOverride = null, interactive = true) {
  const cliConfig = await getCliConfig();
  const versionToDownload = versionOverride || cliConfig.defaultPocketBaseVersion;

  if (!versionOverride && (await fs.pathExists(POCKETBASE_EXEC_PATH))) {
    if (completeLogging && interactive) {
      console.log(chalk.green(`PocketBase executable already exists at ${POCKETBASE_EXEC_PATH}. Skipping download.`));
    }
    return { success: true, message: "PocketBase executable already exists." };
  }

  if (await fs.pathExists(POCKETBASE_EXEC_PATH)) {
    if (interactive) {
      const { confirmOverwrite } = await inquirer.prompt([{ type: "confirm", name: "confirmOverwrite", message: `PocketBase executable already exists at ${POCKETBASE_EXEC_PATH}. Do you want to remove it and download version ${versionToDownload}?`, default: false }]);
      if (!confirmOverwrite) {
        console.log(chalk.yellow("Download cancelled by user."));
        return { success: false, message: "Download cancelled by user." };
      }
    }
    if (completeLogging) {
      console.log(chalk.yellow(`Removing existing PocketBase executable at ${POCKETBASE_EXEC_PATH} to download version ${versionToDownload}...`));
    }
    await fs.remove(POCKETBASE_EXEC_PATH);
  }

  try {
    await fs.ensureDir(POCKETBASE_BIN_DIR);
    await fs.writeFile(POCKETBASE_DOWNLOAD_LOCK_PATH, String(process.pid), { flag: "wx" });
  } catch (e) {
    if (e.code === "EEXIST") {
      if (interactive) {
        console.log(chalk.yellow("Another PocketBase download process may be active. Please wait or clear the lock file if stuck: " + POCKETBASE_DOWNLOAD_LOCK_PATH));
      }
      await new Promise((resolve) => setTimeout(resolve, 3000));
      if (await fs.pathExists(POCKETBASE_EXEC_PATH)) {
        return { success: true, message: "PocketBase executable now exists (likely downloaded by another process)." };
      }
      return { success: false, message: "Download lock held by another process." };
    }
    throw e;
  }

  const downloadUrl = `https://github.com/pocketbase/pocketbase/releases/download/v${versionToDownload}/pocketbase_${versionToDownload}_linux_amd64.zip`;
  if (completeLogging) {
    console.log(chalk.blue(`Downloading PocketBase v${versionToDownload} from ${downloadUrl}...`));
  }

  try {
    const response = await axios({ url: downloadUrl, method: "GET", responseType: "stream" });
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
    if (completeLogging && interactive) {
      console.log(chalk.green(`PocketBase v${versionToDownload} downloaded and extracted successfully to ${POCKETBASE_EXEC_PATH}.`));
    }
    return { success: true, message: `PocketBase v${versionToDownload} downloaded.` };
  } catch (error) {
    if (interactive) {
      console.error(chalk.red(`Error downloading or extracting PocketBase v${versionToDownload}:`), error.message);
      if (error.response && error.response.status === 404) {
        console.error(chalk.red(`Version ${versionToDownload} not found. Please check the version number.`));
      }
    }
    if (!interactive) {
      return { success: false, message: `Error downloading or extracting PocketBase v${versionToDownload}: ${error.message}`, error };
    }
    throw error;
  } finally {
    await fs.remove(POCKETBASE_DOWNLOAD_LOCK_PATH).catch(() => {});
  }
}

async function updatePm2EcosystemFile() {
  const config = await getInstancesConfig();
  const apps = [];
  for (const instName in config.instances) {
    const inst = config.instances[instName];
    const migrationsDir = path.join(inst.dataDir, "pb_migrations");
    apps.push({
      name: `${PM2_INSTANCE_PREFIX}${inst.name}`,
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
  const tempEcosystemFile = PM2_ECOSYSTEM_FILE + `.${Date.now()}.tmp`;
  await fs.writeFile(tempEcosystemFile, ecosystemContent);
  await fs.rename(tempEcosystemFile, PM2_ECOSYSTEM_FILE);

  console.log(chalk.green("PM2 ecosystem file updated."));
  return { success: true, message: "PM2 ecosystem file updated." };
}

async function reloadPm2(specificInstanceName = null) {
  try {
    if (specificInstanceName) {
      await safeRunCommand("pm2", ["restart", `${PM2_INSTANCE_PREFIX}${specificInstanceName}`], `Failed to restart PM2 process ${PM2_INSTANCE_PREFIX}${specificInstanceName}`);
    } else {
      await safeRunCommand("pm2", ["reload", PM2_ECOSYSTEM_FILE], "Failed to reload PM2 ecosystem");
    }
    await safeRunCommand("pm2", ["save"], "Failed to save PM2 state", true);
    const message = specificInstanceName ? `PM2 process ${PM2_INSTANCE_PREFIX}${specificInstanceName} restarted and PM2 state saved.` : "PM2 ecosystem reloaded and PM2 state saved.";
    console.log(chalk.green(message));
    return { success: true, message };
  } catch (error) {
    const message = `Failed to reload PM2: ${error.message}`;
    console.error(chalk.red(message));
    return { success: false, message, error };
  }
}

async function generateNginxConfig(instanceName, domain, port, useHttps, useHttp2, maxBody20Mb) {
  const securityHeaders = `
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains; preload" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "DENY" always;
    add_header X-XSS-Protection "1; mode=block" always;`;
  const clientMaxBody = maxBody20Mb ? `client_max_body_size ${NGINX_DEFAULT_MAX_BODY_SIZE};` : "";
  const http2Suffix = useHttp2 ? " http2" : "";
  let configContent;

  if (useHttps) {
    configContent = `
server {
    listen 80;
    listen [::]:80;
    server_name ${domain};
    location / {
        return 301 https://$host$request_uri;
    }
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
    listen 443 ssl${http2Suffix};
    listen [::]:443 ssl${http2Suffix};
    ssl_certificate /etc/letsencrypt/live/${domain}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${domain}/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparam.pem;
}`;
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
    listen 80${http2Suffix};
    listen [::]:80${http2Suffix};
}`;
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
  const tempNginxConfPath = `${nginxConfPath}.${Date.now()}.tmp`;
  await fs.writeFile(tempNginxConfPath, configContent.trim());
  try {
    await safeRunCommand("sudo", ["mv", tempNginxConfPath, nginxConfPath], `Failed to move Nginx config to ${nginxConfPath}`);
  } catch (error) {
    await fs.remove(tempNginxConfPath).catch(() => {});
    throw error;
  }

  if (NGINX_DISTRO_MODE !== "rhel") {
    if (completeLogging) {
      console.log(chalk.blue(`Creating Nginx symlink: ${nginxEnabledPath}`));
    }
    try {
      await safeRunCommand("sudo", ["ln", "-sfn", nginxConfPath, nginxEnabledPath], `Failed to create Nginx symlink for ${nginxConfPath} to ${nginxEnabledPath}`);
    } catch (error) {
      const errorMsg = `Failed to create Nginx symlink for ${nginxConfPath} to ${nginxEnabledPath}: ${error.message}. Please try running this command with sudo, or create the symlink manually.`;
      console.error(chalk.red(errorMsg));
      console.log(chalk.yellow(`Manually run: sudo ln -sfn ${nginxConfPath} ${nginxEnabledPath}`));
      throw new Error(errorMsg);
    }
  }
  return { success: true, message: `Nginx config generated for ${instanceName} at ${nginxConfPath}`, path: nginxConfPath };
}

async function reloadNginx() {
  if (completeLogging) {
    console.log(chalk.blue("Testing Nginx configuration..."));
  }
  try {
    await safeRunCommand("sudo", ["nginx", "-t"], "Nginx configuration test failed");
    if (completeLogging) {
      console.log(chalk.blue("Reloading Nginx..."));
    }
    let reloaded = false;
    if (shell.which("systemctl")) {
      try {
        await safeRunCommand("sudo", ["systemctl", "reload", "nginx"], "Failed to reload Nginx with systemctl");
        reloaded = true;
      } catch (e) {}
    }
    if (!reloaded && shell.which("service")) {
      try {
        await safeRunCommand("sudo", ["service", "nginx", "reload"], "Failed to reload Nginx with service");
        reloaded = true;
      } catch (e) {}
    }
    if (!reloaded) {
      try {
        await safeRunCommand("sudo", ["nginx", "-s", "reload"], "Failed to reload Nginx with nginx -s reload");
        reloaded = true;
      } catch (e) {}
    }
    if (!reloaded) {
      throw new Error("Could not reload Nginx with systemctl, service, or nginx -s reload.");
    }
    console.log(chalk.green("Nginx reloaded successfully."));
    return { success: true, message: "Nginx reloaded successfully." };
  } catch (error) {
    const errorMsg = `Nginx test failed or reload failed: ${error.message}. Please check Nginx configuration.`;
    console.error(chalk.red(errorMsg));
    console.log(chalk.yellow("You can try to diagnose Nginx issues by running: sudo nginx -t"));
    console.log(chalk.yellow("Check Nginx error logs, typically found in /var/log/nginx/error.log"));
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
      await safeRunCommand("sudo", ["openssl", "dhparam", "-out", dhParamPath, "2048"], `Failed to generate ${dhParamPath}. Nginx might fail to reload.`);
      if (completeLogging) {
        console.log(chalk.green(`${dhParamPath} generated successfully.`));
      }
      return { success: true, message: `${dhParamPath} generated successfully.` };
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
    await safeRunCommand("sudo", ["mkdir", "-p", "/var/www/html"], "Creating /var/www/html for Certbot", true);
  } catch (e) {}

  const certbotArgs = ["--nginx", "-d", domain, "--non-interactive", "--agree-tos", "-m", email, "--redirect"];
  if (NGINX_DISTRO_MODE === "rhel") {
    certbotArgs.push("--nginx-server-root", "/etc/nginx/");
  }

  if (isCliCall) {
    const { confirmCertbotRun } = await inquirer.prompt([{ type: "confirm", name: "confirmCertbotRun", message: `Ready to run Certbot for domain ${domain} with email ${email}. Command: sudo certbot ${certbotArgs.join(" ")}. Proceed?`, default: true }]);
    if (!confirmCertbotRun) {
      console.log(chalk.yellow("Certbot execution cancelled by user."));
      return { success: false, message: "Certbot execution cancelled by user." };
    }
  }

  try {
    await safeRunCommand("sudo", ["certbot", ...certbotArgs], "Certbot command failed.");
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
    for (const proc of pm2List) {
      if (proc.name === `${PM2_INSTANCE_PREFIX}${name}`) {
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
    usage.push({ name, domain: inst.domain, port: inst.port, status, cpu, mem, uptime, dataSize, httpStatus, ssl: inst.useHttps ? "Yes" : "No" });
  }
  return usage;
}

async function getDirectorySize(dir) {
  try {
    const result = await safeRunCommand("du", ["-sb", dir], `Failed to get size of ${dir} with du`, true, { silent: true });
    if (result.code === 0 && result.stdout) {
      return parseInt(result.stdout.split(/\s+/)[0], 10);
    }
  } catch (e) {
    if (completeLogging) {
      console.warn(chalk.yellow(`Failed to get size with 'du' for ${dir}: ${e.message}. Falling back to recursive method.`));
    }
  }

  let total = 0;
  try {
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
  } catch (e) {
    if (completeLogging) {
      console.warn(chalk.yellow(`Error during recursive size calculation for ${dir}: ${e.message}`));
    }
    return 0;
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

function getCertExpiryDays(domain) {
  return new Promise((resolve) => {
    const tls = require("node:tls");
    const operationTimeout = 5000;
    let socket;
    let timeoutId;

    const cleanupAndResolve = (value) => {
      clearTimeout(timeoutId);
      if (socket) {
        socket.removeAllListeners();
        socket.destroy();
      }
      resolve(value);
    };

    timeoutId = setTimeout(() => {
      cleanupAndResolve("-");
    }, operationTimeout);

    try {
      socket = tls.connect({ host: domain, port: 443, servername: domain, rejectUnauthorized: false, timeout: operationTimeout - 500 }, () => {
        const cert = socket.getPeerCertificate();
        if (!cert || !cert.valid_to) {
          cleanupAndResolve("-");
        } else {
          const expiryDate = new Date(cert.valid_to);
          const now = new Date();
          const diff = expiryDate.getTime() - now.getTime();
          const daysLeft = Math.ceil(diff / (1000 * 60 * 60 * 24));
          cleanupAndResolve(daysLeft);
        }
        socket.end();
      });

      socket.on("error", () => cleanupAndResolve("-"));
      socket.on("timeout", () => cleanupAndResolve("-"));
    } catch (e) {
      cleanupAndResolve("-");
    }
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

  const screen = blessed.screen({ smartCSR: true, title: "PocketBase Manager Dashboard" });
  const grid = new contrib.grid({ rows: 12, cols: 12, screen: screen });
  const table = grid.set(0, 0, 10, 12, contrib.table, { keys: true, fg: "white", selectedFg: "white", selectedBg: "blue", interactive: true, label: "PocketBase Instances", width: "100%", height: "100%", border: { type: "line", fg: "cyan" }, columnSpacing: 2, columnWidth: [25, 25, 8, 10, 8, 10, 10, 8, 8, 8] });
  grid.set(10, 0, 2, 12, blessed.box, { content: " [q] Quit  [r] Refresh  [l] Logs  [s] Start/Stop  [d] Delete", tags: true, style: { fg: "yellow" } });

  function truncateText(text, maxLength) {
    return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
  }

  let currentData = [];
  let selectedIndex = 0;

  async function refreshTable() {
    try {
      const usage = await getInstanceUsageAnalytics(config.instances);
      currentData = usage;
      const data = [];
      for (const u of usage) {
        data.push([truncateText(u.name, 25), truncateText(u.domain, 25), u.port, u.status, u.httpStatus, u.ssl, `${u.cpu}%`, prettyBytes(u.mem), formatUptime(u.uptime), prettyBytes(u.dataSize)]);
      }
      table.setData({ headers: ["Name", "Domain", "Port", "Status", "HTTP", "SSL", "CPU", "Mem", "Uptime", "Data"], data });
      if (data.length > 0) {
        if (selectedIndex >= data.length) selectedIndex = data.length - 1;
        if (selectedIndex < 0) selectedIndex = 0;
        table.rows.select(selectedIndex);
      }
      screen.render();
    } catch (error) {
      if (completeLogging) console.error(chalk.red("Dashboard refresh error:"), error);
    }
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

  const quitDashboard = () => {
    clearInterval(interval);
    if (screen && !screen.destroyed) {
      screen.destroy();
    }
    process.exit(0);
  };

  screen.key(["q", "C-c"], quitDashboard);
  screen.key(["r"], async () => await refreshTable());

  screen.key(["l"], () => {
    const idx = table.rows.selected;
    if (idx >= 0 && idx < currentData.length) {
      const name = currentData[idx].name;
      clearInterval(interval);
      if (screen && !screen.destroyed) screen.destroy();
      shell.exec(`pm2 logs ${PM2_INSTANCE_PREFIX}${name} --lines 50`);
      process.exit(0);
    }
  });

  screen.key(["s"], async () => {
    const idx = table.rows.selected;
    if (idx >= 0 && idx < currentData.length) {
      const name = currentData[idx].name;
      const inst = currentData[idx];
      try {
        if (inst.status === PM2_STATUS_ONLINE) {
          await safeRunCommand("pm2", ["stop", `${PM2_INSTANCE_PREFIX}${name}`], `Failed to stop ${name}`);
        } else {
          await safeRunCommand("pm2", ["start", `${PM2_INSTANCE_PREFIX}${name}`], `Failed to start ${name}`);
        }
        await refreshTable();
      } catch (e) {
        if (completeLogging) console.error(chalk.red(`Error start/stop ${name}: ${e.message}`));
      }
    }
  });

  screen.key(["d"], async () => {
    const idx = table.rows.selected;
    if (idx >= 0 && idx < currentData.length) {
      const name = currentData[idx].name;
      clearInterval(interval);
      if (screen && !screen.destroyed) screen.destroy();
      console.log(chalk.yellow(`To delete instance "${name}", please run: pb-manager remove ${name}`));
      process.exit(0);
    }
  });
  screen.render();
}

async function _internalGetGlobalStats() {
  try {
    const cliConfig = await getCliConfig();
    return { success: true, data: { pbManagerVersion, defaultPocketBaseVersion: cliConfig.defaultPocketBaseVersion, pocketBaseExecutablePath: POCKETBASE_EXEC_PATH, configDirectory: CONFIG_DIR, nginxSitesAvailable: NGINX_SITES_AVAILABLE, nginxSitesEnabled: NGINX_SITES_ENABLED, nginxDistroMode: NGINX_DISTRO_MODE, completeLoggingEnabled: completeLogging } };
  } catch (error) {
    return { success: false, error: error.message, messages: [error.message] };
  }
}

async function _internalGetInstanceLogs(payload) {
  const { name } = payload;
  let { lines = 100 } = payload;
  lines = Math.min(Math.max(1, parseInt(lines, 10) || 100), 5000);

  if (!name) {
    return { success: false, error: "Instance name is required for logs.", messages: ["Instance name is required for logs."] };
  }
  const instancePM2Name = `${PM2_INSTANCE_PREFIX}${name}`;
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
        if (proc.name.startsWith(PM2_INSTANCE_PREFIX)) {
          pm2Statuses[proc.name.substring(PM2_INSTANCE_PREFIX.length)] = proc.pm2_env.status;
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
    output.push({ name, domain: inst.domain, protocol, publicUrl: `${publicUrl}/_/`, internalPort: inst.port, dataDirectory: inst.dataDir, pm2Status: status, adminURL: `http://127.0.0.1:${inst.port}/_/`, certExpiryDays: certExpiry });
  }
  return output;
}

async function _internalAddInstance(payload) {
  const { name, domain, port, useHttps = true, emailForCertbot, useHttp2 = true, maxBody20Mb = true, autoRunCertbot = true, pocketBaseVersion } = payload;
  const results = { success: false, messages: [], instance: null, nginxConfigPath: null, certbotSuccess: null, error: null };

  try {
    await ensureBaseSetup();
    const pbDownloadResult = await downloadPocketBaseIfNotExists(pocketBaseVersion, false);
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
    const newInstanceConfig = { name, domain, port, dataDir: instanceDataDir, useHttps, emailForCertbot: useHttps ? emailForCertbot : null, useHttp2, maxBody20Mb };
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
      await safeRunCommand("pm2", ["stop", `${PM2_INSTANCE_PREFIX}${name}`], `Stopping ${PM2_INSTANCE_PREFIX}${name}`, true);
      results.messages.push(`Attempted to stop PM2 process ${PM2_INSTANCE_PREFIX}${name}.`);
      await safeRunCommand("pm2", ["delete", `${PM2_INSTANCE_PREFIX}${name}`], `Deleting ${PM2_INSTANCE_PREFIX}${name}`, true);
      results.messages.push(`Attempted to delete PM2 process ${PM2_INSTANCE_PREFIX}${name}.`);
    } catch (e) {
      results.messages.push(`Warning: Could not stop/delete PM2 process ${PM2_INSTANCE_PREFIX}${name} (maybe not running/exists): ${e.message}`);
    }

    const nginxConfPathBase = NGINX_DISTRO_MODE === "rhel" ? `${name}.conf` : name;
    const nginxConfPath = path.join(NGINX_SITES_AVAILABLE, nginxConfPathBase);
    const nginxEnabledPath = NGINX_DISTRO_MODE === "rhel" ? nginxConfPath : path.join(NGINX_SITES_ENABLED, name);

    if (NGINX_DISTRO_MODE !== "rhel" && (await fs.pathExists(nginxEnabledPath))) {
      try {
        await safeRunCommand("sudo", ["rm", nginxEnabledPath], `Failed to remove Nginx symlink ${nginxEnabledPath}`);
        results.messages.push(`Removed Nginx symlink ${nginxEnabledPath}.`);
      } catch (e) {
        results.messages.push(`Warning: Failed to remove Nginx symlink ${nginxEnabledPath}: ${e.message}`);
      }
    }
    if (await fs.pathExists(nginxConfPath)) {
      try {
        await safeRunCommand("sudo", ["rm", nginxConfPath], `Failed to remove Nginx config ${nginxConfPath}`);
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
      await safeRunCommand("pm2", ["save"], "PM2 save failed", true);
      results.messages.push("PM2 state saved.");
    } catch (e) {}
    await reloadNginx();

    if (payload.deleteData) {
      try {
        await fs.remove(instanceDataDir);
        results.messages.push(`Data directory ${instanceDataDir} deleted successfully.`);
      } catch (err) {
        results.messages.push(`Failed to delete data directory ${instanceDataDir}: ${err.message}. Manual deletion may be required.`);
        results.error = results.error ? `${results.error}; Data deletion failed` : "Data deletion failed";
      }
    } else {
      results.messages.push(`Data directory at ${instanceDataDir} was NOT deleted. Manual deletion required if desired.`);
    }
    results.success = true;
  } catch (error) {
    results.messages.push(`Error during internal remove instance: ${error.message}`);
    results.error = error.message;
  }
  return results;
}

async function _internalCloneInstance(payload) {
  const { sourceName, newName, domain, port, useHttps = true, emailForCertbot, useHttp2 = true, maxBody20Mb = true, autoRunCertbot = true, pocketBaseVersion } = payload;
  const results = { success: false, messages: [], instance: null, nginxConfigPath: null, certbotSuccess: null, error: null };

  try {
    await ensureBaseSetup();
    if (!(await fs.pathExists(POCKETBASE_EXEC_PATH))) {
      results.messages.push("PocketBase executable not found. Attempting non-interactive download.");
      const dlResult = await downloadPocketBaseIfNotExists(pocketBaseVersion, false);
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

    if (payload.createAdminCli && payload.adminEmail && payload.adminPassword) {
      const migrationsDir = path.join(newInstanceDataDir, "pb_migrations");
      const adminCreateArgs = ["superuser", "create", payload.adminEmail, payload.adminPassword, "--dir", newInstanceDataDir, "--migrationsDir", migrationsDir];
      results.messages.push(`Attempting to create additional superuser (admin) account: ${payload.adminEmail}`);
      try {
        const adminResult = await safeRunCommand(POCKETBASE_EXEC_PATH, adminCreateArgs, "Failed to create superuser (admin) account via CLI for clone.");
        if (adminResult?.stdout?.includes("Successfully created new superuser")) {
          results.messages.push(adminResult.stdout.trim());
          results.messages.push(`Additional superuser (admin) account for ${payload.adminEmail} created successfully!`);
        } else {
          results.messages.push(`Admin creation output: ${adminResult.stdout} ${adminResult.stderr}`);
        }
      } catch (e) {
        results.messages.push(`Additional superuser (admin) account creation via CLI failed: ${e.message}`);
      }
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
    results.messages.push(`Stopping and deleting PM2 process for ${PM2_INSTANCE_PREFIX}${name}...`);
    try {
      await safeRunCommand("pm2", ["stop", `${PM2_INSTANCE_PREFIX}${name}`], `Stopping ${PM2_INSTANCE_PREFIX}${name}`, true);
      await safeRunCommand("pm2", ["delete", `${PM2_INSTANCE_PREFIX}${name}`], `Deleting ${PM2_INSTANCE_PREFIX}${name}`, true);
    } catch (e) {
      results.messages.push(`Warning: Could not stop/delete PM2 process ${PM2_INSTANCE_PREFIX}${name} (maybe not running/exists): ${e.message}`);
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
        const adminCreateArgs = ["superuser", "create", adminEmail, adminPassword, "--dir", dataDir, "--migrationsDir", migrationsDir];
        results.messages.push(`Attempting to create superuser (admin) account: ${adminEmail}`);
        try {
          const adminResult = await safeRunCommand(POCKETBASE_EXEC_PATH, adminCreateArgs, "Failed to create superuser (admin) account via CLI.");
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
    results.messages.push(`Starting instance ${PM2_INSTANCE_PREFIX}${name}...`);
    await safeRunCommand("pm2", ["start", `${PM2_INSTANCE_PREFIX}${name}`], `Starting ${PM2_INSTANCE_PREFIX}${name}`, true);
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
    const adminUpdateArgs = ["superuser", "update", adminEmail, adminPassword, "--dir", dataDir];
    results.messages.push(`Attempting to reset admin password for ${adminEmail} on instance ${name}...`);
    const result = await safeRunCommand(POCKETBASE_EXEC_PATH, adminUpdateArgs, "Failed to reset superuser (admin) password via CLI.");
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

  const certbotArgs = ["renew"];
  let baseMessage;

  if (instanceName && instanceName.toLowerCase() !== "all") {
    const config = await getInstancesConfig();
    const instance = config.instances[instanceName];
    if (!instance || !instance.useHttps) {
      results.error = `Instance "${instanceName}" not found or does not use HTTPS.`;
      results.messages.push(results.error);
      return results;
    }
    certbotArgs.push("--cert-name", instance.domain);
    baseMessage = `Attempted certificate renewal for ${instance.domain}.`;
  } else {
    baseMessage = "Attempted renewal for all managed certificates.";
  }
  if (force) {
    certbotArgs.push("--force-renewal");
  }

  try {
    results.messages.push(`Executing: sudo certbot ${certbotArgs.join(" ")}`);
    await safeRunCommand("sudo", ["certbot", ...certbotArgs], "Certbot renewal command failed.");
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
    const updateResult = await safeRunCommand(POCKETBASE_EXEC_PATH, ["update"], "PocketBase update command failed.", false, { cwd: POCKETBASE_BIN_DIR });
    results.messages.push("PocketBase executable update process finished.");
    if (updateResult.stdout) results.messages.push(`Stdout: ${updateResult.stdout}`);
    if (updateResult.stderr) results.messages.push(`Stderr: ${updateResult.stderr}`);

    results.messages.push("Restarting all PocketBase instances via PM2...");
    const instancesConf = await getInstancesConfig();
    let allRestarted = true;
    for (const instName in instancesConf.instances) {
      try {
        await safeRunCommand("pm2", ["restart", `${PM2_INSTANCE_PREFIX}${instName}`], `Failed to restart instance ${PM2_INSTANCE_PREFIX}${instName}`);
        results.messages.push(`Instance ${PM2_INSTANCE_PREFIX}${instName} restarted.`);
      } catch (e) {
        results.messages.push(`Failed to restart instance ${PM2_INSTANCE_PREFIX}${instName}: ${e.message}`);
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
  .description("Set or view CLI configurations (e.g., default Certbot email, PocketBase version, logging).")
  .action(async () => {
    await ensureBaseSetup();
    const cliConfig = await getCliConfig();
    const choices = [{ name: `Default Certbot Email: ${cliConfig.defaultCertbotEmail || "Not set"}`, value: "setEmail" }, { name: `Default PocketBase Version (for setup): ${cliConfig.defaultPocketBaseVersion}`, value: "setPbVersion" }, { name: `Enable complete logging: ${cliConfig.completeLogging ? "Yes" : "No"}`, value: "setLogging" }, new inquirer.Separator(), { name: "View current JSON config", value: "viewConfig" }, { name: "Exit", value: "exit" }];
    const { action } = await inquirer.prompt([{ type: "list", name: "action", message: "CLI Configuration:", choices }]);

    switch (action) {
      case "setEmail": {
        const { email } = await inquirer.prompt([{ type: "input", name: "email", message: "Enter new default Certbot email (leave blank to clear):", default: cliConfig.defaultCertbotEmail }]);
        const result = await _internalSetDefaultCertbotEmail({ email });
        for (const msg of result.messages) {
          console.log(result.success ? chalk.green(msg) : chalk.red(msg));
        }
        break;
      }
      case "setPbVersion": {
        const { version } = await inquirer.prompt([{ type: "input", name: "version", message: "Enter new default PocketBase version (e.g., 0.22.10):", default: cliConfig.defaultPocketBaseVersion, validate: (input) => (/^(\d+\.\d+\.\d+)$/.test(input) || input === "" ? true : "Please enter a valid version (x.y.z) or leave blank.") }]);
        cliConfig.defaultPocketBaseVersion = version || (await getLatestPocketBaseVersion());
        await saveCliConfig(cliConfig);
        console.log(chalk.green(`Default PocketBase version set to ${cliConfig.defaultPocketBaseVersion}.`));
        break;
      }
      case "setLogging": {
        const { enableLogging } = await inquirer.prompt([{ type: "confirm", name: "enableLogging", message: "Enable complete logging (show all commands and outputs)?", default: cliConfig.completeLogging || false }]);
        cliConfig.completeLogging = enableLogging;
        await saveCliConfig(cliConfig);
        completeLogging = enableLogging;
        console.log(chalk.green(`Complete logging is now ${enableLogging ? "enabled" : "disabled"}.`));
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
    if (action !== "setLogging" && action !== "viewConfig" && action !== "exit" && action !== "setEmail") {
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
    const dlResult = await downloadPocketBaseIfNotExists(options.version, true);
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
      console.log(chalk.yellow("PocketBase executable not found. Attempting to download..."));
      const dlResult = await downloadPocketBaseIfNotExists(cliConfig.defaultPocketBaseVersion, true);
      if (!dlResult.success) {
        console.error(chalk.red(`PocketBase download failed: ${dlResult.message}. Cannot add instance.`));
        return;
      }
      if (!(await fs.pathExists(POCKETBASE_EXEC_PATH))) {
        console.error(chalk.red("PocketBase download seems to have failed despite no error. Cannot add instance."));
        return;
      }
    }

    const initialAnswers = await inquirer.prompt([
      { type: "input", name: "name", message: "Instance name (e.g., my-app, no spaces):", validate: (input) => (/^[a-zA-Z0-9-]+$/.test(input) ? true : "Invalid name format.") },
      { type: "input", name: "domain", message: "Domain/subdomain for this instance (e.g., app.example.com):", validate: (input) => (input.length > 0 ? true : "Domain cannot be empty.") },
      { type: "number", name: "port", message: "Internal port for this instance (e.g., 8091):", default: 8090 + Math.floor(Math.random() * 100), validate: (input) => (Number.isInteger(input) && input > 1024 && input < 65535 ? true : "Invalid port.") },
      { type: "confirm", name: "useHttp2", message: "Enable HTTP/2 in Nginx config?", default: true },
      { type: "confirm", name: "maxBody20Mb", message: `Set ${NGINX_DEFAULT_MAX_BODY_SIZE} max body size (client_max_body_size ${NGINX_DEFAULT_MAX_BODY_SIZE}) in Nginx config?`, default: true },
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
      if (config.instances[instName].domain === initialAnswers.domain) {
        console.error(chalk.red(`Domain ${initialAnswers.domain} is already in use by another managed instance.`));
        return;
      }
    }

    let emailToUseForCertbot = cliConfig.defaultCertbotEmail;
    const httpsAnswers = await inquirer.prompt([
      { type: "confirm", name: "useHttps", message: "Configure HTTPS (Certbot)?", default: true },
      { type: "confirm", name: "useDefaultEmail", message: `Use default email (${cliConfig.defaultCertbotEmail}) for Let's Encrypt?`, default: true, when: (answers) => answers.useHttps && cliConfig.defaultCertbotEmail },
      { type: "input", name: "emailForCertbot", message: "Enter email for Let's Encrypt:", when: (answers) => answers.useHttps && (!cliConfig.defaultCertbotEmail || !answers.useDefaultEmail), validate: (input) => (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input) ? true : "Valid email required."), default: (answers) => (!cliConfig.defaultCertbotEmail || !answers.useDefaultEmail ? undefined : cliConfig.defaultCertbotEmail) },
      { type: "confirm", name: "autoRunCertbot", message: "Attempt to automatically run Certbot now to obtain the SSL certificate?", default: true, when: (answers) => answers.useHttps },
    ]);

    if (httpsAnswers.useHttps) {
      const dnsValid = await validateDnsRecords(initialAnswers.domain);
      if (!dnsValid) {
        const { proceedAnyway } = await inquirer.prompt([{ type: "confirm", name: "proceedAnyway", message: chalk.yellow(`DNS validation failed for ${initialAnswers.domain}. Certbot will likely fail. Do you want to proceed with the setup (you might need to fix DNS and run Certbot manually later, or use HTTP only)?`), default: false }]);
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

    const addPayload = {
      name: initialAnswers.name,
      domain: initialAnswers.domain,
      port: initialAnswers.port,
      useHttps: httpsAnswers.useHttps,
      emailForCertbot: httpsAnswers.useHttps ? emailToUseForCertbot : null,
      useHttp2: initialAnswers.useHttp2,
      maxBody20Mb: initialAnswers.maxBody20Mb,
      autoRunCertbot: httpsAnswers.useHttps ? httpsAnswers.autoRunCertbot : false,
      pocketBaseVersion: cliConfig.defaultPocketBaseVersion,
    };

    const result = await _internalAddInstance(addPayload);

    for (const msg of result.messages) {
      console.log(chalk.blue(msg));
    }

    if (!result.success) {
      console.error(chalk.red(`Failed to add instance: ${result.error || "Unknown error during add operation."}`));
      return;
    }

    let adminCreatedViaCli = false;
    const { createAdminCli } = await inquirer.prompt([{ type: "confirm", name: "createAdminCli", message: "Do you want to create a superuser (admin) account for this instance via CLI now?", default: true }]);
    if (createAdminCli) {
      const adminCredentials = await inquirer.prompt([
        { type: "input", name: "adminEmail", message: "Enter admin email:", validate: (input) => (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input) ? true : "Please enter a valid email.") },
        { type: "password", name: "adminPassword", message: "Enter admin password (min 8 chars):", mask: "*", validate: (input) => (input.length >= 8 ? true : "Password must be at least 8 characters.") },
      ]);
      const instanceDataDir = path.join(INSTANCES_DATA_BASE_DIR, initialAnswers.name);
      const migrationsDir = path.join(instanceDataDir, "pb_migrations");
      const adminCreateArgs = ["superuser", "create", adminCredentials.adminEmail, adminCredentials.adminPassword, "--dir", instanceDataDir, "--migrationsDir", migrationsDir];
      if (completeLogging) {
        console.log(chalk.blue("\nAttempting to create superuser (admin) account via CLI..."));
      }
      try {
        const adminCmdResult = await safeRunCommand(POCKETBASE_EXEC_PATH, adminCreateArgs, "Failed to create superuser (admin) account via CLI.");
        if (adminCmdResult?.stdout?.includes("Successfully created new superuser")) {
          console.log(adminCmdResult.stdout.trim());
        }
        console.log(chalk.green(`Superuser (admin) account for ${adminCredentials.adminEmail} created successfully!`));
        adminCreatedViaCli = true;
      } catch (e) {
        console.error(chalk.red(`Superuser (admin) account creation via CLI failed: ${e.message}. Please try creating it via the web UI.`));
      }
    }

    console.log(chalk.bold.green(`\nInstance "${initialAnswers.name}" added!`));
    const protocol = result.instance.useHttps && result.certbotSuccess ? "https" : "http";
    const publicBaseUrl = `${protocol}://${result.instance.domain}`;
    const localAdminUrl = `http://127.0.0.1:${result.instance.port}/_/`;
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
    if (result.instance.useHttps && !result.certbotSuccess && httpsAnswers.autoRunCertbot) {
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
      const dlResult = await downloadPocketBaseIfNotExists(cliConfig.defaultPocketBaseVersion, true);
      if (!dlResult.success) {
        console.error(chalk.red("PocketBase download failed. Cannot clone instance."));
        return;
      }
      if (!(await fs.pathExists(POCKETBASE_EXEC_PATH))) {
        console.error(chalk.red("PocketBase download seems to have failed. Cannot clone instance."));
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
      { type: "input", name: "domain", message: `Domain/subdomain for new instance "${newName}":`, default: `cloned-${sourceInstance.domain}`, validate: (input) => (input.length > 0 ? true : "Domain cannot be empty.") },
      { type: "number", name: "port", message: `Internal port for new instance "${newName}":`, default: sourceInstance.port + 1, validate: (input) => (Number.isInteger(input) && input > 1024 && input < 65535 ? true : "Invalid port.") },
      { type: "confirm", name: "useHttp2", message: "Enable HTTP/2 in Nginx config for new instance?", default: sourceInstance.useHttp2 },
      { type: "confirm", name: "maxBody20Mb", message: `Set ${NGINX_DEFAULT_MAX_BODY_SIZE} max body size in Nginx config for new instance?`, default: sourceInstance.maxBody20Mb },
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
      { type: "confirm", name: "useHttps", message: `Configure HTTPS (Certbot) for "${newName}"?`, default: sourceInstance.useHttps },
      { type: "confirm", name: "useDefaultEmail", message: `Use default email (${cliConfig.defaultCertbotEmail}) for Let's Encrypt?`, default: true, when: (answers) => answers.useHttps && cliConfig.defaultCertbotEmail },
      { type: "input", name: "emailForCertbot", message: "Enter email for Let's Encrypt:", when: (answers) => answers.useHttps && (!cliConfig.defaultCertbotEmail || !answers.useDefaultEmail), validate: (input) => (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input) ? true : "Valid email required."), default: (answers) => (!cliConfig.defaultCertbotEmail || !answers.useDefaultEmail ? sourceInstance.emailForCertbot : cliConfig.defaultCertbotEmail) },
      { type: "confirm", name: "autoRunCertbot", message: "Attempt to automatically run Certbot now to obtain the SSL certificate?", default: true, when: (answers) => answers.useHttps },
    ]);

    if (httpsAnswers.useHttps) {
      const dnsValid = await validateDnsRecords(cloneAnswers.domain);
      if (!dnsValid) {
        const { proceedAnyway } = await inquirer.prompt([{ type: "confirm", name: "proceedAnyway", message: chalk.yellow(`DNS validation failed for ${cloneAnswers.domain}. Certbot will likely fail. Do you want to proceed with cloning (you might need to fix DNS and run Certbot manually later, or use HTTP only)?`), default: false }]);
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

    let adminPayload = {};
    const { createAdminCli } = await inquirer.prompt([{ type: "confirm", name: "createAdminCli", message: `Data has been cloned. Do you want to create an *additional* superuser (admin) account for "${newName}" via CLI now? (Existing admins from "${sourceName}" are already cloned)`, default: false }]);
    if (createAdminCli) {
      const adminCredentials = await inquirer.prompt([
        { type: "input", name: "adminEmail", message: "Enter new admin email:", validate: (input) => (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input) ? true : "Please enter a valid email.") },
        { type: "password", name: "adminPassword", message: "Enter new admin password (min 8 chars):", mask: "*", validate: (input) => (input.length >= 8 ? true : "Password must be at least 8 characters.") },
      ]);
      adminPayload = { createAdminCli: true, adminEmail: adminCredentials.adminEmail, adminPassword: adminCredentials.adminPassword };
    }

    const clonePayload = {
      sourceName,
      newName,
      domain: cloneAnswers.domain,
      port: cloneAnswers.port,
      useHttps: httpsAnswers.useHttps,
      emailForCertbot: httpsAnswers.useHttps ? emailToUseForCertbot : null,
      useHttp2: cloneAnswers.useHttp2,
      maxBody20Mb: cloneAnswers.maxBody20Mb,
      autoRunCertbot: httpsAnswers.useHttps ? httpsAnswers.autoRunCertbot : false,
      pocketBaseVersion: cliConfig.defaultPocketBaseVersion,
      ...adminPayload,
    };

    const result = await _internalCloneInstance(clonePayload);

    for (const msg of result.messages) {
      console.log(chalk.blue(msg));
    }

    if (!result.success) {
      console.error(chalk.red(`Failed to clone instance: ${result.error || "Unknown error during clone operation."}`));
      return;
    }

    console.log(chalk.bold.green(`\nInstance "${newName}" cloned!`));
    const protocol = result.instance.useHttps && result.certbotSuccess ? "https" : "http";
    const publicBaseUrl = `${protocol}://${result.instance.domain}`;
    const localAdminUrl = `http://127.0.0.1:${result.instance.port}/_/`;
    console.log(chalk.blue("\nNew Cloned Instance Details:"));
    console.log(chalk.blue(`  Public URL: ${publicBaseUrl}/_/`));
    console.log(chalk.yellow("Remember that all data, including users and admins, has been cloned from the source instance."));
    if (!createAdminCli) {
      console.log(chalk.yellow(`You can access the admin panel for "${newName}" using existing credentials from "${sourceName}" or create/reset admins via the UI or 'pb-manager reset-admin ${newName}'.`));
    }
    console.log(chalk.yellow(`   - Public Admin: ${publicBaseUrl}/_/`));
    console.log(chalk.yellow(`   - Local Admin (direct access): ${localAdminUrl}`));
    if (result.instance.useHttps && !result.certbotSuccess && httpsAnswers.autoRunCertbot) {
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
    const { confirmUpdate } = await inquirer.prompt([{ type: "confirm", name: "confirmUpdate", message: `This will run '${POCKETBASE_EXEC_PATH} update' to fetch the latest PocketBase binary and then restart ALL managed instances. Do you want to proceed?`, default: true }]);
    if (!confirmUpdate) {
      console.log(chalk.yellow("PocketBase update cancelled by user."));
      return;
    }

    const result = await _internalUpdatePocketBaseExecutable();

    for (const msg of result.messages) {
      console.log(result.success ? chalk.green(msg) : chalk.yellow(msg));
    }

    if (!result.success) {
      console.error(chalk.red(`PocketBase update process failed: ${result.error || "Unknown error."}`));
    } else {
      console.log(chalk.bold.green("PocketBase update and instance restarts completed."));
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
    const { confirm } = await inquirer.prompt([{ type: "confirm", name: "confirm", message: `Are you sure you want to remove instance "${name}"? This will stop it, remove its PM2 entry, and Nginx config. Data directory will NOT be deleted automatically by this step.`, default: false }]);
    if (!confirm) {
      console.log(chalk.yellow("Removal cancelled."));
      return;
    }
    const { confirmTyped } = await inquirer.prompt([{ type: "input", name: "confirmTyped", message: `To confirm removal of instance "${name}", please type its name again:` }]);
    if (confirmTyped !== name) {
      console.log(chalk.yellow("Instance name did not match. Removal cancelled."));
      return;
    }

    let deleteData = false;
    const { confirmDeleteData } = await inquirer.prompt([{ type: "confirm", name: "confirmDeleteData", message: `Do you want to permanently delete the data directory ${config.instances[name].dataDir} for the removed instance "${name}"? ${chalk.bold.red("THIS CANNOT BE UNDONE.")}`, default: false }]);
    if (confirmDeleteData) {
      const { confirmTypedDeleteData } = await inquirer.prompt([{ type: "input", name: "confirmTypedDeleteData", message: `To confirm PERMANENT DELETION of data for "${name}", type the instance name again:` }]);
      if (confirmTypedDeleteData === name) {
        deleteData = true;
      } else {
        console.log(chalk.yellow("Instance name did not match for data deletion. Data directory NOT deleted."));
      }
    }

    const result = await _internalRemoveInstance({ name, deleteData });

    for (const msg of result.messages) {
      console.log(chalk.blue(msg));
    }

    if (result.success) {
      console.log(chalk.bold.green(`Instance "${name}" removed process completed.`));
    } else {
      console.error(chalk.red(`Failed to remove instance: ${result.error || "Unknown error."}`));
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
      console.log(`\n  ${chalk.bold(inst.name)}:\n    Domain: ${chalk.green(inst.domain)} (${inst.protocol})\n    Public URL: ${chalk.green(inst.publicUrl)}\n    Internal Port: ${chalk.yellow(inst.internalPort)}\n    Data Directory: ${inst.dataDirectory}\n    PM2 Status: ${inst.pm2Status === PM2_STATUS_ONLINE ? chalk.green(inst.pm2Status) : chalk.red(inst.pm2Status)}\n    Admin URL (local): ${inst.adminURL}\n    Certificate expires in: ${inst.certExpiryDays} day(s)`);
    }
  });

async function handlePm2Action(action, instanceNameOrAll) {
  const config = await getInstancesConfig();
  const targets = [];
  if (instanceNameOrAll && instanceNameOrAll.toLowerCase() === "all") {
    targets.push(...Object.keys(config.instances));
  } else if (instanceNameOrAll) {
    if (!config.instances[instanceNameOrAll]) {
      console.error(chalk.red(`Instance "${instanceNameOrAll}" not found.`));
      return;
    }
    targets.push(instanceNameOrAll);
  } else {
    console.log(chalk.yellow(`Please specify an instance name or 'all'. Usage: pb-manager ${action} <name|all>`));
    return;
  }

  if (targets.length === 0) {
    console.log(chalk.yellow(`No instances configured to ${action}.`));
    return;
  }

  const capitalizedAction = action.charAt(0).toUpperCase() + action.slice(1);
  console.log(chalk.blue(`${capitalizedAction}ing ${targets.length > 1 ? "all managed" : ""} instance(s)...`));
  let allProcessedSuccessfully = true;

  for (const targetName of targets) {
    try {
      await safeRunCommand("pm2", [action, `${PM2_INSTANCE_PREFIX}${targetName}`], `Failed to ${action} instance ${PM2_INSTANCE_PREFIX}${targetName}`);
      console.log(chalk.green(`Instance ${PM2_INSTANCE_PREFIX}${targetName} ${action}ed.`));
    } catch (e) {
      console.error(chalk.red(`Failed to ${action} instance ${PM2_INSTANCE_PREFIX}${targetName}: ${e.message}`));
      allProcessedSuccessfully = false;
    }
  }

  if (allProcessedSuccessfully) {
    console.log(chalk.bold.green(`All instances processed for ${action}ing.`));
  } else {
    console.log(chalk.bold.yellow(`Some instances may not have ${action}ed correctly. Check PM2 logs.`));
  }
}

program
  .command("start [name]")
  .description("Start a specific PocketBase instance or all instances via PM2")
  .action(async (name) => {
    await handlePm2Action("start", name);
  });

program
  .command("stop [name]")
  .description("Stop a specific PocketBase instance or all instances via PM2")
  .action(async (name) => {
    await handlePm2Action("stop", name);
  });

program
  .command("restart [name]")
  .description("Restart a specific PocketBase instance or all instances via PM2")
  .action(async (name) => {
    await handlePm2Action("restart", name);
  });

program
  .command("logs <name>")
  .description("Show logs for a specific PocketBase instance from PM2")
  .action((name) => {
    console.log(chalk.blue(`Displaying logs for ${PM2_INSTANCE_PREFIX}${name}. Press Ctrl+C to exit.`));
    shell.exec(`pm2 logs ${PM2_INSTANCE_PREFIX}${name} --lines 50`);
  });

program
  .command("audit")
  .description("Show the audit log of commands executed by this CLI")
  .action(async () => {
    const auditLogPath = path.join(CONFIG_DIR, AUDIT_LOG_FILE);
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
    const result = await _internalUpdateEcosystemAndReloadPm2();
    for (const msg of result.messages) {
      console.log(result.success ? chalk.green(msg) : chalk.red(msg));
    }
    if (!result.success) {
      console.error(chalk.red(`Failed to update ecosystem: ${result.error || "Unknown error."}`));
    }
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
    const { confirm } = await inquirer.prompt([{ type: "confirm", name: "confirm", message: `Are you sure you want to reset instance "${name}"? This will ${chalk.red.bold("DELETE ALL DATA")} in ${dataDir} and start from zero. This action cannot be undone.`, default: false }]);
    if (!confirm) {
      console.log(chalk.yellow("Reset cancelled."));
      return;
    }
    const { confirmTyped } = await inquirer.prompt([{ type: "input", name: "confirmTyped", message: `To confirm PERMANENT DELETION of all data for instance "${name}", please type its name again:` }]);
    if (confirmTyped !== name) {
      console.log(chalk.yellow("Instance name did not match. Reset cancelled."));
      return;
    }

    let adminPayload = { createAdmin: false };
    const { createAdminCli } = await inquirer.prompt([{ type: "confirm", name: "createAdminCli", message: "Do you want to create a new superuser (admin) account for this reset instance via CLI now?", default: true }]);
    if (createAdminCli) {
      const adminCredentials = await inquirer.prompt([
        { type: "input", name: "adminEmail", message: "Enter admin email:", validate: (input) => (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input) ? true : "Please enter a valid email.") },
        { type: "password", name: "adminPassword", message: "Enter admin password (min 8 chars):", mask: "*", validate: (input) => (input.length >= 8 ? true : "Password must be at least 8 characters.") },
      ]);
      adminPayload = { createAdmin: true, adminEmail: adminCredentials.adminEmail, adminPassword: adminCredentials.adminPassword };
    }

    const resetPayload = { name, ...adminPayload };
    const result = await _internalResetInstance(resetPayload);

    for (const msg of result.messages) {
      console.log(result.success ? chalk.green(msg) : chalk.yellow(msg));
    }

    if (!result.success) {
      console.error(chalk.red(`Failed to reset instance: ${result.error || "Unknown error."}`));
    } else {
      console.log(chalk.bold.green(`Instance "${name}" reset process completed.`));
    }
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

    const adminCredentials = await inquirer.prompt([
      { type: "input", name: "adminEmail", message: "Enter admin email to reset:", validate: (input) => (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input) ? true : "Please enter a valid email.") },
      { type: "password", name: "adminPassword", message: "Enter new admin password (min 8 chars):", mask: "*", validate: (input) => (input.length >= 8 ? true : "Password must be at least 8 characters.") },
    ]);

    const resetPayload = { name, adminEmail: adminCredentials.adminEmail, adminPassword: adminCredentials.adminPassword };
    const result = await _internalResetAdminPassword(resetPayload);

    for (const msg of result.messages) {
      console.log(result.success ? chalk.green(msg) : chalk.red(msg));
    }

    if (!result.success) {
      console.error(chalk.red(`Failed to reset admin password: ${result.error || "Unknown error."}`));
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

    const targetInstanceName = instanceName && instanceName.toLowerCase() !== "all" ? instanceName : "all";
    let domainForPrompt = targetInstanceName;
    if (targetInstanceName !== "all") {
      const config = await getInstancesConfig();
      const instance = config.instances[targetInstanceName];
      if (!instance || !instance.useHttps) {
        console.error(chalk.red(`Instance "${targetInstanceName}" not found or does not use HTTPS.`));
        return;
      }
      domainForPrompt = instance.domain;
    }

    const certbotArgs = ["renew"];
    if (targetInstanceName !== "all") certbotArgs.push("--cert-name", domainForPrompt);
    if (options.force) certbotArgs.push("--force-renewal");

    const { confirmRenew } = await inquirer.prompt([{ type: "confirm", name: "confirmRenew", message: `This will run Certbot to renew certificates. Command: sudo certbot ${certbotArgs.join(" ")}. Proceed?`, default: true }]);
    if (!confirmRenew) {
      console.log(chalk.yellow("Certificate renewal cancelled by user."));
      return;
    }

    const renewPayload = { instanceName: targetInstanceName === "all" ? null : targetInstanceName, force: options.force || false };
    const result = await _internalRenewCertificates(renewPayload);

    for (const msg of result.messages) {
      console.log(result.success ? chalk.green(msg) : chalk.red(msg));
    }
    if (!result.success) {
      console.error(chalk.red(`Certificate renewal failed: ${result.error || "Unknown error."}`));
    }
  });

program
  .command("update-pb-manager")
  .description("Update pb-manager itself from the latest version on GitHub")
  .action(async () => {
    const SCRIPT_URL = `${PB_MANAGER_UPDATE_SCRIPT_URL_BASE}${PB_MANAGER_SCRIPT_NAME}`;
    const CHECKSUM_URL = `${SCRIPT_URL}.sha256`;
    let installPath = process.argv[1];
    if (!installPath || !installPath.endsWith(PB_MANAGER_SCRIPT_NAME)) {
      installPath = DEFAULT_INSTALL_PATH_PB_MANAGER;
    }
    console.log(chalk.cyan(`Attempting to update pb-manager from ${SCRIPT_URL}`));
    const { confirmUpdateSelf } = await inquirer.prompt([{ type: "confirm", name: "confirmUpdateSelf", message: `This will download the latest version of pb-manager from GitHub and overwrite the current script at ${installPath}. Are you sure you want to proceed?`, default: true }]);
    if (!confirmUpdateSelf) {
      console.log(chalk.yellow("pb-manager update cancelled by user."));
      return;
    }

    try {
      const [scriptResponse, checksumResponse] = await Promise.all([axios.get(SCRIPT_URL, { responseType: "text" }), axios.get(CHECKSUM_URL, { responseType: "text" }).catch(() => null)]);
      const newScriptContent = scriptResponse.data;
      if (checksumResponse && checksumResponse.data) {
        const expectedChecksum = checksumResponse.data.trim().split(" ")[0];
        const hash = crypto.createHash("sha256");
        hash.update(newScriptContent);
        const downloadedChecksum = hash.digest("hex");
        if (downloadedChecksum !== expectedChecksum) {
          console.error(chalk.red("Checksum mismatch! Update aborted. The downloaded file may be compromised or outdated."));
          console.log(chalk.yellow(`Expected: ${expectedChecksum}, Got: ${downloadedChecksum}`));
          return;
        }
        console.log(chalk.green("Checksum verified."));
      } else {
        console.log(chalk.yellow("Could not fetch checksum. Proceeding without verification."));
      }

      const tempInstallPath = `${installPath}.${Date.now()}.tmp`;
      await fs.writeFile(tempInstallPath, newScriptContent, { mode: 0o755 });
      await safeRunCommand("sudo", ["mv", tempInstallPath, installPath], `Failed to move updated script to ${installPath}`);
      console.log(chalk.green(`pb-manager.js updated at ${installPath}`));
    } catch (e) {
      console.error(chalk.red("Failed to download or write pb-manager.js:"), e.message);
      process.exit(1);
    }

    const { reinstall } = await inquirer.prompt([{ type: "confirm", name: "reinstall", message: "Do you want to reinstall Node.js dependencies (npm install) in the install directory? This is recommended if the update included dependency changes.", default: true }]);
    if (reinstall) {
      try {
        const installDir = path.dirname(installPath);
        console.log(chalk.cyan("Running npm install..."));
        await safeRunCommand("npm", ["install"], "Failed to install dependencies", false, { cwd: installDir });
        console.log(chalk.green("Dependencies installed."));
      } catch (e) {
        console.error(chalk.red("Failed to install dependencies:"), e.message);
      }
    }
    console.log(chalk.bold.green("pb-manager has been updated. Please re-run your command if needed."));
    process.exit(0);
  });

program.hook("preAction", async (thisCommand, actionCommand) => {
  currentCommandNameForAudit = actionCommand.name();
  currentCommandArgsForAudit = process.argv.slice(3).join(" ");
  try {
    await fs.ensureDir(CONFIG_DIR);
    const cliConfig = await getCliConfig();
    completeLogging = cliConfig.completeLogging || false;
    const cachedLatestVersion = await getCachedLatestVersion();
    if (cliConfig.defaultPocketBaseVersion && cachedLatestVersion && cliConfig.defaultPocketBaseVersion !== cachedLatestVersion && actionCommand.name() !== "update-pocketbase" && actionCommand.name() !== "setup" && actionCommand.name() !== "configure") {
      console.log(chalk.yellow(`A new version of PocketBase (v${cachedLatestVersion}) has been released. Your default is v${cliConfig.defaultPocketBaseVersion}. Consider running 'pb-manager update-pocketbase' or 'pb-manager configure' to update the default.`));
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
    configure                          Set or view CLI configurations (default Certbot email, PB version, logging)

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
  if (process.geteuid && process.geteuid() !== 0) {
    console.error(chalk.red("You must run this script as root or with sudo. This is required for managing system services and configurations."));
    process.exit(1);
  }

  await detectDistro();
  const cliConfig = await getCliConfig();
  completeLogging = cliConfig.completeLogging || false;

  if (process.argv[2] !== "setup" && process.argv[2] !== "configure" && process.argv[2] !== "update-pb-manager") {
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
  const foundCommand = program.commands.find((cmd) => cmd.name() === process.argv[2]);
  if (foundCommand) {
    program.runningCommand = foundCommand;
  }
  await parsedCommand;
}

main().catch(async (err) => {
  console.error(chalk.red("An unexpected error occurred:"), err.message);
  await appendAuditLog(currentCommandNameForAudit, currentCommandArgsForAudit, err);
  const cliConfig = await getCliConfig().catch(() => ({ completeLogging: false }));
  if (err.stack && (cliConfig.completeLogging || process.env.DEBUG)) {
    console.error(err.stack);
  }
  process.exit(1);
});
