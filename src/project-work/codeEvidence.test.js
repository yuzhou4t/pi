import assert from "node:assert/strict";
import test from "node:test";
import {
  codeEvidenceHref,
  parseCodeEvidenceHref,
  remarkCodeEvidence,
} from "./codeEvidence.js";

const evidence = {
  path: "src/example.js",
  contentHash: `sha256:${"a".repeat(64)}`,
  startLine: 10,
  endLine: 30,
};

test("code evidence href round-trips the hash-bound location", () => {
  const href = codeEvidenceHref(evidence, 12, 14);
  assert.deepEqual(parseCodeEvidenceHref(href), {
    path: evidence.path,
    contentHash: evidence.contentHash,
    startLine: 12,
    endLine: 14,
  });
});

test("remark code evidence links only locations inside the read range", () => {
  const tree = {
    type: "root",
    children: [{
      type: "paragraph",
      children: [{
        type: "text",
        value: "见 src/example.js:12-14；不要链接 src/example.js:40。",
      }],
    }],
  };
  remarkCodeEvidence({ evidence: [evidence] })(tree);
  const children = tree.children[0].children;
  assert.equal(children.some((node) => node.type === "link"), true);
  assert.equal(
    children.filter((node) => node.type === "link").length,
    1,
  );
  assert.match(
    children.find((node) => node.type === "text" && /40/.test(node.value)).value,
    /src\/example\.js:40/,
  );
});

test("remark code evidence links an exact inline-code location", () => {
  const tree = {
    type: "root",
    children: [{
      type: "paragraph",
      children: [{
        type: "inlineCode",
        value: "src/example.js:12",
      }],
    }],
  };
  remarkCodeEvidence({ evidence: [evidence] })(tree);
  assert.deepEqual(tree.children[0].children, [{
    type: "link",
    url: codeEvidenceHref(evidence, 12),
    title: "打开 src/example.js 第 12 行",
    children: [{
      type: "inlineCode",
      value: "src/example.js:12",
    }],
  }]);
});

test("remark code evidence uses the newest matching file hash", () => {
  const latest = {
    ...evidence,
    contentHash: `sha256:${"b".repeat(64)}`,
  };
  const tree = {
    type: "root",
    children: [{
      type: "paragraph",
      children: [{
        type: "text",
        value: "src/example.js:12",
      }],
    }],
  };
  remarkCodeEvidence({ evidence: [evidence, latest] })(tree);
  const link = tree.children[0].children.find((node) => node.type === "link");
  assert.equal(
    parseCodeEvidenceHref(link.url).contentHash,
    latest.contentHash,
  );
});

test("remark code evidence leaves unrelated inline code unchanged", () => {
  const tree = {
    type: "root",
    children: [{
      type: "paragraph",
      children: [{
        type: "inlineCode",
        value: "npm run verify",
      }],
    }],
  };
  remarkCodeEvidence({ evidence: [evidence] })(tree);
  assert.deepEqual(tree.children[0].children, [{
    type: "inlineCode",
    value: "npm run verify",
  }]);
});
