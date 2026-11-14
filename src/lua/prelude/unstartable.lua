-- Why a task can't start, or nil. Same two checks jobstart makes.
-- Task:start only logs a failure to overseer.log and leaves the task PENDING,
-- which looks the same as one held by the dependencies component, so callers
-- check before starting.
local function unstartable(cmd, cwd)
  if cwd and vim.fn.isdirectory(cwd) == 0 then
    return 'cwd ' .. cwd .. ' is not a directory'
  end
  -- a string cmd goes through 'shell'
  if type(cmd) ~= 'table' or vim.fn.executable(cmd[1]) == 1 then
    return nil
  end
  if not cmd[1]:find('/', 1, true) then
    return tostring(cmd[1]) .. " is not on nvim's PATH, or not executable"
  end
  return tostring(cmd[1])
    .. " is not executable (a relative path resolves against nvim's cwd, "
    .. vim.fn.getcwd()
    .. ')'
end
