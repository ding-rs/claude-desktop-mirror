import { rm } from "node:fs/promises";

import { downloadAndHash, fetchWithRetry } from "./http.mjs";
import { MAX_ASSET_SIZE } from "./snapshot.mjs";

const DEFAULT_PROBE_TIMEOUT_MS = 15_000;
const DEFAULT_PROBE_BODY_CANCEL_TIMEOUT_MS = 250;
const PROBE_REDIRECT_PROTOCOLS = ["https:"];
const REVIEWED_DOWNLOAD_HOSTS = new Set(["downloads.claude.ai"]);
const REVIEWED_REQUEST_HOSTS = new Set([
  "api.anthropic.com",
  "downloads.claude.ai",
]);
const STRONG_ETAG_PATTERN = /^"([0-9a-f]{32})"$/;
const CLAUDE_BASENAME_PATTERN = /^Claude-([0-9a-f]{40})\.(dmg|msix)$/;

const ASSETS = [
  {
    id: "darwin-universal-dmg",
    filename: "Claude-macOS-universal.dmg",
    sourceEndpoint:
      "https://api.anthropic.com/api/desktop/darwin/universal/dmg/latest/redirect",
    kind: "dmg",
  },
  {
    id: "win32-x64-msix",
    filename: "Claude-Windows-x64.msix",
    sourceEndpoint:
      "https://api.anthropic.com/api/desktop/win32/x64/msix/latest/redirect",
    kind: "msix",
  },
  {
    id: "win32-arm64-msix",
    filename: "Claude-Windows-arm64.msix",
    sourceEndpoint:
      "https://api.anthropic.com/api/desktop/win32/arm64/msix/latest/redirect",
    kind: "msix",
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

async function probeAsset(fetchImpl, asset, options) {
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

export async function probeClaudeAssets(fetchImpl, options = {}) {
  if (typeof fetchImpl !== "function") {
    throw new TypeError("fetchImpl must be a function");
  }
  const probes = [];
  for (const asset of ASSETS) {
    probes.push(await probeAsset(fetchImpl, asset, options));
  }
  return probes;
}

function parseSourceFingerprint(value) {
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
  const normalized = normalizeClaudeDownloadUrl(probe.resolvedUrl);
  const fingerprint = parseSourceFingerprint(probe.sourceFingerprint);
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
      const { definition, expectedSize, expectedEtag } =
        definitionForProbe(probe);
      const noRedirectFetch = async (url, init = {}) => {
        normalizeClaudeDownloadUrl(String(url));
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
        const responseEtag = canonicalStrongEtag(
          response.headers?.get?.("etag"),
          `${definition.id} GET ETag`,
        );
        if (responseEtag.value !== expectedEtag) {
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
