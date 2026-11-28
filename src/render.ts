/**
 * Optional JavaScript rendering, used only for the raw-vs-rendered diff.
 *
 * Playwright is not a dependency: it is imported at run time so a user who only
 * wants the per-bot fetch never downloads a browser. If it is missing, the CLI
 * explains how to add it and carries on with the rest of the audit.
 *
 * Where Playwright is looked for matters. The tool is usually run from a
 * directory that is not its own: `npx -y github:yardworkdev/botglass#v0.4.3`
 * unpacks into a cache and a global install lives in a prefix, so resolving
 * "playwright" from this module's own location alone fails for every documented
 * install except a clone — even when Playwright is installed in the project the
 * user is auditing from. The working directory is therefore tried first, then
 * the directory npm was invoked from, and only then the ordinary resolution path
 * that serves a clone.
 */

import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { Renderer, RenderResult } from "./types.js";

export const NOT_INSTALLED =
  "Playwright is not installed, so --render cannot measure the JavaScript version. " +
  "Install it where you run botglass: `npm i -D playwright && npx playwright install chromium`, " +
  "then repeat with --render. Without it botglass still runs and labels JavaScript-only " +
  "verdicts as heuristic.";

export const NO_BROWSER =
  "Playwright is installed but its Chromium build is missing. Run `npx playwright install chromium`.";

export interface PlaywrightModule {
  chromium: {
    launch(options?: Record<string, unknown>): Promise<{
      newPage(options?: Record<string, unknown>): Promise<{
        goto(url: string, options?: Record<string, unknown>): Promise<unknown>;
        title(): Promise<string>;
        evaluate<T>(fn: () => T): Promise<T>;
        close(): Promise<void>;
      }>;
      close(): Promise<void>;
    }>;
  };
}

export interface PlaywrightRendererOptions {
  timeoutMs: number;
  /** Viewport width; wide screens get the desktop layout most crawlers see. */
  viewport?: { width: number; height: number };
  userAgent?: string;
}

function explainLaunchError(message: string): string {
  if (/Executable doesn't exist|playwright install|browserType\.launch/i.test(message)) {
    return `${message.split("\n")[0]}\n${NO_BROWSER}`;
  }
  return message;
}

/** Directories whose node_modules are searched before this module's own. */
function searchDirs(): string[] {
  const dirs = [process.cwd()];
  const initCwd = process.env.INIT_CWD;
  if (initCwd && initCwd !== process.cwd()) dirs.push(initCwd);
  return dirs;
}

function asPlaywrightModule(loaded: unknown): PlaywrightModule | null {
  if (!loaded || typeof loaded !== "object") return null;
  const direct = loaded as PlaywrightModule;
  if (direct.chromium) return direct;
  const viaDefault = (loaded as { default?: PlaywrightModule }).default;
  return viaDefault && viaDefault.chromium ? viaDefault : null;
}

async function importFrom(dir: string): Promise<PlaywrightModule | null> {
  try {
    const requireFrom = createRequire(join(dir, "package.json"));
    const resolved = requireFrom.resolve("playwright");
    return asPlaywrightModule(await import(pathToFileURL(resolved).href));
  } catch {
    return null;
  }
}

async function importBare(): Promise<PlaywrightModule | null> {
  try {
    // Keep the specifier opaque so TypeScript does not need playwright types.
    const specifier = "playwright";
    return asPlaywrightModule(await import(specifier));
  } catch {
    return null;
  }
}

/** Playwright from the caller's project first, then the module's own tree. */
export async function loadPlaywright(): Promise<PlaywrightModule | null> {
  for (const dir of searchDirs()) {
    const found = await importFrom(dir);
    if (found) return found;
  }
  return importBare();
}

export async function createPlaywrightRenderer(
  options: PlaywrightRendererOptions,
): Promise<Renderer> {
  const playwright = await loadPlaywright();
  if (!playwright) throw new Error(NOT_INSTALLED);

  const loaded = playwright;

  return async (url: string): Promise<RenderResult> => {
    let browser;
    try {
      browser = await loaded.chromium.launch({ args: ["--no-sandbox"] });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        error: explainLaunchError(message),
        text: "",
        wordCount: 0,
        title: "",
      };
    }
    try {
      const page = await browser.newPage({
        viewport: options.viewport ?? { width: 1440, height: 900 },
        ...(options.userAgent ? { userAgent: options.userAgent } : {}),
      });
      await page.goto(url, {
        waitUntil: "networkidle",
        timeout: options.timeoutMs,
      });
      const text = await page.evaluate(() => document.body?.innerText ?? "");
      const title = await page.title();
      const words = text
        .split(/\s+/)
        .map((w) => w.trim())
        .filter((w) => w.length > 0).length;
      await page.close();
      return { ok: true, error: null, text, wordCount: words, title };
    } catch (err) {
      return {
        ok: false,
        error: explainLaunchError(err instanceof Error ? err.message : String(err)),
        text: "",
        wordCount: 0,
        title: "",
      };
    } finally {
      await browser.close();
    }
  };
}
