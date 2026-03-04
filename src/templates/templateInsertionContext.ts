import YAML from "yaml";

import { findAppScopeAtLine, resolveEnvMaps } from "../preview/includeResolver";

export interface TopLevelGroupBlock {
  name: string;
  startLine: number;
  endLine: number;
  effectiveType: string;
}

export function collectTopLevelGroupBlocks(text: string): TopLevelGroupBlock[] {
  const lines = text.split(/\r?\n/);
  const topLevelEntries: Array<{ name: string; startLine: number }> = [];

  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(/^([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (!m) {
      continue;
    }
    if (m[1] === "global") {
      continue;
    }
    topLevelEntries.push({ name: m[1], startLine: i });
  }

  const blocks: TopLevelGroupBlock[] = [];
  for (let i = 0; i < topLevelEntries.length; i += 1) {
    const entry = topLevelEntries[i];
    const next = topLevelEntries[i + 1];
    const endLine = next ? next.startLine : lines.length;
    const effectiveType = entry.name.startsWith("apps-")
      ? entry.name
      : resolveEffectiveGroupType(text, entry.name);
    blocks.push({
      name: entry.name,
      startLine: entry.startLine,
      endLine,
      effectiveType,
    });
  }
  return blocks;
}

export function findTopLevelGroupBlockAtLine(
  text: string,
  blocks: TopLevelGroupBlock[],
  lineNumber: number,
): TopLevelGroupBlock | undefined {
  const lines = text.split(/\r?\n/);
  const rawLine = lines[lineNumber] ?? "";
  const trimmed = rawLine.trim();

  const topLevelOnLine = rawLine.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/);
  if (topLevelOnLine) {
    if (topLevelOnLine[1] === "global") {
      return undefined;
    }
    return blocks.find((b) => b.name === topLevelOnLine[1]);
  }

  if ((trimmed.length === 0 || trimmed.startsWith("#")) && countIndent(rawLine) === 0) {
    return undefined;
  }

  const appScope = findAppScopeAtLine(text, lineNumber);
  if (appScope) {
    return blocks.find((b) => b.name === appScope.group);
  }

  if (countIndent(rawLine) === 0) {
    return undefined;
  }

  for (let i = lineNumber - 1; i >= 0; i -= 1) {
    const m = lines[i].match(/^([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (!m) {
      continue;
    }
    if (m[1] === "global") {
      return undefined;
    }
    return blocks.find((b) => b.name === m[1]);
  }

  return undefined;
}

export function allowedTemplateGroupTypesForCursor(
  activeBlock: TopLevelGroupBlock | undefined,
  allGroupTypes: readonly string[],
): Set<string> {
  const allowed = new Set<string>();
  if (!activeBlock) {
    for (const groupType of allGroupTypes) {
      allowed.add(groupType);
    }
    return allowed;
  }
  if (allGroupTypes.includes(activeBlock.effectiveType)) {
    allowed.add(activeBlock.effectiveType);
  }
  return allowed;
}

export interface TemplateVisibilitySpec {
  groupType: string;
  insertionMode: "appEntity" | "groupScaffold";
}

export function buildAllowedTemplateGroupTypes(
  text: string,
  blocks: TopLevelGroupBlock[],
  activeBlock: TopLevelGroupBlock | undefined,
  specs: readonly TemplateVisibilitySpec[],
): Set<string> {
  const scopedAllowed = allowedTemplateGroupTypesForCursor(activeBlock, specs.map((spec) => spec.groupType));
  const allowed = new Set<string>();

  for (const spec of specs) {
    if (!scopedAllowed.has(spec.groupType)) {
      continue;
    }
    if (spec.insertionMode !== "groupScaffold") {
      allowed.add(spec.groupType);
      continue;
    }
    const targetGroupName = activeBlock?.name
      ?? findPreferredGroupNameByType(blocks, spec.groupType)
      ?? spec.groupType;
    if (canInsertGroupScaffold(text, targetGroupName, spec.groupType)) {
      allowed.add(spec.groupType);
    }
  }

  return allowed;
}

export function findPreferredGroupNameByType(blocks: TopLevelGroupBlock[], groupType: string): string | null {
  const exact = blocks.find((b) => b.name === groupType);
  if (exact) {
    return exact.name;
  }
  const custom = blocks.find((b) => b.effectiveType === groupType);
  return custom ? custom.name : null;
}

export function collectExistingEntityNames(text: string, groupName: string): Set<string> {
  const values = parseValuesObject(text);
  const group = toMap(values[groupName]);
  if (!group) {
    return new Set<string>();
  }
  const names = new Set<string>();
  for (const name of Object.keys(group)) {
    if (name === "__GroupVars__") {
      continue;
    }
    names.add(name);
  }
  return names;
}

export function nextEntityName(existingNames: Set<string>, base: string): string {
  let idx = 1;
  while (existingNames.has(`${base}-${idx}`)) {
    idx += 1;
  }
  return `${base}-${idx}`;
}

export function buildEntityGroupInsertionPrefix(text: string, eol: string): string {
  let prefix = "";
  if (text.trim().length > 0) {
    if (!text.endsWith("\n") && !text.endsWith("\r\n")) {
      prefix += eol;
    }
    if (!(text.endsWith(`${eol}${eol}`) || prefix === `${eol}${eol}`)) {
      prefix += eol;
    }
  }
  return prefix;
}

export function canInsertGroupScaffold(
  text: string,
  groupName: string,
  groupType: string,
): boolean {
  if (groupType !== "apps-infra") {
    return true;
  }
  const values = parseValuesObject(text);
  const group = toMap(values[groupName]);
  if (!group) {
    return true;
  }
  const hasNodeUsers = hasOwnKey(group, "node-users");
  const hasNodeGroups = hasOwnKey(group, "node-groups");
  return !(hasNodeUsers && hasNodeGroups);
}

function countIndent(line: string): number {
  const m = line.match(/^(\s*)/);
  return m ? m[1].length : 0;
}

export function resolveEffectiveGroupType(text: string, groupName: string): string {
  if (groupName.startsWith("apps-")) {
    return groupName;
  }
  try {
    const parsed = YAML.parse(text) as unknown;
    const root = toMap(parsed);
    const group = root ? toMap(root[groupName]) : null;
    const groupVars = group ? toMap(group.__GroupVars__) : null;
    const rawType = groupVars ? groupVars.type : undefined;
    if (typeof rawType === "string" && rawType.trim().length > 0) {
      return rawType.trim();
    }
    if (isMap(rawType)) {
      const env = (() => {
        const global = root ? toMap(root.global) : null;
        const e = global ? global.env : undefined;
        return typeof e === "string" && e.trim().length > 0 ? e.trim() : "dev";
      })();
      const typed = resolveEnvMaps(rawType, env);
      if (typeof typed === "string" && typed.trim().length > 0) {
        return typed.trim();
      }
    }
  } catch {
    // ignore parse errors
  }
  return groupName;
}

function parseValuesObject(text: string): Record<string, unknown> {
  try {
    const parsed = YAML.parse(text) as unknown;
    return isMap(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function toMap(value: unknown): Record<string, unknown> | null {
  if (isMap(value)) {
    return value;
  }
  return null;
}

function isMap(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwnKey(root: Record<string, unknown> | null | undefined, key: string): boolean {
  return !!root && Object.prototype.hasOwnProperty.call(root, key);
}
