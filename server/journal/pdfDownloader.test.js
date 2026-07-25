import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { downloadPdf, isPrivateAddress } from "./pdfDownloader.js";

const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];

test("private and loopback addresses are rejected", () => {
  assert.equal(isPrivateAddress("127.0.0.1"), true);
  assert.equal(isPrivateAddress("192.168.1.2"), true);
  assert.equal(isPrivateAddress("10.0.0.2"), true);
  assert.equal(isPrivateAddress("93.184.216.34"), false);
  assert.equal(isPrivateAddress("::1"), true);
});

test("PDF download follows a revalidated HTTPS redirect and writes a hash manifest", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "pi-agent-pdf-"));
  const requested = [];
  const fetchImpl = async (url, options) => {
    requested.push({ url: url.toString(), redirect: options.redirect });
    if (url.hostname === "papers.example") {
      return new Response(null, {
        status: 302,
        headers: { location: "https://cdn.example/paper.pdf" },
      });
    }
    return new Response(Buffer.from("%PDF-1.7\nverified"), {
      status: 200,
      headers: {
        "content-type": "application/pdf",
        "content-length": "17",
      },
    });
  };

  const result = await downloadPdf({
    paperId: "conf/acl/Test26",
    url: "https://papers.example/download",
    outputDir,
    fetchImpl,
    lookup: publicLookup,
  });
  assert.equal(result.final_url, "https://cdn.example/paper.pdf");
  assert.equal((await readFile(result.file_path)).subarray(0, 5).toString(), "%PDF-");
  assert.equal(result.sha256.length, 64);
  assert.equal(requested.every((request) => request.redirect === "manual"), true);
});

test("HTML disguised as a PDF is rejected without leaving a partial file", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "pi-agent-pdf-invalid-"));
  await assert.rejects(downloadPdf({
    paperId: "paper-1",
    url: "https://papers.example/paper.pdf",
    outputDir,
    fetchImpl: async () => new Response("<html>blocked</html>", { status: 200 }),
    lookup: publicLookup,
  }), /PDF_MAGIC_INVALID/);
});

test("redirects to a private address are rejected before the second request", async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), "pi-agent-pdf-private-"));
  let calls = 0;
  await assert.rejects(downloadPdf({
    paperId: "paper-1",
    url: "https://papers.example/paper.pdf",
    outputDir,
    fetchImpl: async () => {
      calls += 1;
      return new Response(null, { status: 302, headers: { location: "https://localhost/private.pdf" } });
    },
    lookup: publicLookup,
  }), /PDF_URL_UNSAFE/);
  assert.equal(calls, 1);
});
