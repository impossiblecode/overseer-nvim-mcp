-- msgpack encodes JS null as vim.NIL (a userdata sentinel), NOT Lua nil, so an
-- omitted optional arg arrives as userdata and fails overseer's string checks.
-- Needed by any snippet that forwards optional args to overseer.
local function nilify(v)
  if v == nil or v == vim.NIL then
    return nil
  end
  return v
end
