import { Quat, Vec3 } from "reze-engine"
import type { HkxAnimation } from "./hkx-loader"
import {
  createCoreContext,
  retargetCoreFrame,
  retargetCoreClip,
  q4Normalize,
  type FrameResult,
  type Q4,
  type RetargetCoreContext,
  type RetargetedClip,
  type RetargetSource,
  type SourceBone,
  type V3,
} from "./retarget-core"

/**
 * HKX (Elden Ring / Havok) → MMD frontend for the retarget core
 * (lib/retarget-core.ts — the algorithm and its derivation live there).
 *
 * HKX and MMD are both left-handed Y-up, so locals feed the core unconverted.
 * This file owns what is ER-specific: the bone map, the Master/Root translation
 * split, the meters→MMD-units scale, and the c2190 reference-pose calibration.
 */

export type { RetargetedClip, RetargetedBoneTrack, RetargetedPositionTrack, FrameResult } from "./retarget-core"

/* ============================================================================
 * ER → MMD bone mapping.
 * ========================================================================= */

export const ER_BONE_MAP: Record<string, string> = {
  Master: "全ての親",
  Root: "センター",
  Pelvis: "下半身",
  // Three ER spine joints onto MMD's two: the DEEPEST (Spine2, the chest — deep
  // bows live on it) must land on 上半身2, with Spine1 unmapped so its rotation
  // folds INTO 上半身2's world target. Mapping Spine1→上半身2 instead folds
  // Spine2 into neck/shoulders: head and arms pitch but the torso stays
  // straight — an upright chest with a dipped head on every deep bend.
  Spine: "上半身",
  Spine2: "上半身2",
  Neck: "首",
  Head: "頭",
  L_Clavicle: "左肩",
  L_UpperArm: "左腕",
  L_Forearm: "左ひじ",
  L_Hand: "左手首",
  R_Clavicle: "右肩",
  R_UpperArm: "右腕",
  R_Forearm: "右ひじ",
  R_Hand: "右手首",
  L_Thigh: "左足",
  L_Calf: "左ひざ",
  L_Foot: "左足首",
  L_Toe0: "左足先EX",
  L_Toe_302: "左つま先",
  R_Thigh: "右足",
  R_Calf: "右ひざ",
  R_Foot: "右足首",
  R_Toe0: "右足先EX",
  R_Toe_302: "右つま先",
  // MMD thumbs are 親指０/１/２ (the ０ is the metacarpal) — there is no 親指３.
  L_Finger0: "左親指０",
  L_Finger01: "左親指１",
  L_Finger02: "左親指２",
  L_Finger1: "左人指１",
  L_Finger11: "左人指２",
  L_Finger12: "左人指３",
  L_Finger2: "左中指１",
  L_Finger21: "左中指２",
  L_Finger22: "左中指３",
  L_Finger3: "左薬指１",
  L_Finger31: "左薬指２",
  L_Finger32: "左薬指３",
  L_Finger4: "左小指１",
  L_Finger41: "左小指２",
  L_Finger42: "左小指３",
  R_Finger0: "右親指０",
  R_Finger01: "右親指１",
  R_Finger02: "右親指２",
  R_Finger1: "右人指１",
  R_Finger11: "右人指２",
  R_Finger12: "右人指３",
  R_Finger2: "右中指１",
  R_Finger21: "右中指２",
  R_Finger22: "右中指３",
  R_Finger3: "右薬指１",
  R_Finger31: "右薬指２",
  R_Finger32: "右薬指３",
  R_Finger4: "右小指１",
  R_Finger41: "右小指２",
  R_Finger42: "右小指３",
}

/**
 * ER → MMD world-unit scale for translations.
 *
 * ER skeleton is in meters (waist `Root` bone at ~1.62). MMD model is in PMX
 * units (waist bone at ~11.8, head at ~18.7). Natural ratio ≈ 7.3.
 */
export const POSITION_SCALE = 7.3

/**
 * Skeleton calibration: constant reference-pose error, cancelled per bone by
 * right-multiplying `W_target = Δ · C`. For a constant local ref-pose offset
 * this cancels exactly at every frame (W = I whenever the animation sits at its
 * true neutral), while genuine animation on the bone passes through untouched.
 *
 * 頭: the c2190 skeleton's reference pose carries ~7.9° of head roll relative to
 * the animation corpus's neutral — measured as the median world-delta
 * z-component ≈ −0.069, tightly clustered across 8 of 10 melina clips
 * (scripts/validate-hkx.ts). The joint wireframe can't show terminal-bone roll,
 * but the skinned mesh reads it as a permanent leftward head tilt.
 */
const REF_POSE_BIAS_CORRECTION: Record<string, Q4> = {
  頭: q4Normalize([0, 0, 0.069, 0.9976]),
}

/* ============================================================================
 * MMD skeleton dump (from the engine's model, via console dump).
 * ========================================================================= */

export interface MmdSkeletonBone {
  index: number
  name: string
  parentIndex: number
  worldPosition: number[]
}

export interface MmdSkeletonDump {
  bones: MmdSkeletonBone[]
}

export interface HkxRetargetOptions {
  /**
   * The target MMD model's skeleton (bind-pose world positions), used to measure
   * mapped-pair segment directions for absolute-pose alignment. Without it every
   * bone falls back to plain world delta.
   */
  mmdSkeleton?: MmdSkeletonDump
}

export interface HkxRetargetContext {
  hkx: HkxAnimation
  core: RetargetCoreContext
  /** boneIdx → trackIdx, -1 if no track. */
  boneToTrack: Int32Array
}

/* ============================================================================
 * Context creation.
 * ========================================================================= */

function buildSource(hkx: HkxAnimation, boneToTrack: Int32Array): RetargetSource {
  const bones: SourceBone[] = hkx.bones.map((b) => ({
    name: b.name,
    parentIndex: b.parentIndex,
    bindLocalRot: [
      b.referencePose.rotation[0],
      b.referencePose.rotation[1],
      b.referencePose.rotation[2],
      b.referencePose.rotation[3],
    ] as Q4,
    bindLocalPos: [
      b.referencePose.translation[0],
      b.referencePose.translation[1],
      b.referencePose.translation[2],
    ] as V3,
  }))

  return {
    bones,
    numFrames: hkx.numFrames,
    fps: hkx.fps,
    sample(boneIdx, frame) {
      const t = boneToTrack[boneIdx]
      if (t < 0) return null
      const ft = hkx.frames[frame][t]
      return {
        rot: [ft.rotation[0], ft.rotation[1], ft.rotation[2], ft.rotation[3]] as Q4,
        pos: [ft.translation[0], ft.translation[1], ft.translation[2]] as V3,
      }
    },
  }
}

export function createRetargetContext(hkx: HkxAnimation, options?: HkxRetargetOptions): HkxRetargetContext {
  const boneToTrack = new Int32Array(hkx.bones.length).fill(-1)
  for (let t = 0; t < hkx.trackToBone.length; t++) boneToTrack[hkx.trackToBone[t]] = t

  const targetPositions: Record<string, V3> | undefined = options?.mmdSkeleton
    ? Object.fromEntries(
        options.mmdSkeleton.bones.map((b) => [b.name, [b.worldPosition[0], b.worldPosition[1], b.worldPosition[2]] as V3]),
      )
    : undefined

  // Whole-body translation split: Master (the top-level ER bone) carries
  // locomotion / jumps / lying down → 全ての親. Root (the waist, a child of
  // Master) additionally carries crouch depth / pelvis drops — that residual
  // goes to センター, expressed in 全ての親's animated frame so turns don't
  // skew it. Exporting only Master silently flattens crouches (a000_003000
  // loses 0.23m of waist drop).
  const hasMaster = hkx.bones.some((b) => b.name === "Master")
  const hasRoot = hkx.bones.some((b) => b.name === "Root")
  const translationExports = hasMaster
    ? [
        { srcBone: "Master", mmdBone: "全ての親" },
        ...(hasRoot ? [{ srcBone: "Root", mmdBone: "センター", subtractSrcBone: "Master", frameOfMmdBone: "全ての親" }] : []),
      ]
    : hasRoot
      ? [{ srcBone: "Root", mmdBone: "全ての親" }]
      : []

  const core = createCoreContext(buildSource(hkx, boneToTrack), {
    nameMap: ER_BONE_MAP,
    targetPositions,
    positionScale: POSITION_SCALE,
    translationExports,
    refPoseBias: REF_POSE_BIAS_CORRECTION,
  })

  return { hkx, core, boneToTrack }
}

/* ============================================================================
 * Public API.
 * ========================================================================= */

export function computeHkxMmdFrame(hkx: HkxAnimation, frameIdx: number): FrameResult {
  return computeHkxMmdFrameWithCtx(createRetargetContext(hkx), frameIdx)
}

export function computeHkxMmdFrameWithCtx(ctx: HkxRetargetContext, frameIdx: number): FrameResult {
  return retargetCoreFrame(ctx.core, frameIdx)
}

export function retargetHkxClipWithCtx(ctx: HkxRetargetContext): RetargetedClip {
  const clip = retargetCoreClip(ctx.core, ctx.hkx.name)
  // The HKX header's duration wins over numFrames/fps (they can differ by a frame).
  return { ...clip, duration: ctx.hkx.duration }
}

export function retargetHkxClip(hkx: HkxAnimation, options?: HkxRetargetOptions): RetargetedClip {
  return retargetHkxClipWithCtx(createRetargetContext(hkx, options))
}

/* ============================================================================
 * Debug helper.
 * ========================================================================= */

/** Dump ER skeleton (bones + ref poses + world positions/rotations) as JSON. */
export function logHkxSkeletonDefaultsToConsole(hkx: HkxAnimation): void {
  const ctx = createRetargetContext(hkx)
  const bones = hkx.bones.map((b, i) => ({
    name: b.name,
    parentIndex: b.parentIndex,
    refTranslation: [...b.referencePose.translation],
    refRotation: [...b.referencePose.rotation],
    bindWorldPosition: ctx.core.bindWorldPos[i],
    bindWorldRotation: ctx.core.bindWorldRot[i],
  }))
  console.log("[hkx-skeleton.json]\n" + JSON.stringify({ skeletonName: hkx.name, bones }, null, 2))
}
