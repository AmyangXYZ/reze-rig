---
name: anim-to-fbx
description: Convert Unity Humanoid .anim clips (muscle-space animation, e.g. VRChat/booth motion packs) into rigged FBX with real bone curves, verified before delivery. Use when asked to convert .anim files, bake a Unity humanoid clip onto a skeleton, or prepare a motion pack for a rigging service or the FBX→VMD pipeline.
---

# Unity Humanoid `.anim` → FBX

A `.anim` holds **muscle values**, not bone rotations: normalised numbers against
each joint's limits, meaningless without an Avatar. There is no reading the file
directly — something has to sample it onto a real rig. `tools/anim2fbx` ships
one (a Mixamo X Bot, imported Humanoid) and does this.

## Do this

```sh
tools/anim2fbx/anim2fbx.sh out/ path/to/*.anim          # BAKE_FPS=60 BAKE_ROOT=keep as needed
tools/fbx-inspect/fbx-inspect.sh out/*.fbx              # read back what is actually in the files
```

`anim2fbx.sh` runs `fbx-inspect --check` on each file automatically
(`BAKE_CHECK=0` opts out). Sample at the rate the clip was authored at — read
`m_SampleRate` from the YAML; these packs are usually 60, and the tool defaults
to 30.

## Read the pack's settings before choosing a root mode

Motion packs ship screenshots of their intended Unity import settings. **Read
them.** They are authoritative and will settle questions that are slow to derive
from the YAML. Equivalently, from the clip's `m_AnimationClipSettings`:

| YAML | Unity | Means |
|---|---|---|
| `m_LoopBlendOrientation: 1` | Root Transform Rotation → Bake Into Pose | the turn is in the **body**; the root is inert |
| `m_LoopBlendPositionY: 1` | Position Y → Bake Into Pose | height is in the body |
| `m_LoopBlendPositionXZ: 0` | Position XZ → not baked | travel is root motion, to be discarded |

Then pick:

- **`BAKE_ROOT=keep`** — anything that turns (spins, step-arounds), and anything
  with rotation baked into pose. Reads the heading off the hip axis at **frame
  0** and folds it into the hips.
- **`BAKE_ROOT=flatten`** (default) — locomotion cycles whose root carries only
  a capture heading and travel for a host to consume. Averages the hip axis over
  the whole clip so pelvis sway cancels.

Do not use `flatten` on a spin: averaging a rotating vector over a full turn
cancels to noise and imposes an arbitrary yaw. The baker warns when it sees a
turning root, but a root inert from bake-into-pose gives it nothing to warn on.

## Traps

**The bake's log is not evidence.** It reports what it computed, which can be
correct while the result lands somewhere nothing reads. A correction parked on
the scene root produces hips curves byte-identical to an uncorrected bake, and
rigging services drop everything above the skeleton — so the figure arrives
facing its capture heading again. Always confirm with `fbx-inspect` against the
written file; `--facing 0` is the assertion that would have caught it.

**Read curves are not evaluated curves.** `RootQ` in the YAML can show a full
360° turn that Unity never applies, because Bake Into Pose moved it. Sample it;
don't reason from the raw keys.

**The FBX SDK leaks across exports.** The third `FbxManager.Create()` in one
process aborts the editor with `std::overflow_error`. `anim2fbx.sh` runs one
editor per clip for this reason — do not "optimise" it back into a single run.

**Fingers snap legitimately.** A performance flicks a hand open across nearly the
whole muscle range in one frame. `fbx-inspect` holds fingers to a separate limit
(`--max-step-finger`, default 90°) from body bones (`--max-step`, default 25°).
Before loosening a threshold, check the source clip's muscle curve for the same
jump — if it is authored, the threshold is wrong; if it is not, the bake is.

## Delivering

Avoid a `.` in the output folder name — a rig website reads `3.FBX` as an
extension. Use `3-fbx`.

The pack and anything derived from it are third-party content; the collection
folder is not gitignored, so say so rather than committing ~18 MB silently.

Downstream, `scripts/fbx2vmd.ts` takes these to VMD. See the memory note
[[anim2fbx-heading-and-root]] for the incident this all came from.
