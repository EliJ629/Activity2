-- =========================================================
-- schema.sql  (PostgreSQL - works on Neon, or any Postgres)
-- Tables follow section 4 of the requirements document.
-- Additions beyond the document are marked "EXTRA".
-- Timestamps are stored as UTC ISO-8601 text, same format the
-- app already used under SQLite, so no date-handling code had
-- to change when the database engine did.
-- =========================================================

CREATE TABLE IF NOT EXISTS users (
  id                    TEXT PRIMARY KEY,                                   -- UUID
  first_name            TEXT NOT NULL CHECK (length(first_name) BETWEEN 2 AND 50),
  last_name             TEXT NOT NULL CHECK (length(last_name)  BETWEEN 2 AND 50),
  middle_initial        TEXT CHECK (middle_initial IS NULL OR length(middle_initial) <= 2),
  birthday              TEXT NOT NULL,                                      -- DATE (YYYY-MM-DD)
  password_hash         TEXT NOT NULL,                                      -- Argon2id, never plaintext
  email                 TEXT NOT NULL,
  email_verified_at     TEXT,
  mobile_number         TEXT NOT NULL,                                      -- E.164, e.g. +639171234567
  mobile_verified        BOOLEAN NOT NULL DEFAULT FALSE,
  failed_login_attempts INTEGER NOT NULL DEFAULT 0,
  is_locked             BOOLEAN NOT NULL DEFAULT FALSE,
  lockout_until         TEXT,                                               -- unlock is allowed from this moment
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);
-- EXTRA: case-insensitive email uniqueness (SQLite used COLLATE NOCASE; the
-- functional index below is PostgreSQL's equivalent for an email column).
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users (lower(email));

CREATE TABLE IF NOT EXISTS addresses (
  id            TEXT PRIMARY KEY,                                           -- UUID
  user_id       TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  house_street  TEXT NOT NULL,
  country       TEXT NOT NULL,
  country_code  TEXT NOT NULL,                                              -- EXTRA: ISO 3166-1 alpha-2 (drives time zone + phone prefix)
  city          TEXT NOT NULL,
  state         TEXT NOT NULL,
  barangay      TEXT,                                                       -- EXTRA: kept from the existing PSGC address feature (Philippines)
  zip_code      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_addresses_user ON addresses (user_id);

CREATE TABLE IF NOT EXISTS verification_tokens (
  seq           BIGSERIAL,                                                  -- EXTRA: stable insert-order tiebreaker (replaces SQLite's implicit rowid)
  id            TEXT PRIMARY KEY,                                           -- UUID
  user_id       TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash    TEXT NOT NULL,                                              -- SHA-256 of the link token / HMAC of the OTP
  type          TEXT NOT NULL CHECK (type IN ('email_verify', 'mobile_otp', 'password_reset', 'account_unlock')),
  expired_at    TEXT NOT NULL,
  created_at    TEXT NOT NULL,                                              -- EXTRA: resend cooldowns
  used_at       TEXT,                                                       -- EXTRA: single use
  attempts      INTEGER NOT NULL DEFAULT 0,                                 -- EXTRA: OTP entry attempts (max 3)
  locked_until  TEXT                                                        -- EXTRA: OTP lockout after 3 wrong entries
);
CREATE INDEX IF NOT EXISTS idx_tokens_hash ON verification_tokens (token_hash);
CREATE INDEX IF NOT EXISTS idx_tokens_user_type ON verification_tokens (user_id, type);

-- EXTRA: server-side login sessions (so Logout really ends the session)
CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  expires_at  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  ip          TEXT,
  user_agent  TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);
