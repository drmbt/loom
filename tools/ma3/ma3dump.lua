-- read-only dump: exports pool objects as MA3 XML, writes an index. Changes nothing in the show.
local OUT = "/path/to/ma3export"  -- edit: an existing, empty directory
local log = io.open(OUT.."/_index.tsv","w")
local function safe(s) return (tostring(s or ""):gsub("[^%w%-_ ]","_")) end
local function dumpPool(label, pool)
  if not pool then log:write(label.."\tMISSING\n") return end
  local n=0
  for _,o in ipairs(pool:Children()) do
    local fn = string.format("%s_%04d_%s.xml", label, tonumber(o.no) or 0, safe(o.name))
    local ok, r = pcall(function() return o:Export(OUT, fn) end)
    log:write(string.format("%s\t%s\t%s\t%s\t%s\n", label, tostring(o.no), tostring(o.name), fn, tostring(ok and r)))
    n=n+1
  end
  Printf("dump "..label..": "..n)
end
local dp = DataPool()
for _,k in ipairs({"Sequences","Timecodes","Macros","Groups","MAtricks","Layouts","Generators","Plugins","Pages","Quickeys","Timers","Filters","Worlds","Shapes"}) do
  local ok,p = pcall(function() return dp[k] end); dumpPool(k, ok and p or nil)
end
local pp = ShowData().PresetPools
for _,pool in ipairs(pp:Children()) do dumpPool("Preset"..tostring(pool.no).."_"..safe(pool.name), pool) end
-- patch summary with fixture ids/addresses for cross-check with MVR
local pf = io.open(OUT.."/_patch.tsv","w")
pf:write("stage\tfid\tcid\tname\ttype\tmode\tpatch\n")
local function walk(f, stage)
  for _,c in ipairs(f:Children()) do
    local ok = pcall(function()
      pf:write(string.format("%s\t%s\t%s\t%s\t%s\t%s\t%s\n", stage, tostring(c.fid), tostring(c.cid), tostring(c.name), tostring(c.fixturetype and c.fixturetype.name), tostring(c.modedirect and c.modedirect.name), tostring(c.patch)))
    end)
    walk(c, stage)
  end
end
for _,st in ipairs(Patch().Stages:Children()) do walk(st.Fixtures, st.name) end
pf:close(); log:close()
Printf("ma3dump done -> "..OUT)
