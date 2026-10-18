import test from "node:test";
import assert from "node:assert/strict";
import { normalizeTeamMappingKey } from "../src/prediction/pipeline.js";

test("reviewed team-name matching normalizes only case and repeated whitespace", () => {
  assert.equal(normalizeTeamMappingKey("  Manchester   United "), "manchester united");
  assert.equal(normalizeTeamMappingKey("MANCHESTER UNITED"), "manchester united");
});

test("reviewed team-name matching does not fuzzy-match abbreviations or similar names", () => {
  assert.notEqual(normalizeTeamMappingKey("Man Utd"), normalizeTeamMappingKey("Manchester United"));
  assert.notEqual(normalizeTeamMappingKey("Arsenal"), normalizeTeamMappingKey("Arsenal Women"));
});
