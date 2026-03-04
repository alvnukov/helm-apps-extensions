import { readFileSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import {
  APP_ENTRY_GROUP_SET,
  BUILTIN_GROUP_SET,
  getAllowedAppRootKeysByGroup,
} from "../catalog/entityGroups";

export interface FieldDoc {
  title: string;
  summary: string;
  type: string;
  notes?: string[];
  example?: string;
  docsLink?: string;
  docsLinkEn?: string;
  docsLinkRu?: string;
  k8sDocsLink?: string;
  titleRu?: string;
  summaryRu?: string;
  typeRu?: string;
  notesRu?: string[];
}

interface DocRule {
  pattern: string[];
  doc: FieldDoc;
}

interface FieldDocLookupContext {
  documentText?: string;
  env?: string;
}

interface GroupAppGuide {
  purpose: string;
  purposeRu: string;
  keys: string[];
  notes?: string[];
  notesRu?: string[];
}

type JsonSchema = {
  $ref?: string;
  description?: string;
  type?: string | string[];
  enum?: unknown[];
  default?: unknown;
  examples?: unknown[];
  properties?: Record<string, JsonSchema>;
  patternProperties?: Record<string, JsonSchema>;
  additionalProperties?: boolean | JsonSchema;
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  allOf?: JsonSchema[];
  $defs?: Record<string, JsonSchema>;
};

let schemaRootCache: JsonSchema | null = null;
const DOCS_ONLINE_BASE = "https://github.com/alvnukov/helm-apps/blob/main/";

const BASE_APP_KEYS = ["_include", "enabled", "name", "labels", "annotations"];

const GROUP_APP_GUIDES: Record<string, GroupAppGuide> = {
  "apps-stateless": {
    purpose: "Runs long-lived stateless app workloads.",
    purposeRu: "Запускает долгоживущие stateless workload-приложения.",
    keys: ["containers", "initContainers", "service", "serviceAccount", "resources", "horizontalPodAutoscaler", "verticalPodAutoscaler", "podDisruptionBudget"],
    notes: ["Main behavior is usually defined through `containers.<name>` and nested container fields."],
    notesRu: ["Основное поведение обычно задается через `containers.<name>` и вложенные container-поля."],
  },
  "apps-stateful": {
    purpose: "Runs stateful workloads where stable identity/storage matters.",
    purposeRu: "Запускает stateful workload-ы, где важны стабильная идентичность и хранилище.",
    keys: ["containers", "initContainers", "service", "serviceAccount", "resources", "volumes", "horizontalPodAutoscaler", "verticalPodAutoscaler"],
  },
  "apps-jobs": {
    purpose: "Runs one-shot/batch Kubernetes Jobs.",
    purposeRu: "Запускает одноразовые/пакетные Kubernetes Job.",
    keys: ["containers", "initContainers", "serviceAccount", "backoffLimit", "activeDeadlineSeconds", "restartPolicy", "resources"],
  },
  "apps-cronjobs": {
    purpose: "Runs scheduled Kubernetes CronJobs.",
    purposeRu: "Запускает плановые Kubernetes CronJob.",
    keys: ["schedule", "concurrencyPolicy", "startingDeadlineSeconds", "successfulJobsHistoryLimit", "failedJobsHistoryLimit", "containers", "initContainers", "serviceAccount"],
  },
  "apps-services": {
    purpose: "Declares standalone Service resources.",
    purposeRu: "Описывает standalone ресурсы Service.",
    keys: ["type", "ports", "selector", "headless", "annotations"],
  },
  "apps-service-accounts": {
    purpose: "Declares ServiceAccount and related RBAC bindings.",
    purposeRu: "Описывает ServiceAccount и связанные RBAC binding-и.",
    keys: [
      "name",
      "namespace",
      "automountServiceAccountToken",
      "clusterRole",
      "roles",
      "clusterRoles",
      "imagePullSecrets",
      "secrets",
      "apiVersion",
      "extraFields",
      "labels",
      "annotations",
    ],
  },
  "apps-ingresses": {
    purpose: "Declares Ingress routing and TLS/auth options.",
    purposeRu: "Описывает Ingress маршрутизацию и TLS/auth параметры.",
    keys: ["host", "hosts", "paths", "tls", "ingressClassName", "class", "dexAuth", "annotations"],
  },
  "apps-network-policies": {
    purpose: "Declares network access rules (Kubernetes/Cilium-style).",
    purposeRu: "Описывает правила сетевого доступа (Kubernetes/Cilium-стиль).",
    keys: ["type", "podSelector", "policyTypes", "ingress", "egress", "ingressDeny", "egressDeny", "endpointSelector", "extraSpec"],
  },
  "apps-configmaps": {
    purpose: "Declares ConfigMap resources used by apps and envFrom.",
    purposeRu: "Описывает ConfigMap ресурсы для приложений и envFrom.",
    keys: ["data", "binaryData", "envVars"],
  },
  "apps-secrets": {
    purpose: "Declares Secret resources used by apps and envFrom.",
    purposeRu: "Описывает Secret ресурсы для приложений и envFrom.",
    keys: ["type", "data", "binaryData", "envVars"],
  },
  "apps-pvcs": {
    purpose: "Declares PersistentVolumeClaim resources.",
    purposeRu: "Описывает ресурсы PersistentVolumeClaim.",
    keys: ["storageClassName", "accessModes", "resources"],
  },
  "apps-limit-range": {
    purpose: "Declares LimitRange policies.",
    purposeRu: "Описывает политики LimitRange.",
    keys: ["limits"],
  },
  "apps-certificates": {
    purpose: "Declares certificate resources (cert-manager style).",
    purposeRu: "Описывает certificate-ресурсы (в стиле cert-manager).",
    keys: ["clusterIssuer", "host", "hosts", "name"],
  },
  "apps-dex-clients": {
    purpose: "Declares Dex OAuth client entries.",
    purposeRu: "Описывает Dex OAuth client записи.",
    keys: ["redirectURIs", "name"],
  },
  "apps-dex-authenticators": {
    purpose: "Declares dex-authenticator integration resources.",
    purposeRu: "Описывает ресурсы интеграции dex-authenticator.",
    keys: [
      "applicationDomain",
      "applicationIngressClassName",
      "applicationIngressCertificateSecretName",
      "allowedGroups",
      "keepUsersLoggedInFor",
      "signOutURL",
      "sendAuthorizationHeader",
      "whitelistSourceRanges",
      "nodeSelector",
      "tolerations",
    ],
  },
  "apps-custom-prometheus-rules": {
    purpose: "Declares custom Prometheus rule groups/alerts.",
    purposeRu: "Описывает кастомные группы правил/алертов Prometheus.",
    keys: ["groups"],
  },
  "apps-grafana-dashboards": {
    purpose: "Declares Grafana dashboard placement metadata.",
    purposeRu: "Описывает метаданные размещения Grafana dashboard.",
    keys: ["folder"],
  },
  "apps-kafka-strimzi": {
    purpose: "Declares Strimzi Kafka stack components.",
    purposeRu: "Описывает компоненты Strimzi Kafka стека.",
    keys: ["kafka", "zookeeper", "topics", "entityOperator", "exporter", "deckhouseMetrics"],
  },
  "apps-infra": {
    purpose: "Declares infrastructure automation entities.",
    purposeRu: "Описывает инфраструктурные сущности автоматизации.",
    keys: ["node-users", "node-groups"],
  },
  "apps-k8s-manifests": {
    purpose: "Declares universal Kubernetes manifests when no specialized group fits.",
    purposeRu: "Описывает универсальные Kubernetes манифесты, когда нет подходящей специализированной группы.",
    keys: ["apiVersion", "kind", "spec", "fieldsYAML", "extraFields"],
  },
};

const GROUP_COMPONENT_HINTS: Record<string, Record<string, { en: string; ru: string }>> = {
  "apps-stateless": {
    containers: { en: "Main pod containers for stateless app runtime.", ru: "Основные pod-контейнеры для runtime stateless приложения." },
    initContainers: { en: "Init containers executed before main app startup.", ru: "Init-контейнеры, выполняемые до старта основного приложения." },
    service: { en: "Service exposure layer for this stateless app.", ru: "Слой Service-публикации для этого stateless приложения." },
    serviceAccount: { en: "Identity and RBAC binding used by workload pods.", ru: "Идентичность и RBAC-привязка, используемые pod workload-а." },
    horizontalPodAutoscaler: { en: "Horizontal scaling policy for this app.", ru: "Политика горизонтального масштабирования для этого приложения." },
    verticalPodAutoscaler: { en: "Vertical resources tuning policy for this app.", ru: "Политика вертикальной настройки ресурсов для этого приложения." },
    podDisruptionBudget: { en: "Availability guard during voluntary disruptions.", ru: "Ограничение доступности при добровольных прерываниях." },
  },
  "apps-stateful": {
    containers: { en: "Main stateful workload containers.", ru: "Основные контейнеры stateful workload-а." },
    initContainers: { en: "Init containers for state/bootstrap steps.", ru: "Init-контейнеры для state/bootstrap шагов." },
    service: { en: "Service settings, often used with stable network identity.", ru: "Настройки Service, часто с упором на стабильную сетевую идентичность." },
    volumes: { en: "Pod volumes for stateful data and mounts.", ru: "Pod-volumes для stateful данных и монтирования." },
  },
  "apps-jobs": {
    containers: { en: "Job execution containers.", ru: "Контейнеры выполнения Job." },
    backoffLimit: { en: "Retry limit before Job is marked failed.", ru: "Лимит повторов перед пометкой Job как failed." },
    activeDeadlineSeconds: { en: "Hard timeout for Job execution.", ru: "Жесткий таймаут выполнения Job." },
  },
  "apps-cronjobs": {
    schedule: { en: "Cron expression that triggers job runs.", ru: "Cron-выражение, которое запускает job." },
    concurrencyPolicy: { en: "How scheduler handles overlapping runs.", ru: "Как планировщик обрабатывает пересекающиеся запуски." },
    containers: { en: "CronJob pod containers.", ru: "Контейнеры pod для CronJob." },
  },
  "apps-services": {
    type: { en: "Service exposure mode (`ClusterIP`, `NodePort`, etc).", ru: "Режим публикации Service (`ClusterIP`, `NodePort` и т.д.)." },
    ports: { en: "Service ports exported by this resource.", ru: "Порты Service, экспортируемые этим ресурсом." },
    selector: { en: "Label selector that binds Service to target pods.", ru: "Label selector, связывающий Service с целевыми pod." },
    headless: { en: "Headless mode (no cluster IP) for direct pod addressing.", ru: "Headless-режим (без cluster IP) для прямой адресации pod." },
  },
  "apps-service-accounts": {
    namespace: { en: "Target namespace override for ServiceAccount and namespaced RBAC objects.", ru: "Переопределение namespace для ServiceAccount и namespaced RBAC-объектов." },
    automountServiceAccountToken: { en: "Controls automatic API token mount for pods using this ServiceAccount.", ru: "Управляет автоматическим монтированием API-токена в pod с этим ServiceAccount." },
    clusterRole: { en: "Primary cluster role mapping for this service account.", ru: "Основная cluster role привязка для этого service account." },
    roles: { en: "Namespaced RBAC roles generated for this account.", ru: "Namespaced RBAC роли, генерируемые для этого аккаунта." },
    clusterRoles: { en: "Cluster-scoped RBAC roles for this account.", ru: "Cluster-scoped RBAC роли для этого аккаунта." },
  },
  "apps-ingresses": {
    host: { en: "Primary hostname routed by ingress.", ru: "Основной hostname, маршрутизируемый ingress-ом." },
    hosts: { en: "Additional hostnames for ingress/certificate binding.", ru: "Дополнительные hostname для ingress/certificate привязки." },
    paths: { en: "Path routing rules sent to backend service.", ru: "Правила маршрутизации path в backend service." },
    tls: { en: "TLS enablement and secret binding for ingress.", ru: "Включение TLS и привязка секрета для ingress." },
    ingressClassName: { en: "Ingress controller class for this route.", ru: "Класс ingress-контроллера для этого маршрута." },
    class: { en: "Legacy ingress class field for compatibility.", ru: "Legacy-поле ingress class для совместимости." },
    service: { en: "Backend service name used by ingress route.", ru: "Имя backend service, используемое ingress-маршрутом." },
    servicePort: { en: "Backend service port used by ingress route.", ru: "Порт backend service, используемый ingress-маршрутом." },
    dexAuth: { en: "Dex auth integration on ingress layer.", ru: "Интеграция Dex-аутентификации на слое ingress." },
    sendAuthorizationHeader: { en: "Forwards authorization header from auth layer to backend app.", ru: "Пробрасывает authorization header из auth-слоя в backend-приложение." },
  },
  "apps-network-policies": {
    type: { en: "Policy rendering profile/type.", ru: "Профиль/тип рендера policy." },
    podSelector: { en: "Which pods this policy targets.", ru: "Какие pod являются целью этой policy." },
    policyTypes: { en: "Ingress/Egress directions enabled in policy.", ru: "Направления Ingress/Egress, включенные в policy." },
    ingress: { en: "Allowed inbound traffic rules.", ru: "Правила разрешенного входящего трафика." },
    egress: { en: "Allowed outbound traffic rules.", ru: "Правила разрешенного исходящего трафика." },
    ingressDeny: { en: "Explicit inbound deny rules (engine-specific).", ru: "Явные deny-правила входящего трафика (зависит от движка)." },
    egressDeny: { en: "Explicit outbound deny rules (engine-specific).", ru: "Явные deny-правила исходящего трафика (зависит от движка)." },
    endpointSelector: { en: "Endpoint selector block for advanced policy engines.", ru: "Endpoint selector для продвинутых policy-движков." },
    extraSpec: { en: "Additional raw spec patch merged after base generation.", ru: "Дополнительный raw spec-патч после базовой генерации." },
  },
  "apps-configmaps": {
    data: { en: "Key/value textual data stored in ConfigMap.", ru: "Текстовые key/value данные, хранимые в ConfigMap." },
    binaryData: { en: "Binary/base64 payload for ConfigMap.", ru: "Бинарный/base64 payload для ConfigMap." },
    envVars: { en: "Helper map for env-friendly key/value generation.", ru: "Helper-map для env-friendly генерации key/value." },
    immutable: { en: "Prevents ConfigMap data updates after creation.", ru: "Запрещает изменять данные ConfigMap после создания." },
  },
  "apps-secrets": {
    type: { en: "Kubernetes Secret type selector.", ru: "Селектор типа Kubernetes Secret." },
    data: { en: "Secret key/value content.", ru: "Содержимое Secret key/value." },
    binaryData: { en: "Binary secret payload map.", ru: "Карта бинарного payload для Secret." },
    envVars: { en: "Helper map for env-specific secret values.", ru: "Helper-map для env-специфичных secret-значений." },
    immutable: { en: "Prevents Secret data updates after creation.", ru: "Запрещает изменять данные Secret после создания." },
    stringData: { en: "Plain-text secret fields converted to `data` by Kubernetes.", ru: "Текстовые поля секрета, которые Kubernetes конвертирует в `data`." },
    kind: { en: "Compatibility override for target secret-like object kind.", ru: "Совместимое переопределение kind целевого secret-подобного объекта." },
  },
  "apps-pvcs": {
    storageClassName: { en: "Storage class used for PVC provisioning.", ru: "Storage class для provision PVC." },
    accessModes: { en: "PVC access mode list.", ru: "Список режимов доступа PVC." },
    resources: { en: "PVC requested storage resources.", ru: "Запрашиваемые storage-ресурсы PVC." },
  },
  "apps-limit-range": {
    limits: { en: "Default and max/min resource bounds for namespace workloads.", ru: "Default и max/min resource-границы для workload-ов namespace." },
  },
  "apps-certificates": {
    clusterIssuer: { en: "cert-manager ClusterIssuer for certificate issuance.", ru: "cert-manager ClusterIssuer для выпуска сертификата." },
    host: { en: "Primary certificate DNS name.", ru: "Основное DNS-имя сертификата." },
    hosts: { en: "Additional DNS names (SANs) for certificate.", ru: "Дополнительные DNS-имена (SAN) для сертификата." },
  },
  "apps-dex-clients": {
    redirectURIs: { en: "Allowed OAuth redirect URIs for Dex client.", ru: "Разрешенные OAuth redirect URI для Dex client." },
  },
  "apps-dex-authenticators": {
    applicationDomain: { en: "Public domain used by authenticator ingress.", ru: "Публичный домен для ingress аутентификатора." },
    applicationIngressClassName: { en: "Ingress class for authenticator application route.", ru: "Ingress class для маршрута authenticator приложения." },
    applicationIngressCertificateSecretName: { en: "TLS secret for authenticator ingress.", ru: "TLS secret для ingress аутентификатора." },
    allowedGroups: { en: "Identity groups permitted to pass auth.", ru: "Группы identity, которым разрешен доступ." },
    keepUsersLoggedInFor: { en: "Session lifetime for authenticated users.", ru: "Время жизни сессии для аутентифицированных пользователей." },
    signOutURL: { en: "URL used by authenticator sign-out flow.", ru: "URL, используемый в sign-out потоке authenticator." },
    sendAuthorizationHeader: { en: "Forwards authorization header to upstream app.", ru: "Пробрасывает authorization header в upstream приложение." },
    whitelistSourceRanges: { en: "Allowed source CIDR ranges for authenticator ingress.", ru: "Разрешенные source CIDR диапазоны для ingress authenticator." },
  },
  "apps-custom-prometheus-rules": {
    groups: { en: "Prometheus rule groups and alerts map.", ru: "Карта групп правил и алертов Prometheus." },
  },
  "apps-grafana-dashboards": {
    folder: { en: "Grafana folder where dashboard is placed.", ru: "Папка Grafana, куда помещается dashboard." },
  },
  "apps-kafka-strimzi": {
    kafka: { en: "Kafka broker cluster settings.", ru: "Настройки Kafka broker-кластера." },
    zookeeper: { en: "Zookeeper cluster settings.", ru: "Настройки Zookeeper-кластера." },
    topics: { en: "Managed Kafka topics definitions.", ru: "Определения управляемых Kafka topics." },
    entityOperator: { en: "Topic/User operator settings.", ru: "Настройки Topic/User operator-а." },
    exporter: { en: "Kafka metrics exporter settings.", ru: "Настройки экспортера метрик Kafka." },
    deckhouseMetrics: { en: "Deckhouse-specific metrics integration settings.", ru: "Настройки интеграции метрик для Deckhouse." },
  },
  "apps-infra": {
    "node-users": { en: "Managed users map applied to infrastructure nodes.", ru: "Карта управляемых пользователей, применяемых к инфраструктурным нодам." },
    "node-groups": { en: "Node groups inventory used by infra automation.", ru: "Инвентарь групп нод для infra-автоматизации." },
  },
  "apps-k8s-manifests": {
    apiVersion: { en: "Target API version for universal manifest.", ru: "Целевая API версия для универсального манифеста." },
    kind: { en: "Target Kubernetes kind for universal manifest.", ru: "Целевой Kubernetes kind для универсального манифеста." },
    spec: { en: "Raw manifest spec body.", ru: "Raw тело spec манифеста." },
    fieldsYAML: { en: "Additional raw top-level fields as YAML fragments.", ru: "Дополнительные raw top-level поля в виде YAML-фрагментов." },
    extraFields: { en: "Residual fields payload for fallback renderer.", ru: "Остаточный payload полей для fallback-рендера." },
  },
};

const RULES: DocRule[] = [
  {
    pattern: ["global", "env"],
    doc: {
      title: "Environment Selector",
      titleRu: "Выбор окружения",
      summary: "Selects active environment for env-maps (`_default`, `prod`, regex keys).",
      summaryRu: "Выбирает активное окружение для env-map (`_default`, `prod`, regex-ключи).",
      type: "string",
      notes: [
        "Used across all app groups for env-specific values.",
        "Can be any string, not limited to discovered envs.",
      ],
      notesRu: [
        "Используется во всех app-группах для env-специфичных значений.",
        "Может быть любой строкой, не ограничивается обнаруженными env.",
      ],
      example: "global:\n  env: prod\n",
    },
  },
  {
    pattern: ["global", "_includes"],
    doc: {
      title: "Include Profiles Registry",
      titleRu: "Реестр include-профилей",
      summary: "Reusable profiles merged by `_include` in groups/apps.",
      summaryRu: "Переиспользуемые профили, которые мержатся через `_include` в группах/приложениях.",
      type: "map",
      docsLink: "docs/reference-values.md#param-global-includes",
      notes: [
        "Profiles merge recursively.",
        "App-local values override included profile values.",
      ],
      notesRu: [
        "Профили мержатся рекурсивно.",
        "Локальные значения приложения переопределяют include-профили.",
      ],
      example: "global:\n  _includes:\n    apps-default:\n      enabled: true\n",
    },
  },
  {
    pattern: ["*", "__GroupVars__", "type"],
    doc: {
      title: "Group Renderer Type",
      titleRu: "Тип рендерера группы",
      summary: "Defines renderer for a custom group (built-in `apps-*` or custom renderer type).",
      summaryRu: "Определяет рендерер для кастомной группы (встроенный `apps-*` или пользовательский тип).",
      type: "string | env-map",
      notes: [
        "For custom renderer, define template `<type>.render` in chart templates.",
      ],
      notesRu: [
        "Для кастомного рендерера определите шаблон `<type>.render` в templates чарта.",
      ],
      example: "custom-group:\n  __GroupVars__:\n    type: apps-stateless\n",
    },
  },
  {
    pattern: ["apps-stateless", "*", "containers"],
    doc: {
      title: "Stateless Containers",
      titleRu: "Контейнеры stateless приложения",
      summary: "Main runtime containers for `apps-stateless` workload.",
      summaryRu: "Основные runtime-контейнеры для workload `apps-stateless`.",
      type: "map(name -> container spec)",
      docsLink: "docs/reference-values.md#param-apps-sections",
      notes: [
        "Each map key becomes container name in pod template.",
        "Primary place where image, env, probes and ports are configured.",
      ],
      notesRu: [
        "Каждый ключ map становится именем контейнера в pod template.",
        "Основное место настройки image, env, probes и портов.",
      ],
      example: "apps-stateless:\n  api:\n    containers:\n      app:\n        image:\n          name: nginx\n",
    },
  },
  {
    pattern: ["apps-stateless", "*", "initContainers"],
    doc: {
      title: "Stateless Init Containers",
      titleRu: "Init-контейнеры stateless приложения",
      summary: "Startup/preparation containers executed before main `containers`.",
      summaryRu: "Подготовительные контейнеры, выполняемые до основных `containers`.",
      type: "map(name -> container spec)",
      docsLink: "docs/reference-values.md#param-apps-sections",
      example: "initContainers:\n  init-db:\n    image:\n      name: busybox\n",
    },
  },
  {
    pattern: ["apps-stateless", "*", "service"],
    doc: {
      title: "Stateless Service",
      titleRu: "Service для stateless приложения",
      summary: "Service configuration exposing this `apps-stateless` app.",
      summaryRu: "Конфигурация Service для публикации этого `apps-stateless` приложения.",
      type: "map",
      docsLink: "docs/reference-values.md#param-service",
      notes: [
        "Use for stable service DNS/port exposure.",
      ],
      notesRu: [
        "Используется для стабильной DNS/port публикации сервиса.",
      ],
      example: "service:\n  enabled: true\n  ports: |-\n    - name: http\n      port: 80\n",
    },
  },
  {
    pattern: ["apps-stateless", "*", "service", "ports"],
    doc: {
      title: "Stateless Service Ports",
      titleRu: "Порты Service в stateless приложении",
      summary: "Service-level ports exposed for this app.",
      summaryRu: "Порты уровня Service, публикуемые для этого приложения.",
      type: "YAML block string",
      docsLink: "docs/reference-values.md#param-service",
      k8sDocsLink: "https://kubernetes.io/docs/concepts/services-networking/service/",
      example: "ports: |-\n  - name: http\n    port: 80\n    targetPort: 8080\n",
    },
  },
  {
    pattern: ["apps-stateless", "*", "containers", "*", "ports"],
    doc: {
      title: "Stateless Container Ports",
      titleRu: "Порты контейнера в stateless приложении",
      summary: "Container ports declared in pod template for this app.",
      summaryRu: "Порты контейнера, объявляемые в pod template этого приложения.",
      type: "YAML block string",
      docsLinkEn: "docs/k8s-fields-guide.en.md#ports",
      docsLinkRu: "docs/k8s-fields-guide.md#ports",
      k8sDocsLink: "https://kubernetes.io/docs/concepts/services-networking/service/",
      example: "ports: |-\n  - name: http\n    containerPort: 8080\n",
    },
  },
  {
    pattern: ["apps-stateless", "*", "serviceAccount"],
    doc: {
      title: "Stateless ServiceAccount Binding",
      titleRu: "Привязка ServiceAccount для stateless приложения",
      summary: "Identity and RBAC binding used by pods of this app.",
      summaryRu: "Идентичность и RBAC-привязка, используемые pod этого приложения.",
      type: "map | string",
      docsLink: "docs/reference-values.md#param-serviceaccount",
      example: "serviceAccount:\n  enabled: true\n  name: api-sa\n",
    },
  },
  {
    pattern: ["apps-stateless", "*", "horizontalPodAutoscaler"],
    doc: {
      title: "Stateless Horizontal Autoscaler",
      titleRu: "Горизонтальный автоскейлер stateless приложения",
      summary: "HPA settings for scaling pod replicas based on metrics.",
      summaryRu: "Настройки HPA для масштабирования числа pod по метрикам.",
      type: "map | YAML block string",
      docsLink: "docs/reference-values.md#param-hpa",
      k8sDocsLink: "https://kubernetes.io/docs/tasks/run-application/horizontal-pod-autoscale/",
      example: "horizontalPodAutoscaler:\n  enabled: true\n  minReplicas: 2\n  maxReplicas: 10\n",
    },
  },
  {
    pattern: ["apps-stateless", "*", "verticalPodAutoscaler"],
    doc: {
      title: "Stateless Vertical Autoscaler",
      titleRu: "Вертикальный автоскейлер stateless приложения",
      summary: "VPA settings for automatic CPU/memory recommendation/update.",
      summaryRu: "Настройки VPA для авто-рекомендаций/обновлений CPU и памяти.",
      type: "map | YAML block string",
      docsLink: "docs/reference-values.md#param-vpa",
      k8sDocsLink: "https://github.com/kubernetes/autoscaler/tree/master/vertical-pod-autoscaler",
      example: "verticalPodAutoscaler:\n  enabled: true\n  updateMode: Auto\n",
    },
  },
  {
    pattern: ["apps-stateless", "*", "podDisruptionBudget"],
    doc: {
      title: "Stateless PodDisruptionBudget",
      titleRu: "PodDisruptionBudget stateless приложения",
      summary: "Availability guard controlling allowed voluntary disruptions.",
      summaryRu: "Ограничение доступности, контролирующее допустимые добровольные прерывания.",
      type: "map | YAML block string",
      docsLink: "docs/reference-values.md#param-pdb",
      k8sDocsLink: "https://kubernetes.io/docs/tasks/run-application/configure-pdb/",
      example: "podDisruptionBudget:\n  enabled: true\n  minAvailable: 1\n",
    },
  },
  {
    pattern: ["apps-stateful", "*", "containers"],
    doc: {
      title: "Stateful Containers",
      titleRu: "Контейнеры stateful приложения",
      summary: "Main runtime containers for `apps-stateful` workload.",
      summaryRu: "Основные runtime-контейнеры для workload `apps-stateful`.",
      type: "map(name -> container spec)",
      example: "apps-stateful:\n  db:\n    containers:\n      app:\n        image:\n          name: postgres\n",
    },
  },
  {
    pattern: ["apps-stateful", "*", "initContainers"],
    doc: {
      title: "Stateful Init Containers",
      titleRu: "Init-контейнеры stateful приложения",
      summary: "Init containers for state/bootstrap preparation.",
      summaryRu: "Init-контейнеры для подготовки state/bootstrap шагов.",
      type: "map(name -> container spec)",
      example: "initContainers:\n  init-permissions:\n    image:\n      name: busybox\n",
    },
  },
  {
    pattern: ["apps-stateful", "*", "service"],
    doc: {
      title: "Stateful Service",
      titleRu: "Service для stateful приложения",
      summary: "Service config for stable network endpoint of stateful app.",
      summaryRu: "Конфигурация Service для стабильного сетевого endpoint stateful приложения.",
      type: "map",
      docsLink: "docs/reference-values.md#param-service",
      example: "service:\n  enabled: true\n  headless: true\n",
    },
  },
  {
    pattern: ["apps-stateful", "*", "service", "ports"],
    doc: {
      title: "Stateful Service Ports",
      titleRu: "Порты Service в stateful приложении",
      summary: "Service-level ports exposed for stateful app clients.",
      summaryRu: "Порты Service-уровня, публикуемые для клиентов stateful приложения.",
      type: "YAML block string",
      docsLink: "docs/reference-values.md#param-service",
      example: "ports: |-\n  - name: db\n    port: 5432\n    targetPort: 5432\n",
    },
  },
  {
    pattern: ["apps-stateful", "*", "containers", "*", "ports"],
    doc: {
      title: "Stateful Container Ports",
      titleRu: "Порты контейнера в stateful приложении",
      summary: "Container ports declared in pod template for stateful workload.",
      summaryRu: "Порты контейнера в pod template stateful workload-а.",
      type: "YAML block string",
      docsLinkEn: "docs/k8s-fields-guide.en.md#ports",
      docsLinkRu: "docs/k8s-fields-guide.md#ports",
      example: "ports: |-\n  - name: db\n    containerPort: 5432\n",
    },
  },
  {
    pattern: ["apps-stateful", "*", "serviceAccount"],
    doc: {
      title: "Stateful ServiceAccount Binding",
      titleRu: "Привязка ServiceAccount для stateful приложения",
      summary: "Service account identity used by stateful pods.",
      summaryRu: "Идентичность service account, используемая stateful pod.",
      type: "map | string",
      docsLink: "docs/reference-values.md#param-serviceaccount",
      example: "serviceAccount:\n  name: db-sa\n",
    },
  },
  {
    pattern: ["apps-jobs", "*", "containers"],
    doc: {
      title: "Job Containers",
      titleRu: "Контейнеры Job",
      summary: "Containers executed by one-shot Kubernetes Job.",
      summaryRu: "Контейнеры, выполняемые одноразовой Kubernetes Job.",
      type: "map(name -> container spec)",
      example: "apps-jobs:\n  migrate:\n    containers:\n      app:\n        image:\n          name: ghcr.io/org/migrator\n",
    },
  },
  {
    pattern: ["apps-jobs", "*", "serviceAccount"],
    doc: {
      title: "Job ServiceAccount",
      titleRu: "ServiceAccount для Job",
      summary: "Identity used by Job pods while running batch task.",
      summaryRu: "Идентичность, используемая pod Job при выполнении batch-задачи.",
      type: "map | string",
      example: "serviceAccount:\n  name: migrations-sa\n",
    },
  },
  {
    pattern: ["apps-jobs", "*", "backoffLimit"],
    doc: {
      title: "Job Retry Limit",
      titleRu: "Лимит повторов Job",
      summary: "Maximum restart/retry attempts before Job is marked failed.",
      summaryRu: "Максимум повторов до пометки Job как failed.",
      type: "number | env-map",
      k8sDocsLink: "https://kubernetes.io/docs/concepts/workloads/controllers/job/",
      example: "backoffLimit: 3\n",
    },
  },
  {
    pattern: ["apps-jobs", "*", "activeDeadlineSeconds"],
    doc: {
      title: "Job Active Deadline",
      titleRu: "Active deadline Job",
      summary: "Hard execution timeout for batch job.",
      summaryRu: "Жесткий таймаут выполнения batch-job.",
      type: "number | env-map",
      k8sDocsLink: "https://kubernetes.io/docs/concepts/workloads/controllers/job/",
      example: "activeDeadlineSeconds: 1800\n",
    },
  },
  {
    pattern: ["apps-jobs", "*", "restartPolicy"],
    doc: {
      title: "Job Pod Restart Policy",
      titleRu: "Политика рестарта pod Job",
      summary: "Restart policy for Job pod template (`Never`/`OnFailure`).",
      summaryRu: "Политика рестарта pod template Job (`Never`/`OnFailure`).",
      type: "string | env-map",
      k8sDocsLink: "https://kubernetes.io/docs/concepts/workloads/controllers/job/",
      example: "restartPolicy: OnFailure\n",
    },
  },
  {
    pattern: ["apps-cronjobs", "*", "schedule"],
    doc: {
      title: "CronJob Schedule",
      titleRu: "Расписание CronJob",
      summary: "Cron expression controlling when Job runs are triggered.",
      summaryRu: "Cron-выражение, определяющее время запуска Job.",
      type: "string | env-map",
      k8sDocsLink: "https://kubernetes.io/docs/concepts/workloads/controllers/cron-jobs/",
      example: "schedule: \"*/10 * * * *\"\n",
    },
  },
  {
    pattern: ["apps-cronjobs", "*", "concurrencyPolicy"],
    doc: {
      title: "CronJob Concurrency Policy",
      titleRu: "Политика конкурентности CronJob",
      summary: "Defines behavior when previous run is still active.",
      summaryRu: "Определяет поведение, если предыдущий запуск еще активен.",
      type: "Allow | Forbid | Replace | env-map",
      k8sDocsLink: "https://kubernetes.io/docs/concepts/workloads/controllers/cron-jobs/",
      example: "concurrencyPolicy: Forbid\n",
    },
  },
  {
    pattern: ["apps-cronjobs", "*", "startingDeadlineSeconds"],
    doc: {
      title: "CronJob Starting Deadline",
      titleRu: "Starting deadline CronJob",
      summary: "How long controller may delay missed schedule before skipping it.",
      summaryRu: "Как долго контроллер может задержать пропущенный запуск перед его пропуском.",
      type: "number | env-map",
      k8sDocsLink: "https://kubernetes.io/docs/concepts/workloads/controllers/cron-jobs/",
      example: "startingDeadlineSeconds: 200\n",
    },
  },
  {
    pattern: ["apps-cronjobs", "*", "successfulJobsHistoryLimit"],
    doc: {
      title: "CronJob Success History Limit",
      titleRu: "Лимит успешной истории CronJob",
      summary: "How many successful finished Jobs to keep.",
      summaryRu: "Сколько успешных завершенных Job хранить в истории.",
      type: "number | env-map",
      example: "successfulJobsHistoryLimit: 3\n",
    },
  },
  {
    pattern: ["apps-cronjobs", "*", "failedJobsHistoryLimit"],
    doc: {
      title: "CronJob Failed History Limit",
      titleRu: "Лимит неуспешной истории CronJob",
      summary: "How many failed finished Jobs to keep.",
      summaryRu: "Сколько неуспешных завершенных Job хранить в истории.",
      type: "number | env-map",
      example: "failedJobsHistoryLimit: 1\n",
    },
  },
  {
    pattern: ["apps-configmaps", "*", "data"],
    doc: {
      title: "ConfigMap Data",
      titleRu: "Данные ConfigMap",
      summary: "Text key/value payload stored in ConfigMap resource.",
      summaryRu: "Текстовый key/value payload, сохраняемый в ресурсе ConfigMap.",
      type: "YAML block string | map | env-map",
      docsLink: "docs/reference-values.md#param-apps-configmaps",
      example: "data: |-\n  APP_MODE: production\n  LOG_LEVEL: info\n",
    },
  },
  {
    pattern: ["apps-configmaps", "*", "binaryData"],
    doc: {
      title: "ConfigMap Binary Data",
      titleRu: "BinaryData ConfigMap",
      summary: "Binary payload map (`binaryData`) for ConfigMap entries.",
      summaryRu: "Карта бинарного payload (`binaryData`) для записей ConfigMap.",
      type: "YAML block string | map | env-map",
      docsLink: "docs/reference-values.md#param-apps-configmaps",
      example: "binaryData: |-\n  app.bin: SGVsbG8=\n",
    },
  },
  {
    pattern: ["apps-secrets", "*", "data"],
    doc: {
      title: "Secret Data",
      titleRu: "Данные Secret",
      summary: "Secret key/value payload for sensitive values.",
      summaryRu: "Secret key/value payload для чувствительных значений.",
      type: "YAML block string | map | env-map",
      docsLink: "docs/reference-values.md#param-apps-secrets",
      k8sDocsLink: "https://kubernetes.io/docs/concepts/configuration/secret/",
      example: "data: |-\n  DB_PASSWORD: super-secret\n",
    },
  },
  {
    pattern: ["apps-secrets", "*", "binaryData"],
    doc: {
      title: "Secret Binary Data",
      titleRu: "BinaryData Secret",
      summary: "Binary payload map for Secret data entries.",
      summaryRu: "Карта бинарного payload для data-записей Secret.",
      type: "YAML block string | map | env-map",
      docsLink: "docs/reference-values.md#param-apps-secrets",
      example: "binaryData: |-\n  cert.p12: MII...\n",
    },
  },
  {
    pattern: ["apps-pvcs", "*", "storageClassName"],
    doc: {
      title: "PVC StorageClass",
      titleRu: "StorageClass PVC",
      summary: "Storage class used for PVC dynamic provisioning.",
      summaryRu: "Storage class для dynamic provisioning PVC.",
      type: "string | env-map",
      docsLink: "docs/reference-values.md#param-apps-sections",
      k8sDocsLink: "https://kubernetes.io/docs/concepts/storage/persistent-volumes/",
      example: "storageClassName: gp3\n",
    },
  },
  {
    pattern: ["apps-pvcs", "*", "accessModes"],
    doc: {
      title: "PVC Access Modes",
      titleRu: "Режимы доступа PVC",
      summary: "PVC access mode list (`ReadWriteOnce`, `ReadOnlyMany`, `ReadWriteMany`).",
      summaryRu: "Список режимов доступа PVC (`ReadWriteOnce`, `ReadOnlyMany`, `ReadWriteMany`).",
      type: "YAML block string | list | env-map",
      docsLink: "docs/reference-values.md#param-apps-sections",
      example: "accessModes: |-\n  - ReadWriteOnce\n",
    },
  },
  {
    pattern: ["apps-pvcs", "*", "resources"],
    doc: {
      title: "PVC Requested Resources",
      titleRu: "Запрашиваемые ресурсы PVC",
      summary: "Requested storage resources for PVC (usually capacity request).",
      summaryRu: "Запрашиваемые ресурсы хранилища для PVC (обычно объем).",
      type: "YAML block string | map | env-map",
      docsLink: "docs/reference-values.md#param-apps-sections",
      example: "resources: |-\n  requests:\n    storage: 10Gi\n",
    },
  },
  {
    pattern: ["apps-certificates", "*", "clusterIssuer"],
    doc: {
      title: "Certificate ClusterIssuer",
      titleRu: "ClusterIssuer сертификата",
      summary: "cert-manager ClusterIssuer used to issue certificate.",
      summaryRu: "cert-manager ClusterIssuer, используемый для выпуска сертификата.",
      type: "string | env-map",
      docsLink: "docs/reference-values.md#param-apps-sections",
      k8sDocsLink: "https://cert-manager.io/docs/concepts/issuer/",
      example: "clusterIssuer: letsencrypt-prod\n",
    },
  },
  {
    pattern: ["apps-certificates", "*", "host"],
    doc: {
      title: "Certificate Host",
      titleRu: "Host сертификата",
      summary: "Primary DNS name for certificate.",
      summaryRu: "Основное DNS-имя для сертификата.",
      type: "string | env-map",
      docsLink: "docs/reference-values.md#param-apps-sections",
      example: "host: app.example.com\n",
    },
  },
  {
    pattern: ["apps-certificates", "*", "hosts"],
    doc: {
      title: "Certificate SAN Hosts",
      titleRu: "SAN hosts сертификата",
      summary: "Additional DNS names (SANs) included in certificate.",
      summaryRu: "Дополнительные DNS-имена (SAN), включаемые в сертификат.",
      type: "YAML block string | list | env-map",
      docsLink: "docs/reference-values.md#param-apps-sections",
      example: "hosts: |-\n  - app.example.com\n  - api.example.com\n",
    },
  },
  {
    pattern: ["apps-dex-clients", "*", "redirectURIs"],
    doc: {
      title: "Dex Client Redirect URIs",
      titleRu: "Redirect URI для Dex client",
      summary: "Allowed OAuth redirect URIs for Dex client registration.",
      summaryRu: "Разрешенные OAuth redirect URI для регистрации Dex client.",
      type: "YAML block string | list | env-map",
      docsLink: "docs/reference-values.md#param-apps-sections",
      example: "redirectURIs: |-\n  - https://app.example.com/callback\n",
    },
  },
  {
    pattern: ["apps-dex-authenticators", "*", "applicationDomain"],
    doc: {
      title: "Dex Authenticator Domain",
      titleRu: "Домен Dex Authenticator",
      summary: "Public domain of application protected by dex-authenticator.",
      summaryRu: "Публичный домен приложения, защищаемого dex-authenticator.",
      type: "string | env-map",
      docsLink: "docs/reference-values.md#param-apps-sections",
      example: "applicationDomain: auth.example.com\n",
    },
  },
  {
    pattern: ["apps-dex-authenticators", "*", "applicationIngressClassName"],
    doc: {
      title: "Dex Authenticator IngressClass",
      titleRu: "IngressClass Dex Authenticator",
      summary: "Ingress controller class used by authenticator route.",
      summaryRu: "Класс ingress-контроллера для маршрута authenticator.",
      type: "string | env-map",
      docsLink: "docs/reference-values.md#param-apps-sections",
      example: "applicationIngressClassName: nginx\n",
    },
  },
  {
    pattern: ["apps-dex-authenticators", "*", "applicationIngressCertificateSecretName"],
    doc: {
      title: "Dex Authenticator TLS Secret",
      titleRu: "TLS secret Dex Authenticator",
      summary: "TLS secret name bound to authenticator ingress.",
      summaryRu: "Имя TLS секрета, привязанного к ingress authenticator.",
      type: "string | env-map",
      docsLink: "docs/reference-values.md#param-apps-sections",
      example: "applicationIngressCertificateSecretName: auth-tls\n",
    },
  },
  {
    pattern: ["apps-dex-authenticators", "*", "allowedGroups"],
    doc: {
      title: "Dex Authenticator Allowed Groups",
      titleRu: "Разрешенные группы Dex Authenticator",
      summary: "Identity-provider groups allowed to access protected app.",
      summaryRu: "Группы identity-provider, которым разрешен доступ к защищенному приложению.",
      type: "YAML block string | list | env-map",
      docsLink: "docs/reference-values.md#param-apps-sections",
      example: "allowedGroups: |-\n  - platform-admins\n  - devops\n",
    },
  },
  {
    pattern: ["apps-dex-authenticators", "*", "sendAuthorizationHeader"],
    doc: {
      title: "Forward Authorization Header",
      titleRu: "Проброс Authorization header",
      summary: "When enabled, passes Authorization header to upstream app.",
      summaryRu: "Если включено, пробрасывает Authorization header в upstream приложение.",
      type: "bool | env-map",
      docsLink: "docs/reference-values.md#param-apps-sections",
      example: "sendAuthorizationHeader: true\n",
    },
  },
  {
    pattern: ["apps-dex-authenticators", "*", "keepUsersLoggedInFor"],
    doc: {
      title: "Dex Session Lifetime",
      titleRu: "Время жизни Dex-сессии",
      summary: "Duration users stay logged in before re-authentication is required.",
      summaryRu: "Длительность, в течение которой пользователь остается залогинен без повторной аутентификации.",
      type: "string | env-map",
      docsLink: "docs/reference-values.md#param-apps-sections",
      notes: [
        "Use duration format supported by dex-authenticator (for example: `24h`, `168h`).",
      ],
      notesRu: [
        "Используйте формат duration, поддерживаемый dex-authenticator (например: `24h`, `168h`).",
      ],
      example: "keepUsersLoggedInFor: 168h\n",
    },
  },
  {
    pattern: ["apps-dex-authenticators", "*", "signOutURL"],
    doc: {
      title: "Dex Sign-out URL",
      titleRu: "URL выхода Dex",
      summary: "URL users are redirected to on sign-out.",
      summaryRu: "URL, на который пользователь перенаправляется при выходе.",
      type: "string | env-map",
      docsLink: "docs/reference-values.md#param-apps-sections",
      example: "signOutURL: https://auth.example.local/sign_out\n",
    },
  },
  {
    pattern: ["apps-dex-authenticators", "*", "whitelistSourceRanges"],
    doc: {
      title: "Dex Authenticator Source CIDR Allowlist",
      titleRu: "Allowlist source CIDR для Dex Authenticator",
      summary: "Restricts authenticator ingress access to listed source CIDR ranges.",
      summaryRu: "Ограничивает доступ к ingress authenticator указанными source CIDR диапазонами.",
      type: "YAML block string | list | env-map",
      docsLink: "docs/reference-values.md#param-apps-sections",
      example: "whitelistSourceRanges: |-\n  - 10.0.0.0/8\n  - 192.168.0.0/16\n",
    },
  },
  {
    pattern: ["apps-custom-prometheus-rules", "*", "groups"],
    doc: {
      title: "Prometheus Rule Groups",
      titleRu: "Группы правил Prometheus",
      summary: "Map of rule groups/alerts rendered into PrometheusRule resource.",
      summaryRu: "Карта групп правил/алертов, рендеримых в ресурс PrometheusRule.",
      type: "map",
      docsLink: "docs/reference-values.md#param-apps-sections",
      example: "groups:\n  app.rules:\n    alerts:\n      highErrorRate:\n        content: |-\n          expr: rate(http_requests_total[5m]) > 100\n",
    },
  },
  {
    pattern: ["apps-grafana-dashboards", "*", "folder"],
    doc: {
      title: "Grafana Folder",
      titleRu: "Папка Grafana",
      summary: "Target Grafana folder where dashboard should be imported.",
      summaryRu: "Целевая папка Grafana, куда должен импортироваться dashboard.",
      type: "string | env-map",
      docsLink: "docs/reference-values.md#param-apps-sections",
      example: "folder: Platform\n",
    },
  },
  {
    pattern: ["apps-kafka-strimzi", "*", "kafka"],
    doc: {
      title: "Strimzi Kafka Spec",
      titleRu: "Спека Strimzi Kafka",
      summary: "Kafka broker cluster block for Strimzi operator.",
      summaryRu: "Блок Kafka broker-кластера для оператора Strimzi.",
      type: "map",
      docsLink: "docs/reference-values.md#param-apps-sections",
      example: "kafka:\n  replicas: 3\n  resources:\n    requests:\n      mcpu: 500\n      memoryMb: 2048\n",
    },
  },
  {
    pattern: ["apps-kafka-strimzi", "*", "zookeeper"],
    doc: {
      title: "Strimzi Zookeeper Spec",
      titleRu: "Спека Strimzi Zookeeper",
      summary: "Zookeeper cluster block for Strimzi deployment.",
      summaryRu: "Блок Zookeeper-кластера для Strimzi deployment.",
      type: "map",
      docsLink: "docs/reference-values.md#param-apps-sections",
      example: "zookeeper:\n  replicas: 3\n",
    },
  },
  {
    pattern: ["apps-kafka-strimzi", "*", "topics"],
    doc: {
      title: "Strimzi Topics",
      titleRu: "Топики Strimzi",
      summary: "Topic definitions managed by Strimzi.",
      summaryRu: "Определения топиков, управляемых Strimzi.",
      type: "map",
      docsLink: "docs/reference-values.md#param-apps-sections",
      example: "topics:\n  events:\n    partitions: 12\n    replicas: 3\n",
    },
  },
  {
    pattern: ["apps-kafka-strimzi", "*", "entityOperator"],
    doc: {
      title: "Strimzi Entity Operator",
      titleRu: "Strimzi Entity Operator",
      summary: "Topic/User operator configuration block.",
      summaryRu: "Блок конфигурации Topic/User operator.",
      type: "map",
      docsLink: "docs/reference-values.md#param-apps-sections",
      example: "entityOperator:\n  topicOperator:\n    watchedNamespace: \"*\"\n",
    },
  },
  {
    pattern: ["apps-kafka-strimzi", "*", "exporter"],
    doc: {
      title: "Kafka Exporter",
      titleRu: "Kafka Exporter",
      summary: "Metrics exporter config for Kafka cluster.",
      summaryRu: "Конфигурация экспортера метрик для Kafka-кластера.",
      type: "map",
      docsLink: "docs/reference-values.md#param-apps-sections",
      example: "exporter:\n  enabled: true\n",
    },
  },
  {
    pattern: ["apps-kafka-strimzi", "*", "kafka", "version"],
    doc: {
      title: "Kafka Version",
      titleRu: "Версия Kafka",
      summary: "Kafka broker version used by Strimzi cluster.",
      summaryRu: "Версия Kafka broker, используемая Strimzi-кластером.",
      type: "string | env-map",
      docsLink: "docs/reference-values.md#param-apps-sections",
      notes: [
        "Pin this value to a version supported by your installed Strimzi operator.",
      ],
      notesRu: [
        "Фиксируйте значение на версии, поддерживаемой установленным Strimzi-оператором.",
      ],
      example: "kafka:\n  version: 3.7.0\n",
    },
  },
  {
    pattern: ["apps-kafka-strimzi", "*", "kafka", "replicas"],
    doc: {
      title: "Kafka Broker Replicas",
      titleRu: "Количество Kafka broker-реплик",
      summary: "Number of Kafka broker replicas in Strimzi cluster.",
      summaryRu: "Количество Kafka broker-реплик в Strimzi-кластере.",
      type: "number | env-map",
      docsLink: "docs/reference-values.md#param-apps-sections",
      example: "kafka:\n  replicas: 3\n",
    },
  },
  {
    pattern: ["apps-kafka-strimzi", "*", "zookeeper", "replicas"],
    doc: {
      title: "Zookeeper Replicas",
      titleRu: "Количество Zookeeper-реплик",
      summary: "Number of Zookeeper replicas for Strimzi cluster.",
      summaryRu: "Количество Zookeeper-реплик для Strimzi-кластера.",
      type: "number | env-map",
      docsLink: "docs/reference-values.md#param-apps-sections",
      example: "zookeeper:\n  replicas: 3\n",
    },
  },
  {
    pattern: ["apps-kafka-strimzi", "*", "kafka", "storage", "size"],
    doc: {
      title: "Kafka Storage Size",
      titleRu: "Размер Kafka storage",
      summary: "Persistent volume size for each Kafka broker.",
      summaryRu: "Размер persistent volume для каждого Kafka broker.",
      type: "string | env-map",
      docsLink: "docs/reference-values.md#param-apps-sections",
      k8sDocsLink: "https://kubernetes.io/docs/concepts/storage/persistent-volumes/",
      example: "kafka:\n  storage:\n    size: 100Gi\n",
    },
  },
  {
    pattern: ["apps-kafka-strimzi", "*", "topics", "*"],
    doc: {
      title: "Kafka Topic Spec",
      titleRu: "Спека Kafka topic",
      summary: "Config block for a managed Kafka topic.",
      summaryRu: "Блок конфигурации управляемого Kafka topic.",
      type: "map(topicConfig)",
      docsLink: "docs/reference-values.md#param-apps-sections",
      example: "topics:\n  app-events:\n    partitions: 6\n    replicas: 3\n",
    },
  },
  {
    pattern: ["apps-kafka-strimzi", "*", "topics", "*", "retention"],
    doc: {
      title: "Topic Retention (ms)",
      titleRu: "Retention topic (мс)",
      summary: "Kafka topic retention in milliseconds (`retention.ms`).",
      summaryRu: "Retention Kafka topic в миллисекундах (`retention.ms`).",
      type: "number | env-map",
      docsLink: "docs/reference-values.md#param-apps-sections",
      example: "topics:\n  app-events:\n    retention: 604800000\n",
    },
  },
  {
    pattern: ["apps-infra", "node-users"],
    doc: {
      title: "Infra Node Users",
      titleRu: "Пользователи нод",
      summary: "Map of managed system users applied to target node groups.",
      summaryRu: "Карта управляемых системных пользователей, применяемых к целевым группам нод.",
      type: "map(userName -> userSpec)",
      docsLink: "docs/reference-values.md#param-apps-sections",
      example: "node-users:\n  deploy:\n    uid: 1001\n    isSudoer: true\n",
    },
  },
  {
    pattern: ["apps-infra", "node-groups"],
    doc: {
      title: "Infra Node Groups",
      titleRu: "Группы нод",
      summary: "Node inventory/group map consumed by infra automation.",
      summaryRu: "Карта инвентаря/групп нод, используемая infra-автоматизацией.",
      type: "map",
      docsLink: "docs/reference-values.md#param-apps-sections",
      example: "node-groups:\n  workers:\n    labels: |-\n      role: worker\n",
    },
  },
  {
    pattern: ["apps-k8s-manifests", "*", "apiVersion"],
    doc: {
      title: "Manifest API Version",
      titleRu: "API версия манифеста",
      summary: "API version for universal manifest object.",
      summaryRu: "API версия для универсального объекта манифеста.",
      type: "string | env-map",
      k8sDocsLink: "https://kubernetes.io/docs/reference/using-api/",
      example: "apiVersion: v1\n",
    },
  },
  {
    pattern: ["apps-k8s-manifests", "*", "kind"],
    doc: {
      title: "Manifest Kind",
      titleRu: "Kind манифеста",
      summary: "Kubernetes kind for universal manifest object.",
      summaryRu: "Kubernetes kind для универсального объекта манифеста.",
      type: "string | env-map",
      k8sDocsLink: "https://kubernetes.io/docs/reference/using-api/",
      example: "kind: ConfigMap\n",
    },
  },
  {
    pattern: ["apps-k8s-manifests", "*", "spec"],
    doc: {
      title: "Manifest Spec",
      titleRu: "Spec манифеста",
      summary: "Raw spec body merged into universal manifest.",
      summaryRu: "Raw тело spec, мержимое в универсальный манифест.",
      type: "YAML block string | map | env-map",
      example: "spec: |-\n  selector:\n    matchLabels:\n      app: sample\n",
    },
  },
  {
    pattern: ["*", "*", "enabled"],
    doc: {
      title: "Resource Toggle",
      summary: "Enables/disables app rendering.",
      type: "bool | env-map",
      notes: [
        "In release-matrix mode may be auto-enabled by `global.deploy.enabled`.",
      ],
      example: "apps-stateless:\n  api:\n    enabled: true\n",
    },
  },
  {
    pattern: ["*", "*", "_include"],
    doc: {
      title: "Include Profiles",
      titleRu: "Подключение include-профилей",
      summary: "Applies one or more profiles from `global._includes` to current app/group.",
      summaryRu: "Применяет один или несколько профилей из `global._includes` к текущему app/group.",
      type: "string | string[]",
      docsLink: "docs/reference-values.md#param-include",
      notes: [
        "Chains are concatenated in declared order.",
        "Local fields override included values.",
      ],
      notesRu: [
        "Цепочки конкатенируются в указанном порядке.",
        "Локальные поля переопределяют значения из include.",
      ],
      example: "apps-stateless:\n  api:\n    _include: [apps-default]\n",
    },
  },
  {
    pattern: ["*", "*", "_include_from_file"],
    doc: {
      title: "Inline Include From File",
      titleRu: "Inline include из файла",
      summary: "Loads YAML map from file and merges it into current object.",
      summaryRu: "Загружает YAML map из файла и мержит его в текущий объект.",
      type: "string",
      docsLink: "docs/reference-values.md#param-include-from-file",
      notes: [
        "Path is relative to current values file.",
        "Missing file is skipped (warning only).",
      ],
      notesRu: [
        "Путь относительный к текущему values-файлу.",
        "Отсутствующий файл пропускается (только предупреждение).",
      ],
      example: "_include_from_file: helm-apps-defaults.yaml\n",
    },
  },
  {
    pattern: ["*", "*", "_include_files"],
    doc: {
      title: "Import Include Profiles From Files",
      titleRu: "Импорт include-профилей из файлов",
      summary: "Loads file maps as named include profiles and prepends them into `_include`.",
      summaryRu: "Загружает файлы как именованные include-профили и добавляет их в начало `_include`.",
      type: "string[]",
      docsLink: "docs/reference-values.md#param-include-files",
      notes: [
        "Each file becomes profile named by filename.",
        "Supports navigation/hover to include definition.",
      ],
      notesRu: [
        "Каждый файл становится профилем с именем по файлу.",
        "Поддерживается переход/hover к определению include.",
      ],
      example: "_include_files:\n  - defaults.yaml\n  - profile-prod.yaml\n",
    },
  },
  {
    pattern: ["*", "*", "labels"],
    doc: {
      title: "Labels Override",
      summary: "Kubernetes labels fragment for rendered resource.",
      type: "YAML block string | env-map",
      notes: [
        "Prefer YAML block (`|-`) for map content to follow library conventions.",
      ],
      example: "labels: |-\n  app.kubernetes.io/component: api\n",
    },
  },
  {
    pattern: ["*", "*", "annotations"],
    doc: {
      title: "Annotations Override",
      summary: "Kubernetes annotations fragment for rendered resource.",
      type: "YAML block string | env-map",
      example: "annotations: |-\n  nginx.ingress.kubernetes.io/proxy-body-size: 64m\n",
    },
  },
  {
    pattern: ["*", "*", "containers"],
    doc: {
      title: "Containers Spec",
      summary: "Container definitions for workload groups.",
      type: "map | YAML block string",
      notes: [
        "For complex k8s snippets prefer block-string fields where group contract expects it.",
      ],
      example: "containers:\n  app:\n    image:\n      name: nginx\n",
    },
  },
  {
    pattern: ["*", "*", "service"],
    doc: {
      title: "Service Settings",
      summary: "Service exposure settings bound to app workload.",
      type: "map",
      notes: [
        "Commonly used in `apps-stateless`/`apps-stateful`.",
      ],
      example: "service:\n  enabled: true\n  ports: |-\n    - name: http\n      port: 80\n",
    },
  },
  {
    pattern: ["*", "*", "ports"],
    doc: {
      title: "Ports Configuration",
      summary: "Port list for service/container depending on field context.",
      type: "YAML block string",
      notes: [
        "Native YAML list may be restricted by list-policy.",
      ],
      example: "ports: |-\n  - name: http\n    port: 80\n",
    },
  },
  {
    pattern: ["*", "*", "envYAML"],
    doc: {
      title: "Container Env List",
      summary: "Environment variables in Kubernetes `env` list format.",
      type: "list",
      docsLink: "docs/reference-values.md#param-envyaml",
      notes: [
        "One of allowed native-list paths in list-policy validator.",
      ],
      example: "envYAML:\n  - name: LOG_LEVEL\n    value: info\n",
    },
  },
  {
    pattern: ["*", "*", "fieldsYAML"],
    doc: {
      title: "Raw Fields YAML",
      summary: "Additional raw fields merged into rendered resource body.",
      type: "map of YAML block strings",
      notes: [
        "Used heavily by fallback and k8s-manifest style resources.",
      ],
      example: "fieldsYAML:\n  spec: |-\n    template:\n      spec:\n        hostNetwork: true\n",
    },
  },
  {
    pattern: ["apps-k8s-manifests", "*", "extraFields"],
    doc: {
      title: "Residual Top-level Fields",
      summary: "Unknown/unmapped top-level fields preserved for universal manifest rendering.",
      type: "YAML block string",
      example: "extraFields: |-\n  roleRef:\n    kind: Role\n",
    },
  },
  {
    pattern: ["*", "*", "resources"],
    doc: {
      title: "Resources",
      titleRu: "Ресурсы",
      summary: "CPU/Memory resource profile for the component.",
      summaryRu: "Профиль CPU/Memory ресурсов для компонента.",
      type: "map | env-map",
      docsLink: "docs/reference-values.md#param-resources",
      k8sDocsLink: "https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/",
      notes: [
        "Commonly contains `requests` and `limits`.",
        "Can be inherited via `_include` profiles.",
      ],
      notesRu: [
        "Обычно содержит `requests` и `limits`.",
        "Может наследоваться через `_include` профили.",
      ],
      example: "resources:\n  requests:\n    mcpu: 100\n    memoryMb: 256\n  limits:\n    mcpu: 500\n    memoryMb: 512\n",
    },
  },
  {
    pattern: ["*", "*", "*", "resources"],
    doc: {
      title: "Resources",
      titleRu: "Ресурсы",
      summary: "CPU/Memory resource profile for nested component (for example in kafka/strimzi blocks).",
      summaryRu: "Профиль CPU/Memory ресурсов для вложенного компонента (например в блоках kafka/strimzi).",
      type: "map | env-map",
      docsLink: "docs/reference-values.md#param-resources",
      k8sDocsLink: "https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/",
      notes: [
        "Typical nested keys: `requests`, `limits`.",
      ],
      notesRu: [
        "Типичные вложенные ключи: `requests`, `limits`.",
      ],
      example: "kafka:\n  resources:\n    requests:\n      mcpu: 100\n      memoryMb: 768\n    limits:\n      mcpu: 1000\n      memoryMb: 4096\n",
    },
  },
  {
    pattern: ["*", "*", "*", "resources", "requests"],
    doc: {
      title: "Resource Requests",
      summary: "Guaranteed resources requested by scheduler.",
      type: "map | env-map",
      docsLink: "docs/reference-values.md#param-resources",
      k8sDocsLink: "https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/",
      example: "requests:\n  mcpu: 100\n  memoryMb: 768\n",
    },
  },
  {
    pattern: ["*", "*", "*", "resources", "limits"],
    doc: {
      title: "Resource Limits",
      summary: "Maximum resources allowed for the component.",
      type: "map | env-map",
      docsLink: "docs/reference-values.md#param-resources",
      k8sDocsLink: "https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/",
      example: "limits:\n  mcpu: 1000\n  memoryMb: 4096\n",
    },
  },
  {
    pattern: ["*", "*", "*", "envVars"],
    doc: {
      title: "envVars Helper",
      titleRu: "Хелпер envVars",
      summary: "Declares container env variables as key/value map with env-map support.",
      summaryRu: "Описывает env-переменные контейнера как map key/value с поддержкой env-map.",
      type: "map | env-map",
      docsLink: "docs/reference-values.md#param-envvars-usage",
      example: "envVars:\n  LOG_LEVEL: info\n  APP_MODE:\n    _default: safe\n    production: fast\n",
    },
  },
  {
    pattern: ["*", "*", "*", "secretEnvVars"],
    doc: {
      title: "secretEnvVars Helper",
      titleRu: "Хелпер secretEnvVars",
      summary: "Generates Secret-backed env vars and wires them into container env chain.",
      summaryRu: "Генерирует env-переменные через Secret и подключает их в env-цепочку контейнера.",
      type: "map | env-map",
      docsLink: "docs/reference-values.md#param-secretenvvars",
      example: "secretEnvVars:\n  DB_PASSWORD:\n    _default: dev-password\n    production: prod-password\n",
    },
  },
  {
    pattern: ["*", "*", "*", "sharedEnvSecrets"],
    doc: {
      title: "sharedEnvSecrets Helper",
      titleRu: "Хелпер sharedEnvSecrets",
      summary: "Adds shared Secret references into container `envFrom`.",
      summaryRu: "Добавляет ссылки на общие Secret в `envFrom` контейнера.",
      type: "list",
      docsLink: "docs/reference-values.md#param-sharedenvsecrets",
      example: "sharedEnvSecrets:\n  - common-runtime\n  - platform-observability\n",
    },
  },
  {
    pattern: ["*", "*", "*", "sharedEnvConfigMaps"],
    doc: {
      title: "sharedEnvConfigMaps Helper",
      titleRu: "Хелпер sharedEnvConfigMaps",
      summary: "Adds shared ConfigMap references into container `envFrom`.",
      summaryRu: "Добавляет ссылки на общие ConfigMap в `envFrom` контейнера.",
      type: "list",
      docsLink: "docs/reference-values.md#param-sharedenvconfigmaps",
      example: "sharedEnvConfigMaps:\n  - common-runtime-cm\n  - platform-observability-cm\n",
    },
  },
  {
    pattern: ["*", "*", "*", "configFiles"],
    doc: {
      title: "configFiles Helper",
      titleRu: "Хелпер configFiles",
      summary: "Creates/mounts text config files for a container.",
      summaryRu: "Создает/монтирует текстовые конфигурационные файлы для контейнера.",
      type: "map",
      docsLink: "docs/reference-values.md#param-configfiles",
      example: "configFiles:\n  app.yaml:\n    mountPath: /etc/app/app.yaml\n    content: |\n      key: value\n",
    },
  },
  {
    pattern: ["*", "*", "*", "configFilesYAML"],
    doc: {
      title: "configFilesYAML Helper",
      titleRu: "Хелпер configFilesYAML",
      summary: "YAML-aware config files with env-map overrides in content tree.",
      summaryRu: "YAML-конфиги с env-map переопределениями внутри дерева content.",
      type: "map",
      docsLink: "docs/reference-values.md#param-configfilesyaml",
      example: "configFilesYAML:\n  app.yaml:\n    mountPath: /etc/app/app.yaml\n    content:\n      key:\n        _default: value\n        production: prod-value\n",
    },
  },
  {
    pattern: ["*", "*", "*", "fromSecretsEnvVars"],
    doc: {
      title: "fromSecretsEnvVars Helper",
      titleRu: "Хелпер fromSecretsEnvVars",
      summary: "Maps keys from external Secret into explicit env vars.",
      summaryRu: "Маппит ключи из внешнего Secret в явные env-переменные.",
      type: "map | list",
      docsLink: "docs/reference-values.md#param-fromsecretsenvvars",
      example: "fromSecretsEnvVars:\n  external-db:\n    DB_PASSWORD: password\n",
    },
  },
  {
    pattern: ["apps-services", "*", "type"],
    doc: {
      title: "Service Type",
      titleRu: "Тип Service",
      summary: "Kubernetes Service type (`ClusterIP`, `NodePort`, `LoadBalancer`, `ExternalName`).",
      summaryRu: "Тип Kubernetes Service (`ClusterIP`, `NodePort`, `LoadBalancer`, `ExternalName`).",
      type: "string | env-map",
      docsLink: "docs/reference-values.md#param-service",
      k8sDocsLink: "https://kubernetes.io/docs/concepts/services-networking/service/#publishing-services-service-types",
      example: "apps-services:\n  api:\n    type: ClusterIP\n",
    },
  },
  {
    pattern: ["apps-secrets", "*", "type"],
    doc: {
      title: "Secret Type",
      titleRu: "Тип Secret",
      summary: "Secret type (`Opaque`, `kubernetes.io/dockerconfigjson`, etc).",
      summaryRu: "Тип Secret (`Opaque`, `kubernetes.io/dockerconfigjson` и т.д.).",
      type: "string | env-map",
      docsLink: "docs/reference-values.md#param-apps-secrets",
      k8sDocsLink: "https://kubernetes.io/docs/concepts/configuration/secret/#secret-types",
      example: "apps-secrets:\n  docker-auth:\n    type: kubernetes.io/dockerconfigjson\n",
    },
  },
  {
    pattern: ["apps-configmaps", "*", "immutable"],
    doc: {
      title: "ConfigMap Immutable Flag",
      titleRu: "Флаг immutable для ConfigMap",
      summary: "When true, prevents updates to ConfigMap data after creation.",
      summaryRu: "Если true, запрещает обновление данных ConfigMap после создания.",
      type: "bool | env-map",
      docsLink: "docs/reference-values.md#param-apps-configmaps",
      k8sDocsLink: "https://kubernetes.io/docs/concepts/configuration/configmap/#immutable-configmaps",
      example: "immutable: true\n",
    },
  },
  {
    pattern: ["apps-secrets", "*", "immutable"],
    doc: {
      title: "Secret Immutable Flag",
      titleRu: "Флаг immutable для Secret",
      summary: "When true, prevents updates to Secret data after creation.",
      summaryRu: "Если true, запрещает обновление данных Secret после создания.",
      type: "bool | env-map",
      docsLink: "docs/reference-values.md#param-apps-secrets",
      k8sDocsLink: "https://kubernetes.io/docs/concepts/configuration/secret/#secret-immutable",
      example: "immutable: true\n",
    },
  },
  {
    pattern: ["apps-secrets", "*", "stringData"],
    doc: {
      title: "Secret StringData",
      titleRu: "StringData для Secret",
      summary: "Plain-text key/value map which Kubernetes encodes into `data` on create/update.",
      summaryRu: "Карта текстовых key/value, которую Kubernetes кодирует в `data` при создании/обновлении.",
      type: "YAML block string | map | env-map",
      docsLink: "docs/reference-values.md#param-apps-secrets",
      k8sDocsLink: "https://kubernetes.io/docs/concepts/configuration/secret/#working-with-secrets",
      notes: [
        "Use `stringData` for human-readable values in GitOps; Kubernetes converts them to base64 in `data`.",
      ],
      notesRu: [
        "Используйте `stringData` для человеко-читаемых значений в GitOps; Kubernetes конвертирует их в base64 в `data`.",
      ],
      example: "stringData:\n  DB_PASSWORD: change-me\n",
    },
  },
  {
    pattern: ["apps-secrets", "*", "kind"],
    doc: {
      title: "Secret Kind Override",
      titleRu: "Переопределение kind для Secret",
      summary: "Compatibility override for generated secret-like object kind.",
      summaryRu: "Совместимое переопределение kind для генерируемого secret-подобного объекта.",
      type: "string | env-map",
      docsLink: "docs/reference-values.md#param-apps-secrets",
      k8sDocsLink: "https://kubernetes.io/docs/reference/using-api/",
      example: "kind: Secret\n",
    },
  },
  {
    pattern: ["apps-network-policies", "*", "type"],
    doc: {
      title: "Network Policy Renderer Type",
      titleRu: "Тип рендеринга network policy",
      summary: "Chooses policy rendering mode (library profile for Kubernetes/Cilium variants).",
      summaryRu: "Выбирает режим рендеринга policy (профиль библиотеки для Kubernetes/Cilium вариантов).",
      type: "string",
      docsLink: "docs/reference-values.md#param-apps-sections",
      notes: [
        "Use `kubernetes` for standard Kubernetes NetworkPolicy rendering.",
      ],
      notesRu: [
        "Используйте `kubernetes` для стандартного рендера Kubernetes NetworkPolicy.",
      ],
      example: "apps-network-policies:\n  deny-all:\n    type: kubernetes\n",
    },
  },
  {
    pattern: ["apps-ingresses", "*", "paths"],
    doc: {
      title: "Ingress Paths",
      titleRu: "Ingress paths",
      summary: "List/map of routing paths forwarded to backend service.",
      summaryRu: "Список/карта путей маршрутизации, направляемых в backend service.",
      type: "YAML block string | map | env-map",
      docsLink: "docs/reference-values.md#param-ingress",
      k8sDocsLink: "https://kubernetes.io/docs/concepts/services-networking/ingress/",
      example: "paths: |-\n  - path: /\n    pathType: Prefix\n",
    },
  },
  {
    pattern: ["apps-ingresses", "*", "servicePort"],
    doc: {
      title: "Ingress Backend Service Port",
      titleRu: "Порт backend service для Ingress",
      summary: "Backend service port used by ingress route.",
      summaryRu: "Порт backend service, используемый ingress-маршрутом.",
      type: "number | string | env-map",
      docsLink: "docs/reference-values.md#param-ingress",
      k8sDocsLink: "https://kubernetes.io/docs/concepts/services-networking/ingress/",
      example: "servicePort: 8080\n",
    },
  },
  {
    pattern: ["apps-ingresses", "*", "tls"],
    doc: {
      title: "Ingress TLS Block",
      titleRu: "Блок ingress TLS",
      summary: "TLS settings for ingress endpoint (`enabled`, `secret_name`).",
      summaryRu: "TLS-настройки ingress endpoint (`enabled`, `secret_name`).",
      type: "map",
      docsLink: "docs/reference-values.md#param-ingress",
      k8sDocsLink: "https://kubernetes.io/docs/concepts/services-networking/ingress/#tls",
      example: "tls:\n  enabled: true\n  secret_name: app-tls\n",
    },
  },
  {
    pattern: ["apps-ingresses", "*", "dexAuth"],
    doc: {
      title: "Dex Auth Block",
      titleRu: "Блок Dex Auth",
      summary: "Ingress authentication helper based on Dex integration.",
      summaryRu: "Хелпер аутентификации ingress на основе интеграции с Dex.",
      type: "map",
      docsLink: "docs/reference-values.md#param-ingress",
      example: "dexAuth:\n  enabled: true\n  clusterDomain: corp.example\n",
    },
  },
  {
    pattern: ["apps-service-accounts", "*", "roles"],
    doc: {
      title: "Namespaced Roles",
      titleRu: "Namespaced роли",
      summary: "Role definitions automatically bound to current ServiceAccount.",
      summaryRu: "Определения Role, которые автоматически биндуются на текущий ServiceAccount.",
      type: "map(name -> role)",
      docsLink: "docs/reference-values.md#param-apps-sections",
      k8sDocsLink: "https://kubernetes.io/docs/reference/access-authn-authz/rbac/",
      example: "roles:\n  pod-reader:\n    rules: |-\n      - apiGroups: [\"\"]\n        resources: [\"pods\"]\n        verbs: [\"get\", \"list\"]\n",
    },
  },
  {
    pattern: ["apps-service-accounts", "*", "clusterRoles"],
    doc: {
      title: "Cluster Roles",
      titleRu: "Cluster роли",
      summary: "ClusterRole definitions automatically bound to current ServiceAccount.",
      summaryRu: "Определения ClusterRole, которые автоматически биндуются на текущий ServiceAccount.",
      type: "map(name -> clusterRole)",
      docsLink: "docs/reference-values.md#param-apps-sections",
      k8sDocsLink: "https://kubernetes.io/docs/reference/access-authn-authz/rbac/",
      example: "clusterRoles:\n  viewer:\n    rules: |-\n      - apiGroups: [\"*\"]\n        resources: [\"*\"]\n        verbs: [\"get\", \"list\", \"watch\"]\n",
    },
  },
  {
    pattern: ["apps-service-accounts", "*", "namespace"],
    doc: {
      title: "ServiceAccount Namespace Override",
      titleRu: "Переопределение namespace ServiceAccount",
      summary: "Overrides namespace for generated ServiceAccount and namespaced Role/RoleBinding objects.",
      summaryRu: "Переопределяет namespace для ServiceAccount и namespaced Role/RoleBinding объектов.",
      type: "string | env-map",
      docsLink: "docs/reference-values.md#param-apps-sections",
      k8sDocsLink: "https://kubernetes.io/docs/concepts/overview/working-with-objects/namespaces/",
      example: "namespace: tools\n",
    },
  },
  {
    pattern: ["apps-service-accounts", "*", "automountServiceAccountToken"],
    doc: {
      title: "Automount ServiceAccount Token",
      titleRu: "Автомонтирование токена ServiceAccount",
      summary: "Controls automatic mount of service account token into pods that use this identity.",
      summaryRu: "Управляет автоматическим монтированием service account token в pod с этой идентичностью.",
      type: "bool | env-map",
      docsLink: "docs/reference-values.md#param-apps-sections",
      k8sDocsLink: "https://kubernetes.io/docs/tasks/configure-pod-container/configure-service-account/#opt-out-of-api-credential-automounting",
      example: "automountServiceAccountToken: false\n",
    },
  },
  {
    pattern: ["apps-service-accounts", "*", "clusterRole"],
    doc: {
      title: "Predefined ClusterRole Binding",
      titleRu: "Привязка к готовой ClusterRole",
      summary: "Binds current ServiceAccount to pre-existing ClusterRole by name.",
      summaryRu: "Привязывает текущий ServiceAccount к заранее существующей ClusterRole по имени.",
      type: "map",
      docsLink: "docs/reference-values.md#param-apps-sections",
      k8sDocsLink: "https://kubernetes.io/docs/reference/access-authn-authz/rbac/",
      example: "clusterRole:\n  name: view\n",
    },
  },
  {
    pattern: ["apps-service-accounts", "*", "roles", "*", "rules"],
    doc: {
      title: "Role Rules",
      titleRu: "Правила Role",
      summary: "Rules list for namespaced Role. Keep verbs/resources minimal for least-privilege access.",
      summaryRu: "Список правил для namespaced Role. Держите verbs/resources минимальными по принципу least-privilege.",
      type: "YAML block string with rule list",
      docsLink: "docs/reference-values.md#param-apps-sections",
      k8sDocsLink: "https://kubernetes.io/docs/reference/access-authn-authz/rbac/#role-and-clusterrole",
      notes: [
        "Use YAML block string (`|-`) in values for compatibility with helm-apps list policy.",
      ],
      notesRu: [
        "В values используйте YAML block string (`|-`) для совместимости с list-policy helm-apps.",
      ],
      example: "roles:\n  pod-reader:\n    rules: |-\n      - apiGroups: [\"\"]\n        resources: [\"pods\"]\n        verbs: [\"get\", \"list\", \"watch\"]\n",
    },
  },
  {
    pattern: ["apps-service-accounts", "*", "clusterRoles", "*", "rules"],
    doc: {
      title: "ClusterRole Rules",
      titleRu: "Правила ClusterRole",
      summary: "Rules list for cluster-scoped ClusterRole generated by this app entry.",
      summaryRu: "Список правил для cluster-scoped ClusterRole, генерируемой этим app-узлом.",
      type: "YAML block string with rule list",
      docsLink: "docs/reference-values.md#param-apps-sections",
      k8sDocsLink: "https://kubernetes.io/docs/reference/access-authn-authz/rbac/#role-and-clusterrole",
      notes: [
        "Use YAML block string (`|-`) in values for compatibility with helm-apps list policy.",
      ],
      notesRu: [
        "В values используйте YAML block string (`|-`) для совместимости с list-policy helm-apps.",
      ],
      example: "clusterRoles:\n  metrics-reader:\n    rules: |-\n      - apiGroups: [\"metrics.k8s.io\"]\n        resources: [\"pods\"]\n        verbs: [\"get\", \"list\"]\n",
    },
  },
  {
    pattern: ["apps-service-accounts", "*", "roles", "*", "binding", "subjects"],
    doc: {
      title: "RoleBinding Subjects",
      titleRu: "Subjects для RoleBinding",
      summary: "Explicit subject list for generated RoleBinding. If omitted, ServiceAccount subject is used by default.",
      summaryRu: "Явный список subjects для генерируемого RoleBinding. Если не задан, по умолчанию используется ServiceAccount.",
      type: "YAML block string with subjects list",
      docsLink: "docs/reference-values.md#param-apps-sections",
      k8sDocsLink: "https://kubernetes.io/docs/reference/access-authn-authz/rbac/#referring-to-subjects",
      notes: [
        "Use this when binding role to group/user identities instead of current ServiceAccount.",
      ],
      notesRu: [
        "Используйте это, когда роль нужно выдать group/user-идентичностям вместо текущего ServiceAccount.",
      ],
      example: "roles:\n  pod-reader:\n    binding:\n      subjects: |-\n        - kind: Group\n          name: observability-readers\n          apiGroup: rbac.authorization.k8s.io\n",
    },
  },
  {
    pattern: ["apps-service-accounts", "*", "clusterRoles", "*", "binding", "subjects"],
    doc: {
      title: "ClusterRoleBinding Subjects",
      titleRu: "Subjects для ClusterRoleBinding",
      summary: "Explicit subject list for generated ClusterRoleBinding.",
      summaryRu: "Явный список subjects для генерируемого ClusterRoleBinding.",
      type: "YAML block string with subjects list",
      docsLink: "docs/reference-values.md#param-apps-sections",
      k8sDocsLink: "https://kubernetes.io/docs/reference/access-authn-authz/rbac/#referring-to-subjects",
      notes: [
        "Use this to bind cluster role to users/groups and keep ServiceAccount binding separate.",
      ],
      notesRu: [
        "Используйте это, чтобы выдавать cluster role пользователям/группам отдельно от ServiceAccount.",
      ],
      example: "clusterRoles:\n  metrics-reader:\n    binding:\n      subjects: |-\n        - kind: User\n          name: alice@example.com\n          apiGroup: rbac.authorization.k8s.io\n",
    },
  },
];

const LAST_KEY_RULES: Record<string, FieldDoc> = {
  _include: {
    title: "Include Profiles",
    titleRu: "Подключение include-профилей",
    summary: "Applies one or more profiles from `global._includes` to current node.",
    summaryRu: "Применяет один или несколько профилей из `global._includes` к текущему узлу.",
    type: "string | string[]",
    docsLink: "docs/reference-values.md#param-include",
    notes: [
      "Chains are concatenated in declared order.",
      "Local fields override included values.",
    ],
    notesRu: [
      "Цепочки конкатенируются в указанном порядке.",
      "Локальные поля переопределяют значения из include.",
    ],
    example: "_include: [apps-default]\n",
  },
  _include_from_file: {
    title: "Inline Include From File",
    titleRu: "Inline include из файла",
    summary: "Loads YAML map from file and merges it into current object.",
    summaryRu: "Загружает YAML map из файла и мержит его в текущий объект.",
    type: "string",
    docsLink: "docs/reference-values.md#param-include-from-file",
    notes: [
      "Path is relative to current values file.",
      "Missing file is skipped (warning only).",
    ],
    notesRu: [
      "Путь относительный к текущему values-файлу.",
      "Отсутствующий файл пропускается (только предупреждение).",
    ],
    example: "_include_from_file: helm-apps-defaults.yaml\n",
  },
  _include_files: {
    title: "Import Include Profiles From Files",
    titleRu: "Импорт include-профилей из файлов",
    summary: "Loads file maps as named include profiles and prepends them into `_include`.",
    summaryRu: "Загружает файлы как именованные include-профили и добавляет их в начало `_include`.",
    type: "string[]",
    docsLink: "docs/reference-values.md#param-include-files",
    notes: [
      "Each file becomes profile named by filename.",
      "Supports navigation/hover to include definition.",
    ],
    notesRu: [
      "Каждый файл становится профилем с именем по файлу.",
      "Поддерживается переход/hover к определению include.",
    ],
    example: "_include_files:\n  - defaults.yaml\n  - profile-prod.yaml\n",
  },
  _preRenderGroupHook: {
    title: "Pre-render Group Hook",
    titleRu: "Pre-render group hook",
    summary: "Template hook executed before rendering apps in the current group.",
    summaryRu: "Шаблонный hook, выполняемый перед рендером app внутри текущей группы.",
    type: "YAML block string (template)",
    notes: [
      "Use for computed defaults shared across group apps.",
    ],
    notesRu: [
      "Используйте для вычисляемых дефолтов, общих для app в группе.",
    ],
    example: "_preRenderGroupHook: |\n  {{/* custom hook */}}\n",
  },
  _preRenderAppHook: {
    title: "Pre-render App Hook",
    titleRu: "Pre-render app hook",
    summary: "Template hook executed before each app render in the group.",
    summaryRu: "Шаблонный hook, выполняемый перед рендером каждого app в группе.",
    type: "YAML block string (template)",
    notes: [
      "Use for per-app normalization before renderer call.",
    ],
    notesRu: [
      "Используйте для нормализации app-полей перед вызовом рендерера.",
    ],
    example: "_preRenderAppHook: |\n  {{/* app-level hook */}}\n",
  },
  ci_url: {
    title: "CI URL",
    titleRu: "CI URL",
    summary: "URL of CI pipeline/build attached to rendered release metadata.",
    summaryRu: "URL CI-пайплайна/сборки, прикрепляемый к метаданным релиза.",
    type: "string | env-map",
    example: "ci_url: https://gitlab.example.com/group/project/-/pipelines/12345\n",
  },
  validation: {
    title: "Library Validation Settings",
    titleRu: "Настройки валидации библиотеки",
    summary: "Global switches for strict checks and template/list validation behavior.",
    summaryRu: "Глобальные переключатели строгих проверок и валидации шаблонов/list.",
    type: "map",
    notes: [
      "Best practice: enable stricter checks in CI before production rollout.",
    ],
    notesRu: [
      "Рекомендуется включать более строгие проверки в CI перед прод-раскаткой.",
    ],
    example: "validation:\n  strict: true\n  allowNativeListsInBuiltInListFields: false\n",
  },
  strict: {
    title: "Strict Validation Mode",
    titleRu: "Режим строгой валидации",
    summary: "Fails rendering on unsupported keys/contracts instead of silently passing through.",
    summaryRu: "Падает на неподдерживаемых ключах/контрактах вместо молчаливого пропуска.",
    type: "boolean",
    notes: [
      "Useful in CI to catch typos and contract drift early.",
    ],
    notesRu: [
      "Полезно в CI, чтобы рано ловить опечатки и дрейф контрактов.",
    ],
    example: "strict: true\n",
  },
  allowNativeListsInBuiltInListFields: {
    title: "Allow Native Lists In Built-in List Fields",
    titleRu: "Разрешить native list в built-in list-полях",
    summary: "Migration flag allowing YAML native lists in selected built-in fields.",
    summaryRu: "Флаг миграции: разрешает YAML native list в выбранных built-in полях.",
    type: "boolean",
    notes: [
      "Prefer block-string style (`|`) for stable merge semantics.",
    ],
    notesRu: [
      "Предпочтителен block-string стиль (`|`) для предсказуемого merge-поведения.",
    ],
    example: "allowNativeListsInBuiltInListFields: true\n",
  },
  validateTplDelimiters: {
    title: "Validate Template Delimiters",
    titleRu: "Проверка шаблонных delimiters",
    summary: "Checks `{{`/`}}` balance in template-like string values before render.",
    summaryRu: "Проверяет баланс `{{`/`}}` в template-подобных строках до рендера.",
    type: "boolean",
    notes: [
      "Helps catch broken fl.value expressions early.",
    ],
    notesRu: [
      "Помогает рано ловить поломанные выражения fl.value.",
    ],
    example: "validateTplDelimiters: true\n",
  },
  validateFlValueTemplates: {
    title: "Validate fl.value Templates",
    titleRu: "Проверка шаблонов fl.value",
    summary: "Checks template balance/shape in values rendered through `fl.value` helpers.",
    summaryRu: "Проверяет корректность шаблонов в значениях, рендеримых через `fl.value`.",
    type: "boolean",
    notes: [
      "Useful when actively using template expressions in value strings.",
    ],
    notesRu: [
      "Полезно, когда активно используются шаблонные выражения в строковых значениях.",
    ],
    example: "validateFlValueTemplates: true\n",
  },
  deploy: {
    title: "Deploy Controls",
    titleRu: "Управление deploy",
    summary: "Global deploy-related behavior switches used by release matrix flow.",
    summaryRu: "Глобальные переключатели deploy-поведения для release-matrix потока.",
    type: "map",
    example: "deploy:\n  enabled: true\n  release: production\n",
  },
  release: {
    title: "Current Release Name",
    titleRu: "Имя текущего релиза",
    summary: "Selected release profile name used to resolve `global.releases` mapping.",
    summaryRu: "Имя выбранного release-профиля для разрешения `global.releases`.",
    type: "string | env-map",
    example: "release: production\n",
  },
  releases: {
    title: "Release Matrix",
    titleRu: "Release matrix",
    summary: "Map of release names to per-group app-version enables.",
    summaryRu: "Карта release-имен с матрицей включения app-версий по группам.",
    type: "map",
    notes: [
      "Used with `global.deploy.enabled` and `global.deploy.release`.",
    ],
    notesRu: [
      "Используется вместе с `global.deploy.enabled` и `global.deploy.release`.",
    ],
    example: "releases:\n  production:\n    apps-stateless:\n      api: v1\n",
  },
  addEnv: {
    title: "Add Environment Label",
    titleRu: "Добавлять environment label",
    summary: "Adds environment label into rendered resource metadata.",
    summaryRu: "Добавляет environment label в metadata рендеримых ресурсов.",
    type: "bool | env-map",
    example: "addEnv: true\n",
  },
  annotateAllWithRelease: {
    title: "Annotate Resources With Release",
    titleRu: "Аннотировать ресурсы релизом",
    summary: "Adds release annotation to all rendered resources for deploy traceability.",
    summaryRu: "Добавляет release-аннотацию во все ресурсы для трассировки deploy.",
    type: "bool | env-map",
    example: "annotateAllWithRelease: true\n",
  },
  enabled: {
    title: "Resource Toggle",
    titleRu: "Флаг включения ресурса",
    summary: "Enables/disables rendering of current entity.",
    summaryRu: "Включает/выключает рендер текущей сущности.",
    type: "bool | env-map",
    example: "enabled: true\n",
  },
  __AppType__: {
    title: "App Type Hint",
    titleRu: "Подсказка типа app",
    summary: "Internal marker used by library for renderer context and compatibility paths.",
    summaryRu: "Служебный маркер, который библиотека использует для контекста рендерера и совместимости.",
    type: "string",
    example: "__AppType__: apps-stateless\n",
  },
  name: {
    title: "Resource Name Override",
    titleRu: "Переопределение имени ресурса",
    summary: "Overrides generated resource name for current entity.",
    summaryRu: "Переопределяет генерируемое имя ресурса для текущей сущности.",
    type: "string | env-map",
    example: "name: api-backend\n",
  },
  randomName: {
    title: "Random Name Suffix",
    titleRu: "Случайный суффикс имени",
    summary: "Enables randomized name suffix to force unique rollout names.",
    summaryRu: "Включает случайный суффикс имени для уникализации rollout-имен.",
    type: "bool | env-map",
    example: "randomName: true\n",
  },
  alwaysRestart: {
    title: "Always Restart Hint",
    titleRu: "Флаг принудительного рестарта",
    summary: "Forces restart-oriented rollout behavior on each render/update.",
    summaryRu: "Форсирует rollout/рестарт-поведение при каждом рендере/обновлении.",
    type: "bool | env-map",
    example: "alwaysRestart: true\n",
  },
  werfWeight: {
    title: "werf Weight",
    titleRu: "Вес werf",
    summary: "Ordering hint for werf deployment stages.",
    summaryRu: "Подсказка порядка применения ресурсов в этапах werf.",
    type: "number | string | env-map",
    example: "werfWeight: 10\n",
  },
  versionKey: {
    title: "Version Key",
    titleRu: "Ключ версии",
    summary: "Controls version source key used by release matrix logic.",
    summaryRu: "Управляет ключом версии, который использует release-matrix логика.",
    type: "string | env-map",
    example: "versionKey: backend-api\n",
  },
  schedule: {
    title: "Cron Schedule",
    titleRu: "Cron-расписание",
    summary: "Cron expression for `apps-cronjobs` execution.",
    summaryRu: "Cron-выражение для запуска `apps-cronjobs`.",
    type: "string | env-map",
    k8sDocsLink: "https://kubernetes.io/docs/concepts/workloads/controllers/cron-jobs/",
    example: "schedule: \"*/5 * * * *\"\n",
  },
  concurrencyPolicy: {
    title: "CronJob Concurrency Policy",
    titleRu: "Политика конкурентности CronJob",
    summary: "Defines whether concurrent CronJob runs are allowed, forbidden, or replaced.",
    summaryRu: "Определяет, разрешать, запрещать или заменять параллельные запуски CronJob.",
    type: "Allow | Forbid | Replace | env-map",
    k8sDocsLink: "https://kubernetes.io/docs/concepts/workloads/controllers/cron-jobs/",
    example: "concurrencyPolicy: Forbid\n",
  },
  successfulJobsHistoryLimit: {
    title: "Successful Jobs History Limit",
    titleRu: "Лимит истории успешных Job",
    summary: "How many successful job records CronJob keeps.",
    summaryRu: "Сколько успешных job хранит CronJob в истории.",
    type: "number | env-map",
    example: "successfulJobsHistoryLimit: 3\n",
  },
  failedJobsHistoryLimit: {
    title: "Failed Jobs History Limit",
    titleRu: "Лимит истории неуспешных Job",
    summary: "How many failed job records CronJob keeps.",
    summaryRu: "Сколько неуспешных job хранит CronJob в истории.",
    type: "number | env-map",
    example: "failedJobsHistoryLimit: 1\n",
  },
  startingDeadlineSeconds: {
    title: "Starting Deadline Seconds",
    titleRu: "Дедлайн старта (сек)",
    summary: "Maximum delay before missed CronJob schedule is considered failed.",
    summaryRu: "Максимальная задержка, после которой пропущенный запуск CronJob считается невалидным.",
    type: "number | env-map",
    example: "startingDeadlineSeconds: 200\n",
  },
  backoffLimit: {
    title: "Job Backoff Limit",
    titleRu: "Лимит backoff для Job",
    summary: "Maximum retry attempts before Job is marked failed.",
    summaryRu: "Максимум повторов перед тем как Job помечается failed.",
    type: "number | env-map",
    k8sDocsLink: "https://kubernetes.io/docs/concepts/workloads/controllers/job/",
    example: "backoffLimit: 3\n",
  },
  activeDeadlineSeconds: {
    title: "Active Deadline Seconds",
    titleRu: "Дедлайн активности (сек)",
    summary: "Hard timeout for Job execution.",
    summaryRu: "Жесткий таймаут выполнения Job.",
    type: "number | env-map",
    k8sDocsLink: "https://kubernetes.io/docs/concepts/workloads/controllers/job/",
    example: "activeDeadlineSeconds: 1800\n",
  },
  restartPolicy: {
    title: "Pod Restart Policy",
    titleRu: "Политика рестарта Pod",
    summary: "Restart policy for pod template (`Always`, `OnFailure`, `Never`).",
    summaryRu: "Политика рестарта pod template (`Always`, `OnFailure`, `Never`).",
    type: "string | env-map",
    k8sDocsLink: "https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/#restart-policy",
    example: "restartPolicy: OnFailure\n",
  },
  priorityClassName: {
    title: "Priority Class Name",
    titleRu: "Имя PriorityClass",
    summary: "Assigns pod priority class for scheduler preemption order.",
    summaryRu: "Назначает pod priority class для приоритета в планировщике.",
    type: "string | env-map",
    k8sDocsLink: "https://kubernetes.io/docs/concepts/scheduling-eviction/pod-priority-preemption/",
    example: "priorityClassName: high-priority\n",
  },
  topologySpreadConstraints: {
    title: "Topology Spread Constraints",
    titleRu: "Ограничения топологического распределения",
    summary: "Rules to distribute pods across zones/nodes.",
    summaryRu: "Правила распределения pod по зонам/нодам.",
    type: "YAML block string | map",
    k8sDocsLink: "https://kubernetes.io/docs/concepts/scheduling-eviction/topology-spread-constraints/",
    example: "topologySpreadConstraints: |-\n  - maxSkew: 1\n    topologyKey: topology.kubernetes.io/zone\n",
  },
  type: {
    title: "Type",
    titleRu: "Тип",
    summary: "Type discriminator for current entity (meaning depends on concrete group/context).",
    summaryRu: "Ключ типа текущей сущности (семантика зависит от конкретной группы/контекста).",
    type: "string | env-map",
    example: "type: ClusterIP\n",
  },
  headless: {
    title: "Headless Service",
    titleRu: "Headless Service",
    summary: "Enables headless Service mode (`clusterIP: None`).",
    summaryRu: "Включает headless-режим Service (`clusterIP: None`).",
    type: "bool | env-map",
    docsLink: "docs/reference-values.md#param-service",
    k8sDocsLink: "https://kubernetes.io/docs/concepts/services-networking/service/#headless-services",
    example: "headless: true\n",
  },
  labels: {
    title: "Labels",
    titleRu: "Labels",
    summary: "Kubernetes labels fragment merged into rendered object metadata.",
    summaryRu: "Фрагмент Kubernetes labels, мержимый в metadata рендеримого объекта.",
    type: "YAML block string | map | env-map",
    example: "labels: |-\n  app.kubernetes.io/part-of: platform\n",
  },
  annotations: {
    title: "Annotations",
    titleRu: "Annotations",
    summary: "Kubernetes annotations fragment merged into rendered object metadata.",
    summaryRu: "Фрагмент Kubernetes annotations, мержимый в metadata рендеримого объекта.",
    type: "YAML block string | map | env-map",
    example: "annotations: |-\n  reloader.stakater.com/auto: \"true\"\n",
  },
  selector: {
    title: "Selector",
    titleRu: "Selector",
    summary: "Label selector fragment used to bind resources (Service/Policy/etc).",
    summaryRu: "Фрагмент label selector для связывания ресурсов (Service/Policy и т.д.).",
    type: "YAML block string | map | env-map",
    example: "selector: |-\n  app.kubernetes.io/name: api\n",
  },
  ingressClassName: {
    title: "Ingress Class Name",
    titleRu: "Имя IngressClass",
    summary: "Kubernetes ingress class used by ingress controller.",
    summaryRu: "IngressClass, используемый ingress-контроллером.",
    type: "string | env-map",
    docsLink: "docs/reference-values.md#param-ingress",
    k8sDocsLink: "https://kubernetes.io/docs/concepts/services-networking/ingress/#ingress-class",
    example: "ingressClassName: nginx\n",
  },
  class: {
    title: "Ingress Class (legacy)",
    titleRu: "Ingress class (legacy)",
    summary: "Legacy class field kept for compatibility with older ingress controllers.",
    summaryRu: "Legacy-поле class для совместимости со старыми ingress-контроллерами.",
    type: "string | env-map",
    docsLink: "docs/reference-values.md#param-ingress",
    example: "class: nginx\n",
  },
  host: {
    title: "Ingress Host",
    titleRu: "Ingress host",
    summary: "Primary host/domain served by ingress rule.",
    summaryRu: "Основной host/domain для ingress-правила.",
    type: "string | env-map",
    docsLink: "docs/reference-values.md#param-ingress",
    example: "host: api.example.com\n",
  },
  hosts: {
    title: "Ingress Hosts",
    titleRu: "Ingress hosts",
    summary: "Additional host list for ingress/certificate resources.",
    summaryRu: "Список дополнительных host для ingress/certificate ресурсов.",
    type: "YAML block string | list | env-map",
    docsLink: "docs/reference-values.md#param-ingress",
    example: "hosts: |-\n  - api.example.com\n  - www.api.example.com\n",
  },
  paths: {
    title: "Ingress Paths",
    titleRu: "Ingress paths",
    summary: "Path match rules and backend routing for ingress.",
    summaryRu: "Правила matching path и маршрутизация backend для ingress.",
    type: "YAML block string | map | env-map",
    docsLink: "docs/reference-values.md#param-ingress",
    k8sDocsLink: "https://kubernetes.io/docs/concepts/services-networking/ingress/",
    example: "paths: |-\n  - path: /\n    pathType: Prefix\n",
  },
  tls: {
    title: "TLS Settings",
    titleRu: "TLS-настройки",
    summary: "TLS block for ingress/certificate-like resources.",
    summaryRu: "TLS-блок для ingress/certificate-подобных ресурсов.",
    type: "map",
    docsLink: "docs/reference-values.md#param-ingress",
    example: "tls:\n  enabled: true\n  secret_name: api-tls\n",
  },
  secret_name: {
    title: "TLS Secret Name",
    titleRu: "Имя TLS секрета",
    summary: "Secret name used by ingress TLS configuration.",
    summaryRu: "Имя секрета, используемого ingress TLS-конфигурацией.",
    type: "string | env-map",
    docsLink: "docs/reference-values.md#param-ingress",
    example: "secret_name: api-tls\n",
  },
  dexAuth: {
    title: "Dex Auth",
    titleRu: "Dex Auth",
    summary: "Ingress authentication integration settings for Dex.",
    summaryRu: "Настройки интеграции ingress-аутентификации с Dex.",
    type: "map",
    docsLink: "docs/reference-values.md#param-ingress",
    example: "dexAuth:\n  enabled: true\n  clusterDomain: corp.example\n",
  },
  clusterRole: {
    title: "Cluster Role Binding Options",
    titleRu: "Опции cluster role binding",
    summary: "Role/ClusterRole reference or inline rules bound to ServiceAccount.",
    summaryRu: "Ссылка на Role/ClusterRole или inline rules, биндуемые к ServiceAccount.",
    type: "map | string",
    docsLink: "docs/reference-values.md#param-serviceaccount",
    k8sDocsLink: "https://kubernetes.io/docs/reference/access-authn-authz/rbac/",
    example: "clusterRole:\n  name: view\n",
  },
  roles: {
    title: "Roles Map",
    titleRu: "Карта roles",
    summary: "Namespaced RBAC roles created for current service-account entity.",
    summaryRu: "Namespaced RBAC роли, создаваемые для текущей service-account сущности.",
    type: "map",
    docsLink: "docs/reference-values.md#param-apps-sections",
    k8sDocsLink: "https://kubernetes.io/docs/reference/access-authn-authz/rbac/",
    example: "roles:\n  pod-reader:\n    rules: |-\n      - apiGroups: [\"\"]\n        resources: [\"pods\"]\n        verbs: [\"get\", \"list\"]\n",
  },
  clusterRoles: {
    title: "ClusterRoles Map",
    titleRu: "Карта clusterRoles",
    summary: "Cluster-scoped RBAC roles created for current service-account entity.",
    summaryRu: "Cluster-scoped RBAC роли, создаваемые для текущей service-account сущности.",
    type: "map",
    docsLink: "docs/reference-values.md#param-apps-sections",
    k8sDocsLink: "https://kubernetes.io/docs/reference/access-authn-authz/rbac/",
    example: "clusterRoles:\n  readonly:\n    rules: |-\n      - apiGroups: [\"*\"]\n        resources: [\"*\"]\n        verbs: [\"get\", \"list\", \"watch\"]\n",
  },
  rules: {
    title: "RBAC Rules",
    titleRu: "RBAC rules",
    summary: "Permissions list for Role/ClusterRole objects.",
    summaryRu: "Список разрешений для Role/ClusterRole объектов.",
    type: "YAML block string | list",
    k8sDocsLink: "https://kubernetes.io/docs/reference/access-authn-authz/rbac/",
    example: "rules: |-\n  - apiGroups: [\"\"]\n    resources: [\"pods\"]\n    verbs: [\"get\", \"list\"]\n",
  },
  subjects: {
    title: "RBAC Subjects",
    titleRu: "RBAC subjects",
    summary: "Subject bindings for RoleBinding/ClusterRoleBinding.",
    summaryRu: "Привязки субъектов для RoleBinding/ClusterRoleBinding.",
    type: "YAML block string | list",
    k8sDocsLink: "https://kubernetes.io/docs/reference/access-authn-authz/rbac/",
    example: "subjects: |-\n  - kind: ServiceAccount\n    name: app-sa\n",
  },
  data: {
    title: "Object Data",
    titleRu: "Данные объекта",
    summary: "Main data payload for ConfigMap/Secret-like resources.",
    summaryRu: "Основные данные для ConfigMap/Secret-подобных ресурсов.",
    type: "YAML block string | map | env-map",
    docsLink: "docs/reference-values.md#param-apps-configmaps",
    example: "data: |-\n  LOG_LEVEL: info\n",
  },
  binaryData: {
    title: "Binary Data",
    titleRu: "Бинарные данные",
    summary: "Binary payload map for ConfigMap/Secret resources (base64 values).",
    summaryRu: "Карта бинарных данных для ConfigMap/Secret (base64-значения).",
    type: "YAML block string | map | env-map",
    docsLink: "docs/reference-values.md#param-apps-configmaps",
    example: "binaryData: |-\n  cert.pem: LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0t\n",
  },
  stringData: {
    title: "String Data",
    titleRu: "StringData",
    summary: "Plain-text secret values converted by Kubernetes into base64 `data`.",
    summaryRu: "Текстовые значения секрета, которые Kubernetes конвертирует в base64 `data`.",
    type: "YAML block string | map | env-map",
    docsLink: "docs/reference-values.md#param-apps-secrets",
    example: "stringData:\n  DB_PASSWORD: change-me\n",
  },
  immutable: {
    title: "Immutable Flag",
    titleRu: "Флаг immutable",
    summary: "Prevents data mutation after resource creation.",
    summaryRu: "Запрещает изменение данных после создания ресурса.",
    type: "bool | env-map",
    docsLink: "docs/reference-values.md#param-apps-sections",
    example: "immutable: true\n",
  },
  storageClassName: {
    title: "Storage Class Name",
    titleRu: "Имя StorageClass",
    summary: "Storage class for PVC provisioning.",
    summaryRu: "StorageClass для provision PVC.",
    type: "string | env-map",
    docsLink: "docs/reference-values.md#param-apps-sections",
    k8sDocsLink: "https://kubernetes.io/docs/concepts/storage/persistent-volumes/",
    example: "storageClassName: gp3\n",
  },
  accessModes: {
    title: "PVC Access Modes",
    titleRu: "Режимы доступа PVC",
    summary: "PVC access mode list (`ReadWriteOnce`, `ReadOnlyMany`, `ReadWriteMany`).",
    summaryRu: "Список режимов доступа PVC (`ReadWriteOnce`, `ReadOnlyMany`, `ReadWriteMany`).",
    type: "YAML block string | list | env-map",
    docsLink: "docs/reference-values.md#param-apps-sections",
    k8sDocsLink: "https://kubernetes.io/docs/concepts/storage/persistent-volumes/#access-modes",
    example: "accessModes: |-\n  - ReadWriteOnce\n",
  },
  clusterIssuer: {
    title: "Cluster Issuer",
    titleRu: "ClusterIssuer",
    summary: "cert-manager ClusterIssuer used for certificate issuance.",
    summaryRu: "ClusterIssuer cert-manager, используемый для выпуска сертификата.",
    type: "string | env-map",
    docsLink: "docs/reference-values.md#param-apps-sections",
    k8sDocsLink: "https://cert-manager.io/docs/concepts/issuer/",
    example: "clusterIssuer: letsencrypt-prod\n",
  },
  groups: {
    title: "Prometheus Rule Groups",
    titleRu: "Группы правил Prometheus",
    summary: "Rule-group map for `apps-custom-prometheus-rules`.",
    summaryRu: "Карта групп правил для `apps-custom-prometheus-rules`.",
    type: "map",
    docsLink: "docs/reference-values.md#param-apps-sections",
    example: "groups:\n  app.rules:\n    alerts:\n      highErrorRate:\n        content: |-\n          expr: rate(http_requests_total[5m]) > 100\n",
  },
  folder: {
    title: "Grafana Folder",
    titleRu: "Папка Grafana",
    summary: "Target folder name for imported dashboards.",
    summaryRu: "Имя папки Grafana для импортируемых дашбордов.",
    type: "string | env-map",
    docsLink: "docs/reference-values.md#param-apps-sections",
    example: "folder: Platform\n",
  },
  redirectURIs: {
    title: "Dex Client Redirect URIs",
    titleRu: "Redirect URI для Dex client",
    summary: "Allowed OAuth redirect URIs for dex-client resource.",
    summaryRu: "Разрешенные OAuth redirect URI для ресурса dex-client.",
    type: "YAML block string | list | env-map",
    docsLink: "docs/reference-values.md#param-apps-sections",
    example: "redirectURIs: |-\n  - https://app.example.com/callback\n",
  },
  applicationDomain: {
    title: "Authenticator Application Domain",
    titleRu: "Домен приложения аутентификатора",
    summary: "Public domain used by dex-authenticator integration.",
    summaryRu: "Публичный домен для интеграции dex-authenticator.",
    type: "string | env-map",
    docsLink: "docs/reference-values.md#param-apps-sections",
    example: "applicationDomain: auth.example.com\n",
  },
  applicationIngressCertificateSecretName: {
    title: "Application Ingress Certificate Secret",
    titleRu: "Секрет сертификата ingress приложения",
    summary: "TLS secret name for dex-authenticator ingress.",
    summaryRu: "Имя TLS секрета для ingress dex-authenticator.",
    type: "string | env-map",
    docsLink: "docs/reference-values.md#param-apps-sections",
    example: "applicationIngressCertificateSecretName: auth-tls\n",
  },
  applicationIngressClassName: {
    title: "Application Ingress Class Name",
    titleRu: "IngressClass приложения",
    summary: "Ingress class used by dex-authenticator application ingress.",
    summaryRu: "Ingress class для ingress dex-authenticator приложения.",
    type: "string | env-map",
    docsLink: "docs/reference-values.md#param-apps-sections",
    example: "applicationIngressClassName: nginx\n",
  },
  allowedGroups: {
    title: "Allowed Groups",
    titleRu: "Разрешенные группы",
    summary: "Identity provider groups allowed to access authenticator-protected app.",
    summaryRu: "Группы identity provider, которым разрешен доступ к защищенному приложению.",
    type: "YAML block string | list | env-map",
    docsLink: "docs/reference-values.md#param-apps-sections",
    example: "allowedGroups: |-\n  - devops\n  - platform-admins\n",
  },
  sendAuthorizationHeader: {
    title: "Forward Authorization Header",
    titleRu: "Проброс Authorization header",
    summary: "When enabled, passes authorization header to upstream service.",
    summaryRu: "Если включено, пробрасывает authorization header в upstream-сервис.",
    type: "bool | env-map",
    docsLink: "docs/reference-values.md#param-apps-sections",
    example: "sendAuthorizationHeader: true\n",
  },
  keepUsersLoggedInFor: {
    title: "Session Lifetime",
    titleRu: "Время жизни сессии",
    summary: "Session duration before user re-authentication is required.",
    summaryRu: "Длительность сессии до необходимости повторной аутентификации пользователя.",
    type: "string | env-map",
    docsLink: "docs/reference-values.md#param-apps-sections",
    example: "keepUsersLoggedInFor: 168h\n",
  },
  signOutURL: {
    title: "Sign-out URL",
    titleRu: "URL выхода",
    summary: "Endpoint used for user sign-out redirect.",
    summaryRu: "Endpoint, используемый для редиректа при выходе пользователя.",
    type: "string | env-map",
    docsLink: "docs/reference-values.md#param-apps-sections",
    example: "signOutURL: https://auth.example.local/sign_out\n",
  },
  whitelistSourceRanges: {
    title: "Source CIDR Allowlist",
    titleRu: "Allowlist source CIDR",
    summary: "Restricts ingress access by source CIDR ranges.",
    summaryRu: "Ограничивает доступ к ingress по source CIDR диапазонам.",
    type: "YAML block string | list | env-map",
    docsLink: "docs/reference-values.md#param-apps-sections",
    example: "whitelistSourceRanges: |-\n  - 10.0.0.0/8\n  - 192.168.0.0/16\n",
  },
  containers: {
    title: "Containers Block",
    titleRu: "Блок containers",
    summary: "Main workload containers map (`name -> container spec`).",
    summaryRu: "Карта основных контейнеров workload (`имя -> спецификация контейнера`).",
    type: "map",
    notes: [
      "Each key is container name.",
      "Container options are resolved by library helpers and k8s-specific fields.",
    ],
    notesRu: [
      "Каждый ключ — имя контейнера.",
      "Поля контейнера обрабатываются helper-логикой библиотеки и k8s-параметрами.",
    ],
    example: "containers:\n  app:\n    image:\n      name: nginx\n",
  },
  initContainers: {
    title: "Init Containers Block",
    titleRu: "Блок initContainers",
    summary: "Init-container map (`name -> container spec`) executed before main containers.",
    summaryRu: "Карта init-контейнеров (`имя -> спецификация`), выполняемых до main-контейнеров.",
    type: "map",
    notes: [
      "Uses same container field model as `containers`.",
    ],
    notesRu: [
      "Использует ту же модель полей, что и `containers`.",
    ],
    example: "initContainers:\n  init-db:\n    image:\n      name: busybox\n",
  },
  service: {
    title: "Service Block",
    titleRu: "Блок service",
    summary: "Service exposure settings for workload app.",
    summaryRu: "Параметры Service для публикации workload-приложения.",
    type: "map",
    notes: [
      "Typical keys: `enabled`, `ports`, `type`, `selector`.",
    ],
    notesRu: [
      "Типичные ключи: `enabled`, `ports`, `type`, `selector`.",
    ],
    example: "service:\n  enabled: true\n  ports: |-\n    - name: http\n      port: 80\n",
  },
  serviceAccount: {
    title: "Service Account Binding",
    titleRu: "Привязка serviceAccount",
    summary: "Associates workload with service account options.",
    summaryRu: "Связывает workload с настройками service account.",
    type: "map | string",
    example: "serviceAccount:\n  name: app-sa\n",
  },
  podDisruptionBudget: {
    title: "PodDisruptionBudget",
    titleRu: "PodDisruptionBudget",
    summary: "Controls voluntary disruption limits for workload pods.",
    summaryRu: "Ограничивает добровольные прерывания для pod workload-а.",
    type: "map | YAML block string",
    k8sDocsLink: "https://kubernetes.io/docs/tasks/run-application/configure-pdb/",
    example: "podDisruptionBudget:\n  enabled: true\n  minAvailable: 1\n",
  },
  horizontalPodAutoscaler: {
    title: "Horizontal Pod Autoscaler",
    titleRu: "Horizontal Pod Autoscaler",
    summary: "HPA settings for CPU/memory/custom-metric based scaling.",
    summaryRu: "Настройки HPA для масштабирования по CPU/памяти/метрикам.",
    type: "map | YAML block string",
    k8sDocsLink: "https://kubernetes.io/docs/tasks/run-application/horizontal-pod-autoscale/",
    example: "horizontalPodAutoscaler:\n  enabled: true\n  minReplicas: 1\n  maxReplicas: 5\n",
  },
  verticalPodAutoscaler: {
    title: "Vertical Pod Autoscaler",
    titleRu: "Vertical Pod Autoscaler",
    summary: "VPA settings for automatic resources recommendations/update.",
    summaryRu: "Настройки VPA для авто-рекомендаций/обновления ресурсов.",
    type: "map | YAML block string",
    k8sDocsLink: "https://github.com/kubernetes/autoscaler/tree/master/vertical-pod-autoscaler",
    example: "verticalPodAutoscaler:\n  enabled: true\n  updatePolicy:\n    updateMode: Auto\n",
  },
  imagePullSecrets: {
    title: "Image Pull Secrets",
    titleRu: "Image Pull Secrets",
    summary: "Registry secrets used to pull private images.",
    summaryRu: "Секреты реестра для скачивания приватных образов.",
    type: "YAML block string | list",
    k8sDocsLink: "https://kubernetes.io/docs/tasks/configure-pod-container/pull-image-private-registry/",
    example: "imagePullSecrets: |-\n  - name: regcred\n",
  },
  resources: {
    title: "Resources",
    summary: "Resource configuration block (requests/limits).",
    type: "map | env-map",
    docsLink: "docs/reference-values.md#param-resources",
    k8sDocsLink: "https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/",
    notes: [
      "Supported by many library entities and nested component blocks.",
    ],
    example: "resources:\n  requests:\n    mcpu: 100\n    memoryMb: 256\n  limits:\n    mcpu: 500\n    memoryMb: 512\n",
  },
  requests: {
    title: "Resource Requests",
    summary: "Requested CPU/Memory values for scheduling.",
    type: "map | env-map",
    docsLink: "docs/reference-values.md#param-resources",
    k8sDocsLink: "https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/",
    example: "requests:\n  mcpu: 100\n  memoryMb: 256\n",
  },
  limits: {
    title: "Resource Limits",
    summary: "Upper bound CPU/Memory values for runtime.",
    type: "map | env-map",
    docsLink: "docs/reference-values.md#param-resources",
    k8sDocsLink: "https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/",
    example: "limits:\n  mcpu: 500\n  memoryMb: 512\n",
  },
  mcpu: {
    title: "CPU (mCPU)",
    summary: "CPU value in millicores.",
    type: "number | env-map",
    docsLink: "docs/reference-values.md#param-resources",
    k8sDocsLink: "https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/",
    notes: ["Example: `100` means 0.1 CPU core."],
    example: "mcpu:\n  _default: 100\n  production: 500\n",
  },
  memoryMb: {
    title: "Memory (MiB)",
    summary: "Memory value in MiB.",
    type: "number | env-map",
    docsLink: "docs/reference-values.md#param-resources",
    k8sDocsLink: "https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/",
    example: "memoryMb:\n  _default: 256\n  production: 1024\n",
  },
  envVars: {
    title: "envVars Helper",
    summary: "Declares container env variables as key/value map with env-map support.",
    type: "map | env-map",
    docsLink: "docs/reference-values.md#param-envvars-usage",
    example: "envVars:\n  LOG_LEVEL: info\n  APP_MODE:\n    _default: safe\n    production: fast\n",
  },
  secretEnvVars: {
    title: "secretEnvVars Helper",
    summary: "Generates Secret-backed env vars and wires them into container env chain.",
    type: "map | env-map",
    docsLink: "docs/reference-values.md#param-secretenvvars",
    example: "secretEnvVars:\n  DB_PASSWORD:\n    _default: dev-password\n    production: prod-password\n",
  },
  sharedEnvSecrets: {
    title: "sharedEnvSecrets Helper",
    summary: "Adds shared Secret references into container `envFrom`.",
    type: "list",
    docsLink: "docs/reference-values.md#param-sharedenvsecrets",
    example: "sharedEnvSecrets:\n  - common-runtime\n  - platform-observability\n",
  },
  sharedEnvConfigMaps: {
    title: "sharedEnvConfigMaps Helper",
    summary: "Adds shared ConfigMap references into container `envFrom`.",
    type: "list",
    docsLink: "docs/reference-values.md#param-sharedenvconfigmaps",
    example: "sharedEnvConfigMaps:\n  - common-runtime-cm\n  - platform-observability-cm\n",
  },
  configFiles: {
    title: "configFiles Helper",
    summary: "Creates/mounts text config files for a container.",
    type: "map",
    docsLink: "docs/reference-values.md#param-configfiles",
    example: "configFiles:\n  app.yaml:\n    mountPath: /etc/app/app.yaml\n    content: |\n      key: value\n",
  },
  configFilesYAML: {
    title: "configFilesYAML Helper",
    summary: "YAML-aware config files with env-map overrides in content tree.",
    type: "map",
    docsLink: "docs/reference-values.md#param-configfilesyaml",
    example: "configFilesYAML:\n  app.yaml:\n    mountPath: /etc/app/app.yaml\n    content:\n      key:\n        _default: value\n        production: prod-value\n",
  },
  fromSecretsEnvVars: {
    title: "fromSecretsEnvVars Helper",
    summary: "Maps keys from external Secret into explicit env vars.",
    type: "map | list",
    docsLink: "docs/reference-values.md#param-fromsecretsenvvars",
    example: "fromSecretsEnvVars:\n  external-db:\n    DB_PASSWORD: password\n",
  },
  envYAML: {
    title: "Container Env YAML",
    titleRu: "Container env YAML",
    summary: "Native Kubernetes `env` array for container-level variable declarations.",
    summaryRu: "Нативный Kubernetes массив `env` для объявления переменных контейнера.",
    type: "list",
    docsLink: "docs/reference-values.md#param-envyaml",
    k8sDocsLink: "https://kubernetes.io/docs/tasks/inject-data-application/define-environment-variable-container/",
    notes: [
      "This is one of explicit list-policy exceptions.",
    ],
    notesRu: [
      "Это одно из явных исключений в list-policy.",
    ],
    example: "envYAML:\n  - name: LOG_LEVEL\n    value: info\n",
  },
  env: {
    title: "Raw env block",
    titleRu: "Raw env блок",
    summary: "Low-level raw env mapping/list passed into container template.",
    summaryRu: "Низкоуровневый raw env блок, передаваемый в контейнерный шаблон.",
    type: "YAML block string | map | list",
    k8sDocsLink: "https://kubernetes.io/docs/tasks/inject-data-application/define-environment-variable-container/",
    example: "env: |-\n  - name: HTTP_PORT\n    value: \"8080\"\n",
  },
  secretConfigFiles: {
    title: "secretConfigFiles Helper",
    titleRu: "Хелпер secretConfigFiles",
    summary: "Creates or mounts Secret-backed files into container filesystem.",
    summaryRu: "Создает или монтирует файлы на основе Secret в файловую систему контейнера.",
    type: "map",
    docsLink: "docs/reference-values.md#param-secretconfigfiles",
    example: "secretConfigFiles:\n  token.txt:\n    mountPath: /etc/secret/token.txt\n    content: super-secret\n",
  },
  persistantVolumes: {
    title: "Persistent Volumes (legacy key)",
    titleRu: "Persistent Volumes (legacy ключ)",
    summary: "Legacy compatibility key for persistent volume mapping in container spec.",
    summaryRu: "Legacy-ключ совместимости для маппинга persistent volumes в container spec.",
    type: "YAML block string | map",
    notes: [
      "Prefer modern `volumes` / `volumeMounts` where possible.",
    ],
    notesRu: [
      "По возможности используйте современные `volumes` / `volumeMounts`.",
    ],
    example: "persistantVolumes: |-\n  data:\n    mountPath: /var/lib/app\n",
  },
  apiVersion: {
    title: "Kubernetes API Version",
    titleRu: "Kubernetes API version",
    summary: "Explicit API version override for rendered manifest.",
    summaryRu: "Явное переопределение API версии для рендеримого манифеста.",
    type: "string | env-map",
    k8sDocsLink: "https://kubernetes.io/docs/reference/using-api/",
    example: "apiVersion: networking.k8s.io/v1\n",
  },
  kind: {
    title: "Kubernetes Kind",
    titleRu: "Kubernetes Kind",
    summary: "Explicit kind override for manifest rendering.",
    summaryRu: "Явное переопределение kind для рендера манифеста.",
    type: "string | env-map",
    k8sDocsLink: "https://kubernetes.io/docs/reference/using-api/",
    example: "kind: NetworkPolicy\n",
  },
  spec: {
    title: "Manifest Spec Override",
    titleRu: "Переопределение spec манифеста",
    summary: "Raw `spec` fragment merged into target Kubernetes object.",
    summaryRu: "Raw-фрагмент `spec`, мержимый в целевой Kubernetes объект.",
    type: "YAML block string | map | env-map",
    example: "spec: |-\n  replicas: 2\n  template:\n    spec:\n      hostNetwork: true\n",
  },
  podSelector: {
    title: "NetworkPolicy Pod Selector",
    titleRu: "Pod selector для NetworkPolicy",
    summary: "Selects target pods to which policy is applied.",
    summaryRu: "Выбирает целевые pod, к которым применяется policy.",
    type: "YAML block string | map | env-map",
    k8sDocsLink: "https://kubernetes.io/docs/concepts/services-networking/network-policies/",
    example: "podSelector: |-\n  matchLabels:\n    app: api\n",
  },
  policyTypes: {
    title: "NetworkPolicy Types",
    titleRu: "Типы NetworkPolicy",
    summary: "Policy direction list (`Ingress`, `Egress`) for Kubernetes NetworkPolicy.",
    summaryRu: "Список направлений policy (`Ingress`, `Egress`) для Kubernetes NetworkPolicy.",
    type: "YAML block string | list | env-map",
    k8sDocsLink: "https://kubernetes.io/docs/concepts/services-networking/network-policies/",
    example: "policyTypes: |-\n  - Ingress\n  - Egress\n",
  },
  ingress: {
    title: "NetworkPolicy Ingress Rules",
    titleRu: "Ingress rules NetworkPolicy",
    summary: "Allowed inbound traffic rules for selected pods.",
    summaryRu: "Правила разрешенного входящего трафика для выбранных pod.",
    type: "YAML block string | list | env-map",
    k8sDocsLink: "https://kubernetes.io/docs/concepts/services-networking/network-policies/",
    example: "ingress: |-\n  - from:\n      - namespaceSelector:\n          matchLabels:\n            team: core\n",
  },
  egress: {
    title: "NetworkPolicy Egress Rules",
    titleRu: "Egress rules NetworkPolicy",
    summary: "Allowed outbound traffic rules for selected pods.",
    summaryRu: "Правила разрешенного исходящего трафика для выбранных pod.",
    type: "YAML block string | list | env-map",
    k8sDocsLink: "https://kubernetes.io/docs/concepts/services-networking/network-policies/",
    example: "egress: |-\n  - to:\n      - ipBlock:\n          cidr: 10.0.0.0/8\n",
  },
  endpointSelector: {
    title: "Endpoint Selector",
    titleRu: "Endpoint selector",
    summary: "Endpoint selector fragment (commonly used in Cilium policy style).",
    summaryRu: "Фрагмент endpoint selector (часто используется в Cilium-стиле policy).",
    type: "YAML block string | map | env-map",
    example: "endpointSelector: |-\n  matchLabels:\n    app.kubernetes.io/name: api\n",
  },
  ingressDeny: {
    title: "Ingress Deny Rules",
    titleRu: "Ingress deny rules",
    summary: "Explicit deny rules for inbound traffic in policy engines that support deny model.",
    summaryRu: "Явные deny-правила входящего трафика для policy-движков с поддержкой deny-модели.",
    type: "YAML block string | list | env-map",
    example: "ingressDeny: |-\n  - from:\n      - ipBlock:\n          cidr: 0.0.0.0/0\n",
  },
  egressDeny: {
    title: "Egress Deny Rules",
    titleRu: "Egress deny rules",
    summary: "Explicit deny rules for outbound traffic in policy engines that support deny model.",
    summaryRu: "Явные deny-правила исходящего трафика для policy-движков с поддержкой deny-модели.",
    type: "YAML block string | list | env-map",
    example: "egressDeny: |-\n  - to:\n      - dns:\n          matchPattern: \"*.internal\"\n",
  },
  types: {
    title: "Policy Types (legacy/Cilium variants)",
    titleRu: "Policy types (legacy/Cilium варианты)",
    summary: "Alternative policy-type selector used by specific network-policy renderers.",
    summaryRu: "Альтернативный селектор типа policy для отдельных network-policy рендереров.",
    type: "YAML block string | list | env-map",
    example: "types: |-\n  - cilium\n",
  },
  extraSpec: {
    title: "Extra Spec Patch",
    titleRu: "Дополнительный патч spec",
    summary: "Additional raw spec fragment appended/merged after base policy spec generation.",
    summaryRu: "Дополнительный raw-фрагмент spec, добавляемый/мержимый после базовой генерации policy.",
    type: "YAML block string | map | env-map",
    example: "extraSpec: |-\n  endpointSelector:\n    matchLabels:\n      app: api\n",
  },
  kafka: {
    title: "Strimzi Kafka Block",
    titleRu: "Блок Strimzi Kafka",
    summary: "Kafka cluster settings for `apps-kafka-strimzi` entity.",
    summaryRu: "Настройки Kafka-кластера для сущности `apps-kafka-strimzi`.",
    type: "map",
    docsLink: "docs/reference-values.md#param-apps-sections",
    example: "kafka:\n  replicas: 3\n  resources:\n    requests:\n      mcpu: 500\n      memoryMb: 2048\n",
  },
  zookeeper: {
    title: "Strimzi Zookeeper Block",
    titleRu: "Блок Strimzi Zookeeper",
    summary: "Zookeeper settings for `apps-kafka-strimzi` entity.",
    summaryRu: "Настройки Zookeeper для сущности `apps-kafka-strimzi`.",
    type: "map",
    docsLink: "docs/reference-values.md#param-apps-sections",
    example: "zookeeper:\n  replicas: 3\n",
  },
  topics: {
    title: "Kafka Topics Block",
    titleRu: "Блок Kafka topics",
    summary: "Topic definitions generated together with Strimzi resources.",
    summaryRu: "Определения топиков, генерируемых вместе со Strimzi-ресурсами.",
    type: "map",
    docsLink: "docs/reference-values.md#param-apps-sections",
    example: "topics:\n  events:\n    partitions: 12\n    replicas: 3\n",
  },
  entityOperator: {
    title: "Strimzi Entity Operator",
    titleRu: "Strimzi Entity Operator",
    summary: "Settings for topic/user operators in Strimzi deployment.",
    summaryRu: "Настройки topic/user операторов в Strimzi deployment.",
    type: "map",
    docsLink: "docs/reference-values.md#param-apps-sections",
    example: "entityOperator:\n  topicOperator:\n    resources:\n      requests:\n        mcpu: 100\n",
  },
  exporter: {
    title: "Kafka Exporter",
    titleRu: "Kafka Exporter",
    summary: "Metrics exporter settings for Kafka cluster.",
    summaryRu: "Настройки экспортера метрик для Kafka-кластера.",
    type: "map",
    docsLink: "docs/reference-values.md#param-apps-sections",
    example: "exporter:\n  enabled: true\n",
  },
  deckhouseMetrics: {
    title: "Deckhouse Metrics",
    titleRu: "Deckhouse metrics",
    summary: "Deckhouse-specific monitoring integration block.",
    summaryRu: "Блок интеграции мониторинга для Deckhouse-окружения.",
    type: "map",
    docsLink: "docs/reference-values.md#param-apps-sections",
    example: "deckhouseMetrics:\n  enabled: true\n",
  },
  uid: {
    title: "System User UID",
    titleRu: "UID системного пользователя",
    summary: "Numeric UID for `apps-infra.node-users` entry.",
    summaryRu: "Числовой UID для записи `apps-infra.node-users`.",
    type: "number | string | env-map",
    docsLink: "docs/reference-values.md#param-apps-sections",
    example: "uid: 1001\n",
  },
  passwordHash: {
    title: "Password Hash",
    titleRu: "Хэш пароля",
    summary: "Precomputed password hash for infra node user.",
    summaryRu: "Предварительно вычисленный хэш пароля для infra node-user.",
    type: "string | env-map",
    docsLink: "docs/reference-values.md#param-apps-sections",
    example: "passwordHash: \"$6$rounds=10000$...\"\n",
  },
  sshPublicKey: {
    title: "SSH Public Key",
    titleRu: "SSH публичный ключ",
    summary: "Single SSH public key for infra node user access.",
    summaryRu: "Один SSH публичный ключ для доступа infra node-user.",
    type: "string | env-map",
    docsLink: "docs/reference-values.md#param-apps-sections",
    example: "sshPublicKey: \"ssh-ed25519 AAAAC3... user@example\"\n",
  },
  sshPublicKeys: {
    title: "SSH Public Keys",
    titleRu: "SSH публичные ключи",
    summary: "Multiple SSH public keys for infra node user.",
    summaryRu: "Несколько SSH публичных ключей для infra node-user.",
    type: "YAML block string | list | env-map",
    docsLink: "docs/reference-values.md#param-apps-sections",
    example: "sshPublicKeys: |-\n  - ssh-ed25519 AAAAC3... user1@example\n  - ssh-ed25519 AAAAC3... user2@example\n",
  },
  extraGroups: {
    title: "Extra Linux Groups",
    titleRu: "Дополнительные Linux группы",
    summary: "Additional Unix groups assigned to infra node user.",
    summaryRu: "Дополнительные Unix-группы, назначаемые infra node-user.",
    type: "YAML block string | list | env-map",
    docsLink: "docs/reference-values.md#param-apps-sections",
    example: "extraGroups: |-\n  - docker\n  - systemd-journal\n",
  },
  nodeGroups: {
    title: "Node Groups Selection",
    titleRu: "Выбор групп нод",
    summary: "Node-group list where infra user should be applied.",
    summaryRu: "Список групп нод, на которые должен применяться infra user.",
    type: "YAML block string | list | env-map",
    docsLink: "docs/reference-values.md#param-apps-sections",
    example: "nodeGroups: |-\n  - workers\n  - infra\n",
  },
  isSudoer: {
    title: "Sudo Privilege Flag",
    titleRu: "Флаг sudo-привилегии",
    summary: "Grants sudo permissions to infra node user when enabled.",
    summaryRu: "Выдает sudo-привилегии infra node-user при включении.",
    type: "bool | env-map",
    docsLink: "docs/reference-values.md#param-apps-sections",
    example: "isSudoer: true\n",
  },
  "node-users": {
    title: "Infra Node Users",
    titleRu: "Пользователи нод",
    summary: "Map of system users managed on target node groups.",
    summaryRu: "Карта системных пользователей, управляемых на целевых группах нод.",
    type: "map(userName -> userSpec)",
    docsLink: "docs/reference-values.md#param-apps-sections",
    example: "node-users:\n  deploy:\n    uid: 1001\n    isSudoer: true\n",
  },
  "node-groups": {
    title: "Infra Node Groups",
    titleRu: "Группы нод",
    summary: "Inventory/group definitions used by infra automation blocks.",
    summaryRu: "Определения инвентаря/групп нод для infra-автоматизации.",
    type: "map",
    docsLink: "docs/reference-values.md#param-apps-sections",
    example: "node-groups:\n  workers:\n    labels: |-\n      role: worker\n",
  },
  image: {
    title: "Container Image",
    titleRu: "Образ контейнера",
    summary: "Container image settings (`name`, `staticTag`, optional generated tag behavior).",
    summaryRu: "Настройки образа контейнера (`name`, `staticTag`, опционально генерация тега).",
    type: "map",
    docsLinkEn: "docs/k8s-fields-guide.en.md#image",
    docsLinkRu: "docs/k8s-fields-guide.md#image",
    k8sDocsLink: "https://kubernetes.io/docs/concepts/containers/images/",
    example: "image:\n  name: ghcr.io/example/api\n  staticTag: \"1.2.3\"\n",
  },
  command: {
    title: "Container Command",
    titleRu: "Команда контейнера",
    summary: "Overrides container entrypoint command.",
    summaryRu: "Переопределяет команду запуска контейнера (entrypoint).",
    type: "YAML block string | env-map",
    docsLinkEn: "docs/k8s-fields-guide.en.md#command-and-args",
    docsLinkRu: "docs/k8s-fields-guide.md#command-and-args",
    k8sDocsLink: "https://kubernetes.io/docs/tasks/inject-data-application/define-command-argument-container/",
    example: "command: |-\n  - /app/server\n",
  },
  args: {
    title: "Container Args",
    titleRu: "Аргументы контейнера",
    summary: "Sets arguments passed to container command.",
    summaryRu: "Задает аргументы, передаваемые в команду контейнера.",
    type: "YAML block string | env-map",
    docsLinkEn: "docs/k8s-fields-guide.en.md#command-and-args",
    docsLinkRu: "docs/k8s-fields-guide.md#command-and-args",
    k8sDocsLink: "https://kubernetes.io/docs/tasks/inject-data-application/define-command-argument-container/",
    example: "args: |-\n  - --port=8080\n  - --log-level=info\n",
  },
  livenessProbe: {
    title: "Liveness Probe",
    titleRu: "Liveness Probe",
    summary: "Restart check: if probe fails repeatedly, Kubernetes restarts the container.",
    summaryRu: "Проверка живости: при регулярном провале Kubernetes перезапускает контейнер.",
    type: "YAML block string | map",
    docsLinkEn: "docs/k8s-fields-guide.en.md#probes-liveness-readiness-startup",
    docsLinkRu: "docs/k8s-fields-guide.md#probes-liveness-readiness-startup",
    k8sDocsLink: "https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/",
    example: "livenessProbe: |-\n  httpGet:\n    path: /healthz\n    port: 8080\n  initialDelaySeconds: 15\n",
  },
  readinessProbe: {
    title: "Readiness Probe",
    titleRu: "Readiness Probe",
    summary: "Traffic readiness check: failing pod is removed from Service endpoints.",
    summaryRu: "Проверка готовности к трафику: при провале pod убирается из endpoint'ов Service.",
    type: "YAML block string | map",
    docsLinkEn: "docs/k8s-fields-guide.en.md#probes-liveness-readiness-startup",
    docsLinkRu: "docs/k8s-fields-guide.md#probes-liveness-readiness-startup",
    k8sDocsLink: "https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/",
    example: "readinessProbe: |-\n  httpGet:\n    path: /ready\n    port: 8080\n  periodSeconds: 5\n",
  },
  startupProbe: {
    title: "Startup Probe",
    titleRu: "Startup Probe",
    summary: "Slow-start guard: delays liveness/readiness failures until app starts.",
    summaryRu: "Защита медленного старта: откладывает liveness/readiness до запуска приложения.",
    type: "YAML block string | map",
    docsLinkEn: "docs/k8s-fields-guide.en.md#probes-liveness-readiness-startup",
    docsLinkRu: "docs/k8s-fields-guide.md#probes-liveness-readiness-startup",
    k8sDocsLink: "https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/",
    example: "startupProbe: |-\n  httpGet:\n    path: /startup\n    port: 8080\n  failureThreshold: 30\n  periodSeconds: 10\n",
  },
  securityContext: {
    title: "Security Context",
    titleRu: "Контекст безопасности",
    summary: "Container/pod security options (user, capabilities, privilege controls).",
    summaryRu: "Параметры безопасности контейнера/pod (пользователь, capabilities, привилегии).",
    type: "YAML block string | map",
    docsLinkEn: "docs/k8s-fields-guide.en.md#security-context",
    docsLinkRu: "docs/k8s-fields-guide.md#security-context",
    k8sDocsLink: "https://kubernetes.io/docs/tasks/configure-pod-container/security-context/",
    example: "securityContext: |-\n  runAsNonRoot: true\n  runAsUser: 1000\n  readOnlyRootFilesystem: true\n",
  },
  affinity: {
    title: "Affinity",
    titleRu: "Affinity",
    summary: "Rules for pod placement by labels/topology.",
    summaryRu: "Правила размещения pod по лейблам и топологии.",
    type: "YAML block string | map",
    docsLinkEn: "docs/k8s-fields-guide.en.md#affinity-tolerations-nodeselector",
    docsLinkRu: "docs/k8s-fields-guide.md#affinity-tolerations-nodeselector",
    k8sDocsLink: "https://kubernetes.io/docs/concepts/scheduling-eviction/assign-pod-node/",
    example: "affinity: |-\n  podAntiAffinity:\n    preferredDuringSchedulingIgnoredDuringExecution:\n      - weight: 100\n",
  },
  tolerations: {
    title: "Tolerations",
    titleRu: "Tolerations",
    summary: "Allows scheduling on tainted nodes matching toleration rules.",
    summaryRu: "Позволяет запуск на tainted-нодах при совпадении правил toleration.",
    type: "YAML block string | map",
    docsLinkEn: "docs/k8s-fields-guide.en.md#affinity-tolerations-nodeselector",
    docsLinkRu: "docs/k8s-fields-guide.md#affinity-tolerations-nodeselector",
    k8sDocsLink: "https://kubernetes.io/docs/concepts/scheduling-eviction/taint-and-toleration/",
    example: "tolerations: |-\n  - key: dedicated\n    operator: Equal\n    value: workload\n    effect: NoSchedule\n",
  },
  nodeSelector: {
    title: "Node Selector",
    titleRu: "Node Selector",
    summary: "Simple label-based node selection for pods.",
    summaryRu: "Простой выбор нод для pod по label-ключам.",
    type: "YAML block string | map",
    docsLinkEn: "docs/k8s-fields-guide.en.md#affinity-tolerations-nodeselector",
    docsLinkRu: "docs/k8s-fields-guide.md#affinity-tolerations-nodeselector",
    k8sDocsLink: "https://kubernetes.io/docs/concepts/scheduling-eviction/assign-pod-node/",
    example: "nodeSelector: |-\n  kubernetes.io/os: linux\n",
  },
  volumes: {
    title: "Volumes",
    titleRu: "Volumes",
    summary: "Pod volume declarations attached to containers via `volumeMounts`.",
    summaryRu: "Описание томов pod, подключаемых в контейнеры через `volumeMounts`.",
    type: "YAML block string | map",
    docsLinkEn: "docs/k8s-fields-guide.en.md#volumes-and-volumemounts",
    docsLinkRu: "docs/k8s-fields-guide.md#volumes-and-volumemounts",
    k8sDocsLink: "https://kubernetes.io/docs/concepts/storage/volumes/",
    example: "volumes: |-\n  - name: cache\n    emptyDir: {}\n",
  },
  volumeMounts: {
    title: "Volume Mounts",
    titleRu: "Volume Mounts",
    summary: "Container mount points for declared volumes.",
    summaryRu: "Точки монтирования томов в контейнере.",
    type: "YAML block string | map",
    docsLinkEn: "docs/k8s-fields-guide.en.md#volumes-and-volumemounts",
    docsLinkRu: "docs/k8s-fields-guide.md#volumes-and-volumemounts",
    k8sDocsLink: "https://kubernetes.io/docs/concepts/storage/volumes/",
    example: "volumeMounts: |-\n  - name: cache\n    mountPath: /tmp/cache\n",
  },
  lifecycle: {
    title: "Lifecycle Hooks",
    titleRu: "Lifecycle Hooks",
    summary: "Container startup/shutdown hooks (`postStart`, `preStop`).",
    summaryRu: "Хуки старта/остановки контейнера (`postStart`, `preStop`).",
    type: "YAML block string | map",
    docsLinkEn: "docs/k8s-fields-guide.en.md#lifecycle-hooks",
    docsLinkRu: "docs/k8s-fields-guide.md#lifecycle-hooks",
    k8sDocsLink: "https://kubernetes.io/docs/concepts/containers/container-lifecycle-hooks/",
    example: "lifecycle: |-\n  preStop:\n    exec:\n      command: [\"/bin/sh\", \"-c\", \"sleep 5\"]\n",
  },
  envFrom: {
    title: "envFrom",
    summary: "Imports env variables from ConfigMap/Secret references.",
    type: "YAML block string | list",
    docsLinkEn: "docs/k8s-fields-guide.en.md#envfrom",
    docsLinkRu: "docs/k8s-fields-guide.md#envfrom",
    k8sDocsLink: "https://kubernetes.io/docs/tasks/inject-data-application/define-environment-variable-container/",
    example: "envFrom: |-\n  - secretRef:\n      name: app-secrets\n  - configMapRef:\n      name: app-config\n",
  },
  ports: {
    title: "Ports",
    summary: "Port declarations for containers/services.",
    type: "YAML block string | list",
    docsLinkEn: "docs/k8s-fields-guide.en.md#ports",
    docsLinkRu: "docs/k8s-fields-guide.md#ports",
    k8sDocsLink: "https://kubernetes.io/docs/concepts/services-networking/service/",
    example: "ports: |-\n  - name: http\n    containerPort: 8080\n",
  },
};

export function findKeyPathAtPosition(text: string, line: number, character: number): string[] | null {
  const lines = text.split(/\r?\n/);
  if (line < 0 || line >= lines.length) {
    return null;
  }

  const stack: Array<{ indent: number; key: string }> = [];
  let blockScalarIndent: number | null = null;

  for (let i = 0; i <= line; i += 1) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }

    const indent = countIndent(raw);
    if (blockScalarIndent !== null) {
      if (indent > blockScalarIndent) {
        continue;
      }
      blockScalarIndent = null;
    }

    const keyMatch = raw.match(/^(\s*)([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (!keyMatch) {
      continue;
    }

    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }

    const key = keyMatch[2];
    const keyStart = keyMatch[1].length;
    const keyEnd = keyStart + key.length;
    const path = [...stack.map((s) => s.key), key];

    if (i === line) {
      // Show field hover for the whole key-value line, not only exact key token.
      // This avoids falling back to generic schema hover when user points at ":" or value area.
      if (character >= keyStart && character <= raw.length) {
        return path;
      }
    }

    stack.push({ indent, key });
    if (/^[|>][-+]?\s*$/.test(keyMatch[3].trim())) {
      blockScalarIndent = indent;
    }
  }

  return null;
}

export function findFieldDoc(path: string[], context?: FieldDocLookupContext): FieldDoc | null {
  const candidatePaths = buildCandidateDocPaths(path, context);
  for (const candidate of candidatePaths) {
    for (const rule of RULES) {
      if (matchesPath(rule.pattern, candidate)) {
        return specializeDocForPath(candidate, rule.doc);
      }
    }
  }

  const byLastKey = LAST_KEY_RULES[path[path.length - 1] ?? ""];
  if (byLastKey) {
    const contextPath = candidatePaths.find((candidate) => candidate.length === path.length && BUILTIN_GROUP_SET.has(candidate[0])) ?? path;
    return specializeDocForPath(contextPath, byLastKey);
  }

  for (const candidate of candidatePaths) {
    const dynamic = dynamicFieldDoc(candidate);
    if (dynamic) {
      return specializeDocForPath(candidate, dynamic);
    }
  }
  for (const candidate of candidatePaths) {
    const schemaDoc = schemaFieldDoc(candidate);
    if (schemaDoc) {
      return specializeDocForPath(candidate, schemaDoc);
    }
  }
  const unknown = unknownFieldDoc(path);
  if (unknown) {
    return specializeDocForPath(path, unknown);
  }
  return null;
}

function buildCandidateDocPaths(path: string[], context?: FieldDocLookupContext): string[][] {
  const out: string[][] = [];
  const pushPath = (next: string[]) => {
    const key = next.join("\u001f");
    if (out.some((existing) => existing.join("\u001f") === key)) {
      return;
    }
    out.push(next);
  };

  pushPath(path);
  if (!context?.documentText || path.length === 0) {
    return out;
  }

  const group = path[0];
  if (!group || group === "global" || group.startsWith("apps-")) {
    return out;
  }

  const effective = resolveEffectiveGroupTypeFromText(context.documentText, group, context.env);
  if (!effective || effective === group) {
    return out;
  }
  pushPath([effective, ...path.slice(1)]);
  return out;
}

export function buildFieldDocMarkdown(path: string[], doc: FieldDoc): string {
  return buildFieldDocMarkdownLocalized(path, doc, "en");
}

export function buildFieldDocMarkdownLocalized(path: string[], doc: FieldDoc, locale: string): string {
  const ru = isRussianLocale(locale);
  const title = ru ? (doc.titleRu ?? doc.title) : doc.title;
  const summary = ru ? (doc.summaryRu ?? doc.summary) : doc.summary;
  const notes = ru ? (doc.notesRu ?? doc.notes) : doc.notes;
  const typeText = ru ? (doc.typeRu ?? doc.type) : doc.type;

  const parts: string[] = [];
  parts.push(`**${title}**`);
  parts.push(`\`${path.join(".")}\``);
  parts.push("");
  parts.push(`**${ru ? "Назначение" : "Purpose"}**: ${summary.trim()}`);
  parts.push("");
  parts.push(`**${ru ? "Тип" : "Type"}**: \`${typeText}\``);
  if (notes && notes.length > 0) {
    parts.push("");
    parts.push(`**${ru ? "Важно" : "Important"}**:`);
    for (const n of notes) {
      parts.push(`- ${n}`);
    }
  }
  if (doc.example) {
    parts.push("");
    parts.push(`**${ru ? "Пример" : "Example"}**:`);
    parts.push("```yaml");
    parts.push(doc.example.trimEnd());
    parts.push("```");
  }
  if (doc.docsLink || doc.docsLinkEn || doc.docsLinkRu) {
    parts.push("");
    const localLink = resolveDocsLink(doc, ru);
    const onlineLink = toOnlineDocsLink(localLink);
    parts.push(`**${ru ? "Документация" : "Docs"}**: [${ru ? "Открыть онлайн" : "Open Online"}](${onlineLink})`);
  }
  if (doc.k8sDocsLink) {
    parts.push("");
    parts.push(`**${ru ? "Kubernetes Docs" : "Kubernetes Docs"}**: [${doc.k8sDocsLink}](${doc.k8sDocsLink})`);
  }
  return parts.join("\n");
}

function matchesPath(pattern: string[], path: string[]): boolean {
  if (pattern.length !== path.length) {
    return false;
  }
  for (let i = 0; i < pattern.length; i += 1) {
    if (pattern[i] !== "*" && pattern[i] !== path[i]) {
      return false;
    }
  }
  return true;
}

function dynamicFieldDoc(path: string[]): FieldDoc | null {
  if (path.length === 1) {
    const group = path[0];
    if (group === "global") {
      return {
        title: "Global Settings",
        summary: "Common settings applied across groups: env selection, includes and deploy/release controls.",
        type: "map",
        notes: [
          "Most important keys: `env`, `_includes`, `deploy`, `releases`.",
        ],
        example: "global:\n  env: prod\n",
      };
    }
    if (BUILTIN_GROUP_SET.has(group)) {
  const guide = GROUP_APP_GUIDES[group];
  const groupKeys = guide ? formatKeyList(guide.keys) : "";
  return {
    title: "Built-in Group",
    titleRu: "Встроенная группа",
    summary: guide
      ? `${guide.purpose} Group \`${group}\` is rendered by helm-apps built-in templates.`
      : `Top-level built-in group \`${group}\` rendered by helm-apps library templates.`,
    summaryRu: guide
      ? `${guide.purposeRu} Группа \`${group}\` рендерится встроенными шаблонами helm-apps.`
      : `Верхнеуровневая встроенная группа \`${group}\`, рендерится шаблонами библиотеки helm-apps.`,
    type: "map(appName -> appConfig)",
    notes: [
      "Each child key is an app name.",
      `Base app keys: ${formatKeyList(BASE_APP_KEYS)}.`,
      ...(guide ? [`Group-specific app keys: ${groupKeys}.`] : ["Use renderer-specific fields inside app."]),
    ],
    notesRu: [
      "Каждый дочерний ключ — это имя приложения.",
      `Базовые app-ключи: ${formatKeyList(BASE_APP_KEYS)}.`,
      ...(guide ? [`Ключи этой группы: ${groupKeys}.`] : ["Используйте поля выбранного рендерера внутри app."]),
    ],
    example: `${group}:\n  my-app:\n    enabled: true\n`,
  };
    }
    return {
      title: "Custom Group",
      titleRu: "Кастомная группа",
      summary: "Top-level custom group. Renderer type is usually defined in `__GroupVars__.type`.",
      summaryRu: "Кастомная верхнеуровневая группа. Тип рендерера обычно задается в `__GroupVars__.type`.",
      type: "map",
      notes: [
        "Can map to any built-in renderer or custom `<type>.render` template.",
      ],
      notesRu: [
        "Может маппиться на любой встроенный рендерер или на custom-шаблон `<type>.render`.",
      ],
      example: `${group}:\n  __GroupVars__:\n    type: apps-stateless\n  my-app:\n    enabled: true\n`,
    };
  }

  if (path.length === 2 && path[0] !== "global" && path[1] !== "__GroupVars__") {
    const group = path[0];
    const guide = GROUP_APP_GUIDES[group];
    const allowedKeys = [...getAllowedAppRootKeysByGroup(group)].sort();
    const groupSpecificKeys = allowedKeys.filter((key) => !BASE_APP_KEYS.includes(key));
    const groupKeys = groupSpecificKeys.length > 0
      ? formatKeyList(groupSpecificKeys)
      : (guide ? formatKeyList(guide.keys) : "");
    return {
      title: "App Entry",
      titleRu: "Узел приложения",
      summary: guide
        ? `Application config \`${path[1]}\` in \`${group}\`. ${guide.purpose}`
        : `Application config \`${path[1]}\` inside group \`${group}\`.`,
      summaryRu: guide
        ? `Конфигурация приложения \`${path[1]}\` в \`${group}\`. ${guide.purposeRu}`
        : `Конфигурация приложения \`${path[1]}\` внутри группы \`${group}\`.`,
      type: "map",
      notes: [
        `Base app keys: ${formatKeyList(BASE_APP_KEYS)}.`,
        ...(groupKeys
          ? [`Group-specific keys for \`${group}\`: ${groupKeys}.`]
          : (guide ? [] : ["Add renderer-specific keys based on selected group type."])),
        ...(guide?.notes ?? []),
      ],
      notesRu: [
        `Базовые app-ключи: ${formatKeyList(BASE_APP_KEYS)}.`,
        ...(groupKeys
          ? [`Ключи для \`${group}\`: ${groupKeys}.`]
          : (guide ? [] : ["Добавьте ключи выбранного рендерера для этой группы."])),
        ...(guide?.notesRu ?? []),
      ],
      example: `${group}:\n  ${path[1]}:\n    enabled: true\n`,
    };
  }

  return null;
}

function specializeDocForPath(path: string[], doc: FieldDoc): FieldDoc {
  if (path.length < 2) {
    return doc;
  }
  const group = path[0];
  const guide = GROUP_APP_GUIDES[group];
  if (!guide) {
    return doc;
  }

  const nonTypical = nonTypicalGroupFieldDoc(path, doc, guide);
  if (nonTypical) {
    return nonTypical;
  }

  const notes = [...(doc.notes ?? [])];
  const notesRu = [...(doc.notesRu ?? [])];
  const pushNote = (en: string, ru: string) => {
    if (!notes.includes(en)) {
      notes.push(en);
    }
    if (!notesRu.includes(ru)) {
      notesRu.push(ru);
    }
  };

  pushNote(
    `Group context: \`${group}\` (${guide.purpose.toLowerCase()})`,
    `Контекст группы: \`${group}\` (${guide.purposeRu.toLowerCase()})`,
  );

  if (path.length >= 3) {
    const appRootKey = path[2];
    const fieldKey = path[path.length - 1];

    if (fieldKey === "_include") {
      if (path.length === 3) {
        pushNote(
          "This is a base app key used in almost every group to inherit shared defaults.",
          "Это базовый app-ключ, который почти во всех группах используется для наследования общих дефолтов.",
        );
      } else {
        pushNote(
          "Nested `_include` applies profile merge at current nested node.",
          "Вложенный `_include` применяет merge профиля на уровне текущего узла.",
        );
      }
    }
    if (fieldKey === "enabled") {
      if (path.length === 3) {
        pushNote(
          "This is a base app key: global on/off switch for the whole app entity.",
          "Это базовый app-ключ: глобальный on/off переключатель всей app-сущности.",
        );
      } else {
        pushNote(
          "This `enabled` toggles only the current subcomponent, not the whole app.",
          "Этот `enabled` переключает только текущий subcomponent, а не приложение целиком.",
        );
      }
    }

    const componentHints = GROUP_COMPONENT_HINTS[group];
    if (componentHints) {
      const directHint = componentHints[appRootKey];
      if (directHint) {
        pushNote(directHint.en, directHint.ru);
      }
      if (path.length >= 4) {
        const nestedHint = componentHints[path[path.length - 1]];
        if (nestedHint) {
          pushNote(nestedHint.en, nestedHint.ru);
        }
      }
    }
    if (appRootKey === "containers" || appRootKey === "initContainers") {
      pushNote(
        "Changes affect pod template container spec and rollout behavior.",
        "Изменения влияют на container spec pod template и поведение rollout.",
      );
    }
    if (appRootKey === "service") {
      pushNote(
        "This config controls Service resource generated for workload exposure.",
        "Эта конфигурация управляет Service-ресурсом для публикации workload.",
      );
    }
    if (appRootKey === "horizontalPodAutoscaler" || appRootKey === "verticalPodAutoscaler") {
      pushNote(
        "Autoscaler fields impact runtime scaling behavior; validate metrics/source compatibility.",
        "Поля автоскейлера влияют на scaling в рантайме; проверяйте совместимость метрик/источников.",
      );
    }
    if (appRootKey === "podDisruptionBudget") {
      pushNote(
        "Too strict PDB values can block drain/upgrade operations.",
        "Слишком строгие значения PDB могут блокировать drain/upgrade.",
      );
    }
  }

  if (group === "apps-network-policies") {
    pushNote(
      "Policy mistakes can isolate traffic; verify rendered result before rollout.",
      "Ошибки в policy могут изолировать трафик; проверяйте рендер перед раскаткой.",
    );
  } else if (group === "apps-ingresses") {
    pushNote(
      "Ingress behavior depends on controller class and cluster ingress setup.",
      "Поведение Ingress зависит от ingress-контроллера и настроек кластера.",
    );
  } else if (group === "apps-service-accounts") {
    pushNote(
      "RBAC fields define effective permissions; keep least-privilege in mind.",
      "RBAC-поля определяют итоговые права; соблюдайте принцип минимальных привилегий.",
    );
  } else if (group === "apps-k8s-manifests") {
    pushNote(
      "This group is universal fallback; prefer specialized groups when available.",
      "Эта группа является универсальным fallback; при возможности лучше использовать специализированные группы.",
    );
  } else if (group === "apps-kafka-strimzi") {
    pushNote(
      "Strimzi fields are operator-specific; validate against operator version in cluster.",
      "Поля Strimzi зависят от версии оператора; сверяйте с версией оператора в кластере.",
    );
  } else if (group === "apps-infra") {
    pushNote(
      "Infra changes can affect node access and bootstrap flows.",
      "Infra-изменения могут влиять на доступ к нодам и bootstrap-потоки.",
    );
  }

  return {
    ...doc,
    notes: notes.length > 0 ? notes : undefined,
    notesRu: notesRu.length > 0 ? notesRu : undefined,
  };
}

function nonTypicalGroupFieldDoc(path: string[], doc: FieldDoc, guide: GroupAppGuide): FieldDoc | null {
  const group = path[0];
  if (!APP_ENTRY_GROUP_SET.has(group) || path.length < 3) {
    return null;
  }
  if (doc.title === "Custom or Unknown Field") {
    return null;
  }
  if (path[1] === "__GroupVars__") {
    return null;
  }

  const rootKey = path[2];
  const typical = getAllowedAppRootKeysByGroup(group);
  const typicalList = [...typical].sort();
  if (rootKey === "__AppType__") {
    return {
      ...doc,
      notes: [
        ...(doc.notes ?? []),
        "Internal compatibility key; usually managed by library internals.",
      ],
      notesRu: [
        ...(doc.notesRu ?? []),
        "Служебный ключ совместимости; обычно управляется внутренней логикой библиотеки.",
      ],
    };
  }
  if (typical.has(rootKey)) {
    return null;
  }

  const keyPath = path.join(".");
  return {
    title: "Field Is Unusual For This Group",
    titleRu: "Ключ нетипичен для этой группы",
    summary: `\`${rootKey}\` is not part of the standard contract for \`${group}\`.`,
    summaryRu: `\`${rootKey}\` не входит в типовой контракт группы \`${group}\`.`,
    type: doc.type,
    notes: [
      `For this group, expected app keys are: ${formatKeyList(typicalList)}.`,
      "If this is intentional custom payload, verify behavior via render/manifest preview.",
      `Current path: \`${keyPath}\`.`,
    ],
    notesRu: [
      `Для этой группы ожидаемые app-ключи: ${formatKeyList(typicalList)}.`,
      "Если это намеренный custom payload, проверьте эффект через рендер/preview манифестов.",
      `Текущий путь: \`${keyPath}\`.`,
    ],
    example: `${group}:\n  app-1:\n    ${typicalList.find((key) => !BASE_APP_KEYS.includes(key)) ?? "enabled"}: ...\n`,
  };
}

function schemaFieldDoc(path: string[]): FieldDoc | null {
  const root = loadSchemaRoot();
  if (!root) {
    return null;
  }
  const matched = resolveSchemaAtPath(root, path);
  if (!matched) {
    return null;
  }

  const notes: string[] = [];
  const notesRu: string[] = [];
  const schemaType = formatSchemaType(matched);
  if (matched.enum && matched.enum.length > 0) {
    const allowed = `${matched.enum.slice(0, 12).map((v) => `\`${String(v)}\``).join(", ")}${matched.enum.length > 12 ? ", ..." : ""}`;
    notes.push(`Allowed values: ${allowed}`);
    notesRu.push(`Допустимые значения: ${allowed}`);
  }
  if (matched.default !== undefined) {
    const def = `\`${stringifyValue(matched.default)}\``;
    notes.push(`Default: ${def}`);
    notesRu.push(`Значение по умолчанию: ${def}`);
  }

  const childHints = collectKnownChildHints(matched);
  if (childHints.length > 0) {
    notes.push(`Known child keys: ${childHints.join(", ")}`);
    notesRu.push(`Известные дочерние ключи: ${childHints.join(", ")}`);
  }

  const variantTypes = collectVariantTypes(matched);
  if (variantTypes.length > 0) {
    const variants = variantTypes.map((v) => `\`${v}\``).join(", ");
    notes.push(`Schema variants: ${variants}`);
    notesRu.push(`Варианты схемы: ${variants}`);
  }

  const description = matched.description?.trim() ?? "";
  const fallback = contextualSchemaSummary(path);
  return {
    title: `Schema Field: ${path[path.length - 1]}`,
    titleRu: `Поле схемы: ${path[path.length - 1]}`,
    summary: description.length > 0
      ? description
      : fallback.en,
    summaryRu: description.length > 0
      ? description
      : fallback.ru,
    type: schemaType,
    notes: notes.length > 0 ? notes : undefined,
    notesRu: notesRu.length > 0 ? notesRu : undefined,
  };
}

function unknownFieldDoc(path: string[]): FieldDoc | null {
  if (path.length < 3) {
    return null;
  }
  const group = path[0];
  const app = path[1];
  const key = path[path.length - 1];
  const root = loadSchemaRoot();
  const parentPath = path.slice(0, -1);
  const parentSchema = root ? resolveSchemaAtPath(root, parentPath) : null;
  const hints = parentSchema ? collectKnownChildHints(parentSchema) : [];

  const notes = [
    "This key is not yet documented by extension hover catalog.",
    "It can still be fully valid in library/custom renderer.",
    "Check rendered manifest diff to confirm this field affects output.",
  ];
  if (hints.length > 0) {
    notes.push(`Known sibling keys here: ${hints.join(", ")}`);
  }

  return {
    title: "Custom or Unknown Field",
    titleRu: "Кастомное или неизвестное поле",
    summary: `\`${key}\` under \`${group}.${app}\` is treated as custom payload or group-specific field.`,
    summaryRu: `\`${key}\` в \`${group}.${app}\` трактуется как кастомное поле или group-specific параметр.`,
    type: "custom",
    notes,
    notesRu: [
      "Этот ключ пока не каталогизирован в hover-справочнике расширения.",
      "Поле может быть полностью валидным для библиотеки/кастомного рендерера.",
      "Проверяйте итоговый рендер/дифф манифестов для подтверждения эффекта.",
      ...(hints.length > 0 ? [`Известные соседние ключи: ${hints.join(", ")}`] : []),
    ],
  };
}

function loadSchemaRoot(): JsonSchema | null {
  if (schemaRootCache) {
    return schemaRootCache;
  }
  try {
    const candidates = [
      path.resolve(__dirname, "../../schemas/values.schema.json"),
      path.resolve(__dirname, "../../../schemas/values.schema.json"),
    ];
    for (const schemaPath of candidates) {
      try {
        const raw = readFileSync(schemaPath, "utf8");
        schemaRootCache = JSON.parse(raw) as JsonSchema;
        return schemaRootCache;
      } catch {
        // try next candidate
      }
    }
    return null;
  } catch {
    return null;
  }
}

function resolveSchemaAtPath(root: JsonSchema, pathParts: string[]): JsonSchema | null {
  return walkSchema(root, pathParts, 0, root);
}

function walkSchema(current: JsonSchema, pathParts: string[], index: number, root: JsonSchema): JsonSchema | null {
  const schema = resolveRefs(current, root);
  if (!schema) {
    return null;
  }
  if (index >= pathParts.length) {
    return schema;
  }

  const seg = pathParts[index];
  const candidates = nextSchemasForSegment(schema, seg, root);
  for (const candidate of candidates) {
    const resolved = walkSchema(candidate, pathParts, index + 1, root);
    if (resolved) {
      return resolved;
    }
  }
  return null;
}

function nextSchemasForSegment(schema: JsonSchema, segment: string, root: JsonSchema): JsonSchema[] {
  const out: JsonSchema[] = [];
  for (const variant of schemaVariants(schema, root)) {
    if (variant.properties && variant.properties[segment]) {
      out.push(variant.properties[segment]);
    }
    if (variant.patternProperties) {
      for (const [pattern, child] of Object.entries(variant.patternProperties)) {
        try {
          const re = new RegExp(pattern);
          if (re.test(segment)) {
            out.push(child);
          }
        } catch {
          // ignore broken schema regex
        }
      }
    }
    if (variant.additionalProperties && typeof variant.additionalProperties === "object") {
      out.push(variant.additionalProperties);
    }
  }
  return out;
}

function schemaVariants(schema: JsonSchema, root: JsonSchema): JsonSchema[] {
  const base = resolveRefs(schema, root);
  if (!base) {
    return [];
  }
  const out: JsonSchema[] = [base];
  for (const arr of [base.allOf, base.anyOf, base.oneOf]) {
    if (!arr) {
      continue;
    }
    for (const item of arr) {
      const resolved = resolveRefs(item, root);
      if (resolved) {
        out.push(resolved);
      }
    }
  }
  return out;
}

function resolveRefs(schema: JsonSchema | undefined, root: JsonSchema): JsonSchema | null {
  if (!schema) {
    return null;
  }
  let current: JsonSchema | undefined = schema;
  const seen = new Set<string>();
  while (current && current.$ref) {
    const ref = current.$ref;
    if (!ref.startsWith("#/") || seen.has(ref)) {
      break;
    }
    seen.add(ref);
    current = getByPointer(root, ref);
  }
  return current ?? null;
}

function getByPointer(root: JsonSchema, ptr: string): JsonSchema | undefined {
  const chunks = ptr.slice(2).split("/").map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
  let cur: unknown = root;
  for (const c of chunks) {
    if (!cur || typeof cur !== "object" || !(c in (cur as Record<string, unknown>))) {
      return undefined;
    }
    cur = (cur as Record<string, unknown>)[c];
  }
  return cur as JsonSchema;
}

function collectKnownChildHints(schema: JsonSchema): string[] {
  const out = new Set<string>();
  if (schema.properties) {
    for (const key of Object.keys(schema.properties)) {
      out.add(`\`${key}\``);
    }
  }
  if (schema.patternProperties) {
    for (const key of Object.keys(schema.patternProperties)) {
      out.add(`pattern:${key}`);
    }
  }
  return [...out].slice(0, 14);
}

function formatSchemaType(schema: JsonSchema): string {
  if (Array.isArray(schema.type)) {
    return schema.type.join(" | ");
  }
  if (typeof schema.type === "string") {
    return schema.type;
  }
  if (schema.oneOf || schema.anyOf) {
    const variants = collectVariantTypes(schema);
    return variants.length > 0 ? `oneOf(${variants.join(" | ")})` : "oneOf";
  }
  if (schema.allOf) {
    const variants = collectVariantTypes(schema);
    return variants.length > 0 ? `allOf(${variants.join(" & ")})` : "allOf";
  }
  if (schema.properties || schema.patternProperties) {
    return "object";
  }
  return "unknown";
}

function collectVariantTypes(schema: JsonSchema): string[] {
  const out = new Set<string>();
  for (const arr of [schema.oneOf, schema.anyOf, schema.allOf]) {
    if (!arr) {
      continue;
    }
    for (const item of arr) {
      if (typeof item.type === "string") {
        out.add(item.type);
      } else if (Array.isArray(item.type)) {
        for (const t of item.type) {
          out.add(t);
        }
      } else if (item.properties || item.patternProperties || item.additionalProperties) {
        out.add("object");
      }
    }
  }
  return [...out];
}

function contextualSchemaSummary(path: string[]): { en: string; ru: string } {
  const key = path[path.length - 1] ?? "";
  const parent = path.length >= 2 ? path[path.length - 2] : "";
  const scope = detectScope(path);
  if (isNamedEntry(key, parent)) {
    return {
      en: `Named entry \`${key}\` in \`${parent}\` (${scope.en}). Usually this is a user-defined map item key.`,
      ru: `Именованный элемент \`${key}\` в \`${parent}\` (${scope.ru}). Обычно это пользовательский ключ элемента map.`,
    };
  }
  if (parent === "containers" || parent === "initContainers") {
    return {
      en: `Container-level field at ${scope.en}.`,
      ru: `Поле контейнерного уровня на уровне ${scope.ru}.`,
    };
  }
  if (key === "initContainers" || parent === "initContainers") {
    return {
      en: `Init-container settings at ${scope.en}.`,
      ru: `Настройки init-container на уровне ${scope.ru}.`,
    };
  }
  return {
    en: `Schema-defined field at ${scope.en}.`,
    ru: `Поле, определенное схемой, на уровне ${scope.ru}.`,
  };
}

function detectScope(path: string[]): { en: string; ru: string } {
  if (path[0] === "global") {
    return { en: "global scope", ru: "global" };
  }
  if (path.length >= 2 && path[1] === "__GroupVars__") {
    return { en: "group vars scope", ru: "group vars" };
  }
  if (path.length >= 2) {
    return { en: `app scope \`${path[0]}.${path[1]}\``, ru: `приложения \`${path[0]}.${path[1]}\`` };
  }
  return { en: "top-level scope", ru: "верхнего уровня" };
}

function isNamedEntry(key: string, parent: string): boolean {
  if (key === "__GroupVars__" || parent.length === 0) {
    return false;
  }
  if (!/^[a-z0-9_.-]+$/i.test(key)) {
    return false;
  }
  return /-\d+$/.test(key) || /\d$/.test(key) || key.includes("-");
}

function stringifyValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function resolveEffectiveGroupTypeFromText(text: string, groupName: string, envHint?: string): string | null {
  try {
    const parsed = YAML.parse(text) as unknown;
    if (!isMap(parsed)) {
      return null;
    }
    const group = toMap(parsed[groupName]);
    if (!group) {
      return null;
    }
    const groupVars = toMap(group.__GroupVars__);
    if (!groupVars) {
      return null;
    }
    const rawType = groupVars.type;
    if (typeof rawType === "string" && rawType.trim().length > 0) {
      return rawType.trim();
    }
    const asMap = toMap(rawType);
    if (!asMap) {
      return null;
    }
    const global = toMap(parsed.global);
    const globalEnv = typeof global?.env === "string" && global.env.trim().length > 0
      ? global.env.trim()
      : "";
    const env = (envHint && envHint.trim().length > 0 ? envHint.trim() : globalEnv) || "dev";
    const resolved = resolveEnvMapValue(asMap, env);
    if (typeof resolved === "string" && resolved.trim().length > 0) {
      return resolved.trim();
    }
    return null;
  } catch {
    return null;
  }
}

function resolveEnvMapValue(value: Record<string, unknown>, env: string): unknown {
  if (Object.prototype.hasOwnProperty.call(value, env)) {
    return value[env];
  }
  for (const [key, candidate] of Object.entries(value)) {
    if (key === "_default" || !looksLikeRegexPattern(key)) {
      continue;
    }
    try {
      if (new RegExp(key).test(env)) {
        return candidate;
      }
    } catch {
      // ignore invalid regex-like env keys
    }
  }
  if (Object.prototype.hasOwnProperty.call(value, "_default")) {
    return value._default;
  }
  return value;
}

function looksLikeRegexPattern(key: string): boolean {
  if (!key || key === "_default") {
    return false;
  }
  if (key.startsWith("^") || key.endsWith("$")) {
    return true;
  }
  if (key.includes(".*") || key.includes(".+") || key.includes(".?")) {
    return true;
  }
  return /[\[\]()|\\]/.test(key);
}

function isMap(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toMap(value: unknown): Record<string, unknown> | null {
  return isMap(value) ? value : null;
}

function isRussianLocale(locale: string): boolean {
  return locale.toLowerCase().startsWith("ru");
}

function resolveDocsLink(doc: FieldDoc, ru: boolean): string {
  if (ru && doc.docsLinkRu) {
    return doc.docsLinkRu;
  }
  if (!ru && doc.docsLinkEn) {
    return doc.docsLinkEn;
  }
  return doc.docsLink ?? doc.docsLinkEn ?? doc.docsLinkRu ?? "";
}

function toOnlineDocsLink(link: string): string {
  if (link.startsWith("http://") || link.startsWith("https://")) {
    return link;
  }
  const normalized = link.startsWith("/") ? link.slice(1) : link;
  return `${DOCS_ONLINE_BASE}${normalized}`;
}

function formatKeyList(keys: string[]): string {
  return keys.map((k) => `\`${k}\``).join(", ");
}

function countIndent(line: string): number {
  let n = 0;
  while (n < line.length && line[n] === " ") {
    n += 1;
  }
  return n;
}
