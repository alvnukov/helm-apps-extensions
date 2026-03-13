#!/usr/bin/env node
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { spawn, execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { pathToFileURL } = require("node:url");
const YAML = require("yaml");

const execFileAsync = promisify(execFile);
const IGNORE_DIRS = new Set([".git", "node_modules", "vendor", "tmp", ".werf", "templates"]);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.file || !args.group || !args.app) {
    printUsage();
    process.exitCode = 2;
    return;
  }

  const currentPath = path.resolve(args.file);
  const documentText = await fsp.readFile(currentPath, "utf8");
  const chartYaml = await findNearestChartYaml(currentPath);
  if (!chartYaml) {
    throw new Error(`Chart.yaml not found for ${currentPath}`);
  }
  const chartDir = path.dirname(chartYaml);
  const env = String(args.env || "").trim();
  const backend = args.backend;
  const happPath = args["happ-path"] || "happ";
  const happ = new HappLspSession(happPath);
  try {
    await happ.start();
    const listed = await happ.request("happ/listEntities", {
      uri: pathToFileURL(currentPath).toString(),
      text: documentText,
      env,
      applyIncludes: true,
      applyEnvResolution: true,
    });
    const effectiveEnv = env || String(listed.defaultEnv || "").trim();

    printPlan({
      backend,
      file: currentPath,
      chartDir,
      env: effectiveEnv,
      valuesFiles: [],
      isolationSetValues: [],
      command: `${happPath} lsp --stdio=true -> happ/renderEntityManifest(renderer=${backend})`,
    });

    if (args["plan-only"]) {
      return;
    }

    const manifest = await happ.request("happ/renderEntityManifest", {
      uri: pathToFileURL(currentPath).toString(),
      text: documentText,
      group: args.group,
      app: args.app,
      env: effectiveEnv,
      renderer: backend,
      applyIncludes: true,
      applyEnvResolution: true,
    });
    process.stdout.write(ensureTrailingNewline(String(manifest.manifest || "")));
  } finally {
    await happ.stop();
  }
}

function printUsage() {
  process.stderr.write(
    "usage: node scripts/run-manifest-preview.js --file <values.yaml> --group <apps-*> --app <name> [--env <env>] [--backend fast|helm|werf] [--happ-path <bin>] [--helm-path <bin>] [--plan-only]\n",
  );
}

function parseArgs(argv) {
  const out = { backend: "fast", "plan-only": false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq >= 0) {
      out[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const key = arg.slice(2);
    if (key === "plan-only") {
      out[key] = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`missing value for --${key}`);
    }
    out[key] = value;
    i += 1;
  }
  if (out.backend !== "fast" && out.backend !== "helm" && out.backend !== "werf") {
    throw new Error(`unsupported backend: ${String(out.backend)}`);
  }
  return out;
}

async function findNearestChartYaml(fromFile) {
  let dir = path.dirname(fromFile);
  const root = path.parse(dir).root;
  while (true) {
    const candidate = path.join(dir, "Chart.yaml");
    try {
      await fsp.access(candidate, fs.constants.R_OK);
      return candidate;
    } catch {
      if (dir === root) {
        return undefined;
      }
      dir = path.dirname(dir);
    }
  }
}

async function resolveWerfProjectDir(chartDir) {
  let current = chartDir;
  while (true) {
    const configPath = path.join(current, "werf.yaml");
    try {
      await fsp.access(configPath, fs.constants.R_OK);
      return current;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        return chartDir;
      }
      current = parent;
    }
  }
}

async function resolveManifestValuesFiles(currentPath, chartDir) {
  const rootDocuments = await findHelmAppsRootDocuments(chartDir);
  const primaryValues = await findPrimaryValuesFileForChart(chartDir);
  const includeOwners = await collectIncludeOwnersForChart(chartDir);
  return selectManifestValuesFiles({
    currentPath,
    rootDocuments,
    primaryValues,
    includeOwners: [...(includeOwners.get(path.resolve(currentPath)) || [])],
  });
}

async function findPrimaryValuesFileForChart(chartDir) {
  for (const candidate of [path.join(chartDir, "values.yaml"), path.join(chartDir, "values.yml")]) {
    try {
      await fsp.access(candidate, fs.constants.R_OK);
      return path.resolve(candidate);
    } catch {}
  }
  return undefined;
}

async function findHelmAppsRootDocuments(chartDir) {
  const files = [];
  await walkYamlFiles(chartDir, files);
  const documents = [];
  for (const filePath of files) {
    try {
      documents.push({
        filePath,
        text: await fsp.readFile(filePath, "utf8"),
      });
    } catch {}
  }
  return selectHelmAppsRootDocuments(documents);
}

async function walkYamlFiles(dir, out) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORE_DIRS.has(entry.name)) {
        await walkYamlFiles(fullPath, out);
      }
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    const lower = entry.name.toLowerCase();
    if (lower.endsWith(".yaml") || lower.endsWith(".yml")) {
      out.push(path.resolve(fullPath));
    }
  }
}

function looksLikeHelmAppsValuesText(text) {
  if (/\n?global:\s*/m.test(text) && /(?:^|\n)\s*_includes:\s*/m.test(text)) {
    return true;
  }
  if (/\n?global:\s*/m.test(text) && /(?:^|\n)\s*releases:\s*/m.test(text)) {
    return true;
  }
  if (/(?:^|\n)apps-[a-z0-9-]+:\s*/m.test(text)) {
    return true;
  }
  if (/(?:^|\n)\s*__GroupVars__:\s*/m.test(text)) {
    return true;
  }
  return false;
}

function selectHelmAppsRootDocuments(files) {
  const candidateRoots = new Set();
  const includedByOtherDocuments = new Set();

  for (const file of files) {
    const resolvedFilePath = path.resolve(file.filePath);
    if (looksLikeHelmAppsValuesText(file.text)) {
      candidateRoots.add(resolvedFilePath);
    }

    const baseDir = path.dirname(resolvedFilePath);
    for (const ref of collectIncludeFileRefs(file.text)) {
      for (const candidatePath of buildIncludeCandidates(ref.path, baseDir)) {
        const resolvedCandidatePath = path.resolve(candidatePath);
        if (resolvedCandidatePath !== resolvedFilePath) {
          includedByOtherDocuments.add(resolvedCandidatePath);
        }
      }
    }
  }

  return [...candidateRoots].filter((filePath) => !includedByOtherDocuments.has(filePath)).sort();
}

async function collectIncludeOwnersForChart(chartDir) {
  const owners = new Map();
  const roots = (await findHelmAppsRootDocuments(chartDir)).map((current) => path.resolve(current));

  for (const root of roots) {
    const visited = new Set();
    const queue = [root];
    while (queue.length > 0) {
      const current = path.resolve(String(queue.pop() || ""));
      if (!current || visited.has(current)) {
        continue;
      }
      visited.add(current);

      let text = "";
      try {
        text = await fsp.readFile(current, "utf8");
      } catch {
        continue;
      }

      const baseDir = path.dirname(current);
      for (const ref of collectIncludeFileRefs(text)) {
        if (isTemplatedIncludePath(ref.path)) {
          continue;
        }
        for (const candidate of buildIncludeCandidates(ref.path, baseDir)) {
          const includedPath = path.resolve(candidate);
          try {
            await fsp.access(includedPath, fs.constants.R_OK);
            if (!owners.has(includedPath)) {
              owners.set(includedPath, new Set());
            }
            owners.get(includedPath).add(root);
            if (!visited.has(includedPath)) {
              queue.push(includedPath);
            }
            break;
          } catch {}
        }
      }
    }
  }

  return owners;
}

function collectIncludeFileRefs(text) {
  const lines = text.split(/\r?\n/);
  const refs = [];
  const keyStack = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const keyMatch = line.match(/^(\s*)(_include_from_file|_include_files):\s*(.*)$/);
    if (!keyMatch) {
      const anyKeyMatch = line.match(/^(\s*)([A-Za-z0-9_.-]+):\s*(.*)$/);
      if (anyKeyMatch) {
        const indent = anyKeyMatch[1].length;
        while (keyStack.length > 0 && keyStack[keyStack.length - 1].indent >= indent) {
          keyStack.pop();
        }
        keyStack.push({ indent, key: anyKeyMatch[2] });
      }
      continue;
    }
    const indent = keyMatch[1].length;
    const key = keyMatch[2];
    const tail = keyMatch[3].trim();
    while (keyStack.length > 0 && keyStack[keyStack.length - 1].indent >= indent) {
      keyStack.pop();
    }
    keyStack.push({ indent, key });

    if (key === "_include_from_file") {
      const value = unquote(tail);
      if (value && !isTemplatedIncludePath(value)) {
        refs.push({ path: value, line: i });
      }
      continue;
    }

    if (tail.startsWith("[") && tail.endsWith("]")) {
      for (const part of tail.slice(1, -1).split(",")) {
        const value = unquote(part.trim());
        if (value && !isTemplatedIncludePath(value)) {
          refs.push({ path: value, line: i });
        }
      }
      continue;
    }

    for (let j = i + 1; j < lines.length; j += 1) {
      const sub = lines[j];
      const trimmed = sub.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }
      const subIndent = countIndent(sub);
      if (subIndent <= indent) {
        break;
      }
      const item = sub.match(/^\s*-\s+(.+)\s*$/);
      if (item) {
        const value = unquote(item[1].trim());
        if (value && !isTemplatedIncludePath(value)) {
          refs.push({ path: value, line: j });
        }
      }
    }
  }

  return refs;
}

function buildIncludeCandidates(rawPath, baseDir) {
  if (path.isAbsolute(rawPath)) {
    return [rawPath];
  }
  return [path.resolve(baseDir, rawPath)];
}

function isTemplatedIncludePath(value) {
  return value.includes("{{") || value.includes("}}");
}

function unquote(value) {
  const trimmed = String(value || "").trim();
  if (trimmed.length < 2) {
    return trimmed;
  }
  if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function countIndent(line) {
  const match = line.match(/^\s*/);
  return match ? match[0].length : 0;
}

function selectManifestValuesFiles(input) {
  const currentPath = path.resolve(input.currentPath);
  const normalizedRoots = new Set(input.rootDocuments.map((current) => path.resolve(current)));
  const primaryValues = input.primaryValues ? path.resolve(input.primaryValues) : undefined;
  const ownerCandidates = [...(input.includeOwners || [])]
    .map((current) => path.resolve(current))
    .sort((a, b) => a.localeCompare(b));

  if (ownerCandidates.length > 0) {
    if (primaryValues && ownerCandidates.includes(primaryValues)) {
      return [primaryValues];
    }
    return [ownerCandidates[0]];
  }
  if (normalizedRoots.has(currentPath)) {
    if (primaryValues && currentPath !== primaryValues) {
      return [primaryValues];
    }
    return [currentPath];
  }
  if (primaryValues) {
    return [primaryValues];
  }
  return [currentPath];
}

function buildManifestEntityIsolationSetValues(documentText, group, app) {
  const text = documentText || "";
  if (!text.trim()) {
    return null;
  }
  try {
    const parsed = YAML.parse(text);
    if (!isMap(parsed)) {
      return [`${escapeHelmSetPathSegment(group)}.${escapeHelmSetPathSegment(app)}.enabled=true`];
    }
    const overrides = [];
    let targetFound = false;
    for (const [groupName, groupValue] of Object.entries(parsed)) {
      if (groupName === "global" || !isMap(groupValue)) {
        continue;
      }
      for (const [appName, appValue] of Object.entries(groupValue)) {
        if (appName === "__GroupVars__" || !isMap(appValue)) {
          continue;
        }
        if (groupName === group && appName === app) {
          targetFound = true;
          overrides.push(`${escapeHelmSetPathSegment(groupName)}.${escapeHelmSetPathSegment(appName)}.enabled=true`);
          continue;
        }
        if (typeof appValue.enabled === "boolean" && appValue.enabled === true) {
          overrides.push(`${escapeHelmSetPathSegment(groupName)}.${escapeHelmSetPathSegment(appName)}.enabled=false`);
        }
      }
    }
    if (!targetFound) {
      return [`${escapeHelmSetPathSegment(group)}.${escapeHelmSetPathSegment(app)}.enabled=true`];
    }
    return overrides;
  } catch {
    return [`${escapeHelmSetPathSegment(group)}.${escapeHelmSetPathSegment(app)}.enabled=true`];
  }
}

function buildManifestEntityIsolationSetValuesFromEnabledEntities(enabledEntities, group, app) {
  const setValues = [`${escapeHelmSetPathSegment(group)}.${escapeHelmSetPathSegment(app)}.enabled=true`];
  const seen = new Set([`${group}\u0000${app}`]);
  for (const entity of enabledEntities) {
    const groupName = String(entity.group || "").trim();
    const appName = String(entity.app || "").trim();
    if (!groupName || !appName) {
      continue;
    }
    const key = `${groupName}\u0000${appName}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    setValues.push(`${escapeHelmSetPathSegment(groupName)}.${escapeHelmSetPathSegment(appName)}.enabled=false`);
  }
  return setValues;
}

function escapeHelmSetPathSegment(segment) {
  return String(segment)
    .replace(/\\/g, "\\\\")
    .replace(/\./g, "\\.")
    .replace(/,/g, "\\,")
    .replace(/=/g, "\\=")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]");
}

function resolveManifestBackendCommand(backend, configuredHelmPath) {
  const configured = String(configuredHelmPath || "").trim();
  const configuredBinary = path.basename(configured).toLowerCase();
  if (backend === "werf") {
    if (configured && configuredBinary === "werf") {
      return configured;
    }
    return "werf";
  }
  if (configured && configuredBinary !== "werf") {
    return configured;
  }
  return "helm";
}

function buildManifestBackendArgs(backend, chartDir, valuesFiles, isolationSetValues, env) {
  const valueArgs = valuesFiles
    .map((current) => String(current || "").trim())
    .filter(Boolean)
    .flatMap((current) => ["--values", current]);
  const setArgs = isolationSetValues
    .map((current) => String(current || "").trim())
    .filter(Boolean)
    .flatMap((current) => ["--set", current]);
  const normalizedEnv = String(env || "").trim();
  const withEnvSet = (base) => normalizedEnv
    ? [...base, "--set-string", `global.env=${normalizedEnv}`]
    : base;

  if (backend === "werf") {
    const args = ["render", "--dir", chartDir, "--dev", "--ignore-secret-key", ...valueArgs, ...setArgs];
    if (normalizedEnv) {
      args.push("--env", normalizedEnv);
    }
    return withEnvSet(args);
  }

  return withEnvSet(["template", "helm-apps-preview", chartDir, ...valueArgs, ...setArgs]);
}

function printPlan(plan) {
  process.stderr.write(
    [
      "[preview-runner]",
      `backend: ${plan.backend}`,
      `file: ${plan.file}`,
      `chartDir: ${plan.chartDir}`,
      `env: ${plan.env || "<empty>"}`,
      `valuesFiles: ${plan.valuesFiles.length > 0 ? plan.valuesFiles.join(", ") : "<none>"}`,
      `isolationSetValues: ${plan.isolationSetValues.length > 0 ? plan.isolationSetValues.join(", ") : "<none>"}`,
      `command: ${plan.command}`,
      "",
    ].join("\n"),
  );
}

function ensureTrailingNewline(text) {
  return text.endsWith("\n") ? text : `${text}\n`;
}

function isMap(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

class HappLspSession {
  constructor(command) {
    this.command = command;
    this.proc = undefined;
    this.buffer = Buffer.alloc(0);
    this.pending = new Map();
    this.nextId = 1;
    this.stderr = "";
    this.exited = false;
  }

  async start() {
    if (this.proc) {
      return;
    }
    this.proc = spawn(this.command, ["lsp", "--stdio=true"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc.stdout.on("data", (chunk) => this.onStdout(chunk));
    this.proc.stderr.on("data", (chunk) => {
      this.stderr += chunk.toString("utf8");
    });
    this.proc.on("exit", (code, signal) => {
      this.exited = true;
      const error = new Error(
        `happ lsp exited early (code=${code ?? "null"} signal=${signal ?? "null"})${this.stderr ? `\n${this.stderr.trim()}` : ""}`,
      );
      for (const pending of this.pending.values()) {
        pending.reject(error);
      }
      this.pending.clear();
    });

    await this.request("initialize", {
      processId: process.pid,
      rootUri: null,
      capabilities: {},
      clientInfo: {
        name: "helm-apps-preview-runner",
      },
      initializationOptions: {},
    });
    this.notify("initialized", {});
  }

  async stop() {
    if (!this.proc || this.exited) {
      return;
    }
    try {
      await this.request("shutdown", null);
    } catch {}
    try {
      this.notify("exit", null);
    } catch {}
    await new Promise((resolve) => {
      const proc = this.proc;
      if (!proc) {
        resolve();
        return;
      }
      proc.once("exit", () => resolve());
      setTimeout(() => {
        try {
          proc.kill("SIGTERM");
        } catch {}
        resolve();
      }, 300);
    });
  }

  request(method, params) {
    if (!this.proc || !this.proc.stdin.writable) {
      return Promise.reject(new Error("happ lsp is not running"));
    }
    const id = this.nextId++;
    const message = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };
    const payload = Buffer.from(JSON.stringify(message), "utf8");
    const header = Buffer.from(`Content-Length: ${payload.length}\r\n\r\n`, "utf8");
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc.stdin.write(Buffer.concat([header, payload]));
    });
  }

  notify(method, params) {
    if (!this.proc || !this.proc.stdin.writable) {
      return;
    }
    const message = {
      jsonrpc: "2.0",
      method,
      params,
    };
    const payload = Buffer.from(JSON.stringify(message), "utf8");
    const header = Buffer.from(`Content-Length: ${payload.length}\r\n\r\n`, "utf8");
    this.proc.stdin.write(Buffer.concat([header, payload]));
  }

  onStdout(chunk) {
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    while (true) {
      const headerEnd = this.buffer.indexOf(Buffer.from("\r\n\r\n"));
      if (headerEnd < 0) {
        return;
      }
      const headerText = this.buffer.slice(0, headerEnd).toString("utf8");
      const match = headerText.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        throw new Error(`invalid LSP header from happ: ${headerText}`);
      }
      const contentLength = Number(match[1]);
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + contentLength;
      if (this.buffer.length < bodyEnd) {
        return;
      }
      const body = this.buffer.slice(bodyStart, bodyEnd).toString("utf8");
      this.buffer = this.buffer.slice(bodyEnd);
      const message = JSON.parse(body);
      this.onMessage(message);
    }
  }

  onMessage(message) {
    if (Object.prototype.hasOwnProperty.call(message, "id")) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(String(message.error.message || "unknown happ lsp error")));
        return;
      }
      pending.resolve(message.result);
    }
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
