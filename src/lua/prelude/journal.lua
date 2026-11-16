-- Lifecycle events of the tasks this server follows, numbered in one global
-- sequence. Each chunk is compiled afresh, so the log lives in _G to last
-- between calls. Task:subscribe survives Task:reset, so one follow covers
-- every later restart.
local JOURNAL_EVENTS_PER_TASK = 50
local JOURNAL_MAX_TASKS = 200
local DIAGNOSTICS_MAX = 20

local function journal_state()
  local j = _G.__mcp_overseer_nvim_journal
  if not j then
    j = { seq = 0, count = 0, tasks = {} }
    _G.__mcp_overseer_nvim_journal = j
  end
  return j
end

local function journal_seq()
  return journal_state().seq
end

local function journal_get(id)
  return journal_state().tasks[id]
end

-- Disposed tasks go first, oldest last event first; a live task is never dropped.
local function journal_prune(j)
  while j.count > JOURNAL_MAX_TASKS do
    local oldest_id, oldest_seq = nil, math.huge
    for id, entry in pairs(j.tasks) do
      if entry.disposed and entry.last < oldest_seq then
        oldest_id, oldest_seq = id, entry.last
      end
    end
    if not oldest_id then
      return
    end
    j.tasks[oldest_id] = nil
    j.count = j.count - 1
  end
end

local function journal_entry(id)
  local j = journal_state()
  local entry = j.tasks[id]
  if not entry then
    entry = { followed = false, disposed = false, last = j.seq, events = {} }
    j.tasks[id] = entry
    j.count = j.count + 1
    journal_prune(j)
  end
  return entry
end

local function journal_note(task, kind, fields)
  local j = journal_state()
  local entry = journal_entry(task.id)
  j.seq = j.seq + 1
  local event = fields or {}
  event.seq, event.kind = j.seq, kind
  entry.last = j.seq
  table.insert(entry.events, event)
  if #entry.events > JOURNAL_EVENTS_PER_TASK then
    table.remove(entry.events, 1)
  end
end

local function journal_diagnostics(result)
  local diags = type(result) == 'table' and result.diagnostics or nil
  if type(diags) ~= 'table' or #diags == 0 then
    return nil, nil
  end
  local out = {}
  for i = 1, math.min(#diags, DIAGNOSTICS_MAX) do
    local d = diags[i]
    local filename = d.filename
    if not filename and d.bufnr and vim.api.nvim_buf_is_valid(d.bufnr) then
      filename = vim.api.nvim_buf_get_name(d.bufnr)
    end
    out[i] = { filename = filename, lnum = d.lnum, col = d.col, type = d.type, text = d.text or '' }
  end
  return out, #diags
end

-- The callbacks return nothing: a truthy return unsubscribes.
local function journal_follow(task)
  local entry = journal_entry(task.id)
  if entry.followed then
    return
  end
  entry.followed = true
  task:subscribe('on_complete', function(t, status, result)
    -- A forced dispose of a running task completes and disposes in one call;
    -- the flag is cleared before anything else can run.
    local current = journal_entry(t.id)
    current.completing = true
    vim.schedule(function()
      current.completing = false
    end)
    local diagnostics, total = journal_diagnostics(result)
    journal_note(t, 'complete', {
      status = status,
      exit_code = t.exit_code,
      diagnostics = diagnostics,
      diagnostics_total = total,
    })
  end)
  task:subscribe('on_reset', function(t)
    journal_note(t, 'reset')
  end)
  task:subscribe('on_dispose', function(t)
    local current = journal_entry(t.id)
    current.disposed = true
    journal_note(t, 'dispose', { while_running = current.completing or nil })
  end)
end
