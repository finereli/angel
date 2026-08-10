-- Clean up the rolled-back main/tangent experiment. The seeded main row has no
-- messages, so deleting it orphans nothing; then drop the now-unused columns.
DELETE FROM conversations WHERE id = 'main';
ALTER TABLE conversations DROP COLUMN continuous;
ALTER TABLE conversations DROP COLUMN kind;
