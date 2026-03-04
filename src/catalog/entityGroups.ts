export const BUILTIN_GROUP_TYPES = [
  "apps-stateless",
  "apps-stateful",
  "apps-jobs",
  "apps-cronjobs",
  "apps-services",
  "apps-ingresses",
  "apps-network-policies",
  "apps-configmaps",
  "apps-secrets",
  "apps-pvcs",
  "apps-limit-range",
  "apps-certificates",
  "apps-dex-clients",
  "apps-dex-authenticators",
  "apps-custom-prometheus-rules",
  "apps-grafana-dashboards",
  "apps-kafka-strimzi",
  "apps-infra",
  "apps-service-accounts",
  "apps-k8s-manifests",
] as const;

export type BuiltinGroupType = typeof BUILTIN_GROUP_TYPES[number];

export const APP_ENTRY_GROUP_TYPES = [
  "apps-stateless",
  "apps-stateful",
  "apps-jobs",
  "apps-cronjobs",
  "apps-services",
  "apps-ingresses",
  "apps-network-policies",
  "apps-configmaps",
  "apps-secrets",
  "apps-pvcs",
  "apps-limit-range",
  "apps-certificates",
  "apps-dex-clients",
  "apps-dex-authenticators",
  "apps-custom-prometheus-rules",
  "apps-grafana-dashboards",
  "apps-kafka-strimzi",
  "apps-service-accounts",
  "apps-k8s-manifests",
] as const;

export const WORKLOAD_GROUP_TYPES = [
  "apps-stateless",
  "apps-stateful",
  "apps-jobs",
  "apps-cronjobs",
] as const;

export const BUILTIN_GROUP_SET = new Set<string>(BUILTIN_GROUP_TYPES);
export const APP_ENTRY_GROUP_SET = new Set<string>(APP_ENTRY_GROUP_TYPES);
export const WORKLOAD_GROUP_SET = new Set<string>(WORKLOAD_GROUP_TYPES);

export type InsertionMode = "appEntity" | "groupScaffold";

export interface EntityTemplateCommandSpec {
  groupType: BuiltinGroupType;
  commandId: string;
  contextKey: string;
  appBase: string;
  insertionMode: InsertionMode;
  legacyCommandId?: string;
  legacyContextKey?: string;
}

type CommandSeed = {
  groupType: BuiltinGroupType;
  suffix: string;
  appBase: string;
  insertionMode?: InsertionMode;
  legacySuffix?: string;
};

const COMMAND_SEEDS: readonly CommandSeed[] = [
  { groupType: "apps-stateless", suffix: "appsStateless", appBase: "app", legacySuffix: "appsStateless" },
  { groupType: "apps-stateful", suffix: "appsStateful", appBase: "app", legacySuffix: "appsStateful" },
  { groupType: "apps-jobs", suffix: "appsJobs", appBase: "job", legacySuffix: "appsJobs" },
  { groupType: "apps-cronjobs", suffix: "appsCronjobs", appBase: "cronjob", legacySuffix: "appsCronjobs" },
  { groupType: "apps-services", suffix: "appsServices", appBase: "service", legacySuffix: "appsServices" },
  { groupType: "apps-ingresses", suffix: "appsIngresses", appBase: "ingress", legacySuffix: "appsIngresses" },
  { groupType: "apps-network-policies", suffix: "appsNetworkPolicies", appBase: "policy", legacySuffix: "appsNetworkPolicies" },
  { groupType: "apps-configmaps", suffix: "appsConfigmaps", appBase: "config", legacySuffix: "appsConfigmaps" },
  { groupType: "apps-secrets", suffix: "appsSecrets", appBase: "secret", legacySuffix: "appsSecrets" },
  { groupType: "apps-pvcs", suffix: "appsPvcs", appBase: "pvc", legacySuffix: "appsPvcs" },
  { groupType: "apps-limit-range", suffix: "appsLimitRange", appBase: "limits" },
  { groupType: "apps-certificates", suffix: "appsCertificates", appBase: "certificate" },
  { groupType: "apps-dex-clients", suffix: "appsDexClients", appBase: "dex-client" },
  { groupType: "apps-dex-authenticators", suffix: "appsDexAuthenticators", appBase: "authenticator" },
  { groupType: "apps-custom-prometheus-rules", suffix: "appsCustomPrometheusRules", appBase: "rules" },
  { groupType: "apps-grafana-dashboards", suffix: "appsGrafanaDashboards", appBase: "dashboard" },
  { groupType: "apps-kafka-strimzi", suffix: "appsKafkaStrimzi", appBase: "kafka" },
  { groupType: "apps-infra", suffix: "appsInfra", appBase: "infra", insertionMode: "groupScaffold" },
  { groupType: "apps-service-accounts", suffix: "appsServiceAccounts", appBase: "sa", legacySuffix: "appsServiceAccounts" },
  { groupType: "apps-k8s-manifests", suffix: "appsK8sManifests", appBase: "manifest", legacySuffix: "appsK8sManifests" },
];

const TEMPLATE_COMMAND_PREFIX = "helm-apps.insertEntityTemplate";
const TEMPLATE_CONTEXT_PREFIX = "helmApps.insertEntityTemplate";
const LEGACY_COMMAND_PREFIX = "helm-apps.insertEntityExample";
const LEGACY_CONTEXT_PREFIX = "helmApps.insertEntityExample";

export const INSERT_ENTITY_TEMPLATE_MENU_CONTEXT = `${TEMPLATE_CONTEXT_PREFIX}.visible`;
export const LEGACY_INSERT_ENTITY_EXAMPLE_MENU_CONTEXT = `${LEGACY_CONTEXT_PREFIX}.visible`;

export const ENTITY_TEMPLATE_COMMAND_SPECS: readonly EntityTemplateCommandSpec[] = COMMAND_SEEDS.map((seed) => ({
  groupType: seed.groupType,
  commandId: `${TEMPLATE_COMMAND_PREFIX}.${seed.suffix}`,
  contextKey: `${TEMPLATE_CONTEXT_PREFIX}.${seed.suffix}`,
  appBase: seed.appBase,
  insertionMode: seed.insertionMode ?? "appEntity",
  legacyCommandId: seed.legacySuffix ? `${LEGACY_COMMAND_PREFIX}.${seed.legacySuffix}` : undefined,
  legacyContextKey: seed.legacySuffix ? `${LEGACY_CONTEXT_PREFIX}.${seed.legacySuffix}` : undefined,
}));

const BASE_APP_ROOT_KEYS = [
  "enabled",
  "_include",
  "name",
  "annotations",
  "labels",
];

const GROUP_APP_ROOT_KEYS: Partial<Record<BuiltinGroupType, readonly string[]>> = {
  "apps-stateless": [
    "containers",
    "initContainers",
    "resources",
    "envVars",
    "service",
    "serviceAccount",
    "affinity",
    "tolerations",
    "nodeSelector",
    "volumes",
    "imagePullSecrets",
    "podDisruptionBudget",
    "horizontalPodAutoscaler",
    "verticalPodAutoscaler",
  ],
  "apps-stateful": [
    "containers",
    "initContainers",
    "resources",
    "envVars",
    "service",
    "serviceAccount",
    "affinity",
    "tolerations",
    "nodeSelector",
    "volumes",
    "imagePullSecrets",
    "horizontalPodAutoscaler",
    "verticalPodAutoscaler",
  ],
  "apps-jobs": [
    "containers",
    "initContainers",
    "resources",
    "envVars",
    "serviceAccount",
    "affinity",
    "tolerations",
    "nodeSelector",
    "volumes",
    "imagePullSecrets",
    "backoffLimit",
    "activeDeadlineSeconds",
    "restartPolicy",
  ],
  "apps-cronjobs": [
    "schedule",
    "concurrencyPolicy",
    "startingDeadlineSeconds",
    "successfulJobsHistoryLimit",
    "failedJobsHistoryLimit",
    "containers",
    "initContainers",
    "resources",
    "envVars",
    "serviceAccount",
    "affinity",
    "tolerations",
    "nodeSelector",
    "volumes",
    "imagePullSecrets",
  ],
  "apps-services": ["selector", "type", "ports", "headless", "annotations"],
  "apps-ingresses": [
    "class",
    "host",
    "hosts",
    "paths",
    "tls",
    "ingressClassName",
    "service",
    "servicePort",
    "dexAuth",
    "sendAuthorizationHeader",
    "annotations",
  ],
  "apps-network-policies": [
    "type",
    "podSelector",
    "policyTypes",
    "ingress",
    "egress",
    "ingressDeny",
    "egressDeny",
    "endpointSelector",
    "extraSpec",
  ],
  "apps-configmaps": ["data", "binaryData", "envVars", "immutable"],
  "apps-secrets": ["type", "data", "binaryData", "envVars", "immutable", "stringData", "kind"],
  "apps-pvcs": ["storageClassName", "accessModes", "resources"],
  "apps-limit-range": ["limits"],
  "apps-certificates": ["clusterIssuer", "host", "hosts"],
  "apps-dex-clients": ["redirectURIs"],
  "apps-dex-authenticators": [
    "applicationDomain",
    "applicationIngressClassName",
    "applicationIngressCertificateSecretName",
    "allowedGroups",
    "sendAuthorizationHeader",
    "whitelistSourceRanges",
    "nodeSelector",
    "tolerations",
  ],
  "apps-custom-prometheus-rules": ["groups"],
  "apps-grafana-dashboards": ["folder"],
  "apps-kafka-strimzi": ["kafka", "zookeeper", "topics", "entityOperator", "exporter", "deckhouseMetrics"],
  "apps-service-accounts": ["clusterRole", "roles", "clusterRoles"],
  "apps-k8s-manifests": ["apiVersion", "kind", "spec", "fieldsYAML", "extraFields"],
};

export function getAllowedAppRootKeysByGroup(group: string): Set<string> {
  if (!APP_ENTRY_GROUP_SET.has(group)) {
    return new Set<string>();
  }
  const typed = group as BuiltinGroupType;
  const extra = GROUP_APP_ROOT_KEYS[typed] ?? [];
  return new Set<string>([...BASE_APP_ROOT_KEYS, ...extra]);
}

export function isWorkloadGroupType(group: string): boolean {
  return WORKLOAD_GROUP_SET.has(group);
}
