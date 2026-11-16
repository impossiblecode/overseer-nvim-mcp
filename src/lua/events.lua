-- needs: journal
-- args: (id: number, after: number)
local id, after = ({ ... })[1], ({ ... })[2]
local entry = journal_get(id)
local events = {}
for _, event in ipairs(entry and entry.events or {}) do
  if event.seq > after then
    events[#events + 1] = event
  end
end
return { seq = journal_seq(), known = entry ~= nil, events = events }
