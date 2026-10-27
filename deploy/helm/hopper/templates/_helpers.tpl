{{/* The release's name, or <release>-hopper when the release name does not say hopper. */}}
{{- define "hopper.fullname" -}}
{{- if contains .Chart.Name .Release.Name -}}
{{- .Release.Name | trunc 50 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 50 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{/* The labels every object carries; `component` names the part. */}}
{{- define "hopper.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .ctx.Chart.Name .ctx.Chart.Version }}
app.kubernetes.io/managed-by: {{ .ctx.Release.Service }}
{{ include "hopper.selector" . }}
{{- end -}}

{{- define "hopper.selector" -}}
app.kubernetes.io/name: {{ .ctx.Chart.Name }}
app.kubernetes.io/instance: {{ .ctx.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{/* The generated runtime Secret: the database password, URL and the preshared keys of OpenFGA and the vault pod. */}}
{{- define "hopper.runtimeSecret" -}}
{{- printf "%s-runtime" (include "hopper.fullname" .) -}}
{{- end -}}

{{/* Every container: no privilege to gain, no capability. */}}
{{- define "hopper.containerSecurity" -}}
securityContext:
  allowPrivilegeEscalation: false
  capabilities:
    drop: [ALL]
  seccompProfile:
    type: RuntimeDefault
{{- end -}}

{{- define "hopper.storageClass" -}}
{{- if . }}
storageClassName: {{ . | quote }}
{{- end }}
{{- end -}}

{{/* The master key Secret: the one given, else <release>-master-key. */}}
{{- define "hopper.masterKeySecret" -}}
{{- .Values.masterKey.existingSecret | default (printf "%s-master-key" (include "hopper.fullname" .)) -}}
{{- end -}}

{{/* Whether the chart makes the hopper's service account: asked, or the sandbox Role needs one and none is named. */}}
{{- define "hopper.makesServiceAccount" -}}
{{- if or .Values.serviceAccount.create (and .Values.sandbox.enabled (not .Values.serviceAccount.name)) }}true{{ end -}}
{{- end -}}

{{/* The hopper's service account, or nothing: the namespace's default. */}}
{{- define "hopper.serviceAccount" -}}
{{- if include "hopper.makesServiceAccount" . -}}
{{- .Values.serviceAccount.name | default (include "hopper.fullname" .) -}}
{{- else -}}
{{- .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{/*
The lane pool key's Secret (issue #1284): the hopper and the lane pods' join step read its `key`. lanes.existingSecret
(issue #1454): one the chart did not make, as a runner-only release's, with the key the hopper issued.
*/}}
{{- define "hopper.lanePoolSecret" -}}
{{- .Values.lanes.existingSecret | default (printf "%s-lane-pool" (include "hopper.fullname" .)) -}}
{{- end -}}

{{/* The URL the lane pods join and dial in at: lanes.hopperUrl (issue #1454), else the release's own hopper's Service. */}}
{{- define "hopper.lanesHopperUrl" -}}
{{- if .Values.lanes.hopperUrl -}}
{{- if not (regexMatch "^https?://[^/#?]+/?$" .Values.lanes.hopperUrl) }}{{ fail "lanes.hopperUrl is the hopper's URL alone, http:// or https://, a host and a port: no path" }}{{ end -}}
{{- .Values.lanes.hopperUrl | trimSuffix "/" -}}
{{- else if .Values.hopper.enabled -}}
{{- printf "http://%s:%d" (include "hopper.fullname" .) (.Values.port | int) -}}
{{- else -}}
{{- fail "hopper.enabled=false (a runner-only release) needs lanes.hopperUrl: the URL of the hopper the lane pods join" -}}
{{- end -}}
{{- end -}}

{{/*
A container's own limits through the Downward API (issue #1289): its resources in the hopper are these, millicores and
bytes. With no limit set, Kubernetes gives the node's allocatable.
*/}}
{{- define "hopper.podLimits" -}}
- name: HOPPER_POD_CPU_LIMIT
  valueFrom:
    resourceFieldRef:
      containerName: {{ . }}
      resource: limits.cpu
      divisor: 1m
- name: HOPPER_POD_MEMORY_LIMIT
  valueFrom:
    resourceFieldRef:
      containerName: {{ . }}
      resource: limits.memory
      divisor: "1"
{{- end -}}

{{/* The Secret with `database_url` and `openfga_datastore_uri`: the runtime Secret, or the external one (issue #1282). */}}
{{- define "hopper.databaseSecret" -}}
{{- if .Values.postgres.bundled -}}
{{- include "hopper.runtimeSecret" . -}}
{{- else -}}
{{- required "postgres.external.existingSecret: the Secret with database_url and openfga_datastore_uri, for postgres.bundled=false" .Values.postgres.external.existingSecret -}}
{{- end -}}
{{- end -}}

{{/*
The master key, for each pod that seals or opens with it: the hopper, and the vault pod. From the mounted Secret's files
(the chart's own, one given, or one an ExternalSecret fills): a start without its file is refused.
*/}}
{{- define "hopper.masterKeyEnv" -}}
- name: HOPPER_MASTER_KEY_FILE
  value: /run/hopper-master-key/master-key
- name: HOPPER_MASTER_KEY_PREVIOUS_FILE
  value: /run/hopper-master-key/previous
{{- end -}}

{{/* The master key Secret's volume. */}}
{{- define "hopper.masterKeyVolume" -}}
# Optional: with no Secret the pod starts and refuses, saying the key file is missing.
- name: master-key
  secret:
    secretName: {{ include "hopper.masterKeySecret" . }}
    defaultMode: 0440
    optional: true
{{- end -}}

{{/*
The KMS that wraps the vault's data key, for the pod the vault runs in (the hopper, or the vault pod): AWS KMS, or the
local KMS. Neither: the vault seals under the master key.
*/}}
{{- define "hopper.kmsEnv" -}}
{{- if and .Values.kms.local.enabled .Values.kms.aws.region -}}
{{- fail "kms.local.enabled and kms.aws.region: one KMS wraps the vault's data key; set one" -}}
{{- end -}}
{{- with .Values.kms.aws -}}
{{- if .region -}}
- name: HOPPER_KMS_REGION
  value: {{ .region | quote }}
- name: HOPPER_KMS_KEY
  value: {{ required "kms.aws.key: the AWS KMS key that wraps the vault's data key (the hopper never makes one in AWS)" .key | quote }}
{{- if .endpoint }}
- name: HOPPER_KMS_URL
  value: {{ .endpoint | quote }}
{{- end -}}
{{- end -}}
{{- end -}}
{{- if .Values.kms.local.enabled -}}
# The local KMS (issue #586): it makes its key alias/hopper-vault at the vault's first ask.
- name: HOPPER_KMS_URL
  value: {{ printf "http://%s-kms:8080" (include "hopper.fullname" .) | quote }}
{{- end -}}
{{- end -}}

{{/* Who runs the vault, and so asks the KMS: the vault pod, else the hopper. */}}
{{- define "hopper.vaultRunner" -}}
{{- if .Values.hopperVault.enabled }}vault{{ else }}hopper{{ end -}}
{{- end -}}

{{/*
A confined lane pod's egress (issue #2849 part 6, docs/design.md "Contained machines"): DNS, and the hopper alone — its own
pod on its port, or, in a runner-only release, the addresses lanes.egress.hopperCidrs names on lanes.hopperUrl's port. So
the job egress allowlist, through the hopper, is the one way out of the jobs on it.
*/}}
{{- define "hopper.lanesEgress" -}}
{{- $cidrs := .Values.lanes.egress.hopperCidrs | default list -}}
{{- if and (not .Values.hopper.enabled) (not $cidrs) }}{{ fail "lanes.egress.confine in a runner-only release needs lanes.egress.hopperCidrs: the addresses of the hopper the lane pods join, as CIDRs" }}{{ end -}}
{{- $port := .Values.port | int -}}
{{- if not .Values.hopper.enabled -}}
{{- $u := urlParse (include "hopper.lanesHopperUrl" .) -}}
{{- $hp := splitList ":" $u.host -}}
{{- $port = ternary (last $hp | int) (ternary 443 80 (eq $u.scheme "https")) (gt (len $hp) 1) -}}
{{- end -}}
egress:
  - to:
      - namespaceSelector: {}
        podSelector:
          matchLabels:
            {{- toYaml .Values.lanes.egress.dnsSelector | nindent 12 }}
    ports:
      - port: 53
        protocol: UDP
      - port: 53
        protocol: TCP
  - to:
      {{- if .Values.hopper.enabled }}
      - podSelector:
          matchLabels:
            {{- include "hopper.selector" (dict "ctx" . "component" "hopper") | nindent 12 }}
      {{- end }}
      {{- range $cidrs }}
      - ipBlock:
          cidr: {{ . | quote }}
      {{- end }}
    ports:
      - port: {{ $port }}
        protocol: TCP
{{- end -}}
