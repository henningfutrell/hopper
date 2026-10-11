// Tools assembled per run (issue #716, item 2; design.md "Tools assembled per run"): the hopper adds the tools a box
// needs to its image, instead of one fixed image per template. Pure: the Containerfile and the tag of that image. It
// starts from the box's image, fetches each tool in a separate Debian stage from the tool's own release — pinned, and
// checked by its SHA-256 before it is kept —, and copies only the result into /opt/hopper-tools. The tag is a hash of
// the Containerfile and the base image's id, so the same tools on the same base build once.
//
// The versions and sums are pinned by hand: a new release is a change here, read and reviewed like any other.
import { createHash } from 'node:crypto';
import type { AssetKind, OperationProfile } from '../domain/access.ts';
import { toolSet, type BoxTool } from '../domain/sandboxes.ts';

/** The repository the hopper tags the images it builds in. Local: it is never pushed. */
export const TOOLS_IMAGE = 'localhost/hopper-box-tools';
/** The stage that fetches the tools: Debian, by its index digest, so a moved tag cannot change it. */
const FETCH_BASE = 'docker.io/library/debian:bookworm-slim@sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587';
const DIR = '/opt/hopper-tools';

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

/** One RUN per tool: a layer each, so a tool fetched for one image is not fetched again for another. */
const step = (tool: BoxTool): string => {
  const r = RECIPES[tool];
  const arches = Object.entries(r.arch).map(([arch, x]) => `${arch}) sum=${x.sum} a=${x.a} ;;`).join(' ');
  return `# ${tool} ${r.version}
RUN set -eu; case "$(dpkg --print-architecture)" in ${arches} *) echo "${tool}: no release for this architecture" >&2; exit 1 ;; esac; \\
    f=/tmp/${tool}.download; curl -fsSL "${r.url}" -o "$f"; echo "$sum  $f" | sha256sum -c -; \\
    ${r.install}; rm -rf /tmp/*`;
};

/** The image of `base` with `tools` added: its tag and its Containerfile. */
export function toolsImage(base: { image: string; id?: string | undefined }, tools: readonly string[]): { tag: string; containerfile: string } {
  const set = toolSet(tools);
  const containerfile = `# Made by the hopper (issue #716): ${base.image} with ${set.join(', ')}. Each download is pinned and checked by its SHA-256.
FROM ${FETCH_BASE} AS fetch
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl unzip && rm -rf /var/lib/apt/lists/* && mkdir -p ${DIR}/bin
${set.map(step).join('\n')}

FROM ${base.image}
COPY --from=fetch ${DIR}/ ${DIR}/
ENV PATH=${DIR}/bin:\${PATH}
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
