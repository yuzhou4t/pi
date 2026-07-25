export class HttpRangeError extends Error {
  constructor(message = "请求的字节范围无效") {
    super(message);
    this.name = "HttpRangeError";
  }
}

function integer(value) {
  if (!/^\d+$/.test(value)) throw new HttpRangeError();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new HttpRangeError();
  return parsed;
}

export function parseByteRange(header, totalBytes) {
  if (header === undefined || header === null || header === "") return null;
  if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0) {
    throw new TypeError("totalBytes must be a positive safe integer");
  }
  const match = String(header).trim().match(/^bytes=(\d*)-(\d*)$/);
  if (!match || (!match[1] && !match[2])) throw new HttpRangeError();

  if (!match[1]) {
    const suffixLength = integer(match[2]);
    if (suffixLength <= 0) throw new HttpRangeError();
    return {
      start: Math.max(totalBytes - suffixLength, 0),
      end: totalBytes - 1,
    };
  }

  const start = integer(match[1]);
  if (start >= totalBytes) throw new HttpRangeError();
  const requestedEnd = match[2] ? integer(match[2]) : totalBytes - 1;
  if (requestedEnd < start) throw new HttpRangeError();
  return {
    start,
    end: Math.min(requestedEnd, totalBytes - 1),
  };
}
