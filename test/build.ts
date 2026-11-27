/**
 * Small builders for report-shaped fixtures.
 *
 * Only the fields a test actually depends on are explicit; everything else gets
 * a boring default so a new required field does not force an edit in every test.
 */

import { adviceForPage } from "../src/advice.js";
import type { UsageDecision } from "../src/aipref.js";
import type { BotResult, BotVerdict, JsOnlyReport, PageReport, RenderResult, Verdict } from "../src/types.js";

export function makeBot(bot: string, status: number | null = 200, wordCount = 100): BotResult {
  return {
    bot,
    status,
    finalUrl: "https://example.com/",
    redirects: [],
    durationMs: 10,
    htmlBytes: 1000,
    title: "Example",
    description: "",
    text: "x ".repeat(wordCount).trim(),
    wordCount,
    robots: { available: true, allowed: true, rule: null, robotsUrl: "https://example.com/robots.txt", status: 200 },
    similarityToBaseline: 1,
    error: status === null ? "request failed" : null,
    server: null,
    mitigation: null,
  };
}

export interface PageInput {
  url?: string;
  httpStatus?: number | null;
  baselineWords?: number;
  /** Status the plain browser got; defaults to a healthy 200. */
  baselineStatus?: number | null;
  /** `Server`/mitigation of the browser answer, for edge-refusal advice tests. */
  baselineMitigation?: string | null;
  /** [bot name, verdict] pairs; the same bots become the page's bot results. */
  verdicts?: Array<[string, Verdict]>;
  botStatuses?: Record<string, number | null>;
  /** Bot-management product named per bot, when the response carried one. */
  mitigations?: Record<string, string | null>;
  jsOnly?: JsOnlyReport | null;
  render?: RenderResult | null;
  usage?: UsageDecision;
}

export const NO_USAGE: UsageDecision = { signals: [], trainAi: null, source: null, malformed: [], unknownCategories: [] };

export function makePage(input: PageInput = {}): PageReport {
  const verdicts: BotVerdict[] = (input.verdicts ?? [["GPTBot", "ok"]]).map(([bot, verdict]) => ({
    bot,
    verdict,
    reason: `${verdict} reason`,
    confidence: "measured",
  }));
  const bots = verdicts.map((verdict) => {
    // `?? 200` would swallow an explicit null, and null means "no answer at all".
    const statuses = input.botStatuses;
    const status = statuses && verdict.bot in statuses ? statuses[verdict.bot]! : 200;
    const built = makeBot(verdict.bot, status, verdict.verdict === "js-dependent" ? 3 : 100);
    const mitigation = input.mitigations?.[verdict.bot];
    return mitigation === undefined ? built : { ...built, mitigation };
  });
  const baseline = makeBot("baseline", input.baselineStatus === undefined ? 200 : input.baselineStatus, input.baselineWords ?? 120);
  const page = {
    url: input.url ?? "https://example.com/",
    fetchedAt: "2026-11-04T10:00:00.000Z",
    httpStatus: input.httpStatus === undefined ? 200 : input.httpStatus,
    robotsUrl: "https://example.com/robots.txt",
    robotsStatus: 200,
    baseline:
      input.baselineMitigation === undefined
        ? baseline
        : { ...baseline, mitigation: input.baselineMitigation },
    bots,
    render: input.render ?? null,
    jsOnly: input.jsOnly ?? null,
    verdicts,
    findings: [],
    usage: input.usage ?? NO_USAGE,
  } as unknown as PageReport;
  return { ...page, advice: adviceForPage(page) };
}
