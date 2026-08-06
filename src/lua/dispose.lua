-- needs: resolve
-- args: (selector: number|string, force: boolean|nil)
local task, err = resolve_or_error(({ ... })[1])
if err then
  return err
end
local refused = guard(task, nilify(({ ... })[2]))
if refused then
  return refused
end
local id = task.id
task:dispose(true)
return { id = id, disposed = true }
