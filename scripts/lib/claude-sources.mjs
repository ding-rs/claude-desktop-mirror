import { rm } from "node:fs/promises";

import {
  downloadAndHash,
  fetchTextWithRetry,
  fetchWithRetry,
} from "./http.mjs";
import { MAX_ASSET_SIZE } from "./snapshot.mjs";

const DEFAULT_PROBE_TIMEOUT_MS = 15_000;
const DEFAULT_PROBE_BODY_TIMEOUT_MS = 15_000;
const DEFAULT_PROBE_BODY_CANCEL_TIMEOUT_MS = 250;
const APT_INDEX_MAX_BYTES = 1024 ** 2;
const APT_REPOSITORY_ROOT =
  "https://downloads.claude.ai/claude-desktop/apt/stable";
const PROBE_REDIRECT_PROTOCOLS = ["https:"];
const REVIEWED_DOWNLOAD_HOSTS = new Set(["downloads.claude.ai"]);
const REVIEWED_REQUEST_HOSTS = new Set([
  "api.anthropic.com",
  "downloads.claude.ai",
]);
const STRONG_ETAG_PATTERN = /^"([0-9a-f]{32})"$/;
const CLAUDE_BASENAME_PATTERN = /^Claude-([0-9a-f]{40})\.(dmg|msix)$/;
const CANONICAL_VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

const ASSETS = [
  {
    id: "darwin-universal-dmg",
    filename: "Claude-macOS-universal.dmg",
    sourceEndpoint:
      "https://api.anthropic.com/api/desktop/darwin/universal/dmg/latest/redirect",
    kind: "dmg",
    probeKind: "redirect",
  },
  {
    id: "win32-x64-msix",
    filename: "Claude-Windows-x64.msix",
    sourceEndpoint:
      "https://api.anthropic.com/api/desktop/win32/x64/msix/latest/redirect",
    kind: "msix",
    probeKind: "redirect",
  },
  {
    id: "win32-arm64-msix",
    filename: "Claude-Windows-arm64.msix",
    sourceEndpoint:
      "https://api.anthropic.com/api/desktop/win32/arm64/msix/latest/redirect",
    kind: "msix",
    probeKind: "redirect",
  },
  {
    id: "linux-x64-deb",
    filename: "Claude-Linux-x64.deb",
    sourceEndpoint:
      "https://downloads.claude.ai/claude-desktop/apt/stable/dists/stable/main/binary-amd64/Packages",
    architecture: "amd64",
    kind: "deb",
    probeKind: "apt",
  },
  {
    id: "linux-arm64-deb",
    filename: "Claude-Linux-arm64.deb",
    sourceEndpoint:
      "https://downloads.claude.ai/claude-desktop/apt/stable/dists/stable/main/binary-arm64/Packages",
    architecture: "arm64",
    kind: "deb",
    probeKind: "apt",
  },
];

function positiveAssetSize(value, field) {
  const normalized =
    typeof value === "string" && /^(0|[1-9]\d*)$/.test(value)
      ? Number(value)
      : value;
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    throw new Error(`${field} must be a positive safe integer`);
  }
  if (normalized >= MAX_ASSET_SIZE) {
    throw new Error(`${field} must be less than 2 GiB`);
  }
  return normalized;
}

function rawPathname(value) {
  const authorityStart = value.indexOf("://") + 3;
  const pathStart = value.indexOf("/", authorityStart);
  const queryStart = value.indexOf("?", authorityStart);
  const pathEnd = queryStart === -1 ? value.length : queryStart;
  return pathStart === -1 || pathStart >= pathEnd
    ? ""
    : value.slice(pathStart, pathEnd);
}

function assertUnambiguousRawUrl(value, label) {
  if (value.includes("#")) {
    throw new Error(`${label} must not contain a raw fragment`);
  }
  const pathname = rawPathname(value);
  if (
    pathname.includes("%") ||
    pathname.includes("\\") ||
    /[^\x21-\x7e]/.test(pathname) ||
    pathname.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw new Error(`${label} raw pathname is unsafe or ambiguous`);
  }
}

function parseHttpsUrl(value, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`${label} must be a valid HTTPS URL`);
  }
  if (!/^https:\/\/[^/\\?#]/.test(value)) {
    throw new Error(`${label} must use the literal canonical https:// form`);
  }
  if (value.includes("\\")) {
    throw new Error(`${label} must not contain a backslash`);
  }
  assertUnambiguousRawUrl(value, label);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid HTTPS URL`);
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.hash ||
    parsed.port
  ) {
    throw new Error(`${label} must be a credential-free HTTPS URL without a fragment`);
  }
  return parsed;
}

export function parseClaudeVersion(value) {
  const parsed = parseHttpsUrl(value, "Claude version URL");
  const versions = [];
  for (const segment of parsed.pathname.split("/")) {
    if (segment.length === 0) continue;
    if (/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(segment)) {
      versions.push(segment);
    }
  }
  if (versions.length !== 1) {
    throw new Error(
      versions.length === 0
        ? "Claude version URL has no canonical numeric release segment"
        : "Claude version URL has an ambiguous release version",
    );
  }
  return versions[0];
}

function safeFinalBasename(parsed) {
  const basename = parsed.pathname.split("/").at(-1);
  const match = CLAUDE_BASENAME_PATTERN.exec(basename);
  if (!match) {
    throw new Error(
      "Claude download basename must use canonical Claude-<40hex> format",
    );
  }
  return { basename, contentId: match[1], extension: match[2] };
}

function normalizeClaudeDownloadUrl(value) {
  const parsed = parseHttpsUrl(value, "Claude download URL");
  if (!REVIEWED_DOWNLOAD_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new Error("Claude download URL must use a reviewed host");
  }
  const version = parseClaudeVersion(value);
  const basename = safeFinalBasename(parsed);
  return { parsed, version, ...basename };
}

function canonicalStrongEtag(value, field) {
  const match =
    typeof value === "string" ? STRONG_ETAG_PATTERN.exec(value) : null;
  if (!match) {
    throw new Error(`${field} must be a canonical strong 32-hex ETag`);
  }
  return { value, hex: match[1] };
}

function sourceFingerprint(value, size, etagHex) {
  const { version, basename } = normalizeClaudeDownloadUrl(value);
  return `version:${version}|file:${basename}|size:${size}|etag:${etagHex}`;
}

function canonicalVersion(value, field) {
  if (typeof value !== "string" || !CANONICAL_VERSION_PATTERN.test(value)) {
    throw new Error(`${field} must use canonical numeric x.y.z form`);
  }
  return value;
}

function debPoolPath(version, architecture) {
  return `pool/main/c/claude-desktop/claude-desktop_${version}_${architecture}.deb`;
}

function normalizeAptPoolUrl(value, asset) {
  const parsed = parseHttpsUrl(value, `${asset.id} DEB URL`);
  if (
    parsed.origin !== "https://downloads.claude.ai" ||
    parsed.search ||
    !parsed.pathname.startsWith("/claude-desktop/apt/stable/")
  ) {
    throw new Error(`${asset.id} DEB URL must use the exact reviewed APT pool`);
  }
  const filename = parsed.pathname.slice("/claude-desktop/apt/stable/".length);
  const match =
    /^pool\/main\/c\/claude-desktop\/claude-desktop_([^/_]+)_(amd64|arm64)\.deb$/.exec(
      filename,
    );
  if (!match) {
    throw new Error(`${asset.id} DEB URL has a noncanonical pool filename`);
  }
  const version = canonicalVersion(match[1], `${asset.id} DEB version`);
  if (
    match[2] !== asset.architecture ||
    filename !== debPoolPath(version, asset.architecture) ||
    value !== `${APT_REPOSITORY_ROOT}/${filename}`
  ) {
    throw new Error(`${asset.id} DEB URL does not match its architecture`);
  }
  return { parsed, version, filename };
}

function compareCanonicalVersions(left, right) {
  const leftParts = left.split(".").map((part) => BigInt(part));
  const rightParts = right.split(".").map((part) => BigInt(part));
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] < rightParts[index]) return -1;
    if (leftParts[index] > rightParts[index]) return 1;
  }
  return 0;
}

function aptSourceFingerprint(record) {
  return `version:${record.version}|file:${record.filename}|size:${record.size}|sha256:${record.sha256}`;
}

function parseAptPackages(text, asset) {
  if (typeof text !== "string" || text.length === 0) {
    throw new Error(`${asset.id} APT Packages index is empty`);
  }
  const normalized = text.replaceAll("\r\n", "\n");
  if (normalized.includes("\r") || normalized.includes("\0")) {
    throw new Error(`${asset.id} APT Packages index has unsafe control bytes`);
  }
  const recordText = normalized.replace(/(?:\n[ \t]*)+$/, "");
  const paragraphs = recordText
    .split(/\n[ \t]*\n/)
    .filter((paragraph) => paragraph.trim().length > 0);
  if (paragraphs.length === 0) {
    throw new Error(`${asset.id} APT Packages index has no records`);
  }

  const records = [];
  const versions = new Set();
  for (const paragraph of paragraphs) {
    const fields = new Map();
    const normalizedNames = new Set();
    let previousField;
    for (const line of paragraph.split("\n")) {
      if (/^[ \t]/.test(line)) {
        if (previousField === undefined) {
          throw new Error(`${asset.id} APT record continuation has no field`);
        }
        fields.set(
          previousField,
          `${fields.get(previousField)}\n${line.slice(1)}`,
        );
        continue;
      }
      const match = /^([A-Za-z0-9][A-Za-z0-9-]*):[ \t]*(.*)$/.exec(line);
      if (!match) {
        throw new Error(`${asset.id} APT Packages record is malformed`);
      }
      const normalizedName = match[1].toLowerCase();
      if (normalizedNames.has(normalizedName)) {
        throw new Error(`${asset.id} APT Packages record has a duplicate field`);
      }
      normalizedNames.add(normalizedName);
      fields.set(match[1], match[2]);
      previousField = match[1];
    }

    for (const required of [
      "Package",
      "Version",
      "Architecture",
      "Filename",
      "Size",
      "SHA256",
    ]) {
      if (!fields.has(required) || fields.get(required).length === 0) {
        throw new Error(`${asset.id} APT record is missing a required field`);
      }
    }
    if (fields.get("Package") !== "claude-desktop") {
      throw new Error(`${asset.id} APT record has the wrong package`);
    }
    if (fields.get("Architecture") !== asset.architecture) {
      throw new Error(`${asset.id} APT record has the wrong architecture`);
    }

    const version = canonicalVersion(
      fields.get("Version"),
      `${asset.id} APT Version`,
    );
    if (versions.has(version)) {
      throw new Error(`${asset.id} APT Packages index has a duplicate version`);
    }
    versions.add(version);

    const filename = fields.get("Filename");
    if (filename !== debPoolPath(version, asset.architecture)) {
      throw new Error(`${asset.id} APT Filename is not the canonical pool path`);
    }
    const size = positiveAssetSize(fields.get("Size"), `${asset.id} APT Size`);
    const sha256 = fields.get("SHA256");
    if (!SHA256_PATTERN.test(sha256)) {
      throw new Error(`${asset.id} APT SHA256 must be 64 lowercase hex characters`);
    }
    records.push({ version, filename, size, sha256 });
  }

  records.sort((left, right) =>
    compareCanonicalVersions(left.version, right.version),
  );
  return records.at(-1);
}

function reviewedFetch(fetchImpl) {
  return async (url, init) => {
    const parsed = parseHttpsUrl(String(url), "Claude request URL");
    if (!REVIEWED_REQUEST_HOSTS.has(parsed.hostname.toLowerCase())) {
      throw new Error("Claude request URL must use a reviewed host");
    }
    return await fetchImpl(url, init);
  };
}

function probeRequestOptions(options) {
  const maxRedirects = options.maxRedirects ?? 5;
  if (
    !Number.isSafeInteger(maxRedirects) ||
    maxRedirects < 0 ||
    maxRedirects > 5
  ) {
    throw new RangeError("maxRedirects must be an integer from 0 through 5");
  }
  return {
    headerTimeoutMs: options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
    backoffBaseMs: options.backoffBaseMs ?? 500,
    allowedRedirectProtocols: PROBE_REDIRECT_PROTOCOLS,
    maxRedirects,
  };
}

async function cancelProbeBody(response, timeoutMs) {
  if (response?.body === null || response?.body === undefined) return;
  const cancel = response.body.cancel;
  if (typeof cancel !== "function") return;
  let timer;
  try {
    await Promise.race([
      Promise.resolve().then(() => cancel.call(response.body)).catch(() => {}),
      new Promise((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function probeTotal(response) {
  if (response.status === 206) {
    const contentRange = response.headers?.get?.("content-range");
    const match =
      typeof contentRange === "string"
        ? /^bytes 0-0\/(0|[1-9]\d*)$/.exec(contentRange)
        : null;
    if (!match) {
      throw new Error("Claude range probe requires Content-Range bytes 0-0/TOTAL");
    }
    return positiveAssetSize(match[1], "Claude Content-Range total");
  }
  if (response.status === 200) {
    const contentLength = response.headers?.get?.("content-length");
    if (
      typeof contentLength !== "string" ||
      !/^(0|[1-9]\d*)$/.test(contentLength)
    ) {
      throw new Error(
        "Claude range-ignored response requires a canonical Content-Length",
      );
    }
    return positiveAssetSize(contentLength, "Claude Content-Length");
  }
  throw new Error("Claude range probe returned an unsupported success status");
}

async function probeRedirectAsset(fetchImpl, asset, options) {
  const response = await fetchWithRetry(
    reviewedFetch(fetchImpl),
    asset.sourceEndpoint,
    {
      method: "GET",
      headers: { range: "bytes=0-0" },
      signal: options.signal,
    },
    options.attempts ?? 3,
    probeRequestOptions(options),
  );

  try {
    if (typeof response.url !== "string" || response.url.length === 0) {
      throw new Error("Claude range probe final URL is missing");
    }
    const normalized = normalizeClaudeDownloadUrl(response.url);
    if (normalized.extension !== asset.kind) {
      throw new Error(
        `${asset.id} final basename extension does not match asset kind`,
      );
    }
    const expectedSize = probeTotal(response);
    const expectedEtag = canonicalStrongEtag(
      response.headers?.get?.("etag"),
      `${asset.id} ETag`,
    );
    return {
      id: asset.id,
      filename: asset.filename,
      sourceEndpoint: asset.sourceEndpoint,
      sourceFingerprint: sourceFingerprint(
        response.url,
        expectedSize,
        expectedEtag.hex,
      ),
      resolvedUrl: response.url,
      expectedSize,
      expectedEtag: expectedEtag.value,
    };
  } finally {
    await cancelProbeBody(
      response,
      options.probeBodyCancelTimeoutMs ??
        DEFAULT_PROBE_BODY_CANCEL_TIMEOUT_MS,
    );
  }
}

async function probeAptAsset(fetchImpl, asset, options) {
  const packages = await fetchTextWithRetry(
    reviewedFetch(fetchImpl),
    asset.sourceEndpoint,
    {
      method: "GET",
      signal: options.signal,
    },
    options.attempts ?? 3,
    {
      headerTimeoutMs: options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
      bodyTimeoutMs:
        options.probeBodyTimeoutMs ?? DEFAULT_PROBE_BODY_TIMEOUT_MS,
      backoffBaseMs: options.backoffBaseMs ?? 500,
      maxBytes: APT_INDEX_MAX_BYTES,
      allowedRedirectProtocols: PROBE_REDIRECT_PROTOCOLS,
      maxRedirects: 0,
      validateResponse(response) {
        if (
          response?.status !== 200 ||
          response.url !== asset.sourceEndpoint
        ) {
          throw new Error(`${asset.id} APT response must use the exact endpoint`);
        }
        const parsed = parseHttpsUrl(response.url, `${asset.id} APT response URL`);
        if (
          parsed.origin !== "https://downloads.claude.ai" ||
          parsed.search ||
          parsed.href !== asset.sourceEndpoint
        ) {
          throw new Error(`${asset.id} APT response URL is not reviewed`);
        }
      },
    },
  );
  const record = parseAptPackages(packages, asset);
  const resolvedUrl = `${APT_REPOSITORY_ROOT}/${record.filename}`;
  normalizeAptPoolUrl(resolvedUrl, asset);
  return {
    id: asset.id,
    filename: asset.filename,
    sourceEndpoint: asset.sourceEndpoint,
    sourceFingerprint: aptSourceFingerprint(record),
    resolvedUrl,
    expectedSize: record.size,
    expectedSha256: record.sha256,
  };
}

export async function probeClaudeAssets(fetchImpl, options = {}) {
  if (typeof fetchImpl !== "function") {
    throw new TypeError("fetchImpl must be a function");
  }
  const probes = [];
  for (const asset of ASSETS) {
    probes.push(
      asset.probeKind === "apt"
        ? await probeAptAsset(fetchImpl, asset, options)
        : await probeRedirectAsset(fetchImpl, asset, options),
    );
  }
  return probes;
}

function parseRedirectSourceFingerprint(value) {
  const match =
    typeof value === "string"
      ? /^version:((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))\|file:(Claude-([0-9a-f]{40})\.(dmg|msix))\|size:([1-9]\d*)\|etag:([0-9a-f]{32})$/.exec(
          value,
        )
      : null;
  if (!match) {
    throw new Error("Claude source fingerprint has an invalid canonical form");
  }
  return {
    version: match[1],
    basename: match[2],
    contentId: match[3],
    extension: match[4],
    size: positiveAssetSize(match[5], "Claude fingerprint size"),
    etagHex: match[6],
    etag: `"${match[6]}"`,
  };
}

function parseAptSourceFingerprint(value, definition) {
  const match =
    typeof value === "string"
      ? /^version:([^|]+)\|file:([^|]+)\|size:([1-9]\d*)\|sha256:([0-9a-f]{64})$/.exec(
          value,
        )
      : null;
  if (!match) {
    throw new Error(`${definition.id} source fingerprint has an invalid canonical form`);
  }
  const version = canonicalVersion(
    match[1],
    `${definition.id} fingerprint version`,
  );
  const filename = match[2];
  if (filename !== debPoolPath(version, definition.architecture)) {
    throw new Error(`${definition.id} fingerprint has a noncanonical pool path`);
  }
  return {
    version,
    filename,
    size: positiveAssetSize(match[3], `${definition.id} fingerprint size`),
    sha256: match[4],
  };
}

function definitionForProbe(probe) {
  const definition = ASSETS.find((asset) => asset.id === probe?.id);
  if (
    !definition ||
    probe.filename !== definition.filename ||
    probe.sourceEndpoint !== definition.sourceEndpoint
  ) {
    throw new Error(
      "changed asset must use a fixed Claude id, filename, and source endpoint",
    );
  }
  const expectedSize = positiveAssetSize(
    probe.expectedSize,
    `${definition.id} expectedSize`,
  );
  if (typeof probe.resolvedUrl !== "string" || probe.resolvedUrl.length === 0) {
    throw new Error(`${definition.id} resolved download URL is missing`);
  }
  if (definition.probeKind === "apt") {
    const normalized = normalizeAptPoolUrl(probe.resolvedUrl, definition);
    const fingerprint = parseAptSourceFingerprint(
      probe.sourceFingerprint,
      definition,
    );
    if (
      fingerprint.version !== normalized.version ||
      fingerprint.filename !== normalized.filename ||
      fingerprint.size !== expectedSize
    ) {
      throw new Error(
        `${definition.id} source fingerprint does not match DEB URL metadata`,
      );
    }
    if (
      typeof probe.expectedSha256 !== "string" ||
      !SHA256_PATTERN.test(probe.expectedSha256) ||
      probe.expectedSha256 !== fingerprint.sha256
    ) {
      throw new Error(
        `${definition.id} expectedSha256 does not match its source fingerprint`,
      );
    }
    return {
      definition,
      expectedSize,
      expectedSha256: fingerprint.sha256,
    };
  }
  const normalized = normalizeClaudeDownloadUrl(probe.resolvedUrl);
  const fingerprint = parseRedirectSourceFingerprint(probe.sourceFingerprint);
  if (
    normalized.extension !== definition.kind ||
    fingerprint.extension !== definition.kind
  ) {
    throw new Error(
      `${definition.id} download basename extension does not match asset kind`,
    );
  }
  if (
    fingerprint.version !== normalized.version ||
    fingerprint.basename !== normalized.basename ||
    fingerprint.contentId !== normalized.contentId ||
    fingerprint.size !== expectedSize
  ) {
    throw new Error(
      `${definition.id} source fingerprint does not match final URL metadata`,
    );
  }
  if (
    probe.expectedEtag !== undefined &&
    canonicalStrongEtag(
      probe.expectedEtag,
      `${definition.id} expectedEtag`,
    ).value !== fingerprint.etag
  ) {
    throw new Error(`${definition.id} expectedEtag does not match fingerprint`);
  }
  return { definition, expectedSize, expectedEtag: fingerprint.etag };
}

function stagingOptions(options, expectedSize, validateResponse) {
  return {
    attempts: options.downloadAttempts ?? options.attempts ?? 3,
    backoffBaseMs: options.backoffBaseMs,
    headerTimeoutMs: options.downloadHeaderTimeoutMs,
    inactivityTimeoutMs: options.downloadInactivityTimeoutMs,
    signal: options.signal,
    maxBytes: expectedSize + 1,
    validateResponse,
  };
}

export function createClaudeSource({
  fetchImpl,
  verifyWindowsSignature,
  probeOptions = {},
}) {
  if (typeof fetchImpl !== "function") {
    throw new TypeError("fetchImpl must be a function");
  }
  if (typeof verifyWindowsSignature !== "function") {
    throw new TypeError("verifyWindowsSignature must be a function");
  }

  return {
    probe() {
      return probeClaudeAssets(fetchImpl, probeOptions);
    },

    async stageChanged(probe, destination) {
      const metadata = definitionForProbe(probe);
      const { definition, expectedSize } = metadata;
      const noRedirectFetch = async (url, init = {}) => {
        if (definition.probeKind === "apt") {
          normalizeAptPoolUrl(String(url), definition);
        } else {
          normalizeClaudeDownloadUrl(String(url));
        }
        return await fetchImpl(url, { ...init, redirect: "manual" });
      };
      const validateResponse = (response) => {
        if (
          response?.status !== 200 ||
          typeof response.url !== "string" ||
          response.url.length === 0
        ) {
          throw new Error("Claude GET response metadata is incomplete");
        }
        const contentLength = response.headers?.get?.("content-length");
        if (
          positiveAssetSize(
            contentLength,
            `${definition.id} GET Content-Length`,
          ) !== expectedSize
        ) {
          throw new Error(
            `${definition.id} GET Content-Length does not match probe`,
          );
        }
        if (definition.probeKind === "apt") {
          normalizeAptPoolUrl(response.url, definition);
          if (response.url !== probe.resolvedUrl) {
            throw new Error(
              `${definition.id} GET URL does not match the probed pool URL`,
            );
          }
          return;
        }
        const responseEtag = canonicalStrongEtag(
          response.headers?.get?.("etag"),
          `${definition.id} GET ETag`,
        );
        if (responseEtag.value !== metadata.expectedEtag) {
          throw new Error(`${definition.id} GET ETag does not match probe`);
        }
        if (
          sourceFingerprint(
            response.url,
            expectedSize,
            responseEtag.hex,
          ) !==
          probe.sourceFingerprint
        ) {
          throw new Error(
            `${definition.id} GET final URL does not match probe fingerprint`,
          );
        }
      };

      const file = await downloadAndHash(
        noRedirectFetch,
        probe.resolvedUrl,
        destination,
        stagingOptions(probeOptions, expectedSize, validateResponse),
      );
      if (file.size !== expectedSize) {
        await rm(destination, { force: true });
        throw new Error(
          `${definition.id} downloaded size does not match expectedSize`,
        );
      }
      if (
        definition.probeKind === "apt" &&
        file.sha256 !== metadata.expectedSha256
      ) {
        await rm(destination, { force: true });
        throw new Error(
          `${definition.id} downloaded SHA256 does not match APT metadata`,
        );
      }

      if (definition.kind === "msix") {
        try {
          await verifyWindowsSignature(destination);
        } catch {
          await rm(destination, { force: true });
          throw new Error(
            `${definition.id} Windows signature verification failed`,
          );
        }
      }
      return file;
    },
  };
}
