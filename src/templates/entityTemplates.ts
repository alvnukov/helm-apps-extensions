export type EntityTemplateGroupType =
  | "apps-stateless"
  | "apps-stateful"
  | "apps-jobs"
  | "apps-cronjobs"
  | "apps-services"
  | "apps-ingresses"
  | "apps-network-policies"
  | "apps-configmaps"
  | "apps-secrets"
  | "apps-pvcs"
  | "apps-service-accounts"
  | "apps-k8s-manifests";

function withAppRoot(appName: string, bodyLines: string[]): string[] {
  return [`  ${appName}:`, ...bodyLines];
}

export function renderEntityTemplateLines(groupType: string, appName: string): string[] {
  switch (groupType as EntityTemplateGroupType) {
    case "apps-stateless":
      return withAppRoot(appName, [
        "    enabled: true",
        "    # HTTP stateless app template: service + probes + autoscaling hooks",
        "    _include: [\"apps-stateless-defaultApp\"]",
        "    containers:",
        `      ${appName}:`,
        "        image:",
        "          name: ghcr.io/acme/platform-api",
        "          staticTag: \"1.0.0\"",
        "        envVars:",
        "          APP_ENV: \"{{ $.Values.global.env }}\"",
        "          LOG_LEVEL:",
        "            _default: info",
        "            prod: warn",
        "          HTTP_PORT: \"8080\"",
        "        resources:",
        "          requests:",
        "            mcpu: 100",
        "            memoryMb: 256",
        "          limits:",
        "            mcpu: 500",
        "            memoryMb: 512",
        "        ports: |-",
        "          - name: http",
        "            containerPort: 8080",
        "        readinessProbe: |-",
        "          httpGet:",
        "            path: /ready",
        "            port: 8080",
        "          initialDelaySeconds: 5",
        "          periodSeconds: 10",
        "        livenessProbe: |-",
        "          httpGet:",
        "            path: /health",
        "            port: 8080",
        "          initialDelaySeconds: 15",
        "          periodSeconds: 15",
        "    initContainers:",
        "      wait-db:",
        "        image:",
        "          name: busybox",
        "          staticTag: \"1.36\"",
        "        command: |-",
        "          - sh",
        "        args: |-",
        "          - -c",
        "          - until nc -z postgres 5432; do echo waiting for db; sleep 2; done",
        "    service:",
        "      enabled: true",
        "      type: ClusterIP",
        "      ports: |-",
        "        - name: http",
        "          port: 80",
        "          targetPort: 8080",
        "    serviceAccount:",
        "      name: app-runtime",
        "    podDisruptionBudget:",
        "      enabled: true",
        "      minAvailable: 1",
        "    horizontalPodAutoscaler:",
        "      enabled: false",
        "      minReplicas: 2",
        "      maxReplicas: 8",
        "    verticalPodAutoscaler:",
        "      enabled: false",
      ]);

    case "apps-stateful":
      return withAppRoot(appName, [
        "    enabled: true",
        "    # Stateful workload template: stable identity + persistent data",
        "    _include: [\"apps-stateful-defaultApp\"]",
        "    containers:",
        `      ${appName}:`,
        "        image:",
        "          name: ghcr.io/acme/platform-stateful",
        "          staticTag: \"1.0.0\"",
        "        envVars:",
        "          APP_ENV: \"{{ $.Values.global.env }}\"",
        "          DATA_DIR: /var/lib/app",
        "        resources:",
        "          requests:",
        "            mcpu: 300",
        "            memoryMb: 512",
        "          limits:",
        "            mcpu: 1500",
        "            memoryMb: 2048",
        "        ports: |-",
        "          - name: http",
        "            containerPort: 8080",
        "        volumeMounts: |-",
        "          - name: data",
        "            mountPath: /var/lib/app",
        "    initContainers:",
        "      init-permissions:",
        "        image:",
        "          name: busybox",
        "          staticTag: \"1.36\"",
        "        command: |-",
        "          - sh",
        "        args: |-",
        "          - -c",
        "          - chown -R 1000:1000 /var/lib/app",
        "        volumeMounts: |-",
        "          - name: data",
        "            mountPath: /var/lib/app",
        "    volumes: |-",
        "      - name: data",
        "        persistentVolumeClaim:",
        "          claimName: app-data",
        "    service:",
        "      enabled: true",
        "      headless: true",
        "      ports: |-",
        "        - name: http",
        "          port: 80",
        "          targetPort: 8080",
        "    serviceAccount:",
        "      name: app-stateful",
        "    verticalPodAutoscaler:",
        "      enabled: false",
      ]);

    case "apps-jobs":
      return withAppRoot(appName, [
        "    enabled: true",
        "    # One-shot batch/migration template",
        "    _include: [\"apps-jobs-defaultJob\"]",
        "    restartPolicy: OnFailure",
        "    backoffLimit: 3",
        "    activeDeadlineSeconds: 1800",
        "    serviceAccount:",
        "      name: jobs-runner",
        "    initContainers:",
        "      wait-db:",
        "        image:",
        "          name: busybox",
        "          staticTag: \"1.36\"",
        "        command: |-",
        "          - sh",
        "        args: |-",
        "          - -c",
        "          - until nc -z postgres 5432; do echo waiting for db; sleep 2; done",
        "    containers:",
        `      ${appName}:`,
        "        image:",
        "          name: ghcr.io/acme/db-migrate",
        "          staticTag: \"1.0.0\"",
        "        command: |-",
        "          - sh",
        "        args: |-",
        "          - -c",
        "          - ./scripts/migrate.sh",
        "        envVars:",
        "          APP_ENV: \"{{ $.Values.global.env }}\"",
        "        resources:",
        "          requests:",
        "            mcpu: 100",
        "            memoryMb: 256",
        "          limits:",
        "            mcpu: 500",
        "            memoryMb: 512",
      ]);

    case "apps-cronjobs":
      return withAppRoot(appName, [
        "    enabled: true",
        "    # Periodic maintenance/report template",
        "    schedule: \"*/15 * * * *\"",
        "    concurrencyPolicy: Forbid",
        "    startingDeadlineSeconds: 180",
        "    successfulJobsHistoryLimit: 3",
        "    failedJobsHistoryLimit: 1",
        "    serviceAccount:",
        "      name: cron-runner",
        "    containers:",
        `      ${appName}:`,
        "        image:",
        "          name: ghcr.io/acme/cron-task",
        "          staticTag: \"1.0.0\"",
        "        command: |-",
        "          - sh",
        "        args: |-",
        "          - -c",
        "          - ./scripts/run-cron.sh",
        "        envVars:",
        "          APP_ENV: \"{{ $.Values.global.env }}\"",
        "        resources:",
        "          requests:",
        "            mcpu: 50",
        "            memoryMb: 128",
        "          limits:",
        "            mcpu: 300",
        "            memoryMb: 512",
      ]);

    case "apps-services":
      return withAppRoot(appName, [
        "    enabled: true",
        "    # Standalone Service template for exposing existing pods",
        "    type: ClusterIP",
        "    selector: |-",
        "      app.kubernetes.io/name: app-1",
        "    ports: |-",
        "      - name: http",
        "        port: 80",
        "        targetPort: 8080",
      ]);

    case "apps-ingresses":
      return withAppRoot(appName, [
        "    enabled: true",
        "    # Public entrypoint template",
        "    ingressClassName: nginx",
        "    host: app.example.local",
        "    hosts: |-",
        "      - app.example.local",
        "    paths: |-",
        "      - path: /",
        "        pathType: Prefix",
        "    tls:",
        "      enabled: true",
        "      secret_name: app-example-local-tls",
        "    dexAuth:",
        "      enabled: false",
      ]);

    case "apps-network-policies":
      return withAppRoot(appName, [
        "    enabled: true",
        "    # Network access policy template (start from deny + allow-list)",
        "    type: kubernetes",
        "    podSelector: |-",
        "      matchLabels:",
        "        app.kubernetes.io/name: app-1",
        "    policyTypes: |-",
        "      - Ingress",
        "      - Egress",
        "    ingress: |-",
        "      - from:",
        "          - namespaceSelector:",
        "              matchLabels:",
        "                kubernetes.io/metadata.name: ingress-nginx",
        "          - podSelector:",
        "              matchLabels:",
        "                app.kubernetes.io/name: api-gateway",
        "    egress: |-",
        "      - to:",
        "          - namespaceSelector:",
        "              matchLabels:",
        "                kubernetes.io/metadata.name: kube-system",
        "        ports:",
        "          - protocol: UDP",
        "            port: 53",
      ]);

    case "apps-configmaps":
      return withAppRoot(appName, [
        "    enabled: true",
        "    # Non-sensitive runtime config",
        "    data:",
        "      APP_MODE: \"service\"",
        "      LOG_LEVEL: \"info\"",
        "      FEATURE_FLAG_X: \"false\"",
        "    binaryData:",
        "      logo.png: \"<base64-content>\"",
        "    envVars:",
        "      APP_MODE: service",
        "      LOG_LEVEL:",
        "        _default: info",
        "        prod: warn",
      ]);

    case "apps-secrets":
      return withAppRoot(appName, [
        "    enabled: true",
        "    # Sensitive data (prefer external secret manager in production)",
        "    type: Opaque",
        "    data:",
        "      DB_USER: app",
        "      DB_PASSWORD: \"change-me\"",
        "    binaryData:",
        "      ca.crt: \"<base64-cert>\"",
        "    envVars:",
        "      DB_USER: app",
      ]);

    case "apps-pvcs":
      return withAppRoot(appName, [
        "    enabled: true",
        "    # Persistent disk claim template",
        "    storageClassName: gp3",
        "    accessModes: |-",
        "      - ReadWriteOnce",
        "    resources: |-",
        "      requests:",
        "        storage: 10Gi",
      ]);

    case "apps-service-accounts":
      return withAppRoot(appName, [
        "    enabled: true",
        "    # RBAC template with namespaced and cluster-scoped permissions",
        "    name: app-runtime",
        "    roles:",
        "      pod-reader:",
        "        rules: |-",
        "          - apiGroups: [\"\"]",
        "            resources: [\"pods\"]",
        "            verbs: [\"get\", \"list\", \"watch\"]",
        "    clusterRoles:",
        "      metrics-reader:",
        "        rules: |-",
        "          - apiGroups: [\"metrics.k8s.io\"]",
        "            resources: [\"pods\"]",
        "            verbs: [\"get\", \"list\"]",
      ]);

    case "apps-k8s-manifests":
      return withAppRoot(appName, [
        "    enabled: true",
        "    # Generic Kubernetes manifest fallback template",
        "    apiVersion: v1",
        "    kind: ConfigMap",
        "    fieldsYAML:",
        "      metadata: |-",
        "        labels:",
        "          app.kubernetes.io/name: app-1",
        "      data: |-",
        "        FEATURE_X: \"true\"",
        "    extraFields:",
        "      immutable: false",
      ]);
  }

  return withAppRoot(appName, [
    "    enabled: true",
  ]);
}
