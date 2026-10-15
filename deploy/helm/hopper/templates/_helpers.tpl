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

{{/* The generated runtime Secret: the database password, URL and OpenFGA's preshared key. */}}
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

{{/* Whether the master key is read from a mounted Secret file (a Secret given, or an ExternalSecret), not variables. */}}
{{- define "hopper.masterKeyFromFile" -}}
{{- if or .Values.masterKey.existingSecret .Values.masterKey.externalSecret.enabled }}true{{ end -}}
{{- end -}}

{{/* The hopper's service account, or nothing: the namespace's default. */}}
{{- define "hopper.serviceAccount" -}}
{{- if .Values.serviceAccount.create -}}
{{- .Values.serviceAccount.name | default (include "hopper.fullname" .) -}}
{{- else -}}
{{- .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}
