// Shodan credit preflight for CI. Checks the query-credit balance (spends none)
// and emits a `has_credits` step output so the scrape workflow can skip the
// expensive DB restore + scrape + deploy when there's nothing left to spend.
// Always a neutral stop: exits 0 whether or not credits remain; only a genuine
// API/network failure (after retries) surfaces as a non-zero exit.
//
// Usage:  bun run preflight        (needs SHODANTOKEN)

import { checkCreds, makeClient } from "./shodan.ts";
import { mustEnv, setStepOutput } from "../core/util.ts";

const client = makeClient(mustEnv("SHODANTOKEN"));
const credits = await checkCreds(client);
const hasCredits = credits > 0;

console.log(
  `Query credits: ${credits} — ${hasCredits ? "proceeding with scrape." : "none remaining; skipping scrape + deploy."}`,
);
setStepOutput("has_credits", hasCredits);
