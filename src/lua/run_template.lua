-- needs: nilify
-- args: (name: string, cwd: string|nil)
local name, cwd, params = ({ ... })[1], nilify(({ ... })[2]), nilify(({ ... })[3])
local done, res = false, nil
-- run_task resolves templates with opts.search_params ONLY; opts.dir and
-- opts.cwd are applied after resolution, so without search_params a
-- template that overseer.template.list found for cwd cannot be run from
-- it. cwd stays, since it still sets the task working directory.
--
-- disallow_prompt is not optional: overseer prompts the user for missing
-- params, which over RPC opens a form in the editor mid-keystroke while
-- the vim.wait below spins out, leaving the form orphaned. With it set, a
-- missing param comes back as an error. Written as a Lua literal because
-- run_task validates a boolean, and msgpack null arrives as vim.NIL.
local opts = { name = name, cwd = cwd, disallow_prompt = true }
-- Always set: without search_params run_task falls back to
-- get_search_params(), which resolves from the current buffer's parent, so
-- a template overseer_list_templates just listed could fail to resolve here.
-- Defaulting to nvim's cwd keeps listing and running in agreement.
opts.search_params = { dir = cwd or vim.fn.getcwd() }
-- run_task validates params as a table, so only set it when we have one.
if params then
  opts.params = params
end
-- TemplateRunOpts has no metadata field, but on_build hands us the task
-- definition before the task is constructed, which is where it belongs.
opts.on_build = function(task_defn)
  task_defn.metadata = task_defn.metadata or {}
  task_defn.metadata.mcp_overseer_nvim = true
end
require('overseer').run_task(opts, function(task)
  if task then
    res = { id = task.id, name = task.name }
  end
  done = true
end)
vim.wait(10000, function()
  return done
end)
if res then
  return res
end
if not done then
  return { error = 'timed out starting template ' .. tostring(name) }
end

-- run_task throws the build error away, so a nil task is ambiguous between
-- no-such-template and found-but-failed-to-build. Most often it is a missing
-- param that disallow_prompt converted into an error, so work out which case
-- this is before reporting anything. The diagnosis runs after the vim.wait
-- finishes; nesting a vim.wait inside the callback of one already running
-- is re-entrant.
local found, listed = nil, false
require('overseer.template').list({ dir = cwd or vim.fn.getcwd() }, function(tmpls)
  for _, t in ipairs(tmpls) do
    if t.name == name then
      found = t
    end
  end
  listed = true
end)
vim.wait(8000, function()
  return listed
end)
if not found then
  return { error = 'no template named ' .. tostring(name) }
end

local schema = found.params
if type(schema) == 'function' then
  schema = schema()
end
local missing = {}
for key, param in pairs(schema or {}) do
  local supplied = params ~= nil and params[key] ~= nil
  if not param.optional and param.default == nil and not supplied then
    missing[#missing + 1] = key
  end
end
table.sort(missing)
if #missing > 0 then
  return {
    error = 'template ' .. tostring(name) .. ' requires params: ' .. table.concat(missing, ', '),
  }
end
return { error = 'template ' .. tostring(name) .. ' was found but failed to build' }
