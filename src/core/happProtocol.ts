export const HAPP_LSP_METHODS = {
  listEntities: "happ/listEntities",
  resolveEntity: "happ/resolveEntity",
  renderEntityManifest: "happ/renderEntityManifest",
  getPreviewTheme: "happ/getPreviewTheme",
  templateAssist: "happ/templateAssist",
} as const;

export const DEFAULT_HAPP_LSP_ARGS = ["lsp"];

export interface RenderEntityManifestParams {
  uri?: string;
  text?: string;
  group: string;
  app: string;
  env?: string;
  applyIncludes?: boolean;
  applyEnvResolution?: boolean;
}

export interface EnvironmentDiscoveryModel {
  literals: string[];
  regexes: string[];
}

export interface ListEntitiesParams {
  uri?: string;
  text?: string;
  env?: string;
  applyIncludes?: boolean;
  applyEnvResolution?: boolean;
}

export interface PreviewEntityGroupModel {
  name: string;
  apps: string[];
}

export interface ListEntitiesResult {
  groups: PreviewEntityGroupModel[];
  defaultEnv: string;
  usedEnv: string;
  envDiscovery: EnvironmentDiscoveryModel;
}

export interface ResolveEntityParams {
  uri?: string;
  text?: string;
  group: string;
  app: string;
  env?: string;
  applyIncludes?: boolean;
  applyEnvResolution?: boolean;
}

export interface ResolveEntityResult {
  entity: unknown;
  defaultEnv: string;
  usedEnv: string;
  envDiscovery: EnvironmentDiscoveryModel;
}

export interface RenderEntityManifestResult {
  manifest: string;
  defaultEnv: string;
  usedEnv: string;
  envDiscovery: EnvironmentDiscoveryModel;
}

export interface TemplateAssistParams {
  uri?: string;
  text?: string;
  line: number;
  character: number;
}

export interface TemplateAssistCompletion {
  label: string;
  insertText: string;
  detail: string;
  kind: string;
  replaceStart: number;
  replaceEnd: number;
}

export interface TemplateAssistResult {
  insideTemplate: boolean;
  completions: TemplateAssistCompletion[];
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

export function collectCustomMethods(experimental: unknown): Set<string> {
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
