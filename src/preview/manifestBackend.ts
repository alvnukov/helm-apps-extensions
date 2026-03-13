import * as path from "node:path";

export type ManifestBackend = "helm" | "werf";

export interface ManifestValuesSelectionInput {
  currentPath: string;
  rootDocuments: readonly string[];
  primaryValues?: string;
  includeOwners?: readonly string[];
}

export function resolveManifestBackendCommand(
  backend: ManifestBackend,
  configuredHelmPath: string,
): string {
  const configured = configuredHelmPath.trim();
  const configuredBinary = path.basename(configured).toLowerCase();

  if (backend === "werf") {
    if (configured.length > 0 && configuredBinary === "werf") {
      return configured;
    }
    return "werf";
  }

  if (configured.length > 0 && configuredBinary !== "werf") {
    return configured;
  }
  return "helm";
}

export function buildManifestBackendArgs(
  backend: ManifestBackend,
  chartDir: string,
  valuesFiles: readonly string[],
  isolationSetValues: readonly string[],
  env: string,
): string[] {
  const valueArgs = valuesFiles
    .map((current) => current.trim())
    .filter((current) => current.length > 0)
    .flatMap((current) => ["--values", current]);

  const setArgs = isolationSetValues
    .map((current) => current.trim())
    .filter((current) => current.length > 0)
    .flatMap((current) => ["--set", current]);

  const normalizedEnv = env.trim();
  const withEnvSet = (base: string[]): string[] => {
    if (!normalizedEnv) {
      return base;
    }
    return [...base, "--set-string", `global.env=${normalizedEnv}`];
  };

  if (backend === "werf") {
    const args = ["render", "--dir", chartDir, "--dev", ...valueArgs, ...setArgs];
    if (normalizedEnv) {
      args.push("--env", normalizedEnv);
    }
    return withEnvSet(args);
  }

  return withEnvSet(["template", "helm-apps-preview", chartDir, ...valueArgs, ...setArgs]);
}

export function selectManifestValuesFiles(input: ManifestValuesSelectionInput): string[] {
  const currentPath = path.resolve(input.currentPath);
  const normalizedRoots = new Set(input.rootDocuments.map((current) => path.resolve(current)));
  const primaryValues = input.primaryValues?.trim()
    ? path.resolve(input.primaryValues)
    : undefined;
  const ownerCandidates = [...(input.includeOwners ?? [])]
    .map((current) => current.trim())
    .filter((current) => current.length > 0)
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
