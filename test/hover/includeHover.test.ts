import assert from "node:assert/strict";
import test from "node:test";

import { extractIncludeProfileBlock, extractLocalIncludeBlock, trimPreview } from "../../src/hover/includeHover";

test("extract local include block", () => {
  const text = `global:\n  _includes:\n    common:\n      labels: |-\n        team: platform\n    another:\n      enabled: true\napps-stateless:\n  api:\n    enabled: true\n`;

  const block = extractLocalIncludeBlock(text, "common");
  assert.equal(block, "common:\n  labels: |-\n    team: platform");
});

test("trim preview by lines and chars", () => {
  const many = Array.from({ length: 120 }, (_, i) => `k${i}: v`).join("\n");
  const trimmed = trimPreview(many, 10, 500);
  assert.match(trimmed, /truncated/);
});

test("extract include profile block from top-level include file", () => {
  const text = `apps-stateless-defaultApp:\n  enabled: true\n  image:\n    name: nginx\napps-stateful-defaultApp:\n  enabled: false\n`;

  const block = extractIncludeProfileBlock(text, "apps-stateless-defaultApp");
  assert.equal(block, "apps-stateless-defaultApp:\n  enabled: true\n  image:\n    name: nginx");
});

test("extract include profile block from wrapped global._includes", () => {
  const text = `global:\n  _includes:\n    apps-stateless-defaultApp:\n      enabled: true\n      image:\n        name: nginx\n    apps-stateful-defaultApp:\n      enabled: false\n`;

  const block = extractIncludeProfileBlock(text, "apps-stateless-defaultApp");
  assert.equal(
    block,
    "apps-stateless-defaultApp:\n  enabled: true\n  image:\n    name: nginx",
  );
});
