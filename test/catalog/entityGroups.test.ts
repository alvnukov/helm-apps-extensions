import assert from "node:assert/strict";
import test from "node:test";

import {
  APP_ENTRY_GROUP_SET,
  BUILTIN_GROUP_TYPES,
  ENTITY_TEMPLATE_COMMAND_SPECS,
  INSERT_ENTITY_TEMPLATE_MENU_CONTEXT,
  LEGACY_INSERT_ENTITY_EXAMPLE_MENU_CONTEXT,
  getAllowedAppRootKeysByGroup,
} from "../../src/catalog/entityGroups";

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
