-- needs: nilify
-- Shared resolver: turns a selector (numeric id or name substring, or nil for
-- most-recent) into an overseer task.
-- include_ephemeral and wrapped both default false upstream, so a bare
-- list_tasks() omits ephemeral and jobstart/vim.system-wrapped tasks.
local function all_tasks(filter)
  return require('overseer').list_tasks({
    include_ephemeral = true,
    wrapped = true,
    filter = filter,
  })
end

local function resolve(selector)
  selector = nilify(selector)
  if type(selector) == 'number' then
    return all_tasks(function(t)
      return t.id == selector
    end)[1]
  elseif type(selector) == 'string' then
    local needle = selector:lower()
    local matches = {}
    for _, t in ipairs(all_tasks()) do
      if t.name:lower():find(needle, 1, true) then
        matches[#matches + 1] = t
      end
    end
    -- A substring like dev can match a dozen names in a monorepo, and silently
    -- taking the first is how an agent stops the wrong task, so multiple
    -- matches come back as an error.
    if #matches > 1 then
      return nil, matches
    end
    return matches[1]
  end
  return all_tasks()[1]
end

local function resolve_or_error(selector)
  local task, ambiguous = resolve(selector)
  if ambiguous then
    local names = {}
    for _, t in ipairs(ambiguous) do
      names[#names + 1] = t.id .. ':' .. t.name
    end
    return nil,
      {
        error = 'selector '
          .. tostring(selector)
          .. ' matches '
          .. #ambiguous
          .. ' tasks ('
          .. table.concat(names, ', ')
          .. '); use a numeric id',
      }
  end
  if not task then
    return nil, { error = 'no task matched ' .. tostring(selector) }
  end
  return task, nil
end

local function started_by_us(task)
  return task.metadata ~= nil and task.metadata.mcp_overseer_nvim == true
end

-- Refusing costs one force flag; wrongly stopping the user's dev server costs
-- real state, and they would not attribute it to the agent. Only running tasks
-- are guarded: disposing a finished one just removes a dead row.
local function guard(task, force)
  if force == true then
    return nil
  end
  if task.status ~= 'RUNNING' then
    return nil
  end
  if started_by_us(task) then
    return nil
  end
  return {
    error = 'task '
      .. task.id
      .. ' ('
      .. task.name
      .. ') is running and was not started by this server; pass force to act on it anyway',
  }
end
