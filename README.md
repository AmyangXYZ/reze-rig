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

Each source bone's animation is expressed as a world-orientation delta from its own bind pose, aligned onto the MMD skeleton, and written as parent-local rotations for MMD's hierarchy (センター / 上半身 / 左腕 / …). Every calibration below happens automatically, per file — there is nothing to configure.

- **Rig detection.** Mixamo, UE-Mannequin / Unity Humanoid, 3ds Max Biped and Character Creator names resolve to MMD's Japanese bone names, with the hierarchy taken from the file's own connections.
- **Any bind pose.** Each bone is aligned by measuring the same anatomical segment on both skeletons, so T-pose, A-pose and relaxed binds convert alike — arms, legs, feet, spine and fingers.
- **The true bind, wherever it lives.** FBX records it in the skin or a `BindPose` node; exporters that overwrite the rest pose with the current frame no longer break the conversion. A file authored Z-up is stood upright first. When nothing supplies a bind, the tool says so instead of converting silently.
- **The target model is measured, not assumed.** Bone positions come from the loaded PMX, so alignment, proportions and translation scale adapt to whatever model is in the viewport — centimetre, metre and inch exports all land correctly. Upload your own model as a zip and the motion re-retargets to it on the spot.
- **Feet are placed, not derived.** The VMD drives 左足ＩＫ / 右足ＩＫ from the source's own foot positions, so a proportion difference between the two skeletons doesn't turn into sliding, and the motion adapts to other models.
- **In Place** removes horizontal travel while keeping the vertical, so jumps and crouches survive.

Preview and download share one code path: the converted clip plays in the engine directly, and `exportVmd` serializes exactly what you watched.

## Supported source rigs

| Rig                           | Bone names                             | Status                 |
| ----------------------------- | -------------------------------------- | ---------------------- |
| Mixamo                        | `mixamorig:Hips`, `mixamorig:LeftArm`  | Tested                 |
| UE-Mannequin / Unity Humanoid | `pelvis`, `upperarm_l`, `thigh_l`      | Tested                 |
| Reallusion Character Creator  | `CC_Base_Hip`, `CC_Base_L_Upperarm`    | Mapped, lightly tested |
| 3ds Max Biped                 | `Bip001 Pelvis`, `Bip01 L Thigh`       | Mapped, lightly tested |

Any other humanoid rig is worth a try: the retarget is rig-agnostic and only the naming table is rig-specific. The corner panel shows the skeleton as parsed — rig profile, bones mapped, measured scale, with unmapped bones dimmed. If a rig converts badly, open an issue with that line and the file if you can share it.

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
| `--no-foot-ik`        | Drive the legs by FK instead of exporting foot-IK targets                |
| `--bind-ref <file>`   | Anchor per-pose exports to this clip's bind (defaults to an `Idle.fbx` among the inputs) |
| `--no-bind-ref`       | Use each clip's own rest pose                                            |

`scripts/regression.ts` pins every verified conversion — profile, bone counts, scale and a checksum over all exported keys — so a change to the retarget can't quietly alter motions that already work.
