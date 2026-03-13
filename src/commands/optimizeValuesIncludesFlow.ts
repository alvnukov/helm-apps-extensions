import type { OptimizeValuesIncludesParams } from "../core/happProtocol";

export type OptimizeValuesGuardBlocker =
  | "noActiveEditor"
  | "wrongDocument"
  | "happUnavailable"
  | "methodUnavailable";

export interface OptimizeValuesGuardInput {
  hasActiveEditor: boolean;
  isHelmAppsLanguageDocument: boolean;
  happRunning: boolean;
  methodAdvertised: boolean;
}

export interface BuildOptimizeValuesRequestInput {
  uri: string;
  text: string;
  minProfileBytes?: number;
}

export interface OptimizeValuesLspResult {
  changed: boolean;
  profilesAdded: number;
  optimizedText: string;
}

export type OptimizeValuesResultPlan =
  | { kind: "noChanges" }
  | { kind: "apply"; optimizedText: string; profilesAdded: number };

export function classifyOptimizeValuesGuard(
  input: OptimizeValuesGuardInput,
): OptimizeValuesGuardBlocker | null {
  if (!input.hasActiveEditor) {
    return "noActiveEditor";
  }
  if (!input.isHelmAppsLanguageDocument) {
    return "wrongDocument";
  }
  if (!input.happRunning) {
    return "happUnavailable";
  }
  if (!input.methodAdvertised) {
    return "methodUnavailable";
  }
  return null;
}

export function buildOptimizeValuesRequest(
  input: BuildOptimizeValuesRequestInput,
): OptimizeValuesIncludesParams {
  return {
    uri: input.uri,
    text: input.text,
    minProfileBytes: input.minProfileBytes ?? 24,
  };
}

export function classifyOptimizeValuesResult(
  result: OptimizeValuesLspResult,
): OptimizeValuesResultPlan {
  if (!result.changed) {
    return { kind: "noChanges" };
  }
  return {
    kind: "apply",
    optimizedText: result.optimizedText,
    profilesAdded: result.profilesAdded,
  };
}
