export interface PreviewEntityGroup {
  name: string;
  apps: string[];
}

export interface PreviewEntityMenuModel {
  groups: PreviewEntityGroup[];
  selectedGroup: string;
  selectedApp: string;
}

export function buildPreviewEntityMenuModel(
  values: unknown,
  selectedGroup: string,
  selectedApp: string,
): PreviewEntityMenuModel {
  const root = toMap(values);
  const groups: PreviewEntityGroup[] = [];

  if (root) {
    for (const [groupName, groupValue] of Object.entries(root)) {
      if (groupName === "global") {
        continue;
      }
      const groupMap = toMap(groupValue);
      if (!groupMap) {
        continue;
      }
      const apps = Object.keys(groupMap).filter((appName) => appName !== "__GroupVars__");
      if (apps.length === 0) {
        continue;
      }
      groups.push({ name: groupName, apps });
    }
  }

  if (groups.length === 0) {
    return { groups, selectedGroup, selectedApp };
  }

  const nextGroup = groups.some((group) => group.name === selectedGroup) ? selectedGroup : groups[0].name;
  const nextApps = groups.find((group) => group.name === nextGroup)?.apps ?? [];
  const nextApp = nextApps.includes(selectedApp) ? selectedApp : (nextApps[0] ?? selectedApp);

  return {
    groups,
    selectedGroup: nextGroup,
    selectedApp: nextApp,
  };
}

export function buildPreviewEntityMenuModelFromGroups(
  groupsRaw: ReadonlyArray<{ name: string; apps: string[] }>,
  selectedGroup: string,
  selectedApp: string,
): PreviewEntityMenuModel {
  const groups = groupsRaw
    .map((group) => ({
      name: group.name,
      apps: [...group.apps]
        .filter((app) => typeof app === "string" && app.trim().length > 0)
        .map((app) => app.trim())
        .sort((a, b) => a.localeCompare(b)),
    }))
    .filter((group) => group.name.trim().length > 0 && group.apps.length > 0)
    .sort((a, b) => a.name.localeCompare(b.name));

  if (groups.length === 0) {
    return { groups: [], selectedGroup, selectedApp };
  }

  const nextGroup = groups.some((group) => group.name === selectedGroup) ? selectedGroup : groups[0].name;
  const nextApps = groups.find((group) => group.name === nextGroup)?.apps ?? [];
  const nextApp = nextApps.includes(selectedApp) ? selectedApp : (nextApps[0] ?? selectedApp);
  return {
    groups,
    selectedGroup: nextGroup,
    selectedApp: nextApp,
  };
}

export function buildPreviewGlobalProjection(
  values: unknown,
  entity: unknown,
  env: string,
): Record<string, unknown> {
  const root = toMap(values);
  const sourceGlobal = toMap(root?.global) ?? {};
  const out: Record<string, unknown> = { env };

  for (const section of ["validation", "labels", "deploy", "releases"] as const) {
    const pruned = pruneDefaultish(sourceGlobal[section]);
    if (pruned !== undefined) {
      out[section] = pruned;
    }
  }

  const referenced = collectReferencedGlobalKeys(entity);
  for (const key of referenced) {
    if (key === "env") {
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(out, key)) {
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(sourceGlobal, key)) {
      out[key] = sourceGlobal[key];
    }
  }

  return out;
}

function pruneDefaultish(value: unknown): unknown {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === "boolean") {
    return value ? true : undefined;
  }
  if (typeof value === "string") {
    return value.trim().length > 0 ? value : undefined;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (Array.isArray(value)) {
    const items = value
      .map((item) => pruneDefaultish(item))
      .filter((item) => item !== undefined);
    return items.length > 0 ? items : undefined;
  }
  if (isMap(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      const pruned = pruneDefaultish(nested);
      if (pruned !== undefined) {
        out[key] = pruned;
      }
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }
  return value;
}

function collectReferencedGlobalKeys(entity: unknown): Set<string> {
  const out = new Set<string>();
  collectReferencedGlobalKeysInner(entity, out);
  return out;
}

function collectReferencedGlobalKeysInner(value: unknown, out: Set<string>): void {
  if (typeof value === "string") {
    collectGlobalKeysFromTemplateString(value, out);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectReferencedGlobalKeysInner(item, out);
    }
    return;
  }
  if (isMap(value)) {
    for (const nested of Object.values(value)) {
      collectReferencedGlobalKeysInner(nested, out);
    }
  }
}

function collectGlobalKeysFromTemplateString(text: string, out: Set<string>): void {
  const re = /(?:\$?\s*\.)?Values\.global\.([A-Za-z0-9_-]+)/g;
  for (const match of text.matchAll(re)) {
    const key = (match[1] ?? "").trim();
    if (key.length > 0) {
      out.add(key);
    }
  }
}

function isMap(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toMap(value: unknown): Record<string, unknown> | null {
  return isMap(value) ? value : null;
}
