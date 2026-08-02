/**
 * Numeric validation harness for the FBX→MMD retarget (node-side, no browser).
 *
 * Usage:  npx esbuild scripts/validate-fbx.ts --bundle --platform=node --format=esm \
 *           --outfile=<tmp>/validate-fbx.mjs && node <tmp>/validate-fbx.mjs [file.fbx...]
 *
 * Target positions come from public/mmd-skeleton.json — directions are valid for
 * alignment; the absolute scale of that dump is odd, so the auto position scale
 * printed here is NOT what the browser (live-model measurement) will use.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { parseFbxToAnimationClips } from "../lib/fbx"
import { buildBindReferenceFromClip, retargetClips } from "../lib/retarget"

/** Shape of public/mmd-skeleton.json (a bone-position dump of an MMD model). */
interface MmdSkeletonDump {
  bones: { name: string; worldPosition: number[] }[]
}

const ROOT = process.cwd()

function main(): void {
  const args = process.argv.slice(2)
  const files = args.length > 0 ? args : [join(ROOT, "public", "fbx", "Rumba Dancing.fbx")]

  const mmdSkel = JSON.parse(readFileSync(join(ROOT, "public", "mmd-skeleton.json"), "utf8")) as MmdSkeletonDump
  const targetPositions: Record<string, [number, number, number]> = {}
  for (const b of mmdSkel.bones) {
    targetPositions[b.name] = [b.worldPosition[0], b.worldPosition[1], b.worldPosition[2]]
  }

  // Same bind reference the page preloads: Idle.fbx anchors Unity/UE per-pose
  // exports whose embedded "rest" is a mid-cycle stride snapshot.
  let bindReference: ReturnType<typeof buildBindReferenceFromClip> | null = null
  try {
    const idle = readFileSync(join(ROOT, "public", "fbx", "Idle.fbx"))
    const idleClips = parseFbxToAnimationClips(idle.buffer.slice(idle.byteOffset, idle.byteOffset + idle.byteLength))
    if (idleClips[0]) bindReference = buildBindReferenceFromClip(idleClips[0])
  } catch {
    // no Idle.fbx — UE clips will use their embedded rest
  }

  for (const file of files) {
    const buf = readFileSync(file)
    const clips = parseFbxToAnimationClips(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
    console.log(`=== ${file} · ${clips.length} clip(s) ===`)

    const retargeted = retargetClips(clips, { targetPositions, bindReference })
    for (const clip of retargeted) {
      let nan = 0
      let denorm = 0
      let maxAngle = 0
      const perTrackMax: [string, number][] = []
      for (const tr of clip.boneTracks) {
        let trackMax = 0
        for (const q of tr.quats) {
          const l = Math.sqrt(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w)
          if (Number.isNaN(l)) nan++
          else if (Math.abs(l - 1) > 1e-3) denorm++
          const ang = (2 * Math.acos(Math.min(1, Math.abs(q.w))) * 180) / Math.PI
          if (ang > trackMax) trackMax = ang
        }
        perTrackMax.push([tr.name, trackMax])
        if (trackMax > maxAngle) maxAngle = trackMax
      }
      perTrackMax.sort((a, b) => b[1] - a[1])
      console.log(
        "  largest local angles: " +
          perTrackMax.slice(0, 6).map(([n, a]) => `${n}=${a.toFixed(0)}°`).join("  "),
      )
      const pos = clip.positionTracks.map((t) => {
        const min = [1e9, 1e9, 1e9]
        const max = [-1e9, -1e9, -1e9]
        for (const p of t.positions) {
          const v = [p.x, p.y, p.z]
          for (let k = 0; k < 3; k++) {
            if (v[k] < min[k]) min[k] = v[k]
            if (v[k] > max[k]) max[k] = v[k]
          }
        }
        const f0 = t.positions[0]
        return (
          `${t.name}(src=${t.originalName}) span [${(max[0] - min[0]).toFixed(2)}, ${(max[1] - min[1]).toFixed(2)}, ${(max[2] - min[2]).toFixed(2)}]` +
          ` frame0 [${f0.x.toFixed(2)}, ${f0.y.toFixed(2)}, ${f0.z.toFixed(2)}]`
        )
      })
      console.log(
        `  "${clip.name}" ${clip.duration.toFixed(2)}s: ${clip.boneTracks.length} rot tracks, ` +
          `max local angle ${maxAngle.toFixed(1)}°, NaN=${nan} denorm=${denorm}`,
      )
      for (const p of pos) console.log(`    ${p}`)
    }
    console.log()
  }
}

main()
