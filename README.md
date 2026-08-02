# Reze Rig

Convert humanoid skeletal animations into MMD VMD files in the browser. Upload a motion, watch it play on a PMX model, and download the VMD — no Blender, no Maya, no plugins.

![screenshot](./screenshot.png)

Powered by [Reze-Engine](https://github.com/AmyangXYZ/reze-engine)

## How it works

The retargeter expresses each source bone's animation as a world-orientation delta from its own bind pose, aligns it onto the MMD skeleton, and writes parent-local rotations for MMD's bone hierarchy (センター / 上半身 / 左腕 / …). The calibrations that make this work across rigs happen automatically, per file:

- **Rig detection.** Mixamo's `mixamorig:*` names and UE-Mannequin / Unity Humanoid names (`pelvis`, `upperarm_l`, `clavicle_r`, …) resolve to one canonical scheme, then to MMD's Japanese bone names. Bone hierarchy comes from the FBX's own connections.
- **Segment alignment for any bind pose.** For every mapped bone, the same anatomical segment (bone → its mapped child) is measured on both skeletons' bind poses, and a shortest-arc swing maps one onto the other. T-pose, A-pose, and relaxed binds all convert the same way — arms, legs, feet, spine, and fingers included.
- **The target model is measured, not assumed.** Bone positions are read from the loaded PMX at bind, so alignment and proportions adapt to whatever model is in the viewport. Upload your own model as a zip (a picker appears when the zip holds several `.pmx` files) and the loaded motion re-retargets to it on the spot.
- **Translation scale from the skeletons themselves.** The hip-height ratio between source and target scales root motion — centimeter, meter, and inch exports all land correctly, including Mixamo characters with different rig sizes.
- **Correct IK data.** The exported VMD carries per-chain IK frames disabling the six leg chains, since the converted motion drives every leg bone directly.
- **Bind-reference override for broken exports.** Some Unity per-pose clips embed the first animation frame as their rest pose instead of the real bind. When such a clip is detected, the canonical bind from an idle clip stands in, so "delta from rest" references the right baseline.

Playback preview and the downloaded file share one code path: the converted clip loads into the engine's animation system directly and `exportVmd` serializes exactly what you watched.

## Supported source rigs

- **Mixamo** (T-pose, `mixamorig:` prefixed bones)
- **UE-Mannequin / Unity Humanoid** (A-pose, `pelvis` / `upperarm_l` / `thigh_l` style bones)

Other humanoid rigs (Maya HumanIK, Daz, VRoid, custom) need their bone names added to the canonicalization table — the retarget math itself is rig-agnostic.

The Elden Ring HKX → VMD pipeline lives on the [`hkx`](../../tree/hkx) branch.
