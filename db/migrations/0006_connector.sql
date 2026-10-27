-- Claude connector (Milestone 6): Spotlight is its own small OAuth server, so an admin can
-- connect the Claude app to Spotlight. Only hashes of codes and tokens are stored.

-- Apps that registered themselves (OAuth dynamic client registration). Only Claude's
-- callback addresses are accepted, so a registration can't send codes anywhere else.
CREATE TABLE oauth_clients (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id             text NOT NULL UNIQUE,
  client_secret_hash    text,
  client_name           text NOT NULL DEFAULT 'Unnamed app' CHECK (length(client_name) <= 100),
  redirect_uris         text[] NOT NULL CHECK (cardinality(redirect_uris) BETWEEN 1 AND 5),
  token_auth_method     text NOT NULL DEFAULT 'none'
                        CHECK (token_auth_method IN ('none', 'client_secret_post', 'client_secret_basic')),
  created_at            timestamptz NOT NULL DEFAULT now(),
  last_used_at          timestamptz,
  CHECK ((token_auth_method = 'none') = (client_secret_hash IS NULL))
);

-- An admin's "yes" to an app: what Settings lists as a connection, and what Disconnect removes.
CREATE TABLE oauth_grants (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id     uuid NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  resource      text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz
);
CREATE INDEX oauth_grants_user_idx ON oauth_grants (user_id) WHERE revoked_at IS NULL;

-- One-time codes handed back to the app after "Allow" (valid for minutes, PKCE-bound).
CREATE TABLE oauth_codes (
  code_hash       text PRIMARY KEY,
  grant_id        uuid NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
  redirect_uri    text NOT NULL,
  code_challenge  text NOT NULL CHECK (code_challenge ~ '^[A-Za-z0-9_-]{43}$'),
  expires_at      timestamptz NOT NULL,
  used_at         timestamptz
);

-- Access tokens (short-lived) and refresh tokens (rotated on every use).
CREATE TABLE oauth_tokens (
  token_hash   text PRIMARY KEY,
  grant_id     uuid NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('access', 'refresh')),
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX oauth_tokens_grant_idx ON oauth_tokens (grant_id);

ALTER TABLE oauth_clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_tokens ENABLE ROW LEVEL SECURITY;
