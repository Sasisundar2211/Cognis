-- Knowledge objects, tags, collections, audit events.
-- Tenant isolation: every row carries user_id. Join tables use composite
-- foreign keys (user_id, id) so a row can never link objects owned by
-- different users, even if application code has a bug.

CREATE TABLE knowledge_items (
  seq INTEGER PRIMARY KEY,               -- stable rowid for external-content FTS5
  id TEXT NOT NULL UNIQUE,               -- public id
  user_id TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('url','text','note','capture')),
  title TEXT NOT NULL DEFAULT '',
  original_url TEXT,
  canonical_url TEXT,
  source_platform TEXT NOT NULL DEFAULT 'manual',
  description TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',       -- user-provided text
  extracted_text TEXT NOT NULL DEFAULT '',-- text extracted from fetched source
  content_hash TEXT,
  metadata TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata)),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','ready','failed')),
  error_code TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0,1)),
  embedding BLOB,
  embedding_model TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  ingested_at TEXT,
  UNIQUE (user_id, id)
);
CREATE INDEX knowledge_user_created_idx ON knowledge_items(user_id, created_at DESC);
CREATE INDEX knowledge_user_source_idx ON knowledge_items(user_id, source_platform);
CREATE INDEX knowledge_user_status_idx ON knowledge_items(user_id, status);
CREATE UNIQUE INDEX knowledge_user_url_uq ON knowledge_items(user_id, canonical_url) WHERE canonical_url IS NOT NULL;
CREATE UNIQUE INDEX knowledge_user_hash_uq ON knowledge_items(user_id, content_hash) WHERE canonical_url IS NULL AND content_hash IS NOT NULL;

CREATE VIRTUAL TABLE knowledge_fts USING fts5(
  title, description, content, extracted_text,
  content='knowledge_items', content_rowid='seq',
  tokenize='porter unicode61 remove_diacritics 2'
);

CREATE TRIGGER knowledge_ai AFTER INSERT ON knowledge_items BEGIN
  INSERT INTO knowledge_fts(rowid, title, description, content, extracted_text)
  VALUES (new.seq, new.title, new.description, new.content, new.extracted_text);
END;
CREATE TRIGGER knowledge_ad AFTER DELETE ON knowledge_items BEGIN
  INSERT INTO knowledge_fts(knowledge_fts, rowid, title, description, content, extracted_text)
  VALUES ('delete', old.seq, old.title, old.description, old.content, old.extracted_text);
END;
CREATE TRIGGER knowledge_au AFTER UPDATE OF title, description, content, extracted_text ON knowledge_items BEGIN
  INSERT INTO knowledge_fts(knowledge_fts, rowid, title, description, content, extracted_text)
  VALUES ('delete', old.seq, old.title, old.description, old.content, old.extracted_text);
  INSERT INTO knowledge_fts(rowid, title, description, content, extracted_text)
  VALUES (new.seq, new.title, new.description, new.content, new.extracted_text);
END;

CREATE TABLE tags (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (user_id, name),
  UNIQUE (user_id, id)
);

CREATE TABLE item_tags (
  user_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  tag_id TEXT NOT NULL,
  PRIMARY KEY (item_id, tag_id),
  FOREIGN KEY (user_id, item_id) REFERENCES knowledge_items(user_id, id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, tag_id) REFERENCES tags(user_id, id) ON DELETE CASCADE
);
CREATE INDEX item_tags_tag_idx ON item_tags(tag_id);

CREATE TABLE collections (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (user_id, name),
  UNIQUE (user_id, id)
);

CREATE TABLE collection_items (
  user_id TEXT NOT NULL,
  collection_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  added_at TEXT NOT NULL,
  PRIMARY KEY (collection_id, item_id),
  FOREIGN KEY (user_id, collection_id) REFERENCES collections(user_id, id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, item_id) REFERENCES knowledge_items(user_id, id) ON DELETE CASCADE
);
CREATE INDEX collection_items_item_idx ON collection_items(item_id);

-- Audit events never store content, IPs, or user agents.
CREATE TABLE audit_events (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT,
  event TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(detail)),
  created_at TEXT NOT NULL
);
CREATE INDEX audit_user_idx ON audit_events(user_id, created_at DESC);
