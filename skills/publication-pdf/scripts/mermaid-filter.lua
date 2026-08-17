-- Convert fenced Mermaid code blocks into SVG images before Typst rendering.
-- The output directory and mmdc command are supplied by the build script.

local counter = 0
local output_dir = os.getenv("TOWER_TYPST_ASSET_DIR") or "assets/generated"
local mmdc = os.getenv("TOWER_MMDC") or "mmdc"
local chromium = os.getenv("PUPPETEER_EXECUTABLE_PATH")
local chrome_tmp = os.getenv("TOWER_CHROME_TMP") or "/tmp"
local project_root = os.getenv("TOWER_TYPST_ROOT") or "."
local document_asset_prefix = os.getenv("TOWER_TYPST_DOCUMENT_ASSET_PREFIX") or "assets"
local mermaid_config = os.getenv("TOWER_MERMAID_CONFIG")
local puppeteer_config = os.getenv("TOWER_PUPPETEER_CONFIG")

local function shell_quote(value)
  return "'" .. tostring(value):gsub("'", "'\\''") .. "'"
end

local function has_class(block, expected)
  for _, class_name in ipairs(block.classes) do
    if class_name == expected then return true end
  end
  return false
end

function CodeBlock(block)
  if not has_class(block, "mermaid") then return nil end

  counter = counter + 1
  local stem = string.format("mermaid-%02d", counter)
  local source_path = output_dir .. "/" .. stem .. ".mmd"
  local image_path = output_dir .. "/" .. stem .. ".png"

  local source = assert(io.open(source_path, "w"))
  source:write(block.text)
  source:write("\n")
  source:close()

  local command_parts = {
    "TMPDIR=" .. shell_quote(chrome_tmp),
  }
  if chromium and chromium ~= "" then
    table.insert(command_parts, "PUPPETEER_EXECUTABLE_PATH=" .. shell_quote(chromium))
  end
  table.insert(command_parts, shell_quote(mmdc))
  table.insert(command_parts, "-i")
  table.insert(command_parts, shell_quote(source_path))
  table.insert(command_parts, "-o")
  table.insert(command_parts, shell_quote(image_path))
  table.insert(command_parts, "-b white")
  if puppeteer_config and puppeteer_config ~= "" then
    table.insert(command_parts, "-p")
    table.insert(command_parts, shell_quote(puppeteer_config))
  end
  table.insert(command_parts, "-w 1600")
  table.insert(command_parts, "-s 2")
  if mermaid_config and mermaid_config ~= "" then
    table.insert(command_parts, "-c")
    table.insert(command_parts, shell_quote(mermaid_config))
  end

  local ok, _, code = os.execute(table.concat(command_parts, " "))
  if ok ~= true and ok ~= 0 then
    error("Mermaid rendering failed for " .. source_path .. " (exit " .. tostring(code) .. ")")
  end

  local document_path = document_asset_prefix .. "/" .. stem .. ".png"

  local caption = block.attributes.caption or ""
  local alt = block.attributes.alt or (caption ~= "" and caption or "Mermaid diagram")
  return pandoc.Figure(
    { pandoc.Plain({ pandoc.Image(alt, document_path) }) },
    caption ~= "" and { pandoc.Plain({ pandoc.Str(caption) }) } or {}
  )
end
