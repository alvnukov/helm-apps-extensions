import * as path from "node:path";

export interface ChartValuesLoadPlanInput {
  currentPath: string;
  primaryValuesPath?: string;
  werfSecretValuesPath?: string;
}

export interface ChartValuesLoadPlan {
  basePath: string;
  mergePaths: string[];
}

export type ChartValuesReadFile = (filePath: string) => Promise<string>;

export function isWerfSecretValuesFilePath(filePath: string): boolean {
  const base = path.basename(filePath).toLowerCase();
  return base === "secret-values.yaml" || base === "secret-values.yml";
}

export function planChartValuesLoad(input: ChartValuesLoadPlanInput): ChartValuesLoadPlan {
  const currentPath = path.resolve(input.currentPath);
  const primaryValuesPath = input.primaryValuesPath?.trim()
    ? path.resolve(input.primaryValuesPath)
    : undefined;
  const werfSecretValuesPath = input.werfSecretValuesPath?.trim()
    ? path.resolve(input.werfSecretValuesPath)
    : undefined;

  const basePath = primaryValuesPath ?? currentPath;
  const mergePaths = werfSecretValuesPath && werfSecretValuesPath !== basePath
    ? [werfSecretValuesPath]
    : [];

  return { basePath, mergePaths };
}

export function createChartValuesReadFile(
  readFile: ChartValuesReadFile,
  currentPath: string,
  currentText: string,
): ChartValuesReadFile {
  const normalizedCurrentPath = path.resolve(currentPath);
  return async (filePath: string) =>
    path.resolve(filePath) === normalizedCurrentPath
      ? currentText
      : await readFile(filePath);
}

export function mergeChartValues(
  base: Record<string, unknown>,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(incoming)) {
    if (key === "_include") {
      out[key] = [...normalizeInclude(out[key]), ...normalizeInclude(value)];
      continue;
    }

    const currentValue = out[key];
    if (isMap(currentValue) && isMap(value)) {
      out[key] = mergeChartValues(currentValue, value);
      continue;
    }
    out[key] = cloneValue(value);
  }
  return out;
}

function normalizeInclude(value: unknown): string[] {
  if (typeof value === "string" && value.trim().length > 0) {
    return [value.trim()];
  }
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      .map((item) => item.trim());
  }
  return [];
}

function isMap(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cloneValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => cloneValue(item));
  }
  if (isMap(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      out[key] = cloneValue(nested);
    }
    return out;
  }
  return value;
}
