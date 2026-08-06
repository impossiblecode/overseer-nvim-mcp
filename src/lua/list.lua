-- args: none
-- Lua drops nil-valued keys, so a running task omits exit_code entirely.
local out = {}
local tasks = require('overseer').list_tasks({ include_ephemeral = true, wrapped = true })
for _, t in ipairs(tasks) do
  out[#out + 1] = {
    id = t.id,
    name = t.name,
    status = t.status,
    exit_code = t.exit_code,
    cmd = t.cmd,
    cwd = t.cwd,
    time_start = t.time_start,
    time_end = t.time_end,
    -- So the agent can clean up its own tasks without touching the user's.
    origin = (t.metadata ~= nil and t.metadata.mcp_overseer_nvim == true) and 'agent' or 'user',
  }
end
return out
