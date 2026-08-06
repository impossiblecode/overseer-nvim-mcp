-- args: none
-- Kept separate from diagnose, which runs a full template listing
-- behind an 8s vim.wait. Completion can fire on every keystroke, so it needs
-- something that cannot block.
return vim.fn.getcwd()
