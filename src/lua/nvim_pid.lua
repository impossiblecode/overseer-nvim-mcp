-- args: none
-- Task ids restart at 1 in a new nvim, so a wait's task id only means
-- something next to the pid of the nvim that issued it.
return vim.fn.getpid()
