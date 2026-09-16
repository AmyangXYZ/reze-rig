# fbx-inspect

Reads what a clip actually does, out of the exported file.

```sh
./fbx-inspect.sh out/*.fbx
./fbx-inspect.sh out/*.fbx --check --facing 0
```

Reports duration, key count, rig profile, how many bones map to the MMD
skeleton, how the body faces at frame 0, how far it turns across the clip, and
the largest single-frame rotation on any bone. `--check` asserts those and exits
non-zero instead of printing, so a bake script can refuse to install a bad file.

## Why

`anim2fbx` once reported

```
[bake] SPIN_01_Elegant: faced 105.0 deg at frame 0 — straightened to 0.0 deg
```

and wrote a file whose hips curves were byte-identical to the uncorrected bake.
The correction was real and correctly computed; it landed on the scene root,
which rigging services drop along with everything else above the skeleton. A
producer's log says what it meant to do. This says what is in the file.

## Options

| Flag | Default | |
|---|---|---|
| `--check` | off | assert instead of print; exit 1 on any problem |
| `--facing <deg>` | — | required frame-0 hips yaw |
| `--facing-tol <deg>` | 2 | tolerance for the above |
| `--max-step <deg>` | 25 | largest tolerated per-frame rotation, body bones |
| `--max-step-finger <deg>` | 90 | the same, for fingers |
| `--quiet` | off | problems only |

Fingers get their own limit because a performance flicks a hand open across
nearly the whole muscle range inside one frame, while the same jump on a spine
or a leg is a sign flip or a dropped key. When a threshold fires, check the
source clip's own curve before loosening it.

Built on `lib/fbx` and `lib/retarget`, so it sees clips exactly as the retarget
pipeline does.
