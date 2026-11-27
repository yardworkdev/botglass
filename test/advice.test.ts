import assert from "node:assert/strict";
import { test } from "node:test";
import { adviceForPage } from "../src/advice.js";
import type { Verdict } from "../src/types.js";
import { makePage } from "./build.js";

test("bots with the same cause share one instruction", () => {
  const page = makePage({
    verdicts: [
      ["GPTBot", "js-dependent"],
      ["ClaudeBot", "js-dependent"],
    ],
  });
  const advice = adviceForPage(page);
  assert.equal(advice.length, 1);
  assert.match(advice[0] as string, /GPTBot and ClaudeBot do not run JavaScript/);
  assert.match(advice[0] as string, /server-render/);
});

test("one bot reads as a singular sentence", () => {
  const page = makePage({ verdicts: [["ClaudeBot", "js-dependent"]] });
  assert.match(adviceForPage(page)[0] as string, /ClaudeBot does not run JavaScript/);
});

test("a robots block names the bot and the file to edit", () => {
  const page = makePage({ verdicts: [["CCBot", "robots-blocked"]] });
  const advice = adviceForPage(page);
  assert.match(advice[0] as string, /Allow CCBot in robots\.txt/);
});

test("a refusal carries the HTTP status the bot actually got", () => {
  const page = makePage({
    verdicts: [
      ["GPTBot", "ua-blocked"],
      ["ClaudeBot", "ua-blocked"],
    ],
    botStatuses: { GPTBot: 403, ClaudeBot: 403 },
  });
  const advice = adviceForPage(page);
  assert.match(advice[0] as string, /were refused with HTTP 403/);
  assert.match(advice[0] as string, /WAF/);
});

test("cloaking advice says to serve the same text", () => {
  const page = makePage({ verdicts: [["PerplexityBot", "cloaked"]] });
  assert.match(adviceForPage(page)[0] as string, /same text a browser gets/);
});

test("a healthy page has no advice", () => {
  const page = makePage({ verdicts: [["GPTBot", "ok"]] });
  assert.deepEqual(adviceForPage(page), []);
});

test("thin pages get page-level advice even when the verdict is ok", () => {
  const page = makePage({ verdicts: [["GPTBot", "ok"]], baselineWords: 3 });
  const advice = adviceForPage(page);
  assert.equal(advice.length, 1);
  assert.match(advice[0] as string, /Only 3 words of text/);
});

test("advice is capped at five lines so it stays readable", () => {
  const page = makePage({
    verdicts: [
      ["A", "js-dependent"],
      ["B", "robots-blocked"],
      ["C", "cloaked"],
      ["D", "ua-blocked"],
      ["E", "error"],
    ],
    botStatuses: { E: null },
    baselineWords: 1,
    jsOnly: { renderedWords: 100, rawWords: 5, missingWords: 90, ratio: 0.9, sample: [] },
  });
  const advice = adviceForPage(page);
  assert.equal(advice.length, 5);
  assert.match(advice[0] as string, /request failed/);
  assert.match(advice[4] as string, /not run JavaScript/);
});

test("a refusal served to crawler and browser alike is called bot management", () => {
  const page = makePage({
    verdicts: [["GPTBot", "error"]],
    botStatuses: { GPTBot: 403 },
    baselineStatus: 403,
    mitigations: { GPTBot: "Cloudflare challenge" },
  });
  const advice = adviceForPage(page);
  assert.match(advice[0] as string, /GPTBot was refused HTTP 403 by Cloudflare challenge/);
  assert.match(advice[0] as string, /bot management/);
  assert.doesNotMatch(advice.join(" "), /TLS/);
});

test("a 429 to everyone is advice about rate limiting, not about the page", () => {
  const page = makePage({
    verdicts: [["GPTBot", "error"], ["ClaudeBot", "error"]],
    botStatuses: { GPTBot: 429, ClaudeBot: 429 },
    baselineStatus: 429,
  });
  const advice = adviceForPage(page);
  assert.match(advice[0] as string, /HTTP 429/);
  assert.match(advice[0] as string, /rate limits/);
  assert.doesNotMatch(advice.join(" "), /TLS/);
});

test("an error only the crawler got is not blamed on the browser", () => {
  const page = makePage({
    verdicts: [["GPTBot", "error"]],
    botStatuses: { GPTBot: 500 },
    baselineStatus: 200,
  });
  const advice = adviceForPage(page);
  assert.match(advice[0] as string, /HTTP 500 while a browser loads the page/);
});

test("a 401 to everyone is advice about authentication, not about bots", () => {
  const page = makePage({
    verdicts: [["GPTBot", "error"]],
    botStatuses: { GPTBot: 401 },
    baselineStatus: 401,
  });
  assert.match(adviceForPage(page)[0] as string, /Check authentication at your edge/);
});

/**
 * `botglass <url>` prints only the first fix line, cut at 150 characters. An
 * instruction that loses its verb to that cut is not a fix line, so the refusal
 * advice has to fit inside the budget it is printed in.
 */
test("the refusal fix fits the 150-character budget it is printed in", () => {
  const EIGHT = ["GPTBot", "OAI-SearchBot", "ChatGPT-User", "ClaudeBot", "PerplexityBot", "CCBot", "Googlebot", "meta-externalagent"];
  const shapes = [
    [["GPTBot", "error"]] as Array<[string, Verdict]>,
    [
      ["GPTBot", "error"],
      ["ClaudeBot", "error"],
      ["PerplexityBot", "error"],
      ["CCBot", "error"],
    ] as Array<[string, Verdict]>,
    EIGHT.map((b) => [b, "error"] as [string, Verdict]),
  ];
  for (const verdicts of shapes) {
    const advice = adviceForPage(
      makePage({
        verdicts,
        botStatuses: Object.fromEntries(verdicts.map(([name]) => [name, 403])),
        baselineStatus: 403,
        mitigations: Object.fromEntries(verdicts.map(([name]) => [name, "Cloudflare challenge"])),
      }),
    );
    assert.ok(advice.length >= 1, "expected a fix line");
    assert.ok(
      (advice[0] ?? "").length <= 150,
      `too long for the terminal: ${(advice[0] ?? "").length} chars — ${advice[0]}`,
    );
  }
});

test("more than four bots collapse to a count", () => {
  const page = makePage({
    verdicts: [
      ["GPTBot", "js-dependent"],
      ["ClaudeBot", "js-dependent"],
      ["PerplexityBot", "js-dependent"],
      ["CCBot", "js-dependent"],
      ["Googlebot", "js-dependent"],
    ],
  });
  assert.match(adviceForPage(page)[0] as string, /^5 crawlers do not run JavaScript/);
});
