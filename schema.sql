-- =========================================================
-- schema.sql  (PostgreSQL - works on Neon, or any Postgres)
-- Column types follow section 4 of the requirements document:
-- UUID keys, VARCHAR(n) lengths, DATE, TIMESTAMP, BOOLEAN, INT,
-- and an ENUM for the token type. Additions beyond the document
-- are marked "EXTRA".
-- TIMESTAMP columns have no time zone and always hold UTC; the app
-- reads them back as ISO-8601 text (see server/db.js).
-- Safe to run on every start: everything is IF NOT EXISTS, and the
-- block at the bottom upgrades an older all-TEXT database in place.
-- =========================================================

DO $$ BEGIN
  CREATE TYPE verification_token_type AS ENUM ('email_verify', 'mobile_otp', 'password_reset', 'account_unlock');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS users (
  id                    UUID PRIMARY KEY,
  first_name            VARCHAR(50)  NOT NULL CHECK (length(first_name) BETWEEN 2 AND 50),
  last_name             VARCHAR(50)  NOT NULL CHECK (length(last_name)  BETWEEN 2 AND 50),
  middle_initial        VARCHAR(2)   CHECK (middle_initial IS NULL OR length(middle_initial) <= 2),
  birthday              DATE         NOT NULL,
  password_hash         VARCHAR(255) NOT NULL,                              -- Argon2id, never plaintext
  email                 VARCHAR(255) NOT NULL UNIQUE,
  email_verified_at     TIMESTAMP,
  mobile_number         VARCHAR(20)  NOT NULL,                              -- E.164, e.g. +639171234567
  mobile_verified       BOOLEAN      NOT NULL DEFAULT FALSE,
  failed_login_attempts INTEGER      NOT NULL DEFAULT 0,
  is_locked             BOOLEAN      NOT NULL DEFAULT FALSE,
  lockout_until         TIMESTAMP,                                          -- unlock is allowed from this moment
  created_at            TIMESTAMP    NOT NULL,
  updated_at            TIMESTAMP    NOT NULL
);
-- EXTRA: case-insensitive email uniqueness (emails are stored lower-case already; this makes it a rule of the database)
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users (lower(email));

CREATE TABLE IF NOT EXISTS addresses (
  id            UUID PRIMARY KEY,
  user_id       UUID         NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  house_street  VARCHAR(255) NOT NULL,
  country       VARCHAR(100) NOT NULL,
  country_code  VARCHAR(2)   NOT NULL,                                      -- EXTRA: ISO 3166-1 alpha-2 (drives time zone + phone prefix)
  city          VARCHAR(100) NOT NULL,
  state         VARCHAR(100) NOT NULL,
  barangay      VARCHAR(100),                                               -- EXTRA: kept from the existing PSGC address feature (Philippines)
  zip_code      VARCHAR(20)  NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_addresses_user ON addresses (user_id);

CREATE TABLE IF NOT EXISTS verification_tokens (
  seq           BIGSERIAL,                                                  -- EXTRA: stable insert-order tiebreaker
  id            UUID PRIMARY KEY,
  user_id       UUID         NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash    VARCHAR(255) NOT NULL,                                      -- SHA-256 of the link token / HMAC of the OTP
  type          verification_token_type NOT NULL,
  expired_at    TIMESTAMP    NOT NULL,
  created_at    TIMESTAMP    NOT NULL,                                      -- EXTRA: resend cooldowns
  used_at       TIMESTAMP,                                                  -- EXTRA: single use
  attempts      INTEGER      NOT NULL DEFAULT 0,                            -- EXTRA: OTP entry attempts (max 3)
  locked_until  TIMESTAMP                                                   -- EXTRA: OTP lockout after 3 wrong entries
);
CREATE INDEX IF NOT EXISTS idx_tokens_hash ON verification_tokens (token_hash);
CREATE INDEX IF NOT EXISTS idx_tokens_user_type ON verification_tokens (user_id, type);

-- EXTRA: server-side login sessions (so Logout really ends the session)
CREATE TABLE IF NOT EXISTS sessions (
  id          UUID PRIMARY KEY,
  user_id     UUID         NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash  VARCHAR(255) NOT NULL UNIQUE,
  expires_at  TIMESTAMP    NOT NULL,
  created_at  TIMESTAMP    NOT NULL,
  ip          VARCHAR(64),
  user_agent  VARCHAR(255)
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);

-- ---------------------------------------------------------
-- Upgrade for a database created by an earlier version, where every column was TEXT.
-- Runs only when it finds the old layout. All-or-nothing: if anything fails, the whole upgrade is
-- rolled back, a warning is printed, and the tables are left exactly as they were (the app works
-- with either layout), so this can never stop the server from starting.
-- ---------------------------------------------------------
DO $upgrade$
DECLARE r record;
BEGIN
  IF (SELECT data_type FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'users' AND column_name = 'id') = 'text' THEN
    SET LOCAL lock_timeout = '15s';

    -- foreign keys have to be dropped while the key columns change type, then put back
    FOR r IN SELECT conrelid::regclass AS tbl, conname FROM pg_constraint WHERE contype = 'f' AND confrelid = 'users'::regclass LOOP
      EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.tbl, r.conname);
    END LOOP;
    -- the old text CHECK on the token type is replaced by the ENUM
    FOR r IN SELECT conname FROM pg_constraint
              WHERE contype = 'c' AND conrelid = 'verification_tokens'::regclass AND pg_get_constraintdef(oid) LIKE '%email_verify%' LOOP
      EXECUTE format('ALTER TABLE verification_tokens DROP CONSTRAINT %I', r.conname);
    END LOOP;

    ALTER TABLE users
      ALTER COLUMN id TYPE UUID USING id::uuid,
      ALTER COLUMN first_name TYPE VARCHAR(50),
      ALTER COLUMN last_name TYPE VARCHAR(50),
      ALTER COLUMN middle_initial TYPE VARCHAR(2),
      ALTER COLUMN birthday TYPE DATE USING birthday::date,
      ALTER COLUMN password_hash TYPE VARCHAR(255),
      ALTER COLUMN email TYPE VARCHAR(255),
      ALTER COLUMN email_verified_at TYPE TIMESTAMP USING email_verified_at::timestamp,
      ALTER COLUMN mobile_number TYPE VARCHAR(20),
      ALTER COLUMN lockout_until TYPE TIMESTAMP USING lockout_until::timestamp,
      ALTER COLUMN created_at TYPE TIMESTAMP USING created_at::timestamp,
      ALTER COLUMN updated_at TYPE TIMESTAMP USING updated_at::timestamp;

    ALTER TABLE addresses
      ALTER COLUMN id TYPE UUID USING id::uuid,
      ALTER COLUMN user_id TYPE UUID USING user_id::uuid,
      ALTER COLUMN house_street TYPE VARCHAR(255),
      ALTER COLUMN country TYPE VARCHAR(100),
      ALTER COLUMN country_code TYPE VARCHAR(2),
      ALTER COLUMN city TYPE VARCHAR(100),
      ALTER COLUMN state TYPE VARCHAR(100),
      ALTER COLUMN barangay TYPE VARCHAR(100),
      ALTER COLUMN zip_code TYPE VARCHAR(20);

    ALTER TABLE verification_tokens
      ALTER COLUMN id TYPE UUID USING id::uuid,
      ALTER COLUMN user_id TYPE UUID USING user_id::uuid,
      ALTER COLUMN token_hash TYPE VARCHAR(255),
      ALTER COLUMN type TYPE verification_token_type USING type::text::verification_token_type,
      ALTER COLUMN expired_at TYPE TIMESTAMP USING expired_at::timestamp,
      ALTER COLUMN created_at TYPE TIMESTAMP USING created_at::timestamp,
      ALTER COLUMN used_at TYPE TIMESTAMP USING used_at::timestamp,
      ALTER COLUMN locked_until TYPE TIMESTAMP USING locked_until::timestamp;

    ALTER TABLE sessions
      ALTER COLUMN id TYPE UUID USING id::uuid,
      ALTER COLUMN user_id TYPE UUID USING user_id::uuid,
      ALTER COLUMN token_hash TYPE VARCHAR(255),
      ALTER COLUMN expires_at TYPE TIMESTAMP USING expires_at::timestamp,
      ALTER COLUMN created_at TYPE TIMESTAMP USING created_at::timestamp,
      ALTER COLUMN ip TYPE VARCHAR(64),
      ALTER COLUMN user_agent TYPE VARCHAR(255);

    ALTER TABLE addresses            ADD CONSTRAINT addresses_user_id_fkey            FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE;
    ALTER TABLE verification_tokens  ADD CONSTRAINT verification_tokens_user_id_fkey  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE;
    ALTER TABLE sessions             ADD CONSTRAINT sessions_user_id_fkey             FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'users'::regclass AND conname = 'users_email_key') THEN
      ALTER TABLE users ADD CONSTRAINT users_email_key UNIQUE (email);
    END IF;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Schema upgrade skipped, tables left unchanged: %', SQLERRM;
END
$upgrade$;