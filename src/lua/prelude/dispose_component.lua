-- on_complete_dispose for every task started here.
--
-- The stock default alias sets require_view = { SUCCESS, FAILURE }, and that
-- timer only starts once the output buffer is shown in a window. We read
-- output over RPC and never show it, so finished tasks would stay in the
-- user's list until nvim exits.
local function dispose_component(timeout, require_view)
  return {
    'on_complete_dispose',
    timeout = timeout,
    -- true = every status the component disposes on
    require_view = require_view and { 'SUCCESS', 'FAILURE', 'CANCELED' } or {},
  }
end
