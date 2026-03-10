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
    const doc = YAML.parseDocument(text);
    if (doc.errors.length > 0) {
      return text;
    }

    const groupNode = doc.get(group, true);
    if (!groupNode || !YAML.isMap(groupNode)) {
      return text;
    }
    const appNode = doc.getIn([group, app], true);
    if (!appNode || !YAML.isMap(appNode)) {
      return text;
    }

    doc.setIn([group, app, "enabled"], true);
    const next = String(doc);
    return next.length > 0 ? next : text;
  } catch {
    return text;
  }
}

function isMap(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
