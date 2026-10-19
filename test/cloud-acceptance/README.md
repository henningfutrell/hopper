# Cloud acceptance tests (issue #1956)

The vault's read-only and minted-scope rules, checked against an API that evaluates the session policy, not only
against shell stubs (`test/support/fake-cloud-tools.ts`) or a loopback STS (`test/support/fake-mint-apis.ts`).

## What runs

- **moto** (`docker.io/motoserver/moto`, a testcontainers container): STS, IAM, S3, EC2, KMS, SQS, and the EKS, ELB and
  RDS lists topology discovery reads. Seeded per test (`support/moto.ts`): a read role, a write role and discovery's
  read role `hopper-read`, each with full access of its own; an S3 bucket with a terraform
  state of the seeded resources; an EC2 instance; a KMS key; an SQS queue.
- **The policy-assert proxy** (`test/support/policy-assert-proxy.ts`) in front of moto, on loopback. moto enforces no
  policy, so the proxy re-checks every SigV4 call against the session that signed it: it learns each session from the
  AssumeRole that minted it, applies the inline deny policy first and then `ReadOnlyAccess` (IAM's Read and List
  actions, `@cloud-copilot/iam-data`), fails closed on a call it cannot name, and logs each allow and deny.
- **The hopper** from the checkout: the real composition root (`test/support/app.ts`), its vault minting through the
  real STS adapter to the proxy. A joined client's vault helper hands the job its session, as on a box
  (`support/hopper.ts`). Topology discovery reads the account with the real AWS SDK reader.
- **The real `aws` CLI and curl** (`docker.io/amazon/aws-cli`, `support/aws-cli.ts`), on the host's network, and the
  AWS SDK in the test.
- **A read-only box image** (`support/box.ts`), made as the hopper makes it for a template that reads a terraform
  workspace: `boxImage` (`src/sandbox/box-image.ts`) through the real container runtime, the published box image
  (`ghcr.io/henningfutrell/hopper:box-claude`) with terraform and the aws CLI added, terraform behind the read-only
  wrapper, its providers from the image's mirror. The build fetches the tools' own releases, so it needs the network.
  The box runs on the host's network with the read session's keys in its environment.
- **A write box image** (`support/box.ts`), made the same way for a template that applies on a terraform workspace:
  terraform behind the apply wrapper, which applies only the saved file of a plan the hopper recorded. Its providers come
  from the registry, so `terraform init` in it needs the network. GitHub is faked on loopback for the plan's branch head.
- **The egress of a read-only box** (`support/egress.ts`), as compose gives it beside the hopper: an internal network with
  no route out; the egress proxy, the compose service `egress` itself (its script read from `compose.yaml`, run in the
  hopper's image, which carries tinyproxy) on that network and on a routed one; and a second moto on the routed network
  only, the host the box's credential names. A need box of the read-only image runs through the hopper's sandbox module
  (`createSandboxes`, the real sandbox flags) and the real `createEgress`, which writes the allowlist the proxy loads.
- **A read-only need box with a minted session** (`need-box-read-only.test.ts`): the need box of the egress tests, with
  the read session the vault minted. Its credential names the policy-assert proxy as its endpoint, so the egress proxy
  allows that host and the box reaches moto only through both proxies. The policy-assert proxy listens on every
  interface for this test, and the egress proxy reaches it by a name the runtime resolves to this machine
  (`--add-host <name>:host-gateway`). The box image has no AWS SDK, so the SDK script (`support/box-sdk.ts`) is bundled
  with the SDK into one file (vite) and goes into the box as the step's input.
- **Need steps that apply** (`need-box-write-path.test.ts`): a crash harness hopper (below), not killed, runs the job's
  need steps on the real container runtime, in need boxes of the write box image under the sandbox flags. A read step
  plans and brings the saved plan file back as an output; an apply step names the recorded plan (`planId`), and the
  hopper puts the plan's saved file in the box (`HOPPER_PLAN_FILE`): the box holds no proxy token. GitHub is faked for
  the plan's branch head.
- **Hoppers killed mid-step** (`saga-resume.test.ts`): the crash harness's hoppers (`test/crash/harness.ts`), the real
  composition root in processes of their own over one database, each ended with SIGKILL at a kill point of the
  `need-step` saga or while its need box runs. Their need boxes start on the same container runtime (Podman's or Docker's
  socket, as `HOPPER_TEST_CONTAINER_CLI` names it), from the image the hopper makes for the template (the write box
  image's tools), on the host's network, so the box's aws CLI reaches the proxy with the session the vault minted for the step.
- **A Kubernetes cluster** (`support/kind.ts`, `kubectl.test.ts`): a kind cluster made for the run (`kind create cluster`,
  on the container runtime `HOPPER_TEST_CONTAINER_CLI` names), or the cluster whose admin kubeconfig
  `HOPPER_TEST_KUBECONFIG` names (it is not deleted). Seeded with `hopper-read` in the namespace `hopper`, bound to the
  cluster's own `view` role, and `hopper-minter`, which may only make tokens and the Secrets they are bound to there:
  the minting credential `KUBE_LAB` (type `token`) holds a token of it. The namespace `app` holds a pod, a ConfigMap and
  a Secret. A crash harness hopper runs a need step of a template that reads the cluster: its need box (the box image
  with kubectl) runs on the host's network, where kind's API server listens, with the token the vault minted for the
  step in its kubeconfig. The real `kubectl` on this machine (`HOPPER_TEST_KUBECTL`) reads the cluster as its admin.

## Run

```sh
npm run test:cloud                 # testcontainers starts moto and Postgres; the aws CLI runs with `docker run`
HOPPER_TEST_MOTO_URL=http://127.0.0.1:<port> HOPPER_TEST_POSTGRES_URL=postgres://… npm run test:cloud
                                   # a moto and a Postgres that are already up (a seat where testcontainers hangs)
```

`kubectl.test.ts` needs `kind` and `kubectl` on the PATH (`HOPPER_TEST_KIND`, `HOPPER_TEST_KUBECTL` name others), or
`HOPPER_TEST_KUBECONFIG` for a cluster that is already up. `HOPPER_TEST_CONTAINER_CLI` names the container command (default `docker`; podman's `docker` works). Image overrides:
`MOTO_IMAGE`, `AWS_CLI_IMAGE`, `HOPPER_TEST_BOX_IMAGE` (the box's base image), `HOPPER_TEST_EGRESS_IMAGE` (the egress
proxy's image; default the hopper's `dev` image, the first channel whose image carries tinyproxy). CI: `.github/workflows/cloud-acceptance.yml`, nightly and on a pull request that
changes `src/vault`, `src/sandbox`, `src/infra-plans`, `src/domain/minting.ts` or these tests.

## Acceptance criteria covered

| # | Criterion | Where |
|---|-----------|-------|
| 1 | Minted scope: ReadOnlyAccess and the deny policy, a lifetime within the template's, the configured session name, no key on the box | `read-session.test.ts` |
| 2 | Read-only by every route: the aws CLI (delete, terminate, schedule deletion, send, attach, assume another role), curl's raw SigV4 PUT and the SDK are denied at the proxy; moto's state hash is the same before and after | `read-session.test.ts` |
| 2 | The terraform route, in the read-only box: init and plan work; `apply` and `apply -auto-approve` are refused by the wrapper before any call; the real binary's `apply -auto-approve` by its absolute path is denied at the proxy; the box's aws CLI is denied too; moto is unchanged | `terraform.test.ts` |
| 2 | Every route inside a read-only need box, under the sandbox flags and behind the egress proxy, with the minted read session: the aws CLI reads through both proxies; its delete and terminate, terraform's real binary by its absolute path, curl's own SigV4 PUT and an SDK script's put and delete are denied at the proxy; the wrapper refuses `apply` and `apply -auto-approve` before any call; the proxy allows the session no write; moto is unchanged; the box is burned after the step | `need-box-read-only.test.ts` |
| 3 | Lifetime: after the job ends, or a person revokes the template's approval in Access, the helper's renewal is refused and STS is asked for no new session; the session the job held is denied once its lifetime (900 s at most) is over | `lifetime.test.ts` |
| 4 | Write path: a box of a write template plans with its read session, the job records the plan with its saved file, a person approves it; the apply session is minted only for that plan at its branch's commit (not before the approval, not after the branch moved); the apply wrapper refuses a tampered copy of the file and an apply that names no plan, before any call; the recorded plan applies, one CreateBucket; the same plan again is refused by terraform as stale, and moto is unchanged | `write-path.test.ts` |
| 4 | The write path in need boxes, under the sandbox flags: a read step plans, the job records the plan with the saved file the step brought back, a person approves it; an apply step that names no plan, names it before the approval or after the branch moved ends refused with no apply session minted, and with infra applies off it is refused when asked; the apply wrapper refuses a tampered copy of the file before any call; the saved file the hopper put in the box applies, one CreateBucket; the same plan again on the state it left is refused by terraform as stale, and moto is unchanged; no need box or home is left | `need-box-write-path.test.ts` |
| 5 | Drift: a bucket and a VPC made in moto out of band show in the next Discover now; every call of discovery's session is a Describe, List or Get, allowed, and moto's state is what the change left | `discovery.test.ts` |
| 6 | Saga resume: the hopper is killed before the mint, after the mint while the step's command runs, after the box exited before the saga recorded it, and before and after the credentials' release; a second hopper on the same database ends the step's saga once; STS minted one session and the command's listing reached moto once (never run again: a step interrupted mid-command ends `STEP_INTERRUPTED`); the job reads one result; no need box or home volume is left; the step's session is denied once its lifetime is over | `saga-resume.test.ts` |
| 7 | Egress: a read-only need box, started by the sandbox module behind the egress proxy, reaches the STS endpoint its credential names through the proxy (curl and the aws CLI); a public host, the metadata address, a raw IP and that endpoint by its IP are refused by the proxy (403), and past the proxy none has a route or resolves; the proxy refuses a name that carries data, and the box's resolver answers no public name; the box has no capability, no new privileges and a read-only root, and is burned after the step | `egress.test.ts` |
| 8 | kubectl on kind: a need step's token is a TokenRequest token of `hopper-read`, bound to a Secret of its own, for 10 minutes at most, and the box holds no minting token; it lists pods, and the cluster forbids it to delete a pod, exec in it, create a Secret or read one; the workload is the same after; when the step's box ended, the Secret is gone and the cluster refuses the same token (Unauthorized); no need box is left | `kubectl.test.ts` |

Criterion 3, stated: the hopper does not end an STS session early. A session it handed a job lives until its own
expiry (900 s at most), after the job ends or a revoke too; the test moves the proxy's clock past it.

Every criterion is covered. A Kubernetes token is bound to its sandbox and ends with it; an STS session cannot be
ended early, so criterion 3 is met by its lifetime (above).

## Notes

- On some seats `aws s3 rm` and `aws s3 cp` (the CLI's transfer manager) crash with exit 139 even against moto alone;
  the tests use the `s3api` commands, which make the same calls.
- moto answers two `Date` headers; node joins them and the AWS SDK fails its clock-skew check. The proxy makes them
  one, so the seed and the state hash go through the proxy with the seed's key.
- The proxy names a bucket's subresources (tagging, CORS, lifecycle, object lock and the others terraform's
  `aws_s3_bucket` reads and writes). A PUT or DELETE of one it cannot name is unnamed and denied, never taken for
  `CreateBucket` or `DeleteBucket`. Each allowed call in its log keeps moto's HTTP status (`status`): the AWS provider
  sends `CreateBucket` again without its tags when moto refuses the first, so a test counts the calls moto took.
