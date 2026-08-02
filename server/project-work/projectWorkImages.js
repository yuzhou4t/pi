import { resizeImage } from "@earendil-works/pi-coding-agent";
import { projectWorkError } from "./errors.js";

export const MAX_PROJECT_WORK_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_PROJECT_WORK_IMAGE_DIMENSION = 2_000;
export const MAX_PROJECT_WORK_IMAGE_MODEL_BASE64_BYTES = 4.5 * 1024 * 1024;
export const MAX_PROJECT_WORK_IMAGES_PER_MESSAGE = 1;

const ALLOWED_IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);
const MAX_INPUT_BASE64_CHARACTERS = 4 * Math.ceil(
  MAX_PROJECT_WORK_IMAGE_BYTES / 3,
);
const PNG_SIGNATURE = Buffer.from([
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
]);

function invalidImage(message) {
  return projectWorkError(
    "PROJECT_WORK_IMAGE_INVALID",
    message,
    400,
  );
}

function imageTooLarge() {
  return projectWorkError(
    "PROJECT_WORK_IMAGE_TOO_LARGE",
    "单张图片不能超过 5 MiB",
    413,
  );
}

function hasOnlyBase64Characters(value) {
  const firstPadding = value.indexOf("=");
  const dataEnd = firstPadding === -1 ? value.length : firstPadding;
  if (firstPadding !== -1) {
    const paddingLength = value.length - firstPadding;
    if (
      paddingLength > 2
      || value.slice(firstPadding) !== "=".repeat(paddingLength)
    ) {
      return false;
    }
  }
  for (let index = 0; index < dataEnd; index += 1) {
    const code = value.charCodeAt(index);
    if (
      (code >= 0x41 && code <= 0x5a)
      || (code >= 0x61 && code <= 0x7a)
      || (code >= 0x30 && code <= 0x39)
      || code === 0x2b
      || code === 0x2f
    ) {
      continue;
    }
    return false;
  }
  return true;
}

function normalizedFileName(rawImage) {
  const fileName = String(
    rawImage?.fileName ?? rawImage?.file_name ?? "",
  ).trim();
  if (
    !fileName
    || fileName.length > 160
    || /[\u0000-\u001f\u007f/\\]/.test(fileName)
  ) {
    throw invalidImage("图片文件名无效");
  }
  return fileName;
}

function normalizedDeclaredMimeType(rawImage) {
  const mimeType = String(
    rawImage?.mimeType ?? rawImage?.mime_type ?? "",
  ).trim().toLowerCase();
  if (!ALLOWED_IMAGE_MIME_TYPES.has(mimeType)) {
    throw invalidImage("只支持 PNG、JPEG 和 WebP 图片");
  }
  return mimeType;
}

function strictBase64Bytes(value) {
  if (typeof value !== "string" || !value) {
    throw invalidImage("图片内容缺失");
  }
  if (value.length > MAX_INPUT_BASE64_CHARACTERS) {
    throw imageTooLarge();
  }
  if (value.length % 4 !== 0 || !hasOnlyBase64Characters(value)) {
    throw invalidImage("图片内容不是有效的 Base64");
  }
  const bytes = Buffer.from(value, "base64");
  if (!bytes.length || bytes.toString("base64") !== value) {
    throw invalidImage("图片内容不是有效的 Base64");
  }
  if (bytes.length > MAX_PROJECT_WORK_IMAGE_BYTES) {
    throw imageTooLarge();
  }
  return bytes;
}

function isStaticPng(bytes) {
  if (
    bytes.length < 33
    || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
    || bytes.readUInt32BE(8) !== 13
    || bytes.toString("ascii", 12, 16) !== "IHDR"
  ) {
    return false;
  }
  let offset = PNG_SIGNATURE.length;
  while (offset + 12 <= bytes.length) {
    const chunkLength = bytes.readUInt32BE(offset);
    const chunkType = bytes.toString("ascii", offset + 4, offset + 8);
    const nextOffset = offset + 12 + chunkLength;
    if (nextOffset <= offset || nextOffset > bytes.length) return false;
    if (chunkType === "acTL") return false;
    if (chunkType === "IDAT") return true;
    offset = nextOffset;
  }
  return true;
}

function isStaticWebp(bytes) {
  if (
    bytes.length < 20
    || bytes.toString("ascii", 0, 4) !== "RIFF"
    || bytes.toString("ascii", 8, 12) !== "WEBP"
    || bytes.readUInt32LE(4) !== bytes.length - 8
  ) {
    return false;
  }
  let offset = 12;
  let foundImageChunk = false;
  while (offset + 8 <= bytes.length) {
    const chunkType = bytes.toString("ascii", offset, offset + 4);
    const chunkLength = bytes.readUInt32LE(offset + 4);
    const nextOffset = offset + 8 + chunkLength + (chunkLength % 2);
    if (nextOffset <= offset || nextOffset > bytes.length) return false;
    if (chunkType === "ANIM" || chunkType === "ANMF") return false;
    if (chunkType === "VP8 " || chunkType === "VP8L" || chunkType === "VP8X") {
      foundImageChunk = true;
    }
    offset = nextOffset;
  }
  return foundImageChunk && offset === bytes.length;
}

function detectedMimeType(bytes) {
  if (
    bytes.length >= 4
    && bytes[0] === 0xff
    && bytes[1] === 0xd8
    && bytes[2] === 0xff
    && bytes[3] !== 0xf7
  ) {
    return "image/jpeg";
  }
  if (isStaticPng(bytes)) return "image/png";
  if (isStaticWebp(bytes)) return "image/webp";
  return null;
}

function declaredByteLength(rawImage, actualLength) {
  const value = rawImage?.byteLength ?? rawImage?.byte_length;
  if (!Number.isSafeInteger(value) || value <= 0 || value !== actualLength) {
    throw invalidImage("图片字节长度与声明不一致");
  }
  return value;
}

function validateResizeResult(result) {
  if (
    !result
    || typeof result.data !== "string"
    || !result.data
    || !ALLOWED_IMAGE_MIME_TYPES.has(result.mimeType)
    || Buffer.byteLength(result.data, "utf8")
      > MAX_PROJECT_WORK_IMAGE_MODEL_BASE64_BYTES
  ) {
    throw projectWorkError(
      "PROJECT_WORK_IMAGE_PROCESSING_FAILED",
      "图片无法规范化为模型可读格式",
      422,
    );
  }
  if (
    result.data.length % 4 !== 0
    || !hasOnlyBase64Characters(result.data)
    || Buffer.from(result.data, "base64").toString("base64") !== result.data
  ) {
    throw projectWorkError(
      "PROJECT_WORK_IMAGE_PROCESSING_FAILED",
      "图片规范化结果无效",
      422,
    );
  }
}

export async function normalizeProjectWorkImage(rawImage, {
  resize = resizeImage,
} = {}) {
  const fileName = normalizedFileName(rawImage);
  const declaredMimeType = normalizedDeclaredMimeType(rawImage);
  const bytes = strictBase64Bytes(rawImage?.data);
  declaredByteLength(rawImage, bytes.length);
  const actualMimeType = detectedMimeType(bytes);
  if (!actualMimeType || actualMimeType !== declaredMimeType) {
    throw invalidImage("图片格式与声明的 MIME 类型不一致");
  }

  let resized;
  try {
    resized = await resize(bytes, actualMimeType, {
      maxWidth: MAX_PROJECT_WORK_IMAGE_DIMENSION,
      maxHeight: MAX_PROJECT_WORK_IMAGE_DIMENSION,
      maxBytes: MAX_PROJECT_WORK_IMAGE_MODEL_BASE64_BYTES,
      jpegQuality: 80,
    });
  } catch {
    throw projectWorkError(
      "PROJECT_WORK_IMAGE_PROCESSING_FAILED",
      "图片无法规范化为模型可读格式",
      422,
    );
  }
  validateResizeResult(resized);

  return {
    image: {
      type: "image",
      data: resized.data,
      mimeType: resized.mimeType,
    },
    metadata: {
      fileName,
      mimeType: actualMimeType,
      byteLength: bytes.length,
    },
  };
}

export async function normalizeProjectWorkImages(rawImages, options) {
  if (!Array.isArray(rawImages)) {
    throw invalidImage("图片附件格式无效");
  }
  if (rawImages.length > MAX_PROJECT_WORK_IMAGES_PER_MESSAGE) {
    throw projectWorkError(
      "PROJECT_WORK_IMAGE_COUNT_INVALID",
      "每条消息最多附加一张图片",
      400,
    );
  }
  return Promise.all(
    rawImages.map((rawImage) => normalizeProjectWorkImage(rawImage, options)),
  );
}
