// Tools assembled per run (issue #716, item 2; design.md "Tools assembled per run"): the hopper adds the tools a box
// needs to its image, instead of one fixed image per template. Pure: the Containerfile and the tag of that image. It
// starts from the box's image, fetches each tool in a separate Debian stage from the tool's own release — pinned, and
// checked by its SHA-256 before it is kept —, and copies only the result into /opt/hopper-tools. The tag is a hash of
// the Containerfile and the base image's id, so the same tools on the same base build once. A read-only template's image
// (issue #715) also puts the read-only terraform wrapper first on PATH, in front of the real binary, and holds the
// providers terraform may install in a mirror it installs from alone: a box downloads no provider.
//
// The versions and sums are pinned by hand: a new release is a change here, read and reviewed like any other.
import { createHash } from 'node:crypto';
import type { AssetKind, OperationProfile } from '../domain/access.ts';
import { toolSet, type BoxTool } from '../domain/sandboxes.ts';
import { PROVIDER_MIRROR, TERRAFORM_CLI_CONFIG, TERRAFORM_WRAPPER } from './terraform-wrapper.ts';

/** The repository the hopper tags the images it builds in. Local: it is never pushed. */
export const TOOLS_IMAGE = 'localhost/hopper-box-tools';
/** The stage that fetches the tools: Debian, by its index digest, so a moved tag cannot change it. */
const FETCH_BASE = 'docker.io/library/debian:bookworm-slim@sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587';
const DIR = '/opt/hopper-tools';
/** Where a read-only image keeps its wrappers: first on PATH, in front of `${DIR}/bin`. */
const READ_ONLY_DIR = `${DIR}/read-only`;
/** A read-only image's terraform CLI config: providers from the mirror only. */
const CLI_CONFIG = `${DIR}/terraform.rc`;

/** One tool: its release for each architecture (`a`: the release's own word for it), and how the download `$f` is installed. */
interface Recipe { version: string; arch: Record<'amd64' | 'arm64', { a: string; sum: string }>; url: string; install: string }

const RECIPES: Record<BoxTool, Recipe> = {
  aws: {
    version: '2.37.12',
    arch: {
      amd64: { a: 'x86_64', sum: 'e6d3c672fb36ed4b12c354c39a993eee2b34da1437cafb10bac4480840cfa83f' },
      arm64: { a: 'aarch64', sum: '829c76096e05f743267d75098bc7cc7cfae799fc7e568554ebaa6d78e6aba753' },
    },
    url: 'https://awscli.amazonaws.com/awscli-exe-linux-${a}-2.37.12.zip',
    install: `unzip -q "$f" -d /tmp/aws-cli && /tmp/aws-cli/aws/install --install-dir ${DIR}/aws-cli --bin-dir ${DIR}/bin`,
  },
  helm: {
    version: 'v4.3.0',
    arch: {
      amd64: { a: 'amd64', sum: '86584a54def73570558f66f5111cc53dfed56689637ae32c1201205d494f54fb' },
      arm64: { a: 'arm64', sum: '31c5794dd55c66a51e6b7d2e2ac7a114ae8b1de41ff1d9ba51748ac973b06a08' },
    },
    url: 'https://get.helm.sh/helm-v4.3.0-linux-${a}.tar.gz',
    install: `tar -xzf "$f" -C /tmp && install -m 755 "/tmp/linux-$a/helm" ${DIR}/bin/helm`,
  },
  kubectl: {
    version: 'v1.37.1',
    arch: {
      amd64: { a: 'amd64', sum: '65691ff77eb6fa44c908b77a1082c9f092c3b9733b5cefabec0d1104890e21a8' },
      arm64: { a: 'arm64', sum: 'ff749f4b78d9c4f1ec87307df9b50119ed819e2094aa9810cb9acffc3286c8c7' },
    },
    url: 'https://dl.k8s.io/release/v1.37.1/bin/linux/${a}/kubectl',
    install: `install -m 755 "$f" ${DIR}/bin/kubectl`,
  },
  terraform: {
    version: '1.16.5',
    arch: {
      amd64: { a: 'amd64', sum: '2bc2fcfff033265c9e02ca0351f01794eb122f62a9b2a49a3294b9e49eaab5e4' },
      arm64: { a: 'arm64', sum: '61a50b00485ee4810cf20581ef080fc54d34d666e175c58d9a10501c65c1ccde' },
    },
    url: 'https://releases.hashicorp.com/terraform/1.16.5/terraform_1.16.5_linux_${a}.zip',
    install: `unzip -q "$f" -d /tmp/terraform && install -m 755 /tmp/terraform/terraform ${DIR}/bin/terraform`,
  },
};

/**
 * The one provider a read-only image holds in its mirror (issue #715), and so the only one terraform installs there: the
 * AWS provider, as the hopper reads a terraform workspace with an AWS read session. Kept in the mirror's packed layout:
 * the release's zip, as published, under its registry address.
 */
const AWS_PROVIDER_DIR = `${PROVIDER_MIRROR}/registry.terraform.io/hashicorp/aws`;
const AWS_PROVIDER: Recipe = {
  version: '6.68.0',
  arch: {
    amd64: { a: 'amd64', sum: 'b2511842cb6b23036c72babbaf12b4984835bb2824f938882330b51c68bdaecd' },
    arm64: { a: 'arm64', sum: 'abd449fbf38cf828b8b17bc8540752733dd861160504a45b411e72e1792c758c' },
  },
  url: 'https://releases.hashicorp.com/terraform-provider-aws/6.68.0/terraform-provider-aws_6.68.0_linux_${a}.zip',
  install: `mkdir -p ${AWS_PROVIDER_DIR} && mv "$f" ${AWS_PROVIDER_DIR}/terraform-provider-aws_6.68.0_linux_$a.zip`,
};

/** One RUN per tool: a layer each, so a tool fetched for one image is not fetched again for another. */
const step = (name: string, r: Recipe): string => {
  const arches = Object.entries(r.arch).map(([arch, x]) => `${arch}) sum=${x.sum} a=${x.a} ;;`).join(' ');
  return `# ${name} ${r.version}
RUN set -eu; case "$(dpkg --print-architecture)" in ${arches} *) echo "${name}: no release for this architecture" >&2; exit 1 ;; esac; \\
    f=/tmp/${name}.download; curl -fsSL "${r.url}" -o "$f"; echo "$sum  $f" | sha256sum -c -; \\
    ${r.install}; rm -rf /tmp/*`;
};

const b64 = (text: string): string => Buffer.from(text).toString('base64');

/**
 * The read-only steps of an image with terraform (issue #715): the provider of its mirror, then the wrapper and the CLI
 * config, each in base64, so the Containerfile needs no build context and no heredoc, which not every builder takes.
 */
const readOnlySteps = (): string => `${step('terraform-provider-aws', AWS_PROVIDER)}
# the read-only terraform wrapper and its CLI config: providers from the mirror only (issue #715)
RUN mkdir -p ${READ_ONLY_DIR} && echo ${b64(TERRAFORM_WRAPPER)} | base64 -d > ${READ_ONLY_DIR}/terraform && chmod 755 ${READ_ONLY_DIR}/terraform \\
    && echo ${b64(TERRAFORM_CLI_CONFIG)} | base64 -d > ${CLI_CONFIG}`;

/**
 * The image of `base` with `tools` added: its tag and its Containerfile. `readOnly` (a read-only template's boxes, issue
 * #715): terraform runs through the read-only wrapper, and installs providers only from the image's mirror.
 */
export function toolsImage(base: { image: string; id?: string | undefined }, tools: readonly string[], o: { readOnly?: boolean | undefined } = {}): { tag: string; containerfile: string } {
  const set = toolSet(tools);
  const wrapped = o.readOnly === true && set.includes('terraform');
  const containerfile = `# Made by the hopper (issue #716): ${base.image} with ${set.join(', ')}. Each download is pinned and checked by its SHA-256.
FROM ${FETCH_BASE} AS fetch
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl unzip && rm -rf /var/lib/apt/lists/* && mkdir -p ${DIR}/bin
${set.map((tool) => step(tool, RECIPES[tool])).join('\n')}${wrapped ? `\n${readOnlySteps()}` : ''}

FROM ${base.image}
COPY --from=fetch ${DIR}/ ${DIR}/
ENV PATH=${wrapped ? `${READ_ONLY_DIR}:` : ''}${DIR}/bin:\${PATH}${wrapped ? `\nENV TF_CLI_CONFIG_FILE=${CLI_CONFIG}` : ''}
LABEL io.hopper.tools="${set.join(' ')}"
`;
  const hash = createHash('sha256').update(`${base.id ?? ''}\n${containerfile}`).digest('hex').slice(0, 16);
  return { tag: `${TOOLS_IMAGE}:${hash}`, containerfile };
}

/** The tools work on an asset of each kind uses (issue #716): what a template made on request adds. */
const KIND_TOOLS: Record<AssetKind, BoxTool[]> = {
  cluster: ['kubectl', 'helm'],
  namespace: ['kubectl', 'helm'],
  'argocd-app': ['kubectl'],
  'terraform-workspace': ['terraform', 'aws'],
  'aws-account': ['aws'],
  'aws-role': ['aws'],
};

/** The tools these needs use, each once, in the catalog's order. */
export const toolsForNeeds = (needs: readonly OperationProfile[]): BoxTool[] => toolSet(needs.flatMap((p) => KIND_TOOLS[p.asset.kind]));
