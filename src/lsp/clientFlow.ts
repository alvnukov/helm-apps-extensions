export type MethodCallGuard = "clientNotRunning" | "methodUnavailable" | null;

export function classifyMethodCallGuard(
  isClientRunning: boolean,
  customMethods: ReadonlySet<string>,
  method: string,
): MethodCallGuard {
  if (!isClientRunning) {
    return "clientNotRunning";
  }
  if (customMethods.size > 0 && !customMethods.has(method)) {
    return "methodUnavailable";
  }
  return null;
}

export function withParentPidArg(args: readonly string[], parentPid: number = process.pid): string[] {
  const hasParentPid = args.some((arg) => arg === "--parent-pid" || arg.startsWith("--parent-pid="));
  if (hasParentPid) {
    return [...args];
  }
  return [...args, `--parent-pid=${parentPid}`];
}

export function errorMessageFromUnknown(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
