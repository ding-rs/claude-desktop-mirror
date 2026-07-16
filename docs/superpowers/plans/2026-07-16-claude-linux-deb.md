# Claude Linux DEB Mirror Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish Anthropic's latest official Claude Desktop Linux `amd64` and `arm64` DEB packages in every complete GitHub Release snapshot.

**Architecture:** Add two fixed APT-index-backed assets to the existing Claude source adapter. Probe bounded `Packages` metadata to select the greatest canonical version per architecture, then bind staging to its exact official pool URL, size, and repository SHA-256. Preserve the existing atomic snapshot/reuse/publish pipeline.

**Tech Stack:** Node.js 22 ESM, built-in `fetch`, streams and crypto, `node:test`, GitHub Actions, GitHub Releases.

---

### Task 1: Add the two APT-index-backed Linux assets

**Files:**
- Modify: `scripts/lib/http.mjs`
- Modify: `scripts/lib/claude-sources.mjs`
- Modify: `scripts/sync.mjs`
- Modify: `test/claude-sources.test.mjs`
- Modify: `test/synchronize.test.mjs`
- Modify: `test/snapshot.test.mjs`
- Modify: `README.md`

- [ ] **Step 1: Write failing source-contract tests**

Add tests that define two new fixed assets after the existing three:

```js
{
  id: "linux-x64-deb",
  filename: "Claude-Linux-x64.deb",
  endpoint: "https://downloads.claude.ai/claude-desktop/apt/stable/dists/stable/main/binary-amd64/Packages",
  architecture: "amd64",
}
{
  id: "linux-arm64-deb",
  filename: "Claude-Linux-arm64.deb",
  endpoint: "https://downloads.claude.ai/claude-desktop/apt/stable/dists/stable/main/binary-arm64/Packages",
  architecture: "arm64",
}
```

The tests must require a bounded GET of each index, numeric selection of the greatest canonical `x.y.z` version, exact `claude-desktop` package and architecture matching, canonical pool filename, positive sub-2-GiB `Size`, lowercase 64-hex `SHA256`, stable public filenames, and a fingerprint of:

```text
version:<x.y.z>|file:<pool path>|size:<bytes>|sha256:<64hex>
```

Reject duplicate fields/versions, wrong package or architecture, malformed records, unsafe paths, redirects/unreviewed hosts, oversized bodies/assets, and noncanonical versions/checksums.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```sh
node --test test/claude-sources.test.mjs test/snapshot.test.mjs test/synchronize.test.mjs
```

Expected: failures because only the original three assets and redirect-style fingerprints exist.

- [ ] **Step 3: Implement bounded APT probing and exact DEB staging**

Refactor the existing bounded metadata reader in `scripts/lib/http.mjs` only as needed so `claude-sources.mjs` can read bounded UTF-8 text with the same retry, timeout, maximum-byte, cancellation, and sanitized-error behavior already used for JSON.

In `claude-sources.mjs`, keep redirect-backed DMG/MSIX behavior unchanged and add APT-backed definitions. The APT probe must return runtime `resolvedUrl`, `expectedSize`, and `expectedSha256`; only `id`, `filename`, `sourceEndpoint`, `sourceFingerprint`, and `expectedSize` may reach probe-only JSON. Stage a DEB with redirect mode `manual`, require exact reviewed URL/status/Content-Length, stream with `maxBytes = expectedSize + 1`, then compare returned size and SHA-256 with the probe before keeping the file. Never call `signtool` for DEBs.

Add both IDs to `EXPECTED_IDS` in this exact order:

```js
const EXPECTED_IDS = [
  "darwin-universal-dmg",
  "win32-x64-msix",
  "win32-arm64-msix",
  "linux-x64-deb",
  "linux-arm64-deb",
];
```

Update all shared expected-ID fixtures so first-run, changed-only, previous-release reuse, manifest validation, metadata writing, and probe-only behavior use a complete five-installer snapshot.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run the same focused command. Expected: all focused tests pass with five-asset expectations.

- [ ] **Step 5: Update maintainer documentation**

Add stable latest links for both DEBs. Document the two official APT index endpoints, five-request no-change probe model, independent per-architecture latest selection, repository SHA-256 enforcement for DEBs, and that Authenticode applies only to MSIX files.

- [ ] **Step 6: Run full local verification**

Run:

```sh
node --test
node scripts/sync.mjs --probe-only
```

Expected: zero test failures and safe probe-only JSON with five assets, including current Linux `amd64` and `arm64` versions but no runtime URLs or signed query parameters.

- [ ] **Step 7: Commit**

Stage only intended mirror files and commit:

```sh
git commit -m "feat: mirror Claude Desktop Linux packages"
```

### Task 2: Publish and prove the expanded snapshot

**Files:**
- No source changes expected.

- [ ] **Step 1: Push the reviewed branch and integrate it into `main`**

Fast-forward `main` only after the full suite and both review gates approve the implementation, then push `main` to `origin` without force.

- [ ] **Step 2: Dispatch the workflow manually**

Run the `Sync Claude Desktop` workflow and wait for a successful conclusion. Do not change `MIRROR_SYNC_ENABLED` and do not deploy zhongzhuan Web.

- [ ] **Step 3: Verify the public Release snapshot**

The new non-draft `latest` Release must contain exactly these seven assets:

```text
Claude-macOS-universal.dmg
Claude-Windows-x64.msix
Claude-Windows-arm64.msix
Claude-Linux-x64.deb
Claude-Linux-arm64.deb
manifest.json
SHA256SUMS
```

Verify manifest ID/name/size/hash values against the GitHub API and anonymously download both DEBs to verify their SHA-256 values.

- [ ] **Step 4: Prove no-change idempotence**

Dispatch the same workflow again at the same commit. It must succeed without creating another Release or changing the existing Release/asset IDs, sizes, digests, or timestamps.
