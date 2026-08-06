-- needs: nilify
-- args: (cmd: string[], name: string|nil, cwd: string|nil)
local cmd, name, cwd = ({ ... })[1], nilify(({ ... })[2]), nilify(({ ... })[3])
local t = require('overseer').new_task({
  cmd = cmd,
  name = name,
  cwd = cwd,
  metadata = { mcp_overseer_nvim = true },
})
t:start()
return { id = t.id, name = t.name }
