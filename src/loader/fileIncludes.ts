import { createHash } from "node:crypto";
import { dirname, isAbsolute, resolve } from "node:path";

import * as YAML from "yaml";

export interface IncludeDefinition {
  name: string;
  filePath: string;
  line: number;
}

export interface ExpandedValuesResult {
  values: Record<string, unknown>;
  includeDefinitions: IncludeDefinition[];
  missingFiles: MissingIncludeFile[];
}

export interface MissingIncludeFile {
  rawPath: string;
  tried: string[];
}

export type ReadFileFn = (filePath: string) => Promise<string>;

const INCLUDE_ENTRY_HELPER_KEYS = new Set(["_include", "_include_from_file", "_include_files"]);

export async function expandValuesWithFileIncludes(
  values: Record<string, unknown>,
  sourceFilePath: string,
  readFile: ReadFileFn,
): Promise<ExpandedValuesResult> {
  const includeDefinitions: IncludeDefinition[] = [];
  const missingFiles: MissingIncludeFile[] = [];
  const injectedIncludes: Record<string, unknown> = {};
  const root = clone(values);
  const fileStack = new Set<string>();

  const processed = await processNode(
    root,
    dirname(sourceFilePath),
    [],
    includeDefinitions,
    injectedIncludes,
    missingFiles,
    readFile,
    fileStack,
  );
  if (!isMap(processed)) {
    throw new Error("expanded values must stay a YAML map");
  }

  ensureGlobalIncludes(processed);
  const globalIncludes = ((processed.global as Record<string, unknown>)._includes as Record<string, unknown>);
  for (const [k, v] of Object.entries(injectedIncludes)) {
    globalIncludes[k] = v;
  }

  return { values: processed, includeDefinitions, missingFiles };
}

async function processNode(
  node: unknown,
  includeBaseDir: string,
  pathSegments: string[],
  includeDefinitions: IncludeDefinition[],
  injectedIncludes: Record<string, unknown>,
  missingFiles: MissingIncludeFile[],
  readFile: ReadFileFn,
  fileStack: Set<string>,
): Promise<unknown> {
  if (Array.isArray(node)) {
    return clone(node);
  }
  if (!isMap(node)) {
    return node;
  }

  let current = clone(node);

  if (typeof current._include_from_file === "string" && current._include_from_file.trim().length > 0) {
    const includeRawPath = current._include_from_file.trim();
    const loadedResult = await loadYamlMapFromFile(includeRawPath, includeBaseDir, missingFiles, readFile, fileStack);
    delete current._include_from_file;
    if (loadedResult) {
      const includePath = loadedResult.filePath;
      const includePayload = isGlobalIncludesPath(pathSegments)
        ? normalizeGlobalIncludesPayload(loadedResult.content)
        : loadedResult.content;
      if (isGlobalIncludesPath(pathSegments)) {
        for (const includeName of Object.keys(includePayload)) {
          if (isIncludeEntryHelperKey(includeName)) {
            continue;
          }
          includeDefinitions.push({ name: includeName, filePath: includePath, line: 0 });
        }
      }

      current = mergeMaps(includePayload, current);
    }
  }

  if (Object.prototype.hasOwnProperty.call(current, "_include_files")) {
    const includeFiles = normalizeIncludeFiles(current._include_files);
    const includeNames: string[] = [];
    for (const includeRawPath of includeFiles) {
      const includeName = includeNameFromPath(includeRawPath);

      const loadedResult = await loadYamlMapFromFile(includeRawPath, includeBaseDir, missingFiles, readFile, fileStack);
      if (loadedResult) {
        const includePath = loadedResult.filePath;
        injectedIncludes[includeName] = loadedResult.content;
        includeDefinitions.push({ name: includeName, filePath: includePath, line: 0 });
        includeNames.push(includeName);
      }
    }

    const existing = normalizeInclude(current._include);
    current._include = [...includeNames, ...existing];
    delete current._include_files;
  }

  for (const [k, v] of Object.entries(current)) {
    if (!isMap(v)) {
      continue;
    }
    current[k] = await processNode(v, includeBaseDir, [...pathSegments, k], includeDefinitions, injectedIncludes, missingFiles, readFile, fileStack);
  }

  return current;
}

async function loadYamlMapFromFile(
  rawPath: string,
  baseDir: string,
  missingFiles: MissingIncludeFile[],
  readFile: ReadFileFn,
  fileStack: Set<string>,
): Promise<{ filePath: string; content: Record<string, unknown> } | null> {
  if (isTemplatedPath(rawPath)) {
    return null;
  }
  const candidates = buildCandidates(rawPath, baseDir);
  const tried: string[] = [];

  let lastError: unknown;
  for (const filePath of candidates) {
    try {
      const content = await loadYamlMapFromAbsoluteFile(filePath, readFile, fileStack);
      return { filePath, content };
    } catch (err) {
      tried.push(filePath);
      lastError = err;
      if (!isNotFoundError(err)) {
        throw err;
      }
    }
  }

  if (tried.length > 0 && isNotFoundError(lastError)) {
    missingFiles.push({ rawPath, tried });
    return null;
  }

  const msg = [
    `include file error: ${rawPath}`,
    "tried:",
    ...tried.slice(0, 12).map((p) => `- ${p}`),
  ].join("\n");
  throw new Error(`${msg}${lastError ? `\nlast error: ${String(lastError)}` : ""}`);
}

async function loadYamlMapFromAbsoluteFile(
  filePath: string,
  readFile: ReadFileFn,
  fileStack: Set<string>,
): Promise<Record<string, unknown>> {
  if (fileStack.has(filePath)) {
    throw new Error(`_include file cycle detected: ${filePath}`);
  }
  fileStack.add(filePath);
  try {
    const text = await readFile(filePath);
    const parsed = YAML.parse(text) as unknown;
    if (!isMap(parsed)) {
      throw new Error(`included file must contain YAML map: ${filePath}`);
    }
    return parsed;
  } finally {
    fileStack.delete(filePath);
  }
}

function buildCandidates(rawPath: string, baseDir: string): string[] {
  if (isAbsolute(rawPath)) {
    return [rawPath];
  }
  return [resolve(baseDir, rawPath.trim())];
}

function isNotFoundError(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return false;
  }
  const e = err as { code?: string };
  return e.code === "ENOENT" || e.code === "ENOTDIR";
}

function includeNameFromPath(pathValue: string): string {
  const normalized = pathValue.trim();
  return createHash("sha256").update(normalized).digest("hex");
}

function isTemplatedPath(pathValue: string): boolean {
  return pathValue.includes("{{") || pathValue.includes("}}");
}

function isGlobalIncludesPath(pathSegments: string[]): boolean {
  return pathSegments.length === 2 && pathSegments[0] === "global" && pathSegments[1] === "_includes";
}

function normalizeGlobalIncludesPayload(loaded: Record<string, unknown>): Record<string, unknown> {
  const globalMap = toMap(loaded.global);
  const includesMap = toMap(globalMap?._includes);
  if (includesMap) {
    return clone(includesMap);
  }
  return loaded;
}

function ensureGlobalIncludes(root: Record<string, unknown>): void {
  if (!isMap(root.global)) {
    root.global = {};
  }
  const globalMap = root.global as Record<string, unknown>;
  if (!isMap(globalMap._includes)) {
    globalMap._includes = {};
  }
}

function normalizeInclude(value: unknown): string[] {
  if (typeof value === "string" && value.trim().length > 0) {
    return [value.trim()];
  }
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === "string" && v.trim().length > 0).map((v) => v.trim());
  }
  return [];
}

function normalizeIncludeFiles(value: unknown): string[] {
  if (typeof value === "string" && value.trim().length > 0) {
    return [value.trim()];
  }
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === "string" && v.trim().length > 0).map((v) => v.trim());
  }
  return [];
}

function isIncludeEntryHelperKey(name: string): boolean {
  return INCLUDE_ENTRY_HELPER_KEYS.has(name);
}

function isMap(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toMap(value: unknown): Record<string, unknown> | null {
  return isMap(value) ? value : null;
}

function mergeMaps(base: Record<string, unknown>, incoming: Record<string, unknown>): Record<string, unknown> {
  const out = clone(base);

  for (const [key, value] of Object.entries(incoming)) {
    if (key === "_include") {
      out[key] = [...normalizeInclude(out[key]), ...normalizeInclude(value)];
      continue;
    }

    const current = out[key];
    if (isMap(current) && isMap(value)) {
      out[key] = mergeMaps(current, value);
      continue;
    }

    out[key] = cloneValue(value);
  }

  return out;
}

function clone<T>(value: T): T {
  return cloneValue(value);
}

function cloneValue<T>(value: T): T {
  if (value === null || value === undefined) {
    return value;
  }
  if (Array.isArray(value) || typeof value === "object") {
    return JSON.parse(JSON.stringify(value)) as T;
  }
  return value;
}
