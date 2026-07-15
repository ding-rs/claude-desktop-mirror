import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";

import {
  createClaudeSource,
  parseClaudeVersion,
  probeClaudeAssets,
} from "../scripts/lib/claude-sources.mjs";

const MAX_ASSET_SIZE = 2 * 1024 ** 3;
const CONTENT_ID = "a".repeat(40);
const REPLACEMENT_CONTENT_ID = "c".repeat(40);
const VALID_ETAG = `"${"b".repeat(32)}"`;
const REPLACEMENT_ETAG = `"${"d".repeat(32)}"`;
const ASSETS = [
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

function probeFor(asset, overrides = {}) {
  const expectedSize = overrides.expectedSize ?? 5;
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
  etag = probe.expectedEtag ?? VALID_ETAG,
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
        etag,
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

test("Claude probes return the exact ordered three-asset contract using GET range only", async () => {
  const calls = [];
  const bodies = [];
  const fetchImpl = async (url, init = {}) => {
    const asset = ASSETS.find((candidate) => candidate.endpoint === String(url));
    assert.ok(asset);
    calls.push({ url: String(url), init });
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
    probes.map(({ id, filename, sourceEndpoint, sourceFingerprint, expectedSize, expectedEtag }) => ({
      id,
      filename,
      sourceEndpoint,
      sourceFingerprint,
      expectedSize,
      expectedEtag,
    })),
    ASSETS.map((asset, index) => ({
      id: asset.id,
      filename: asset.filename,
      sourceEndpoint: asset.endpoint,
      sourceFingerprint:
        `version:1.2.3|file:${asset.finalName}|size:${101 + index}|etag:${VALID_ETAG.slice(1, -1)}`,
      expectedSize: 101 + index,
      expectedEtag: VALID_ETAG,
    })),
  );
  assert.deepEqual(calls.map((call) => call.url), ASSETS.map((asset) => asset.endpoint));
  for (const { init } of calls) {
    assert.equal(init.method, "GET");
    assert.equal(new Headers(init.headers).get("range"), "bytes=0-0");
    assert.equal(init.redirect, "manual");
  }
  assert.ok(bodies.every((body) => body.pulls === 0));
  assert.ok(bodies.every((body) => body.cancelled === 1));
});

test("probe accepts a range-ignored 200 only with a trusted bounded Content-Length and cancels immediately", async () => {
  const bodies = [];
  const probes = await probeClaudeAssets(async (url) => {
    const asset = ASSETS.find((candidate) => candidate.endpoint === String(url));
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

  assert.ok(probes.every((probe) => probe.expectedSize === 777));
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
        const asset = ASSETS.find((candidate) => candidate.endpoint === String(url));
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
      return rangeResponse(asset, { total: 101, etag });
    }, { attempts: 1, backoffBaseMs: 0 });

  const before = await probeWithEtag(VALID_ETAG);
  const after = await probeWithEtag(REPLACEMENT_ETAG);
  assert.deepEqual(
    before.map(({ resolvedUrl, expectedSize }) => ({ resolvedUrl, expectedSize })),
    after.map(({ resolvedUrl, expectedSize }) => ({ resolvedUrl, expectedSize })),
  );
  assert.ok(
    before.every(
      (probe, index) =>
        probe.sourceFingerprint !== after[index].sourceFingerprint,
    ),
  );
  assert.ok(before.every((probe) => probe.expectedEtag === VALID_ETAG));
  assert.ok(after.every((probe) => probe.expectedEtag === REPLACEMENT_ETAG));
});

test("probe cancellation is bounded when an injected body never settles", async () => {
  let cancelCalls = 0;
  const started = Date.now();
  const probes = await probeClaudeAssets(async (url) => {
    const asset = ASSETS.find((candidate) => candidate.endpoint === String(url));
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

  assert.equal(probes.length, 3);
  assert.equal(cancelCalls, 3);
  assert.ok(Date.now() - started < 500);
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

test("all three changed assets download exact bytes and only MSIX files verify signatures", async () => {
  await withTempDir(async (root) => {
    const signatures = [];
    for (const asset of ASSETS) {
      const bytes = Buffer.from(`new:${asset.id}`);
      const probe = probeFor(asset, { expectedSize: bytes.length });
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
      assert.match(result.sha256, /^[0-9a-f]{64}$/);
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

test("both MSIX signature failures remove the downloaded file while DMG skips signtool", async () => {
  await withTempDir(async (root) => {
    for (const asset of ASSETS.slice(1)) {
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
    fetchImpl: async (url) => {
      calls += 1;
      const asset = ASSETS.find((candidate) => candidate.endpoint === String(url));
      return rangeResponse(asset);
    },
    verifyWindowsSignature: async () => {},
    probeOptions: { attempts: 1, backoffBaseMs: 0 },
  });
  const probes = await source.probe();
  assert.deepEqual(probes.map((probe) => probe.id), ASSETS.map((asset) => asset.id));
  assert.equal(calls, 3);
});
