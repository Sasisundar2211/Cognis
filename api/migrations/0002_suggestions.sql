-- Contextual suggestions shown by the desktop companion, and the user's feedback.
-- Stores which saved items were shown and when. Never stores window titles, app names or task text.

CREATE TABLE suggestion_events (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('SUGGEST','HIGH_CONFIDENCE')),
  item_count INTEGER NOT NULL,
  feedback TEXT CHECK (feedback IN ('useful','not_useful','opened','dismissed')),
  feedback_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (user_id, id)
);
CREATE INDEX suggestion_events_user_idx ON suggestion_events(user_id, created_at DESC);

CREATE TABLE suggestion_items (
  suggestion_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (suggestion_id, item_id),
  FOREIGN KEY (user_id, suggestion_id) REFERENCES suggestion_events(user_id, id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, item_id) REFERENCES knowledge_items(user_id, id) ON DELETE CASCADE
);
CREATE INDEX suggestion_items_user_item_idx ON suggestion_items(user_id, item_id);
