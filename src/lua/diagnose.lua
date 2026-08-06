-- needs: nilify
-- args: (dir: string)
-- template.list's second callback argument is a report keyed by provider
-- name; each entry's `message` is that provider's reason for contributing
-- nothing ("No package.json file found"). Nothing else exposes that reason.
local dir = nilify(({ ... })[1]) or vim.fn.getcwd()
local done, report, count = false, nil, 0
require('overseer.template').list({ dir = dir }, function(tmpls, rep)
  count, report = #tmpls, rep
  done = true
end)
vim.wait(8000, function()
  return done
end)

local providers = {}
for name, r in pairs((report or {}).providers or {}) do
  providers[#providers + 1] = {
    name = name,
    message = r.message or vim.NIL,
    available = r.available_tasks,
    total = r.total_tasks,
    from_cache = r.from_cache == true,
  }
end
table.sort(providers, function(a, b)
  return a.name < b.name
end)

local running = 0
for _, t in
  ipairs(require('overseer').list_tasks({
    include_ephemeral = true,
    wrapped = true,
  }))
do
  if t.status == 'RUNNING' then
    running = running + 1
  end
end

return {
  timed_out = not done,
  dir = dir,
  -- Providers search nvim's cwd as well as the requested dir, so a
  -- mismatch explains templates appearing that belong to another project.
  nvim_cwd = vim.fn.getcwd(),
  exrc = vim.o.exrc,
  has_nvim_lua = vim.uv.fs_stat(dir .. '/.nvim.lua') ~= nil,
  templates = count,
  providers = providers,
  tasks_running = running,
}
