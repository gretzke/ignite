import { describe, expect, it } from "vitest";
import {
  GetReposResponseSchema,
  RepoListEntrySchema,
  RepoVersionSummarySchema,
} from "../v1/profiles.js";

const detectedWith = [{ pluginId: "foundry", version: "1.2.3" }];
const version = {
  url: "https://example.test/contracts",
  commit: "a".repeat(40),
  lastUsedAt: "2026-07-22T00:00:00.000Z",
};

describe("repo list schemas", () => {
  it("round-trips a detected compiler catalog and reusable version summary", () => {
    expect(
      RepoListEntrySchema.parse({
        pathOrUrl: "/repo",
        initialized: true,
        versions: [version],
        detectedWith,
      }).detectedWith
    ).toEqual(detectedWith);
    expect(RepoVersionSummarySchema.parse(version)).toEqual(version);
    const response = GetReposResponseSchema.parse({
      data: {
        session: null,
        local: [{ pathOrUrl: "/repo", initialized: true, versions: [], detectedWith }],
        cloned: [],
        versionGroups: [{ url: "https://example.test/contracts", versions: [version] }],
        pinned: [],
      },
    });
    expect("data" in response ? response.data.local[0].detectedWith : undefined).toEqual(
      detectedWith,
    );
  });
});
