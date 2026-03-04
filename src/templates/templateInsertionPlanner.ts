import YAML from "yaml";

import type { EntityTemplateCommandSpec } from "../catalog/entityGroups";
import { renderAppsInfraTemplateLines, renderEntityTemplateLines } from "./entityTemplates";
import {
  buildEntityGroupInsertionPrefix,
  collectExistingEntityNames,
  collectTopLevelGroupBlocks,
  nextEntityName,
} from "./templateInsertionContext";

export interface TemplateInsertionPlan {
  line: number;
  text: string;
  insertedLabel: string;
}

export function planEntityTemplateInsertion(
  text: string,
  eol: string,
  targetGroupName: string,
  spec: EntityTemplateCommandSpec,
): TemplateInsertionPlan | null {
  const lines = text.split(/\r?\n/);
  const blocks = collectTopLevelGroupBlocks(text);
  const targetBlock = blocks.find((b) => b.name === targetGroupName);

  if (spec.insertionMode === "groupScaffold" && spec.groupType === "apps-infra") {
    const values = parseValuesObject(text);
    const targetGroup = toMap(values[targetGroupName]);
    const hasNodeUsers = hasOwnKey(targetGroup, "node-users");
    const hasNodeGroups = hasOwnKey(targetGroup, "node-groups");
    if (targetBlock && hasNodeUsers && hasNodeGroups) {
      return null;
    }

    const scaffoldLines = renderAppsInfraTemplateLines({
      includeNodeUsers: !targetBlock || !hasNodeUsers,
      includeNodeGroups: !targetBlock || !hasNodeGroups,
    });
    const scaffoldText = `${scaffoldLines.join(eol)}${eol}`;
    if (targetBlock) {
      return {
        line: targetBlock.endLine,
        text: scaffoldText,
        insertedLabel: `${targetGroupName}.{node-users,node-groups}`,
      };
    }

    const prefix = buildEntityGroupInsertionPrefix(text, eol);
    return {
      line: lines.length,
      text: `${prefix}${targetGroupName}:${eol}${scaffoldText}`,
      insertedLabel: `${targetGroupName}.{node-users,node-groups}`,
    };
  }

  const existingAppNames = collectExistingEntityNames(text, targetGroupName);
  const appName = nextEntityName(existingAppNames, spec.appBase);
  const entityLines = renderEntityTemplateLines(spec.groupType, appName);
  const entityText = `${entityLines.join(eol)}${eol}`;

  if (targetBlock) {
    return {
      line: targetBlock.endLine,
      text: entityText,
      insertedLabel: `${targetGroupName}.${appName}`,
    };
  }

  const prefix = buildEntityGroupInsertionPrefix(text, eol);
  const groupText = `${targetGroupName}:${eol}${entityText}`;
  return {
    line: lines.length,
    text: `${prefix}${groupText}`,
    insertedLabel: `${targetGroupName}.${appName}`,
  };
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
