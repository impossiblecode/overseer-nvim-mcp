-- needs: nilify
-- args: (dir: string)
-- overseer.template is internal, and there is no public equivalent: nothing
-- on the public surface returns the discovered template list. Expect this to
-- be the first thing to break on an overseer bump.
-- Providers search nvim's cwd regardless of what is passed, so any other
-- default makes the omitted-dir case disagree with discovery.
local dir = nilify(({ ... })[1]) or vim.fn.getcwd()
local filter = nilify(({ ... })[2])
local needle = filter and filter:lower() or nil

-- running_task_id is what stops a second dev server being started on top
-- of the first. Task names come from each template's builder, so the name
-- match can miss.
local running = {}
for _, task in
  ipairs(require('overseer').list_tasks({
    include_ephemeral = true,
    wrapped = true,
  }))
do
  if task.status == 'RUNNING' and running[task.name] == nil then
    running[task.name] = task.id
  end
end

local done, res = false, {}
require('overseer.template').list({ dir = dir }, function(tmpls)
  for _, t in ipairs(tmpls) do
    local keep = true
    if needle then
      keep = t.name:lower():find(needle, 1, true) ~= nil
        or (t.desc ~= nil and t.desc:lower():find(needle, 1, true) ~= nil)
    end
    if keep then
      -- Only name, desc, params and module are ever populated; no builtin
      -- provider sets tags or priority.
      local entry = { name = t.name, desc = t.desc, provider = t.module }

      local schema = t.params
      if type(schema) == 'function' then
        schema = schema()
      end
      if type(schema) == 'table' then
        local params = {}
        for key, param in pairs(schema) do
          params[#params + 1] = {
            name = key,
            type = param.type,
            default = param.default,
            required = not param.optional and param.default == nil,
          }
        end
        table.sort(params, function(a, b)
          return a.name < b.name
        end)
        -- Omitted when empty; params are rare and long lists should not
        -- carry empty arrays on every entry.
        if #params > 0 then
          entry.params = params
        end
      end

      entry.running_task_id = running[t.name]
      res[#res + 1] = entry
    end
  end
  done = true
end)
vim.wait(8000, function()
  return done
end)

-- An empty list is a real answer, so a timeout has to say so explicitly or
-- the two look identical to the caller.
if not done then
  return { error = 'timed out listing templates for ' .. tostring(dir) }
end

-- Described-first: npm and make supply no desc while go-task and just do,
-- so a mixed repo would otherwise bury its documented half.
table.sort(res, function(a, b)
  local ad, bd = a.desc ~= nil, b.desc ~= nil
  if ad ~= bd then
    return ad
  end
  return a.name < b.name
end)

-- Lua drops nil-valued keys, so absent and none-to-report would look alike;
-- vim.NIL survives as an explicit null. provider needs it as well as desc:
-- directly registered templates carry no module.
for _, entry in ipairs(res) do
  if entry.desc == nil then
    entry.desc = vim.NIL
  end
  if entry.provider == nil then
    entry.provider = vim.NIL
  end
end
return res
