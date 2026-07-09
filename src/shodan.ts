import { createShodanClient, ShodanApiError } from "shodan-ts";
import { BACKOFF_BASE_MS, CLIENT_OPTS, MAX_RETRIES } from "./config.ts";
import { sleep } from "./util.ts";

export type ShodanClient = ReturnType<typeof createShodanClient>;

export function makeClient(token: string): ShodanClient {
  return createShodanClient(token, CLIENT_OPTS);
}

/**
 * Run an API call with retry + exponential backoff on 429 and 5xx.
 * shodan-ts does NOT retry 429 and does no throttling, so we own this.
 */
export async function withBackoff<T>(
  label: string,
  fn: () => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status = err instanceof ShodanApiError ? err.status : 0;
      const retriable = status === 429 || (status >= 500 && status < 600);
      if (!retriable || attempt >= MAX_RETRIES) throw err;
      const wait = BACKOFF_BASE_MS * 2 ** attempt + Math.floor(Math.random() * 500);
      console.warn(
        `  ${label}: HTTP ${status || "network error"}, backing off ${Math.round(
          wait,
        )}ms (attempt ${attempt + 1}/${MAX_RETRIES})`,
      );
      await sleep(wait);
    }
  }
}

/**
 * Cheap preflight: return the current query-credit balance. `getApiInfo` spends
 * no credits, so CI can call this before the expensive DB restore + scrape and
 * bail early (a neutral stop) when there's nothing left to spend.
 */
export async function checkCreds(client: ShodanClient): Promise<number> {
  const info = await withBackoff("api-info", () => client.getApiInfo());
  return info.query_credits;
}

/** Fetch one search page with screenshots included (minify:false is required). */
export function searchPage(client: ShodanClient, query: string, page: number) {
  return withBackoff(`search page ${page}`, () =>
    client.searchHosts(query, { page, minify: false }),
  );
}
