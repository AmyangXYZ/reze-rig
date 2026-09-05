import { Quat, Vec3, VMDLoader } from "reze-engine"
import type { AnimationClip, BoneInterpolation, BoneKeyframe, IkKeyframe } from "reze-engine"
import { groundClip } from "./retarget"
import type { RetargetedClip, V3 } from "./retarget-core"

/**
 * Stand an existing VMD on the loaded model's floor.
 *
 * Motion capture lands feet by solving joint angles against the performer's
 * proportions, so on a model built differently they sink, float and skate — the
 * same three faults the FBX conversion has, arriving in a file that has already
 * been converted. The correction is the same one, so this samples the VMD into
 * the shape `groundClip` works on and hands it over.
 *
 * ONLY センター and the two 足ＩＫ tracks are rewritten. Every other bone leaves
 * with the keyframes and the interpolation curves it arrived with, because
 * nothing about the rest of the body is being corrected and resampling it would
 * throw away the author's easing to no purpose.
 */

/** MMD-standard linear bezier — what the rewritten tracks are keyed with. */
const LINEAR: BoneInterpolation = {
  rotation: [{ x: 20, y: 20 }, { x: 107, y: 107 }],
  translationX: [{ x: 20, y: 20 }, { x: 107, y: 107 }],
  translationY: [{ x: 20, y: 20 }, { x: 107, y: 107 }],
  translationZ: [{ x: 20, y: 20 }, { x: 107, y: 107 }],
}

const REWRITTEN = new Set(["センター", "左足ＩＫ", "右足ＩＫ"])

/** The chain `groundClip` walks, plus the tracks it reads and replaces. */
const NEEDED_ROTATIONS = ["下半身", "左足", "左ひざ", "左足首", "右足", "右ひざ", "右足首"]

export interface VmdImproveResult {
  clip: AnimationClip
  frameCount: number
  /** Bones the file carried. */
  boneCount: number
  /** How far the body had to rise, at its largest. 0 = nothing was sinking. */
  maxLift: number
  /** Absent from the source and synthesised here, so the model gains foot IK. */
  addedFootIK: boolean
}

/** Sample a bone's sparse keys at every frame. Linear between keys, held past
 *  the ends — exact for the dense per-frame keys capture and this tool produce. */
function sampleFrames<T>(
  keys: { frame: number; value: T }[],
  frameCount: number,
  blend: (a: T, b: T, t: number) => T,
): T[] {
  const out: T[] = []
  let k = 0
  for (let f = 0; f < frameCount; f++) {
    while (k + 1 < keys.length && keys[k + 1].frame <= f) k++
    const a = keys[k]
    const b = keys[k + 1]
    if (!b || f <= a.frame) out.push(a.value)
    else out.push(blend(a.value, b.value, (f - a.frame) / (b.frame - a.frame)))
  }
  return out
}

const lerpVec = (a: Vec3, b: Vec3, t: number) =>
  new Vec3(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t)

export function improveVmd(buffer: ArrayBuffer, targetPositions: Record<string, V3>): VmdImproveResult {
  const parsed = VMDLoader.loadFromBuffer(buffer)
  const frames = parsed.flatMap((k) => k.boneFrames)
  if (frames.length === 0) throw new Error("This VMD carries no bone motion.")

  const byBone = new Map<string, typeof frames>()
  for (const f of frames) {
    const list = byBone.get(f.boneName)
    if (list) list.push(f)
    else byBone.set(f.boneName, [f])
  }
  for (const list of byBone.values()) list.sort((a, b) => a.frame - b.frame)
  const frameCount = Math.max(...frames.map((f) => f.frame)) + 1

  // Sample into the shape groundClip reads.
  const boneTracks = NEEDED_ROTATIONS.flatMap((name) => {
    const keys = byBone.get(name)
    if (!keys) return []
    const quats = sampleFrames(
      keys.map((k) => ({ frame: k.frame, value: k.rotation })),
      frameCount,
      Quat.slerp,
    )
    return [{ name, originalName: name, times: quats.map((_, i) => i / 30), quats }]
  })

  const positionTrack = (name: string) => {
    const keys = byBone.get(name)
    const positions = keys
      ? sampleFrames(keys.map((k) => ({ frame: k.frame, value: k.translation })), frameCount, lerpVec)
      : Array.from({ length: frameCount }, () => new Vec3(0, 0, 0))
    return { name, originalName: name, times: positions.map((_, i) => i / 30), positions }
  }
  const addedFootIK = !byBone.has("左足ＩＫ") && !byBone.has("右足ＩＫ")
  const sampled: RetargetedClip = {
    name: "vmd",
    duration: frameCount / 30,
    fps: 30,
    boneTracks,
    positionTracks: [...REWRITTEN].map(positionTrack),
  }

  const grounded = groundClip(sampled, targetPositions)
  const before = new Map(sampled.positionTracks.map((t) => [t.name, t.positions]))
  const center = grounded.positionTracks.find((t) => t.name === "センター")
  const maxLift = center
    ? Math.max(...center.positions.map((p, i) => p.y - (before.get("センター")?.[i].y ?? 0)))
    : 0

  // Everything the correction did not touch leaves exactly as it arrived.
  const out = new Map<string, BoneKeyframe[]>()
  for (const [name, keys] of byBone) {
    if (REWRITTEN.has(name)) continue
    out.set(name, keys.map((k) => ({
      boneName: name,
      frame: k.frame,
      rotation: k.rotation,
      translation: k.translation,
      interpolation: LINEAR,
    })))
  }
  for (const track of grounded.positionTracks) {
    const rot = byBone.get(track.name)
    const rotAt = rot
      ? sampleFrames(rot.map((k) => ({ frame: k.frame, value: k.rotation })), frameCount, Quat.slerp)
      : null
    out.set(track.name, track.positions.map((p, f) => ({
      boneName: track.name,
      frame: f,
      rotation: rotAt ? rotAt[f] : new Quat(0, 0, 0, 1),
      translation: p,
      interpolation: LINEAR,
    })))
  }

  // The corrected targets are only obeyed if the chains are live. Whatever the
  // source said about 足ＩＫ, it is being driven now.
  const ikTracks = new Map<string, IkKeyframe[]>()
  for (const f of VMDLoader.loadIkFromBuffer(buffer)) {
    for (const s of f.states) {
      if (s.boneName === "左足ＩＫ" || s.boneName === "右足ＩＫ") continue
      const list = ikTracks.get(s.boneName) ?? []
      list.push({ frame: f.frame, enabled: s.enabled })
      ikTracks.set(s.boneName, list)
    }
  }
  ikTracks.set("左足ＩＫ", [{ frame: 0, enabled: true }])
  ikTracks.set("右足ＩＫ", [{ frame: 0, enabled: true }])

  return {
    clip: { boneTracks: out, morphTracks: new Map(), ikTracks, frameCount },
    frameCount,
    boneCount: byBone.size,
    maxLift,
    addedFootIK,
  }
}
