import { createHash, randomUUID } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";

const DEFAULT_MAX_BYTES = 200 * 1024 * 1024;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function privateIpv4(address) {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return true;
  const [a, b] = parts;
  return (
    a === 0
    || a === 10
    || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || a >= 224
  );
}

function privateIpv6(address) {
  const normalized = address.toLowerCase().split("%")[0];
  return (
    normalized === "::"
    || normalized === "::1"
    || normalized.startsWith("fc")
    || normalized.startsWith("fd")
    || normalized.startsWith("fe8")
    || normalized.startsWith("fe9")
    || normalized.startsWith("fea")
    || normalized.startsWith("feb")
    || normalized.startsWith("::ffff:127.")
    || normalized.startsWith("::ffff:10.")
    || normalized.startsWith("::ffff:192.168.")
  );
}

export function isPrivateAddress(address) {
  const version = net.isIP(address);
  if (version === 4) return privateIpv4(address);
  if (version === 6) return privateIpv6(address);
  return true;
}

async function assertSafeHttpsUrl(rawUrl, lookup = dnsLookup) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("PDF_URL_INVALID");
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("PDF_URL_UNSAFE");
  }
  if (["localhost", "localhost.localdomain"].includes(url.hostname.toLowerCase())) {
    throw new Error("PDF_URL_UNSAFE");
  }
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (!Array.isArray(addresses) || addresses.length === 0 || addresses.some((item) => isPrivateAddress(item.address))) {
    throw new Error("PDF_URL_UNSAFE");
  }
  return url;
}

function safePaperFileName(paperId) {
  const normalized = String(paperId || "").replaceAll(/[^a-zA-Z0-9._-]+/g, "-").replaceAll(/^-+|-+$/g, "");
  if (!normalized) throw new Error("PAPER_ID_INVALID");
  return `${normalized.slice(0, 140)}.pdf`;
}

async function fetchWithSafeRedirects(rawUrl, {
  fetchImpl,
  lookup,
  signal,
  maxRedirects,
}) {
  let current = await assertSafeHttpsUrl(rawUrl, lookup);
  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    const response = await fetchImpl(current, {
      redirect: "manual",
      signal,
      headers: {
        accept: "application/pdf,application/octet-stream;q=0.9",
        "user-agent": "Pi-Agent-PDF-Resolver/0.1",
      },
    });
    if (!REDIRECT_STATUSES.has(response.status)) return { response, finalUrl: current.toString() };
    const location = response.headers.get("location");
    if (!location || redirectCount === maxRedirects) throw new Error("PDF_REDIRECT_INVALID");
    current = await assertSafeHttpsUrl(new URL(location, current).toString(), lookup);
  }
  throw new Error("PDF_REDIRECT_INVALID");
}

export async function downloadPdf({
  paperId,
  url,
  outputDir,
  fetchImpl = globalThis.fetch,
  lookup = dnsLookup,
  signal,
  timeoutMs = 120000,
  maxBytes = DEFAULT_MAX_BYTES,
  maxRedirects = 4,
} = {}) {
  if (typeof outputDir !== "string" || !outputDir) throw new Error("PDF_OUTPUT_DIR_REQUIRED");
  if (!Number.isInteger(maxBytes) || maxBytes <= 0 || maxBytes > DEFAULT_MAX_BYTES) {
    throw new Error("PDF_MAX_BYTES_INVALID");
  }
  await mkdir(outputDir, { recursive: true });
  const fileName = safePaperFileName(paperId);
  const finalPath = path.join(outputDir, fileName);
  const temporaryPath = `${finalPath}.${randomUUID()}.part`;
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, timeoutMs);
  if (signal?.aborted) controller.abort();
  signal?.addEventListener("abort", abort, { once: true });

  let handle;
  try {
    const { response, finalUrl } = await fetchWithSafeRedirects(url, {
      fetchImpl,
      lookup,
      signal: controller.signal,
      maxRedirects,
    });
    if (!response.ok || !response.body) throw new Error(`PDF_HTTP_${response.status}`);
    const contentLength = Number.parseInt(response.headers.get("content-length") || "", 10);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) throw new Error("PDF_TOO_LARGE");

    handle = await open(temporaryPath, "wx");
    const hash = createHash("sha256");
    const reader = response.body.getReader();
    let total = 0;
    let magic = Buffer.alloc(0);
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error("PDF_TOO_LARGE");
      }
      if (magic.length < 5) magic = Buffer.concat([magic, chunk]).subarray(0, 5);
      hash.update(chunk);
      await handle.write(chunk);
    }
    if (total < 5 || magic.toString("ascii") !== "%PDF-") throw new Error("PDF_MAGIC_INVALID");
    await handle.close();
    handle = null;
    await rename(temporaryPath, finalPath);

    const manifest = {
      schema_version: 1,
      paper_id: paperId,
      file_name: fileName,
      source_url: url,
      final_url: finalUrl,
      byte_length: total,
      sha256: hash.digest("hex"),
      downloaded_at: new Date().toISOString(),
    };
    await writeFile(`${finalPath}.json`, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    return { ...manifest, file_path: finalPath };
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

export async function readPdfManifest(filePath) {
  try {
    return JSON.parse(await readFile(`${filePath}.json`, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}
