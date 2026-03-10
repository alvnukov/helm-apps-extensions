type ManifestPreviewErrorContext = {
  fileUri?: string;
  group?: string;
  app?: string;
  env?: string;
};

type ParsedManifestError = {
  raw: string;
  message: string;
  code?: string;
  location?: string;
  path?: string;
  hint?: string;
  docs?: string;
  docsUrl?: string;
};

const HELM_APPS_DOCS_BASE_URL = "https://github.com/alvnukov/helm-apps/blob/main/";

export function formatManifestPreviewError(
  err: unknown,
  context: ManifestPreviewErrorContext,
): string {
  const parsed = parseManifestPreviewError(extractErrorMessage(err));
  const lines: string[] = [
    "# manifest preview failed",
    "# happ could not render Kubernetes manifests for this entity.",
    "",
    "error:",
    `  message: ${yamlScalar(parsed.message)}`,
  ];

  if (parsed.code) {
    lines.push(`  code: ${yamlScalar(parsed.code)}`);
  }
  if (parsed.location) {
    lines.push(`  location: ${yamlScalar(parsed.location)}`);
  }
  if (parsed.path) {
    lines.push(`  path: ${yamlScalar(parsed.path)}`);
  }
  if (parsed.hint) {
    lines.push(`  hint: ${yamlScalar(parsed.hint)}`);
  }
  if (parsed.docs) {
    lines.push(`  docs: ${yamlScalar(parsed.docs)}`);
  }
  if (parsed.docsUrl) {
    lines.push(`  docsUrl: ${yamlScalar(parsed.docsUrl)}`);
  }

  const contextLines = buildContextLines(context);
  if (contextLines.length > 0) {
    lines.push("", "context:", ...contextLines.map((line) => `  ${line}`));
  }

  lines.push(
    "",
    "nextSteps:",
    "  - Check the `path` field and update the value format.",
    "  - Re-check `hint` and `docs`, then rerender manifest preview.",
    "",
    "rawError: |-",
    ...toYamlBlock(parsed.raw),
    "",
  );

  return lines.join("\n");
}

export function parseManifestPreviewError(message: string): ParsedManifestError {
  const raw = normalizeMessage(message);
  const parts = raw.split(/\s+\|\s+/).map((part) => part.trim()).filter((part) => part.length > 0);

  const keyValues = new Map<string, string>();
  const extraParts: string[] = [];
  for (const part of parts.slice(1)) {
    const match = part.match(/^([A-Za-z][A-Za-z0-9_.-]*)\s*=\s*(.+)$/);
    if (!match) {
      extraParts.push(part);
      continue;
    }
    keyValues.set(match[1].toLowerCase(), match[2].trim());
  }

  let summary = stripKnownErrorPrefixes(parts[0] ?? raw);
  const execMatch = summary.match(/execution error at \(([^)]+)\):\s*(.+)$/i);
  let location = keyValues.get("location");
  if (execMatch) {
    if (!location) {
      location = execMatch[1].trim();
    }
    summary = execMatch[2].trim();
  }

  const code = keyValues.get("code") ?? extractErrorCode(raw);
  if (code) {
    summary = summary.replace(new RegExp(`\\[(?:[^\\]:]+:)?${escapeRegExp(code)}\\]\\s*`, "gi"), "").trim();
  }
  summary = summary.trim();
  if (extraParts.length > 0) {
    summary = [summary, ...extraParts].filter((part) => part.length > 0).join(" | ");
  }
  if (summary.length === 0) {
    summary = "Manifest render failed";
  }

  const docs = keyValues.get("docs");
  return {
    raw,
    message: summary,
    code,
    location,
    path: keyValues.get("path"),
    hint: keyValues.get("hint"),
    docs,
    docsUrl: docs ? resolveDocsUrl(docs) : undefined,
  };
}

function buildContextLines(context: ManifestPreviewErrorContext): string[] {
  const lines: string[] = [];
  const entity = context.group && context.app ? `${context.group}.${context.app}` : undefined;
  if (entity) {
    lines.push(`entity: ${yamlScalar(entity)}`);
  }
  if (context.env) {
    lines.push(`env: ${yamlScalar(context.env)}`);
  }
  if (context.fileUri) {
    lines.push(`fileUri: ${yamlScalar(context.fileUri)}`);
  }
  return lines;
}

function extractErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err ?? "");
}

function normalizeMessage(message: string): string {
  return message.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
}

function stripKnownErrorPrefixes(message: string): string {
  const prefixes = [
    /^render preview manifest:\s*/i,
    /^manifest preview failed:\s*/i,
    /^helm template failed:\s*/i,
    /^helm:\s*error:\s*/i,
    /^error:\s*/i,
  ];

  let current = message.trim();
  let updated = true;
  while (updated) {
    updated = false;
    for (const prefix of prefixes) {
      const next = current.replace(prefix, "").trim();
      if (next !== current) {
        current = next;
        updated = true;
      }
    }
  }
  return current;
}

function extractErrorCode(message: string): string | undefined {
  const bracketMatch = message.match(/\[(?:[A-Za-z0-9_.-]+:)?([A-Z][A-Z0-9_]+)\]/);
  if (bracketMatch?.[1]) {
    return bracketMatch[1];
  }
  const plainMatch = message.match(/\bE_[A-Z0-9_]+\b/);
  return plainMatch?.[0];
}

function resolveDocsUrl(docs: string): string | undefined {
  const value = docs.trim();
  if (value.length === 0) {
    return undefined;
  }
  if (/^https?:\/\//i.test(value)) {
    return value;
  }
  if (!value.startsWith("docs/")) {
    return undefined;
  }
  return `${HELM_APPS_DOCS_BASE_URL}${value}`;
}

function yamlScalar(value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
  return `"${escaped}"`;
}

function toYamlBlock(text: string): string[] {
  const rows = text.split("\n");
  if (rows.length === 0 || (rows.length === 1 && rows[0].length === 0)) {
    return ["  <empty>"];
  }
  return rows.map((row) => `  ${row}`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
