import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  createZoteroDesktopAdapter,
  ZoteroDesktopError,
} from "./zoteroDesktop.js";

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      ...headers,
    },
  });
}

function emptyResponse(status = 201) {
  return new Response(null, { status });
}

function apiItem({
  key = "ABCD1234",
  itemType = "journalArticle",
  title = "A Paper",
  DOI = "",
  extra = "",
} = {}) {
  return {
    key,
    data: {
      key,
      itemType,
      title,
      DOI,
      extra,
    },
  };
}

function child({
  key,
  itemType,
  contentType = "",
  title = itemType,
  filename = "",
  url = "",
  note = "",
}) {
  return {
    key,
    data: {
      key,
      itemType,
      title,
      contentType,
      filename,
      url,
      note,
    },
  };
}

test("status probes API v3 and the connector without exposing response bodies", async () => {
  const calls = [];
  const adapter = createZoteroDesktopAdapter({
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return url.endsWith("/api/")
        ? new Response("Nothing to see here.", {
          status: 200,
          headers: { "zotero-api-version": "3" },
        })
        : new Response("<html>Zotero is running</html>", { status: 200 });
    },
  });

  assert.deepEqual(await adapter.status(), {
    available: true,
    apiVersion: 3,
    connectorAvailable: true,
  });
  assert.equal(calls[0].init.headers["Zotero-API-Version"], "3");
  assert.equal(calls[1].init.headers["X-Zotero-Connector-API-Version"], "3");
});

test("getTargets exposes only writable metadata for the personal library", async () => {
  let request;
  const adapter = createZoteroDesktopAdapter({
    fetchImpl: async (url, init) => {
      request = { url, init };
      return jsonResponse({
        libraryID: 1,
        libraryName: "My Library",
        libraryEditable: true,
        filesEditable: true,
        editable: true,
        id: 23,
        name: "AI Reading",
        targets: [
          {
            id: "L1", name: "My Library", editable: true, filesEditable: true, level: 0,
          },
          {
            id: "C23", name: "AI Reading", editable: true, filesEditable: true, level: 1,
          },
          {
            id: "C24", name: "Archive", editable: false, filesEditable: false, level: 1,
          },
          {
            id: "L2", name: "Group", editable: true, filesEditable: false, level: 0,
          },
          {
            id: "C31", name: "Shared", editable: true, filesEditable: false, level: 1,
          },
        ],
      });
    },
  });

  const result = await adapter.getTargets();

  assert.equal(result.selectedTargetId, "C23");
  assert.equal(result.targets.length, 3);
  assert.deepEqual(result.targets[1], {
    id: "C23",
    name: "AI Reading",
    libraryId: 1,
    libraryName: "My Library",
    level: 1,
    path: ["My Library", "AI Reading"],
    filesEditable: true,
    editable: true,
  });
  assert.deepEqual(result.targets[2], {
    id: "C24",
    name: "Archive",
    libraryId: 1,
    libraryName: "My Library",
    level: 1,
    path: ["My Library", "Archive"],
    filesEditable: false,
    editable: false,
  });
  assert.equal(request.url, "http://127.0.0.1:23119/connector/getSelectedCollection");
  assert.equal(request.init.headers["X-Zotero-Connector-API-Version"], "3");
});

test("getTargets falls back to the personal root when a group library is selected", async () => {
  const adapter = createZoteroDesktopAdapter({
    fetchImpl: async () => jsonResponse({
      libraryID: 2,
      libraryName: "Shared Group",
      libraryEditable: true,
      filesEditable: false,
      editable: true,
      id: 31,
      name: "Shared",
      targets: [
        {
          id: "L1", name: "My Library", editable: true, filesEditable: true, level: 0,
        },
        {
          id: "C23", name: "AI Reading", editable: true, filesEditable: true, level: 1,
        },
        {
          id: "L2", name: "Shared Group", editable: true, filesEditable: false, level: 0,
        },
        {
          id: "C31", name: "Shared", editable: true, filesEditable: false, level: 1,
        },
      ],
    }),
  });

  assert.deepEqual(await adapter.getTargets(), {
    selectedTargetId: "L1",
    targets: [
      {
        id: "L1",
        name: "My Library",
        libraryId: 1,
        libraryName: "My Library",
        level: 0,
        path: ["My Library"],
        filesEditable: true,
        editable: true,
      },
      {
        id: "C23",
        name: "AI Reading",
        libraryId: 1,
        libraryName: "My Library",
        level: 1,
        path: ["My Library", "AI Reading"],
        filesEditable: true,
        editable: true,
      },
    ],
  });
});

test("getTargets preserves full paths for same-named nested collections", async () => {
  const adapter = createZoteroDesktopAdapter({
    fetchImpl: async () => jsonResponse({
      libraryID: 1,
      id: 25,
      targets: [
        {
          id: "L1", name: "My Library", editable: true, filesEditable: true, level: 0,
        },
        {
          id: "C20", name: "Research", editable: true, filesEditable: true, level: 1,
        },
        {
          id: "C23", name: "Reading", editable: true, filesEditable: true, level: 2,
        },
        {
          id: "C21", name: "Products", editable: true, filesEditable: true, level: 1,
        },
        {
          id: "C25", name: "Reading", editable: true, filesEditable: true, level: 2,
        },
      ],
    }),
  });

  const result = await adapter.getTargets();

  assert.equal(result.selectedTargetId, "C25");
  assert.deepEqual(
    result.targets.filter((target) => target.name === "Reading").map((target) => ({
      id: target.id,
      level: target.level,
      path: target.path,
    })),
    [
      {
        id: "C23",
        level: 2,
        path: ["My Library", "Research", "Reading"],
      },
      {
        id: "C25",
        level: 2,
        path: ["My Library", "Products", "Reading"],
      },
    ],
  );
});

test("findDuplicates separates exact operation, DOI, and normalized-title matches", async () => {
  const marker = "Pi-Agent-Operation-ID: run-7:paper-2";
  const adapter = createZoteroDesktopAdapter({
    fetchImpl: async (url) => {
      const query = new URL(url).searchParams.get("q");
      if (query === marker) {
        return jsonResponse([
          apiItem({
            key: "OPER1234",
            title: "Already saved",
            extra: `Unrelated\n${marker}\nOther`,
          }),
          apiItem({
            key: "FALSE123",
            title: "False operation hit",
            extra: "Pi-Agent-Operation-ID: another",
          }),
        ]);
      }
      if (query === "10.1000/test") {
        return jsonResponse([
          apiItem({
            key: "DOIM1234",
            title: "DOI match",
            DOI: "https://doi.org/10.1000/TEST",
          }),
          apiItem({
            key: "DOIF1234",
            title: "DOI false hit",
            DOI: "10.1000/other",
          }),
        ]);
      }
      return jsonResponse([
        apiItem({
          key: "TITL1234",
          title: "  Workflow\u00a0  Agent ",
        }),
      ]);
    },
  });

  const result = await adapter.findDuplicates({
    doi: "doi:10.1000/TEST",
    title: "Workflow Agent",
    operationId: "run-7:paper-2",
  });

  assert.equal(result.operationMatch.key, "OPER1234");
  assert.deepEqual(result.doiMatches.map((item) => item.key), ["DOIM1234"]);
  assert.deepEqual(result.titleMatches.map((item) => item.key), ["TITL1234"]);
  assert.equal("extra" in result.operationMatch, false);
});

test("findDuplicates rejects multiple exact operation markers", async () => {
  const marker = "Pi-Agent-Operation-ID: operation-1";
  const adapter = createZoteroDesktopAdapter({
    fetchImpl: async () => jsonResponse([
      apiItem({ key: "FIRST123", extra: marker }),
      apiItem({ key: "SECON123", extra: marker }),
    ]),
  });

  await assert.rejects(
    adapter.findDuplicates({ operationId: "operation-1" }),
    (error) => (
      error instanceof ZoteroDesktopError
      && error.code === "ZOTERO_OPERATION_CONFLICT"
      && error.status === 409
      && error.retryable === false
    ),
  );
});

test("createItem requires the exact approved operation marker before any Zotero request", async () => {
  let requests = 0;
  const adapter = createZoteroDesktopAdapter({
    fetchImpl: async () => {
      requests += 1;
      return jsonResponse([]);
    },
  });
  const invalidExtras = [
    "",
    "Pi-Agent-Operation-ID: another-operation",
    [
      "Pi-Agent-Operation-ID: approved-operation",
      "Pi-Agent-Operation-ID: approved-operation",
    ].join("\n"),
  ];

  for (const extra of invalidExtras) {
    await assert.rejects(
      adapter.createItem({
        operationId: "approved-operation",
        targetId: "L1",
        item: {
          itemType: "journalArticle",
          title: "Approved paper",
          extra,
        },
      }),
      (error) => (
        error instanceof ZoteroDesktopError
        && error.code === "ZOTERO_INVALID_REQUEST"
        && error.status === 400
        && error.retryable === false
      ),
    );
  }
  assert.equal(requests, 0);
});

test("createItem writes metadata, target tags, note, PDF, then verifies item and children", async () => {
  const pdfBytes = Buffer.from("%PDF-1.7\nverified bytes\n");
  const sha256 = createHash("sha256").update(pdfBytes).digest("hex");
  const calls = [];
  let saved = false;
  let updated = false;
  let uploaded = false;
  const adapter = createZoteroDesktopAdapter({
    sleep: async () => {},
    idFactory: () => {
      throw new Error("explicit IDs should be used");
    },
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (url.includes("/items/top?")) {
        return saved
          ? jsonResponse([
            apiItem({
              key: "ITEM1234",
              title: "RCAFlow",
              DOI: "10.1000/rca",
              extra: [
                "Conference: ICML",
                "Pi-Agent-Operation-ID: run-1:paper-1",
              ].join("\n"),
            }),
          ])
          : jsonResponse([]);
      }
      if (url.endsWith("/connector/saveItems")) {
        saved = true;
        return emptyResponse(201);
      }
      if (url.endsWith("/connector/updateSession")) {
        updated = true;
        return jsonResponse({});
      }
      if (url.endsWith("/connector/saveAttachment")) {
        uploaded = true;
        return emptyResponse(201);
      }
      if (url.endsWith("/items/ITEM1234/children")) {
        return jsonResponse([
          updated && child({
            key: "NOTE1234",
            itemType: "note",
            note: "<p>五分钟导读</p>",
          }),
          uploaded && child({
            key: "ATCH1234",
            itemType: "attachment",
            contentType: "application/pdf",
            title: "RCAFlow.pdf",
            filename: "RCAFlow.pdf",
            url: "https://example.test/RCAFlow.pdf",
          }),
        ].filter(Boolean));
      }
      throw new Error("unexpected request");
    },
  });

  const result = await adapter.createItem({
    operationId: "run-1:paper-1",
    sessionId: "session-explicit",
    connectorItemId: "connector-item-explicit",
    targetId: "C23",
    item: {
      itemType: "conferencePaper",
      title: "RCAFlow",
      DOI: "10.1000/rca",
      url: "https://doi.org/10.1000/rca",
      extra: [
        "Conference: ICML",
        "Pi-Agent-Operation-ID: run-1:paper-1",
        "",
      ].join("\n"),
      tags: [{ tag: "RCA" }, "workflow", { tag: "RCA" }],
    },
    noteHtml: "<p>五分钟导读</p>",
    pdf: {
      bytes: pdfBytes,
      fileName: "RCAFlow.pdf",
      url: "https://example.test/RCAFlow.pdf",
      sha256,
    },
  });

  assert.deepEqual(result, {
    itemKey: "ITEM1234",
    attachmentKey: "ATCH1234",
    noteKey: "NOTE1234",
    sessionId: "session-explicit",
    connectorItemId: "connector-item-explicit",
    verified: true,
    verification_scope: {
      status: "scoped_read_back",
      basis: "zotero_local_api_read_back",
      verified_fields: [
        "item.key",
        "item.operation_marker",
        "bibliographic.normalized_title",
        "bibliographic.normalized_doi",
        "note.key",
        "note.html",
        "pdf.attachment_key",
        "pdf.attachment_content_type",
        "pdf.attachment_file_name",
        "pdf.attachment_source_url",
      ],
      unverified_fields: [
        "bibliographic.complete_record",
        "bibliographic.tags",
        "collection.target",
        "pdf.bytes",
        "pdf.sha256",
      ],
    },
    message: [
      "已从 Zotero 读回核验条目 key、operation marker、规范化标题、规范化 DOI、",
      "导读正文与 note key、PDF 子附件的 key、类型与文件名、PDF 来源 URL；",
      "未从 Zotero 读回核验完整题录、标签、目标集合、PDF 字节与 SHA-256。",
    ].join(""),
    idempotent: false,
  });

  const saveItems = calls.find((call) => call.url.endsWith("/connector/saveItems"));
  const saveBody = JSON.parse(saveItems.init.body);
  assert.equal(saveBody.sessionID, "session-explicit");
  assert.equal(saveBody.items[0].id, "connector-item-explicit");
  assert.equal(saveBody.items[0].extra, [
    "Conference: ICML",
    "Pi-Agent-Operation-ID: run-1:paper-1",
    "",
  ].join("\n"));
  assert.equal(saveBody.items[0].extra.includes("Pi-Agent-Created-At:"), false);
  assert.deepEqual(saveBody.items[0].tags, []);
  assert.equal(saveItems.init.headers["X-Zotero-Connector-API-Version"], "3");

  const update = calls.find((call) => call.url.endsWith("/connector/updateSession"));
  assert.deepEqual(JSON.parse(update.init.body), {
    sessionID: "session-explicit",
    target: "C23",
    tags: ["RCA", "workflow"],
    note: "<p>五分钟导读</p>",
  });

  const upload = calls.find((call) => call.url.endsWith("/connector/saveAttachment"));
  assert.equal(upload.init.body, pdfBytes);
  assert.equal(upload.init.headers["Content-Type"], "application/pdf");
  assert.equal(upload.init.headers["Content-Length"], String(pdfBytes.length));
  assert.deepEqual(JSON.parse(upload.init.headers["X-Metadata"]), {
    sessionID: "session-explicit",
    parentItemID: "connector-item-explicit",
    title: "RCAFlow.pdf",
    url: "https://example.test/RCAFlow.pdf",
  });
  assert.equal(calls.at(-1).url.endsWith("/items/ITEM1234/children"), true);
});

test("createItem returns an existing operation idempotently without connector writes", async () => {
  const calls = [];
  const marker = "Pi-Agent-Operation-ID: run-1:paper-existing";
  const adapter = createZoteroDesktopAdapter({
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (url.includes("/items/top?")) {
        return jsonResponse([
          apiItem({
            key: "EXST1234",
            title: "Existing",
            extra: marker,
          }),
        ]);
      }
      if (url.endsWith("/items/EXST1234/children")) {
        return jsonResponse([
          child({ key: "NOTE5678", itemType: "note" }),
          child({
            key: "ATCH5678",
            itemType: "attachment",
            contentType: "application/pdf",
          }),
        ]);
      }
      throw new Error("connector write must not run");
    },
  });

  const result = await adapter.createItem({
    operationId: "run-1:paper-existing",
    targetId: "L1",
    item: {
      itemType: "journalArticle",
      title: "Existing",
      extra: "Pi-Agent-Operation-ID: run-1:paper-existing",
    },
  });

  assert.deepEqual(result, {
    itemKey: "EXST1234",
    attachmentKey: "ATCH5678",
    noteKey: "NOTE5678",
    sessionId: null,
    connectorItemId: null,
    verified: true,
    verification_scope: {
      status: "scoped_read_back",
      basis: "zotero_local_api_read_back",
      verified_fields: [
        "item.key",
        "item.operation_marker",
        "bibliographic.normalized_title",
      ],
      unverified_fields: [
        "bibliographic.complete_record",
        "bibliographic.tags",
        "collection.target",
      ],
    },
    message: [
      "已从 Zotero 读回核验条目 key、operation marker、规范化标题；",
      "未从 Zotero 读回核验完整题录、标签、目标集合。",
    ].join(""),
    idempotent: true,
  });
  assert.equal(calls.some((call) => call.url.includes("/connector/")), false);
});

test("an incomplete operation without its original connector session requires manual repair", async () => {
  const pdfBytes = Buffer.from("%PDF-1.7\nrecovery", "utf8");
  const adapter = createZoteroDesktopAdapter({
    sleep: async () => {},
    fetchImpl: async (url) => {
      if (url.includes("/items/top?")) {
        return jsonResponse([
          apiItem({
            key: "EXST1234",
            title: "Existing",
            extra: "Pi-Agent-Operation-ID: recovery-operation",
          }),
        ]);
      }
      if (url.endsWith("/items/EXST1234/children")) return jsonResponse([]);
      throw new Error("connector write must not run");
    },
  });

  await assert.rejects(
    adapter.createItem({
      operationId: "recovery-operation",
      targetId: "L1",
      item: {
        itemType: "journalArticle",
        title: "Existing",
        extra: "Pi-Agent-Operation-ID: recovery-operation",
      },
      noteHtml: "<p>导读</p>",
      pdf: {
        bytes: pdfBytes,
        fileName: "paper.pdf",
        url: "https://example.test/paper.pdf",
        sha256: createHash("sha256").update(pdfBytes).digest("hex"),
      },
    }),
    (error) => (
      error instanceof ZoteroDesktopError
      && error.code === "ZOTERO_MANUAL_REPAIR_REQUIRED"
      && error.status === 409
      && error.retryable === false
    ),
  );
});

test("a note seen before an unknown PDF read does not trigger another attachment upload", async () => {
  const pdfBytes = Buffer.from("%PDF-1.7\nunknown attachment state\n");
  let childReads = 0;
  let connectorWrites = 0;
  const adapter = createZoteroDesktopAdapter({
    sleep: async () => {},
    verificationAttempts: 2,
    fetchImpl: async (url) => {
      if (url.includes("/items/top?")) {
        return jsonResponse([
          apiItem({
            key: "UNKNOWN1",
            title: "Unknown PDF state",
            extra: "Pi-Agent-Operation-ID: unknown-pdf-state",
          }),
        ]);
      }
      if (url.endsWith("/items/UNKNOWN1/children")) {
        childReads += 1;
        if (childReads === 1) {
          return jsonResponse([
            child({
              key: "NOTEKNWN",
              itemType: "note",
              note: "<p>guide exists</p>",
            }),
          ]);
        }
        throw new Error("child state unavailable");
      }
      if (url.includes("/connector/")) {
        connectorWrites += 1;
        return emptyResponse(201);
      }
      throw new Error("unexpected request");
    },
  });

  await assert.rejects(
    adapter.createItem({
      operationId: "unknown-pdf-state",
      sessionId: "stable-session",
      connectorItemId: "stable-item",
      targetId: "L1",
      item: {
        itemType: "journalArticle",
        title: "Unknown PDF state",
        extra: "Pi-Agent-Operation-ID: unknown-pdf-state",
      },
      noteHtml: "<p>guide exists</p>",
      pdf: {
        bytes: pdfBytes,
        fileName: "unknown.pdf",
        url: "https://example.test/unknown.pdf",
        sha256: createHash("sha256").update(pdfBytes).digest("hex"),
      },
    }),
    (error) => (
      error instanceof ZoteroDesktopError
      && error.code === "ZOTERO_MANUAL_REPAIR_REQUIRED"
      && error.status === 409
      && error.retryable === false
    ),
  );
  assert.equal(childReads, 2);
  assert.equal(connectorWrites, 0);
});

test("an updateSession error requires manual repair even when its note becomes visible", async () => {
  let noteVisible = false;
  let updateCalls = 0;
  const adapter = createZoteroDesktopAdapter({
    sleep: async () => {},
    verificationAttempts: 2,
    fetchImpl: async (url) => {
      if (url.includes("/items/top?")) {
        return jsonResponse([
          apiItem({
            key: "UPDERR01",
            title: "Uncertain target and tags",
            extra: "Pi-Agent-Operation-ID: update-error",
          }),
        ]);
      }
      if (url.endsWith("/items/UPDERR01/children")) {
        return jsonResponse(noteVisible
          ? [child({
            key: "UPDNOTE1",
            itemType: "note",
            note: "<p>note became visible</p>",
          })]
          : []);
      }
      if (url.endsWith("/connector/updateSession")) {
        updateCalls += 1;
        noteVisible = true;
        throw new Error("response was lost");
      }
      throw new Error("unexpected request");
    },
  });

  await assert.rejects(
    adapter.createItem({
      operationId: "update-error",
      sessionId: "stable-session",
      connectorItemId: "stable-item",
      targetId: "C23",
      item: {
        itemType: "journalArticle",
        title: "Uncertain target and tags",
        tags: ["Pi Agent"],
        extra: "Pi-Agent-Operation-ID: update-error",
      },
      noteHtml: "<p>note became visible</p>",
    }),
    (error) => (
      error instanceof ZoteroDesktopError
      && error.code === "ZOTERO_MANUAL_REPAIR_REQUIRED"
      && error.status === 409
      && error.retryable === false
    ),
  );
  assert.equal(noteVisible, true);
  assert.equal(updateCalls, 1);
});

test("createItem blocks an ordinary DOI duplicate before connector writes", async () => {
  const writes = [];
  const adapter = createZoteroDesktopAdapter({
    fetchImpl: async (url, init) => {
      if (url.includes("/items/top?")) {
        const query = new URL(url).searchParams.get("q");
        return query === "10.1000/same"
          ? jsonResponse([
            apiItem({
              key: "DUPE1234",
              title: "Duplicate",
              DOI: "10.1000/same",
            }),
          ])
          : jsonResponse([]);
      }
      if (url.includes("/connector/")) {
        writes.push(url);
        return emptyResponse(201);
      }
      throw new Error("unexpected request");
    },
  });

  await assert.rejects(
    adapter.createItem({
      operationId: "fresh-operation",
      targetId: "L1",
      item: {
        itemType: "journalArticle",
        title: "New item",
        DOI: "10.1000/same",
        extra: "Pi-Agent-Operation-ID: fresh-operation",
      },
    }),
    (error) => (
      error instanceof ZoteroDesktopError
      && error.code === "ZOTERO_PREVIEW_STALE"
      && error.status === 409
      && error.retryable === false
    ),
  );
  assert.deepEqual(writes, []);
});

test("createItem blocks a title conflict even when the requested DOI is new", async () => {
  const adapter = createZoteroDesktopAdapter({
    fetchImpl: async (url) => {
      const query = new URL(url).searchParams.get("q");
      return query === "Same Title"
        ? jsonResponse([apiItem({ key: "TITLE123", title: " same   title " })])
        : jsonResponse([]);
    },
  });

  await assert.rejects(
    adapter.createItem({
      operationId: "title-conflict",
      targetId: "L1",
      item: {
        itemType: "journalArticle",
        title: "Same Title",
        DOI: "10.1000/new",
        extra: "Pi-Agent-Operation-ID: title-conflict",
      },
    }),
    (error) => (
      error instanceof ZoteroDesktopError
      && error.code === "ZOTERO_PREVIEW_STALE"
      && error.status === 409
      && error.retryable === false
    ),
  );
});

test("createItem refuses to repair an operation marker whose bibliographic identity changed", async () => {
  const calls = [];
  const adapter = createZoteroDesktopAdapter({
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (url.includes("/items/top?")) {
        return jsonResponse([
          apiItem({
            key: "WRONG123",
            title: "A different paper",
            DOI: "10.1000/different",
            extra: "Pi-Agent-Operation-ID: changed-operation",
          }),
        ]);
      }
      throw new Error("must not inspect children or write");
    },
  });

  await assert.rejects(
    adapter.createItem({
      operationId: "changed-operation",
      sessionId: "stable-session",
      connectorItemId: "stable-item",
      targetId: "L1",
      item: {
        itemType: "journalArticle",
        title: "Expected paper",
        DOI: "10.1000/expected",
        extra: "Pi-Agent-Operation-ID: changed-operation",
      },
    }),
    (error) => (
      error instanceof ZoteroDesktopError
      && error.code === "ZOTERO_OPERATION_CONFLICT"
      && error.status === 409
      && error.retryable === false
    ),
  );
  assert.equal(calls.some((call) => call.url.includes("/children")), false);
  assert.equal(calls.some((call) => call.url.includes("/connector/")), false);
});

test("createItem repairs missing requested assets only through the original connector session", async () => {
  const pdfBytes = Buffer.from("%PDF-1.7\nresume safely\n");
  const sha256 = createHash("sha256").update(pdfBytes).digest("hex");
  const events = [];
  let noteSaved = false;
  let pdfSaved = false;
  const adapter = createZoteroDesktopAdapter({
    sleep: async () => {},
    verificationAttempts: 2,
    fetchImpl: async (url, init) => {
      if (url.includes("/items/top?")) {
        return jsonResponse([
          apiItem({
            key: "HALF1234",
            title: "Half written",
            DOI: "10.1000/half",
            extra: "Pi-Agent-Operation-ID: half-operation",
          }),
        ]);
      }
      if (url.endsWith("/items/HALF1234/children")) {
        events.push("read");
        return jsonResponse([
          noteSaved && child({
            key: "NOTEHALF",
            itemType: "note",
            note: "<p>requested guide</p>",
          }),
          pdfSaved && child({
            key: "PDFHALF1",
            itemType: "attachment",
            contentType: "application/pdf",
            title: "half.pdf",
            filename: "half.pdf",
            url: "https://example.test/half.pdf",
          }),
        ].filter(Boolean));
      }
      if (url.endsWith("/connector/updateSession")) {
        events.push("update");
        noteSaved = true;
        assert.deepEqual(JSON.parse(init.body), {
          sessionID: "stable-session",
          target: "C23",
          tags: ["Pi Agent"],
          note: "<p>requested guide</p>",
        });
        return jsonResponse({});
      }
      if (url.endsWith("/connector/saveAttachment")) {
        events.push("upload");
        pdfSaved = true;
        assert.equal(
          JSON.parse(init.headers["X-Metadata"]).parentItemID,
          "stable-item",
        );
        return emptyResponse(201);
      }
      throw new Error("unexpected request");
    },
  });

  const result = await adapter.createItem({
    operationId: "half-operation",
    sessionId: "stable-session",
    connectorItemId: "stable-item",
    targetId: "C23",
    item: {
      itemType: "journalArticle",
      title: "Half written",
      DOI: "10.1000/half",
      tags: ["Pi Agent"],
      extra: "Pi-Agent-Operation-ID: half-operation",
    },
    noteHtml: "<p>requested guide</p>",
    pdf: {
      bytes: pdfBytes,
      fileName: "half.pdf",
      url: "https://example.test/half.pdf",
      sha256,
    },
  });

  assert.deepEqual(result, {
    itemKey: "HALF1234",
    attachmentKey: "PDFHALF1",
    noteKey: "NOTEHALF",
    sessionId: "stable-session",
    connectorItemId: "stable-item",
    verified: true,
    verification_scope: {
      status: "scoped_read_back",
      basis: "zotero_local_api_read_back",
      verified_fields: [
        "item.key",
        "item.operation_marker",
        "bibliographic.normalized_title",
        "bibliographic.normalized_doi",
        "note.key",
        "note.html",
        "pdf.attachment_key",
        "pdf.attachment_content_type",
        "pdf.attachment_file_name",
        "pdf.attachment_source_url",
      ],
      unverified_fields: [
        "bibliographic.complete_record",
        "bibliographic.tags",
        "collection.target",
        "pdf.bytes",
        "pdf.sha256",
      ],
    },
    message: [
      "已从 Zotero 读回核验条目 key、operation marker、规范化标题、规范化 DOI、",
      "导读正文与 note key、PDF 子附件的 key、类型与文件名、PDF 来源 URL；",
      "未从 Zotero 读回核验完整题录、标签、目标集合、PDF 字节与 SHA-256。",
    ].join(""),
    idempotent: true,
  });
  assert.deepEqual(events.slice(0, 3), ["read", "read", "update"]);
  assert.equal(events.filter((event) => event === "update").length, 1);
  assert.equal(events.filter((event) => event === "upload").length, 1);
});

test("an uncertain attachment response is verified read-only and never uploaded twice", async () => {
  const pdfBytes = Buffer.from("%PDF-1.7\nuncertain response\n");
  const noteHtml = "<p>guide already present</p>";
  let pdfSaved = false;
  let uploads = 0;
  const adapter = createZoteroDesktopAdapter({
    sleep: async () => {},
    verificationAttempts: 2,
    fetchImpl: async (url) => {
      if (url.includes("/items/top?")) {
        return jsonResponse([
          apiItem({
            key: "UNCERTN1",
            title: "Uncertain upload",
            extra: "Pi-Agent-Operation-ID: uncertain-upload",
          }),
        ]);
      }
      if (url.endsWith("/items/UNCERTN1/children")) {
        return jsonResponse([
          child({ key: "NOTECERT", itemType: "note", note: noteHtml }),
          pdfSaved && child({
            key: "PDFCERT1",
            itemType: "attachment",
            contentType: "application/pdf",
            filename: "uncertain.pdf",
          }),
        ].filter(Boolean));
      }
      if (url.endsWith("/connector/updateSession")) return jsonResponse({});
      if (url.endsWith("/connector/saveAttachment")) {
        uploads += 1;
        pdfSaved = true;
        throw new Error("response was lost");
      }
      throw new Error("unexpected request");
    },
  });

  const result = await adapter.createItem({
    operationId: "uncertain-upload",
    sessionId: "stable-session",
    connectorItemId: "stable-item",
    targetId: "L1",
    item: {
      itemType: "journalArticle",
      title: "Uncertain upload",
      extra: "Pi-Agent-Operation-ID: uncertain-upload",
    },
    noteHtml,
    pdf: {
      bytes: pdfBytes,
      fileName: "uncertain.pdf",
      url: "https://example.test/uncertain.pdf",
      sha256: createHash("sha256").update(pdfBytes).digest("hex"),
    },
  });

  assert.equal(result.attachmentKey, "PDFCERT1");
  assert.equal(result.idempotent, true);
  assert.equal(uploads, 1);
  assert.equal(
    result.verification_scope.verified_fields.includes("pdf.attachment_source_url"),
    false,
  );
  assert.equal(
    result.verification_scope.unverified_fields.includes("pdf.attachment_source_url"),
    true,
  );
  assert.match(result.message, /未从 Zotero 读回核验.*PDF 来源 URL.*PDF 字节与 SHA-256/);
});

test("createItem serializes concurrent writes and the second call observes the operation marker", async () => {
  let saved = false;
  let saveCount = 0;
  let updateCount = 0;
  const ids = ["one-session", "one-item", "unused-session", "unused-item"];
  const fetchImpl = async (url) => {
    if (url.includes("/items/top?")) {
      return saved
        ? jsonResponse([
          apiItem({
            key: "LOCK1234",
            title: "Parallel paper",
            extra: "Pi-Agent-Operation-ID: parallel-operation",
          }),
        ])
        : jsonResponse([]);
    }
    if (url.endsWith("/connector/saveItems")) {
      saveCount += 1;
      saved = true;
      return emptyResponse(201);
    }
    if (url.endsWith("/connector/updateSession")) {
      updateCount += 1;
      return jsonResponse({});
    }
    if (url.endsWith("/items/LOCK1234/children")) return jsonResponse([]);
    throw new Error("unexpected request");
  };
  const options = {
    sleep: async () => {},
    idFactory: () => ids.shift(),
    fetchImpl,
  };
  const firstAdapter = createZoteroDesktopAdapter(options);
  const secondAdapter = createZoteroDesktopAdapter(options);
  const input = {
    operationId: "parallel-operation",
    targetId: "L1",
    item: {
      itemType: "journalArticle",
      title: "Parallel paper",
      extra: "Pi-Agent-Operation-ID: parallel-operation",
    },
  };

  const [first, second] = await Promise.all([
    firstAdapter.createItem(input),
    secondAdapter.createItem(input),
  ]);

  assert.equal(saveCount, 1);
  assert.equal(updateCount, 1);
  assert.equal(first.idempotent, false);
  assert.equal(second.idempotent, true);
  assert.equal(first.itemKey, "LOCK1234");
  assert.equal(second.itemKey, "LOCK1234");
});

test("PDF hash mismatch is rejected before any connector write", async () => {
  const calls = [];
  const bytes = Buffer.from("%PDF-1.7\npaper");
  const adapter = createZoteroDesktopAdapter({
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return jsonResponse([]);
    },
  });

  await assert.rejects(
    adapter.createItem({
      operationId: "hash-mismatch",
      targetId: "L1",
      item: {
        itemType: "journalArticle",
        title: "Paper",
        extra: "Pi-Agent-Operation-ID: hash-mismatch",
      },
      pdf: {
        bytes,
        fileName: "paper.pdf",
        url: "https://example.test/paper.pdf",
        sha256: "0".repeat(64),
      },
    }),
    (error) => (
      error instanceof ZoteroDesktopError
      && error.code === "ZOTERO_INVALID_REQUEST"
      && error.status === 400
      && error.retryable === false
    ),
  );
  assert.equal(calls.some((call) => call.url.includes("/connector/")), false);
});

test("uncertain write errors require manual repair and expose only stable fields", async () => {
  const adapter = createZoteroDesktopAdapter({
    fetchImpl: async (url) => {
      if (url.includes("/items/top?")) return jsonResponse([]);
      return jsonResponse({
        error: "failed /Users/private/library secret-response",
      }, 500);
    },
  });

  await assert.rejects(
    adapter.createItem({
      operationId: "safe-error",
      targetId: "L1",
      item: {
        itemType: "journalArticle",
        title: "Paper",
        extra: "Pi-Agent-Operation-ID: safe-error",
      },
    }),
    (error) => {
      assert.equal(error instanceof ZoteroDesktopError, true);
      assert.equal(error.code, "ZOTERO_MANUAL_REPAIR_REQUIRED");
      assert.equal(error.status, 409);
      assert.equal(error.retryable, false);
      assert.equal(error.message.includes("/Users/"), false);
      assert.equal(error.message.includes("secret-response"), false);
      assert.deepEqual(
        Object.keys(error).sort(),
        ["code", "name", "retryable", "status"].sort(),
      );
      return true;
    },
  );
});

test("network failures are retryable and never include the thrown local path", async () => {
  const adapter = createZoteroDesktopAdapter({
    fetchImpl: async () => {
      throw new Error("connect /Users/private/zotero.sqlite");
    },
  });

  await assert.rejects(
    adapter.findDuplicates({ title: "Paper" }),
    (error) => (
      error instanceof ZoteroDesktopError
      && error.code === "ZOTERO_UNAVAILABLE"
      && error.status === 503
      && error.retryable === true
      && !error.message.includes("/Users/")
    ),
  );
});
