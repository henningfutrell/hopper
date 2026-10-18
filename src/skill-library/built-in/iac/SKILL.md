---
name: iac
description: How a hopper job changes infrastructure as code, so that every plan is green and destroys nothing before it ends done.
---

# Infrastructure as code

Use this skill beside the work skill when the job changes infrastructure code: Terraform, OpenTofu or the like.
A skill rule gives it to a job, for example by its repository or a label such as `iac`.

## Rules

- Never apply. An apply runs only in CI, behind the environment's approval.
- Run infrastructure tools only in a sandbox that the hopper starts for the job. With no sandbox, read and edit the code only.
- Never add the MAP tag to a resource that exists already.

## After each push

1. Wait for the pull request's plan checks: `sh "$HOPPER_GH" pr wait <number> --repo <owner/name>`.
2. Read the plan summary of each root: the output of each plan check, and the plan comment on the pull request.
3. Look at the plan's own line, `Plan: N to add, N to change, N to destroy.`, for each root.

## When is the job done

The job is done only when all of these are true:

- Every plan check is green, and the verdict is green.
- No plan destroys or replaces a resource: each plan shows `0 to destroy`. A replace counts as a destroy.
  When the issue asks for a delete, list each resource address in the pull request body. The hopper's check still
  counts it, so the job ends failed with the reason, and a person decides.

The hopper checks these itself before it takes the job as done (`done.json`). A job that ends done with a red plan or a
delete is sent back to fix it, else it ends failed with the reason.

## When a plan replaces a resource

1. Find the attribute that forces the replace: the plan marks it `# forces replacement`.
2. Keep the existing value of that attribute in the code, or narrow `lifecycle { ignore_changes = [...] }` to that attribute.
3. Push, and read the plans again.
