-- needs: resolve
-- args: (selector: number|string|nil, n: number)
-- Output lives in one of two places: the task buffer once the jobstart
-- terminal channel exists (which requires the panel having been viewed), or
-- strategy.pending_output for a task started over RPC, the agent's own case.
-- Read the buffer first, fall back to pending_output.
--
-- task.strategy is private upstream with no public accessor. The nil-checks
-- below matter: if it changes shape, tail degrades to "no output yet"
-- instead of raising.
-- nilify on both: msgpack null arrives as vim.NIL, which is truthy in Lua,
-- so a bare or-default would keep the sentinel and break the arithmetic.
local selector = ({ ... })[1]
local n = nilify(({ ... })[2]) or 100
local since = nilify(({ ... })[3]) or 0
-- Reading is only guarded by ambiguity: tailing someone else's task is
-- useful and harmless.
local task, err = resolve_or_error(selector)
if err then
  return err
end
local buf = task:get_bufnr()

local function trimmed_len(lines)
  local last = #lines
  while last > 0 and not lines[last]:match('%S') do
    last = last - 1
  end
  return last
end

local lines = buf and vim.api.nvim_buf_get_lines(buf, 0, -1, false) or {}
local last = trimmed_len(lines)

-- pending_output holds chunks, not lines: per :h channel-lines a chunk's
-- last element is a partial line that the next chunk's first element
-- continues. Appending both verbatim invents a blank line per write.
local function join_chunks(chunks)
  local out = {}
  for _, chunk in ipairs(chunks) do
    if #chunk > 0 then
      if #out == 0 then
        for _, l in ipairs(chunk) do
          out[#out + 1] = l
        end
      else
        out[#out] = out[#out] .. chunk[1]
        for i = 2, #chunk do
          out[#out + 1] = chunk[i]
        end
      end
    end
  end
  return out
end

if last == 0 then
  local strat = task.strategy
  if strat and strat.pending_output then
    lines = join_chunks(strat.pending_output)
    last = trimmed_len(lines)
  end
end

-- status and exit_code ride along so the caller learns about a dead task
-- from the tail itself.
local res = {
  lines = {},
  from = 0,
  total = last,
  status = task.status,
  exit_code = task.exit_code,
}

-- An empty tail is a normal state. Raising here would abort a wait_for poll
-- loop on a task that just has not printed anything yet.
if last == 0 then
  return res
end

-- since is a total previously handed back, so resume just after it. from is
-- reported because the n-line window can begin later than since + 1: a
-- caller that fell behind must be able to see the gap.
local from = math.max(since + 1, last - n + 1, 1)

-- PTY translates \n to \r\n, so a \r\n line arrives as \r\r after the
-- line split; strip all trailing CR/LF, then ANSI SGR color codes.
local out = {}
for i = from, last do
  out[#out + 1] = (lines[i]:gsub('[\r\n]+$', ''):gsub('\27%[[0-9;]*m', ''))
end
res.lines = out
res.from = from
return res
