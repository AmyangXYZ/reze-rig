# anim2fbx

Converts Unity Humanoid `.anim` clips to FBX, so reze-rig can read them.

```sh
./anim2fbx.sh out/ "Run1 slow.anim" "Run2 fast.anim"
```

Local tool, not part of the site.

## Why a whole Unity editor

A `.anim` doesn't contain bone rotations. A Humanoid clip stores *muscle values*
— normalised numbers against each joint's limits — which mean nothing without an
Avatar to interpret them against a specific skeleton. There is no reading the
file directly; something has to sample it onto a real rig.

So the tool ships a rig: a Mixamo X Bot, in `project/Assets/XBot.fbx`, imported
as Humanoid. Clips are sampled onto it frame by frame, what the bones actually
do is recorded as ordinary transform curves, and that gets exported as FBX.

Requires a Unity editor with the FBX Exporter package (`com.unity.formats.fbx`,
pinned in `project/Packages/manifest.json`). It's found under Unity Hub
automatically; override with `UNITY=/path/to/Unity`. Sample rate defaults to 30
— `BAKE_FPS=60` for more.

## What it corrects

These clips are authored for a game host that consumes root motion. Nothing
consumes it here, so without correction it stays in the body twice over:

- **Travel.** A cycle authored to run on the spot slides forward — 1.4m across
  Run1 — dragging the feet through the floor. The net drift is measured, then
  subtracted as an even ramp, so per-frame bob and sway survive.
- **Heading.** The capture was performed running along its own heading, ~83° off
  axis, and the runner comes out turned that far sideways. Measured off the hip
  axis, summed over the cycle so the pelvis sway cancels, then rotated back.

Both are reported per clip:

```
[bake] Run1_slow: heading 82.6 deg, net travel 1.39m — both removed
```

## Note on rotation order

Unity's FBX exporter declares `RotationOrder` ZXY, where the middle axis is X —
and a running figure puts knee and shoulder at X ≈ 85°, which is gimbal lock.
The remaining two channels then swing to large coupled values that cancel *only*
in the declared order. Readers that assume FBX's default XYZ (as Mixamo and UE
files, which declare nothing, effectively are) will see a bent knee acquire an
80° twist for two frames — a leg snapping out and back once per stride.

reze-rig reads the declared order as of v0.2.1. Anything older, or any other
tool, may not.
