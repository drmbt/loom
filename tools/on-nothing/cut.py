"""The On Nothing full-length cut, row by row, against the reference (T1400b).

`src/projects/on-nothing/edl.json` holds every shot of the reference (the 110 rows of
docs/on-nothing-shotlist-2026-09-27.md) with the loom shot that plays it (`shot`, `take`, and
`from`, the shot time it starts at). A row with no shot yet plays black, labelled NOT BUILT, so
the cut always runs the reference's full length and every row sits on the reference's own frames.

    python3 tools/on-nothing/cut.py render [--rows 1-20,35] [--shots quad] [--final] [--force] [--glb f] [--width 960]
    python3 tools/on-nothing/cut.py assemble [--tag 05] [--rows ...]

render    renders each built row to renders/on-nothing/rows/row-NNN.mp4: exactly the row's frame
          count, with the song from the row's in-point (so reactive shots hear their own bars).
          An existing row clip is kept unless --force.
assemble  writes renders/on-nothing/cuts/full-<tag>.mp4 (ours, with the song) and
          compare-full-<tag>.mp4 (the reference above, ours below, labelled per row), plus
          -share copies under 30 MB.

Needs ffmpeg and Pillow (renders/on-nothing/.venv: python3 -m venv renders/on-nothing/.venv &&
renders/on-nothing/.venv/bin/pip install pillow). Run from the repo root.
"""
import argparse
import json
import os
import subprocess
import sys
from fractions import Fraction

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
EDL = os.path.join(ROOT, "src/projects/on-nothing/edl.json")
OUT = os.path.join(ROOT, "renders/on-nothing")
ROWS = os.path.join(OUT, "rows")
SONG_WAV = os.path.join(OUT, "reference/audio.wav")
SONG_M4A = os.path.join(OUT, "reference/audio.m4a")
W, H = 1920, 818
HALF_W, HALF_H = 1280, 546
FONT = "/System/Library/Fonts/Supplemental/Arial Bold.ttf"


def load():
    with open(EDL) as f:
        edl = json.load(f)
    fps = Fraction(edl["fps"])
    # A row whose reference cuts inside it (strobes, a cut-in) lists "parts": each part is its
    # own clip, {start, end, shot, take, from, args}, and the parts tile the row in time.
    units = []
    for r in edl["rows"]:
        parts = r.get("parts")
        if not parts:
            units.append({**r, "id": f"{r['row']:03d}", "name": f"row {r['row']}"})
            continue
        for k, part in enumerate(parts):
            unit = {**r, "take": 0, "from": 0.0, "args": [], **part}
            unit.pop("parts", None)
            letter = "abcdefghijklmnopqrstuvwxyz"[k]
            units.append({**unit, "id": f"{r['row']:03d}{letter}", "name": f"row {r['row']}{letter}"})
    for u in units:
        u["f0"] = round(u["start"] * fps)
        u["f1"] = round(u["end"] * fps)
    edl["rows"] = units
    return edl, fps


def pick(rows, spec, shots):
    if spec:
        wanted = set()
        for part in spec.split(","):
            a, _, b = part.partition("-")
            wanted.update(range(int(a), int(b or a) + 1))
        rows = [r for r in rows if r["row"] in wanted]
    if shots:
        rows = [r for r in rows if r["shot"] in shots.split(",")]
    return rows


def row_clip(r):
    return os.path.join(ROWS, f"row-{r['id']}.mp4")


def render(args):
    edl, _fps = load()
    os.makedirs(ROWS, exist_ok=True)
    for r in pick(edl["rows"], args.rows, args.shots):
        if not r["shot"]:
            continue
        path = row_clip(r)
        if os.path.exists(path) and not args.force:
            print(f"{r['name']:>9}: kept {os.path.relpath(path, ROOT)}", flush=True)
            continue
        cmd = ["node", "--import", "./src/tooling/alias-hooks.ts", "src/projects/on-nothing/render.ts", "--",
               "--width", str(W), "--shots", r["shot"], "--frames", str(r["f1"] - r["f0"]),
               "--from", str(r["from"]), "--take", str(r["take"]), "--out", path,
               "--audio", SONG_WAV, "--audio-start", str(r["start"]), *r.get("args", [])]
        if args.glb:
            cmd += ["--glb", args.glb]
        if args.width:
            cmd[cmd.index("--width") + 1] = str(args.width)
        if args.final:
            cmd.append("--final")
        print(f"{r['name']:>9}: {r['shot']} take {r['take']} from {r['from']} ({r['f1'] - r['f0']} frames)", flush=True)
        done = subprocess.run(cmd, cwd=ROOT)
        if done.returncode != 0:
            print(f"{r['name']:>9}: FAILED ({done.returncode})", flush=True)
            if os.path.exists(path):
                os.remove(path)


def label(path, text, width):
    from PIL import Image, ImageDraw, ImageFont
    font = ImageFont.truetype(FONT, 20)
    im = Image.new("RGBA", (width, 36), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    while d.textlength(text, font=font) > width - 40:
        text = text[:-2]
    d.rectangle([8, 4, 24 + d.textlength(text, font=font), 32], fill=(0, 0, 0, 160))
    d.text((16, 6), text, font=font, fill=(255, 255, 255, 235))
    im.save(path)


def stamp(seconds):
    return f"{int(seconds // 60)}:{seconds % 60:05.2f}"


def assemble(args):
    edl, fps = load()
    rows = pick(edl["rows"], args.rows, None)
    seg_dir = os.path.join(ROWS, "segments")
    os.makedirs(seg_dir, exist_ok=True)
    rate = f"{fps.numerator}/{fps.denominator}"
    ref = os.path.join(ROOT, edl["reference"])
    ours_list, cmp_list = [], []
    for r in rows:
        n = r["f1"] - r["f0"]
        clip = row_clip(r)
        have = r["shot"] is not None and os.path.exists(clip)
        ours = os.path.join(seg_dir, f"ours-{r['id']}.mp4")
        cmp = os.path.join(seg_dir, f"cmp-{r['id']}.mp4")
        top_label = os.path.join(seg_dir, f"lab-ref-{r['id']}.png")
        bot_label = os.path.join(seg_dir, f"lab-our-{r['id']}.png")
        label(top_label, f"REFERENCE  {r['name']}  {stamp(r['start'])}  {r['what']}", HALF_W)
        ours_text = ((f"LOOM  {r['shot']}" + (f" take {r['take']}" if r["take"] else "")) if have
                     else f"NOT RENDERED  {r['name']}  ({r['shot']}: cut.py render --rows {r['row']})" if r["shot"]
                     else f"NOT BUILT  {r['name']}  (planned: {r['plan']})")
        label(bot_label, ours_text, HALF_W)
        # our half, normalised to the reference's size and rate, exactly n frames (black when not built)
        src = ["-i", clip] if have else ["-f", "lavfi", "-i", f"color=c=black:s={W}x{H}:r={rate}"]
        subprocess.run(["ffmpeg", "-v", "error", "-y", *src, "-vf",
                        f"scale={W}:{H},setsar=1,setpts=N/({rate})/TB,fps={rate}", "-frames:v", str(n),
                        "-r", rate, "-an", "-c:v", "h264_videotoolbox", "-b:v", "24M", "-pix_fmt", "yuv420p", ours], check=True)
        graph = (f"[0:v]trim=start_frame={r['f0']}:end_frame={r['f1']},setpts=PTS-STARTPTS,scale={HALF_W}:{HALF_H},setsar=1[ref];"
                 f"[1:v]scale={HALF_W}:{HALF_H},setsar=1[our];[ref][2:v]overlay=0:0[t];[our][3:v]overlay=0:0[b];[t][b]vstack=inputs=2[v]")
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", ref, "-i", ours, "-i", top_label, "-i", bot_label,
                        "-filter_complex", graph, "-map", "[v]", "-frames:v", str(n), "-r", rate, "-an",
                        "-c:v", "h264_videotoolbox", "-b:v", "10M", "-pix_fmt", "yuv420p", cmp], check=True)
        r["segment"], r["have"] = ours, have
        ours_list.append(ours)
        cmp_list.append(cmp)
        print(f"{r['name']:>9}: {'built' if have else 'black'} {n} frames", flush=True)
    cuts = os.path.join(OUT, "cuts")
    timeline(rows, ref, os.path.join(cuts, f"timeline-{args.tag}.fcpxml"), args.tag)
    start = rows[0]["start"]
    duration = rows[-1]["end"] - start
    for name, parts, share_w in (("full", ours_list, 1280), ("compare-full", cmp_list, 960)):
        listing = os.path.join(seg_dir, f"{name}-{args.tag}.txt")
        with open(listing, "w") as f:
            f.writelines(f"file '{p}'\n" for p in parts)
        video = os.path.join(seg_dir, f"{name}-{args.tag}-video.mp4")
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", listing, "-c", "copy", video], check=True)
        final = os.path.join(cuts, f"{name}-{args.tag}.mp4")
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", video, "-ss", str(start), "-t", str(duration), "-i", SONG_M4A,
                        "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", final], check=True)
        # a share copy under 30 MB: the budget over the length, less the sound
        kbps = max(600, int(29 * 8 * 1024 / max(duration, 1)) - 200)
        share = os.path.join(cuts, f"{name}-{args.tag}-share.mp4")
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", final, "-vf", f"scale={share_w}:-2", "-c:v", "h264_videotoolbox",
                        "-b:v", f"{kbps}k", "-maxrate", f"{kbps}k", "-bufsize", f"{2 * kbps}k", "-c:a", "aac", "-b:a", "128k", share], check=True)
        print(os.path.relpath(final, ROOT), "and", os.path.relpath(share, ROOT), flush=True)


def timeline(rows, ref, path, tag):
    """An FCPXML (1.8) timeline for DaVinci Resolve (File > Import > Timeline): our rows on V1 at
    the reference's frames (a gap where a row is not built), the reference on V2 and the song on
    A1, so the edit around the rows (strobe cuts, dissolves, flashes) is done in the NLE."""
    from xml.sax.saxutils import quoteattr
    t = lambda frames: f"{frames * 1001}/24000s"
    total = rows[-1]["f1"] - rows[0]["f0"]
    base = rows[0]["f0"]
    out = ['<?xml version="1.0" encoding="UTF-8"?>', "<!DOCTYPE fcpxml>", '<fcpxml version="1.8">', "<resources>",
           f'<format id="fmt" frameDuration="1001/24000s" width="{W}" height="{H}"/>',
           f'<asset id="ref" name="reference" src={quoteattr("file://" + ref)} start="0s" duration="{t(4000)}" hasVideo="1" hasAudio="1" format="fmt" audioSources="1" audioChannels="2"/>',
           f'<asset id="song" name="song" src={quoteattr("file://" + SONG_WAV)} start="0s" duration="{t(4000)}" hasAudio="1" audioSources="1" audioChannels="2"/>']
    for r in rows:
        if r["have"]:
            out.append(f'<asset id="row{r["id"]}" name="{r["name"]} {r["shot"]}" src={quoteattr("file://" + r["segment"])} start="0s" duration="{t(r["f1"] - r["f0"])}" hasVideo="1" format="fmt"/>')
    out += ["</resources>", "<library>", '<event name="On Nothing">', f'<project name="On Nothing {tag}">',
            f'<sequence format="fmt" duration="{t(total)}" tcStart="0s" tcFormat="NDF">', "<spine>"]
    for k, r in enumerate(rows):
        n = r["f1"] - r["f0"]
        at = t(r["f0"] - base)
        inner = ""
        if k == 0:
            inner = (f'<asset-clip ref="ref" lane="2" offset="{at}" start="{t(base)}" duration="{t(total)}" name="reference"/>'
                     f'<asset-clip ref="song" lane="-1" offset="{at}" start="{t(base)}" duration="{t(total)}" name="song"/>')
        if r["have"]:
            out.append(f'<asset-clip ref="row{r["id"]}" offset="{at}" start="0s" duration="{t(n)}" name="{r["name"]} {r["shot"]}">{inner}</asset-clip>')
        else:
            out.append(f'<gap name="{r["name"]} not built" offset="{at}" start="0s" duration="{t(n)}">{inner}</gap>')
    out += ["</spine>", "</sequence>", "</project>", "</event>", "</library>", "</fcpxml>"]
    with open(path, "w") as f:
        f.write("\n".join(out) + "\n")
    print(os.path.relpath(path, ROOT), flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["render", "assemble"])
    parser.add_argument("--rows")
    parser.add_argument("--shots")
    parser.add_argument("--final", action="store_true")
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--tag", default="wip")
    parser.add_argument("--glb", help="render.ts --glb (a GLB built elsewhere)")
    parser.add_argument("--width", type=int, help="a draft width; assemble scales every row to 1920 either way")
    args = parser.parse_args()
    {"render": render, "assemble": assemble}[args.command](args)


if __name__ == "__main__":
    sys.exit(main())
