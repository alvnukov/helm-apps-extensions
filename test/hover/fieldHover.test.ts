import assert from "node:assert/strict";
import test from "node:test";

import { buildFieldDocMarkdown, buildFieldDocMarkdownLocalized, findFieldDoc, findKeyPathAtPosition } from "../../src/hover/fieldHover";
import { APP_ENTRY_GROUP_SET, BUILTIN_GROUP_TYPES, getAllowedAppRootKeysByGroup } from "../../src/catalog/entityGroups";

test("finds path for nested key at cursor", () => {
  const yaml = `global:
  env: prod
apps-stateless:
  nginx:
    enabled: true
`;
  const path = findKeyPathAtPosition(yaml, 4, 6);
  assert.deepEqual(path, ["apps-stateless", "nginx", "enabled"]);
});

test("finds doc for wildcard app path", () => {
  const doc = findFieldDoc(["apps-stateless", "nginx", "enabled"]);
  assert.ok(doc);
  assert.equal(doc?.title, "Resource Toggle");
});

test("finds doc for custom group __GroupVars__.type", () => {
  const doc = findFieldDoc(["test-app-stateless", "__GroupVars__", "type"]);
  assert.ok(doc);
  assert.equal(doc?.title, "Group Renderer Type");
});

test("markdown contains key sections", () => {
  const doc = findFieldDoc(["global", "env"]);
  assert.ok(doc);
  const md = buildFieldDocMarkdown(["global", "env"], doc!);
  assert.ok(md.includes("**Environment Selector**"));
  assert.ok(md.includes("**Type**:"));
  assert.ok(md.includes("```yaml"));
});

test("returns dynamic doc for built-in top-level group", () => {
  const doc = findFieldDoc(["apps-certificates"]);
  assert.ok(doc);
  assert.equal(doc?.title, "Built-in Group");
});

test("returns dynamic doc for app entry node", () => {
  const doc = findFieldDoc(["apps-stateless", "nginx"]);
  assert.ok(doc);
  assert.equal(doc?.title, "App Entry");
});

test("returns explicit doc for releases matrix", () => {
  const doc = findFieldDoc(["global", "releases"]);
  assert.ok(doc);
  assert.equal(doc?.title, "Release Matrix");
});

test("custom global keys and nested values have dedicated docs", () => {
  const globalKey = findFieldDoc(["global", "base_url"]);
  assert.ok(globalKey);
  assert.equal(globalKey?.title, "Custom Global Setting");

  const globalNested = findFieldDoc(["global", "base_url", "prod"]);
  assert.ok(globalNested);
  assert.equal(globalNested?.title, "Custom Global Value");
});

test("returns unusual-field doc for unsupported root key under built-in app", () => {
  const doc = findFieldDoc(["apps-stateless", "nginx", "myCustomFlag"]);
  assert.ok(doc);
  assert.equal(doc?.title, "Field Is Unusual For This Group");
});

test("underscore helper roots use dedicated chart-helper docs", () => {
  const doc = findFieldDoc(["apps-stateless", "nginx", "_options", "metricsEnabled"]);
  assert.ok(doc);
  assert.equal(doc?.title, "Chart Helper Option Entry");

  const envOverride = findFieldDoc(["apps-stateless", "nginx", "_options", "metricsEnabled", "prod"]);
  assert.ok(envOverride);
  assert.equal(envOverride?.title, "Environment-specific Override Branch");
});

test("returns unknown-field doc for nested custom key inside supported root block", () => {
  const doc = findFieldDoc(["apps-stateless", "nginx", "containers", "main", "myCustomFlag"]);
  assert.ok(doc);
  assert.equal(doc?.title, "Custom or Unknown Field");
});

test("env-map branches have dedicated docs instead of unknown fallback", () => {
  const defaultBranch = findFieldDoc(["apps-stateless", "api", "replicas", "_default"]);
  assert.ok(defaultBranch);
  assert.equal(defaultBranch?.title, "Environment Default Branch");

  const envBranch = findFieldDoc(["apps-stateless", "api", "replicas", "prod"]);
  assert.ok(envBranch);
  assert.equal(envBranch?.title, "Environment-specific Override Branch");
});

test("yaml merge key returns dedicated helper doc", () => {
  const doc = findFieldDoc(["apps-stateless", "api", "<<"]);
  assert.ok(doc);
  assert.equal(doc?.title, "YAML Merge Key");
});

test("include profile payload path gets dedicated include-profile hover", () => {
  const profile = findFieldDoc(["global", "_includes", "python-backend"]);
  assert.ok(profile);
  assert.equal(profile?.title, "Include Profile Entry");

  const nested = findFieldDoc(["global", "_includes", "python-backend", "containers", "main"]);
  assert.ok(nested);
  assert.equal(nested?.title, "Include Profile Field");
});

test("returns resources doc for kafka-strimzi app resources key", () => {
  const doc = findFieldDoc(["apps-kafka-strimzi", "test-kafka", "resources"]);
  assert.ok(doc);
  assert.equal(doc?.title, "Kafka Broker Resources");
});

test("helper markdown includes docs link", () => {
  const doc = findFieldDoc(["apps-stateless", "api", "containers", "main", "configFilesYAML"]);
  assert.ok(doc);
  const md = buildFieldDocMarkdown(["apps-stateless", "api", "containers", "main", "configFilesYAML"], doc!);
  assert.ok(md.includes("https://github.com/alvnukov/helm-apps/blob/main/docs/reference-values.md#param-configfilesyaml"));
});

test("envVars helper points to dedicated envVars docs section", () => {
  const doc = findFieldDoc(["apps-stateful", "app-1", "initContainers", "init-container-1", "envVars"]);
  assert.ok(doc);
  const md = buildFieldDocMarkdown(["apps-stateful", "app-1", "initContainers", "init-container-1", "envVars"], doc!);
  assert.ok(md.includes("https://github.com/alvnukov/helm-apps/blob/main/docs/reference-values.md#param-envvars-usage"));
  assert.ok(md.includes("**Example**:"));
});

test("resources helper has inline example in fallback-by-key mode", () => {
  const doc = findFieldDoc(["apps-kafka-strimzi", "test-kafka", "resources"]);
  assert.ok(doc);
  const md = buildFieldDocMarkdown(["apps-kafka-strimzi", "test-kafka", "resources"], doc!);
  assert.ok(md.includes("requests:"));
  assert.ok(md.includes("limits:"));
});

test("k8s field markdown switches docs link by locale", () => {
  const doc = findFieldDoc(["apps-stateless", "api", "containers", "main", "command"]);
  assert.ok(doc);
  const ru = buildFieldDocMarkdownLocalized(["apps-stateless", "api", "containers", "main", "command"], doc!, "ru");
  const en = buildFieldDocMarkdownLocalized(["apps-stateless", "api", "containers", "main", "command"], doc!, "en");
  assert.ok(ru.includes("docs/k8s-fields-guide.md#command-and-args"));
  assert.ok(en.includes("docs/k8s-fields-guide.en.md#command-and-args"));
});

test("k8s field markdown contains official kubernetes docs link", () => {
  const doc = findFieldDoc(["apps-stateless", "api", "containers", "main", "livenessProbe"]);
  assert.ok(doc);
  const md = buildFieldDocMarkdown(["apps-stateless", "api", "containers", "main", "livenessProbe"], doc!);
  assert.ok(md.includes("https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/"));
});

test("ignores key-like text inside block scalars", () => {
  const yaml = `apps-stateless:
  nginx:
    labels: |-
      enabled: true
`;
  const path = findKeyPathAtPosition(yaml, 3, 8);
  assert.equal(path, null);
});

test("initContainers node has explicit helper doc", () => {
  const path = ["apps-cronjobs", "cronjob-1", "initContainers"];
  const doc = findFieldDoc(path);
  assert.ok(doc);
  assert.equal(doc?.title, "Init Containers Block");
  assert.ok((doc?.summary ?? "").toLowerCase().includes("init"));
});

test("schema fallback for named map entry explains map item semantics", () => {
  const path = ["apps-cronjobs", "cronjob-1", "initContainers", "init-container-1"];
  const doc = findFieldDoc(path);
  assert.ok(doc);
  assert.ok((doc?.summary ?? "").includes("Named entry"));
});

test("nested _include does not fall back to unknown", () => {
  const path = ["apps-stateless", "app-1", "containers", "app-1", "_include"];
  const doc = findFieldDoc(path);
  assert.ok(doc);
  assert.equal(doc?.title, "Include Profiles");
});

test("custom group resolves docs by __GroupVars__.type for nested fields", () => {
  const yaml = `global:
  env: dev
my-apps:
  __GroupVars__:
    type: apps-stateless
  app-1:
    containers:
      app-1:
        image:
          name: nginx
`;
  const path = ["my-apps", "app-1", "containers"];
  const doc = findFieldDoc(path, { documentText: yaml });
  assert.ok(doc);
  assert.equal(doc?.title, "Containers Spec");
});

test("container image leaf fields have explicit docs", () => {
  const imageName = findFieldDoc(["apps-stateless", "app-1", "containers", "app-1", "image", "name"]);
  assert.ok(imageName);
  assert.equal(imageName?.title, "Container Image Repository");

  const imageTag = findFieldDoc(["apps-stateless", "app-1", "containers", "app-1", "image", "staticTag"]);
  assert.ok(imageTag);
  assert.equal(imageTag?.title, "Container Image Tag");
});

test("container image pull and termination policies have explicit docs", () => {
  const pullPolicy = findFieldDoc(["apps-stateless", "api", "containers", "main", "imagePullPolicy"]);
  assert.ok(pullPolicy);
  assert.equal(pullPolicy?.title, "Image Pull Policy");

  const termPolicy = findFieldDoc(["apps-stateless", "api", "containers", "main", "terminationMessagePolicy"]);
  assert.ok(termPolicy);
  assert.equal(termPolicy?.title, "Termination Message Policy");
});

test("container envVars entry has dedicated doc", () => {
  const doc = findFieldDoc(["apps-stateless", "api", "containers", "main", "envVars", "LOG_LEVEL"]);
  assert.ok(doc);
  assert.equal(doc?.title, "Container envVars Entry");
});

test("configmaps and secrets data entries have dedicated docs", () => {
  const cfgEntry = findFieldDoc(["apps-configmaps", "cfg", "data", "APP_MODE"]);
  assert.ok(cfgEntry);
  assert.equal(cfgEntry?.title, "ConfigMap Data Entry");

  const secretEntry = findFieldDoc(["apps-secrets", "main", "data", "DB_PASSWORD"]);
  assert.ok(secretEntry);
  assert.equal(secretEntry?.title, "Secret Data Entry");
});

test("container config file content paths have dedicated docs", () => {
  const textContent = findFieldDoc(["apps-stateless", "api", "containers", "main", "configFiles", "app.yaml", "content"]);
  assert.ok(textContent);
  assert.equal(textContent?.title, "Config File Content");

  const yamlContent = findFieldDoc(["apps-stateless", "api", "containers", "main", "configFilesYAML", "app.yaml", "content"]);
  assert.ok(yamlContent);
  assert.equal(yamlContent?.title, "YAML Config File Content");
});

test("config file subPath and YAML include_files paths have dedicated docs", () => {
  const subPath = findFieldDoc(["apps-cronjobs", "etcd-backup", "containers", "main", "configFiles", "backup-script", "subPath"]);
  assert.ok(subPath);
  assert.equal(subPath?.title, "Config File SubPath");

  const includeFiles = findFieldDoc(["apps-stateless", "worker", "containers", "main", "configFilesYAML", "op_config.yaml", "content", "_include_files"]);
  assert.ok(includeFiles);
  assert.equal(includeFiles?.title, "YAML Content Include Files");
});

test("nodeSelector dynamic entries have dedicated docs", () => {
  const rootEntry = findFieldDoc(["apps-jobs", "load-dump", "nodeSelector", "devops-p"]);
  assert.ok(rootEntry);
  assert.equal(rootEntry?.title, "Node Selector Entry");

  const nestedEntry = findFieldDoc(["apps-stateful", "minio", "nodeSelector", "stage1", "kubernetes.io/hostname"]);
  assert.ok(nestedEntry);
  assert.equal(nestedEntry?.title, "Nested Node Selector Entry");
});

test("kafka-strimzi nested zookeeper/entityOperator fields have dedicated docs", () => {
  const topicOperator = findFieldDoc(["apps-kafka-strimzi", "kafka", "entityOperator", "topicOperator"]);
  assert.ok(topicOperator);
  assert.equal(topicOperator?.title, "Topic Operator Settings");

  const zkStorageSize = findFieldDoc(["apps-kafka-strimzi", "kafka", "zookeeper", "storage", "size"]);
  assert.ok(zkStorageSize);
  assert.equal(zkStorageSize?.title, "Zookeeper Storage Size");

  const autoCreateTopic = findFieldDoc(["apps-kafka-strimzi", "kafka", "autoCreateTopicEnable"]);
  assert.ok(autoCreateTopic);
  assert.equal(autoCreateTopic?.title, "Auto Create Topic Flag");

  const brokerHost = findFieldDoc(["apps-kafka-strimzi", "kafka", "brokers", "host"]);
  assert.ok(brokerHost);
  assert.equal(brokerHost?.title, "Kafka Bootstrap Host");

  const protocolVersion = findFieldDoc(["apps-kafka-strimzi", "kafka", "interBrokerProtocolVersion"]);
  assert.ok(protocolVersion);
  assert.equal(protocolVersion?.title, "Inter-broker Protocol Version");
});

test("custom group resolves docs by env-map __GroupVars__.type", () => {
  const yaml = `global:
  env: prod
apps-routes:
  __GroupVars__:
    type:
      _default: apps-ingresses
  ui:
    host: ui.example.local
`;
  const doc = findFieldDoc(["apps-routes", "ui", "host"], { documentText: yaml });
  assert.ok(doc);
  assert.equal(doc?.title, "Ingress Host");
});

test("nested workload service keys reuse standalone service docs", () => {
  const doc = findFieldDoc(["apps-stateless", "api", "service", "clusterIP"]);
  assert.ok(doc);
  assert.equal(doc?.title, "Service ClusterIP");
});

test("unsupported nested workload service key is marked unusual", () => {
  const doc = findFieldDoc(["apps-stateless", "api", "service", "metadata"]);
  assert.ok(doc);
  assert.equal(doc?.title, "Field Is Unusual For This Group");
});

test("custom workload group resolves nested service docs through effective type", () => {
  const yaml = `global:
  env: dev
workload-custom:
  __GroupVars__:
    type: apps-stateless
  app-1:
    service:
      clusterIP: 10.96.10.25
`;
  const doc = findFieldDoc(["workload-custom", "app-1", "service", "clusterIP"], { documentText: yaml });
  assert.ok(doc);
  assert.equal(doc?.title, "Service ClusterIP");
});

test("path-specific service type doc overrides generic type", () => {
  const doc = findFieldDoc(["apps-services", "api", "type"]);
  assert.ok(doc);
  assert.equal(doc?.title, "Service Type");
});

test("path-specific secret type doc overrides generic type", () => {
  const doc = findFieldDoc(["apps-secrets", "app-secret", "type"]);
  assert.ok(doc);
  assert.equal(doc?.title, "Secret Type");
});

test("certificate fields have certificate-specific docs", () => {
  const issuer = findFieldDoc(["apps-certificates", "api-cert", "clusterIssuer"]);
  assert.ok(issuer);
  assert.equal(issuer?.title, "Certificate ClusterIssuer");

  const primaryHost = findFieldDoc(["apps-certificates", "api-cert", "host"]);
  assert.ok(primaryHost);
  assert.equal(primaryHost?.title, "Certificate Host");

  const sanHosts = findFieldDoc(["apps-certificates", "api-cert", "hosts"]);
  assert.ok(sanHosts);
  assert.equal(sanHosts?.title, "Certificate SAN Hosts");
});

test("pvc resources field has pvc-specific doc", () => {
  const resources = findFieldDoc(["apps-pvcs", "data-volume", "resources"]);
  assert.ok(resources);
  assert.equal(resources?.title, "PVC Requested Resources");
});

test("pvc extraSpec field has pvc-specific doc", () => {
  const extraSpec = findFieldDoc(["apps-pvcs", "data-volume", "extraSpec"]);
  assert.ok(extraSpec);
  assert.equal(extraSpec?.title, "PVC Extra Spec Patch");
});

test("limit-range limits field has limit-range-specific doc", () => {
  const limits = findFieldDoc(["apps-limit-range", "namespace-defaults", "limits"]);
  assert.ok(limits);
  assert.equal(limits?.title, "LimitRange Limits Rules");
});

test("configmaps and secrets expose group-specific helper docs", () => {
  const configEnvVars = findFieldDoc(["apps-configmaps", "cfg", "envVars"]);
  assert.ok(configEnvVars);
  assert.equal(configEnvVars?.title, "ConfigMap envVars Helper");

  const secretExtra = findFieldDoc(["apps-secrets", "secret-main", "extraFields"]);
  assert.ok(secretExtra);
  assert.equal(secretExtra?.title, "Secret Extra Fields");

  const secretData = findFieldDoc(["apps-secrets", "secret-main", "data"]);
  assert.ok(secretData);
  assert.match(secretData?.summary ?? "", /base64/i);
});

test("legacy secret/configmap native keys are marked unusual with migration hints", () => {
  const configImmutable = findFieldDoc(["apps-configmaps", "cfg", "immutable"]);
  assert.ok(configImmutable);
  assert.equal(configImmutable?.title, "Field Is Unusual For This Group");
  assert.ok((configImmutable?.notes ?? []).some((note) => note.includes("extraFields.immutable")));

  const secretStringData = findFieldDoc(["apps-secrets", "secret-main", "stringData"]);
  assert.ok(secretStringData);
  assert.equal(secretStringData?.title, "Field Is Unusual For This Group");
  assert.ok((secretStringData?.notes ?? []).some((note) => note.includes("extraFields.stringData")));

  const secretKind = findFieldDoc(["apps-secrets", "secret-main", "kind"]);
  assert.ok(secretKind);
  assert.equal(secretKind?.title, "Field Is Unusual For This Group");
  assert.ok((secretKind?.notes ?? []).some((note) => note.includes("apps-k8s-manifests")));
});

test("path-specific network policy type doc overrides generic type", () => {
  const doc = findFieldDoc(["apps-network-policies", "deny-all", "type"]);
  assert.ok(doc);
  assert.equal(doc?.title, "Network Policy Renderer Type");
});

test("ingress tls secret name has explicit context doc", () => {
  const tlsSecretDoc = findFieldDoc(["apps-ingresses", "api", "tls", "secret_name"]);
  assert.ok(tlsSecretDoc);
  assert.equal(tlsSecretDoc?.title, "Ingress TLS Secret Name");
});

test("legacy ingress servicePort is marked as unusual for current contract", () => {
  const doc = findFieldDoc(["apps-ingresses", "api", "servicePort"]);
  assert.ok(doc);
  assert.equal(doc?.title, "Field Is Unusual For This Group");
});

test("ingress targetPort/clusterIssuer helper fields have dedicated docs", () => {
  const targetPort = findFieldDoc(["apps-ingresses", "api", "targetPort"]);
  assert.ok(targetPort);
  assert.equal(targetPort?.title, "Ingress Target Port Helper");

  const issuer = findFieldDoc(["apps-ingresses", "api", "clusterIssuer"]);
  assert.ok(issuer);
  assert.equal(issuer?.title, "Ingress Cert ClusterIssuer");
});

test("chart-level helper flags have dedicated docs", () => {
  const restart = findFieldDoc(["apps-stateless", "api", "restartOnDeploy"]);
  assert.ok(restart);
  assert.equal(restart?.title, "Restart On Deploy Flag");

  const restartLegacy = findFieldDoc(["apps-stateless", "api", "restart-on-deploy"]);
  assert.ok(restartLegacy);
  assert.equal(restartLegacy?.title, "Restart On Deploy Flag (legacy key)");

  const werfSkipLogs = findFieldDoc(["apps-stateless", "api", "werfSkipLogs"]);
  assert.ok(werfSkipLogs);
  assert.equal(werfSkipLogs?.title, "Werf Skip Logs Hint");
});

test("hover notes keep purpose hint but avoid redundant group-context label", () => {
  const doc = findFieldDoc(["apps-ingresses", "api", "dexAuth"]);
  assert.ok(doc);
  assert.equal((doc?.notes ?? []).some((note) => note.includes("Group context:")), false);
  assert.equal((doc?.notesRu ?? []).some((note) => note.includes("Контекст группы:")), false);
  assert.equal((doc?.notesRu ?? []).some((note) => note.includes("Ingress маршрутизацию")), true);
});

test("standalone service clusterIP has explicit context doc", () => {
  const doc = findFieldDoc(["apps-services", "api-svc", "clusterIP"]);
  assert.ok(doc);
  assert.equal(doc?.title, "Service ClusterIP");
});

test("dex authenticator session field has explicit context doc", () => {
  const doc = findFieldDoc(["apps-dex-authenticators", "auth-main", "keepUsersLoggedInFor"]);
  assert.ok(doc);
  assert.equal(doc?.title, "Dex Session Lifetime");
});

test("dex authenticator sign-out field has explicit context doc", () => {
  const doc = findFieldDoc(["apps-dex-authenticators", "auth-main", "signOutURL"]);
  assert.ok(doc);
  assert.equal(doc?.title, "Dex Sign-out URL");
});

test("dex authenticator source-range field has explicit context doc", () => {
  const doc = findFieldDoc(["apps-dex-authenticators", "auth-main", "whitelistSourceRanges"]);
  assert.ok(doc);
  assert.equal(doc?.title, "Dex Authenticator Source CIDR Allowlist");
});

test("dex authenticator scheduling fields have explicit context docs", () => {
  const nodeSelector = findFieldDoc(["apps-dex-authenticators", "auth-main", "nodeSelector"]);
  assert.ok(nodeSelector);
  assert.equal(nodeSelector?.title, "Dex Authenticator Node Selector");

  const tolerations = findFieldDoc(["apps-dex-authenticators", "auth-main", "tolerations"]);
  assert.ok(tolerations);
  assert.equal(tolerations?.title, "Dex Authenticator Tolerations");
});

test("dex client redirect URIs doc highlights required field behavior", () => {
  const doc = findFieldDoc(["apps-dex-clients", "portal-client", "redirectURIs"]);
  assert.ok(doc);
  assert.equal(doc?.title, "Dex Client Redirect URIs");
  assert.ok((doc?.notes ?? []).some((note) => note.includes("Required by renderer")));
});

test("custom prometheus rules nested nodes have dedicated docs", () => {
  const groupEntry = findFieldDoc(["apps-custom-prometheus-rules", "slo", "groups", "app.rules"]);
  assert.ok(groupEntry);
  assert.equal(groupEntry?.title, "Prometheus Rule Group Entry");

  const alertEntry = findFieldDoc(["apps-custom-prometheus-rules", "slo", "groups", "app.rules", "alerts", "highErrorRate"]);
  assert.ok(alertEntry);
  assert.equal(alertEntry?.title, "Prometheus Alert Entry");

  const alertContent = findFieldDoc(["apps-custom-prometheus-rules", "slo", "groups", "app.rules", "alerts", "highErrorRate", "content"]);
  assert.ok(alertContent);
  assert.equal(alertContent?.title, "Prometheus Alert Content");

  const severity = findFieldDoc(["apps-custom-prometheus-rules", "slo", "groups", "app.rules", "alerts", "highErrorRate", "severity"]);
  assert.ok(severity);
  assert.equal(severity?.title, "Prometheus Alert Severity");

  const severityEnv = findFieldDoc(["apps-custom-prometheus-rules", "slo", "groups", "app.rules", "alerts", "highErrorRate", "severity", "prod"]);
  assert.ok(severityEnv);
  assert.equal(severityEnv?.title, "Environment-specific Override Branch");
});

test("k8s manifests dedicated top-level fields have explicit docs", () => {
  const metadata = findFieldDoc(["apps-k8s-manifests", "raw-obj", "metadata"]);
  assert.ok(metadata);
  assert.equal(metadata?.title, "Manifest Metadata");

  const topLevelData = findFieldDoc(["apps-k8s-manifests", "raw-obj", "data"]);
  assert.ok(topLevelData);
  assert.equal(topLevelData?.title, "Manifest Top-level Data");
});

test("k8s manifests legacy fieldsYAML is marked unusual with migration hint", () => {
  const fieldsYaml = findFieldDoc(["apps-k8s-manifests", "raw-obj", "fieldsYAML"]);
  assert.ok(fieldsYaml);
  assert.equal(fieldsYaml?.title, "Field Is Unusual For This Group");
  assert.ok((fieldsYaml?.notes ?? []).some((note) => note.includes("dedicated top-level keys")));
});

test("service-account namespace has explicit context doc", () => {
  const doc = findFieldDoc(["apps-service-accounts", "runtime", "namespace"]);
  assert.ok(doc);
  assert.equal(doc?.title, "ServiceAccount Namespace Override");
});

test("service-account automount token has explicit context doc", () => {
  const doc = findFieldDoc(["apps-service-accounts", "runtime", "automountServiceAccountToken"]);
  assert.ok(doc);
  assert.equal(doc?.title, "Automount ServiceAccount Token");
});

test("service-account imagePullSecrets has explicit context doc", () => {
  const doc = findFieldDoc(["apps-service-accounts", "runtime", "imagePullSecrets"]);
  assert.ok(doc);
  assert.equal(doc?.title, "ServiceAccount ImagePullSecrets");
});

test("service-account role map entry has dedicated hover", () => {
  const doc = findFieldDoc(["apps-service-accounts", "runtime", "roles", "pod-reader"]);
  assert.ok(doc);
  assert.equal(doc?.title, "Role Entry");
});

test("service-account nested role rules use specific RBAC doc", () => {
  const doc = findFieldDoc(["apps-service-accounts", "runtime", "roles", "pod-reader", "rules"]);
  assert.ok(doc);
  assert.equal(doc?.title, "Role Rules");
});

test("service-account nested rule verbs has dedicated RBAC leaf doc", () => {
  const doc = findFieldDoc(["apps-service-accounts", "runtime", "roles", "pod-reader", "rules", "allow-read", "verbs"]);
  assert.ok(doc);
  assert.equal(doc?.title, "RBAC Rule Verbs");
});

test("service-account nested binding name has dedicated doc", () => {
  const doc = findFieldDoc(["apps-service-accounts", "runtime", "clusterRoles", "viewer", "binding", "name"]);
  assert.ok(doc);
  assert.equal(doc?.title, "Binding Name Override");
});

test("service-account nested binding subjects use specific RBAC doc", () => {
  const doc = findFieldDoc(["apps-service-accounts", "runtime", "clusterRoles", "viewer", "binding", "subjects"]);
  assert.ok(doc);
  assert.equal(doc?.title, "ClusterRoleBinding Subjects");
});

test("service-account legacy clusterRole root key is marked as unusual", () => {
  const doc = findFieldDoc(["apps-service-accounts", "runtime", "clusterRole"]);
  assert.ok(doc);
  assert.equal(doc?.title, "Field Is Unusual For This Group");
  assert.ok((doc?.notes ?? []).some((note) => note.includes("does not consume root `clusterRole`")));
});

test("kafka-strimzi version has specific doc", () => {
  const doc = findFieldDoc(["apps-kafka-strimzi", "main", "version"]);
  assert.ok(doc);
  assert.equal(doc?.title, "Kafka Version");
});

test("kafka-strimzi topic entry has specific doc", () => {
  const doc = findFieldDoc(["apps-kafka-strimzi", "main", "topics", "app-events"]);
  assert.ok(doc);
  assert.equal(doc?.title, "Kafka Topic Spec");
});

test("kafka-strimzi topic retention has specific doc", () => {
  const doc = findFieldDoc(["apps-kafka-strimzi", "main", "topics", "app-events", "retention"]);
  assert.ok(doc);
  assert.equal(doc?.title, "Topic Retention (ms)");
});

test("stateless replicas key is treated as standard workload key", () => {
  const doc = findFieldDoc(["apps-stateless", "api", "replicas"]);
  assert.ok(doc);
  assert.equal(doc?.title, "Replicas Count");
});

test("stateful updateStrategy key has dedicated statefulset doc", () => {
  const doc = findFieldDoc(["apps-stateful", "db", "updateStrategy"]);
  assert.ok(doc);
  assert.equal(doc?.title, "StatefulSet Update Strategy");
});

test("jobs completionMode key has dedicated job doc", () => {
  const doc = findFieldDoc(["apps-jobs", "migrate", "completionMode"]);
  assert.ok(doc);
  assert.equal(doc?.title, "Job Completion Mode");
});

test("cronjob-only keys under apps-jobs are marked unusual with migration hints", () => {
  const concurrency = findFieldDoc(["apps-jobs", "manual", "concurrencyPolicy"]);
  assert.ok(concurrency);
  assert.equal(concurrency?.title, "Field Is Unusual For This Group");
  assert.ok((concurrency?.notes ?? []).some((note) => note.includes("apps-cronjobs")));

  const successHistory = findFieldDoc(["apps-jobs", "manual", "successfulJobsHistoryLimit"]);
  assert.ok(successHistory);
  assert.equal(successHistory?.title, "Field Is Unusual For This Group");
  assert.ok((successHistory?.notes ?? []).some((note) => note.includes("apps-cronjobs")));

  const failHistory = findFieldDoc(["apps-jobs", "manual", "failedJobsHistoryLimit"]);
  assert.ok(failHistory);
  assert.equal(failHistory?.title, "Field Is Unusual For This Group");
  assert.ok((failHistory?.notes ?? []).some((note) => note.includes("apps-cronjobs")));
});

test("cronjobs suspend key has dedicated scheduling doc", () => {
  const doc = findFieldDoc(["apps-cronjobs", "sync-cache", "suspend"]);
  assert.ok(doc);
  assert.equal(doc?.title, "Suspend Execution");
});

test("deep labels key gets explicit labels hover instead of unknown", () => {
  const doc = findFieldDoc(["apps-infra", "node-users", "ops", "labels"]);
  assert.ok(doc);
  assert.equal(doc?.title, "Labels");
});

test("catalog app-root keys are never marked as unusual fields", () => {
  for (const group of BUILTIN_GROUP_TYPES) {
    if (!APP_ENTRY_GROUP_SET.has(group)) {
      continue;
    }
    const allowed = getAllowedAppRootKeysByGroup(group);
    for (const key of allowed) {
      const doc = findFieldDoc([group, "sample-app", key]);
      assert.ok(doc, `${group}.${key}: doc should exist`);
      assert.notEqual(
        doc?.title,
        "Field Is Unusual For This Group",
        `${group}.${key}: should not be marked unusual`,
      );
      assert.notEqual(
        doc?.titleRu,
        "Ключ нетипичен для этой группы",
        `${group}.${key}: should not be marked unusual (ru)`,
      );
      assert.notEqual(
        doc?.title,
        "Custom or Unknown Field",
        `${group}.${key}: should not fall back to unknown hover`,
      );
    }
  }
});
