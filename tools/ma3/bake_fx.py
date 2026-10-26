"""Bake one grandMA3 timecode show into the stage-previz FX feed (VN123).

Rough first pass. Reads a read-only XML dump of an MA3 show (sequences and timecodes, exported
from onPC with obj:Export), the show's patch (ma3-patch-*.csv, from its MVR), and the previz's
FX-feed layout (fx-pixel-map-r2.csv). It replays the timecode events through a small model of
the MA3 playback engine and writes the pixel lines and JDC strobes into a 1920x1080 video laid
out the way the stage-previz session expects its FX feed.

What the model covers: Goto and Go+ events, cue fades (CueInFade), tracking, "Off Sequence N"
cue commands with the OffCue fade, latest-takes-precedence between sequences, and multi-step
dimmer phasers (speed, phase, width, transition). What it ignores: MAtricks, presets resolved
at playback (it uses the values the show already cooked into the cues), strobe/shutter channels,
moving lights, the house rig. Values are percentages straight from the show; no fixture
calibration or gamma.

Run with numpy available:
    python tools/ma3/bake_fx.py --export <dump dir> --timecode TwentyfiveEight \
        --tc-start 3:00:00 --duration 190.9 --out public/media/stage-previz/ma3/twentyfiveeight-fx.mp4
"""

import argparse
import collections
import csv
import math
import os
import re
import subprocess
import sys
import xml.etree.ElementTree as ET

import numpy as np

W, H = 1920, 1080
PL_CELLS = 32  # Pixel Line IP Mode 10 (GDTF): sub 1 = 32 RGB cells, sub 2 = 16 white strobe cells
JDC_SEGS = 12  # JDC Burst 1 Mode 3: 12 RGBW plate segments (sub 4) + 12 white tube segments (sub 3)


def tc_seconds(s):
    """'3h00m01.386' / '59m59.9' / '12.5' -> seconds."""
    m = re.fullmatch(r"(?:(\d+)h)?(?:(\d+)m)?([\d.]+)?", s.strip())
    h, mi, se = m.groups()
    return int(h or 0) * 3600 + int(mi or 0) * 60 + float(se or 0)


def num(v):
    """Show values carry markers: '*75' (cooked from a preset), '?100' (phaser step)."""
    if v is None:
        return None
    v = v.lstrip("*?")
    if v.startswith("Specials:Release"):
        return "release"
    try:
        return float(v)
    except ValueError:
        return None


# ---------------------------------------------------------------- channels

class Channels:
    """Global channel index: (fid, sub, attribute) -> slot in one dense vector."""

    def __init__(self, keep_fids):
        self.keep = keep_fids
        self.index = {}
        self.default = []

    def slot(self, fid, sub, attr):
        key = (fid, sub, attr)
        if key not in self.index:
            self.index[key] = len(self.default)
            # MA defaults: dimmers closed, RGB at full (white), white emitters off.
            # Group/master dimmers (sub "" or a single group level) default open so cell-level
            # programming shows; the show never sets most of them.
            if attr == "Dimmer":
                d = 100.0 if sub.count(".") == 0 else 0.0
            elif attr in ("ColorRGB_R", "ColorRGB_G", "ColorRGB_B"):
                d = 100.0
            else:
                d = 0.0
            self.default.append(d)
        return self.index[key]

    def get(self, fid, sub, attr):
        return self.index.get((fid, sub, attr))


# ---------------------------------------------------------------- sequences

class Cue:
    def __init__(self, no, name):
        self.no, self.name = no, name
        self.fade = 0.0
        self.commands = []
        self.values = {}   # slot -> float | 'release' | phaser tuple


class Sequence:
    def __init__(self, no, name):
        self.no, self.name = no, name
        self.tracking = True
        self.wrap = False
        self.off_fade = 0.0
        self.cues = []      # sorted by number
        self.state = {}     # cue no -> compiled (slots, static, phaser arrays) with tracking applied


def parse_phaser(p, ch):
    steps = p.findall("Step")
    vals = [num(s.get("Absolute")) for s in steps]
    if len(steps) == 1:
        return vals[0]
    v = [0.0 if (x is None or x == "release") else x for x in vals]
    widths = [num(s.get("Width")) for s in steps]
    widths = [100.0 if w is None or w == "release" else w for w in widths]
    trans = [num(s.get("Trans")) for s in steps]
    trans = [100.0 if t is None or t == "release" else t for t in trans]
    speed = num(p.get("Speed"))
    hz = (speed / 2 ** 24) if isinstance(speed, float) else 1.0
    phase = num(p.get("Phase"))
    phase = phase if isinstance(phase, float) else 0.0
    return ("phaser", v, widths, trans, hz, phase)


def load_sequence(path, ch):
    root = ET.parse(path).getroot().find("Sequence")
    no = int(re.search(r"Sequences_(\d+)_", os.path.basename(path)).group(1))
    seq = Sequence(no, root.get("Name"))
    seq.tracking = root.get("Tracking", "Yes") == "Yes"
    seq.wrap = root.get("WrapAround", "No") == "Yes"
    for c in root.findall("Cue"):
        parts = c.findall("Part")
        if c.get("Name") == "OffCue":
            fades = [num(p.get("CueInFade")) for p in parts]
            seq.off_fade = max([f for f in fades if isinstance(f, float)] or [0.0])
            continue
        if c.get("No") is None:
            continue
        cue = Cue(float(c.get("No")), c.get("Name"))
        fades = [num(p.get("CueInFade")) for p in parts]
        cue.fade = max([f for f in fades if isinstance(f, float)] or [0.0])
        cue.commands = [p.get("Command") for p in parts if p.get("Command")]
        for ph in c.iter("Phaser"):
            if ph.get("IDType") != "0":
                continue
            parts_id = ph.get("ID").split(".")
            fid = int(parts_id[0])
            if fid not in ch.keep:
                continue
            slot = ch.slot(fid, ".".join(parts_id[1:]), ph.get("Attribute"))
            cue.values[slot] = parse_phaser(ph, ch)
        seq.cues.append(cue)
    seq.cues.sort(key=lambda q: q.no)
    return seq


def compile_states(seq, n):
    """Per cue: the sequence's full output with tracking applied, as dense arrays."""
    tracked = {}
    for cue in seq.cues:
        cur = dict(tracked) if seq.tracking else {}
        for k, v in cue.values.items():
            if v == "release" or v is None:
                cur.pop(k, None)
            else:
                cur[k] = v
        tracked = cur
        static_idx, static_val, ph = [], [], []
        for k, v in cur.items():
            if isinstance(v, tuple):
                ph.append((k, v))
            else:
                static_idx.append(k)
                static_val.append(v)
        comp = {"static_idx": np.array(static_idx, dtype=np.int64),
                "static_val": np.array(static_val, dtype=np.float32)}
        if ph:
            m = max(len(v[1]) for _, v in ph)
            P = len(ph)
            vals = np.zeros((P, m), np.float32)
            wid = np.full((P, m), 100.0, np.float32)
            tr = np.full((P, m), 100.0, np.float32)
            nst = np.zeros(P, np.int64)
            hz = np.zeros(P, np.float32)
            phs = np.zeros(P, np.float32)
            for i, (k, v) in enumerate(ph):
                _, vv, ww, tt, f, p = v
                vals[i, :len(vv)] = vv
                wid[i, :len(ww)] = ww
                tr[i, :len(tt)] = tt
                nst[i] = len(vv)
                hz[i] = f
                phs[i] = p
            comp.update(ph_idx=np.array([k for k, _ in ph], dtype=np.int64), ph_vals=vals, ph_wid=wid,
                        ph_tr=tr, ph_n=nst, ph_hz=hz, ph_phase=phs)
        seq.state[cue.no] = comp


def eval_state(comp, t_since, n):
    """Dense vector (NaN where the sequence holds nothing) for a compiled cue at a time."""
    out = np.full(n, np.nan, np.float32)
    out[comp["static_idx"]] = comp["static_val"]
    if "ph_idx" in comp:
        nst = comp["ph_n"]
        u = (t_since * comp["ph_hz"] + comp["ph_phase"] / 360.0) % 1.0
        pos = u * nst
        k = np.minimum(pos.astype(np.int64), nst - 1)
        f = pos - k
        rows = np.arange(len(nst))
        v0 = comp["ph_vals"][rows, k]
        v1 = comp["ph_vals"][rows, (k + 1) % nst]
        w = comp["ph_wid"][rows, k] / 100.0
        tr = comp["ph_tr"][rows, k] / 100.0
        # Within a step: hold for its width; a full-width step crossfades into the next over
        # its transition share; a short step (width < 100 %) is a flash and drops to 0 after.
        full = w >= 0.99
        cross = np.where(tr > 0, np.clip((f - (1 - tr)) / np.maximum(tr, 1e-6), 0, 1), 0)
        v_full = v0 + (v1 - v0) * cross
        v_flash = np.where(f < w, v0, 0.0)
        out[comp["ph_idx"]] = np.where(full, v_full, v_flash)
    return out


# ---------------------------------------------------------------- playback

class Playback:
    def __init__(self, seq):
        self.seq = seq
        self.active = False
        self.cue = None
        self.t_fire = 0.0
        self.prev = None        # (cue no, its t_fire) the sequence faded from
        self.off_t = None
        self.order = 0

    def cue_after(self, no):
        nos = [c.no for c in self.seq.cues]
        later = [x for x in nos if x > no + 1e-6]
        if later:
            return later[0]
        return nos[0] if self.seq.wrap and nos else None


def run(args):
    export = args.export
    # patch: which fixtures we draw and where
    patch = list(csv.DictReader(open(args.patch)))
    pl = {int(r["fid"]): r for r in patch if r["layer"] == "PixelLine"}
    jdc = {int(r["fid"]): r for r in patch if r["layer"] == "JDC Bursts"}
    ch = Channels(set(pl) | set(jdc))

    # timecode
    tc_files = [f for f in os.listdir(export) if f.startswith("Timecodes_") and f.endswith(".xml")]
    tc_root = None
    for f in tc_files:
        r = ET.parse(os.path.join(export, f)).getroot().find("Timecode")
        if r is not None and r.get("Name") == args.timecode:
            tc_root = r
    if tc_root is None:
        sys.exit(f"no timecode named {args.timecode}")
    seq_files = {int(re.search(r"Sequences_(\d+)_", f).group(1)): os.path.join(export, f)
                 for f in os.listdir(export) if f.startswith("Sequences_")}
    t0 = tc_seconds(args.tc_start.replace(":", "h", 1).replace(":", "m", 1)) if ":" in args.tc_start else float(args.tc_start)

    events = []
    seqs = {}
    for track in tc_root.iter("Track"):
        for e in track.iter("CmdEvent"):
            rc = e.find("RealtimeCmd")
            dest = rc.get("ValCueDestination") if rc is not None else None
            if not dest:
                continue
            d = dest.split(".")
            seq_no, cue_no = int(d[2]) + 1, int(d[3]) / 1000.0
            if seq_no not in seqs:
                if seq_no not in seq_files:
                    print(f"  missing sequence {seq_no} for track {track.get('Name')}")
                    continue
                seqs[seq_no] = load_sequence(seq_files[seq_no], ch)
            events.append((tc_seconds(e.get("Time")) - t0, seq_no, e.get("Name"), cue_no))
    events.sort(key=lambda x: x[0])
    n = len(ch.default)
    for s in seqs.values():
        compile_states(s, n)
    default = np.array(ch.default, np.float32)
    print(f"timecode {args.timecode}: {len(events)} events, {len(seqs)} sequences, {n} channels")
    for s in seqs.values():
        print(f"  seq {s.no:5d} {s.name!r:28s} cues={len(s.cues):3d} tracking={s.tracking} offfade={s.off_fade}")

    pbs = {no: Playback(s) for no, s in seqs.items()}
    order = 0

    def fire(pb, cue_no, t):
        nonlocal order
        if cue_no not in pb.seq.state:
            return
        if pb.active and pb.cue is not None and pb.off_t is None:
            pb.prev = (pb.cue, pb.t_fire)
        else:
            pb.prev = None
        pb.active, pb.cue, pb.t_fire, pb.off_t = True, cue_no, t, None
        order += 1
        pb.order = order
        cue = next(c for c in pb.seq.cues if c.no == cue_no)
        for cmd in cue.commands:
            m = re.fullmatch(r"\s*Off\s+Sequence\s+(\d+)\s*", cmd, re.I)
            if m and int(m.group(1)) in pbs:
                pbs[int(m.group(1))].off_t = t
            elif cmd.strip():
                unknown_cmds[cmd] += 1

    unknown_cmds = collections.Counter()

    # ------------------------------------------------ layout: who paints where
    pix = list(csv.DictReader(open(args.pixmap)))
    bars = collections.defaultdict(list)
    strobes = {}
    for r in pix:
        if r["kind"] == "pixel":
            bars[r["id"].split(":")[0]].append(r)
        else:
            strobes[r["id"]] = r
    bar_info = {}
    for b, rs in bars.items():
        xs = [float(r["x_m"]) for r in rs]
        bar_info[b] = dict(x=sum(xs) / len(xs), z=float(rs[0]["z_m"]),
                           c0=min(int(r["col"]) for r in rs), c1=max(int(r["col"]) for r in rs),
                           row=int(rs[0]["row"]))
    label = np.full((H, W), -1, np.int32)
    # cell list: each entry paints one rectangle with one colour
    cells = []   # (kind, fid, cell index)

    used = set()
    for fid, r in sorted(pl.items()):
        x, z = float(r["previz_x_m"]), float(r["previz_z_m"])
        b = min(bar_info, key=lambda k: (bar_info[k]["x"] - x) ** 2 + (bar_info[k]["z"] - z) ** 2)
        bi = bar_info[b]
        if b in used:
            print(f"  warning: two show fixtures on bar {b}")
        used.add(b)
        span0, span1 = bi["c0"] - 2.5, bi["c1"] + 2.5
        for c in range(PL_CELLS):
            k = (PL_CELLS - 1 - c) if args.flip_pl else c
            x0 = int(round(span0 + (span1 - span0) * k / PL_CELLS))
            x1 = int(round(span0 + (span1 - span0) * (k + 1) / PL_CELLS))
            label[max(bi["row"] - 3, 0):bi["row"] + 4, max(x0, 0):min(x1, W)] = len(cells)
            cells.append(("pl", fid, c + 1))
    unmatched = []
    for fid, r in sorted(jdc.items()):
        x, y = float(r["previz_x_m"]), float(r["previz_y_m"])
        s = min(strobes, key=lambda k: (float(strobes[k]["x_m"]) - x) ** 2 + (float(strobes[k]["y_m"]) - y) ** 2)
        d = math.hypot(float(strobes[s]["x_m"]) - x, float(strobes[s]["y_m"]) - y)
        if d > 0.5:
            unmatched.append((fid, round(x, 2), round(y, 2), s, round(d, 2)))
            continue
        cx, cy = int(strobes[s]["col"]), int(strobes[s]["row"])
        label[max(cy - 12, 0):cy + 13, max(cx - 12, 0):cx + 13] = len(cells)
        cells.append(("jdc", fid, s))
    print(f"  pixel lines mapped: {len(used)} bars; JDC mapped: {sum(1 for c in cells if c[0] == 'jdc')}; unmatched JDC: {unmatched}")

    # gather matrices: colour of each paint cell = sum_j weight_j * channel products
    def slots(fid, sub, attr):
        return ch.slot(fid, sub, attr)

    # Per cell we compute rgb from channel vector `out` (percent units).
    pl_cells = [(i, f, c) for i, (k, f, c) in enumerate(cells) if k == "pl"]
    jd_cells = [(i, f, s) for i, (k, f, s) in enumerate(cells) if k == "jdc"]
    # pixel line: master(f) * group(f.1) * cell dim(f.1.c) * rgb(f.1.c)  +  white cell f.2.k (* group f.2)
    A = lambda lst: np.array(lst, dtype=np.int64)
    plI = A([i for i, _, _ in pl_cells])
    pl_m = A([slots(f, "", "Dimmer") for _, f, _ in pl_cells])
    pl_g = A([slots(f, "1", "Dimmer") for _, f, _ in pl_cells])
    pl_d = A([slots(f, f"1.{c}", "Dimmer") for _, f, c in pl_cells])
    pl_r = A([slots(f, f"1.{c}", "ColorRGB_R") for _, f, c in pl_cells])
    pl_gg = A([slots(f, f"1.{c}", "ColorRGB_G") for _, f, c in pl_cells])
    pl_b = A([slots(f, f"1.{c}", "ColorRGB_B") for _, f, c in pl_cells])
    # 16 white strobe cells (sub 2.k) under the 32 RGB cells: white k covers RGB cells 2k-1, 2k
    pl_w = A([slots(f, f"2.{(c + 1) // 2}", "Dimmer") for _, f, c in pl_cells])
    pl_wg = A([slots(f, "2", "Dimmer") for _, f, _ in pl_cells])
    jdI = A([i for i, _, _ in jd_cells])
    jd = {}
    for name, sub, attr in [("d", "4", "Dimmer"), ("r", "4", "ColorRGB_R"), ("g", "4", "ColorRGB_G"),
                            ("b", "4", "ColorRGB_B"), ("w", "4", "ColorRGB_W"), ("t", "3", "Dimmer")]:
        jd[name] = A([[slots(f, f"{sub}.{s + 1}", attr) for s in range(JDC_SEGS)] for _, f, _ in jd_cells]).reshape(len(jd_cells), JDC_SEGS)
    jd_m = A([slots(f, "", "Dimmer") for _, f, _ in jd_cells])
    jd_g4 = A([slots(f, "4", "Dimmer") for _, f, _ in jd_cells])
    jd_g3 = A([slots(f, "3", "Dimmer") for _, f, _ in jd_cells])
    n = len(ch.default)  # slots() above may have added channels the show never programs
    default = np.array(ch.default, np.float32)
    for s in seqs.values():   # re-pad nothing: compiled arrays index only existing slots
        pass

    # ------------------------------------------------ render
    fps = args.fps
    frames = int(round(args.duration * fps))
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    cmd = ["ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}",
           "-r", str(fps), "-i", "-"]
    if args.audio:
        cmd += ["-i", args.audio, "-c:a", "aac", "-b:a", "192k", "-shortest"]
    cmd += ["-c:v", "libx264", "-preset", "fast", "-crf", "14", "-pix_fmt", "yuv420p", "-g", "30",
            "-movflags", "+faststart", args.out]
    ff = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    colors = np.zeros((len(cells) + 1, 3), np.float32)   # last row = background (label -1)
    ei = 0
    for fi in range(frames):
        t = fi / fps
        while ei < len(events) and events[ei][0] <= t:
            te, sn, kind, cue_no = events[ei]
            pb = pbs[sn]
            if kind == "Go+":
                nxt = pb.cue_after(pb.cue if (pb.active and pb.cue is not None) else -1e9)
                if nxt is not None:
                    fire(pb, nxt, max(te, 0.0))
            else:
                fire(pb, cue_no, max(te, 0.0))
            ei += 1
        out = default.copy()
        for pb in sorted((p for p in pbs.values() if p.active), key=lambda p: p.order):
            comp = pb.seq.state[pb.cue]
            fade = next(c.fade for c in pb.seq.cues if c.no == pb.cue)
            a = 1.0 if fade <= 0 else min(max((t - pb.t_fire) / fade, 0.0), 1.0)
            new = eval_state(comp, t - pb.t_fire, n)
            has_new = ~np.isnan(new)
            if pb.prev is not None and a < 1.0:
                prev = eval_state(pb.seq.state[pb.prev[0]], t - pb.prev[1], n)
                has_prev = ~np.isnan(prev)
            else:
                prev = None
                has_prev = np.zeros(n, bool)
            val = np.where(has_new & has_prev, prev + (new - prev) * a if prev is not None else new,
                           np.where(has_new, out + (new - out) * a,
                                    np.where(has_prev, (prev if prev is not None else out) + (out - (prev if prev is not None else out)) * a, out)))
            own = has_new | has_prev
            wgt = 1.0
            if pb.off_t is not None:
                of = pb.seq.off_fade
                wgt = 0.0 if of <= 0 else 1.0 - min(max((t - pb.off_t) / of, 0.0), 1.0)
                if wgt <= 0.0:
                    pb.active = False
                    continue
            out = np.where(own, out + (val - out) * wgt, out)
        o = np.clip(out / 100.0, 0.0, 1.0)
        # pixel lines
        lvl = o[pl_m] * o[pl_g] * o[pl_d]
        white = o[pl_w] * o[pl_wg] * o[pl_m]
        colors[plI, 0] = o[pl_r] * lvl + white
        colors[plI, 1] = o[pl_gg] * lvl + white
        colors[plI, 2] = o[pl_b] * lvl + white
        # JDC: average of the 12 plate segments + the tube
        lv = o[jd["d"]] * (o[jd_m] * o[jd_g4])[:, None]
        wv = o[jd["w"]] * lv
        tube = (o[jd["t"]] * (o[jd_m] * o[jd_g3])[:, None]).mean(axis=1)
        colors[jdI, 0] = (o[jd["r"]] * lv + wv).mean(axis=1) + tube
        colors[jdI, 1] = (o[jd["g"]] * lv + wv).mean(axis=1) + tube
        colors[jdI, 2] = (o[jd["b"]] * lv + wv).mean(axis=1) + tube
        frame = (np.clip(colors, 0, 1) * 255).astype(np.uint8)[label]
        ff.stdin.write(frame.tobytes())
        if fi % (fps * 10) == 0:
            print(f"  {t:6.1f}s  active={[p.seq.name for p in pbs.values() if p.active]}", flush=True)
    ff.stdin.close()
    ff.wait()
    if unknown_cmds:
        print("  cue commands not modelled:", dict(unknown_cmds))
    print("wrote", args.out)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--export", required=True, help="dir of MA3 XML (Sequences_*.xml, Timecodes_*.xml)")
    ap.add_argument("--patch", default="projects/stage-previz/ma3/ma3-patch-10.12.csv")
    ap.add_argument("--pixmap", default="projects/stage-previz/fx-pixel-map-r2.csv")
    ap.add_argument("--timecode", required=True)
    ap.add_argument("--tc-start", default="0", help="timecode of the audio's first sample, h:m:s or seconds")
    ap.add_argument("--duration", type=float, required=True)
    ap.add_argument("--fps", type=int, default=30)
    ap.add_argument("--flip-pl", action="store_true", help="pixel line cell 1 at stage right instead of house left")
    ap.add_argument("--audio", help="mux this audio in (for a reference copy; the session plays the song itself)")
    ap.add_argument("--out", required=True)
    run(ap.parse_args())
