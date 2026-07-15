# Claude Desktop Mirror

This public repository is an automated mirror of Claude Desktop installer bytes obtained through the Anthropic source endpoints listed below. Anonymous users can download every published asset directly from GitHub Releases.

## Stable latest downloads

- [Claude-macOS-universal.dmg](https://github.com/ding-rs/claude-desktop-mirror/releases/latest/download/Claude-macOS-universal.dmg)
- [Claude-Windows-x64.msix](https://github.com/ding-rs/claude-desktop-mirror/releases/latest/download/Claude-Windows-x64.msix)
- [Claude-Windows-arm64.msix](https://github.com/ding-rs/claude-desktop-mirror/releases/latest/download/Claude-Windows-arm64.msix)
- [manifest.json](https://github.com/ding-rs/claude-desktop-mirror/releases/latest/download/manifest.json)
- [SHA256SUMS](https://github.com/ding-rs/claude-desktop-mirror/releases/latest/download/SHA256SUMS)

## Source endpoints

The mirror tracks these three Anthropic latest-redirect endpoints:

- Universal macOS DMG: `https://api.anthropic.com/api/desktop/darwin/universal/dmg/latest/redirect`
- x64 Windows MSIX: `https://api.anthropic.com/api/desktop/win32/x64/msix/latest/redirect`
- arm64 Windows MSIX: `https://api.anthropic.com/api/desktop/win32/arm64/msix/latest/redirect`

Each endpoint must remain on reviewed Anthropic hosts throughout its HTTPS redirect chain and resolve to a canonical release URL on `downloads.claude.ai`. Any signed query parameters are kept only in memory for the current run and are not written to release metadata or probe output.

## Synchronization model

The scheduled no-change check performs three one-byte HTTPS Range probes (`bytes=0-0`). If the source fingerprints have not changed, it downloads zero installer bodies and performs zero release writes.

The observed upstream identity contract combines the canonical version, 40-hex filename identifier, exact size, and strong ETag. The 40-hex filename field is an opaque upstream identifier, not a claim that it is a SHA-256 digest. The strong ETag is an observed upstream contract and is required to remain stable from the Range probe through the full download.

When a source changes, only changed installers are downloaded from the Anthropic endpoints. Unchanged installers are retrieved from the previous GitHub Release and checked against their previously recorded local hashes. The workflow assembles a complete snapshot as a draft, verifies the remote draft's exact asset names and sizes, and only then publishes it as the new `latest` release. If publishing is interrupted after GitHub may have accepted the change, the workflow reconciles the release state and recovers the intended `latest` marker when safe. Older releases are retained for rollback.

Every automatic and manually dispatched synchronization uses the same repository concurrency lock. This single-writer rule, together with per-run ownership markers, ensures that cleanup can remove only a draft owned by the current run. A failure before publishing leaves the previous `latest` release intact. If the publication state is uncertain, cleanup refuses to delete the new release because it may already be published.

## Security and integrity

- Every release includes `manifest.json` and `SHA256SUMS`. SHA-256 is computed locally from the installer bytes before upload; Anthropic does not publish a digest through these endpoints, so this records the bytes mirrored by the workflow rather than independently proving their upstream content.
- Each installer must be smaller than 2 GiB and its full-download size and ETag must exactly match the probe.
- The Windows runner uses Windows SDK `signtool` to perform Authenticode trust-chain verification for both MSIX assets. It does not pin a specific publisher identity.
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
