#!/usr/bin/env node
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { pathToFileURL } = require("node:url");

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
    } catch (_error) {
      void _error;
    }
    try {
      this.notify("exit", null);
    } catch (_error) {
      void _error;
    }
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
        } catch (_error) {
          void _error;
        }
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
