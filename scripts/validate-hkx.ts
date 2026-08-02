/**
 * Numeric validation harness for the HKX→MMD retarget (node-side, no browser).
 *
 * Usage:  npx esbuild scripts/validate-hkx.ts --bundle --platform=node --format=esm \
 *           --outfile=<tmp>/validate-hkx.mjs && node <tmp>/validate-hkx.mjs [animId...]
 *
 * What it checks — the things the Babylon wireframe can't quantify:
 *  1. Chain structure: for every mapped bone, the retarget's assumed nearest mapped
 *     MMD ancestor vs the REAL one in the PMX hierarchy (public/mmd-skeleton.json).
 *     A mismatch means the engine composes rotations differently than the VMD assumes.
 *  2. Translation content: which ER root bones (Master / Root) actually move in the
 *     clip, and how much of that motion the exported 全ての親 track captures.
 *  3. Coverage: animated ER tracks that map to nothing in MMD (motion silently lost).
 *  4. Sanity: NaN / denormalized quaternions in the output clip.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { loadHkxJson, type HkxAnimation } from "../lib/hkx-loader"
import {
  createRetargetContext,
  retargetHkxClipWithCtx,
  ER_BONE_MAP,
  type MmdSkeletonDump,
} from "../lib/hkx-retarget"

const ROOT = process.cwd()
const HKX_DIR = join(ROOT, "public", "hkx")

/* ---------------------------------------------------------------- load + merge */

type AnyJson = Record<string, unknown>

function findContainer(json: AnyJson): AnyJson | null {
  const variants = (json as { namedVariants?: { variant?: AnyJson }[] }).namedVariants ?? []
  for (const entry of variants) {
    const v = entry?.variant
    if (!v) continue
    if (Array.isArray(v.skeletons) || Array.isArray(v.animations) || Array.isArray(v.bindings)) return v
  }
  return null
}

/** Same splice the debug page does: animation JSONs ship without skeletons. */
function mergeSkeleton(animJson: AnyJson, skeletonJson: AnyJson): AnyJson {
  const animContainer = findContainer(animJson)
  const skeletonContainer = findContainer(skeletonJson)
  if (!animContainer || !skeletonContainer) return animJson
  if ((animContainer.skeletons as unknown[] | undefined)?.length) return animJson
  const variants = (animJson as { namedVariants?: { variant?: AnyJson }[] }).namedVariants ?? []
  const idx = variants.findIndex((e) => e?.variant === animContainer)
  if (idx < 0) return animJson
  return {
    ...animJson,
    namedVariants: [
      ...variants.slice(0, idx),
      { ...(variants[idx] as AnyJson), variant: { ...animContainer, skeletons: skeletonContainer.skeletons } },
      ...variants.slice(idx + 1),
    ],
  }
}

/* ---------------------------------------------------------------- small math */

type Q4 = [number, number, number, number]
type V3 = [number, number, number]

function qMul(a: Q4, b: Q4): Q4 {
  const [ax, ay, az, aw] = a
  const [bx, by, bz, bw] = b
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ]
}

function qRot(q: Q4, v: V3): V3 {
  const t = qMul(q, [v[0], v[1], v[2], 0])
  const r = qMul(t, [-q[0], -q[1], -q[2], q[3]])
  return [r[0], r[1], r[2]]
}

/** FK world positions for one frame (or the reference pose when frameIdx < 0). */
function fkPositions(hkx: HkxAnimation, frameIdx: number): V3[] {
  const n = hkx.bones.length
  const boneToTrack = new Int32Array(n).fill(-1)
  for (let t = 0; t < hkx.trackToBone.length; t++) boneToTrack[hkx.trackToBone[t]] = t
  const frame = frameIdx >= 0 ? hkx.frames[frameIdx] : null

  const wRot: Q4[] = new Array(n)
  const wPos: V3[] = new Array(n)
  for (let i = 0; i < n; i++) {
    const ref = hkx.bones[i].referencePose
    const t = boneToTrack[i]
    const src = frame && t >= 0 ? frame[t] : ref
    const lr: Q4 = [src.rotation[0], src.rotation[1], src.rotation[2], src.rotation[3]]
    const lt: V3 = [src.translation[0], src.translation[1], src.translation[2]]
    const pi = hkx.bones[i].parentIndex
    if (pi < 0) {
      wRot[i] = lr
      wPos[i] = lt
    } else {
      wRot[i] = qMul(wRot[pi], lr)
      const r = qRot(wRot[pi], lt)
      wPos[i] = [r[0] + wPos[pi][0], r[1] + wPos[pi][1], r[2] + wPos[pi][2]]
    }
  }
  return wPos
}

/* ---------------------------------------------------------------- checks */

function checkChainStructure(mmdSkel: MmdSkeletonDump): string[] {
  const issues: string[] = []
  const byName = new Map(mmdSkel.bones.map((b) => [b.name, b]))
  const mapped = new Set(Object.values(ER_BONE_MAP))

  // The retarget's assumed parent, reproduced from hkx-retarget's rules: nearest
  // mapped ancestor in the ER tree + the 下半身 bypass overrides. We reproduce it
  // via the ER hierarchy of the skeleton file at call time, so here we only need
  // the REAL side: nearest mapped ancestor in the PMX tree.
  const realMappedAncestor = (name: string): string | null => {
    let b = byName.get(name)
    if (!b) return null
    while (b && b.parentIndex >= 0) {
      const p: MmdSkeletonDump["bones"][number] | undefined = mmdSkel.bones[b.parentIndex]
      if (!p) return null
      if (mapped.has(p.name)) return p.name
      b = p
    }
    return null
  }

  for (const mmdName of mapped) {
    if (!byName.has(mmdName)) {
      issues.push(`MISSING in PMX: ${mmdName}`)
      continue
    }
    const real = realMappedAncestor(mmdName)
    issues.push(`chain ${mmdName} ← real mapped ancestor: ${real ?? "(none)"}`)
  }
  return issues
}

function main(): void {
  const args = process.argv.slice(2)
  const animIds = args.length > 0 ? args : ["a000_002100"]

  const skeletonJson = JSON.parse(readFileSync(join(HKX_DIR, "skeleton.json"), "utf8")) as AnyJson
  const mmdSkel = JSON.parse(readFileSync(join(ROOT, "public", "mmd-skeleton.json"), "utf8")) as MmdSkeletonDump

  // ---- one-time structural report -------------------------------------------
  console.log("=== MMD chain structure (real PMX nearest mapped ancestor per mapped bone) ===")
  for (const line of checkChainStructure(mmdSkel)) console.log("  " + line)
  console.log()

  for (const id of animIds) {
    const animJson = JSON.parse(readFileSync(join(HKX_DIR, `${id}.json`), "utf8")) as AnyJson
    const hkx = loadHkxJson(mergeSkeleton(animJson, skeletonJson))
    const ctx = createRetargetContext(hkx, { mmdSkeleton: mmdSkel })
    const clip = retargetHkxClipWithCtx(ctx)

    console.log(`=== ${id} · ${hkx.duration.toFixed(2)}s · ${hkx.numFrames}f@${hkx.fps} ===`)

    // ---- retarget parent assumptions (needs the ER skeleton, hence per-clip) --
    const assumed = new Map(ctx.core.mappedBones.map((b) => [b.mmdName, b.parentMmdName]))
    console.log("  assumed parents: " +
      [...assumed.entries()].filter(([, p]) => p !== null).slice(0, 6).map(([b, p]) => `${b}←${p}`).join("  ") + "  …")
    const plainDelta = ctx.core.mappedBones.filter((b) => !b.frameAlign)
    const why = plainDelta.map((b) =>
      b.alignDot === null ? `${b.mmdName}(no segment)` : `${b.mmdName}(dot=${b.alignDot.toFixed(2)})`,
    )
    console.log(`  plain-delta bones (no absolute alignment, ${plainDelta.length}): ${why.join(", ") || "none"}`)

    // ---- translation content --------------------------------------------------
    const nameToIdx = new Map(hkx.bones.map((b, i) => [b.name, i]))
    const bindPos = fkPositions(hkx, -1)
    const watch = ["Master", "Root", "Pelvis"].filter((n) => nameToIdx.has(n))
    const ranges = new Map<string, { min: V3; max: V3 }>(
      watch.map((n) => [n, { min: [1e9, 1e9, 1e9] as V3, max: [-1e9, -1e9, -1e9] as V3 }]),
    )
    const step = Math.max(1, Math.floor(hkx.numFrames / 120))
    for (let f = 0; f < hkx.numFrames; f += step) {
      const wp = fkPositions(hkx, f)
      for (const n of watch) {
        const i = nameToIdx.get(n) as number
        const d: V3 = [wp[i][0] - bindPos[i][0], wp[i][1] - bindPos[i][1], wp[i][2] - bindPos[i][2]]
        const r = ranges.get(n) as { min: V3; max: V3 }
        for (let k = 0; k < 3; k++) {
          if (d[k] < r.min[k]) r.min[k] = d[k]
          if (d[k] > r.max[k]) r.max[k] = d[k]
        }
      }
    }
    console.log("  world-space motion range from bind (meters, sampled):")
    for (const n of watch) {
      const r = ranges.get(n) as { min: V3; max: V3 }
      const span = r.max.map((v, k) => v - r.min[k])
      console.log(
        `    ${n.padEnd(7)} span x=${span[0].toFixed(3)} y=${span[1].toFixed(3)} z=${span[2].toFixed(3)}`,
      )
    }
    if (clip.positionTracks.length === 0) console.log("    exported position tracks: NONE")
    for (const posTrack of clip.positionTracks) {
      const min: V3 = [1e9, 1e9, 1e9]
      const max: V3 = [-1e9, -1e9, -1e9]
      for (const p of posTrack.positions) {
        const v: V3 = [p.x, p.y, p.z]
        for (let k = 0; k < 3; k++) {
          if (v[k] < min[k]) min[k] = v[k]
          if (v[k] > max[k]) max[k] = v[k]
        }
      }
      console.log(
        `    exported ${posTrack.name} (MMD units, source=${posTrack.originalName}) span x=${(max[0] - min[0]).toFixed(2)} y=${(max[1] - min[1]).toFixed(2)} z=${(max[2] - min[2]).toFixed(2)}`,
      )
    }

    // ---- coverage -------------------------------------------------------------
    const animatedUnmapped: string[] = []
    for (let t = 0; t < hkx.trackToBone.length; t++) {
      const bone = hkx.bones[hkx.trackToBone[t]]
      if (ER_BONE_MAP[bone.name]) continue
      // A track is "animated" if any frame differs meaningfully from the ref pose.
      const ref = bone.referencePose
      let moves = false
      for (let f = 0; f < hkx.numFrames && !moves; f += step) {
        const fr = hkx.frames[f][t]
        const dq =
          Math.abs(fr.rotation[0] - ref.rotation[0]) +
          Math.abs(fr.rotation[1] - ref.rotation[1]) +
          Math.abs(fr.rotation[2] - ref.rotation[2]) +
          Math.abs(fr.rotation[3] - ref.rotation[3])
        if (dq > 0.01) moves = true
      }
      if (moves) animatedUnmapped.push(bone.name)
    }
    console.log(`  animated-but-unmapped ER tracks (${animatedUnmapped.length}): ${animatedUnmapped.join(", ") || "none"}`)

    // ---- spine/head alignment diagnostics ------------------------------------
    // Constant offsets here render as a permanent lean/tilt of the upper body.
    console.log("  spine chain diagnostics:")
    for (const name of ["上半身", "上半身2", "首", "頭"]) {
      const b = ctx.core.mappedBones.find((m) => m.mmdName === name)
      if (!b) continue
      if (b.frameAlign) {
        const [x, y, z, w] = b.frameAlign
        const ang = (2 * Math.acos(Math.min(1, Math.abs(w))) * 180) / Math.PI
        const s = Math.sqrt(Math.max(1e-12, 1 - w * w))
        console.log(
          `    ${name} align offset ${ang.toFixed(1)}° axis [${(x / s).toFixed(2)}, ${(y / s).toFixed(2)}, ${(z / s).toFixed(2)}] dot=${b.alignDot?.toFixed(3)}`,
        )
      } else {
        console.log(`    ${name} plain delta (alignDot=${b.alignDot?.toFixed(3) ?? "n/a"})`)
      }
    }
    // Head world delta decomposition per sampled frame: how much of it is roll
    // about the view axis (frontal tilt) vs total. Constant nonzero roll while
    // the wireframe looks straight = bone roll invisible to the joint plot.
    {
      const head = ctx.core.mappedBones.find((m) => m.mmdName === "頭")
      if (head) {
        const bTrack: number = ctx.boneToTrack[head.srcIdx]
        let maxAng = 0
        let sumZ = 0
        let cnt = 0
        const xs: number[] = []
        const ys: number[] = []
        const zs: number[] = []
        for (let f = 0; f < hkx.numFrames; f += step) {
          // Build world rotations for this frame via FK (reuse fkPositions math is
          // positions-only, so do a local rotation FK here).
          const nB = hkx.bones.length
          const wRot: Q4[] = new Array(nB)
          for (let i = 0; i < nB; i++) {
            const t = ctx.boneToTrack[i]
            const src = t >= 0 ? hkx.frames[f][t] : hkx.bones[i].referencePose
            const lr: Q4 = [src.rotation[0], src.rotation[1], src.rotation[2], src.rotation[3]]
            const pi = hkx.bones[i].parentIndex
            wRot[i] = pi < 0 ? lr : qMul(wRot[pi], lr)
          }
          const bind = ctx.core.bindWorldRot[head.srcIdx] as Q4
          let delta = qMul(wRot[head.srcIdx], [-bind[0], -bind[1], -bind[2], bind[3]])
          if (delta[3] < 0) delta = [-delta[0], -delta[1], -delta[2], -delta[3]]
          const ang = (2 * Math.acos(Math.min(1, Math.abs(delta[3]))) * 180) / Math.PI
          if (ang > maxAng) maxAng = ang
          xs.push(delta[0]); ys.push(delta[1]); zs.push(delta[2])
          sumZ += delta[2]
          cnt++
        }
        const med = (a: number[]) => [...a].sort((p, q) => p - q)[Math.floor(a.length / 2)] ?? 0
        console.log(
          `    頭 Δ over clip: max ${maxAng.toFixed(1)}°, median [${med(xs).toFixed(3)}, ${med(ys).toFixed(3)}, ${med(zs).toFixed(3)}] mean z ${(sumZ / Math.max(1, cnt)).toFixed(3)} (track=${bTrack})`,
        )
      }
    }

    // ---- sanity ---------------------------------------------------------------
    let nan = 0
    let denorm = 0
    for (const tr of clip.boneTracks) {
      for (const q of tr.quats) {
        const l = Math.sqrt(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w)
        if (Number.isNaN(l)) nan++
        else if (Math.abs(l - 1) > 1e-3) denorm++
      }
    }
    console.log(`  sanity: boneTracks=${clip.boneTracks.length} NaN=${nan} denormalized=${denorm}`)
    console.log()
  }
}

main()
