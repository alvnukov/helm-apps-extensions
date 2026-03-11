import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { DEFAULT_HAPP_LSP_ARGS, HAPP_LSP_METHODS } from "../../src/core/happProtocol";

type Contract = {
  entrypoint?: {
    args?: string[];
  };
  methods?: {
    resolveEntity?: string;
    renderEntityManifest?: string;
    getPreviewTheme?: string;
    optimizeValuesIncludes?: string;
  };
};

test("shared happ contract matches extension protocol constants", () => {
  const contractPath = path.resolve(__dirname, "../../../shared/happ-lsp-contract.json");
  const raw = fs.readFileSync(contractPath, "utf8");
  const contract = JSON.parse(raw) as Contract;

  assert.deepEqual(contract.entrypoint?.args ?? [], DEFAULT_HAPP_LSP_ARGS);
  assert.equal(contract.methods?.resolveEntity, HAPP_LSP_METHODS.resolveEntity);
  assert.equal(contract.methods?.renderEntityManifest, HAPP_LSP_METHODS.renderEntityManifest);
  assert.equal(contract.methods?.getPreviewTheme, HAPP_LSP_METHODS.getPreviewTheme);
  assert.equal(contract.methods?.optimizeValuesIncludes, HAPP_LSP_METHODS.optimizeValuesIncludes);
});
