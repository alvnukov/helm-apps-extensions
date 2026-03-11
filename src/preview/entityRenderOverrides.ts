import * as YAML from "yaml";

export function forceEntityEnabled(entity: unknown): unknown {
  if (!isMap(entity)) {
    return entity;
  }
  return {
    ...entity,
    enabled: true,
  };
}

export function withManifestRenderEntityEnabled(
  sourceText: string,
  group: string,
  app: string,
): string {
  const text = sourceText ?? "";
  if (text.trim().length === 0) {
    return text;
  }
  try {
    const parsed = YAML.parse(text) as unknown;
    if (!isMap(parsed)) {
      return text;
    }
    const model = buildEntityEnableOverrideModel(parsed, group, app);
    if (!model.targetFound) {
      return text;
    }
    applyEntityEnableOverrides(parsed, model);
    const next = YAML.stringify(parsed);
    return next.length > 0 ? next : text;
  } catch {
    return text;
  }
}

export function buildManifestEntityIsolationOverrides(
  sourceText: string,
  group: string,
  app: string,
): string | null {
  const text = sourceText ?? "";
  if (text.trim().length === 0) {
    return null;
  }
  try {
    const parsed = YAML.parse(text) as unknown;
    if (!isMap(parsed)) {
      return null;
    }
    const model = buildEntityEnableOverrideModel(parsed, group, app);
    if (!model.targetFound) {
      return null;
    }
    return YAML.stringify(model.overrides);
  } catch {
    return null;
  }
}

export function buildManifestEntityIsolationSetValues(
  sourceText: string,
  group: string,
  app: string,
): string[] | null {
  const text = sourceText ?? "";
  if (text.trim().length === 0) {
    return null;
  }
  try {
    const parsed = YAML.parse(text) as unknown;
    if (!isMap(parsed)) {
      return null;
    }
    const model = buildEntityEnableOverrideModel(parsed, group, app);
    if (!model.targetFound) {
      return null;
    }
    return flattenEnableOverridesToSetValues(model.overrides);
  } catch {
    return null;
  }
}

type EnableOverrideGroup = Record<string, { enabled: boolean }>;

type EntityEnableOverrideModel = {
  overrides: Record<string, EnableOverrideGroup>;
  targetFound: boolean;
};

function buildEntityEnableOverrideModel(
  values: Record<string, unknown>,
  group: string,
  app: string,
): EntityEnableOverrideModel {
  const overrides: Record<string, EnableOverrideGroup> = {};
  let targetFound = false;

  for (const [groupName, groupValue] of Object.entries(values)) {
    if (groupName === "global" || !isMap(groupValue)) {
      continue;
    }
    for (const [appName, appValue] of Object.entries(groupValue)) {
      if (appName === "__GroupVars__" || !isMap(appValue)) {
        continue;
      }
      if (groupName === group && appName === app) {
        targetFound = true;
        if (!overrides[groupName]) {
          overrides[groupName] = {};
        }
        overrides[groupName][appName] = { enabled: true };
        continue;
      }

      if (readEntityEnabled(appValue) === true) {
        if (!overrides[groupName]) {
          overrides[groupName] = {};
        }
        overrides[groupName][appName] = { enabled: false };
      }
    }
  }

  return { overrides, targetFound };
}

function applyEntityEnableOverrides(
  values: Record<string, unknown>,
  model: EntityEnableOverrideModel,
): void {
  for (const [groupName, groupOverrides] of Object.entries(model.overrides)) {
    const groupValue = values[groupName];
    if (!isMap(groupValue)) {
      continue;
    }
    for (const [appName, appOverride] of Object.entries(groupOverrides)) {
      const appValue = groupValue[appName];
      if (!isMap(appValue)) {
        continue;
      }
      appValue.enabled = appOverride.enabled;
    }
  }
}

function isMap(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readEntityEnabled(entity: Record<string, unknown>): boolean | null {
  const enabled = entity.enabled;
  return typeof enabled === "boolean" ? enabled : null;
}

function flattenEnableOverridesToSetValues(overrides: Record<string, EnableOverrideGroup>): string[] {
  const setValues: string[] = [];
  for (const [groupName, groupOverrides] of Object.entries(overrides)) {
    for (const [appName, appOverride] of Object.entries(groupOverrides)) {
      const keyPath = `${escapeHelmSetPathSegment(groupName)}.${escapeHelmSetPathSegment(appName)}.enabled`;
      setValues.push(`${keyPath}=${appOverride.enabled ? "true" : "false"}`);
    }
  }
  return setValues;
}

function escapeHelmSetPathSegment(segment: string): string {
  return segment
    .replace(/\\/g, "\\\\")
    .replace(/\./g, "\\.")
    .replace(/,/g, "\\,")
    .replace(/=/g, "\\=")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]");
}
