import type { ProviderDiagnostics } from "../providers/provider.js";

export function aggregateProviderStatus(providers: ProviderDiagnostics[]) {
  const now = Date.now();
  return {
    checkedAt: new Date(now).toISOString(),
    configuredProviderCount: providers.length,
    successfulProviderCount: providers.filter(p => p.state === "success" || p.state === "success_empty").length,
    providers: providers.map(p => ({
      ...p,
      freshness: !p.lastSuccessAt ? "unknown" : now - Date.parse(p.lastSuccessAt) > 15 * 60_000 ? "stale" : "recent",
      // success_empty is intentionally distinct from a populated successful response.
      usableFixtureCount: p.state === "success" ? p.lastRecordCount : 0
    }))
  };
}
