# Claude Linux DEB Mirror Design

## Goal and scope

Extend the existing Claude Desktop snapshot mirror with Anthropic's two official Linux beta packages: Debian `amd64` and `arm64`. Keep the current macOS Universal DMG and Windows x64/arm64 MSIX assets unchanged. ChromeOS, mobile apps, RPM, AppImage, and repository metadata are outside the release asset set.

## Upstream contract

Each Linux architecture uses its fixed HTTPS `Packages` index under `downloads.claude.ai/claude-desktop/apt/stable`. The probe reads a bounded index body, accepts only unambiguous `claude-desktop` records with canonical three-part numeric versions, the requested architecture, a canonical pool filename, a positive sub-2-GiB size, and a lowercase SHA-256. It selects the greatest numeric version independently per architecture, matching Anthropic's documented `sort -V | tail -n 1` behavior.

The public asset names are stable:

- `Claude-Linux-x64.deb`
- `Claude-Linux-arm64.deb`

The source fingerprint contains version, canonical pool filename, exact size, and Anthropic's repository SHA-256. The resolved pool URL remains runtime-only.

## Download and integrity behavior

A changed DEB is downloaded without redirects from the exact reviewed pool URL selected by the probe. The response must be HTTPS on `downloads.claude.ai`, status 200, and advertise the probed size. The streamed result must match both the probed size and repository SHA-256; a mismatch removes the staged file. Windows Authenticode verification remains limited to MSIX assets.

Unchanged DEBs are reused from the previous GitHub Release under the existing manifest-hash checks. The draft, exact asset verification, atomic publish, latest marker, rollback retention, and concurrency behavior remain unchanged.

## Failure policy and tests

Malformed, oversized, ambiguous, cross-architecture, downgraded, redirected, or checksum-mismatched APT data fails closed before publication. Tests cover bounded index parsing and version selection, exact five-asset order, changed DEB staging, hash/size/host rejection, snapshot reuse, probe-only redaction, and existing macOS/Windows regressions.

## Delivery

Update the README's asset list, source endpoints, probe model, and integrity wording. Run the full Node test suite and a live probe. Commit and push the implementation, manually dispatch the workflow, verify the new non-draft latest Release contains exactly five installers plus `manifest.json` and `SHA256SUMS`, then rerun once to prove no-change idempotence. Do not deploy zhongzhuan Web.
