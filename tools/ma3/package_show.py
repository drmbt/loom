"""Package a grandMA3 show dump into one Loom show file (VN131).

Input: the onPC XML dump (`ma3dump.lua`), the show's patch CSV (from its MVR) and the fixture
profiles in `tools/ma3/profiles.json`. Output: `<name>.ma3show.json`, the file Loom's `ma3Show`
node plays. Nothing is pre-rendered: the file carries the patch, the per-type DMX profiles, and
the cue data and timecode events of the chosen songs, as data. Loom evaluates the cues on the
timeline (cue fades, tracking, LTP, phasers, Off Sequence commands) and encodes them to DMX.

    python3 tools/ma3/package_show.py --export <dump dir> --timecode TwentyfiveEight \
        --tc-start 3:00:00 --out public/media/stage-previz/ma3/twentyfiveeight.ma3show.json

Format (`loom-ma3-show`, version 1):
  fixtures   [{fid, name, layer, type, kind, universe, address, position:[x,y,z] (previz metres,
             Blender frame: Z up, audience at -Y), axes:[u,v,w] (MVR basis; the beam leaves along -w)}]
  types      {type: profile from profiles.json}
  channels   [[fid, sub, attribute]]  -- every value a cue sets refers to one of these
  sequences  [{no, name, tracking, wrap, offFade, cues:[{no, name, fade, off:[seq no],
             set:[[channel, value, phys?]], release:[channel],
             phasers:[[channel, hz, phase, [values], [widths], [transitions]]]}]}]
  timecode   {name, start, events:[[t, sequence no, 0 goto | 1 go+, cue no]]}  (t in seconds from start)
`phys` is 1 when the value is physical (degrees for Pan/Tilt, Hz for strobe rates), else the value is %.
"""

import argparse
import csv
import json
import os
import re
import xml.etree.ElementTree as ET

LAYER_TYPE = {  # patch layer -> profile name in profiles.json
    "PixelLine": "Acme Pixel Line IP 1000mm@Mode 10",
    "JDC Bursts": "GLP JDC Burst 1@Mode 3 12-Segment",
    "House Wash": "Martin Mac Aura XB@Standard - RGB",
    "Hosue Spot": "Elation Proteus Lucius@Standard",
    "House FOH": "Elation Proteus Lucius@Standard",
    "House Strobe": "Robe Robin ColorStrobe@Mode 1",
    "Robin FS": "Robe Robin iForte FS@Mode 1 - Standard 16 bit",
}


def tc_seconds(s):
    m = re.fullmatch(r"(?:(\d+)h)?(?:(\d+)m)?([\d.]+)?", s.strip())
    h, mi, se = m.groups()
    return int(h or 0) * 3600 + int(mi or 0) * 60 + float(se or 0)


def clean(v):
    if v is None:
        return None
    v = v.lstrip("*?")
    if v.startswith("Specials:Release"):
        return "release"
    try:
        return float(v)
    except ValueError:
        return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--export", required=True)
    ap.add_argument("--patch", default="projects/stage-previz/ma3/ma3-patch-10.12.csv")
    ap.add_argument("--profiles", default="tools/ma3/profiles.json")
    ap.add_argument("--layout", default="projects/stage-previz/ma3/fixtures-r3.csv")
    ap.add_argument("--timecode", required=True)
    ap.add_argument("--tc-start", required=True, help="timecode of the audio's first sample, h:m:s")
    ap.add_argument("--out", required=True)
    a = ap.parse_args()

    profiles = json.load(open(a.profiles))
    # Positions come from the stage layout (the same file the Blender build places bodies from);
    # universe and address from the patch.
    layout = {int(r["fid"]): r for r in csv.DictReader(open(a.layout))}
    fixtures = []
    for r in csv.DictReader(open(a.patch)):
        t = LAYER_TYPE.get(r["layer"])
        if t is None:
            continue
        p = layout[int(r["fid"])]
        fixtures.append(dict(fid=int(r["fid"]), name=r["name"], layer=r["layer"], type=t, kind=p["kind"],
                             universe=int(r["universe"]), address=int(r["address"]),
                             position=[float(p["x_m"]), float(p["y_m"]), float(p["z_m"])],
                             axes=[[float(x) for x in p[k].split()] for k in ("u", "v", "w")]))
    fixtures.sort(key=lambda f: f["fid"])
    keep = {f["fid"] for f in fixtures}

    channels, index = [], {}

    def ch(fid, sub, attr):
        k = (fid, sub, attr)
        if k not in index:
            index[k] = len(channels)
            channels.append([fid, sub, attr])
        return index[k]

    tc = None
    for f in os.listdir(a.export):
        if f.startswith("Timecodes_") and f.endswith(".xml"):
            r = ET.parse(os.path.join(a.export, f)).getroot().find("Timecode")
            if r is not None and r.get("Name") == a.timecode:
                tc = r
    if tc is None:
        raise SystemExit(f"no timecode {a.timecode}")
    files = {int(re.search(r"Sequences_(\d+)_", f).group(1)): os.path.join(a.export, f)
             for f in os.listdir(a.export) if f.startswith("Sequences_")}
    t0 = tc_seconds(a.tc_start.replace(":", "h", 1).replace(":", "m", 1))

    events, wanted = [], set()
    for track in tc.iter("Track"):
        for e in track.iter("CmdEvent"):
            rc = e.find("RealtimeCmd")
            dest = rc.get("ValCueDestination") if rc is not None else None
            if not dest:
                continue
            d = dest.split(".")
            no = int(d[2]) + 1
            if no not in files:
                continue
            wanted.add(no)
            events.append([round(tc_seconds(e.get("Time")) - t0, 4), no, 1 if e.get("Name") == "Go+" else 0, int(d[3]) / 1000.0])
    events.sort(key=lambda x: x[0])

    sequences = []
    for no in sorted(wanted):
        root = ET.parse(files[no]).getroot().find("Sequence")
        seq = dict(no=no, name=root.get("Name"), tracking=root.get("Tracking", "Yes") == "Yes",
                   wrap=root.get("WrapAround", "No") == "Yes", offFade=0.0, cues=[])
        for c in root.findall("Cue"):
            parts = c.findall("Part")
            fades = [clean(p.get("CueInFade")) for p in parts]
            fade = max([x for x in fades if isinstance(x, float)] or [0.0])
            if c.get("Name") == "OffCue":
                seq["offFade"] = fade
                continue
            if c.get("No") is None:
                continue
            cue = dict(no=float(c.get("No")), name=c.get("Name"), fade=fade, off=[], set=[], release=[], phasers=[])
            for p in parts:
                for m in re.finditer(r"Off\s+Sequence\s+(\d+)", p.get("Command") or "", re.I):
                    cue["off"].append(int(m.group(1)))
            for ph in c.iter("Phaser"):
                if ph.get("IDType") != "0":
                    continue
                # A Global value is stored for the fixture TYPE (preset data riding in the cue),
                # not output by the fixture it is filed under: playing it flashed one head per
                # type on every hit.
                if ph.get("Selective") == "Global":
                    continue
                ids = ph.get("ID").split(".")
                fid = int(ids[0])
                if fid not in keep:
                    continue
                k = ch(fid, ".".join(ids[1:]), ph.get("Attribute"))
                steps = ph.findall("Step")
                if len(steps) == 1:
                    s = steps[0]
                    phys = s.get("AbsolutePhys") is not None
                    v = clean(s.get("AbsolutePhys") if phys else s.get("Absolute"))
                    if v == "release":
                        cue["release"].append(k)
                    elif v is not None:
                        cue["set"].append([k, round(v, 4), 1] if phys else [k, round(v, 4)])
                    continue
                vals = [clean(s.get("Absolute") or s.get("AbsolutePhys")) for s in steps]
                vals = [0.0 if not isinstance(v, float) else round(v, 3) for v in vals]
                wid = [clean(s.get("Width")) for s in steps]
                wid = [100.0 if not isinstance(w, float) else round(w, 3) for w in wid]
                tr = [clean(s.get("Trans")) for s in steps]
                tr = [100.0 if not isinstance(x, float) else round(x, 3) for x in tr]
                sp = clean(ph.get("Speed"))
                hz = sp / 2 ** 24 if isinstance(sp, float) else 1.0
                pha = clean(ph.get("Phase"))
                cue["phasers"].append([k, round(hz, 6), round(pha if isinstance(pha, float) else 0.0, 3), vals, wid, tr])
            seq["cues"].append(cue)
        seq["cues"].sort(key=lambda q: q["no"])
        sequences.append(seq)

    used_types = sorted({f["type"] for f in fixtures})
    out = dict(format="loom-ma3-show", version=1, source=os.path.basename(os.path.normpath(a.export)),
               fixtures=fixtures, types={t: profiles[t] for t in used_types}, channels=channels,
               sequences=sequences, timecode=dict(name=a.timecode, start=a.tc_start, events=events))
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    with open(a.out, "w") as fh:
        json.dump(out, fh, separators=(",", ":"))
    print(f"{a.out}: {len(fixtures)} fixtures, {len(channels)} channels, {len(sequences)} sequences, "
          f"{sum(len(s['cues']) for s in sequences)} cues, {len(events)} events, {os.path.getsize(a.out) / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
