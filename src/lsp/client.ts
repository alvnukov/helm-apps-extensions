import * as vscode from "vscode";
import {
  CloseAction,
  ErrorAction,
  LanguageClient,
  type LanguageClientOptions,
  type ServerOptions,
  TransportKind,
} from "vscode-languageclient/node";

export const HAPP_AVAILABLE_CONTEXT_KEY = "helmApps.happAvailable";
export const DEFAULT_HAPP_LSP_ARGS = ["lsp"];
export type LanguageMode = "happ" | "fallback";

export interface HappLspStartResult {
  started: boolean;
  fullLanguageSupport: boolean;
  errorMessage?: string;
}

export interface RenderEntityManifestParams {
  uri?: string;
  text?: string;
  group: string;
  app: string;
  env?: string;
  applyIncludes?: boolean;
  applyEnvResolution?: boolean;
}

export interface RenderEntityManifestResult {
  manifest: string;
  defaultEnv: string;
  usedEnv: string;
  envDiscovery: {
    literals: string[];
    regexes: string[];
  };
}

export interface HappPreviewTheme {
  ui: {
    bg: string;
    surface: string;
    surface2: string;
    surface3: string;
    surface4: string;
    text: string;
    muted: string;
    accent: string;
    accent2: string;
    border: string;
    danger: string;
    ok: string;
    title: string;
    controlHoverBorder: string;
    controlFocusBorder: string;
    controlFocusRing: string;
    quickEnvBg: string;
    quickEnvBorder: string;
    quickEnvText: string;
    quickEnvHoverBg: string;
    quickEnvHoverBorder: string;
  };
  syntax: {
    key: string;
    bool: string;
    number: string;
    comment: string;
    string: string;
    block: string;
  };
}

export class HappLspClient {
  private client: LanguageClient | undefined;
  private readonly logger: vscode.OutputChannel | undefined;
  private customMethods = new Set<string>();

  constructor(logger?: vscode.OutputChannel) {
    this.logger = logger;
  }

  async start(
    context: vscode.ExtensionContext,
    happPath: string,
    args: string[],
  ): Promise<HappLspStartResult> {
    const runtimeArgs = withParentPidArg(args);
    this.logger?.appendLine(`[client] start requested command=${happPath} args=${JSON.stringify(runtimeArgs)}`);
    const serverOptions: ServerOptions = {
      command: happPath,
      args: runtimeArgs,
      transport: TransportKind.stdio,
    };
    const clientOptions: LanguageClientOptions = {
      documentSelector: [
        { language: "yaml", scheme: "file" },
        { language: "yaml", scheme: "untitled" },
      ],
      outputChannelName: "helm-apps / happ-lsp",
      synchronize: {
        configurationSection: ["helm-apps", "yaml"],
      },
      errorHandler: {
        error: (error, message, count) => {
          this.logger?.appendLine(
            `[client] error message=${message ?? "<none>"} count=${count} err=${error?.message ?? String(error)}`,
          );
          return { action: ErrorAction.Shutdown };
        },
        closed: () => {
          this.logger?.appendLine("[client] transport closed");
          return { action: CloseAction.DoNotRestart };
        },
      },
      initializationOptions: {
        extension: "helm-apps",
        extensionVersion: context.extension.packageJSON.version,
      },
    };

    const client = new LanguageClient(
      "helm-apps-happ-lsp",
      "helm-apps (happ LSP)",
      serverOptions,
      clientOptions,
    );

    try {
      await client.start();
      await new Promise<void>((resolve) => setTimeout(resolve, 150));
      if (!client.isRunning()) {
        throw new Error("happ LSP exited immediately after start");
      }
      this.client = client;
      this.customMethods = collectCustomMethods(client.initializeResult?.capabilities?.experimental);
      await this.setAvailableContext(true);
      this.logger?.appendLine("[client] started and running");

      const experimental = client.initializeResult?.capabilities?.experimental as
        | Record<string, unknown>
        | undefined;
      return {
        started: true,
        fullLanguageSupport: experimental?.helmAppsFullLanguageFeatures === true,
      };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.logger?.appendLine(`[client] start failed: ${errorMessage}`);
      try {
        await client.stop();
      } catch {
        // ignore stop errors when start failed
      }
      this.client = undefined;
      this.customMethods.clear();
      await this.setAvailableContext(false);
      return {
        started: false,
        fullLanguageSupport: false,
        errorMessage,
      };
    }
  }

  async stop(): Promise<void> {
    this.logger?.appendLine("[client] stop requested");
    const active = this.client;
    this.client = undefined;
    this.customMethods.clear();
    await this.setAvailableContext(false);
    if (!active) {
      this.logger?.appendLine("[client] stop noop (not running)");
      return;
    }
    try {
      await active.stop();
      this.logger?.appendLine("[client] stopped");
    } catch {
      // ignore shutdown errors
      this.logger?.appendLine("[client] stop finished with ignored shutdown error");
    }
  }

  isRunning(): boolean {
    return this.client !== undefined;
  }

  async renderEntityManifest(
    params: RenderEntityManifestParams,
  ): Promise<RenderEntityManifestResult> {
    const active = this.client;
    if (!active) {
      throw new Error("happ LSP client is not running");
    }
    if (this.customMethods.size > 0 && !this.customMethods.has("happ/renderEntityManifest")) {
      this.logger?.appendLine("[client] renderEntityManifest unavailable (method not advertised by server)");
      throw new Error("happ LSP server does not support manifest preview (happ/renderEntityManifest)");
    }
    try {
      const result = await active.sendRequest<RenderEntityManifestResult>(
        "happ/renderEntityManifest",
        {
          uri: params.uri,
          text: params.text,
          group: params.group,
          app: params.app,
          env: params.env,
          applyIncludes: params.applyIncludes,
          applyEnvResolution: params.applyEnvResolution,
        },
      );
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger?.appendLine(`[client] renderEntityManifest failed: ${message}`);
      throw new Error(message);
    }
  }

  async getPreviewTheme(): Promise<HappPreviewTheme> {
    const active = this.client;
    if (!active) {
      throw new Error("happ LSP client is not running");
    }
    if (this.customMethods.size > 0 && !this.customMethods.has("happ/getPreviewTheme")) {
      this.logger?.appendLine("[client] getPreviewTheme unavailable (method not advertised by server)");
      throw new Error("happ LSP server does not support preview theme request (happ/getPreviewTheme)");
    }
    try {
      const result = await active.sendRequest<HappPreviewTheme>("happ/getPreviewTheme", {});
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger?.appendLine(`[client] getPreviewTheme failed: ${message}`);
      throw new Error(message);
    }
  }

  async setAvailableContext(available: boolean): Promise<void> {
    await vscode.commands.executeCommand("setContext", HAPP_AVAILABLE_CONTEXT_KEY, available);
  }
}

function withParentPidArg(args: string[]): string[] {
  const hasParentPid = args.some((arg) => arg === "--parent-pid" || arg.startsWith("--parent-pid="));
  if (hasParentPid) {
    return [...args];
  }
  return [...args, `--parent-pid=${process.pid}`];
}

function collectCustomMethods(experimental: unknown): Set<string> {
  if (!experimental || typeof experimental !== "object") {
    return new Set<string>();
  }
  const methodsRaw = (experimental as { customMethods?: unknown }).customMethods;
  if (!Array.isArray(methodsRaw)) {
    return new Set<string>();
  }
  return new Set(
    methodsRaw
      .filter((it): it is string => typeof it === "string")
      .map((it) => it.trim())
      .filter((it) => it.length > 0),
  );
}
