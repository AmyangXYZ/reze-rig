import * as THREE from "three"

export interface AnimData {
  bones: { name: string; parentIndex: number }[]
  refPose: { translation: number[]; rotation: number[]; scale: number[] }[]
  trackToBone: number[]
  frames: { translation: number[]; rotation: number[]; scale: number[] }[][]
  numFrames: number
  fps: number
  duration: number
}

function findContainer(json: Record<string, unknown>): Record<string, unknown> {
  const variants = (json as { namedVariants?: { variant?: Record<string, unknown> }[] }).namedVariants ?? []
  for (const entry of variants) {
    const variant = entry?.variant
    if (!variant) continue
    if (Array.isArray(variant.skeletons) || Array.isArray(variant.animations) || Array.isArray(variant.bindings)) {
      return variant
    }
  }
  throw new Error("HKX JSON: missing animation container in namedVariants")
}

export function loadAnimJson(json: Record<string, unknown>): AnimData {
  const container = findContainer(json)
  const skel = (container.skeletons as Record<string, unknown>[])[0]
  const anim = (container.animations as Record<string, unknown>[])[0]
  const binding = (container.bindings as Record<string, unknown>[])[0]

  return {
    bones: (skel.bones as { name: string }[]).map((b, i) => ({
      name: b.name,
      parentIndex: (skel.parentIndices as number[])[i],
    })),
    refPose: skel.referencePose as AnimData["refPose"],
    trackToBone: binding.transformTrackToBoneIndices as number[],
    frames: anim.frames as AnimData["frames"],
    numFrames: anim.numDecompressedFrames as number,
    fps: Math.round(1.0 / (anim.frameDuration as number)),
    duration: anim.duration as number,
  }
}

function qmul4(
  a: [number, number, number, number],
  b: [number, number, number, number],
): [number, number, number, number] {
  const [ax, ay, az, aw] = a
  const [bx, by, bz, bw] = b
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ]
}

function qrot4(q: [number, number, number, number], v: [number, number, number]): [number, number, number] {
  const qc: [number, number, number, number] = [-q[0], -q[1], -q[2], q[3]]
  const t = qmul4(q, [v[0], v[1], v[2], 0])
  const r = qmul4(t, qc)
  return [r[0], r[1], r[2]]
}

/** FK: local transforms -> world positions (frameIdx -1 = reference pose only). */
export function computeWorldPositions(anim: AnimData, frameIdx: number): THREE.Vector3[] {
  const n = anim.bones.length
  const wPos: [number, number, number][] = new Array(n)
  const wRot: [number, number, number, number][] = new Array(n)

  const boneToTrack = new Map<number, number>()
  for (let t = 0; t < anim.trackToBone.length; t++) {
    boneToTrack.set(anim.trackToBone[t], t)
  }

  const frame = frameIdx >= 0 ? anim.frames[frameIdx] : null

  for (let i = 0; i < n; i++) {
    const ref = anim.refPose[i]
    const track = boneToTrack.get(i)

    let lr: [number, number, number, number]
    let lt: [number, number, number]

    if (frame && track !== undefined) {
      const ft = frame[track]
      lr = [ft.rotation[0], ft.rotation[1], ft.rotation[2], ft.rotation[3]]
      lt = [ft.translation[0], ft.translation[1], ft.translation[2]]
    } else {
      lr = [ref.rotation[0], ref.rotation[1], ref.rotation[2], ref.rotation[3]]
      lt = [ref.translation[0], ref.translation[1], ref.translation[2]]
    }

    const pi = anim.bones[i].parentIndex
    if (pi < 0) {
      wRot[i] = lr
      wPos[i] = lt
    } else {
      wRot[i] = qmul4(wRot[pi], lr)
      const rotated = qrot4(wRot[pi], lt)
      wPos[i] = [rotated[0] + wPos[pi][0], rotated[1] + wPos[pi][1], rotated[2] + wPos[pi][2]]
    }
  }

  return wPos.map((p) => new THREE.Vector3(p[0], p[1], p[2]))
}

export const HKX_IMPORTANT_BONES = new Set([
  "Master",
  "RootPos",
  "Pelvis",
  "Spine",
  "Spine1",
  "Spine2",
  "Neck",
  "Head",
  "L_Clavicle",
  "L_UpperArm",
  "L_Forearm",
  "L_Hand",
  "R_Clavicle",
  "R_UpperArm",
  "R_Forearm",
  "R_Hand",
  "L_Thigh",
  "L_Calf",
  "L_Foot",
  "L_Toe0",
  "R_Thigh",
  "R_Calf",
  "R_Foot",
  "R_Toe0",
  "RootRotY",
  "RootRotXZ",
])
