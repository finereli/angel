-- Rolled back the main/tangent split; conversations are flat peers again. The
-- kind/continuous columns (0005) are left in place but no longer used. Normalize
-- the seeded main row into an ordinary conversation - its messages stay in the
-- one stream, and it gets named on its next exchange like any other.
UPDATE conversations SET topic = NULL WHERE id = 'main';
