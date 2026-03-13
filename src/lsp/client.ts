import * as vscode from "vscode";
import {
  CloseAction,
  ErrorAction,
  LanguageClient,
  type LanguageClientOptions,
  type ServerOptions,
  TransportKind,
} from "vscode-languageclient/node";
import {
  collectCustomMethods,
  DEFAULT_HAPP_LSP_ARGS,
  HAPP_LSP_METHODS,
  type HappPreviewTheme,
  type ListEntitiesParams,
  type ListEntitiesResult,
  type OptimizeValuesIncludesParams,
  type OptimizeValuesIncludesResult,
  type ResolveEntityParams,
  type ResolveEntityResult,
  type RenderEntityManifestParams,
  type RenderEntityManifestResult,
  type TemplateAssistParams,
  type TemplateAssistResult,
} from "../core/happProtocol";
import { classifyMethodCallGuard, errorMessageFromUnknown, withParentPidArg } from "./clientFlow";

export const HAPP_AVAILABLE_CONTEXT_KEY = "helmApps.happAvailable";
export type LanguageMode = "happ" | "fallback";
export { DEFAULT_HAPP_LSP_ARGS };
export type {
  HappPreviewTheme,
  ListEntitiesParams,
  ListEntitiesResult,
  OptimizeValuesIncludesParams,
  OptimizeValuesIncludesResult,
  ResolveEntityParams,
  ResolveEntityResult,
  RenderEntityManifestParams,
  RenderEntityManifestResult,
  TemplateAssistParams,
  TemplateAssistResult,
};

export interface HappLspStartResult {
  started: boolean;
  fullLanguageSupport: boolean;
  errorMessage?: string;
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
    args: readonly string[],
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
            `[client] error message=${message ?? "<none>"} count=${count} err=${errorMessageFromUnknown(error)}`,
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
      const errorMessage = errorMessageFromUnknown(err);
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

  advertisesMethod(method: string): boolean {
    return this.client !== undefined && this.customMethods.has(method);
  }

  async listEntities(
    params: ListEntitiesParams,
  ): Promise<ListEntitiesResult> {
    const active = this.requireActiveClientForMethod(
      HAPP_LSP_METHODS.listEntities,
      "[client] listEntities unavailable (method not advertised by server)",
      "happ LSP server does not support entity listing (happ/listEntities)",
    );
    try {
      const result = await active.sendRequest<ListEntitiesResult>(
        HAPP_LSP_METHODS.listEntities,
        {
          uri: params.uri,
          text: params.text,
          env: params.env,
          applyIncludes: params.applyIncludes,
          applyEnvResolution: params.applyEnvResolution,
        },
      );
      return result;
    } catch (err) {
      const message = errorMessageFromUnknown(err);
      this.logger?.appendLine(`[client] listEntities failed: ${message}`);
      throw new Error(message);
    }
  }

  async renderEntityManifest(
    params: RenderEntityManifestParams,
  ): Promise<RenderEntityManifestResult> {
    const active = this.requireActiveClientForMethod(
      HAPP_LSP_METHODS.renderEntityManifest,
      "[client] renderEntityManifest unavailable (method not advertised by server)",
      "happ LSP server does not support manifest preview (happ/renderEntityManifest)",
    );
    try {
      const result = await active.sendRequest<RenderEntityManifestResult>(
        HAPP_LSP_METHODS.renderEntityManifest,
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
      const message = errorMessageFromUnknown(err);
      this.logger?.appendLine(`[client] renderEntityManifest failed: ${message}`);
      throw new Error(message);
    }
  }

  async resolveEntity(
    params: ResolveEntityParams,
  ): Promise<ResolveEntityResult> {
    const active = this.requireActiveClientForMethod(
      HAPP_LSP_METHODS.resolveEntity,
      "[client] resolveEntity unavailable (method not advertised by server)",
      "happ LSP server does not support values entity resolve (happ/resolveEntity)",
    );
    try {
      const result = await active.sendRequest<ResolveEntityResult>(
        HAPP_LSP_METHODS.resolveEntity,
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
      const message = errorMessageFromUnknown(err);
      this.logger?.appendLine(`[client] resolveEntity failed: ${message}`);
      throw new Error(message);
    }
  }

  async getPreviewTheme(): Promise<HappPreviewTheme> {
    const active = this.requireActiveClientForMethod(
      HAPP_LSP_METHODS.getPreviewTheme,
      "[client] getPreviewTheme unavailable (method not advertised by server)",
      "happ LSP server does not support preview theme request (happ/getPreviewTheme)",
    );
    try {
      const result = await active.sendRequest<HappPreviewTheme>(HAPP_LSP_METHODS.getPreviewTheme, {});
      return result;
    } catch (err) {
      const message = errorMessageFromUnknown(err);
      this.logger?.appendLine(`[client] getPreviewTheme failed: ${message}`);
      throw new Error(message);
    }
  }

  async templateAssist(params: TemplateAssistParams): Promise<TemplateAssistResult> {
    const active = this.requireActiveClientForMethod(
      HAPP_LSP_METHODS.templateAssist,
      "[client] templateAssist unavailable (method not advertised by server)",
      "happ LSP server does not support template assist request (happ/templateAssist)",
    );
    try {
      const result = await active.sendRequest<TemplateAssistResult>(HAPP_LSP_METHODS.templateAssist, {
        uri: params.uri,
        text: params.text,
        line: params.line,
        character: params.character,
      });
      return result;
    } catch (err) {
      const message = errorMessageFromUnknown(err);
      this.logger?.appendLine(`[client] templateAssist failed: ${message}`);
      throw new Error(message);
    }
  }

  async optimizeValuesIncludes(
    params: OptimizeValuesIncludesParams,
  ): Promise<OptimizeValuesIncludesResult> {
    const active = this.requireActiveClientForMethod(
      HAPP_LSP_METHODS.optimizeValuesIncludes,
      "[client] optimizeValuesIncludes unavailable (method not advertised by server)",
      "happ LSP server does not support values include optimization (happ/optimizeValuesIncludes)",
    );
    try {
      const result = await active.sendRequest<OptimizeValuesIncludesResult>(
        HAPP_LSP_METHODS.optimizeValuesIncludes,
        {
          uri: params.uri,
          text: params.text,
          minProfileBytes: params.minProfileBytes,
        },
      );
      return result;
    } catch (err) {
      const message = errorMessageFromUnknown(err);
      this.logger?.appendLine(`[client] optimizeValuesIncludes failed: ${message}`);
      throw new Error(message);
    }
  }

  private requireActiveClientForMethod(
    method: string,
    unavailableLogMessage: string,
    unsupportedErrorMessage: string,
  ): LanguageClient {
    const guard = classifyMethodCallGuard(this.client !== undefined, this.customMethods, method);
    if (guard === "clientNotRunning") {
      throw new Error("happ LSP client is not running");
    }
    if (guard === "methodUnavailable") {
      this.logger?.appendLine(unavailableLogMessage);
      throw new Error(unsupportedErrorMessage);
    }
    return this.client as LanguageClient;
  }

  async setAvailableContext(available: boolean): Promise<void> {
    await vscode.commands.executeCommand("setContext", HAPP_AVAILABLE_CONTEXT_KEY, available);
  }
}
