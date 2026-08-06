/**
 * Prebake an FBX clip into the compact JSON clip format `animationClipsFromJson`
 * reads — for shipping a demo motion without shipping its source file.
 *
 * Usage:  npx esbuild scripts/prebake-clip.ts --bundle --platform=node --format=esm \
 *           --outfile=<tmp>/prebake.mjs && node <tmp>/prebake.mjs <in.fbx> <out.json>
 *
 * Two reductions, neither of which changes a single exported frame:
 *  - Resample to 30fps. The retarget samples the source at its own 30fps output
 *    rate, so anything denser is read and discarded at runtime.
 *  - Keep only bones that map to an MMD bone, plus every ancestor of one.
 *    Ancestors matter: an unmapped bone between two mapped ones (Character
 *    Creator's Pelvis) folds its rotation into its mapped children, and dropping
 *    it would quietly change the pose. Leaves that map to nothing — face, teeth,
 *    toe digits, twist and share helpers — carry no motion into MMD at all.
 *
 * Per-bone position tracks are dropped when they never move: the rest pose's
 * translation already says where the bone sits, and a rigid skeleton repeats it
 * on every frame.
 */
import { readFileSync, writeFileSync, statSync } from "node:fs"
import { Quat } from "reze-engine"

import { parseFbxToAnimationClips, type AnimationClip, type BoneTrack } from "../lib/fbx"
import { mapsToMmdBone, pickMotionClip } from "../lib/retarget"

const FPS = 30
const QUAT_DECIMALS = 5
const POS_DECIMALS = 4

/** Radians vs degrees is a guess on the reader's side above this magnitude. */
const PRE_POST_RADIAN_LIMIT = 2.5

const round = (v: number, d: number): number => Number(v.toFixed(d))

function slerp(a: Quat, b: Quat, t: number): [number, number, number, number] {
  let [bx, by, bz, bw] = [b.x, b.y, b.z, b.w]
  let dot = a.x * bx + a.y * by + a.z * bz + a.w * bw
  if (dot < 0) {
    bx = -bx; by = -by; bz = -bz; bw = -bw
    dot = -dot
  }
  if (dot > 0.9995) {
    const q: [number, number, number, number] = [
      a.x + (bx - a.x) * t, a.y + (by - a.y) * t, a.z + (bz - a.z) * t, a.w + (bw - a.w) * t,
    ]
    const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1
    return [q[0] / l, q[1] / l, q[2] / l, q[3] / l]
  }
  const angle = Math.acos(Math.min(1, dot))
  const s = Math.sin(angle)
  const w0 = Math.sin((1 - t) * angle) / s
  const w1 = Math.sin(t * angle) / s
  return [w0 * a.x + w1 * bx, w0 * a.y + w1 * by, w0 * a.z + w1 * bz, w0 * a.w + w1 * bw]
}

function sampleQuat(track: BoneTrack, time: number): [number, number, number, number] {
  const { times, quats } = track
  if (times.length === 0) return [0, 0, 0, 1]
  let i = times.findIndex((t) => t >= time)
  if (i === -1) {
    const q = quats[quats.length - 1]
    return [q.x, q.y, q.z, q.w]
  }
  if (i === 0 || times[i] === time) {
    const q = quats[i]
    return [q.x, q.y, q.z, q.w]
  }
  const u = (time - times[i - 1]) / (times[i] - times[i - 1])
  return slerp(quats[i - 1], quats[i], u)
}

function samplePos(times: number[], positions: [number, number, number][], time: number): [number, number, number] {
  if (times.length === 0) return [0, 0, 0]
  const i = times.findIndex((t) => t >= time)
  if (i === -1) return positions[positions.length - 1]
  if (i === 0 || times[i] === time) return positions[i]
  const u = (time - times[i - 1]) / (times[i] - times[i - 1])
  const a = positions[i - 1]
  const b = positions[i]
  return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u]
}

function clipDuration(clip: AnimationClip): number {
  if (clip.duration > 0) return clip.duration
  let max = 0
  for (const t of clip.tracks) for (const tt of t.times) if (tt > max) max = tt
  for (const p of clip.positionTracks ?? []) for (const tt of p.times) if (tt > max) max = tt
  return max
}

/** Bones that reach an MMD bone: mapped ones and every ancestor of one. */
function keptBones(clip: AnimationClip): Set<string> {
  const keep = new Set<string>()
  const hierarchy = clip.hierarchy
  for (const track of clip.tracks) {
    if (!mapsToMmdBone(track.name)) continue
    keep.add(track.name)
    let parent = hierarchy?.get(track.name)?.parent ?? null
    while (parent && !keep.has(parent)) {
      keep.add(parent)
      parent = hierarchy?.get(parent)?.parent ?? null
    }
  }
  return keep
}

function main(): void {
  const [input, output] = process.argv.slice(2)
  if (!input || !output) throw new Error("usage: prebake-clip <in.fbx> <out.json>")

  const buf = readFileSync(input)
  const clips = parseFbxToAnimationClips(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer)
  const clip = pickMotionClip(clips)
  if (!clip) throw new Error("no clips in file")

  const duration = clipDuration(clip)
  const frames = Math.max(2, Math.round(duration * FPS) + 1)
  const times = Array.from({ length: frames }, (_, i) => round(i / FPS, 4))
  const keep = keptBones(clip)

  let maxPrePost = 0
  const tracks = clip.tracks
    .filter((t) => keep.has(t.name))
    .map((t) => {
      for (const angles of [t.restPose?.preRotation, t.restPose?.postRotation]) {
        for (const a of angles ?? []) maxPrePost = Math.max(maxPrePost, Math.abs(a))
      }
      return {
        name: t.name,
        times,
        quats: times.map((time) => {
          const [x, y, z, w] = sampleQuat(t, time)
          return { x: round(x, QUAT_DECIMALS), y: round(y, QUAT_DECIMALS), z: round(z, QUAT_DECIMALS), w: round(w, QUAT_DECIMALS) }
        }),
        restPose: t.restPose
          ? {
            lclRotation: t.restPose.lclRotation.map((v) => round(v, 6)),
            lclTranslation: t.restPose.lclTranslation?.map((v) => round(v, POS_DECIMALS)) ?? null,
            preRotation: t.restPose.preRotation?.map((v) => round(v, 6)) ?? null,
            postRotation: t.restPose.postRotation?.map((v) => round(v, 6)) ?? null,
          }
          : null,
      }
    })

  // The reader treats a pre/post angle above ~2.5 as degrees; a genuine radian
  // value that large would be silently rescaled.
  if (maxPrePost > PRE_POST_RADIAN_LIMIT) {
    throw new Error(`pre/post rotation of ${maxPrePost.toFixed(3)} rad exceeds the reader's radian/degree cutoff — teach the format an explicit unit before baking this file`)
  }

  const MOVES = 1e-4
  const positionTracks = (clip.positionTracks ?? [])
    .filter((p) => {
      if (!keep.has(p.name)) return false
      const first = p.positions[0]
      return p.positions.some((q) => Math.abs(q[0] - first[0]) > MOVES || Math.abs(q[1] - first[1]) > MOVES || Math.abs(q[2] - first[2]) > MOVES)
    })
    .map((p) => ({
      name: p.name,
      times,
      positions: times.map((time) => samplePos(p.times, p.positions, time).map((v) => round(v, POS_DECIMALS))),
    }))

  const hierarchy: Record<string, { parent: string | null; children: string[] }> = {}
  for (const [name, h] of clip.hierarchy ?? []) {
    if (!keep.has(name)) continue
    hierarchy[name] = { parent: h.parent, children: h.children.filter((c) => keep.has(c)) }
  }

  writeFileSync(output, JSON.stringify({ name: clip.name, duration: round(duration, 4), tracks, positionTracks, hierarchy }))

  const sourceKeys = clip.tracks.reduce((n, t) => n + t.times.length, 0)
  console.log(
    `${input} → ${output}\n` +
    `  ${(statSync(input).size / 1e6).toFixed(2)} MB → ${(statSync(output).size / 1e6).toFixed(2)} MB\n` +
    `  bones ${clip.tracks.length} → ${tracks.length} (kept mapped + ancestors), position tracks ${clip.positionTracks?.length ?? 0} → ${positionTracks.length} (kept the ones that move)\n` +
    `  keys ${sourceKeys.toLocaleString()} → ${(tracks.length * frames).toLocaleString()} at ${FPS}fps · ${duration.toFixed(2)}s`,
  )
}

main()
