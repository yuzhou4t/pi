import assert from "node:assert/strict";
import test from "node:test";
import {
  createSourceDispatcher,
  fetchCrossrefSource,
  SourceDispatchError,
} from "./sourceDispatcher.js";
import { SOURCE_REGISTRY } from "./sourceRegistry.js";

const source = {
  source_id: "journal-test",
  venue: "Test Journal",
  adapter: "publisher-test",
  primary: {
    kind: "publisher-index",
    url: "https://publisher.example/journal",
  },
  fallback: {
    kind: "crossref-api",
    url: "https://api.crossref.org/journals/0000-0000/works",
  },
};

test("dispatcher uses the declared primary adapter when it is available", async () => {
  const calls = [];
  const dispatch = createSourceDispatcher({
    primaryAdapters: {
      "publisher-test": async (_source, { route }) => {
        calls.push(route);
        return {
          fetched_at: "2026-07-27T08:00:00.000Z",
          index_url: route.url,
          target_urls: [route.url],
          papers: [{ title: "Primary LLM Agent Paper", official_id: "primary-1" }],
        };
      },
    },
    fallbackAdapters: {
      "crossref-api": async () => {
        throw new Error("fallback must not run");
      },
    },
  });

  const result = await dispatch(source);

  assert.deepEqual(calls, [source.primary]);
  assert.deepEqual(result.dispatch, {
    status: "primary",
    selected_route: "primary",
    selected_adapter: "publisher-test",
    attempts: [{
      role: "primary",
      adapter: "publisher-test",
      status: "success",
      error: null,
    }],
  });
});

test("dispatcher records an unavailable primary and explicitly degrades to fallback", async () => {
  const dispatch = createSourceDispatcher({
    fallbackAdapters: {
      "crossref-api": async (_source, { route }) => ({
        fetched_at: "2026-07-27T08:00:00.000Z",
        index_url: route.url,
        target_urls: [route.url],
        papers: [{ title: "Fallback LLM Agent Paper", official_id: "fallback-1" }],
      }),
    },
  });

  const result = await dispatch(source);

  assert.equal(result.dispatch.status, "degraded");
  assert.equal(result.dispatch.selected_adapter, "crossref-api");
  assert.equal(result.dispatch.attempts[0].status, "unavailable");
  assert.equal(
    result.dispatch.attempts[0].error.code,
    "SOURCE_ADAPTER_NOT_IMPLEMENTED",
  );
});

test("a primary that returns zero papers is not treated as success and degrades to fallback", async () => {
  const dispatch = createSourceDispatcher({
    primaryAdapters: {
      "publisher-test": async (_source, { route }) => ({
        fetched_at: "2026-07-27T08:00:00.000Z",
        index_url: route.url,
        target_urls: [route.url],
        papers: [],
      }),
    },
    fallbackAdapters: {
      "crossref-api": async (_source, { route }) => ({
        fetched_at: "2026-07-27T08:00:00.000Z",
        index_url: route.url,
        target_urls: [route.url],
        papers: [{ title: "Fallback LLM Agent Paper", official_id: "fallback-1" }],
      }),
    },
  });

  const result = await dispatch(source);

  assert.equal(result.dispatch.status, "degraded");
  assert.equal(result.dispatch.selected_adapter, "crossref-api");
  assert.deepEqual(
    result.dispatch.attempts.map((attempt) => [attempt.role, attempt.status, attempt.error?.code ?? null]),
    [
      ["primary", "failed", "SOURCE_ROUTE_EMPTY"],
      ["fallback", "success", null],
    ],
  );
  assert.equal(result.papers.length, 1);
});

test("a source whose every route returns zero papers is exhausted rather than falsely successful", async () => {
  const dispatch = createSourceDispatcher({
    primaryAdapters: {
      "publisher-test": async (_source, { route }) => ({
        fetched_at: "2026-07-27T08:00:00.000Z",
        index_url: route.url,
        target_urls: [route.url],
        papers: [],
      }),
    },
    fallbackAdapters: {
      "crossref-api": async (_source, { route }) => ({
        fetched_at: "2026-07-27T08:00:00.000Z",
        index_url: route.url,
        target_urls: [route.url],
        papers: [],
      }),
    },
  });

  await assert.rejects(dispatch(source), (error) => (
    error instanceof SourceDispatchError
    && error.code === "SOURCE_ROUTES_EXHAUSTED"
    && error.attempts.every((attempt) => attempt.error?.code === "SOURCE_ROUTE_EMPTY")
    && error.retryable === true
  ));
});

test("unknown primary and fallback adapters fail explicitly without a DBLP substitution", async () => {
  const dispatch = createSourceDispatcher({
    primaryAdapters: {},
    fallbackAdapters: {},
  });
  const unknown = {
    ...source,
    adapter: "unknown-primary",
    fallback: {
      kind: "unknown-fallback",
      url: "https://fallback.example/works",
    },
  };

  await assert.rejects(dispatch(unknown), (error) => (
    error instanceof SourceDispatchError
    && error.code === "SOURCE_ROUTES_EXHAUSTED"
    && error.attempts.length === 2
    && error.attempts.every((attempt) => attempt.status === "unavailable")
  ));
});

test("Crossref adapter preserves publication precision", async () => {
  const response = {
    message: {
      items: [
        {
          DOI: "10.1000/exact",
          title: ["Exact publication"],
          author: [{ given: "A", family: "Author" }],
          "container-title": ["Test Journal"],
          "published-online": { "date-parts": [[2026, 7, 27]] },
          URL: "https://doi.org/10.1000/exact",
        },
        {
          DOI: "10.1000/year-only",
          title: ["Imprecise publication"],
          "published-print": { "date-parts": [[2026]] },
          URL: "https://doi.org/10.1000/year-only",
        },
      ],
    },
  };
  const result = await fetchCrossrefSource(source, {
    fetchImpl: async () => new Response(JSON.stringify(response), { status: 200 }),
  });

  assert.equal(result.papers[0].published_at, "2026-07-27");
  assert.equal(result.papers[0].publication_date_precision, "day");
  assert.equal(result.papers[1].published_at, "2026");
  assert.equal(result.papers[1].publication_date_precision, "year");
});

test("a failed official primary is recorded before the declared Crossref fallback succeeds", async () => {
  const registered = SOURCE_REGISTRY.find(
    (item) => item.source_id === "journal-ai",
  );
  const dispatch = createSourceDispatcher();
  const result = await dispatch(registered, {
    fetchImpl: async (url) => {
      if (String(url).startsWith(registered.primary.url)) {
        return new Response("", { status: 503 });
      }
      return new Response(JSON.stringify({
        message: {
          items: [{
            DOI: "10.1000/fallback",
            title: ["Fallback LLM Agent Paper"],
            "published-online": { "date-parts": [[2026, 7, 27]] },
            URL: "https://doi.org/10.1000/fallback",
          }],
        },
      }), { status: 200 });
    },
  });

  assert.equal(result.dispatch.status, "degraded");
  assert.deepEqual(
    result.dispatch.attempts.map((attempt) => [
      attempt.role,
      attempt.status,
      attempt.error?.code ?? null,
    ]),
    [
      ["primary", "failed", "OFFICIAL_HTTP_503"],
      ["fallback", "success", null],
    ],
  );
  assert.equal(result.papers[0].metadata_source, "crossref");
});

test("the default dispatcher has a working primary handler for every registry adapter", async () => {
  const dispatch = createSourceDispatcher({
    fallbackAdapters: {},
  });
  for (const [index, registered] of SOURCE_REGISTRY.entries()) {
    const result = await dispatch(registered, {
      fetchImpl: async () => new Response(
        registered.adapter === "jmlr-papers-index"
          ? [
              "<rss><channel><item>",
              `<title>Registry Primary LLM Agent Paper ${index + 1}</title>`,
              "<link>http://jmlr.org/papers/v27/registry.html</link>",
              "<pubDate>2026</pubDate>",
              "</item></channel></rss>",
            ].join("")
          : [
              '<script type="application/ld+json">',
              JSON.stringify({
                "@type": "ScholarlyArticle",
                headline: `Registry Primary LLM Agent Paper ${index + 1}`,
                datePublished: "2026-07-27",
                identifier: `10.1000/registry-${index + 1}`,
                url: registered.primary.url,
              }),
              "</script>",
            ].join(""),
        { status: 200 },
      ),
    });

    assert.equal(result.dispatch.status, "primary");
    assert.equal(result.dispatch.selected_adapter, registered.adapter);
    assert.deepEqual(
      result.dispatch.attempts.map((attempt) => attempt.status),
      ["success"],
    );
  }
});
