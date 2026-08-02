export interface HkxBone {
  name: string
  parentIndex: number
  referencePose: {
    translation: number[]
    rotation: number[]
    scale: number[]
  }
}

export interface HkxFrameTransform {
  translation: number[]
  rotation: number[]
  scale: number[]
}

export interface HkxAnimation {
  name: string
  duration: number
  fps: number
  numFrames: number
  bones: HkxBone[]
  trackToBone: number[]
  frames: HkxFrameTransform[][]
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

export function loadHkxJson(json: Record<string, unknown>): HkxAnimation {
  const container = findContainer(json)

  const skel = (container.skeletons as Record<string, unknown>[])[0]
  const anim = (container.animations as Record<string, unknown>[])[0]
  const binding = (container.bindings as Record<string, unknown>[])[0]

  const boneList = skel.bones as { name: string }[]
  const parentIndices = skel.parentIndices as number[]
  const refPose = skel.referencePose as { translation: number[]; rotation: number[]; scale: number[] }[]

  const bones: HkxBone[] = boneList.map((b, i) => ({
    name: b.name,
    parentIndex: parentIndices[i],
    referencePose: refPose[i],
  }))

  const trackToBone = binding.transformTrackToBoneIndices as number[]
  const frames = anim.frames as HkxFrameTransform[][]

  return {
    name: (skel.name as string) || "unknown",
    duration: anim.duration as number,
    fps: Math.round(1.0 / (anim.frameDuration as number)),
    numFrames: anim.numDecompressedFrames as number,
    bones,
    trackToBone,
    frames,
  }
}
