// Shared helper: map image name <-> Dockerfile and compute a content hash.
// The hash covers the image's own Dockerfile plus the shared base Dockerfile,
// so editing either flags every derived image as stale.
import { createHash } from "crypto";
import { readFileSync } from "fs";

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
  }
  return hash.digest("hex").slice(0, 16);
}
