# Reze Rig

Convert humanoid skeletal animations into MMD VMD files in the browser. Upload a motion, watch it play on a PMX model, and download the VMD.

One piece of the **Reze MMD family**, covering the whole MMD workflow on the web:

|                                                         |                                                                                |
| ------------------------------------------------------- | ------------------------------------------------------------------------------ |
| [reze-engine](https://github.com/AmyangXYZ/reze-engine) | The WebGPU foundation — anime-character rendering and physics, dependency-free |
| [reze-design](https://github.com/AmyangXYZ/reze-design) | Scene design, rendering and sharing platform                                   |
| [reze-studio](https://github.com/AmyangXYZ/reze-studio) | Animation editing on a professional timeline and curve editor                  |
| [MiKaPo](https://github.com/AmyangXYZ/MiKaPo)           | Real-time motion capture in the browser, exporting straight to VMD             |
| **reze-rig**                                            | This repo — retarget FBX animations to MMD VMD format                          |

![screenshot](./screenshot.png)

## How it works

The retargeter expresses each source bone's animation as a world-orientation delta from its own bind pose, aligns it onto the MMD skeleton, and writes parent-local rotations for MMD's bone hierarchy (センター / 上半身 / 左腕 / …). The calibrations that make this work across rigs happen automatically, per file:

- **Rig detection.** Mixamo (`mixamorig:*`), UE-Mannequin / Unity Humanoid (`pelvis`, `upperarm_l`, `clavicle_r`, …) and 3ds Max Biped (`Bip001 L Thigh`, `Bip01_Spine1`, …) names resolve to one canonical scheme, then to MMD's Japanese bone names. Bone hierarchy comes from the FBX's own connections.
- **Files that arrive rotated.** A source authored Z-up, or one carrying its axis conversion on a node above the animated bones, is measured from its own bind pose and stood upright before anything else runs — so a file that would otherwise convert face-down converts exactly as the same file upright would.
- **The bind pose comes from the skeleton, not from the export.** FBX records the true bind in the skin (`TransformLink`) or in a `BindPose` node, and some exporters write the current frame as the rest pose instead — which collapses alignment and throws the translation scale out with it. The real bind is read wherever a file carries one; where it doesn't, dropping the pack's T-pose file supplies it, and the source panel says so rather than converting silently.
- **Segment alignment for any bind pose.** For every mapped bone, the same anatomical segment (bone → its mapped child) is measured on both skeletons' bind poses, and a shortest-arc swing maps one onto the other. T-pose, A-pose, and relaxed binds all convert the same way — arms, legs, feet, spine, and fingers included.
- **The target model is measured, not assumed.** Bone positions are read from the loaded PMX at bind, so alignment and proportions adapt to whatever model is in the viewport. Upload your own model as a zip (a picker appears when the zip holds several `.pmx` files) and the loaded motion re-retargets to it on the spot.
- **Translation scale from the skeletons themselves.** The hip-height ratio between source and target scales root motion — centimeter, meter, and inch exports all land correctly, including Mixamo characters with different rig sizes.
- **Correct IK data.** The exported VMD carries per-chain IK frames disabling the six leg chains, since the converted motion drives every leg bone directly.
- **Bind-reference override for broken exports.** Some Unity per-pose clips embed the first animation frame as their rest pose instead of the real bind. When such a clip is detected, the canonical bind from an idle clip stands in, so "delta from rest" references the right baseline.

Playback preview and the downloaded file share one code path: the converted clip loads into the engine's animation system directly and `exportVmd` serializes exactly what you watched. **In Place** strips horizontal root motion the way Mixamo's option does, keeping the vertical so jumps and crouches survive.

## Supported source rigs

| Rig                           | Bone names                             | Status                 |
| ----------------------------- | -------------------------------------- | ---------------------- |
| Mixamo                        | `mixamorig:Hips`, `mixamorig:LeftArm`  | Tested                 |
| UE-Mannequin / Unity Humanoid | `pelvis`, `upperarm_l`, `thigh_l`      | Tested                 |
| Reallusion Character Creator  | `CC_Base_Hip`, `CC_Base_L_Upperarm`    | Mapped, lightly tested |
| 3ds Max Biped                 | `Bip001 Pelvis`, `Bip01 L Thigh`       | Mapped, lightly tested |

Any other humanoid rig is worth a try — the retarget math is rig-agnostic, and the naming table is the only part that is rig-specific. The panel in the corner shows the skeleton as parsed, with the rig profile, how many bones mapped and the scale that was measured; bones that mapped draw bright and unmapped ones stay dim. If a rig converts badly, or names go unmapped, open an issue with that line and the file if you can share it.

## Batch conversion

`scripts/fbx2vmd.ts` converts folders of FBX without a browser:

```bash
npx esbuild scripts/fbx2vmd.ts --bundle --platform=node --format=esm --outfile=/tmp/fbx2vmd.mjs
node /tmp/fbx2vmd.mjs <files-or-dirs...> [options]
```

Directories are scanned recursively; each clip writes `<out>/<basename>.vmd`.

| Option                | |
| --------------------- | ------------------------------------------------------------------------ |
| `--out <dir>`         | Output directory                                                         |
| `--target-pmx <file>` | Measure this model as the retarget target                                |
| `--in-place`          | Strip horizontal root motion                                             |
| `--foot-ik`           | Export foot-IK targets so the model's own IK plants the feet             |
| `--bind-ref <file>`   | Anchor per-pose exports to this clip's bind (defaults to an `Idle.fbx` among the inputs) |
| `--no-bind-ref`       | Use each clip's own rest pose                                            |
