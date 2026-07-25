import assert from "node:assert/strict";
import test from "node:test";
import {
  fetchDblpSource,
  parseDblpIndexTargets,
  parseDblpPublications,
} from "./dblpAdapter.js";

const conferenceIndex = `
<bht>
  <proceedings key="conf/acl/2026-1" mdate="2026-07-06">
    <title>ACL 2026</title>
    <url>db/conf/acl/acl2026-1.html</url>
  </proceedings>
  <proceedings key="conf/acl/2025-1" mdate="2025-11-02">
    <url>db/conf/acl/acl2025-1.html</url>
  </proceedings>
</bht>`;

const volumeXml = `
<bht>
  <inproceedings key="conf/acl/Test26" mdate="2026-07-06">
    <author>Ada Example</author>
    <author>Lin Test</author>
    <title>Efficient &amp; Verifiable Agent Memory.</title>
    <year>2026</year>
    <booktitle>ACL</booktitle>
    <ee type="oa">https://aclanthology.org/2026.acl-long.1/</ee>
    <ee>https://doi.org/10.1000/test</ee>
    <url>db/conf/acl/acl2026-1.html#Test26</url>
  </inproceedings>
  <inproceedings key="conf/acl/Front26" mdate="2026-07-06">
    <title>Frontmatter.</title>
    <year>2026</year>
  </inproceedings>
</bht>`;

test("conference index resolves the latest DBLP volume XML targets", () => {
  assert.deepEqual(parseDblpIndexTargets(conferenceIndex, {
    type: "conference",
    maxVolumes: 1,
  }), [{
    url: "https://dblp.org/db/conf/acl/acl2026-1.xml",
    modified_at: "2026-07-06",
  }]);
});

test("publication parsing keeps bibliographic facts and derives known public PDFs", () => {
  const [paper] = parseDblpPublications(volumeXml, {
    id: "acl",
    name: "ACL",
    type: "conference",
  });
  assert.equal(paper.paper_id, "conf/acl/Test26");
  assert.equal(paper.title, "Efficient & Verifiable Agent Memory.");
  assert.deepEqual(paper.authors, ["Ada Example", "Lin Test"]);
  assert.equal(paper.doi, "10.1000/test");
  assert.equal(paper.pdf_url, "https://aclanthology.org/2026.acl-long.1.pdf");
  assert.equal(paper.abstract, "");
});

test("publication parsing derives JMLR, PMLR, and NeurIPS public PDFs", () => {
  const xml = `<?xml version="1.0"?>
<dblp>
  <article key="journals/jmlr/Test26"><author>A</author><title>JMLR Test.</title><year>2026</year><ee>http://www.jmlr.org/papers/v27/test.html</ee><url>db/journals/jmlr/test.html</url></article>
  <inproceedings key="conf/icml/Test26"><author>B</author><title>ICML Test.</title><year>2026</year><ee>http://proceedings.mlr.press/v1/test.html</ee><url>db/conf/icml/test.html</url></inproceedings>
  <inproceedings key="conf/nips/Test26"><author>C</author><title>NeurIPS Test.</title><year>2026</year><ee>https://proceedings.neurips.cc/paper_files/paper/2026/hash/abc-Abstract-Conference.html</ee><url>db/conf/nips/test.html</url></inproceedings>
  <inproceedings key="conf/nips/Legacy26"><author>D</author><title>NeurIPS Domain Test.</title><year>2026</year><ee>http://papers.nips.cc/paper_files/paper/2026/hash/def-Abstract-Conference.html</ee><url>db/conf/nips/legacy.html</url></inproceedings>
</dblp>`;
  const papers = parseDblpPublications(xml, {
    id: "mixed",
    name: "Mixed",
    type: "conference",
  });
  assert.deepEqual(papers.map((paper) => paper.pdf_url), [
    "https://jmlr.org/papers/v27/test.pdf",
    "https://proceedings.mlr.press/v1/test.pdf",
    "https://proceedings.neurips.cc/paper_files/paper/2026/hash/abc-Paper-Conference.pdf",
    "https://papers.nips.cc/paper_files/paper/2026/hash/def-Paper-Conference.pdf",
  ]);
});

test("fetching a source follows the index without depending on live network", async () => {
  const requested = [];
  const delays = [];
  const fetchImpl = async (url) => {
    requested.push(url);
    return new Response(url.endsWith("index.xml") ? conferenceIndex : volumeXml, {
      status: 200,
      headers: { "content-type": "application/xml" },
    });
  };
  const result = await fetchDblpSource({
    id: "acl",
    name: "ACL",
    type: "conference",
    dblp_path: "conf/acl",
  }, {
    fetchImpl,
    maxVolumes: 1,
    requestDelayMs: 1500,
    sleep: async (milliseconds) => delays.push(milliseconds),
  });
  assert.equal(result.papers.length, 1);
  assert.deepEqual(delays, [1500]);
  assert.deepEqual(requested, [
    "https://dblp.org/db/conf/acl/index.xml",
    "https://dblp.org/db/conf/acl/acl2026-1.xml",
  ]);
});

test("fetching a source falls back to an official DBLP mirror", async () => {
  const requested = [];
  const fetchImpl = async (url) => {
    requested.push(url);
    if (url.startsWith("https://dblp.org/")) {
      return new Response("", { status: 429 });
    }
    return new Response(url.endsWith("index.xml") ? conferenceIndex : volumeXml, {
      status: 200,
      headers: { "content-type": "application/xml" },
    });
  };

  const result = await fetchDblpSource({
    id: "acl",
    name: "ACL",
    type: "conference",
    dblp_path: "conf/acl",
  }, {
    fetchImpl,
    maxVolumes: 1,
    requestDelayMs: 1,
    sleep: async () => {},
  });

  assert.equal(result.papers.length, 1);
  assert.ok(requested.some((url) => url.startsWith("https://dblp.dagstuhl.de/")));
});
