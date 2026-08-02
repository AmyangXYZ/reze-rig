import type { AnimationClip, BoneInterpolation, BoneKeyframe, IkKeyframe } from "reze-engine"
import { Quat, Vec3 } from "reze-engine"
import type { RetargetedClip } from "./retarget-core"

/**
 * RetargetedClip → the engine's AnimationClip. One VMD codepath: the engine
 * plays this clip directly (no write-then-reparse roundtrip) and
 * `model.exportVmd(name)` serializes it for download, IK frames included.
 */

/** MMD-standard linear bezier (20,20)–(107,107). Shared read-only instance. */
const LINEAR: BoneInterpolation = {
  rotation: [{ x: 20, y: 20 }, { x: 107, y: 107 }],
  translationX: [{ x: 20, y: 20 }, { x: 107, y: 107 }],
  translationY: [{ x: 20, y: 20 }, { x: 107, y: 107 }],
  translationZ: [{ x: 20, y: 20 }, { x: 107, y: 107 }],
}

/**
 * The converted motion is pure FK — every leg bone carries its rotation
 * explicitly — so all six IK chains switch off for the whole clip. VMD stores
 * this as a step: one frame-0 keyframe holds until the end.
 *
 * Exception: a clip retargeted with footIK carries 左足ＩＫ/右足ＩＫ target
 * tracks — those two chains stay LIVE so the model's own IK plants the feet
 * (heels ground at their own bind height). Toe IK and IK親 stay off either way.
 */
const IK_DISABLED_BONES = ["右足IK親", "左足IK親", "右足ＩＫ", "左足ＩＫ", "右つま先ＩＫ", "左つま先ＩＫ"]
const FOOT_IK_BONES = new Set(["右足ＩＫ", "左足ＩＫ"])

export function toEngineClip(clip: RetargetedClip, fps = 30): AnimationClip {
  const boneTracks = new Map<string, BoneKeyframe[]>()
  let frameCount = 1

  const posByName = new Map(clip.positionTracks.map((t) => [t.name, t]))

  for (const track of clip.boneTracks) {
    const pos = posByName.get(track.name)
    const frames: BoneKeyframe[] = []
    for (let i = 0; i < track.times.length; i++) {
      const frame = Math.round(track.times[i] * fps)
      const q = track.quats[i]
      const p = pos?.positions[i]
      frames.push({
        boneName: track.name,
        frame,
        rotation: new Quat(q.x, q.y, q.z, q.w),
        translation: p ? new Vec3(p.x, p.y, p.z) : new Vec3(0, 0, 0),
        interpolation: LINEAR,
      })
      if (frame + 1 > frameCount) frameCount = frame + 1
    }
    boneTracks.set(track.name, frames)
  }

  // Translation-only tracks (e.g. センター when its rotation is unmapped).
  for (const track of clip.positionTracks) {
    if (boneTracks.has(track.name)) continue
    const frames: BoneKeyframe[] = []
    for (let i = 0; i < track.times.length; i++) {
      const frame = Math.round(track.times[i] * fps)
      const p = track.positions[i]
      frames.push({
        boneName: track.name,
        frame,
        rotation: new Quat(0, 0, 0, 1),
        translation: new Vec3(p.x, p.y, p.z),
        interpolation: LINEAR,
      })
      if (frame + 1 > frameCount) frameCount = frame + 1
    }
    boneTracks.set(track.name, frames)
  }

  const hasFootIK = clip.positionTracks.some((t) => FOOT_IK_BONES.has(t.name))
  const ikTracks = new Map<string, IkKeyframe[]>()
  for (const name of IK_DISABLED_BONES) {
    if (hasFootIK && FOOT_IK_BONES.has(name)) continue
    ikTracks.set(name, [{ frame: 0, enabled: false }])
  }

  return { boneTracks, morphTracks: new Map(), ikTracks, frameCount }
}

/** Trigger a browser download of binary data. */
export function downloadArrayBuffer(data: ArrayBuffer, filename: string): void {
  const url = URL.createObjectURL(new Blob([data], { type: "application/octet-stream" }))
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
