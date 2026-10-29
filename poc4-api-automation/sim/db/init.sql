-- Creates the two service databases with their schema and seed data. Postgres runs this once, on an empty volume.
-- Every value here is a dummy: example.test addresses, a shared test PIN (246810) and made-up VINs and ICCIDs.

CREATE DATABASE service_a;
CREATE DATABASE service_b;

\connect service_a
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  user_id             text PRIMARY KEY,
  email               text NOT NULL,
  display_name        text NOT NULL,
  pin_hash            text NOT NULL,
  failed_pin_attempts int NOT NULL DEFAULT 0,
  locked              boolean NOT NULL DEFAULT false,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE devices (
  device_id     text PRIMARY KEY,
  user_id       text NOT NULL REFERENCES users,
  platform      text NOT NULL,
  push_token    text NOT NULL,
  registered_at timestamptz NOT NULL
);
CREATE TABLE consents (
  user_id      text NOT NULL REFERENCES users,
  consent_type text NOT NULL,
  version      text NOT NULL,
  agreed       boolean NOT NULL,
  updated_at   timestamptz NOT NULL,
  PRIMARY KEY (user_id, consent_type)
);
CREATE TABLE export_requests (
  request_id    text PRIMARY KEY,
  kind          text NOT NULL,
  date_from     date NOT NULL,
  date_to       date NOT NULL,
  notify_email  text,
  status        text NOT NULL,
  row_count     int,
  file_name     text,
  base_url      text NOT NULL,
  one_time_uuid text,
  requested_at  timestamptz NOT NULL,
  completed_at  timestamptz
);

-- The test accounts: one per Playwright worker, and one that stays locked.
INSERT INTO users (user_id, email, display_name, pin_hash, created_at)
SELECT 'auth0|pw-user-' || lpad(n::text, 2, '0'), 'pw-user-' || lpad(n::text, 2, '0') || '@example.test',
       'Test User ' || lpad(n::text, 2, '0'),
       encode(digest('auth0|pw-user-' || lpad(n::text, 2, '0') || ':246810', 'sha256'), 'hex'), '2025-12-01T00:00:00Z'
FROM generate_series(1, 8) AS n;
INSERT INTO users (user_id, email, display_name, pin_hash, failed_pin_attempts, locked, created_at)
VALUES ('auth0|pw-locked-01', 'pw-locked-01@example.test', 'Locked Test User',
        encode(digest('auth0|pw-locked-01:246810', 'sha256'), 'hex'), 5, true, '2025-12-01T00:00:00Z');

-- Fifty read-only users, one a week through 2026, so an export over a date range has a known row count.
INSERT INTO users (user_id, email, display_name, pin_hash, created_at)
SELECT 'auth0|seed-' || lpad(n::text, 3, '0'), 'seed-' || lpad(n::text, 3, '0') || '@example.test',
       'Seed User ' || lpad(n::text, 3, '0'),
       encode(digest('auth0|seed-' || lpad(n::text, 3, '0') || ':246810', 'sha256'), 'hex'),
       timestamptz '2026-01-01T03:00:00Z' + (n - 1) * interval '7 days'
FROM generate_series(1, 50) AS n;
INSERT INTO consents (user_id, consent_type, version, agreed, updated_at)
SELECT 'auth0|seed-' || lpad(n::text, 3, '0'), 'TERMS', '1.0', true, timestamptz '2026-01-01T03:00:00Z' + (n - 1) * interval '7 days'
FROM generate_series(1, 50) AS n;

\connect service_b

CREATE TABLE vin_registrations (
  vin          text PRIMARY KEY,
  model_code   text NOT NULL,
  status       text NOT NULL,
  execution_id text NOT NULL,
  reason       text,
  requested_at timestamptz NOT NULL,
  updated_at   timestamptz NOT NULL
);
CREATE TABLE ownerships (
  ownership_id text PRIMARY KEY,
  user_id      text NOT NULL,
  vin          text NOT NULL,
  nickname     text,
  status       text NOT NULL,
  created_at   timestamptz NOT NULL,
  ended_at     timestamptz
);
CREATE UNIQUE INDEX ownerships_one_active_per_vin ON ownerships (vin) WHERE status = 'ACTIVE';
CREATE TABLE subscriptions (
  subscription_id text PRIMARY KEY,
  ownership_id    text NOT NULL REFERENCES ownerships,
  plan            text NOT NULL,
  status          text NOT NULL,
  payment_ref     text NOT NULL,
  started_at      timestamptz NOT NULL
);
CREATE TABLE tcus (
  tcu_id     text PRIMARY KEY,
  vin        text,
  iccid      text NOT NULL UNIQUE,
  sim_status text NOT NULL,
  order_id   text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Twenty units with an inactive SIM. ICCIDs are 19 digits under a made-up issuer prefix.
INSERT INTO tcus (tcu_id, iccid, sim_status)
SELECT 'TCU-' || lpad(n::text, 4, '0'), '89990000000000' || lpad(n::text, 5, '0'), 'INACTIVE'
FROM generate_series(1, 20) AS n;
