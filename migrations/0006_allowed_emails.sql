-- Who may use Angel. Managed by hand:
--   npx wrangler d1 execute angel-db --remote --command "INSERT INTO allowed_emails (email, note) VALUES ('someone@gmail.com', 'who')"
--   npx wrangler d1 execute angel-db --remote --command "DELETE FROM allowed_emails WHERE email = 'someone@gmail.com'"
-- Addresses are compared the way Gmail does (dots and +tags ignored, googlemail.com
-- is gmail.com), so any spelling works; the ones below are stored in that form.
CREATE TABLE allowed_emails (
  email TEXT PRIMARY KEY,
  note TEXT,
  added_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO allowed_emails (email, note) VALUES
  ('elifiner@gmail.com', 'Eli'),
  ('yaelfiner@gmail.com', 'Yael'),
  ('finertom@gmail.com', 'Tom'),
  ('ianshaggarwal@gmail.com', 'Ian');
