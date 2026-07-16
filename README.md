# Claude Desktop Mirror

This public repository is an automated mirror of Claude Desktop installer bytes obtained through the Anthropic source endpoints listed below. Anonymous users can download every published asset directly from GitHub Releases.

## Stable latest downloads

- [Claude-macOS-universal.dmg](https://github.com/ding-rs/claude-desktop-mirror/releases/latest/download/Claude-macOS-universal.dmg)
- [Claude-Windows-x64.msix](https://github.com/ding-rs/claude-desktop-mirror/releases/latest/download/Claude-Windows-x64.msix)
- [Claude-Windows-arm64.msix](https://github.com/ding-rs/claude-desktop-mirror/releases/latest/download/Claude-Windows-arm64.msix)
- [Claude-Linux-x64.deb](https://github.com/ding-rs/claude-desktop-mirror/releases/latest/download/Claude-Linux-x64.deb)
- [Claude-Linux-arm64.deb](https://github.com/ding-rs/claude-desktop-mirror/releases/latest/download/Claude-Linux-arm64.deb)
- [manifest.json](https://github.com/ding-rs/claude-desktop-mirror/releases/latest/download/manifest.json)
- [SHA256SUMS](https://github.com/ding-rs/claude-desktop-mirror/releases/latest/download/SHA256SUMS)

## Source endpoints

The mirror tracks three Anthropic latest-redirect endpoints:

- Universal macOS DMG: `https://api.anthropic.com/api/desktop/darwin/universal/dmg/latest/redirect`
- x64 Windows MSIX: `https://api.anthropic.com/api/desktop/win32/x64/msix/latest/redirect`
- arm64 Windows MSIX: `https://api.anthropic.com/api/desktop/win32/arm64/msix/latest/redirect`

It also tracks the two official stable APT package indexes:

- amd64 Linux DEB: `https://downloads.claude.ai/claude-desktop/apt/stable/dists/stable/main/binary-amd64/Packages`
- arm64 Linux DEB: `https://downloads.claude.ai/claude-desktop/apt/stable/dists/stable/main/binary-arm64/Packages`

Each latest-redirect endpoint must remain on reviewed Anthropic hosts throughout its HTTPS redirect chain and resolve to a canonical release URL on `downloads.claude.ai`. Any signed query parameters are kept only in memory for the current run and are not written to release metadata or probe output.

The APT index requests accept no redirects and must return from their exact reviewed HTTPS endpoints. Each architecture is selected independently from unambiguous `claude-desktop` records by greatest canonical numeric `x.y.z` version. The selected pool URL, size, and repository SHA-256 remain bound together for staging; only the canonical version, pool path, size, and SHA-256 fingerprint are persisted.

## Synchronization model

Scheduled synchronization is opt-in. The daily schedule is skipped unless the repository variable `MIRROR_SYNC_ENABLED` is exactly `true`; unset, empty, or any other value keeps it disabled. A manually dispatched workflow always runs, regardless of that variable. For initial setup, run and verify the workflow manually before setting `MIRROR_SYNC_ENABLED=true` under the repository's Actions variables. Unset the variable or set it to `false` to disable later scheduled runs without changing the workflow.

Once enabled, the scheduled no-change check performs five requests: three one-byte HTTPS Range probes (`bytes=0-0`) and two bounded APT `Packages` index GETs (at most 1 MiB each). If the source fingerprints have not changed, it downloads zero installer bodies and performs zero release writes.

For DMG/MSIX sources, the observed upstream identity contract combines the canonical version, 40-hex filename identifier, exact size, and strong ETag. The 40-hex filename field is an opaque upstream identifier, not a claim that it is a SHA-256 digest. The strong ETag is an observed upstream contract and is required to remain stable from the Range probe through the full download.

Each Linux architecture has an independent version and fingerprint. Its identity combines the canonical version, canonical APT pool path, exact size, and the official repository SHA-256. A new version on one architecture does not force the other architecture to change.

The first rollout from the legacy three-installer snapshot accepts only that exact explicitly configured macOS/Windows ID set after full manifest-envelope validation. It reuses and re-verifies those three prior release assets, downloads only the two new DEBs, and publishes a normal five-installer snapshot. Subsequent runs require the regular exact five-ID snapshot for no-change and incremental synchronization.

When a source changes, only changed installers are downloaded from the Anthropic endpoints. Unchanged installers are retrieved from the previous GitHub Release and checked against their previously recorded local hashes. The workflow assembles a complete snapshot as a draft, verifies the remote draft's exact asset names and sizes, and only then publishes it as the new `latest` release. If publishing is interrupted after GitHub may have accepted the change, the workflow reconciles the release state and recovers the intended `latest` marker when safe. Older releases are retained for rollback.

Every automatic and manually dispatched synchronization uses the same repository concurrency lock. This single-writer rule, together with per-run ownership markers, ensures that cleanup can remove only a draft owned by the current run. A failure before publishing leaves the previous `latest` release intact. If the publication state is uncertain, cleanup refuses to delete the new release because it may already be published.

## Security and integrity

- Every release includes `manifest.json` and `SHA256SUMS`, with SHA-256 computed locally from every installer before upload. The latest-redirect DMG/MSIX endpoints do not publish a digest, so their local hashes record the mirrored bytes rather than independently proving upstream content. Each DEB must additionally match the SHA-256 published in Anthropic's official APT repository.
- Every installer must be smaller than 2 GiB. DMG/MSIX full-download size and ETag must exactly match their probes; DEB Content-Length, streamed size, and SHA-256 must exactly match the selected APT record.
- The Windows runner uses Windows SDK `signtool` to perform Authenticode trust-chain verification only for the two MSIX assets. It does not pin a specific publisher identity. DMG and DEB assets do not invoke `signtool`.
- Full installer downloads accept no redirects and must use the exact reviewed URL discovered by the probe.
- Signed query parameters remain runtime-only and are excluded from probe output and release metadata.
- Failures before publish preserve the previous `latest`. Owned-draft cleanup, publication-state recovery, and workflow serialization prevent one run from deleting another run's work.

## Maintainer checks

Run the test suite locally:

```sh
pnpm test
```

Probe upstream metadata without downloading installer bodies or writing a release:

```sh
pnpm sync -- --probe-only
```

A normal synchronization is intended for the serialized Windows GitHub Actions job. It additionally requires `GH_TOKEN`, `GH_REPO`, and Windows SDK `signtool`.
