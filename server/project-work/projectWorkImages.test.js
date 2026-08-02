import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_PROJECT_WORK_IMAGE_BYTES,
  MAX_PROJECT_WORK_IMAGE_DIMENSION,
  MAX_PROJECT_WORK_IMAGE_MODEL_BASE64_BYTES,
  normalizeProjectWorkImage,
  normalizeProjectWorkImages,
} from "./projectWorkImages.js";

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function pngHeader() {
  const bytes = Buffer.alloc(33);
  Buffer.from([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
  ]).copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(1, 16);
  bytes.writeUInt32BE(1, 20);
  return bytes;
}

function jpegHeader() {
  return Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0xff, 0xd9]);
}

function webpHeader() {
  const bytes = Buffer.alloc(20);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WEBP", 8, "ascii");
  bytes.write("VP8L", 12, "ascii");
  bytes.writeUInt32LE(0, 16);
  return bytes;
}

function rawImage(bytes, mimeType, fileName = "screenshot.bin") {
  return {
    fileName,
    mimeType,
    byteLength: bytes.length,
    data: bytes.toString("base64"),
  };
}

test("project-work image normalization accepts one PNG, JPEG, or WebP and applies SDK bounds", async () => {
  for (const [mimeType, bytes] of [
    ["image/png", pngHeader()],
    ["image/jpeg", jpegHeader()],
    ["image/webp", webpHeader()],
  ]) {
    let resizeCall = null;
    const normalized = await normalizeProjectWorkImage(
      rawImage(bytes, mimeType),
      {
        resize: async (input, inputMimeType, options) => {
          resizeCall = { input, inputMimeType, options };
          return {
            data: input.toString("base64"),
            mimeType: inputMimeType,
            originalWidth: 1,
            originalHeight: 1,
            width: 1,
            height: 1,
            wasResized: false,
          };
        },
      },
    );

    assert.equal(resizeCall.input.equals(bytes), true);
    assert.equal(resizeCall.inputMimeType, mimeType);
    assert.deepEqual(resizeCall.options, {
      maxWidth: MAX_PROJECT_WORK_IMAGE_DIMENSION,
      maxHeight: MAX_PROJECT_WORK_IMAGE_DIMENSION,
      maxBytes: MAX_PROJECT_WORK_IMAGE_MODEL_BASE64_BYTES,
      jpegQuality: 80,
    });
    assert.deepEqual(normalized.image, {
      type: "image",
      data: bytes.toString("base64"),
      mimeType,
    });
    assert.deepEqual(normalized.metadata, {
      fileName: "screenshot.bin",
      mimeType,
      byteLength: bytes.length,
    });
  }
});

test("project-work image normalization uses the SDK resizeImage implementation", async () => {
  const normalized = await normalizeProjectWorkImage(
    rawImage(ONE_PIXEL_PNG, "image/png", "pixel.png"),
  );

  assert.equal(normalized.image.type, "image");
  assert.equal(normalized.image.mimeType, "image/png");
  assert.equal(normalized.image.data, ONE_PIXEL_PNG.toString("base64"));
  assert.deepEqual(normalized.metadata, {
    fileName: "pixel.png",
    mimeType: "image/png",
    byteLength: ONE_PIXEL_PNG.length,
  });
});

test("project-work image normalization rejects malformed Base64 and MIME spoofing", async () => {
  await assert.rejects(
    normalizeProjectWorkImage({
      fileName: "bad.png",
      mimeType: "image/png",
      byteLength: 3,
      data: "data:image/png;base64,AAAA",
    }),
    (error) => error?.code === "PROJECT_WORK_IMAGE_INVALID" && error?.status === 400,
  );
  await assert.rejects(
    normalizeProjectWorkImage({
      ...rawImage(pngHeader(), "image/jpeg", "spoof.jpg"),
    }),
    (error) => error?.code === "PROJECT_WORK_IMAGE_INVALID" && error?.status === 400,
  );
  await assert.rejects(
    normalizeProjectWorkImage({
      ...rawImage(pngHeader(), "image/png", "mismatch.png"),
      byteLength: pngHeader().length + 1,
    }),
    (error) => error?.code === "PROJECT_WORK_IMAGE_INVALID" && error?.status === 400,
  );
  await assert.rejects(
    normalizeProjectWorkImage({
      ...rawImage(Buffer.from("<svg/>"), "image/svg+xml", "vector.svg"),
    }),
    (error) => error?.code === "PROJECT_WORK_IMAGE_INVALID" && error?.status === 400,
  );
});

test("project-work image normalization enforces the five MiB raw-image limit", async () => {
  const oversized = Buffer.alloc(MAX_PROJECT_WORK_IMAGE_BYTES + 1);
  await assert.rejects(
    normalizeProjectWorkImage({
      fileName: "oversized.png",
      mimeType: "image/png",
      byteLength: oversized.length,
      data: oversized.toString("base64"),
    }),
    (error) => (
      error?.code === "PROJECT_WORK_IMAGE_TOO_LARGE"
      && error?.status === 413
    ),
  );
});

test("project-work image normalization reports an unusable resize result safely", async () => {
  await assert.rejects(
    normalizeProjectWorkImage(
      rawImage(pngHeader(), "image/png", "broken.png"),
      { resize: async () => null },
    ),
    (error) => (
      error?.code === "PROJECT_WORK_IMAGE_PROCESSING_FAILED"
      && error?.status === 422
    ),
  );
});

test("project-work image normalization allows at most one image per message", async () => {
  const image = rawImage(pngHeader(), "image/png", "one.png");
  const resize = async (bytes, mimeType) => ({
    data: bytes.toString("base64"),
    mimeType,
    originalWidth: 1,
    originalHeight: 1,
    width: 1,
    height: 1,
    wasResized: false,
  });

  assert.equal(
    (await normalizeProjectWorkImages([image], { resize })).length,
    1,
  );
  await assert.rejects(
    normalizeProjectWorkImages([image, image], { resize }),
    (error) => (
      error?.code === "PROJECT_WORK_IMAGE_COUNT_INVALID"
      && error?.status === 400
    ),
  );
});
