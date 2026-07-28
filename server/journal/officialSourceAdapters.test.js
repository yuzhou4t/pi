import assert from "node:assert/strict";
import test from "node:test";
import {
  fetchOfficialSource,
  OFFICIAL_SOURCE_ADAPTERS,
  OfficialSourceError,
} from "./officialSourceAdapters.js";
import { SOURCE_REGISTRY } from "./sourceRegistry.js";

function jsonLdFixture(source, index) {
  return [
    "<!doctype html>",
    "<html><head>",
    '<script type="application/ld+json">',
    JSON.stringify({
      "@context": "https://schema.org",
      "@type": "ScholarlyArticle",
      headline: `Official LLM Agent Paper ${index + 1}`,
      author: [{ "@type": "Person", name: "Ada Author" }],
      datePublished: "2026-07-27",
      identifier: `https://doi.org/10.1000/official-${index + 1}`,
      url: source.primary.url,
      description: "An official structured abstract.",
    }),
    "</script>",
    "</head><body></body></html>",
  ].join("");
}

test("all eleven registered primary adapters request their declared official route", async () => {
  assert.equal(Object.keys(OFFICIAL_SOURCE_ADAPTERS).length, 11);
  for (const [index, source] of SOURCE_REGISTRY.entries()) {
    const requested = [];
    const handler = OFFICIAL_SOURCE_ADAPTERS[source.adapter];
    assert.equal(typeof handler, "function", `${source.adapter} must be registered`);
    const result = await handler(source, {
      route: source.primary,
      fetchImpl: async (url) => {
        requested.push(String(url));
        return new Response(jsonLdFixture(source, index), {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      },
    });

    assert.equal(requested[0], source.primary.url);
    assert.equal(result.index_url, source.primary.url);
    assert.equal(result.papers.length, 1);
    assert.equal(result.papers[0].publication_date_precision, "day");
    assert.equal(result.papers[0].published_at, "2026-07-27");
    assert.equal(result.papers[0].provenance.adapter, source.adapter);
    assert.equal(result.papers[0].provenance.evidence_kind, "json_ld");
  }
});

test("citation metadata preserves exact date, authors, DOI, PDF, and provenance", async () => {
  const source = SOURCE_REGISTRY.find((item) => item.adapter === "jmlr-papers-index");
  const html = [
    "<html><head>",
    '<meta name="citation_title" content="Reliable LLM Agent Memory">',
    '<meta name="citation_author" content="Ada Author">',
    '<meta name="citation_author" content="Lin Researcher">',
    '<meta name="citation_publication_date" content="2026/07/27">',
    '<meta name="citation_doi" content="10.1000/citation-meta">',
    '<meta name="citation_pdf_url" content="https://jmlr.org/papers/v27/meta.pdf">',
    '<meta name="citation_abstract" content="A bounded official abstract.">',
    "</head></html>",
  ].join("");

  const result = await OFFICIAL_SOURCE_ADAPTERS[source.adapter](source, {
    route: source.primary,
    fetchImpl: async () => new Response(html, { status: 200 }),
  });
  const [paper] = result.papers;

  assert.deepEqual(paper.authors, ["Ada Author", "Lin Researcher"]);
  assert.equal(paper.published_at, "2026-07-27");
  assert.equal(paper.publication_date_precision, "day");
  assert.equal(paper.doi, "10.1000/citation-meta");
  assert.equal(paper.pdf_url, "https://jmlr.org/papers/v27/meta.pdf");
  assert.equal(paper.provenance.evidence_kind, "citation_meta");
});

test("an official paper link stays date-unknown when its detail page has no structured date", async () => {
  const source = SOURCE_REGISTRY.find((item) => item.adapter === "jmlr-papers-index");
  const detailUrl = "https://www.jmlr.org/papers/v27/agent.html";
  const requested = [];
  const result = await OFFICIAL_SOURCE_ADAPTERS[source.adapter](source, {
    route: source.primary,
    fetchImpl: async (url) => {
      requested.push(String(url));
      if (String(url) === source.primary.url) {
        return new Response(
          `<a href="${detailUrl}">Reliable LLM Agent Memory Workflows</a>`,
          { status: 200 },
        );
      }
      return new Response("<html><body>Paper page without metadata.</body></html>", {
        status: 200,
      });
    },
  });
  const [paper] = result.papers;

  assert.deepEqual(requested, [source.primary.url, detailUrl]);
  assert.equal(paper.published_at, null);
  assert.equal(paper.publication_date_precision, "unknown");
  assert.equal(paper.provenance.evidence_kind, "official_index_link");
});

test("nested official indexes are followed once before bounded paper detail parsing", async () => {
  const source = SOURCE_REGISTRY.find((item) => item.adapter === "aaai-ojs-archive");
  const issueUrl = "https://ojs.aaai.org/index.php/AAAI/issue/view/99";
  const paperUrl = "https://ojs.aaai.org/index.php/AAAI/article/view/123";
  const requested = [];
  const result = await OFFICIAL_SOURCE_ADAPTERS[source.adapter](source, {
    route: source.primary,
    fetchImpl: async (url) => {
      requested.push(String(url));
      if (String(url) === source.primary.url) {
        return new Response(`<a href="${issueUrl}">AAAI 2026 issue</a>`, { status: 200 });
      }
      if (String(url) === issueUrl) {
        return new Response(
          `<a href="${paperUrl}">A Reliable LLM Agent Evaluation Benchmark</a>`,
          { status: 200 },
        );
      }
      return new Response([
        '<meta name="citation_title" content="A Reliable LLM Agent Evaluation Benchmark">',
        '<meta name="citation_date" content="July 27, 2026">',
        '<meta name="citation_doi" content="10.1000/aaai-primary">',
      ].join(""), { status: 200 });
    },
  });

  assert.deepEqual(requested, [source.primary.url, issueUrl, paperUrl]);
  assert.equal(result.papers[0].publication_date_precision, "day");
  assert.equal(result.papers[0].published_at, "2026-07-27");
});

test("official source fetch rejects oversized bodies and unsafe routes", async () => {
  const source = SOURCE_REGISTRY[0];
  await assert.rejects(
    OFFICIAL_SOURCE_ADAPTERS[source.adapter](source, {
      route: source.primary,
      fetchImpl: async () => new Response("oversized", {
        status: 200,
        headers: { "content-length": String(9 * 1024 * 1024) },
      }),
    }),
    (error) => (
      error instanceof OfficialSourceError
      && error.code === "OFFICIAL_BODY_TOO_LARGE"
    ),
  );

  await assert.rejects(
    fetchOfficialSource({
      ...source,
      primary: {
        ...source.primary,
        url: "https://127.0.0.1/private",
      },
    }, {
      adapterName: source.adapter,
      route: {
        ...source.primary,
        url: "https://127.0.0.1/private",
      },
      fetchImpl: async () => {
        throw new Error("unsafe URL must not be fetched");
      },
    }),
    (error) => (
      error instanceof OfficialSourceError
      && error.code === "OFFICIAL_URL_REJECTED"
    ),
  );
});
