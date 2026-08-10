-- Tag Main's turns so Angel knows where they happened. With topic='main',
-- every Main message is marked [date · main] in the context he reads, the same
-- way a tangent's turns carry its topic. Main is never titled, so this sticks.
UPDATE conversations SET topic = 'main' WHERE id = 'main';
