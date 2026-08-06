-- Loads overseer and nothing else. OVERSEER_PATH points at a checkout of
-- stevearc/overseer.nvim.
local overseer_path = os.getenv("OVERSEER_PATH")
if not overseer_path or overseer_path == "" then
  error("OVERSEER_PATH is not set; cannot find overseer.nvim")
end

vim.opt.runtimepath:append(overseer_path)
require("overseer").setup({})
