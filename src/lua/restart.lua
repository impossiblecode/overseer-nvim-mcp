-- needs: resolve journal
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
journal_follow(task)
journal_note(task, 'restart_requested')
task:restart(true)
-- Read after the restart: a cursor from here skips this restart's own events.
return { id = task.id, status = task.status, seq = journal_seq() }
