# Bit calibration and width-aware isolation (future upgrade)

Status: idea, not started. Planned after PCB CAM v1.

## Context
PCB CAM plans every cut from the width printed on the bit's packet. Real bits cut wider. The tip wears or chips, the bit runs out a little in the ER11 collet, and a V-bit cuts wider the deeper it goes. When the real width is bigger than planned, thin traces get eaten and close pads stay joined.

This upgrade has two parts:
1. **Calibration:** measure what a bit really cuts, with no tools a beginner doesn't already have.
2. **Width-aware isolation:** plan the cuts around that measured width, so a worn bit still makes a board that matches the Gerber.

No AI is involved. Everything is geometry, arithmetic and simple image measuring, and runs offline.

## Part 1: calibration

### Test pattern: two lines at a very small angle
PCB CAM generates the toolpaths directly. It doesn't route them from a Gerber, because isolation routing offsets each cut by the very width we are trying to measure. The pattern is cut along exact centrelines, so where each groove sits doesn't depend on the bit's width.

```
 ───────────────────────────────────────────    line 1 (straight)
                  │ copper strip begins here
 ───────────────────────────────────────────    line 2 (drifts away, ~1°)
 |         |         |         |         |      5 short tick marks (no numbers)
```

- Both lines are cut at the **same depth** all the way, the depth real jobs use.
- They are about 25 mm long. Their centrelines are 0.05 mm apart at the start and 0.55 mm at the end.
- Where they are close, the cuts overlap and all the copper between them is removed. Further along, a thin copper strip survives. **The strip begins where the gap between the centrelines equals the real cut width.**
- The small angle magnifies: 0.01 mm of width moves the start of the strip 0.5 mm along the board, so it can be seen by eye or with a phone camera zoomed in.
- **No engraved numbers.** Each plunge wears a V-bit's tip, so only the two lines and 5 tick marks are cut, about 6 cm of cutting in all. The numbers are shown on screen next to a picture of the pattern.
- **A safe-side error.** A very thin copper strip tends to tear away, so the reading comes out slightly wide. The CAM then treats the bit as wider than it is, which is the safe side.

### Optional extras
- **Three depths (V-bits):** cut the pattern at e.g. 0.05, 0.08 and 0.12 mm. Fitting `w = tip + 2·d·tan(angle/2)` to the three readings gives the bit's effective tip width (wear and runout included) and its effective angle.
- **Depth ladder:** short grooves at 0.02 … 0.10 mm, each between two pads. A multimeter in continuity (beep) mode shows the shallowest depth that cuts through the copper. That depth is the bit's `minDepth`.
- **End mills and corn cutters:** they cut the same width at every depth, so one pattern at one depth is enough.

### Flow
1. Choose a bit in the tool library, then click **Calibrate**. PCB CAM makes a small job, about 30 × 20 mm, for a scrap corner of the board, offset from X0 Y0.
2. Run it the usual way: level the patch, Zero Z, Start. A human starts every motion.
3. Click where the copper strip begins on the on-screen picture, or type the reading.
4. PCB CAM shows the result, for example "This bit cuts 0.27 mm at 0.08 mm deep (packet: 0.20)", and you click Save.

### Checks (structured warnings)
- Width doesn't grow with depth: "Re-zero Z and level, then cut again."
- The fit gives a tip below 0 or an angle far from nominal: "Readings don't fit a V-bit. Check the bit is tight."
- The bit can't isolate the copper at a sensible width: "Replace this bit."

### Data
- The tool schema gets an optional `calibration: { at, points: [{ depth, width }], tipDiameter, angle, minDepth }`.
- `widthAtDepth()` and `depthForWidth()` use the calibrated values when they exist.
- Projects embed tool snapshots, so recalibrating changes the job hash, and Project Runner refuses the old job until it's regenerated.
- Later, Project Runner can track how far each bit has cut and suggest recalibrating after N metres.

### Reading a phone photo (later step)
The user drops a phone photo of the pattern into PCB CAM, and plain image measuring reads it:
1. Find the tick marks, which sit at known distances. That gives the size of a pixel, so the pattern carries its own scale.
2. Walk along the gap between the lines and check brightness: bright is copper, dark is cut.
3. The first bright point is the reading.

If the photo isn't clear, it asks for a new photo or a manual click. It never guesses.

### Camera on the spindle (much later, optional)
A USB microscope camera mounted next to the spindle could measure groove widths automatically.
- **Blocker to check first:** whether the plugin iframe (`allow-scripts allow-forms allow-same-origin`, no camera permission) can use `getUserMedia` in real gSender. A one-hour spike answers this.
- **Pixel size:** move the machine 1 mm between two photos and see how far things shift.
- **Camera offset from the bit:** cut a dot, then move until it's centred in the picture.
- **The hard part:** reliable edges despite dust, burrs and reflections. It needs a ring light and a brushed-clean groove.
- **Rules:** it is never required (beginners don't have the hardware), and every move to the camera needs confirming. Measurements update the calibration and the job is regenerated. The G-code is never patched in place.

## Part 2: width-aware isolation

### Rules, in priority order
1. **Never cut copper that is in the Gerber**, using the calibrated width plus a safety margin. This rule is never broken.
2. **Separate every pair of copper islands that should be separate.** Islands stand in for nets, as in the current analysis.
3. **Remove as much of the other copper as asked**, with extra passes or clearing.

When rules 1 and 2 can't both be met with a bit, the spot is reported. Neither rule is silently broken.

### Techniques
- **Shallower cuts in tight gaps (V-bits):** along a path, the depth at each point is `depthForWidth(gap − margin)`, never shallower than `minDepth` and never deeper than the job's cut depth. The bit rises a little between close pads and drops back afterwards. This is what makes a worn bit usable. It relies on levelling, which Autoleveler and Project Runner already provide. A first version can use a few fixed widths (offset bands computed with clipper) and stitch them, rather than a continuous depth.
- **Cut down the centre of tight gaps:** where the normal edge-following path doesn't fit, follow the gap's centre line, as far as possible from both sides.
- **Wide bit first, fine bit only where needed:** the wide or worn bit does the outlines and any clearing. What it couldn't reach becomes a small job for a fine bit, limited to those spots. This builds on `tool-too-wide`, `suggestRegions` and "Use a finer bit there".
- **Preview of the finished board:** before cutting, compute the board as it will come out (copper minus the cut area at the calibrated width) and compare it with the Gerber. The preview shows copper that would be cut but should stay (must be 0), islands that would still touch (must be 0, marked in red), and harmless leftover copper (grey). Example result: "Matches the Gerber. 0 shorts. 2 spots need the 0.1 mm bit."
- **Pad trimming, off by default:** "Allow trimming up to 0.05 mm off pad edges" applies to pads only, never traces, and only by the amount the user sets.

### Limits
- Flat-bottom end mills cut one width at every depth, so for them only the wide-bit-first, fine-bit-later technique applies.
- Sharp inside corners keep a little extra copper, because a round bit can't reach into them. That's harmless: it never causes a short.

## Phases
1. Test pattern generator (pure module, Node tests), manual reading, `calibration` in the tool schema, `widthAtDepth` using it.
2. Three-depth fit and the depth ladder.
3. Preview of the finished board, compared with the Gerber.
4. Shallower cuts in tight gaps and centre-line paths in the isolation op.
5. Reading a phone photo.
6. Camera on the spindle: spike first, and build only if gSender allows camera access.
