---
name: gitops-deploy
description: How a hopper job changes a GitOps repository, where a merge to a production overlay is a deploy.
---

# GitOps

Use this skill beside the work skill when the job changes a GitOps repository: Kubernetes manifests, Kustomize overlays,
Helm values or the like, that a controller applies when they merge.
A skill rule gives it to a job, for example by its repository or a label such as `gitops`.

## Rules

- A change to a production overlay is a deploy on merge. A merge is a release to production.
- Never merge the pull request yourself. Never apply a manifest to a cluster yourself.
- Run infrastructure tools only in a sandbox that the hopper starts for the job. With no sandbox, read and edit the files only.
- Change the lower environments first when the issue does not say otherwise: a change to production follows a change to
  staging that works.

## The pull request body

When the change touches a production overlay, start the pull request body with a line `Deploys on merge:`, then list each
production overlay that the change touches, and what it changes there. A person reads this line before they merge.

## Who merges

The hopper does not merge a pull request that changes a production overlay, also when yolo mode is on (`done.json`:
`person-merges`). A person merges it. A change only to other overlays merges as the repository's merge rules say.

The job is done when its pull request is ready for review, as the job rules say. Do not wait for the merge.
