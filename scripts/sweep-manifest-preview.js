#!/usr/bin/env node
const fs = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { pathToFileURL } = require("node:url");

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.file) {
    printUsage();
    process.exitCode = 2;
    return;
  }

  const filePath = path.resolve(args.file);
  const documentText = await fs.readFile(filePath, "utf8");
  const requestedEnv = String(args.env || "").trim();
  const happPath = String(args["happ-path"] || "happ").trim() || "happ";
  const backends = resolveBackends(args.backend);
  const requestTimeoutMs = resolvePositiveInt(args["request-timeout-ms"], 30000);
  let session = new HappLspSession(happPath);

  try {
    await session.start();
    const listed = await requestWithTimeout(
      session,
      "happ/listEntities",
      {
        uri: pathToFileURL(filePath).toString(),
        text: documentText,
        env: requestedEnv,
        applyIncludes: true,
        applyEnvResolution: true,
      },
      requestTimeoutMs,
    );

    const effectiveEnv = requestedEnv || String(listed.defaultEnv || "").trim();
    const entities = Array.isArray(listed.groups)
      ? listed.groups.flatMap((group) =>
        Array.isArray(group.apps)
          ? group.apps.map((app) => ({ group: String(group.name || ""), app: String(app || "") }))
          : [])
          .filter((entity) => entity.group && entity.app)
      : [];

    const summary = {
      file: filePath,
      env: effectiveEnv,
      entityCount: entities.length,
      backends: {},
    };

    for (const backend of backends) {
      const failures = [];
      let ok = 0;
      for (let index = 0; index < entities.length; index += 1) {
        const entity = entities[index];
        process.stderr.write(`[sweep] ${backend} ${index + 1}/${entities.length} ${entity.group}.${entity.app}\n`);
        try {
          await requestWithTimeout(
            session,
            "happ/renderEntityManifest",
            {
              uri: pathToFileURL(filePath).toString(),
              text: documentText,
              group: entity.group,
              app: entity.app,
              env: effectiveEnv,
              renderer: backend,
              applyIncludes: true,
              applyEnvResolution: true,
            },
            requestTimeoutMs,
          );
          ok += 1;
        } catch (error) {
          failures.push({
            entity: `${entity.group}.${entity.app}`,
            signature: normalizeErrorSignature(error),
            message: extractErrorMessage(error),
          });
          if (isRequestTimeoutError(error)) {
            process.stderr.write(`[sweep] restarting happ after timeout on ${entity.group}.${entity.app}\n`);
            await session.forceStop();
            session = new HappLspSession(happPath);
            await session.start();
          }
        }
      }

      summary.backends[backend] = {
        ok,
        failed: failures.length,
        signatures: groupFailuresBySignature(failures),
        failures,
      };
    }

    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } finally {
    await session.stop();
  }
}

function parseArgs(argv) {
  const out = { backend: "both" };
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
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`missing value for --${key}`);
    }
    out[key] = value;
    i += 1;
  }
  return out;
}

function resolveBackends(value) {
  const normalized = String(value || "both").trim().toLowerCase();
  if (normalized === "both") {
    return ["helm", "werf"];
  }
  if (normalized === "all") {
    return ["fast", "helm", "werf"];
  }
  if (normalized === "fast" || normalized === "helm" || normalized === "werf") {
    return [normalized];
  }
  throw new Error(`unsupported backend: ${normalized}`);
}

function resolvePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function printUsage() {
  process.stderr.write(
    "usage: node scripts/sweep-manifest-preview.js --file <values.yaml> [--env <env>] [--backend fast|helm|werf|both|all] [--happ-path <bin>] [--request-timeout-ms <ms>]\n",
  );
}

function normalizeErrorSignature(error) {
  const message = extractErrorMessage(error);
  const firstLine = message.split(/\r?\n/).find((line) => line.trim().length > 0) || message;
  return firstLine
    .replace(/\s+/g, " ")
    .replace(/0x[0-9a-f]+/gi, "0x*")
    .trim();
}

function extractErrorMessage(error) {
  if (error instanceof Error) {
    return String(error.message || error.toString());
  }
  return String(error || "");
}

function isRequestTimeoutError(error) {
  return extractErrorMessage(error).startsWith("request timed out after ");
}

function groupFailuresBySignature(failures) {
  const grouped = new Map();
  for (const failure of failures) {
    const bucket = grouped.get(failure.signature) || {
      signature: failure.signature,
      count: 0,
      samples: [],
    };
    bucket.count += 1;
    if (bucket.samples.length < 5) {
      bucket.samples.push(failure.entity);
    }
    grouped.set(failure.signature, bucket);
  }
  return [...grouped.values()].sort((a, b) => b.count - a.count || a.signature.localeCompare(b.signature));
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
      clientInfo: { name: "helm-apps-preview-sweep" },
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

  async forceStop() {
    const proc = this.proc;
    this.proc = undefined;
    this.exited = true;
    for (const pending of this.pending.values()) {
      pending.reject(new Error("happ lsp force-stopped"));
    }
    this.pending.clear();
    if (!proc) {
      return;
    }
    try {
      proc.kill("SIGKILL");
    } catch {}
    await new Promise((resolve) => {
      proc.once("exit", () => resolve());
      setTimeout(resolve, 300);
    });
  }

  request(method, params) {
    if (!this.proc || !this.proc.stdin.writable) {
      return Promise.reject(new Error("happ lsp is not running"));
    }
    const id = this.nextId++;
    const message = { jsonrpc: "2.0", id, method, params };
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
    const message = { jsonrpc: "2.0", method, params };
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
      this.onMessage(JSON.parse(body));
    }
  }

  onMessage(message) {
    if (!Object.prototype.hasOwnProperty.call(message, "id")) {
      return;
    }
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

function requestWithTimeout(session, method, params, timeoutMs) {
  let timer;
  return Promise.race([
    session.request(method, params),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`request timed out after ${timeoutMs}ms: ${method}`));
      }, timeoutMs);
    }),
  ]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
