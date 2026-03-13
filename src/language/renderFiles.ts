import * as path from "node:path";

export interface HelmAppsYamlFile {
  filePath: string;
  text: string;
}

export interface IncludeFileRef {
  path: string;
  line: number;
}

export interface IncludeFileRefWithContext extends IncludeFileRef {
  kind: "from-file" | "files-list";
  parentPath: string[];
}

export function looksLikeHelmAppsValuesText(text: string): boolean {
  if (/\n?global:\s*/m.test(text) && /(?:^|\n)\s*_includes:\s*/m.test(text)) {
    return true;
  }
  if (/\n?global:\s*/m.test(text) && /(?:^|\n)\s*releases:\s*/m.test(text)) {
    return true;
  }
  if (/(?:^|\n)apps-[a-z0-9-]+:\s*/m.test(text)) {
    return true;
  }
  if (/(?:^|\n)\s*__GroupVars__:\s*/m.test(text)) {
    return true;
  }
  return false;
}

export function selectHelmAppsRootDocuments(files: HelmAppsYamlFile[]): string[] {
  const candidateRoots = new Set<string>();
  const includedByOtherDocuments = new Set<string>();

  for (const file of files) {
    const resolvedFilePath = path.resolve(file.filePath);
    if (looksLikeHelmAppsValuesText(file.text)) {
      candidateRoots.add(resolvedFilePath);
    }

    const baseDir = path.dirname(resolvedFilePath);
    for (const ref of collectIncludeFileRefs(file.text)) {
      for (const candidatePath of buildIncludeCandidates(ref.path, baseDir)) {
        const resolvedCandidatePath = path.resolve(candidatePath);
        if (resolvedCandidatePath !== resolvedFilePath) {
          includedByOtherDocuments.add(resolvedCandidatePath);
        }
      }
    }
  }

  return [...candidateRoots]
    .filter((filePath) => !includedByOtherDocuments.has(filePath))
    .sort();
}

export function collectIncludeFileRefs(text: string): IncludeFileRef[] {
  return collectIncludeFileRefsWithContext(text).map(({ path, line }) => ({ path, line }));
}

export function collectIncludeFileRefsWithContext(text: string): IncludeFileRefWithContext[] {
  const lines = text.split(/\r?\n/);
  const refs: IncludeFileRefWithContext[] = [];
  const keyStack: Array<{ indent: number; key: string }> = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const keyMatch = line.match(/^(\s*)(_include_from_file|_include_files):\s*(.*)$/);
    if (!keyMatch) {
      const anyKeyMatch = line.match(/^(\s*)([A-Za-z0-9_.-]+):\s*(.*)$/);
      if (anyKeyMatch) {
        const indent = anyKeyMatch[1].length;
        while (keyStack.length > 0 && keyStack[keyStack.length - 1].indent >= indent) {
          keyStack.pop();
        }
        keyStack.push({ indent, key: anyKeyMatch[2] });
      }
      continue;
    }
    const indent = keyMatch[1].length;
    const key = keyMatch[2];
    const tail = keyMatch[3].trim();
    while (keyStack.length > 0 && keyStack[keyStack.length - 1].indent >= indent) {
      keyStack.pop();
    }
    keyStack.push({ indent, key });
    const parentPath = keyStack.slice(0, -1).map((item) => item.key);

    if (key === "_include_from_file") {
      const value = unquote(tail);
      if (value && !isTemplatedIncludePath(value)) {
        refs.push({ path: value, line: i, kind: "from-file", parentPath });
      }
      continue;
    }

    if (tail.startsWith("[") && tail.endsWith("]")) {
      const inside = tail.slice(1, -1);
      for (const part of inside.split(",")) {
        const value = unquote(part.trim());
        if (value && !isTemplatedIncludePath(value)) {
          refs.push({ path: value, line: i, kind: "files-list", parentPath });
        }
      }
      continue;
    }

    for (let j = i + 1; j < lines.length; j += 1) {
      const sub = lines[j];
      const trimmed = sub.trim();
      if (trimmed.length === 0 || trimmed.startsWith("#")) {
        continue;
      }
      const subIndent = countIndent(sub);
      if (subIndent <= indent) {
        break;
      }
      const item = sub.match(/^\s*-\s+(.+)\s*$/);
      if (item) {
        const value = unquote(item[1].trim());
        if (value && !isTemplatedIncludePath(value)) {
          refs.push({ path: value, line: j, kind: "files-list", parentPath });
        }
      }
    }
  }

  return refs;
}

export function buildIncludeCandidates(rawPath: string, baseDir: string): string[] {
  if (path.isAbsolute(rawPath)) {
    return [rawPath];
  }
  return [path.resolve(baseDir, rawPath)];
}

export function isTemplatedIncludePath(value: string): boolean {
  return value.includes("{{") || value.includes("}}");
}

function countIndent(line: string): number {
  const match = line.match(/^\s*/);
  return match ? match[0].length : 0;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 2) {
    return trimmed;
  }
  if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}
