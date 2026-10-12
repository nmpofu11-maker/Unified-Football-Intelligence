import test from "node:test";
import assert from "node:assert/strict";
import { aggregateProviderStatus } from "../src/status/aggregate.js";
import type { ProviderDiagnostics } from "../src/providers/provider.js";
const provider = (state: ProviderDiagnostics["state"], count: number): ProviderDiagnostics => ({provider:"p",state,lastRecordCount:count,lastSuccessAt:"2026-10-12T12:00:00.000Z"});
test("empty success does not count as usable fixture data", () => {
 const status = aggregateProviderStatus([provider("success_empty",0),provider("success",3)]);
 assert.equal(status.successfulProviderCount,2);
 assert.equal(status.providers[0]!.usableFixtureCount,0);
 assert.equal(status.providers[1]!.usableFixtureCount,3);
});
test("provider failure is not counted as success", () => {
 const status = aggregateProviderStatus([{provider:"p",state:"rate_limited",lastRecordCount:0}]);
 assert.equal(status.successfulProviderCount,0);
 assert.equal(status.providers[0]!.freshness,"unknown");
});
