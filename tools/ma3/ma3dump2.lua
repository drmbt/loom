local OUT = "/path/to/ma3export"  -- edit: an existing, empty directory
local log = io.open(OUT.."/_index2.tsv","w")
local function safe(s) return (tostring(s or ""):gsub("[^%w%-_ ]","_")) end
local ok, err = pcall(function()
  local pp = DataPool().PresetPools
  for _,pool in ipairs(pp:Children()) do
    for _,o in ipairs(pool:Children()) do
      local fn = string.format("P%02d_%s_%04d_%s.xml", tonumber(pool.no) or 0, safe(pool.name), tonumber(o.no) or 0, safe(o.name))
      local ok2 = pcall(function() o:Export(OUT.."/presets", fn) end)
      log:write(string.format("preset\t%s\t%s\t%s\t%s\t%s\n", tostring(pool.name), tostring(o.no), tostring(o.name), fn, tostring(ok2))); log:flush()
    end
  end
end)
log:write("presets_result\t"..tostring(ok).."\t"..tostring(err).."\n"); log:flush()
local pf = io.open(OUT.."/_patch.tsv","w")
pf:write("stage\tfid\tcid\tname\ttype\tmode\tpatch\tposx\tposy\tposz\trotx\troty\trotz\n")
local function g(o,k) local ok,v=pcall(function() return o[k] end); return ok and v or nil end
local function walk(f, stage, depth)
  if depth>4 then return end
  for _,c in ipairs(f:Children()) do
    local ft=g(c,"fixturetype"); local md=g(c,"modedirect")
    pf:write(table.concat({stage, tostring(g(c,"fid")), tostring(g(c,"cid")), tostring(g(c,"name")), tostring(ft and g(ft,"name")), tostring(md and g(md,"name")), tostring(g(c,"patch")), tostring(g(c,"posx")), tostring(g(c,"posy")), tostring(g(c,"posz")), tostring(g(c,"rotx")), tostring(g(c,"roty")), tostring(g(c,"rotz"))},"\t").."\n")
    walk(c, stage, depth+1)
  end
end
local ok3, err3 = pcall(function() for _,st in ipairs(Patch().Stages:Children()) do walk(st.Fixtures, st.name, 0) end end)
pf:close()
log:write("patch_result\t"..tostring(ok3).."\t"..tostring(err3).."\n"); log:close()
Printf("ma3dump2 done")
