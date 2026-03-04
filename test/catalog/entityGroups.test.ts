import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  APP_ENTRY_GROUP_SET,
  BUILTIN_GROUP_TYPES,
  ENTITY_TEMPLATE_COMMAND_SPECS,
  INSERT_ENTITY_TEMPLATE_MENU_CONTEXT,
  LEGACY_INSERT_ENTITY_EXAMPLE_MENU_CONTEXT,
  getAllowedAppRootKeysByGroup,
} from "../../src/catalog/entityGroups";

type ContributedCommand = {
  command?: string;
  title?: string;
};

type ContributedMenuItem = {
  command?: string;
  submenu?: string;
  when?: string;
};

type ContributedSubmenu = {
  id?: string;
  label?: string;
};

type PackageManifest = {
  contributes?: {
    commands?: ContributedCommand[];
    menus?: Record<string, ContributedMenuItem[]>;
    submenus?: ContributedSubmenu[];
  };
};

function readJsonFile<T>(relativePath: string): T {
  const absolutePath = path.resolve(process.cwd(), relativePath);
  return JSON.parse(readFileSync(absolutePath, "utf8")) as T;
}

test("entity group catalog exports all built-in groups and command specs", () => {
  assert.ok(BUILTIN_GROUP_TYPES.includes("apps-stateless"));
  assert.ok(BUILTIN_GROUP_TYPES.includes("apps-infra"));
  assert.ok(BUILTIN_GROUP_TYPES.includes("apps-k8s-manifests"));
  assert.equal(ENTITY_TEMPLATE_COMMAND_SPECS.length, BUILTIN_GROUP_TYPES.length);
  assert.equal(INSERT_ENTITY_TEMPLATE_MENU_CONTEXT, "helmApps.insertEntityTemplate.visible");
  assert.equal(LEGACY_INSERT_ENTITY_EXAMPLE_MENU_CONTEXT, "helmApps.insertEntityExample.visible");
});

test("legacy command ids are kept for previously shipped insert commands", () => {
  const legacyStateless = ENTITY_TEMPLATE_COMMAND_SPECS.find((s) => s.groupType === "apps-stateless");
  const legacyServiceAccounts = ENTITY_TEMPLATE_COMMAND_SPECS.find((s) => s.groupType === "apps-service-accounts");
  const legacyManifest = ENTITY_TEMPLATE_COMMAND_SPECS.find((s) => s.groupType === "apps-k8s-manifests");
  assert.ok(legacyStateless?.legacyCommandId);
  assert.ok(legacyServiceAccounts?.legacyCommandId);
  assert.ok(legacyManifest?.legacyCommandId);

  const newGroup = ENTITY_TEMPLATE_COMMAND_SPECS.find((s) => s.groupType === "apps-limit-range");
  assert.equal(newGroup?.legacyCommandId, undefined);
});

test("root-key allowlist is non-empty only for app-entry groups", () => {
  const stateless = getAllowedAppRootKeysByGroup("apps-stateless");
  assert.ok(stateless.has("containers"));
  assert.ok(stateless.has("service"));
  assert.ok(stateless.has("_include"));

  assert.equal(APP_ENTRY_GROUP_SET.has("apps-infra"), false);
  const infra = getAllowedAppRootKeysByGroup("apps-infra");
  assert.equal(infra.size, 0);
});

test("dex authenticator root-key allowlist covers session and source-range settings", () => {
  const dexAuth = getAllowedAppRootKeysByGroup("apps-dex-authenticators");
  assert.ok(dexAuth.has("keepUsersLoggedInFor"));
  assert.ok(dexAuth.has("signOutURL"));
  assert.ok(dexAuth.has("whitelistSourceRanges"));
});

test("catalog and package command contributions stay in sync", () => {
  const manifest = readJsonFile<PackageManifest>("package.json");
  const nls = readJsonFile<Record<string, string>>("package.nls.json");
  const nlsRu = readJsonFile<Record<string, string>>("package.nls.ru.json");
  const contributes = manifest.contributes;
  assert.ok(contributes);

  const commands = contributes.commands ?? [];
  const commandById = new Map(commands.map((item) => [item.command ?? "", item]));

  for (const spec of ENTITY_TEMPLATE_COMMAND_SPECS) {
    const command = commandById.get(spec.commandId);
    assert.ok(command, `package.json is missing command '${spec.commandId}'`);

    const suffix = spec.commandId.split(".").at(-1) ?? "";
    const titleKey = `cmd.insertEntityTemplate.${suffix}.title`;
    assert.equal(command?.title, `%${titleKey}%`);
    assert.equal(typeof nls[titleKey], "string", `package.nls.json is missing key '${titleKey}'`);
    assert.equal(typeof nlsRu[titleKey], "string", `package.nls.ru.json is missing key '${titleKey}'`);
  }

  const submenuId = "helm-apps.insertEntityTemplateSubmenu";
  const submenus = contributes.submenus ?? [];
  const submenu = submenus.find((item) => item.id === submenuId);
  assert.ok(submenu, `package.json is missing submenu '${submenuId}'`);
  assert.equal(submenu?.label, "%submenu.insertEntityTemplate.label%");
  assert.equal(typeof nls["submenu.insertEntityTemplate.label"], "string");
  assert.equal(typeof nlsRu["submenu.insertEntityTemplate.label"], "string");

  const editorContextMenu = contributes.menus?.["editor/context"] ?? [];
  const insertSubmenuEntry = editorContextMenu.find((item) => item.submenu === submenuId);
  assert.ok(insertSubmenuEntry, "editor/context menu is missing template submenu entry");
  assert.equal(
    insertSubmenuEntry?.when?.includes(INSERT_ENTITY_TEMPLATE_MENU_CONTEXT),
    true,
    "editor/context submenu entry should be guarded by template visibility context",
  );

  const submenuItems = contributes.menus?.[submenuId] ?? [];
  assert.equal(
    submenuItems.length,
    ENTITY_TEMPLATE_COMMAND_SPECS.length,
    "submenu item count must match catalog command spec count",
  );
  for (const spec of ENTITY_TEMPLATE_COMMAND_SPECS) {
    const menuItem = submenuItems.find((item) => item.command === spec.commandId);
    assert.ok(menuItem, `submenu is missing command '${spec.commandId}'`);
    assert.equal(menuItem?.when, spec.contextKey);
  }
});
