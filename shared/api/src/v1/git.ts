// Git remote inspection: powers the plugin install modal (version dropdown,
// branch selector), update checks, and store cards. The lookup runs on the
// HOST (core process) — no plugin container or plugin permission involved.
import { z } from "zod";
import { V1_BASE_PATH } from "./constants.js";
import { createApiResponseSchema } from "../utils/schema.js";

// A semver tag on the remote, enriched with GitHub release info when the
// host is github.com. `notes` is third-party markdown — render sanitized.
export interface GitReleaseData {
  tag: string; // raw tag name, e.g. "v0.4.0"
  version: string; // normalized semver, e.g. "0.4.0"
  sha: string;
  name?: string; // GitHub release title
  notes?: string; // GitHub release body (untrusted markdown)
  publishedAt?: string;
  prerelease?: boolean;
}

export interface InspectGitRemoteData {
  defaultBranch: string | null;
  branches: string[];
  // Branch names are retained for existing clients; this additive map carries
  // their ls-remote SHAs for pinned-workflow update checks.
  branchHeads?: Record<string, string>;
  // All tag heads (including non-semver labels) support retarget/delete
  // detection; releases remains the semver-upgrade surface.
  tagHeads?: Record<string, string>;
  // Semver tags, newest first. Present for any git host (releases metadata
  // only when GitHub is reachable).
  releases: GitReleaseData[];
  github?: {
    owner: string;
    repo: string;
    description?: string;
  };
}

export const GitReleaseSchema = z.object({
  tag: z.string(),
  version: z.string(),
  sha: z.string(),
  name: z.string().optional(),
  notes: z.string().optional(),
  publishedAt: z.string().optional(),
  prerelease: z.boolean().optional(),
}) satisfies z.ZodType<GitReleaseData>;

export const InspectGitRemoteResponseSchema =
  createApiResponseSchema<InspectGitRemoteData>(
    "InspectGitRemoteResponseSchema",
  )(
    z.object({
      defaultBranch: z.string().nullable(),
      branches: z.array(z.string()),
      branchHeads: z.record(z.string(), z.string()),
      tagHeads: z.record(z.string(), z.string()).optional(),
      releases: z.array(GitReleaseSchema),
      github: z
        .object({
          owner: z.string(),
          repo: z.string(),
          description: z.string().optional(),
        })
        .optional(),
    }),
  );

export const InspectGitRemoteBodySchema = z.object({
  url: z.string().min(1),
});

export const gitRoutes = {
  inspectGitRemote: {
    method: "POST" as const,
    path: `${V1_BASE_PATH}/git/inspect`,
    schema: {
      tags: ["git"],
      body: InspectGitRemoteBodySchema,
      response: { 200: InspectGitRemoteResponseSchema },
    },
  },
} as const;
