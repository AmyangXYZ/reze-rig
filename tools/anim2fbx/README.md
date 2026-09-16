# anim2fbx

Converts Unity Humanoid `.anim` clips to FBX, so reze-rig can read them.

```sh
./anim2fbx.sh out/ "Run1 slow.anim" "Run2 fast.anim"
BAKE_FPS=60 BAKE_ROOT=keep ./anim2fbx.sh out/ SPIN_01_Elegant.anim
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
— `BAKE_FPS=60` for more. One editor runs per clip: the FBX SDK leaks its
manager across exports and the third `FbxManager.Create()` aborts the editor
outright, so a four-clip batch in one process dies on the third file.

## Two things the root can be carrying

`BAKE_ROOT` picks which.

**`flatten`** (default) is for a cycle whose root holds only the heading it was
captured along and the travel a host was meant to consume. It replaces the root
with a fixed heading, measured off the hip axis and summed over the whole clip so
pelvis sway cancels.

**`keep`** is for a performance that turns — a spin, a step-around — and for any
clip authored with Root Transform Rotation **baked into pose**, where the root is
inert and the heading lives in the body. It reads the hip axis at frame 0 only,
and folds the correction into the **hips**, handing back an identity root.

The hips matter. A correction parked on the scene root leaves the exported hips
curves byte-identical to an uncorrected bake, and rigging services read the
skeleton and drop everything above it — so the figure arrives facing its capture
heading again, with the log still reporting success.

Averaging the hip axis across a full turn cancels to noise, so `flatten` on a
spin imposes an arbitrary yaw. It warns when it sees a turning root; a root made
inert by bake-into-pose gives it nothing to warn on, which is what `keep` is for.

## What it checks

Every exported file is read back with `tools/fbx-inspect` and the bake fails if
it does not check out — facing, per-frame continuity, NaN, bone mapping.
`BAKE_CHECK=0` skips it.

## What flatten corrects

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
