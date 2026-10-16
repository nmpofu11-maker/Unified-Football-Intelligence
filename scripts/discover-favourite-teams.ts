import "dotenv/config";
import process from "node:process";

const baseUrl = process.env.FOOTBALL_APP_URL?.trim();
const token = process.env.PROVIDER_DIAGNOSTICS_TOKEN?.trim();
const maxBatchesRaw = Number(process.env.TEAM_SEARCH_MAX_BATCHES ?? "32");
const maxBatches = Number.isSafeInteger(maxBatchesRaw) ? Math.min(32, Math.max(1, maxBatchesRaw)) : 32;

if (!baseUrl || !token) {
  console.error("Set FOOTBALL_APP_URL and PROVIDER_DIAGNOSTICS_TOKEN before running discovery.");
  process.exitCode = 1;
} else {
  let endpoint: URL;
  try {
    endpoint = new URL("/api/teams/provider-search/next-batch", baseUrl);
    if (!["http:", "https:"].includes(endpoint.protocol)) throw new Error("invalid protocol");
  } catch {
    console.error("FOOTBALL_APP_URL must be a valid HTTP(S) application URL.");
    process.exitCode = 1;
    endpoint = new URL("http://localhost/");
  }

  if (process.exitCode !== 1) {
    const sleep = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));
    let completed = false;
    let rateLimitRetries = 0;

    for (let batch = 1; batch <= maxBatches; batch++) {
      if (batch > 1) await sleep(31_000);
      let response: Response;
      try {
        response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "accept": "application/json",
            "content-type": "application/json",
            "x-provider-diagnostics-token": token
          },
          body: "{}",
          signal: AbortSignal.timeout(120_000)
        });
      } catch (error) {
        console.error(`Batch ${batch}: request failed (${error instanceof Error && error.name === "TimeoutError" ? "timeout" : "network_error"}).`);
        process.exitCode = 1;
        break;
      }

      if (response.status === 429 && rateLimitRetries < 3) {
        rateLimitRetries++;
        console.log(`Batch ${batch}: provider-search rate limit reached; waiting 65 seconds before retry ${rateLimitRetries}/3.`);
        batch--;
        await sleep(65_000);
        continue;
      }
      if (!response.ok) {
        console.error(`Batch ${batch}: server returned HTTP ${response.status}. Check app deployment, database readiness, and provider diagnostics token.`);
        process.exitCode = 1;
        break;
      }

      let payload: Record<string, any>;
      try {
        payload = await response.json() as Record<string, any>;
      } catch {
        console.error(`Batch ${batch}: server returned invalid JSON.`);
        process.exitCode = 1;
        break;
      }

      const progress = payload.progress as Record<string, unknown> | undefined;
      const processed = Array.isArray(payload.processed)
        ? payload.processed.map((item: { name?: string }) => item?.name).filter(Boolean).join(", ")
        : "";
      const mapping = payload.identityMapping as Record<string, unknown> | undefined;
      console.log(
        `Batch ${batch}: ${String(payload.state ?? "unknown_state")}; ` +
        `searched ${String(progress?.searchedTeams ?? "?")}/${String(progress?.trackedTeams ?? "80")}; ` +
        `confirmed this batch ${String(mapping?.confirmed ?? 0)}; ` +
        `retryable remaining ${String(payload.retryableTeamsRemaining ?? "?")}`
      );
      if (processed) console.log(`  Teams: ${processed}`);

      if (payload.state === "team_search_batches_complete" || payload.retryableTeamsRemaining === 0) {
        completed = true;
        break;
      }
      if (payload.state !== "provider_team_search_batch_completed") {
        console.error("Unexpected response state; stopping rather than repeatedly calling an unknown endpoint.");
        process.exitCode = 1;
        break;
      }
      rateLimitRetries = 0;
    }

    if (!completed && process.exitCode !== 1) {
      console.error(`Stopped after ${maxBatches} batches. Run again later to continue any retryable teams.`);
      process.exitCode = 1;
    }
    if (completed) console.log("Discovery run complete. Review /api/teams/watchlist; unresolved or ambiguous teams are not auto-mapped.");
  }
}
