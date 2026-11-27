import { test } from "node:test";
import assert from "node:assert/strict";
import { edgeMitigation, fetchAs, isRefusal } from "../src/fetch.js";
import { startFixture } from "./fixture.js";

/**
 * The detector must only name a product whose own signature is in the response.
 * A wrong "Cloudflare" in a report is worse than no name at all, because people
 * go and change settings they do not own.
 */
test("a Cloudflare challenge is named from its header", () => {
  assert.equal(
    edgeMitigation({ server: "cloudflare", "cf-mitigated": "challenge" }, "<html>whatever</html>"),
    "Cloudflare challenge",
  );
});

test("a Cloudflare challenge is named from its body when the header is stripped", () => {
  assert.equal(
    edgeMitigation(
      { server: "cloudflare" },
      `<title>Just a moment...</title><script>window.__cf_chl_opt={}</script>`,
    ),
    "Cloudflare challenge",
  );
});

test("an ordinary 403 from an unknown server names no product", () => {
  assert.equal(edgeMitigation({ server: "nginx" }, "<h1>Forbidden</h1>"), null);
});

test("an Akamai answer is not labelled Cloudflare", () => {
  assert.equal(
    edgeMitigation({ server: "Akamai Ghostname/5.0.0" }, "<p>Access Denied</p>"),
    null,
  );
});

test("a DataDome interstitial is named", () => {
  assert.equal(edgeMitigation({ "x-datadome-cld": "submit" }, "<p>blocked</p>"), "DataDome challenge");
});

test("403 and 429 are refusals, 500 and 404 are not", () => {
  assert.equal(isRefusal(403), true);
  assert.equal(isRefusal(429), true);
  assert.equal(isRefusal(404), false);
  assert.equal(isRefusal(503), false);
  assert.equal(isRefusal(null), false);
});

test("fetchAs records the server and the mitigation of the answer it got", async () => {
  const fixture = await startFixture();
  try {
    const challenged = await fetchAs(`${fixture.base}/challenge`, "GPTBot/1.2", { timeoutMs: 5000 });
    assert.equal(challenged.status, 403);
    assert.equal(challenged.server, "cloudflare");
    assert.equal(challenged.mitigation, "Cloudflare challenge");

    const plain = await fetchAs(`${fixture.base}/refused`, "GPTBot/1.2", { timeoutMs: 5000 });
    assert.equal(plain.status, 403);
    assert.equal(plain.mitigation, null, "no signature, no product name");

    const good = await fetchAs(`${fixture.base}/ssr`, "GPTBot/1.2", { timeoutMs: 5000 });
    assert.equal(good.status, 200);
    assert.equal(good.mitigation, null);

    const dead = await fetchAs("http://127.0.0.1:1/nothing", "GPTBot/1.2", { timeoutMs: 5000 });
    assert.equal(dead.status, null);
    assert.equal(dead.mitigation, null);
    assert.equal(dead.error !== null, true);
  } finally {
    await fixture.close();
  }
});
