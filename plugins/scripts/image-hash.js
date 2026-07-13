// Shared helper: map image name <-> Dockerfile and compute a content hash.
// The hash covers the image's own Dockerfile plus the shared base Dockerfile,
// so editing either flags every derived image as stale.
import { createHash } from "crypto";
import { existsSync, readFileSync } from "fs";

const SHARED_DOCKERFILE = "src/shared/Dockerfile";

export function dockerfileForImage(imageName) {
  const bare = imageName.replace(/^ignite\//, "").replace(/:.*$/, "");
  if (bare === "shared") return SHARED_DOCKERFILE;
  if (bare.startsWith("base_")) {
    return `src/shared/base/${bare.slice(5)}/Dockerfile`;
  }
  const [type, ...rest] = bare.split("_");
  return `src/${type}/${rest.join("_")}/Dockerfile`;
}

export function imageHash(imageName) {
  const hash = createHash("sha256");
  hash.update(readFileSync(SHARED_DOCKERFILE));
  const own = dockerfileForImage(imageName);
  if (own !== SHARED_DOCKERFILE) {
    hash.update(readFileSync(own));
    // bundledInImage builtins bake their JS bundle into the image, so the
    // bundle content must be part of the staleness hash — otherwise an image
    // holding an older bundle passes validation (final-review F3). The stage
    // dir sits next to the Dockerfile; hash it when present.
    const staged = own.replace(/Dockerfile$/, ".bundle/index.js");
    if (existsSync(staged)) {
      hash.update(readFileSync(staged));
    }
  }
  return hash.digest("hex").slice(0, 16);
}
