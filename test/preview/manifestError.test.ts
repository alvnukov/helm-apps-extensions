import assert from "node:assert/strict";
import test from "node:test";
import { formatManifestPreviewError, parseManifestPreviewError } from "../../src/preview/manifestError";

test("parseManifestPreviewError extracts structured fields from happ/helm error", () => {
  const input = "render preview manifest: helm template failed: helm: Error: execution error at (happ-lsp-preview/templates/init-helm-apps-library.yaml:1:4): [helm-apps:E_UNEXPECTED_LIST] native YAML list is not allowed here | path=Values.apps-stateless.app-1.service.ports | hint=for Kubernetes list fields use YAML block string ('|') | docs=docs/faq.md#2-почему-list-в-values-почти-везде-запрещены";
  const parsed = parseManifestPreviewError(input);

  assert.equal(parsed.code, "E_UNEXPECTED_LIST");
  assert.equal(parsed.location, "happ-lsp-preview/templates/init-helm-apps-library.yaml:1:4");
  assert.equal(parsed.path, "Values.apps-stateless.app-1.service.ports");
  assert.equal(parsed.hint, "for Kubernetes list fields use YAML block string ('|')");
  assert.equal(parsed.docs, "docs/faq.md#2-почему-list-в-values-почти-везде-запрещены");
  assert.equal(
    parsed.docsUrl,
    "https://github.com/alvnukov/helm-apps/blob/main/docs/faq.md#2-почему-list-в-values-почти-везде-запрещены",
  );
  assert.equal(parsed.message, "native YAML list is not allowed here");
});

test("formatManifestPreviewError renders readable yaml block with context and raw error", () => {
  const input = "helm template failed: Error: [helm-apps:E_BAD_INPUT] bad field value | path=Values.apps.api.port | hint=expected integer";
  const out = formatManifestPreviewError(input, {
    fileUri: "file:///repo/.helm/values.yaml",
    group: "apps-stateless",
    app: "api",
    env: "prod",
  });

  assert.match(out, /^# manifest preview failed/m);
  assert.match(out, /error:\n  message: "bad field value"/m);
  assert.match(out, /  code: "E_BAD_INPUT"/m);
  assert.match(out, /  path: "Values\.apps\.api\.port"/m);
  assert.match(out, /  hint: "expected integer"/m);
  assert.match(out, /context:\n  entity: "apps-stateless\.api"\n  env: "prod"\n  fileUri: "file:\/\/\/repo\/\.helm\/values\.yaml"/m);
  assert.match(out, /rawError: \|-/m);
  assert.match(out, /  helm template failed: Error: \[helm-apps:E_BAD_INPUT\]/m);
});
