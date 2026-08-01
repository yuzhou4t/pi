import assert from "node:assert/strict";
import test, { after } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

let vitePromise;

async function loadModule() {
  vitePromise ??= createServer({
    root: process.cwd(),
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  return (await vitePromise).ssrLoadModule("/src/components/PeriodNavigator.jsx");
}

after(async () => {
  if (vitePromise) await (await vitePromise).close();
});

test("period navigation resolves adjacent ids without wrapping", async () => {
  const { adjacentPeriodId } = await loadModule();
  const periods = [{ id: "oldest" }, { id: "middle" }, { id: "latest" }];

  assert.equal(adjacentPeriodId(periods, "middle", "previous"), "oldest");
  assert.equal(adjacentPeriodId(periods, "middle", "next"), "latest");
  assert.equal(adjacentPeriodId(periods, "oldest", "previous"), null);
  assert.equal(adjacentPeriodId(periods, "latest", "next"), null);
  assert.equal(adjacentPeriodId(periods, "missing", "next"), null);
});

test("period navigator exposes one current period, count, and boundary state", async () => {
  const { PeriodNavigator } = await loadModule();
  const html = renderToStaticMarkup(React.createElement(PeriodNavigator, {
    periods: [{ id: "may" }, { id: "june" }, { id: "july" }],
    activeId: "july",
    activeLabel: "2026-07-01 那期",
    onSelect() {},
  }));

  assert.match(html, /2026-07-01 那期/);
  assert.match(html, /第 3 期 · 共 3 期/);
  assert.match(html, /aria-label="查看上一期"/);
  assert.match(html, /<button[^>]*disabled=""[^>]*aria-label="查看下一期"/);
  assert.match(html, /tabindex="0"/);
});
