/**
 * What to do about a finding.
 *
 * A verdict says what is wrong; advice says what to change, grouped by cause so
 * eight bots with the same problem produce one instruction, not eight. Agents
 * act on this list, so it stays short and every line names a change.
 */

import { isRefusal } from "./fetch.js";
import type { BotVerdict, PageReport, Verdict } from "./types.js";

const THIN_PAGE_WORDS = 50;

/** "GPTBot", "GPTBot and ClaudeBot", "4 bots". */
function listBots(bots: string[]): string {
  if (bots.length === 0) return "The crawlers";
  if (bots.length === 1) return bots[0] as string;
  if (bots.length === 2) return `${bots[0]} and ${bots[1]}`;
  if (bots.length <= 4) return `${bots.slice(0, -1).join(", ")} and ${bots[bots.length - 1]}`;
  return `${bots.length} crawlers`;
}

/**
 * Who a fix line is about. The per-bot list lives in the JSON and in the verdict
 * table; a fix line that names four crawlers individually overflows the width
 * the terminal prints it in, so beyond one crawler the count carries.
 */
function collapseBots(bots: string[]): string {
  if (bots.length === 1) return bots[0] as string;
  return `${bots.length} crawlers`;
}

function groupByVerdict(verdicts: BotVerdict[]): Map<Verdict, string[]> {
  const groups = new Map<Verdict, string[]>();
  for (const verdict of verdicts) {
    if (verdict.verdict === "ok") continue;
    const list = groups.get(verdict.verdict) ?? [];
    list.push(verdict.bot);
    groups.set(verdict.verdict, list);
  }
  return groups;
}

function usageAdvice(page: PageReport): string[] {
  const usage = page.usage;
  if (!usage) return [];
  const out: string[] = [];

  if (usage.unknownCategories.length > 0) {
    out.push(
      `Content-Usage uses the label "${usage.unknownCategories[0]}", which is not in the draft vocabulary (train-ai, ai-use, search); crawlers ignore unknown labels, so this declaration has no effect.`,
    );
  }

  if (usage.malformed.length > 0) {
    out.push(
      `robots.txt has a Content-Usage value we cannot parse ("${usage.malformed[0]}"): write a structured-field dictionary with an explicit y or n, for example "train-ai=n".`,
    );
  }

  // Content-Usage states a usage preference, not crawl permission. Allowing a
  // fetch while declaring train-ai=n (or blocking one crawler while declaring
  // train-ai=y for another) is not a contradiction; those are separate stages.
  // Values other than y and n leave the category unknown, not "ask first".

  return out;
}

/** Page-level advice that is not tied to a single bot. */
function pageAdvice(page: PageReport, alreadyMentionsJs: boolean, alreadyMentionsEdge: boolean): string[] {
  const out: string[] = [];
  if (page.httpStatus !== null && page.httpStatus >= 400 && !alreadyMentionsEdge) {
    out.push(`The page itself returned HTTP ${page.httpStatus} to a normal browser.`);
  }
  const baselineWords = page.baseline.wordCount;
  if (page.httpStatus !== null && page.httpStatus < 400 && baselineWords < THIN_PAGE_WORDS) {
    out.push(
      `Only ${baselineWords} words of text in the HTML: put the page's main copy in the server response, not behind a script.`,
    );
  }
  if (!alreadyMentionsJs && page.jsOnly && page.jsOnly.ratio >= 0.5) {
    out.push(
      `${(page.jsOnly.ratio * 100).toFixed(0)}% of the rendered text is JavaScript-only; treat server rendering as the fix, not an optimisation.`,
    );
  }
  return out;
}

/** Deduplicated, ordered fix list for one page. Empty when every bot is fine. */
export function adviceForPage(page: PageReport): string[] {
  const groups = groupByVerdict(page.verdicts);
  const out: string[] = [];

  const errors = groups.get("error");
  let edgeCovered = false;
  if (errors) {
    const statusOf = new Map(page.bots.map((bot) => [bot.bot, bot.status]));
    const unreachable = errors.filter((name) => statusOf.get(name) === null);
    const refused = errors.filter(
      (name) => isRefusal(statusOf.get(name) ?? null) && isRefusal(page.baseline.status),
    );
    const answered = errors.filter(
      (name) => statusOf.get(name) !== null && !refused.includes(name),
    );

    if (refused.length > 0) {
      const status = statusOf.get(refused[0] as string) ?? null;
      const edge = page.bots.find((bot) => refused.includes(bot.bot) && bot.mitigation !== null)?.mitigation ?? null;
      const cause = status === 429 ? "rate limits" : status === 401 ? "authentication" : "bot management";
      edgeCovered = true;
      out.push(
        `${collapseBots(refused)} ${refused.length === 1 ? "was" : "were"} refused HTTP ${status}${edge ? ` by ${edge}` : ""}; a plain browser got the same. Check ${cause} at your edge, not robots.txt.`,
      );
    }
    if (answered.length > 0) {
      const status = statusOf.get(answered[0] as string) ?? null;
      out.push(
        page.baseline.status !== null && page.baseline.status >= 400
          ? `The URL itself answers HTTP ${page.baseline.status} to a normal browser; fix the page before judging crawler access.`
          : `${collapseBots(answered)} ${answered.length === 1 ? "got" : "were given"} HTTP ${status} while a browser loads the page; that is an error specific to these crawlers, most likely a rule at the edge rather than in the site.`,
      );
    }
    if (unreachable.length > 0) {
      out.push(
        `The request failed for ${listBots(unreachable)}; fix reachability, TLS or the redirect chain before judging crawler access.`,
      );
    }
  }
  const blocked = groups.get("ua-blocked");
  if (blocked) {
    const statuses = new Set(
      page.bots
        .filter((bot) => blocked.includes(bot.bot))
        .map((bot) => bot.status)
        .filter((status): status is number => typeof status === "number"),
    );
    const code = statuses.size === 1 ? ` with HTTP ${Array.from(statuses)[0]}` : "";
    out.push(
      `${listBots(blocked)} ${blocked.length === 1 ? "was" : "were"} refused${code}; check WAF/CDN bot rules, user-agent filtering and rate limits in front of the origin.`,
    );
  }
  const cloaked = groups.get("cloaked");
  if (cloaked) {
    out.push(
      `Serve ${listBots(cloaked)} the same text a browser gets; this looks like content switching by user agent.`,
    );
  }
  const robots = groups.get("robots-blocked");
  if (robots) {
    out.push(`Allow ${listBots(robots)} in robots.txt — the current rules disallow the URL you checked.`);
  }
  const js = groups.get("js-dependent");
  if (js) {
    out.push(
      `${listBots(js)} ${js.length === 1 ? "does" : "do"} not run JavaScript: server-render the page text (SSR, static generation or prerender).`,
    );
  }

  out.push(...pageAdvice(page, js !== undefined, edgeCovered));
  out.push(...usageAdvice(page));
  return out.slice(0, 5);
}
