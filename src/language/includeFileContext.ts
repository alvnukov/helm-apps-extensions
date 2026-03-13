export type IncludeReferenceKind = "from-file" | "files-list";

export interface IncludeReferenceContext {
  rootDocument: string;
  sourceFile: string;
  rawPath: string;
  line: number;
  kind: IncludeReferenceKind;
  parentPath: string[];
}

export type IncludedFileContextMode =
  | "global-includes"
  | "merged-path"
  | "include-files"
  | "mixed";

export interface IncludedFileContextSummary {
  mode: IncludedFileContextMode;
  ownerRoots: string[];
  contexts: IncludeReferenceContext[];
  primaryPath?: string;
}

export function summarizeIncludedFileContexts(
  contexts: readonly IncludeReferenceContext[],
): IncludedFileContextSummary | undefined {
  if (contexts.length === 0) {
    return undefined;
  }

  const ownerRoots = [...new Set(contexts.map((ctx) => ctx.rootDocument))].sort();
  const sorted = [...contexts].sort(compareContexts);
  const hasGlobalIncludes = sorted.some((ctx) => ctx.kind === "from-file" && isGlobalIncludesPath(ctx.parentPath));
  const mergedPathContext = sorted.find((ctx) => ctx.kind === "from-file" && !isGlobalIncludesPath(ctx.parentPath));
  const includeFilesContext = sorted.find((ctx) => ctx.kind === "files-list");

  if (hasGlobalIncludes && !mergedPathContext && !includeFilesContext) {
    return {
      mode: "global-includes",
      ownerRoots,
      contexts: sorted,
      primaryPath: "global._includes",
    };
  }

  if (mergedPathContext && !includeFilesContext && !hasGlobalIncludes) {
    return {
      mode: "merged-path",
      ownerRoots,
      contexts: sorted,
      primaryPath: renderPath(mergedPathContext.parentPath),
    };
  }

  if (includeFilesContext && !mergedPathContext && !hasGlobalIncludes) {
    return {
      mode: "include-files",
      ownerRoots,
      contexts: sorted,
      primaryPath: renderPath(includeFilesContext.parentPath),
    };
  }

  return {
    mode: "mixed",
    ownerRoots,
    contexts: sorted,
    primaryPath: renderPath(sorted[0]?.parentPath ?? []),
  };
}

export function renderIncludeReferenceSite(context: IncludeReferenceContext): string {
  const parent = renderPath(context.parentPath);
  return context.kind === "from-file"
    ? `${parent}._include_from_file`
    : `${parent}._include_files`;
}

function isGlobalIncludesPath(path: readonly string[]): boolean {
  return path.length === 2 && path[0] === "global" && path[1] === "_includes";
}

function renderPath(path: readonly string[]): string {
  return path.length > 0 ? path.join(".") : "<root>";
}

function compareContexts(a: IncludeReferenceContext, b: IncludeReferenceContext): number {
  return a.rootDocument.localeCompare(b.rootDocument)
    || a.sourceFile.localeCompare(b.sourceFile)
    || a.line - b.line
    || a.rawPath.localeCompare(b.rawPath);
}
