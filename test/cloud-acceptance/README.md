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

## Run

```sh
npm run test:cloud                 # testcontainers starts moto and Postgres; the aws CLI runs with `docker run`
HOPPER_TEST_MOTO_URL=http://127.0.0.1:<port> HOPPER_TEST_POSTGRES_URL=postgres://… npm run test:cloud
                                   # a moto and a Postgres that are already up (a seat where testcontainers hangs)
```

`HOPPER_TEST_CONTAINER_CLI` names the container command (default `docker`; podman's `docker` works). Image overrides:
`MOTO_IMAGE`, `AWS_CLI_IMAGE`, `HOPPER_TEST_BOX_IMAGE` (the box's base image). CI: `.github/workflows/cloud-acceptance.yml`, nightly and on a pull request that
changes `src/vault`, `src/sandbox`, `src/infra-plans`, `src/domain/minting.ts` or these tests.

## Acceptance criteria covered

| # | Criterion | Where |
|---|-----------|-------|
| 1 | Minted scope: ReadOnlyAccess and the deny policy, a lifetime within the template's, the configured session name, no key on the box | `read-session.test.ts` |
| 2 | Read-only by every route: the aws CLI (delete, terminate, schedule deletion, send, attach, assume another role), curl's raw SigV4 PUT and the SDK are denied at the proxy; moto's state hash is the same before and after | `read-session.test.ts` |
| 2 | The terraform route, in the read-only box: init and plan work; `apply` and `apply -auto-approve` are refused by the wrapper before any call; the real binary's `apply -auto-approve` by its absolute path is denied at the proxy; the box's aws CLI is denied too; moto is unchanged | `terraform.test.ts` |
| 3 | Lifetime: after the job ends, or a person revokes the template's approval in Access, the helper's renewal is refused and STS is asked for no new session; the session the job held is denied once its lifetime (900 s at most) is over | `lifetime.test.ts` |
| 5 | Drift: a bucket and a VPC made in moto out of band show in the next Discover now; every call of discovery's session is a Describe, List or Get, allowed, and moto's state is what the change left | `discovery.test.ts` |

Criterion 3, stated: the hopper does not end an STS session early. A session it handed a job lives until its own
expiry (900 s at most), after the job ends or a revoke too; the test moves the proxy's clock past it.

Not yet: the box under the hopper's own sandbox flags and egress proxy (a need box), an SDK script inside the box, the
write path's saved plan, saga resume, egress, and kubectl on kind. The pull request of each part lists what is left.

## Notes

- On some seats `aws s3 rm` and `aws s3 cp` (the CLI's transfer manager) crash with exit 139 even against moto alone;
  the tests use the `s3api` commands, which make the same calls.
- moto answers two `Date` headers; node joins them and the AWS SDK fails its clock-skew check. The proxy makes them
  one, so the seed and the state hash go through the proxy with the seed's key.
