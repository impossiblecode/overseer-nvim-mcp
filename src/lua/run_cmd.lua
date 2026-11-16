-- needs: nilify dispose_component unstartable journal
-- args: (cmd: string[], name: string|nil, cwd: string|nil, dispose_timeout: number, dispose_require_view: boolean)
local cmd, name, cwd = ({ ... })[1], nilify(({ ... })[2]), nilify(({ ... })[3])
local dispose_timeout, dispose_require_view = ({ ... })[4], ({ ... })[5]
-- jobstart resolves a relative argv[0] against nvim's cwd, not the task's.
-- The name keeps the command as typed.
local argv0 = cmd[1]
local absolute = argv0:find('^/') or argv0:find('^%a:[/\\]')
if cwd and argv0:find('/', 1, true) and not absolute then
  name = name or table.concat(cmd, ' ')
  cmd = vim.list_extend({ vim.fs.normalize(vim.fs.joinpath(cwd, argv0)) }, cmd, 2)
end
local why = unstartable(cmd, cwd)
if why then
  return { error = 'cannot start: ' .. why }
end
local t = require('overseer').new_task({
  cmd = cmd,
  name = name,
  cwd = cwd,
  metadata = { mcp_overseer_nvim = true },
  -- component.resolve is first-wins, so this shadows the one in 'default'
  components = { dispose_component(dispose_timeout, dispose_require_view), 'default' },
})
journal_follow(t)
local seq = journal_seq()
-- Any other strategy failure. Nothing in 'default' holds a task back, so
-- PENDING after start means it failed.
if not t:start() and t.status == 'PENDING' then
  t:dispose()
  return {
    error = 'overseer did not start the task; its reason is in '
      .. vim.fs.joinpath(vim.fn.stdpath('log'), 'overseer.log'),
  }
end
return { id = t.id, name = t.name, seq = seq }
