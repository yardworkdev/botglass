import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createPlaywrightRenderer, NOT_INSTALLED, NO_BROWSER } from "../src/render.js";

/**
 * `--render` is the difference between a measured verdict and a guess, and the
 * tool is almost never run from its own directory: `npx -y <repo>` unpacks into
 * a cache and `npm install -g` lives in a prefix. Playwright is installed in the
 * project the user is auditing from, not next to botglass, so these tests put a
 * fake Playwright in a scratch project and prove the renderer picks it up from
 * the working directory rather than from this module's own node_modules.
 */

const FAKE_PLAYWRIGHT = `
module.exports = {
  chromium: {
    async launch() {
      return {
        async newPage() {
          return {
            async goto() {},
            async evaluate() { return "one two three four five"; },
            async title() { return "Fake rendered page"; },
            async close() {},
          };
        },
        async close() {},
      };
    },
  },
};
`;

const FAKE_PLAYWRIGHT_NO_BROWSER = `
module.exports = {
  chromium: {
    async launch() {
      throw new Error(
        "browserType.launch: Executable doesn't exist at /root/.cache/ms-playwright/chromium-9999/chrome-linux/chrome"
      );
    },
  },
};
`;

async function projectWithPlaywright(source: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "botglass-render-"));
  const moduleDir = join(dir, "node_modules", "playwright");
  await mkdir(moduleDir, { recursive: true });
  await writeFile(
    join(moduleDir, "package.json"),
    JSON.stringify({ name: "playwright", version: "0.0.0", main: "index.js" }),
  );
  await writeFile(join(moduleDir, "index.js"), source);
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "user-project", version: "0.0.0" }));
  return dir;
}

async function inDirectory<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const before = process.cwd();
  const beforeInit = process.env.INIT_CWD;
  process.chdir(dir);
  delete process.env.INIT_CWD;
  try {
    return await fn();
  } finally {
    process.chdir(before);
    if (beforeInit === undefined) delete process.env.INIT_CWD;
    else process.env.INIT_CWD = beforeInit;
  }
}

test("--render uses the Playwright installed in the directory botglass is run from", async () => {
  const dir = await projectWithPlaywright(FAKE_PLAYWRIGHT);
  await inDirectory(dir, async () => {
    const render = await createPlaywrightRenderer({ timeoutMs: 5_000 });
    const result = await render("https://example.com/");
    assert.equal(result.ok, true);
    assert.equal(result.title, "Fake rendered page");
    assert.equal(result.wordCount, 5);
  });
});

test("a missing Chromium build is reported with the command that fixes it", async () => {
  const dir = await projectWithPlaywright(FAKE_PLAYWRIGHT_NO_BROWSER);
  await inDirectory(dir, async () => {
    const render = await createPlaywrightRenderer({ timeoutMs: 5_000 });
    const result = await render("https://example.com/");
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /Executable doesn't exist/);
    assert.ok((result.error ?? "").includes(NO_BROWSER));
  });
});

test("missing Playwright names the install command and keeps the audit usable", () => {
  assert.match(NOT_INSTALLED, /npm i -D playwright/);
  assert.match(NOT_INSTALLED, /heuristic/);
});
