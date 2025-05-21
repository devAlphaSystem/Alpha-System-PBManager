#!/usr/bin/env node

const express = require("express");
const bodyParser = require("body-parser");
const shell = require("shelljs");
const fs = require("fs-extra");
const path = require("node:path");
const chalk = require("chalk");
const os = require("node:os");

const dotenv = require("dotenv");
dotenv.config();

const API_PORT = process.env.API_PORT || 3001;
const EXTERNAL_API_TOKEN = process.env.EXTERNAL_API_TOKEN || "yourClientFacingSecretToken123abcXYZ";
const PB_MANAGER_SCRIPT_PATH = path.join(__dirname, "pb-manager.js");

const CONFIG_DIR = path.join(process.env.HOME || os.homedir(), ".pb-manager");
const CLI_CONFIG_PATH = path.join(CONFIG_DIR, "cli-config.json");

let pbManagerCliApiSecret = null;
let pbManagerCliApiEnabled = false;

async function loadPbManagerCliConfig() {
  try {
    if (await fs.pathExists(CLI_CONFIG_PATH)) {
      const config = await fs.readJson(CLI_CONFIG_PATH);
      if (config.api?.secret) {
        pbManagerCliApiSecret = config.api.secret;
        pbManagerCliApiEnabled = !!config.api.enabled;
        console.log(chalk.blue(`pb-manager CLI API mode: ${pbManagerCliApiEnabled ? "Enabled" : "Disabled"}. Secret loaded.`));
      } else {
        console.log(chalk.yellow("pb-manager CLI config found, but API secret/enabled flag not set. Internal calls will be limited."));
      }
    } else {
      console.log(chalk.yellow("pb-manager CLI config not found. Internal calls will be limited."));
    }
  } catch (e) {
    console.error(chalk.red(`Error loading pb-manager CLI config: ${e.message}`));
  }
}

if (!EXTERNAL_API_TOKEN) {
  console.error(chalk.red("EXTERNAL_API_TOKEN environment variable is not set. API server cannot start."));
  process.exit(1);
}

if (!fs.existsSync(PB_MANAGER_SCRIPT_PATH)) {
  console.error(chalk.red(`pb-manager.js not found at ${PB_MANAGER_SCRIPT_PATH}. Make sure it's in the same directory as pb-manager-api.js.`));
  process.exit(1);
}

const app = express();
app.use(bodyParser.json());

app.use((req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthorized: Missing or malformed Bearer token" });
  }
  const token = authHeader.split(" ")[1];
  if (token !== EXTERNAL_API_TOKEN) {
    return res.status(403).json({ error: "Forbidden: Invalid API token" });
  }
  next();
});

function executePbManagerCommand(commandArgs, isJsonOutput = false, useInternal = false, payload = null) {
  let fullCommand;
  let jsonOutput = isJsonOutput;
  const actionForLog = useInternal ? commandArgs : commandArgs.split(" ")[0];

  if (useInternal && pbManagerCliApiEnabled && pbManagerCliApiSecret) {
    const payloadString = payload ? Buffer.from(JSON.stringify(payload)).toString("base64") : "";
    fullCommand = `sudo node ${PB_MANAGER_SCRIPT_PATH} _internal-api-request --secret "${pbManagerCliApiSecret}" --action ${commandArgs} ${payload ? `--payload ${payloadString}` : ""}`;
    jsonOutput = true;
  } else {
    fullCommand = `sudo node ${PB_MANAGER_SCRIPT_PATH} ${commandArgs}`;
  }

  console.log(chalk.blue(`API executing (Action: ${actionForLog}): ${fullCommand.replace(pbManagerCliApiSecret || "DUMMY_SECRET_FOR_LOGGING", "********")}`));
  const result = shell.exec(fullCommand, { silent: true });

  if (result.code !== 0) {
    console.error(chalk.red(`API command failed (Action: ${actionForLog}). Code: ${result.code}. Command: ${fullCommand.replace(pbManagerCliApiSecret || "DUMMY_SECRET_FOR_LOGGING", "********")}\nStderr: ${result.stderr}\nStdout: ${result.stdout}`));
    return {
      success: false,
      error: `Command failed with code ${result.code}`,
      stderr: result.stderr,
      stdout: result.stdout,
    };
  }

  if (jsonOutput) {
    try {
      const parsed = JSON.parse(result.stdout);

      if (parsed.success === false) {
        console.error(chalk.yellow(`Internal pb-manager command reported failure. Action: ${actionForLog}. Error: ${parsed.error || JSON.stringify(parsed)}. Full stdout: ${result.stdout}`));
        return {
          success: false,
          error: parsed.error || "Internal command failed",
          details: parsed.messages || parsed,
          rawStdout: result.stdout,
        };
      }
      return {
        success: true,
        data: parsed.data !== undefined ? parsed.data : parsed,
        messages: parsed.messages,
      };
    } catch (e) {
      console.error(chalk.red(`API command JSON parse error. Action: ${actionForLog}. Error: ${e.message}\nRaw Stdout from pb-manager.js: >>>${result.stdout}<<<`));
      return {
        success: false,
        error: "Failed to parse JSON output from command",
        stdout: result.stdout,
        rawStdout: result.stdout,
      };
    }
  }
  return { success: true, data: result.stdout, messages: [] };
}

app.get("/api/v1/instances", async (req, res) => {
  const result = executePbManagerCommand("listInstances", true, true);
  if (result.success) {
    res.json(result.data);
  } else {
    console.log(chalk.yellow("Internal listInstances failed or not configured, falling back to 'list --json'"));
    const fallbackResult = executePbManagerCommand("list --json", true);
    if (fallbackResult.success) {
      res.json(fallbackResult.data);
    } else {
      res.status(500).json({
        error: fallbackResult.error,
        details: fallbackResult.stderr || fallbackResult.stdout,
      });
    }
  }
});

app.post("/api/v1/instances/:name/start", async (req, res) => {
  const { name } = req.params;
  const action = "start";
  if (!/^[a-zA-Z0-9-]+$/.test(name)) {
    return res.status(400).json({ error: "Invalid instance name format." });
  }
  const result = executePbManagerCommand(`${action} ${name}`);
  if (result.success) {
    res.json({
      success: true,
      message: `Instance ${name} ${action} command issued.`,
      output: result.data,
    });
  } else {
    res.status(500).json({
      success: false,
      error: `Failed to ${action} instance ${name}`,
      details: result.stderr || result.stdout,
    });
  }
});

app.post("/api/v1/instances/:name/stop", async (req, res) => {
  const { name } = req.params;
  const action = "stop";
  if (!/^[a-zA-Z0-9-]+$/.test(name)) {
    return res.status(400).json({ error: "Invalid instance name format." });
  }
  const result = executePbManagerCommand(`${action} ${name}`);
  if (result.success) {
    res.json({
      success: true,
      message: `Instance ${name} ${action} command issued.`,
      output: result.data,
    });
  } else {
    res.status(500).json({
      success: false,
      error: `Failed to ${action} instance ${name}`,
      details: result.stderr || result.stdout,
    });
  }
});

app.post("/api/v1/instances/:name/restart", async (req, res) => {
  const { name } = req.params;
  const action = "restart";
  if (!/^[a-zA-Z0-9-]+$/.test(name)) {
    return res.status(400).json({ error: "Invalid instance name format." });
  }
  const result = executePbManagerCommand(`${action} ${name}`);
  if (result.success) {
    res.json({
      success: true,
      message: `Instance ${name} ${action} command issued.`,
      output: result.data,
    });
  } else {
    res.status(500).json({
      success: false,
      error: `Failed to ${action} instance ${name}`,
      details: result.stderr || result.stdout,
    });
  }
});

app.post("/api/v1/instances", async (req, res) => {
  const instanceDetails = req.body;
  if (!instanceDetails.name || !instanceDetails.domain || !instanceDetails.port) {
    return res.status(400).json({ error: "Missing required fields: name, domain, port" });
  }

  const result = executePbManagerCommand("addInstance", true, true, instanceDetails);
  if (result.success) {
    res.status(201).json(result);
  } else {
    res.status(400).json({
      error: result.error || "Failed to add instance",
      details: result.details || result.stderr,
      messages: result.messages,
      rawStdout: result.rawStdout,
    });
  }
});

app.delete("/api/v1/instances/:name", async (req, res) => {
  const { name } = req.params;
  if (!/^[a-zA-Z0-9-]+$/.test(name)) {
    return res.status(400).json({ error: "Invalid instance name format." });
  }

  const result = executePbManagerCommand("removeInstance", true, true, {
    name,
  });
  if (result.success) {
    res.json(result);
  } else {
    res.status(500).json({
      error: result.error || `Failed to remove instance ${name}`,
      details: result.details || result.stderr,
      messages: result.messages,
      rawStdout: result.rawStdout,
    });
  }
});

app.get("/api/v1/cli-config", async (req, res) => {
  try {
    if (await fs.pathExists(CLI_CONFIG_PATH)) {
      const cliConfigData = await fs.readJson(CLI_CONFIG_PATH);
      res.json(cliConfigData);
    } else {
      res.status(404).json({ error: "CLI configuration file not found." });
    }
  } catch (error) {
    console.error(chalk.red(`API GET /cli-config error: ${error.message}`));
    res.status(500).json({ error: "Failed to read CLI configuration", details: error.message });
  }
});

app.get("/api/v1/system/global-stats", async (req, res) => {
  const result = executePbManagerCommand("getGlobalStats", true, true);
  if (result.success) {
    res.json(result.data);
  } else {
    res.status(500).json({
      error: result.error || "Failed to get global stats",
      details: result.details || result.stderr,
      messages: result.messages,
      rawStdout: result.rawStdout,
    });
  }
});

app.get("/api/v1/instances/:name/logs", async (req, res) => {
  const { name } = req.params;
  const lines = req.query.lines || 100;
  if (!/^[a-zA-Z0-9-]+$/.test(name)) {
    return res.status(400).json({ error: "Invalid instance name format." });
  }

  const result = executePbManagerCommand("getInstanceLogs", true, true, { name, lines: Number.parseInt(lines, 10) });
  if (result.success) {
    res.json(result);
  } else {
    const statusCode = result.error?.includes("not found") ? 404 : 500;
    res.status(statusCode).json({
      error: result.error || `Failed to get logs for instance ${name}`,
      details: result.details || result.stderr,
      messages: result.messages,
      rawStdout: result.rawStdout,
    });
  }
});

app.post("/api/v1/instances/clone", async (req, res) => {
  const cloneDetails = req.body;
  if (!cloneDetails.sourceName || !cloneDetails.newName || !cloneDetails.domain || !cloneDetails.port) {
    return res.status(400).json({ error: "Missing required fields for clone: sourceName, newName, domain, port" });
  }
  const result = executePbManagerCommand("cloneInstance", true, true, cloneDetails);
  if (result.success) {
    res.status(201).json(result);
  } else {
    res.status(400).json({
      error: result.error || "Failed to clone instance",
      details: result.details || result.stderr,
      messages: result.messages,
      rawStdout: result.rawStdout,
    });
  }
});

app.post("/api/v1/instances/:name/reset", async (req, res) => {
  const { name } = req.params;
  const resetDetails = req.body || {};
  if (!/^[a-zA-Z0-9-]+$/.test(name)) {
    return res.status(400).json({ error: "Invalid instance name format." });
  }
  const payload = { name, ...resetDetails };
  const result = executePbManagerCommand("resetInstance", true, true, payload);
  if (result.success) {
    res.json(result);
  } else {
    res.status(500).json({
      error: result.error || `Failed to reset instance ${name}`,
      details: result.details || result.stderr,
      messages: result.messages,
      rawStdout: result.rawStdout,
    });
  }
});

app.post("/api/v1/instances/:name/reset-admin", async (req, res) => {
  const { name } = req.params;
  const { adminEmail, adminPassword } = req.body;
  if (!/^[a-zA-Z0-9-]+$/.test(name)) {
    return res.status(400).json({ error: "Invalid instance name format." });
  }
  if (!adminEmail || !adminPassword) {
    return res.status(400).json({ error: "Missing adminEmail or adminPassword in payload." });
  }
  const result = executePbManagerCommand("resetAdminPassword", true, true, { name, adminEmail, adminPassword });
  if (result.success) {
    res.json(result);
  } else {
    res.status(500).json({
      error: result.error || `Failed to reset admin password for instance ${name}`,
      details: result.details || result.stderr,
      messages: result.messages,
      rawStdout: result.rawStdout,
    });
  }
});

app.post("/api/v1/certificates/renew", async (req, res) => {
  const { instanceName, force } = req.body;
  const result = executePbManagerCommand("renewCertificates", true, true, { instanceName, force });
  if (result.success) {
    res.json(result);
  } else {
    res.status(500).json({
      error: result.error || "Failed to renew certificates",
      details: result.details || result.stderr,
      messages: result.messages,
      rawStdout: result.rawStdout,
    });
  }
});

app.post("/api/v1/pocketbase/update-executable", async (req, res) => {
  const result = executePbManagerCommand("updatePocketBaseExecutable", true, true);
  if (result.success) {
    res.json(result);
  } else {
    res.status(500).json({
      error: result.error || "Failed to update PocketBase executable",
      details: result.details || result.stderr,
      messages: result.messages,
      rawStdout: result.rawStdout,
    });
  }
});

app.post("/api/v1/system/update-ecosystem", async (req, res) => {
  const result = executePbManagerCommand("updateEcosystemAndReloadPm2", true, true);
  if (result.success) {
    res.json(result);
  } else {
    res.status(500).json({
      error: result.error || "Failed to update ecosystem and reload PM2",
      details: result.details || result.stderr,
      messages: result.messages,
      rawStdout: result.rawStdout,
    });
  }
});

app.post("/api/v1/cli-config/default-certbot-email", async (req, res) => {
  const { email } = req.body;
  if (email !== null && typeof email !== "string") {
    return res.status(400).json({ error: "Invalid payload: 'email' must be a string or null." });
  }
  const result = executePbManagerCommand("setDefaultCertbotEmail", true, true, { email });
  if (result.success) {
    res.json(result);
  } else {
    res.status(500).json({
      error: result.error || "Failed to set default Certbot email",
      details: result.details || result.stderr,
      messages: result.messages,
      rawStdout: result.rawStdout,
    });
  }
});

app.get("/api/v1/system/status", (req, res) => {
  try {
    const cpus = os.cpus();
    const cpuInfo = [];
    for (let i = 0; i < cpus.length; i++) {
      cpuInfo.push({ model: cpus[i].model, speed: cpus[i].speed });
    }
    const status = {
      hostname: os.hostname(),
      platform: os.platform(),
      release: os.release(),
      uptime: os.uptime(),
      arch: os.arch(),
      cpuCount: cpus.length,
      cpuInfo: cpuInfo.length > 0 ? cpuInfo[0] : { model: "N/A", speed: 0 },
      totalMemory: os.totalmem(),
      freeMemory: os.freemem(),
      loadAverage: os.loadavg(),
      timestamp: new Date().toISOString(),
    };
    res.json({ success: true, data: status });
  } catch (error) {
    console.error(chalk.red(`API GET /system/status error: ${error.message}`));
    res.status(500).json({ success: false, error: "Failed to retrieve system status", details: error.message });
  }
});

app.use((err, req, res, next) => {
  console.error(chalk.red(`API Unhandled Error: ${err.stack || err.message}`));
  res.status(500).json({ error: "Internal Server Error" });
});

async function startApiServer() {
  await loadPbManagerCliConfig();
  app.listen(API_PORT, () => {
    console.log(chalk.green(`pb-manager API server started on http://localhost:${API_PORT}`));
    console.log(chalk.yellow("Ensure this server is secured if exposed externally and the user running it has appropriate (passwordless) sudo access for pb-manager.js commands."));
    console.log(chalk.cyan(`Using EXTERNAL API Token: ${EXTERNAL_API_TOKEN.substring(0, 4)}... (masked)`));
  });
}

startApiServer();
