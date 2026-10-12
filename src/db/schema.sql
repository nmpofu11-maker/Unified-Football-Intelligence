-- PostgreSQL initial schema. This file is a reviewed draft; it has not been applied to a database.
CREATE TABLE IF NOT EXISTS teams (
  id text PRIMARY KEY,
  canonical_name text NOT NULL,
  country_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (length(trim(canonical_name)) > 0)
);
CREATE TABLE IF NOT EXISTS team_aliases (
  team_id text NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  alias text NOT NULL,
  source text NOT NULL DEFAULT 'reviewed_manual',
  PRIMARY KEY (team_id, alias),
  CHECK (length(trim(alias)) > 0)
);
CREATE TABLE IF NOT EXISTS provider_team_ids (
  provider text NOT NULL,
  provider_team_id text NOT NULL,
  team_id text NOT NULL REFERENCES teams(id),
  verified_at timestamptz,
  PRIMARY KEY (provider, provider_team_id),
  UNIQUE (provider, team_id, provider_team_id)
);
CREATE TABLE IF NOT EXISTS competitions (
  id text PRIMARY KEY,
  canonical_name text NOT NULL,
  country_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (length(trim(canonical_name)) > 0)
);
CREATE TABLE IF NOT EXISTS provider_competition_ids (
  provider text NOT NULL,
  provider_competition_id text NOT NULL,
  competition_id text NOT NULL REFERENCES competitions(id),
  verified_at timestamptz,
  PRIMARY KEY (provider, provider_competition_id)
);
CREATE TABLE IF NOT EXISTS fixtures (
  id text PRIMARY KEY,
  competition_id text NOT NULL REFERENCES competitions(id),
  season_id text,
  home_team_id text NOT NULL REFERENCES teams(id),
  away_team_id text NOT NULL REFERENCES teams(id),
  kickoff_utc timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('scheduled','live','finished','postponed','cancelled','abandoned','unknown')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (home_team_id <> away_team_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS fixtures_canonical_identity_idx ON fixtures (competition_id, COALESCE(season_id, ''), kickoff_utc, home_team_id, away_team_id);
CREATE INDEX IF NOT EXISTS fixtures_kickoff_idx ON fixtures(kickoff_utc);
CREATE TABLE IF NOT EXISTS provider_fixture_ids (
  provider text NOT NULL,
  provider_fixture_id text NOT NULL,
  fixture_id text NOT NULL REFERENCES fixtures(id),
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  PRIMARY KEY (provider, provider_fixture_id)
);
CREATE TABLE IF NOT EXISTS provider_observations (
  id bigserial PRIMARY KEY,
  provider text NOT NULL,
  entity_type text NOT NULL CHECK (entity_type IN ('fixture','result','odds','team','competition','statistics')),
  provider_record_id text,
  fixture_id text REFERENCES fixtures(id),
  retrieved_at timestamptz NOT NULL,
  event_time timestamptz,
  evidence_state text NOT NULL CHECK (evidence_state IN ('verified','unverified','stale','conflicted','unavailable','insufficient_evidence')),
  payload_hash text,
  normalized_payload jsonb NOT NULL,
  rejection_reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  UNIQUE (provider, entity_type, provider_record_id, retrieved_at)
);
CREATE INDEX IF NOT EXISTS provider_observations_fixture_idx ON provider_observations(fixture_id, retrieved_at DESC);
CREATE TABLE IF NOT EXISTS settled_results (
  id bigserial PRIMARY KEY,
  fixture_id text NOT NULL REFERENCES fixtures(id),
  home_goals integer NOT NULL CHECK (home_goals >= 0),
  away_goals integer NOT NULL CHECK (away_goals >= 0),
  settled_at timestamptz NOT NULL,
  reconciliation_state text NOT NULL CHECK (reconciliation_state IN ('verified','conflicted','unverified')),
  provenance_observation_ids bigint[] NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS settled_results_fixture_idx ON settled_results(fixture_id, settled_at DESC);
CREATE TABLE IF NOT EXISTS odds_quotes (
  id bigserial PRIMARY KEY,
  fixture_id text NOT NULL REFERENCES fixtures(id),
  bookmaker text NOT NULL,
  market text NOT NULL,
  selection text NOT NULL,
  decimal_odds numeric(10,4) NOT NULL CHECK (decimal_odds > 1),
  observed_at timestamptz NOT NULL,
  evidence_state text NOT NULL CHECK (evidence_state IN ('verified','unverified','stale','conflicted','unavailable','insufficient_evidence')),
  provenance_observation_id bigint REFERENCES provider_observations(id)
);
CREATE INDEX IF NOT EXISTS odds_quotes_current_idx ON odds_quotes(fixture_id, market, selection, observed_at DESC);
CREATE TABLE IF NOT EXISTS model_versions (
  id text PRIMARY KEY,
  created_at timestamptz NOT NULL,
  training_cutoff_utc timestamptz NOT NULL,
  evaluation_start_utc timestamptz NOT NULL,
  evaluation_end_utc timestamptz NOT NULL,
  sample_size integer NOT NULL CHECK (sample_size >= 0),
  log_loss numeric,
  brier_score numeric,
  approved boolean NOT NULL DEFAULT false,
  approval_note text,
  CHECK (evaluation_start_utc <= evaluation_end_utc)
);
CREATE TABLE IF NOT EXISTS prediction_snapshots (
  id text PRIMARY KEY,
  fixture_id text NOT NULL REFERENCES fixtures(id),
  model_version_id text NOT NULL REFERENCES model_versions(id),
  created_at timestamptz NOT NULL,
  data_cutoff_utc timestamptz NOT NULL,
  kickoff_utc timestamptz NOT NULL,
  home_probability numeric(8,7),
  draw_probability numeric(8,7),
  away_probability numeric(8,7),
  evidence_state text NOT NULL CHECK (evidence_state IN ('verified','unverified','stale','conflicted','unavailable','insufficient_evidence')),
  abstention_reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  feature_snapshot jsonb NOT NULL,
  CHECK (data_cutoff_utc <= created_at),
  CHECK (created_at < kickoff_utc),
  CHECK ((home_probability IS NULL AND draw_probability IS NULL AND away_probability IS NULL) OR
         (home_probability IS NOT NULL AND draw_probability IS NOT NULL AND away_probability IS NOT NULL AND
          home_probability BETWEEN 0 AND 1 AND draw_probability BETWEEN 0 AND 1 AND away_probability BETWEEN 0 AND 1 AND
          abs(home_probability + draw_probability + away_probability - 1) <= 0.001))
);
CREATE INDEX IF NOT EXISTS prediction_snapshots_fixture_idx ON prediction_snapshots(fixture_id, created_at DESC);
CREATE TABLE IF NOT EXISTS tracked_teams (
  team_id text NOT NULL REFERENCES teams(id),
  watchlist text NOT NULL DEFAULT 'priority',
  added_at timestamptz NOT NULL DEFAULT now(),
  added_by text,
  PRIMARY KEY (team_id, watchlist)
);

-- Provider evidence is append-only. Corrections are new observations, not overwrites.
CREATE OR REPLACE FUNCTION reject_append_only_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'append-only evidence/prediction rows cannot be updated or deleted';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER provider_observations_append_only BEFORE UPDATE OR DELETE ON provider_observations
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER prediction_snapshots_append_only BEFORE UPDATE OR DELETE ON prediction_snapshots
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
