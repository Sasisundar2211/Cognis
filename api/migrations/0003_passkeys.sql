-- Passkey sign-in (WebAuthn), recovery codes and desktop pairing codes.
-- Replaces passwords so sign-in fits the Workers free plan CPU budget and needs no email service.

ALTER TABLE users ADD COLUMN webauthn_handle TEXT;  -- random 16-byte user handle, base64url
CREATE UNIQUE INDEX users_webauthn_handle_uq ON users(webauthn_handle) WHERE webauthn_handle IS NOT NULL;

CREATE TABLE passkeys (
  id TEXT PRIMARY KEY NOT NULL,                     -- credential id, base64url
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key BLOB NOT NULL,                         -- COSE key bytes
  sign_count INTEGER NOT NULL DEFAULT 0,
  name TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  last_used_at TEXT
);
CREATE INDEX passkeys_user_idx ON passkeys(user_id);

-- One-time WebAuthn challenges. Deleted when used.
CREATE TABLE webauthn_challenges (
  id TEXT PRIMARY KEY NOT NULL,
  challenge TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('register','login','add')),
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  pending_email TEXT,
  pending_name TEXT,
  user_handle TEXT,
  expires_at TEXT NOT NULL
);

-- Recovery codes: high-entropy, stored as SHA-256, single use.
CREATE TABLE recovery_codes (
  code_hash TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  used_at TEXT
);
CREATE INDEX recovery_codes_user_idx ON recovery_codes(user_id);

-- Short-lived codes that pair the desktop companion with an account. Stored as SHA-256.
CREATE TABLE pairing_codes (
  code_hash TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);
