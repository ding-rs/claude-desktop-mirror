import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";

import {
  createClaudeSource,
  parseClaudeVersion,
  probeClaudeAssets,
} from "../scripts/lib/claude-sources.mjs";
import { fetchJsonWithRetry } from "../scripts/lib/http.mjs";

const MAX_ASSET_SIZE = 2 * 1024 ** 3;
const CONTENT_ID = "a".repeat(40);
const REPLACEMENT_CONTENT_ID = "c".repeat(40);
const VALID_ETAG = `"${"b".repeat(32)}"`;
const REPLACEMENT_ETAG = `"${"d".repeat(32)}"`;
const VALID_SHA256 = "e".repeat(64);
const REPLACEMENT_SHA256 = "f".repeat(64);
const REDIRECT_ASSETS = [
  {
    id: "darwin-universal-dmg",
    filename: "Claude-macOS-universal.dmg",
    endpoint:
      "https://api.anthropic.com/api/desktop/darwin/universal/dmg/latest/redirect",
    finalName: `Claude-${CONTENT_ID}.dmg`,
  },
  {
    id: "win32-x64-msix",
    filename: "Claude-Windows-x64.msix",
    endpoint:
      "https://api.anthropic.com/api/desktop/win32/x64/msix/latest/redirect",
    finalName: `Claude-${CONTENT_ID}.msix`,
  },
  {
    id: "win32-arm64-msix",
    filename: "Claude-Windows-arm64.msix",
    endpoint:
      "https://api.anthropic.com/api/desktop/win32/arm64/msix/latest/redirect",
    finalName: `Claude-${CONTENT_ID}.msix`,
  },
];
const DEB_ASSETS = [
  {
    id: "linux-x64-deb",
    filename: "Claude-Linux-x64.deb",
    endpoint:
      "https://downloads.claude.ai/claude-desktop/apt/stable/dists/stable/main/binary-amd64/Packages",
    architecture: "amd64",
  },
  {
    id: "linux-arm64-deb",
    filename: "Claude-Linux-arm64.deb",
    endpoint:
      "https://downloads.claude.ai/claude-desktop/apt/stable/dists/stable/main/binary-arm64/Packages",
    architecture: "arm64",
  },
];
const ASSETS = [...REDIRECT_ASSETS, ...DEB_ASSETS];

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function responseWithUrl(body, init, url) {
  const response = new Response(body, init);
  Object.defineProperty(response, "url", { value: url });
  return response;
}

function finalUrl(asset, {
  version = "1.2.3",
  basename = asset.finalName,
  host = "downloads.claude.ai",
  query = "token=signed-secret",
} = {}) {
  return `https://${host}/releases/${version}/${basename}${query ? `?${query}` : ""}`;
}

function rangeResponse(asset, options = {}) {
  const total = options.total ?? 101;
  const status = options.status ?? 206;
  const url = options.url ?? finalUrl(asset);
  const headers =
    options.headers ??
    (status === 206
      ? {
          "content-range": `bytes 0-0/${total}`,
          etag: options.etag ?? VALID_ETAG,
        }
      : {
          "content-length": String(total),
          etag: options.etag ?? VALID_ETAG,
        });
  return responseWithUrl(options.body ?? Uint8Array.of(1), { status, headers }, url);
}

function poolPath(asset, version = "1.2.3") {
  return `pool/main/c/claude-desktop/claude-desktop_${version}_${asset.architecture}.deb`;
}

function poolUrl(asset, version = "1.2.3") {
  return `https://downloads.claude.ai/claude-desktop/apt/stable/${poolPath(asset, version)}`;
}

function packageRecord(asset, overrides = {}) {
  const version = overrides.Version ?? "1.2.3";
  const fields = {
    Package: "claude-desktop",
    Version: version,
    Architecture: asset.architecture,
    Filename: poolPath(asset, version),
    Size: "5",
    SHA256: VALID_SHA256,
    ...overrides,
  };
  return Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([name, value]) => `${name}: ${value}`)
    .join("\n");
}

function packagesResponse(asset, records = [packageRecord(asset)], options = {}) {
  const body = options.body ?? `${records.join("\n\n")}\n`;
  return responseWithUrl(body, {
    status: options.status ?? 200,
    headers: options.headers ?? {
      "content-length": String(Buffer.byteLength(body)),
    },
  }, options.url ?? asset.endpoint);
}

function successfulProbeFetch({ packageRecords } = {}) {
  return async (url) => {
    const asset = ASSETS.find((candidate) => candidate.endpoint === String(url));
    assert.ok(asset, `unexpected Claude source URL: ${String(url)}`);
    if (asset.architecture) {
      return packagesResponse(
        asset,
        packageRecords?.get(asset.id) ?? [packageRecord(asset)],
      );
    }
    return rangeResponse(asset);
  };
}

function probeFor(asset, overrides = {}) {
  const expectedSize = overrides.expectedSize ?? 5;
  if (asset.architecture) {
    const version = overrides.version ?? "1.2.3";
    const expectedSha256 = overrides.expectedSha256 ?? VALID_SHA256;
    const resolvedUrl = overrides.resolvedUrl ?? poolUrl(asset, version);
    const filename = overrides.poolPath ?? poolPath(asset, version);
    return {
      id: asset.id,
      filename: asset.filename,
      sourceEndpoint: asset.endpoint,
      sourceFingerprint:
        overrides.sourceFingerprint ??
        `version:${version}|file:${filename}|size:${expectedSize}|sha256:${expectedSha256}`,
      resolvedUrl,
      expectedSize,
      expectedSha256,
      ...overrides,
    };
  }
  const expectedEtag = overrides.expectedEtag ?? VALID_ETAG;
  const resolvedUrl = overrides.resolvedUrl ?? finalUrl(asset);
  const parsed = new URL(resolvedUrl);
  const basename = decodeURIComponent(parsed.pathname.split("/").at(-1));
  const version = parseClaudeVersion(resolvedUrl);
  return {
    id: asset.id,
    filename: asset.filename,
    sourceEndpoint: asset.endpoint,
    sourceFingerprint:
      overrides.sourceFingerprint ??
      `version:${version}|file:${basename}|size:${expectedSize}|etag:${expectedEtag.slice(1, -1)}`,
    resolvedUrl,
    expectedSize,
    expectedEtag,
    ...overrides,
  };
}

async function withTempDir(run) {
  const directory = await mkdtemp(join(tmpdir(), "claude-source-test-"));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function downloadFetchFor(probe, bytes, {
  responseUrl = probe.resolvedUrl,
  contentLength = bytes.length,
  etag = probe.expectedEtag ?? null,
  onRequest = () => {},
  body = bytes,
} = {}) {
  return async (url, init = {}) => {
    onRequest(String(url), init);
    return {
      ok: true,
      status: 200,
      url: responseUrl,
      headers: new Headers({
        "content-length": String(contentLength),
        ...(etag === null ? {} : { etag }),
      }),
      body:
        body instanceof ReadableStream
          ? body
          : new Blob([body]).stream(),
    };
  };
}

test("parseClaudeVersion accepts one canonical numeric release segment", () => {
  assert.equal(
    parseClaudeVersion(
      "https://downloads.claude.ai/releases/1.2.3/Claude.dmg?token=secret",
    ),
    "1.2.3",
  );
  assert.equal(
    parseClaudeVersion(
      "https://downloads.claude.ai/desktop/2026.10.0/win/Claude.msix",
    ),
    "2026.10.0",
  );
  assert.equal(
    parseClaudeVersion(
      "https://downloads.claude.ai/releases/1.2.3/Claude.dmg?X-Amz-Signature=a%2Fb%3Dc",
    ),
    "1.2.3",
  );
});

test("parseClaudeVersion rejects noncanonical raw HTTPS spellings before normalization", () => {
  for (const value of [
    "https:downloads.claude.ai/releases/1.2.3/Claude.dmg",
    "https:///downloads.claude.ai/releases/1.2.3/Claude.dmg",
    "https:\\downloads.claude.ai\\releases\\1.2.3\\Claude.dmg",
    "HTTPS://downloads.claude.ai/releases/1.2.3/Claude.dmg",
    "https://downloads.claude.ai/releases/1.2.3/Claude.dmg?token=bad\\value",
  ]) {
    assert.throws(
      () => parseClaudeVersion(value),
      /literal https|canonical HTTPS|backslash|unsafe/i,
    );
  }
});

test("parseClaudeVersion rejects unsafe, missing, noncanonical, and ambiguous URLs", () => {
  for (const value of [
    "http://downloads.claude.ai/releases/1.2.3/Claude.dmg",
    "https://user:pass@downloads.claude.ai/releases/1.2.3/Claude.dmg",
    "https://downloads.claude.ai/releases/latest/Claude.dmg",
    "https://downloads.claude.ai/releases/01.2.3/Claude.dmg",
    "https://downloads.claude.ai/releases/1.2/Claude.dmg",
    "https://downloads.claude.ai/1.2.3/archive/2.3.4/Claude.dmg",
    "https://downloads.claude.ai/releases/../1.2.3/Claude.dmg",
    "https://downloads.claude.ai/releases\\..\\1.2.3\\Claude.dmg",
    "https://downloads.claude.ai/releases/%2e%2e/1.2.3/Claude.dmg",
    `https://downloads.claude.ai/releases/%31.2.3/Claude-${CONTENT_ID}.dmg`,
    `https://downloads.claude.ai/releases%2F1.2.3/Claude-${CONTENT_ID}.dmg`,
    `https://downloads.claude.ai/releases/1.2.3/Claude-${CONTENT_ID}%2Edmg`,
    `https://downloads.claude.ai/releases/%252e%252e/1.2.3/Claude-${CONTENT_ID}.dmg`,
    `https://downloads.claude.ai/releases/1.2.3/Claude-${CONTENT_ID}.dmg#`,
    "https://downloads.claude.ai/releases/1.2.3/Claude.dmg#fragment",
    "https://[invalid",
  ]) {
    assert.throws(() => parseClaudeVersion(value), /Claude version|HTTPS|unsafe|ambiguous/i);
  }
});

test("bounded JSON metadata parsing remains unchanged when the reader is shared with UTF-8 text", async () => {
  const url = "https://example.test/metadata?token=secret";
  const fetchImpl = async () => responseWithUrl('{"ok":true}', {
    status: 200,
    headers: { "content-length": "11" },
  }, url);
  assert.deepEqual(
    await fetchJsonWithRetry(fetchImpl, url, {}, 1, {
      backoffBaseMs: 0,
      maxBytes: 11,
    }),
    { ok: true },
  );

  await assert.rejects(
    fetchJsonWithRetry(fetchImpl, url, {}, 1, {
      backoffBaseMs: 0,
      maxBytes: 10,
    }),
    (error) => {
      assert.match(error.message, /metadata exceeds 10 bytes/i);
      assert.doesNotMatch(error.message, /token=secret/i);
      return true;
    },
  );
});

test("Claude probes return the exact ordered five-asset contract using three ranges and two bounded indexes", async () => {
  const calls = [];
  const bodies = [];
  const fetchImpl = async (url, init = {}) => {
    const asset = ASSETS.find((candidate) => candidate.endpoint === String(url));
    assert.ok(asset);
    calls.push({ url: String(url), init });
    if (asset.architecture) return packagesResponse(asset);

    let pulls = 0;
    let cancelled = 0;
    const body = {
      getReader() {
        pulls += 1;
        throw new Error("range body must not be read");
      },
      cancel() {
        cancelled += 1;
        return Promise.resolve();
      },
    };
    bodies.push({ get pulls() { return pulls; }, get cancelled() { return cancelled; } });
    return {
      ok: true,
      status: 206,
      url: finalUrl(asset),
      headers: new Headers({
        "content-range": `bytes 0-0/${100 + calls.length}`,
        etag: VALID_ETAG,
      }),
      body,
    };
  };

  const probes = await probeClaudeAssets(fetchImpl, {
    attempts: 1,
    backoffBaseMs: 0,
  });

  assert.deepEqual(
    probes.map(({ id, filename, sourceEndpoint, sourceFingerprint, expectedSize }) => ({
      id,
      filename,
      sourceEndpoint,
      sourceFingerprint,
      expectedSize,
    })),
    [
      ...REDIRECT_ASSETS.map((asset, index) => ({
        id: asset.id,
        filename: asset.filename,
        sourceEndpoint: asset.endpoint,
        sourceFingerprint:
          `version:1.2.3|file:${asset.finalName}|size:${101 + index}|etag:${VALID_ETAG.slice(1, -1)}`,
        expectedSize: 101 + index,
      })),
      ...DEB_ASSETS.map((asset) => ({
        id: asset.id,
        filename: asset.filename,
        sourceEndpoint: asset.endpoint,
        sourceFingerprint:
          `version:1.2.3|file:${poolPath(asset)}|size:5|sha256:${VALID_SHA256}`,
        expectedSize: 5,
      })),
    ],
  );
  assert.deepEqual(
    probes.slice(0, 3).map((probe) => probe.expectedEtag),
    [VALID_ETAG, VALID_ETAG, VALID_ETAG],
  );
  assert.deepEqual(
    probes.slice(3).map(({ resolvedUrl, expectedSha256 }) => ({
      resolvedUrl,
      expectedSha256,
    })),
    DEB_ASSETS.map((asset) => ({
      resolvedUrl: poolUrl(asset),
      expectedSha256: VALID_SHA256,
    })),
  );
  assert.deepEqual(calls.map((call) => call.url), ASSETS.map((asset) => asset.endpoint));
  for (const [index, { init }] of calls.entries()) {
    assert.equal(init.method, "GET");
    assert.equal(
      new Headers(init.headers).get("range"),
      index < REDIRECT_ASSETS.length ? "bytes=0-0" : null,
    );
    assert.equal(init.redirect, "manual");
  }
  assert.ok(bodies.every((body) => body.pulls === 0));
  assert.ok(bodies.every((body) => body.cancelled === 1));
});

test("probe accepts a range-ignored 200 only with a trusted bounded Content-Length and cancels immediately", async () => {
  const bodies = [];
  const probes = await probeClaudeAssets(async (url) => {
    const asset = ASSETS.find((candidate) => candidate.endpoint === String(url));
    if (asset.architecture) return packagesResponse(asset);
    let pulls = 0;
    let cancelled = 0;
    const body = {
      getReader() {
        pulls += 1;
        throw new Error("range-ignored body must not be read");
      },
      cancel() {
        cancelled += 1;
        return Promise.resolve();
      },
    };
    bodies.push({ get pulls() { return pulls; }, get cancelled() { return cancelled; } });
    return {
      ok: true,
      status: 200,
      url: finalUrl(asset),
      headers: new Headers({
        "content-length": "777",
        etag: VALID_ETAG,
      }),
      body,
    };
  }, { attempts: 1, backoffBaseMs: 0 });

  assert.ok(probes.slice(0, 3).every((probe) => probe.expectedSize === 777));
  assert.ok(probes.slice(3).every((probe) => probe.expectedSize === 5));
  assert.ok(bodies.every((body) => body.pulls === 0));
  assert.ok(bodies.every((body) => body.cancelled === 1));
});

test("probe requires a canonical strong 32-hex ETag", async () => {
  for (const etag of [
    null,
    "",
    `W/"${"b".repeat(32)}"`,
    `"${"B".repeat(32)}"`,
    `"${"b".repeat(31)}"`,
    "b".repeat(32),
  ]) {
    await assert.rejects(
      probeClaudeAssets(async (url) => {
        const asset = REDIRECT_ASSETS.find((candidate) => candidate.endpoint === String(url));
        return rangeResponse(asset, {
          headers: {
            "content-range": "bytes 0-0/101",
            ...(etag === null ? {} : { etag }),
          },
        });
      }, { attempts: 1, backoffBaseMs: 0 }),
      /ETag|stable.*identity/i,
    );
  }
});

test("same-version same-size replacements change identity when ETag changes", async () => {
  const probeWithEtag = (etag) =>
    probeClaudeAssets(async (url) => {
      const asset = ASSETS.find((candidate) => candidate.endpoint === String(url));
      if (asset.architecture) return packagesResponse(asset);
      return rangeResponse(asset, { total: 101, etag });
    }, { attempts: 1, backoffBaseMs: 0 });

  const before = await probeWithEtag(VALID_ETAG);
  const after = await probeWithEtag(REPLACEMENT_ETAG);
  assert.deepEqual(
    before.map(({ resolvedUrl, expectedSize }) => ({ resolvedUrl, expectedSize })),
    after.map(({ resolvedUrl, expectedSize }) => ({ resolvedUrl, expectedSize })),
  );
  assert.ok(
    before.slice(0, 3).every(
      (probe, index) =>
        probe.sourceFingerprint !== after[index].sourceFingerprint,
    ),
  );
  assert.deepEqual(
    before.slice(3).map((probe) => probe.sourceFingerprint),
    after.slice(3).map((probe) => probe.sourceFingerprint),
  );
  assert.ok(before.slice(0, 3).every((probe) => probe.expectedEtag === VALID_ETAG));
  assert.ok(after.slice(0, 3).every((probe) => probe.expectedEtag === REPLACEMENT_ETAG));
});

test("probe cancellation is bounded when an injected body never settles", async () => {
  let cancelCalls = 0;
  const started = Date.now();
  const probes = await probeClaudeAssets(async (url) => {
    const asset = ASSETS.find((candidate) => candidate.endpoint === String(url));
    if (asset.architecture) return packagesResponse(asset);
    return {
      ok: true,
      status: 206,
      url: finalUrl(asset),
      headers: new Headers({
        "content-range": "bytes 0-0/100",
        etag: VALID_ETAG,
      }),
      body: {
        cancel() {
          cancelCalls += 1;
          return new Promise(() => {});
        },
      },
    };
  }, {
    attempts: 1,
    backoffBaseMs: 0,
    probeBodyCancelTimeoutMs: 5,
  });

  assert.equal(probes.length, 5);
  assert.equal(cancelCalls, 3);
  assert.ok(Date.now() - started < 500);
});

test("APT probes select the greatest canonical version numerically and independently", async () => {
  const packageRecords = new Map([
    [DEB_ASSETS[0].id, [
      packageRecord(DEB_ASSETS[0], { Version: "1.9.99", Filename: poolPath(DEB_ASSETS[0], "1.9.99") }),
      packageRecord(DEB_ASSETS[0], { Version: "1.10.0", Filename: poolPath(DEB_ASSETS[0], "1.10.0"), Size: "17", SHA256: REPLACEMENT_SHA256 }),
      packageRecord(DEB_ASSETS[0], { Version: "1.2.100", Filename: poolPath(DEB_ASSETS[0], "1.2.100") }),
    ]],
    [DEB_ASSETS[1].id, [
      packageRecord(DEB_ASSETS[1], { Version: "9.99.99", Filename: poolPath(DEB_ASSETS[1], "9.99.99") }),
      packageRecord(DEB_ASSETS[1], { Version: "10.0.0", Filename: poolPath(DEB_ASSETS[1], "10.0.0"), Size: "23" }),
    ]],
  ]);

  const probes = await probeClaudeAssets(successfulProbeFetch({ packageRecords }), {
    attempts: 1,
    backoffBaseMs: 0,
  });

  assert.deepEqual(
    probes.slice(3).map(({ id, sourceFingerprint, resolvedUrl, expectedSize, expectedSha256 }) => ({
      id,
      sourceFingerprint,
      resolvedUrl,
      expectedSize,
      expectedSha256,
    })),
    [
      {
        id: "linux-x64-deb",
        sourceFingerprint:
          `version:1.10.0|file:${poolPath(DEB_ASSETS[0], "1.10.0")}|size:17|sha256:${REPLACEMENT_SHA256}`,
        resolvedUrl: poolUrl(DEB_ASSETS[0], "1.10.0"),
        expectedSize: 17,
        expectedSha256: REPLACEMENT_SHA256,
      },
      {
        id: "linux-arm64-deb",
        sourceFingerprint:
          `version:10.0.0|file:${poolPath(DEB_ASSETS[1], "10.0.0")}|size:23|sha256:${VALID_SHA256}`,
        resolvedUrl: poolUrl(DEB_ASSETS[1], "10.0.0"),
        expectedSize: 23,
        expectedSha256: VALID_SHA256,
      },
    ],
  );
});

test("APT probes accept valid Debian continuation lines on descriptive fields", async () => {
  const asset = DEB_ASSETS[0];
  const record = [
    packageRecord(asset),
    "Description: Desktop application for Claude.ai",
    " Desktop application for Claude.ai",
  ].join("\n");
  const probes = await probeClaudeAssets(successfulProbeFetch({
    packageRecords: new Map([[asset.id, [record]]]),
  }), {
    attempts: 1,
    backoffBaseMs: 0,
  });

  assert.equal(probes[3].id, asset.id);
  assert.equal(probes[3].sourceFingerprint,
    `version:1.2.3|file:${poolPath(asset)}|size:5|sha256:${VALID_SHA256}`);
});

test("APT probes reject duplicate fields, duplicate versions, malformed records, and wrong package metadata", async () => {
  const asset = DEB_ASSETS[0];
  const valid = packageRecord(asset);
  const cases = [
    ["duplicate field", [`${valid}\nSize: 5`]],
    ["duplicate version", [valid, valid]],
    ["malformed control line", [`${valid}\nnot-a-field`]],
    ["missing field", [packageRecord(asset, { SHA256: undefined })]],
    ["wrong package", [packageRecord(asset, { Package: "other-package" })]],
    ["wrong architecture", [packageRecord(asset, { Architecture: "arm64" })]],
    ["empty index", []],
  ];

  for (const [name, records] of cases) {
    const fetchImpl = successfulProbeFetch({
      packageRecords: new Map([[asset.id, records]]),
    });
    await assert.rejects(
      probeClaudeAssets(fetchImpl, { attempts: 1, backoffBaseMs: 0 }),
      /APT|Packages|record|field|duplicate|package|architecture|ambiguous|missing/i,
      name,
    );
  }
});

test("APT probes reject noncanonical versions, sizes, checksums, and unsafe pool paths", async () => {
  const asset = DEB_ASSETS[0];
  const cases = [
    { Version: "01.2.3", Filename: poolPath(asset, "01.2.3") },
    { Version: "1.2", Filename: "pool/main/c/claude-desktop/claude-desktop_1.2_amd64.deb" },
    { Size: "0" },
    { Size: "05" },
    { Size: String(MAX_ASSET_SIZE) },
    { SHA256: "E".repeat(64) },
    { SHA256: "e".repeat(63) },
    { Filename: `/claude-desktop/apt/stable/${poolPath(asset)}` },
    { Filename: `pool/main/c/claude-desktop/../${poolPath(asset)}` },
    { Filename: poolPath(asset).replace("pool/", "pool%2f") },
    { Filename: poolPath(asset).replaceAll("/", "\\") },
    { Filename: `${poolPath(asset)}?token=secret` },
    { Filename: `${poolPath(asset)}#fragment` },
  ];

  for (const overrides of cases) {
    const fetchImpl = successfulProbeFetch({
      packageRecords: new Map([[asset.id, [packageRecord(asset, overrides)]]]),
    });
    await assert.rejects(
      probeClaudeAssets(fetchImpl, { attempts: 1, backoffBaseMs: 0 }),
      /version|Size|2 GiB|SHA256|Filename|path|canonical|unsafe|APT/i,
      JSON.stringify(overrides),
    );
  }
});

test("APT index responses must remain the exact reviewed HTTPS endpoint without redirects", async () => {
  const asset = DEB_ASSETS[0];
  for (const url of [
    `${asset.endpoint}?token=secret`,
    asset.endpoint.replace("/Packages", "/other"),
    asset.endpoint.replace("downloads.claude.ai", "evil.example"),
    asset.endpoint.replace("https://", "http://"),
  ]) {
    const fetchImpl = async (requested) => {
      const definition = ASSETS.find((candidate) => candidate.endpoint === String(requested));
      if (!definition.architecture) return rangeResponse(definition);
      return packagesResponse(definition, undefined, { url });
    };
    await assert.rejects(
      probeClaudeAssets(fetchImpl, { attempts: 1, backoffBaseMs: 0 }),
      /APT|Packages|endpoint|HTTPS|reviewed|URL/i,
    );
  }

  const calls = [];
  await assert.rejects(
    probeClaudeAssets(async (requested) => {
      const definition = ASSETS.find((candidate) => candidate.endpoint === String(requested));
      calls.push(String(requested));
      if (!definition.architecture) return rangeResponse(definition);
      return responseWithUrl(null, {
        status: 302,
        headers: { location: poolUrl(definition) },
      }, definition.endpoint);
    }, { attempts: 1, backoffBaseMs: 0 }),
    /redirect|HTTP 302/i,
  );
  assert.deepEqual(calls, [
    ...REDIRECT_ASSETS.map((definition) => definition.endpoint),
    DEB_ASSETS[0].endpoint,
  ]);
});

test("APT index reads are capped at 1 MiB, cancel rejected bodies, and sanitize body failures", async () => {
  const asset = DEB_ASSETS[0];
  let cancellations = 0;
  const oversizedFetch = async (requested) => {
    const definition = ASSETS.find((candidate) => candidate.endpoint === String(requested));
    if (!definition.architecture) return rangeResponse(definition);
    return {
      ok: true,
      status: 200,
      url: definition.endpoint,
      headers: new Headers({ "content-length": String(1024 ** 2 + 1) }),
      body: {
        getReader() {
          assert.fail("oversized APT body must not be read");
        },
        cancel() {
          cancellations += 1;
          return Promise.resolve();
        },
      },
    };
  };
  await assert.rejects(
    probeClaudeAssets(oversizedFetch, { attempts: 1, backoffBaseMs: 0 }),
    /1048576|1 MiB|too large|exceeds/i,
  );
  assert.equal(cancellations, 1);

  const failingFetch = async (requested) => {
    const definition = ASSETS.find((candidate) => candidate.endpoint === String(requested));
    if (!definition.architecture) return rangeResponse(definition);
    const body = new ReadableStream({
      pull(controller) {
        controller.error(new Error("token=must-not-leak"));
      },
    });
    return {
      ok: true,
      status: 200,
      url: asset.endpoint,
      headers: new Headers(),
      body,
    };
  };
  await assert.rejects(
    probeClaudeAssets(failingFetch, { attempts: 1, backoffBaseMs: 0 }),
    (error) => {
      assert.doesNotMatch(error.message, /must-not-leak|token=/i);
      assert.match(error.message, /metadata|body|APT|Packages/i);
      return true;
    },
  );

});

test("APT index body timeout is absolute and cancels the hanging body", async () => {
  let timeoutCancellations = 0;
  const hangingFetch = async (requested) => {
    const definition = ASSETS.find((candidate) => candidate.endpoint === String(requested));
    if (!definition.architecture) return rangeResponse(definition);
    return {
      ok: true,
      status: 200,
      url: definition.endpoint,
      headers: new Headers(),
      body: new ReadableStream({
        cancel() {
          timeoutCancellations += 1;
        },
      }),
    };
  };
  await assert.rejects(
    probeClaudeAssets(hangingFetch, {
      attempts: 1,
      backoffBaseMs: 0,
      probeBodyTimeoutMs: 5,
    }),
    /timed out|timeout/i,
  );
  assert.equal(timeoutCancellations, 1);
});

test("APT index GET retries transient failures and rejects invalid UTF-8", async () => {
  let aptCalls = 0;
  const retryingFetch = async (requested) => {
    const definition = ASSETS.find((candidate) => candidate.endpoint === String(requested));
    if (!definition.architecture) return rangeResponse(definition);
    aptCalls += 1;
    if (aptCalls === 1) {
      return responseWithUrl(null, { status: 503 }, definition.endpoint);
    }
    return packagesResponse(definition);
  };
  const probes = await probeClaudeAssets(retryingFetch, {
    attempts: 2,
    backoffBaseMs: 0,
  });
  assert.equal(probes.length, 5);
  assert.equal(aptCalls, 3);

  const invalidUtf8Fetch = async (requested) => {
    const definition = ASSETS.find((candidate) => candidate.endpoint === String(requested));
    if (!definition.architecture) return rangeResponse(definition);
    return responseWithUrl(Uint8Array.of(0xff), {
      status: 200,
      headers: { "content-length": "1" },
    }, definition.endpoint);
  };
  await assert.rejects(
    probeClaudeAssets(invalidUtf8Fetch, { attempts: 1, backoffBaseMs: 0 }),
    /UTF-8|text|metadata|APT/i,
  );
});

test("probe rejects HTTPS downgrade before fetching the redirect target", async () => {
  const calls = [];
  await assert.rejects(
    probeClaudeAssets(async (url) => {
      calls.push(String(url));
      return responseWithUrl(null, {
        status: 302,
        headers: { location: "http://downloads.claude.ai/releases/1.2.3/Claude.dmg" },
      }, String(url));
    }, { attempts: 1, backoffBaseMs: 0 }),
    /HTTPS|protocol|redirect/i,
  );
  assert.deepEqual(calls, [ASSETS[0].endpoint]);
});

test("probe blocks an unreviewed intermediate redirect host before underlying fetch", async () => {
  const calls = [];
  await assert.rejects(
    probeClaudeAssets(async (url) => {
      const requested = String(url);
      calls.push(requested);
      if (requested === ASSETS[0].endpoint) {
        return responseWithUrl(null, {
          status: 302,
          headers: { location: "https://evil.example/intermediate" },
        }, requested);
      }
      if (requested === "https://evil.example/intermediate") {
        return responseWithUrl(null, {
          status: 302,
          headers: { location: finalUrl(ASSETS[0]) },
        }, requested);
      }
      return rangeResponse(ASSETS[0]);
    }, { attempts: 1, backoffBaseMs: 0 }),
    /reviewed|request failed/i,
  );
  assert.deepEqual(calls, [ASSETS[0].endpoint]);
});

test("probe rejects missing, malformed, and credentialed redirect locations", async () => {
  for (const location of [
    null,
    "https://[invalid",
    "https://user:pass@downloads.claude.ai/releases/1.2.3/Claude.dmg",
  ]) {
    let calls = 0;
    await assert.rejects(
      probeClaudeAssets(async (url) => {
        calls += 1;
        return responseWithUrl(null, {
          status: 302,
          headers: location === null ? {} : { location },
        }, String(url));
      }, { attempts: 1, backoffBaseMs: 0 }),
      /redirect|Location|credential|invalid/i,
    );
    assert.equal(calls, 1);
  }
});

test("probe caps redirect chains at five and never follows a sixth hop", async () => {
  let calls = 0;
  await assert.rejects(
    probeClaudeAssets(async (url) => {
      calls += 1;
      return responseWithUrl(null, {
        status: 302,
        headers: { location: `https://api.anthropic.com/hop-${calls}` },
      }, String(url));
    }, { attempts: 1, backoffBaseMs: 0 }),
    /too many redirects/i,
  );
  assert.equal(calls, 6);
});

test("probe options cannot relax the reviewed five-redirect ceiling", async () => {
  let calls = 0;
  await assert.rejects(
    probeClaudeAssets(async () => {
      calls += 1;
      throw new Error("fetch must not run");
    }, {
      attempts: 1,
      backoffBaseMs: 0,
      maxRedirects: 6,
    }),
    /maxRedirects.*0.*5|redirect.*ceiling/i,
  );
  assert.equal(calls, 0);
});

test("probe fails closed for unreviewed hosts, unsafe basenames, and invalid versions", async () => {
  const badUrls = [
    `https://evil.example/releases/1.2.3/Claude-${CONTENT_ID}.dmg`,
    `https://downloads.claude.ai/releases/latest/Claude-${CONTENT_ID}.dmg`,
    "https://downloads.claude.ai/releases/1.2.3/",
    "https://downloads.claude.ai/releases/1.2.3/%2fetc",
    "https://downloads.claude.ai/releases/1.2.3/Claude%7Cevil.dmg",
    `https://downloads.claude.ai/releases/1.2.3/Claude-${"a".repeat(39)}.dmg`,
    `https://downloads.claude.ai/releases/1.2.3/Claude-${"A".repeat(40)}.dmg`,
    `https://downloads.claude.ai/1.2.3/2.3.4/Claude-${CONTENT_ID}.dmg`,
  ];
  for (const url of badUrls) {
    await assert.rejects(
      probeClaudeAssets(async (requested) => {
        const asset = ASSETS.find((candidate) => candidate.endpoint === String(requested));
        return rangeResponse(asset, { url });
      }, { attempts: 1, backoffBaseMs: 0 }),
      /host|basename|version|ambiguous|unsafe/i,
    );
  }
});

test("206 probes require exactly bytes 0-0/TOTAL with a positive sub-2-GiB total", async () => {
  for (const contentRange of [
    null,
    "bytes 0-1/100",
    "bytes 1-1/100",
    "bytes 0-0/*",
    "bytes 0-0/0",
    `bytes 0-0/${MAX_ASSET_SIZE}`,
    "bytes 0-0/01",
    "Bytes 0-0/100",
  ]) {
    await assert.rejects(
      probeClaudeAssets(async (url) => {
        const asset = ASSETS.find((candidate) => candidate.endpoint === String(url));
        return rangeResponse(asset, {
          headers: contentRange === null ? {} : { "content-range": contentRange },
        });
      }, { attempts: 1, backoffBaseMs: 0 }),
      /Content-Range|2 GiB|size/i,
    );
  }
});

test("range-ignored 200 rejects missing, malformed, zero, and oversized Content-Length", async () => {
  for (const contentLength of [null, "", "0", "-1", "1.5", String(MAX_ASSET_SIZE)]) {
    await assert.rejects(
      probeClaudeAssets(async (url) => {
        const asset = ASSETS.find((candidate) => candidate.endpoint === String(url));
        return rangeResponse(asset, {
          status: 200,
          headers: contentLength === null ? {} : { "content-length": contentLength },
        });
      }, { attempts: 1, backoffBaseMs: 0 }),
      /Content-Length|2 GiB|size/i,
    );
  }
});

test("probe rejects non-success statuses through the bounded retry helper", async () => {
  let calls = 0;
  await assert.rejects(
    probeClaudeAssets(async (url) => {
      calls += 1;
      const asset = ASSETS.find((candidate) => candidate.endpoint === String(url));
      return responseWithUrl(null, { status: 503 }, finalUrl(asset));
    }, { attempts: 2, backoffBaseMs: 0 }),
    /HTTP 503/,
  );
  assert.equal(calls, 2);
});

test("stage rejects malformed probe metadata before any GET", async () => {
  const cases = [
    { ...probeFor(ASSETS[0]), sourceEndpoint: "https://evil.example/source" },
    { ...probeFor(ASSETS[0]), filename: "wrong.dmg" },
    { ...probeFor(ASSETS[0]), resolvedUrl: "https://evil.example/releases/1.2.3/Claude.dmg" },
    { ...probeFor(ASSETS[0]), sourceFingerprint: "version:9.9.9|file:Claude.dmg|size:5" },
    { ...probeFor(ASSETS[0]), expectedSize: 0 },
    { ...probeFor(ASSETS[0]), expectedSize: MAX_ASSET_SIZE },
  ];
  for (const probe of cases) {
    let calls = 0;
    const source = createClaudeSource({
      fetchImpl: async () => {
        calls += 1;
        throw new Error("must not fetch");
      },
      verifyWindowsSignature: async () => {},
      probeOptions: { downloadAttempts: 1, backoffBaseMs: 0 },
    });
    await assert.rejects(
      source.stageChanged(probe, "/tmp/unused-claude-test"),
      /fixed|endpoint|host|fingerprint|expectedSize|2 GiB/i,
    );
    assert.equal(calls, 0);
  }
});

test("DEB stage validates fixed metadata, exact pool URL, size, and repository checksum before any GET", async () => {
  const asset = DEB_ASSETS[0];
  const valid = probeFor(asset);
  const cases = [
    { ...valid, sourceEndpoint: DEB_ASSETS[1].endpoint },
    { ...valid, filename: "wrong.deb" },
    { ...valid, resolvedUrl: poolUrl(asset).replace("downloads.claude.ai", "evil.example") },
    { ...valid, resolvedUrl: `${poolUrl(asset)}?token=secret` },
    { ...valid, resolvedUrl: poolUrl(asset).replace("_amd64.deb", "_arm64.deb") },
    { ...valid, resolvedUrl: poolUrl(asset).replace("pool/", "pool%2f") },
    { ...valid, sourceFingerprint: `version:1.2.3|file:${poolPath(asset)}|size:5|sha256:${"E".repeat(64)}` },
    { ...valid, sourceFingerprint: `version:1.2.4|file:${poolPath(asset)}|size:5|sha256:${VALID_SHA256}` },
    { ...valid, expectedSize: 0 },
    { ...valid, expectedSize: MAX_ASSET_SIZE },
    { ...valid, expectedSha256: REPLACEMENT_SHA256 },
    { ...valid, expectedSha256: undefined },
  ];

  for (const probe of cases) {
    let calls = 0;
    const source = createClaudeSource({
      fetchImpl: async () => {
        calls += 1;
        throw new Error("must not fetch");
      },
      verifyWindowsSignature: async () => {},
      probeOptions: { downloadAttempts: 1, backoffBaseMs: 0 },
    });
    await assert.rejects(
      source.stageChanged(probe, "/tmp/unused-claude-deb-test"),
      /fixed|endpoint|host|URL|fingerprint|expectedSize|SHA256|checksum|2 GiB|unsafe|canonical/i,
    );
    assert.equal(calls, 0);
  }
});

test("stage binds GET final host, version, basename, and size before reading the body", async () => {
  await withTempDir(async (root) => {
    const probe = probeFor(ASSETS[0]);
    for (const responseUrl of [
      "https://evil.example/releases/1.2.3/Claude.dmg",
      finalUrl(ASSETS[0], { version: "1.2.4" }),
      finalUrl(ASSETS[0], { basename: "Other.dmg" }),
    ]) {
      let pulls = 0;
      const body = {
        getReader() {
          pulls += 1;
          throw new Error("must not read rejected body");
        },
        cancel() {
          return Promise.resolve();
        },
      };
      const source = createClaudeSource({
        fetchImpl: downloadFetchFor(probe, Buffer.alloc(5), {
          responseUrl,
          body,
        }),
        verifyWindowsSignature: async () => {},
        probeOptions: { downloadAttempts: 1, backoffBaseMs: 0 },
      });
      const destination = join(root, `rejected-${pulls}-${Math.random()}`);
      await assert.rejects(source.stageChanged(probe, destination), /response validation/i);
      assert.equal(pulls, 0);
      await assert.rejects(access(destination));
    }
  });
});

test("stage rejects a GET Content-Length mismatch before reading the body", async () => {
  const probe = probeFor(ASSETS[0]);
  let reads = 0;
  const body = {
    getReader() {
      reads += 1;
      throw new Error("must not read rejected body");
    },
    cancel() {
      return Promise.resolve();
    },
  };
  const source = createClaudeSource({
    fetchImpl: downloadFetchFor(probe, Buffer.alloc(5), {
      contentLength: 6,
      body,
    }),
    verifyWindowsSignature: async () => {},
    probeOptions: { downloadAttempts: 1, backoffBaseMs: 0 },
  });
  await assert.rejects(
    source.stageChanged(probe, "/tmp/unused-claude-size-mismatch"),
    /response validation/i,
  );
  assert.equal(reads, 0);
});

test("stage rejects ETag and canonical filename-hash mismatches before body reads", async () => {
  const probe = probeFor(ASSETS[0]);
  for (const response of [
    { etag: REPLACEMENT_ETAG },
    {
      responseUrl: finalUrl(ASSETS[0], {
        basename: `Claude-${REPLACEMENT_CONTENT_ID}.dmg`,
      }),
    },
  ]) {
    let reads = 0;
    const body = {
      getReader() {
        reads += 1;
        throw new Error("must not read identity-mismatched body");
      },
      cancel() {
        return Promise.resolve();
      },
    };
    const source = createClaudeSource({
      fetchImpl: downloadFetchFor(probe, Buffer.alloc(5), {
        body,
        ...response,
      }),
      verifyWindowsSignature: async () => {},
      probeOptions: { downloadAttempts: 1, backoffBaseMs: 0 },
    });
    await assert.rejects(
      source.stageChanged(probe, "/tmp/unused-claude-identity-mismatch"),
      /response validation/i,
    );
    assert.equal(reads, 0);
  }
});

test("DEB stage rejects a non-exact response URL or Content-Length before reading the body", async () => {
  const asset = DEB_ASSETS[0];
  const bytes = Buffer.from("12345");
  const probe = probeFor(asset, { expectedSha256: sha256(bytes) });
  for (const response of [
    { responseUrl: `${probe.resolvedUrl}?token=secret` },
    { responseUrl: probe.resolvedUrl.replace("downloads.claude.ai", "evil.example") },
    { responseUrl: probe.resolvedUrl.replace("1.2.3", "1.2.4") },
    { responseUrl: probe.resolvedUrl.replace("_amd64.deb", "_arm64.deb") },
    { contentLength: bytes.length + 1 },
  ]) {
    let reads = 0;
    const body = {
      getReader() {
        reads += 1;
        throw new Error("must not read rejected DEB body");
      },
      cancel() {
        return Promise.resolve();
      },
    };
    const source = createClaudeSource({
      fetchImpl: downloadFetchFor(probe, bytes, { body, ...response }),
      verifyWindowsSignature: async () => {},
      probeOptions: { downloadAttempts: 1, backoffBaseMs: 0 },
    });
    await assert.rejects(
      source.stageChanged(probe, "/tmp/unused-claude-deb-response"),
      /response validation/i,
    );
    assert.equal(reads, 0);
  }
});

test("stage does not follow GET redirects and keeps all network requests HTTPS", async () => {
  const probe = probeFor(ASSETS[0]);
  const calls = [];
  const source = createClaudeSource({
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), redirect: init.redirect });
      return responseWithUrl(null, {
        status: 302,
        headers: { location: "http://evil.example/file" },
      }, String(url));
    },
    verifyWindowsSignature: async () => {},
    probeOptions: { downloadAttempts: 1, backoffBaseMs: 0 },
  });
  await assert.rejects(source.stageChanged(probe, "/tmp/unused-claude-redirect"), /HTTP 302/);
  assert.deepEqual(calls, [{ url: probe.resolvedUrl, redirect: "manual" }]);
});

test("all five changed assets download exact bytes and only MSIX files verify signatures", async () => {
  await withTempDir(async (root) => {
    const signatures = [];
    for (const asset of ASSETS) {
      const bytes = Buffer.from(`new:${asset.id}`);
      const probe = probeFor(asset, {
        expectedSize: bytes.length,
        ...(asset.architecture ? { expectedSha256: sha256(bytes) } : {}),
      });
      let request;
      const source = createClaudeSource({
        fetchImpl: downloadFetchFor(probe, bytes, {
          onRequest(url, init) {
            request = { url, method: init.method, redirect: init.redirect };
          },
        }),
        verifyWindowsSignature: async (path) => signatures.push(path),
        probeOptions: { downloadAttempts: 1, backoffBaseMs: 0 },
      });
      const destination = join(root, asset.filename);
      const result = await source.stageChanged(probe, destination);
      assert.equal(await readFile(destination, "utf8"), bytes.toString());
      assert.equal(result.size, bytes.length);
      assert.equal(result.sha256, sha256(bytes));
      assert.deepEqual(request, {
        url: probe.resolvedUrl,
        method: undefined,
        redirect: "manual",
      });
    }
    assert.deepEqual(
      signatures.map((path) => basename(path)),
      ["Claude-Windows-x64.msix", "Claude-Windows-arm64.msix"],
    );
  });
});

test("stream size races remove partial or complete staged files", async () => {
  await withTempDir(async (root) => {
    for (const bytes of [Buffer.from("tiny"), Buffer.from("too-large")]) {
      const expectedSize = bytes.length === 4 ? 5 : 5;
      const probe = probeFor(ASSETS[0], { expectedSize });
      const source = createClaudeSource({
        fetchImpl: downloadFetchFor(probe, bytes, {
          contentLength: expectedSize,
        }),
        verifyWindowsSignature: async () => {},
        probeOptions: { downloadAttempts: 1, backoffBaseMs: 0 },
      });
      const destination = join(root, `race-${bytes.length}`);
      await assert.rejects(
        source.stageChanged(probe, destination),
        /size|less than|download/i,
      );
      await assert.rejects(access(destination));
    }
  });
});

test("DEB checksum or streamed-size mismatches remove partial and complete staged files", async () => {
  await withTempDir(async (root) => {
    const asset = DEB_ASSETS[0];
    const bytes = Buffer.from("12345");
    const cases = [
      probeFor(asset, { expectedSha256: REPLACEMENT_SHA256 }),
      probeFor(asset, { expectedSize: bytes.length + 1, expectedSha256: sha256(bytes) }),
    ];
    for (const [index, probe] of cases.entries()) {
      const source = createClaudeSource({
        fetchImpl: downloadFetchFor(probe, bytes, {
          contentLength: probe.expectedSize,
        }),
        verifyWindowsSignature: async () => assert.fail("DEBs must not invoke signtool"),
        probeOptions: { downloadAttempts: 1, backoffBaseMs: 0 },
      });
      const destination = join(root, `deb-mismatch-${index}`);
      await assert.rejects(
        source.stageChanged(probe, destination),
        /SHA256|checksum|size|download/i,
      );
      await assert.rejects(access(destination));
    }
  });
});

test("both MSIX signature failures remove the downloaded file while DMG skips signtool", async () => {
  await withTempDir(async (root) => {
    for (const asset of REDIRECT_ASSETS.slice(1)) {
      const bytes = Buffer.from("12345");
      const probe = probeFor(asset);
      const source = createClaudeSource({
        fetchImpl: downloadFetchFor(probe, bytes),
        verifyWindowsSignature: async () => {
          throw new Error("secret signtool detail");
        },
        probeOptions: { downloadAttempts: 1, backoffBaseMs: 0 },
      });
      const destination = join(root, asset.filename);
      await assert.rejects(source.stageChanged(probe, destination), /signature verification failed/i);
      await assert.rejects(access(destination));
    }

    let signatures = 0;
    const asset = ASSETS[0];
    const probe = probeFor(asset);
    const source = createClaudeSource({
      fetchImpl: downloadFetchFor(probe, Buffer.from("12345")),
      verifyWindowsSignature: async () => {
        signatures += 1;
      },
      probeOptions: { downloadAttempts: 1, backoffBaseMs: 0 },
    });
    await source.stageChanged(probe, join(root, asset.filename));
    assert.equal(signatures, 0);
  });
});

test("source probe delegates to the exact Claude probe contract", async () => {
  let calls = 0;
  const source = createClaudeSource({
    fetchImpl: async (...args) => {
      calls += 1;
      return await successfulProbeFetch()(...args);
    },
    verifyWindowsSignature: async () => {},
    probeOptions: { attempts: 1, backoffBaseMs: 0 },
  });
  const probes = await source.probe();
  assert.deepEqual(probes.map((probe) => probe.id), ASSETS.map((asset) => asset.id));
  assert.equal(calls, 5);
});
