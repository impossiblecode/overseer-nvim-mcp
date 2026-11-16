-- needs: resolve journal
-- args: (selector: number|string)
local task, err = resolve_or_error(({ ... })[1])
if err then
  return err
end
journal_follow(task)
return { id = task.id, seq = journal_seq() }
