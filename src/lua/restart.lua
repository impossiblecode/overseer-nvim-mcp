-- needs: resolve
-- args: (selector: number|string, force: boolean|nil)
-- Task:restart is stop() -> reset() -> start() inline, so the status read
-- here is final. It will be RUNNING: a restart ends where it began.
local task, err = resolve_or_error(({ ... })[1])
if err then
  return err
end
local refused = guard(task, nilify(({ ... })[2]))
if refused then
  return refused
end
task:restart(true)
return { id = task.id, status = task.status }
