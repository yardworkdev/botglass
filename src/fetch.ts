/**
 * Fetching a URL as a given identity.
 *
 * We follow redirects by hand so the report can show the chain: a crawler that
 * is redirected to a login page or a different host is worth knowing about,
 * and `fetch`'s automatic follow hides that.
 */

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

/**
 * Statuses that mean "this client is not welcome here" rather than "this page is
 * broken". A refusal decides a verdict; a 500 does not.
 */
export const REFUSAL_STATUSES = new Set([401, 403, 406, 429, 451]);

export function isRefusal(status: number | null): boolean {
  return status !== null && REFUSAL_STATUSES.has(status);
}

/**
 * Name the bot-management product that answered, from evidence only that product
 * leaves behind. `null` means no signature was recognised — never "there is no
 * edge in front of the origin", which we cannot tell from here.
 */
export function edgeMitigation(headers: Record<string, string>, body: string): string | null {
  const cloudflareMarker = /__cf_chl|cf-chl-|cf-browser-verification|Just a moment/.test(body);
  if (headers["cf-mitigated"] !== undefined || (isCloudflare(headers) && cloudflareMarker)) {
    return "Cloudflare challenge";
  }
  if (headers["x-datadome-cld"] !== undefined || /\.datadome\.net|datadome[_-]captcha/.test(body)) {
    return "DataDome challenge";
  }
  return null;
}

function isCloudflare(headers: Record<string, string>): boolean {
  return /cloudflare/i.test(headers["server"] ?? "");
}

export interface FetchOptions {
  timeoutMs: number;
  maxRedirects?: number;
  maxBodyBytes?: number;
}

export interface FetchOutcome {
  status: number | null;
  finalUrl: string | null;
  redirects: string[];
  body: string;
  bodyBytes: number;
  truncated: boolean;
  durationMs: number;
  error: string | null;
  /** The `Server` header of the response that answered, e.g. "cloudflare". */
  server: string | null;
  /** Bot-management product recognised in the response, or null when unseen. */
  mitigation: string | null;
}

/** The handful of response headers that change how a result should be read. */
const HEADER_NAMES = ["server", "cf-mitigated", "x-datadome-cld"];

function pickHeaders(response: Response): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of HEADER_NAMES) {
    const value = response.headers.get(name);
    if (value !== null) out[name] = value;
  }
  return out;
}

function describeEdge(
  response: Response,
  body: string,
): { server: string | null; mitigation: string | null } {
  const headers = pickHeaders(response);
  return { server: headers["server"] ?? null, mitigation: edgeMitigation(headers, body) };
}

function headersFor(userAgent: string): Record<string, string> {
  return {
    "User-Agent": userAgent,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en;q=0.9,*;q=0.5",
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
  };
}

export async function fetchAs(
  url: string,
  userAgent: string,
  options: FetchOptions,
): Promise<FetchOutcome> {
  const started = Date.now();
  const maxRedirects = options.maxRedirects ?? 5;
  const maxBodyBytes = options.maxBodyBytes ?? 3_000_000;
  const redirects: string[] = [];
  let current = url;
  let status: number | null = null;
  let finalUrl: string | null = null;

  try {
    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      const response = await fetch(current, {
        redirect: "manual",
        headers: headersFor(userAgent),
        signal: AbortSignal.timeout(options.timeoutMs),
      });
      status = response.status;
      finalUrl = current;

      const location = response.headers.get("location");
      if (REDIRECT_CODES.has(response.status) && location) {
        const next = new URL(location, current).toString();
        redirects.push(next);
        current = next;
        // Drain the body so the socket is released.
        await response.arrayBuffer().catch(() => undefined);
        continue;
      }

      const buffer = await response.arrayBuffer();
      const truncated = buffer.byteLength > maxBodyBytes;
      const slice = truncated ? buffer.slice(0, maxBodyBytes) : buffer;
      const body = new TextDecoder("utf-8", { fatal: false }).decode(slice);
      return {
        status,
        finalUrl,
        redirects,
        body,
        bodyBytes: buffer.byteLength,
        truncated,
        durationMs: Date.now() - started,
        error: null,
        ...describeEdge(response, body),
      };
    }

    return {
      status,
      finalUrl,
      redirects,
      body: "",
      bodyBytes: 0,
      truncated: false,
      durationMs: Date.now() - started,
      error: `too many redirects (>${maxRedirects})`,
      server: null,
      mitigation: null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      status,
      finalUrl,
      redirects,
      body: "",
      bodyBytes: 0,
      truncated: false,
      durationMs: Date.now() - started,
      error: message,
      server: null,
      mitigation: null,
    };
  }
}

export function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function originOf(url: string): string {
  return new URL(url).origin;
}
