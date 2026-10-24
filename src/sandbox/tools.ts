// Tools assembled per run (issue #716, item 2; design.md "Tools assembled per run"): the hopper adds the tools a box
// needs to its image, instead of one fixed image per template. Pure: the Containerfile and the tag of that image. It
// starts from the box's image, fetches each tool in a separate Debian stage from the tool's own release — pinned, and
// checked by its SHA-256 before it is kept —, and copies only the result into /opt/hopper-tools. The tag is a hash of
// the Containerfile and the base image's id, so the same tools on the same base build once. A read-only template's image
// (issue #715) also puts the read-only terraform wrapper first on PATH, in front of the real binary, and holds the
// providers terraform may install in a mirror it installs from alone: a box downloads no provider. Any other image with
// terraform (a write box, issue #870) puts the apply wrapper first on PATH: terraform applies only a recorded plan.
//
// The versions and sums are pinned by hand: a new release is a change here, read and reviewed like any other.
import { createHash } from 'node:crypto';
import type { AssetKind, OperationProfile } from '../domain/access.ts';
import { toolSet, type BoxTool } from '../domain/sandboxes.ts';
import { PORT_FORWARD_HELPER } from './port-forward-helper.ts';
import { PROVIDER_MIRROR, TERRAFORM_CLI_CONFIG, TERRAFORM_APPLY_WRAPPER, TERRAFORM_WRAPPER } from './terraform-wrapper.ts';

/** The repository the hopper tags the images it builds in. Local: it is never pushed. */
export const TOOLS_IMAGE = 'localhost/hopper-box-tools';
/**
 * The label on each image a build keeps of its fetch stage (issue #1120): untagged, it is known as the hopper's by this
 * label alone, so the removal of leftover box builds (leftover-builds.ts) takes it and no image of anyone else's.
 */
export const TOOLS_STAGE_LABEL = 'io.hopper.tools-stage';
/** The stage that fetches the tools: Debian, by its index digest, so a moved tag cannot change it. */
const FETCH_BASE = 'docker.io/library/debian:bookworm-slim@sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587';
const DIR = '/opt/hopper-tools';
/** Where a read-only image keeps its wrappers: first on PATH, in front of `${DIR}/bin`. */
const READ_ONLY_DIR = `${DIR}/read-only`;
/** Where any other image with terraform keeps the apply wrapper: first on PATH, in front of `${DIR}/bin` (issue #870). */
const APPLY_WRAPPER_DIR = `${DIR}/apply-wrapper`;
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
  // Issue #2146: the observability tools. jq's static binary, logcli from Loki's release, and promtool alone of the
  // Prometheus release (the server is no tool of a box). The sums are each release's published ones.
  jq: {
    version: '1.8.2',
    arch: {
      amd64: { a: 'amd64', sum: 'b1c22172dd303f3be49e935aa56aa48a8b7a46e0bc838b4997d3bb451495870f' },
      arm64: { a: 'arm64', sum: '8b85c817833814ddca00a144c33705546355afccf0cf39b188f3cdb48b852309' },
    },
    url: 'https://github.com/jqlang/jq/releases/download/jq-1.8.2/jq-linux-${a}',
    install: `install -m 755 "$f" ${DIR}/bin/jq`,
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
  logcli: {
    version: 'v3.7.8',
    arch: {
      amd64: { a: 'amd64', sum: '44b790601963193df9cc496f0c8d6782e5d28c90754ca7a697e3f5683dad2588' },
      arm64: { a: 'arm64', sum: '830b431e1b28ee0291a0f3827484cc481e06849dd6e6f3dc5e984e34d5a645a7' },
    },
    url: 'https://github.com/grafana/loki/releases/download/v3.7.8/logcli-linux-${a}.zip',
    install: `unzip -q "$f" -d /tmp/logcli && install -m 755 "/tmp/logcli/logcli-linux-$a" ${DIR}/bin/logcli`,
  },
  promtool: {
    version: 'v3.15.0',
    arch: {
      amd64: { a: 'amd64', sum: '2a542df32eac02ee17b9d844fb2aa1de00dafa5476579ba8a3ba862e9d572ea0' },
      arm64: { a: 'arm64', sum: 'f1f90ec08e849d494ca66c611470afc50192f0355f1a61c33f2cbde02d067823' },
    },
    url: 'https://github.com/prometheus/prometheus/releases/download/v3.15.0/prometheus-3.15.0.linux-${a}.tar.gz',
    install: `tar -xzf "$f" -C /tmp "prometheus-3.15.0.linux-$a/promtool" && install -m 755 "/tmp/prometheus-3.15.0.linux-$a/promtool" ${DIR}/bin/promtool`,
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

/** A provider of the mirror: its release for each architecture, kept as published under its registry address. */
const provider = (name: string, version: string, amd64: string, arm64: string): Recipe => {
  const dir = `${PROVIDER_MIRROR}/registry.terraform.io/hashicorp/${name}`;
  return {
    version, arch: { amd64: { a: 'amd64', sum: amd64 }, arm64: { a: 'arm64', sum: arm64 } },
    url: `https://releases.hashicorp.com/terraform-provider-${name}/${version}/terraform-provider-${name}_${version}_linux_\${a}.zip`,
    install: `mkdir -p ${dir} && mv "$f" ${dir}/terraform-provider-${name}_${version}_linux_$a.zip`,
  };
};

/**
 * The providers a read-only image holds in its mirror (issue #715), and so the only ones terraform installs there: the
 * AWS provider, as the hopper reads a terraform workspace with an AWS read session, and HashiCorp's utility providers,
 * which IaC lock files use beside it (issue #1977: a workspace that needs hashicorp/null could not init). Each is the
 * release's zip, as published, in the mirror's packed layout. None of them reaches a service of its own.
 */
const PROVIDERS: Record<string, Recipe> = {
  'hashicorp/aws': provider('aws', '6.68.0', 'b2511842cb6b23036c72babbaf12b4984835bb2824f938882330b51c68bdaecd', 'abd449fbf38cf828b8b17bc8540752733dd861160504a45b411e72e1792c758c'),
  'hashicorp/null': provider('null', '3.3.2', 'd2855b922ea345dbd89ea287e4c6c4757e38bc0aaffeb2b79aa0b8004f9c53ff', '98da9c42785d27a50f0604758bcb61a30f6278b9f2acd92bb3b2046e0e71916c'),
  'hashicorp/random': provider('random', '3.9.1', '60b4f8a8ef18f52bf8e19215229dae408bee732825964092db7c989fd2de4097', '7c7fbb8895eb75bb4de1f933e98553bd99c8d048c89a925ddba490aa5a67f7dc'),
  'hashicorp/local': provider('local', '2.9.1', 'a8ea1c155bd5e0d695a28d3c0e2f542de8844e1791ea021f015a3f08e1c059e1', 'eedffca70074ae153790fb23c4ace8d1637a60ceba4e3c42c8eaeda7c1f9d10f'),
  'hashicorp/time': provider('time', '0.14.2', '0aa1028d91041f4dceba193e3707dac57358d0063d97e20700e554758b67baca', '32bee9f2b2678e2a0789ad86e716d09ca1d5450180b3cd8033ee7a251bfd352e'),
  'hashicorp/archive': provider('archive', '2.8.1', '50f0e72ba53bfe6e11b03b7fc899e1f72536354381d302a743a274ae2a3f45f4', '66069e604bcf5c4af0278e15997d9e6bd755c54fb3801d78885838b889729c5f'),
  'hashicorp/tls': provider('tls', '4.4.1', 'debc830ec123f27944c6170d76cb4ea3542845896960bb9fc530702774df328e', '693b810e438bb1dfbc13a42629597284ac1eb08eb30f46f18738d7a9bb768d34'),
};

/** The registry addresses of the providers a read-only image's mirror holds. */
export const MIRRORED_PROVIDERS = Object.keys(PROVIDERS);

/**
 * How a download tries again (issue #1737): a network error while the image builds (a host it could not resolve, a reset)
 * is most often gone a few seconds later. --retry-all-errors: curl tries again on every error, the DNS one included; the
 * URL is pinned, so an error that stays is only paid for a few times.
 */
const CURL = 'curl -fsSL --retry 4 --retry-delay 3 --retry-all-errors --connect-timeout 30';

/** One RUN per tool: a layer each, so a tool fetched for one image is not fetched again for another. */
const step = (name: string, r: Recipe): string => {
  const arches = Object.entries(r.arch).map(([arch, x]) => `${arch}) sum=${x.sum} a=${x.a} ;;`).join(' ');
  return `# ${name} ${r.version}
RUN set -eu; case "$(dpkg --print-architecture)" in ${arches} *) echo "${name}: no release for this architecture" >&2; exit 1 ;; esac; \\
    f=/tmp/${name}.download; ${CURL} "${r.url}" -o "$f"; echo "$sum  $f" | sha256sum -c -; \\
    ${r.install}; rm -rf /tmp/*`;
};

const b64 = (text: string): string => Buffer.from(text).toString('base64');

/**
 * The read-only steps of an image with terraform (issue #715): the providers of its mirror, then the wrapper and the CLI
 * config, each in base64, so the Containerfile needs no build context and no heredoc, which not every builder takes.
 */
const readOnlySteps = (): string => `${Object.entries(PROVIDERS).map(([source, r]) => step(`terraform-provider-${source.split('/')[1]}`, r)).join('\n')}
# the read-only terraform wrapper and its CLI config: providers from the mirror only (issue #715)
RUN mkdir -p ${READ_ONLY_DIR} && echo ${b64(TERRAFORM_WRAPPER)} | base64 -d > ${READ_ONLY_DIR}/terraform && chmod 755 ${READ_ONLY_DIR}/terraform \\
    && echo ${b64(TERRAFORM_CLI_CONFIG)} | base64 -d > ${CLI_CONFIG}`;

/** The apply wrapper step of any other image with terraform (issue #870): the wrapper, in base64, as the read-only one. */
const applyWrapperStep = (): string => `# the apply wrapper: no apply without a plan (issue #870)
RUN mkdir -p ${APPLY_WRAPPER_DIR} && echo ${b64(TERRAFORM_APPLY_WRAPPER)} | base64 -d > ${APPLY_WRAPPER_DIR}/terraform && chmod 755 ${APPLY_WRAPPER_DIR}/terraform`;

/** The port-forward helper step of an image with kubectl (issue #2146): the helper, in base64, beside kubectl. */
const portForwardStep = (): string => `# the port-forward helper: a forward lives only as long as its command (issue #2146)
RUN echo ${b64(PORT_FORWARD_HELPER)} | base64 -d > ${DIR}/bin/hopper-port-forward && chmod 755 ${DIR}/bin/hopper-port-forward`;

/**
 * The image of `base` with `tools` added: its tag and its Containerfile. `readOnly` (a read-only template's boxes, issue
 * #715): terraform runs through the read-only wrapper, and installs providers only from the image's mirror. Else
 * terraform runs through the apply wrapper (issue #870): it applies only the saved file of a plan the hopper recorded.
 */
export function toolsImage(base: { image: string; id?: string | undefined }, tools: readonly string[], o: { readOnly?: boolean | undefined } = {}): { tag: string; containerfile: string } {
  const set = toolSet(tools);
  const wrapped = o.readOnly === true && set.includes('terraform');
  const gated = !wrapped && set.includes('terraform');
  const containerfile = `# Made by the hopper (issue #716): ${base.image} with ${set.join(', ')}. Each download is pinned and checked by its SHA-256.
FROM ${FETCH_BASE} AS fetch
LABEL ${TOOLS_STAGE_LABEL}="fetch"
RUN apt-get -o Acquire::Retries=4 update && apt-get -o Acquire::Retries=4 install -y --no-install-recommends ca-certificates curl unzip && rm -rf /var/lib/apt/lists/* && mkdir -p ${DIR}/bin
${set.map((tool) => step(tool, RECIPES[tool])).join('\n')}${set.includes('kubectl') ? `\n${portForwardStep()}` : ''}${wrapped ? `\n${readOnlySteps()}` : ''}${gated ? `\n${applyWrapperStep()}` : ''}

FROM ${base.image}
COPY --from=fetch ${DIR}/ ${DIR}/
ENV PATH=${wrapped ? `${READ_ONLY_DIR}:` : gated ? `${APPLY_WRAPPER_DIR}:` : ''}${DIR}/bin:\${PATH}${wrapped ? `\nENV TF_CLI_CONFIG_FILE=${CLI_CONFIG}` : ''}
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
  // Issue #2231: the hopper reads a database itself; a box gets no tool, and no credential, for it.
  database: [],
};

/** The tools these needs use, each once, in the catalog's order. */
export const toolsForNeeds = (needs: readonly OperationProfile[]): BoxTool[] => toolSet(needs.flatMap((p) => KIND_TOOLS[p.asset.kind]));
