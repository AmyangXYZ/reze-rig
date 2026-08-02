import { Quat, Vec3 } from "reze-engine"
import type { HkxAnimation } from "./hkx-loader"

/**
 * HKX (Elden Ring / Havok) → MMD (VMD) retarget.
 *
 * Self-contained. Designed to be extracted into its own package later.
 *
 * Core idea (world-rotation retarget):
 *
 *   PMX bones have identity local rest rotations (only rest translations).
 *   So every MMD bone's rest world rotation is identity. That means the
 *   MMD bone's animated world rotation must equal the ER bone's *world-space
 *   motion delta* from its own bind:
 *
 *     W_target(mmd_b) = R_er(er_b) · E(er_b)⁻¹
 *
 *   where R_er is ER's animated world rotation (FK per frame) and E is
 *   ER's bind-pose world rotation (FK on the reference pose, cached).
 *
 *   Because MMD local rest rotations are identity, each VMD local rotation is
 *   just the world-rotation delta between a mapped MMD bone and its nearest
 *   mapped MMD ancestor:
 *
 *     q_vmd(mmd_b) = W_target(mmd_parent)⁻¹ · W_target(mmd_b)
 *
 *   Unmapped intermediate ER bones (Spine2, Collar, twist helpers, …) get
 *   their rotations correctly absorbed into the next mapped MMD descendant
 *   via this cancellation — no ad-hoc fold table needed.
 *
 * Handedness: HKX and MMD (reze-engine, Babylon) are both left-handed Y-up,
 * so no axis flip is applied.
 */

/* ============================================================================
 * Public types (kept local so this module can move to its own repo).
 * ========================================================================= */

export interface RetargetedBoneTrack {
  name: string
  originalName: string
  times: number[]
  quats: Quat[]
}

export interface RetargetedPositionTrack {
  name: string
  originalName: string
  times: number[]
  positions: Vec3[]
}

export interface RetargetedClip {
  name: string
  duration: number
  fps: number
  boneTracks: RetargetedBoneTrack[]
  positionTracks: RetargetedPositionTrack[]
}

/**
 * ER → MMD world-unit scale for translations.
 *
 * ER skeleton is in meters (waist `Root` bone at ~1.62). MMD model is in PMX
 * units (waist bone at ~11.8, head at ~18.7). Natural ratio ≈ 7.3.
 *
 * `moveBones` expects the value as a world-space offset from bind pose, so
 * this is applied directly to `(ER_world_anim − ER_world_bind)`.
 */
export const POSITION_SCALE = 7.3

/* ============================================================================
 * ER → MMD bone mapping.
 * ========================================================================= */

export const ER_BONE_MAP: Record<string, string> = {
  Master: "全ての親",
  Root: "センター",
  Pelvis: "下半身",
  Spine: "上半身",
  Spine1: "上半身2",
  Neck: "首",
  Head: "頭",
  L_Clavicle: "左肩",
  L_UpperArm: "左腕",
  // L_UpArmTwist: "左腕捩",
  L_Forearm: "左ひじ",
  // L_ForeArmTwist: "左手捩",
  L_Hand: "左手首",
  R_Clavicle: "右肩",
  R_UpperArm: "右腕",
  // R_UpArmTwist: "右腕捩",
  R_Forearm: "右ひじ",
  // R_ForeArmTwist: "右手捩",
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

/* ============================================================================
 * MMD skeleton dump (from the engine's model, via console dump) → bind dirs.
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

/* ============================================================================
 * Quaternion helpers (Q4 = [x, y, z, w]).
 * ========================================================================= */

type Q4 = [number, number, number, number]

function q4Mul(a: Q4, b: Q4): Q4 {
  const [ax, ay, az, aw] = a
  const [bx, by, bz, bw] = b
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ]
}

function q4Conj(q: Q4): Q4 {
  return [-q[0], -q[1], -q[2], q[3]]
}

function q4Normalize(q: Q4): Q4 {
  const l = Math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3])
  return l > 1e-10 ? [q[0] / l, q[1] / l, q[2] / l, q[3] / l] : [0, 0, 0, 1]
}

function q4Rot(q: Q4, v: [number, number, number]): [number, number, number] {
  const t = q4Mul(q, [v[0], v[1], v[2], 0])
  const r = q4Mul(t, q4Conj(q))
  return [r[0], r[1], r[2]]
}

/**
 * Build the rotation that maps local axes (+X, +Y, +Z) onto a bone-aligned world frame:
 *   +X → `forward` (the bone's tip direction)
 *   +Y → component of `refUp` orthogonal to forward (Gram-Schmidt)
 *   +Z → forward × up
 * `fallbackUp` is substituted if `forward` is (nearly) parallel to `refUp`.
 */
function quatFromForwardUp(
  forward: [number, number, number],
  refUp: [number, number, number],
  fallbackUp: [number, number, number] = [0, 0, 1],
): Q4 {
  const fl = Math.hypot(forward[0], forward[1], forward[2])
  const fx = forward[0] / fl, fy = forward[1] / fl, fz = forward[2] / fl
  let rux = refUp[0], ruy = refUp[1], ruz = refUp[2]
  let dotFU = fx * rux + fy * ruy + fz * ruz
  if (Math.abs(dotFU) > 0.99) {
    rux = fallbackUp[0]; ruy = fallbackUp[1]; ruz = fallbackUp[2]
    dotFU = fx * rux + fy * ruy + fz * ruz
  }
  let ux = rux - dotFU * fx, uy = ruy - dotFU * fy, uz = ruz - dotFU * fz
  const ul = Math.hypot(ux, uy, uz) || 1
  ux /= ul; uy /= ul; uz /= ul
  const sx = fy * uz - fz * uy, sy = fz * ux - fx * uz, sz = fx * uy - fy * ux
  const m00 = fx, m01 = ux, m02 = sx
  const m10 = fy, m11 = uy, m12 = sy
  const m20 = fz, m21 = uz, m22 = sz
  const trace = m00 + m11 + m22
  let qx: number, qy: number, qz: number, qw: number
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2
    qw = 0.25 * s; qx = (m21 - m12) / s; qy = (m02 - m20) / s; qz = (m10 - m01) / s
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2
    qw = (m21 - m12) / s; qx = 0.25 * s; qy = (m01 + m10) / s; qz = (m02 + m20) / s
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2
    qw = (m02 - m20) / s; qx = (m01 + m10) / s; qy = 0.25 * s; qz = (m12 + m21) / s
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2
    qw = (m10 - m01) / s; qx = (m02 + m20) / s; qy = (m12 + m21) / s; qz = 0.25 * s
  }
  return q4Normalize([qx, qy, qz, qw])
}

/* ============================================================================
 * Retarget context.
 * ========================================================================= */

interface MappedBone {
  erName: string
  mmdName: string
  erIdx: number
  /** Nearest mapped ancestor in the ER tree (its MMD name). Null if this is a root-mapped bone. */
  parentMmdName: string | null
  /**
   * Frame-alignment rotation `F = F_mmd · F_er⁻¹`, used as `W_target = Δ_er · F⁻¹`
   * (absolute-pose alignment — see retargetFrame step 3). Both frames are built
   * with quatFromForwardUp from the MAPPED-PAIR segment direction (bone → its
   * mapped child(ren), measured on each skeleton's own bind pose) and a shared up
   * reference (ER's local Y in world), so F⁻¹ maps the MMD segment direction
   * exactly onto the ER segment direction without axial-roll surprises.
   * `null` when the bone has no mapped child, no skeleton dump was provided, or
   * the segment directions disagree by ≥90° — falls back to plain delta.
   */
  frameAlign: Q4 | null
  /** Bind-pose segment-direction agreement (see frameAlign); null if not computed. */
  alignDot: number | null
}

export interface HkxRetargetContext {
  hkx: HkxAnimation
  mappedBones: MappedBone[]
  /** Precomputed ER bind world rotations (one per ER bone). */
  erBindWorldRot: Q4[]
  /** Precomputed ER bind world positions (one per ER bone). */
  erBindWorldPos: [number, number, number][]
  /** boneIdx → trackIdx, -1 if no track. */
  boneToTrack: Int32Array
  /** ER bone index whose world position we export as 全ての親 translation. */
  rootPosIdx: number
  /**
   * ER bone index for センター translation (Root, the waist). ER splits whole-body
   * movement across Master (locomotion / turns) and Root (crouch depth, pelvis
   * drops) — exporting only Master silently flattens crouches. -1 when Root is
   * absent or already serving as rootPosIdx.
   */
  centerPosIdx: number
}

export interface HkxRetargetOptions {
  /**
   * The target MMD model's skeleton (bind-pose world positions), used to measure
   * mapped-pair segment directions for absolute-pose alignment. Without it every
   * bone falls back to plain world delta.
   */
  mmdSkeleton?: MmdSkeletonDump
}

export interface FrameResult {
  rotations: Record<string, Quat>
  positions: Record<string, Vec3>
}

/** FK on the ER skeleton using the given per-bone local rotations. Returns world rotations. */
function fkWorldRotations(hkx: HkxAnimation, localRot: Q4[]): Q4[] {
  const n = hkx.bones.length
  const out: Q4[] = new Array(n)
  for (let i = 0; i < n; i++) {
    const pi = hkx.bones[i].parentIndex
    out[i] = pi < 0 ? localRot[i] : q4Mul(out[pi], localRot[i])
  }
  return out
}

/** FK on the ER skeleton using per-bone local rotations and per-bone local translations. Returns world positions. */
function fkWorldPositions(
  hkx: HkxAnimation,
  localRot: Q4[],
  localPos: [number, number, number][],
): [number, number, number][] {
  const n = hkx.bones.length
  const wRot: Q4[] = new Array(n)
  const wPos: [number, number, number][] = new Array(n)
  for (let i = 0; i < n; i++) {
    const pi = hkx.bones[i].parentIndex
    const lr = localRot[i]
    const lt = localPos[i]
    if (pi < 0) {
      wRot[i] = lr
      wPos[i] = [lt[0], lt[1], lt[2]]
    } else {
      wRot[i] = q4Mul(wRot[pi], lr)
      const r = q4Rot(wRot[pi], lt)
      wPos[i] = [r[0] + wPos[pi][0], r[1] + wPos[pi][1], r[2] + wPos[pi][2]]
    }
  }
  return wPos
}

export function createRetargetContext(hkx: HkxAnimation, options?: HkxRetargetOptions): HkxRetargetContext {
  const n = hkx.bones.length

  // Precompute ER bind-pose world rotations and positions.
  const bindLocal: Q4[] = new Array(n)
  const bindLocalPos: [number, number, number][] = new Array(n)
  for (let i = 0; i < n; i++) {
    const r = hkx.bones[i].referencePose.rotation
    const t = hkx.bones[i].referencePose.translation
    bindLocal[i] = q4Normalize([r[0], r[1], r[2], r[3]])
    bindLocalPos[i] = [t[0], t[1], t[2]]
  }
  const erBindWorldRot = fkWorldRotations(hkx, bindLocal)
  const erBindWorldPos = fkWorldPositions(hkx, bindLocal, bindLocalPos)

  // boneIdx → trackIdx lookup.
  const boneToTrack = new Int32Array(n).fill(-1)
  for (let t = 0; t < hkx.trackToBone.length; t++) boneToTrack[hkx.trackToBone[t]] = t

  const nameToIdx = new Map<string, number>()
  for (let i = 0; i < n; i++) nameToIdx.set(hkx.bones[i].name, i)

  // Pass 1: mapped bone list with nearest mapped ancestor (true + engine-adjusted).
  const mappedBones: MappedBone[] = []
  const trueParentByMmd = new Map<string, string | null>()
  for (const [erName, mmdName] of Object.entries(ER_BONE_MAP)) {
    const erIdx = nameToIdx.get(erName)
    if (erIdx === undefined) continue

    // Walk up the ER tree to find the nearest mapped ancestor.
    let parentMmdName: string | null = null
    let p = hkx.bones[erIdx].parentIndex
    while (p >= 0) {
      const parentErName = hkx.bones[p].name
      const parentMmd = ER_BONE_MAP[parentErName]
      if (parentMmd) {
        parentMmdName = parentMmd
        break
      }
      p = hkx.bones[p].parentIndex
    }
    trueParentByMmd.set(mmdName, parentMmdName)

    // 上半身's real PMX parent chain is 腰 ← グルーブ ← センター — it never inherits
    // 下半身 (its ER counterpart Spine sits under Pelvis, so the ER walk lands on
    // 下半身). 腰/グルーブ are never animated here, so its effective parent is
    // センター. The legs are NOT overridden: their real chain is 腰キャンセル左/右
    // ← 下半身, and the キャンセル bones cancel 腰's rotation (which stays
    // identity), not 下半身's — the engine really does apply 下半身's rotation to
    // the leg chain, so leg locals must subtract it. (Overriding legs to センター
    // double-applied pelvis pitch: a forward lunge read as leaning backwards.)
    if (parentMmdName === "下半身" && mmdName === "上半身") {
      parentMmdName = "センター"
    }

    mappedBones.push({ erName, mmdName, erIdx, parentMmdName, frameAlign: null, alignDot: null })
  }

  // Pass 2: frame alignment from MAPPED-PAIR segment directions — the same
  // anatomical segment measured on both skeletons: bone → its mapped child(ren),
  // ER bind positions on one side, PMX bind positions on the other. (Averaging
  // ALL PMX children instead poisons bones whose children aren't the skeletal
  // continuation — 頭 averages eyes + hair physics, 足首 picks up non-toe
  // helpers — which showed up as a constant head tilt and a flipped ankle.)
  //
  // Both frames are synthetic (forward = segment dir, shared up = ER local Y), so
  // F⁻¹·d_mmd = d_er holds exactly and W_target·d_mmd = Δ_er·d_er every frame.
  //
  // Gate at dot > 0: below that the segments are different anatomy (ER Pelvis's
  // bone axis points up to the spine), not a rest-angle difference. 全ての親 is
  // skipped outright — it carries whole-body root motion, not a limb segment.
  const mmdPosByName = new Map<string, [number, number, number]>()
  for (const b of options?.mmdSkeleton?.bones ?? []) {
    mmdPosByName.set(b.name, [b.worldPosition[0], b.worldPosition[1], b.worldPosition[2]])
  }
  const mappedChildren = new Map<string, MappedBone[]>()
  for (const b of mappedBones) {
    const tp = trueParentByMmd.get(b.mmdName)
    if (!tp) continue
    const arr = mappedChildren.get(tp)
    if (arr) arr.push(b)
    else mappedChildren.set(tp, [b])
  }

  if (mmdPosByName.size > 0) {
    for (const bone of mappedBones) {
      // Control bones, not limb segments: their rotation is whole-body/hip
      // orientation, and an alignment offset on them swings every descendant's
      // POSITION (child orientations cancel via the parent-local subtraction,
      // positions don't) — it reads as a constant structural tilt.
      if (bone.mmdName === "全ての親" || bone.mmdName === "センター") continue
      const children = mappedChildren.get(bone.mmdName)
      const mmdPos = mmdPosByName.get(bone.mmdName)
      if (!children || children.length === 0 || !mmdPos) continue

      const dEr: [number, number, number] = [0, 0, 0]
      const dMmd: [number, number, number] = [0, 0, 0]
      let usable = 0
      for (const c of children) {
        const cMmdPos = mmdPosByName.get(c.mmdName)
        if (!cMmdPos) continue
        const ep = erBindWorldPos[bone.erIdx]
        const ec = erBindWorldPos[c.erIdx]
        dEr[0] += ec[0] - ep[0]; dEr[1] += ec[1] - ep[1]; dEr[2] += ec[2] - ep[2]
        dMmd[0] += cMmdPos[0] - mmdPos[0]; dMmd[1] += cMmdPos[1] - mmdPos[1]; dMmd[2] += cMmdPos[2] - mmdPos[2]
        usable++
      }
      if (usable === 0) continue
      const lEr = Math.hypot(dEr[0], dEr[1], dEr[2])
      const lMmd = Math.hypot(dMmd[0], dMmd[1], dMmd[2])
      // Tiny averages mean the children straddle the bone (センター's 上半身 up +
      // 下半身 down nearly cancel) — no meaningful segment direction.
      if (lEr < 1e-4 || lMmd < 1e-4) continue
      const uEr: [number, number, number] = [dEr[0] / lEr, dEr[1] / lEr, dEr[2] / lEr]
      const uMmd: [number, number, number] = [dMmd[0] / lMmd, dMmd[1] / lMmd, dMmd[2] / lMmd]
      const dot = uEr[0] * uMmd[0] + uEr[1] * uMmd[1] + uEr[2] * uMmd[2]
      bone.alignDot = dot
      if (dot <= 0) continue

      const erLocalY = q4Rot(erBindWorldRot[bone.erIdx], [0, 1, 0])
      const fEr = quatFromForwardUp(uEr, erLocalY)
      const fMmd = quatFromForwardUp(uMmd, erLocalY)
      bone.frameAlign = q4Normalize(q4Mul(fMmd, q4Conj(fEr)))
    }
  }

  // Whole-body translation source. Master is the top-level ER bone that carries
  // world movement (jump, lying down, locomotion). Root (the waist, a child of
  // Master) additionally carries crouch depth / pelvis drops → センター.
  const rootPosIdx = nameToIdx.get("Master") ?? nameToIdx.get("Root") ?? -1
  const rootIdx = nameToIdx.get("Root") ?? -1
  const centerPosIdx = rootIdx >= 0 && rootIdx !== rootPosIdx ? rootIdx : -1

  return { hkx, mappedBones, erBindWorldRot, erBindWorldPos, boneToTrack, rootPosIdx, centerPosIdx }
}

/**
 * Skeleton calibration: constant reference-pose error, cancelled per bone by
 * right-multiplying `W_target = Δ_er · C`. For a constant local ref-pose offset
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
 * Per-frame retarget.
 * ========================================================================= */

function retargetFrame(ctx: HkxRetargetContext, frameIdx: number): FrameResult {
  const { hkx, mappedBones, erBindWorldRot, erBindWorldPos, boneToTrack } = ctx
  const n = hkx.bones.length
  const frame = hkx.frames[frameIdx]

  // Step 1: build per-bone animated local rotations and translations
  //         (track if present, else reference pose).
  const animLocal: Q4[] = new Array(n)
  const animLocalPos: [number, number, number][] = new Array(n)
  for (let i = 0; i < n; i++) {
    const ref = hkx.bones[i].referencePose
    const t = boneToTrack[i]
    if (t >= 0) {
      const ft = frame[t]
      animLocal[i] = [ft.rotation[0], ft.rotation[1], ft.rotation[2], ft.rotation[3]]
      animLocalPos[i] = [ft.translation[0], ft.translation[1], ft.translation[2]]
    } else {
      animLocal[i] = [ref.rotation[0], ref.rotation[1], ref.rotation[2], ref.rotation[3]]
      animLocalPos[i] = [ref.translation[0], ref.translation[1], ref.translation[2]]
    }
  }

  // Step 2: FK → animated ER world rotations.
  const erAnimWorldRot = fkWorldRotations(hkx, animLocal)

  // Step 3: per mapped bone, absolute-pose alignment.
  //   Δ_er     = R_er · B_er⁻¹           (world delta in ER's frame)
  //   W_target = Δ_er · F⁻¹              (F = F_mmd · F_er⁻¹)
  // F⁻¹ maps the MMD bind direction onto ER's bind direction (F⁻¹·d_mmd = d_er),
  // so W_target·d_mmd = Δ_er·d_er — the MMD segment points exactly where the ER
  // segment points, every frame INCLUDING bind. The earlier conjugation form
  // (F·Δ·F⁻¹) preserved MMD rest offsets instead, which made the pose inherit
  // every bind mismatch: A-pose arms drifted ~35° vs ER's arms-down bind, and
  // MMD's narrower thigh stance read as extra leg crossing. Roll stays sane
  // because F's synthetic MMD frame shares ER's up axis.
  // Bones without a tip (no F) fall back to plain delta (F = identity).
  const targetByMmd: Record<string, Q4> = {}
  for (const bone of mappedBones) {
    const deltaEr = q4Mul(erAnimWorldRot[bone.erIdx], q4Conj(erBindWorldRot[bone.erIdx]))
    let target = bone.frameAlign ? q4Mul(deltaEr, q4Conj(bone.frameAlign)) : deltaEr
    const refBias = REF_POSE_BIAS_CORRECTION[bone.mmdName]
    if (refBias) target = q4Mul(target, refBias)
    targetByMmd[bone.mmdName] = q4Normalize(target)
  }

  // Step 4: q_vmd = W_target(mmd_parent)⁻¹ · W_target(mmd_b).
  const rotations: Record<string, Quat> = {}
  for (const bone of mappedBones) {
    const target = targetByMmd[bone.mmdName]
    const parentTarget = bone.parentMmdName ? targetByMmd[bone.parentMmdName] : null
    const local = parentTarget ? q4Mul(q4Conj(parentTarget), target) : target
    const nq = q4Normalize(local)
    rotations[bone.mmdName] = new Quat(nq[0], nq[1], nq[2], nq[3])
  }

  // Step 5: whole-body translation. Master's world displacement → 全ての親
  // (jump, lying down, locomotion). Root (waist) moves beyond Master for
  // crouches / pelvis drops; that residual goes to センター, expressed in
  // 全ての親's animated frame (its VMD parent) so turns don't skew it.
  const positions: Record<string, Vec3> = {}
  if (ctx.rootPosIdx >= 0) {
    const worldPos = fkWorldPositions(hkx, animLocal, animLocalPos)
    const wp = worldPos[ctx.rootPosIdx]
    const bp = erBindWorldPos[ctx.rootPosIdx]
    const masterDelta: [number, number, number] = [wp[0] - bp[0], wp[1] - bp[1], wp[2] - bp[2]]
    positions["全ての親"] = new Vec3(
      masterDelta[0] * POSITION_SCALE,
      masterDelta[1] * POSITION_SCALE,
      masterDelta[2] * POSITION_SCALE,
    )
    if (ctx.centerPosIdx >= 0) {
      const cw = worldPos[ctx.centerPosIdx]
      const cb = erBindWorldPos[ctx.centerPosIdx]
      let residual: [number, number, number] = [
        cw[0] - cb[0] - masterDelta[0],
        cw[1] - cb[1] - masterDelta[1],
        cw[2] - cb[2] - masterDelta[2],
      ]
      const masterTarget = targetByMmd["全ての親"]
      if (masterTarget) residual = q4Rot(q4Conj(masterTarget), residual)
      positions["センター"] = new Vec3(
        residual[0] * POSITION_SCALE,
        residual[1] * POSITION_SCALE,
        residual[2] * POSITION_SCALE,
      )
    }
  }

  return { rotations, positions }
}

/* ============================================================================
 * Public API.
 * ========================================================================= */

export function computeHkxMmdFrame(hkx: HkxAnimation, frameIdx: number): FrameResult {
  return computeHkxMmdFrameWithCtx(createRetargetContext(hkx), frameIdx)
}

export function computeHkxMmdFrameWithCtx(ctx: HkxRetargetContext, frameIdx: number): FrameResult {
  if (frameIdx < 0 || frameIdx >= ctx.hkx.numFrames) return { rotations: {}, positions: {} }
  return retargetFrame(ctx, frameIdx)
}

export function retargetHkxClipWithCtx(ctx: HkxRetargetContext): RetargetedClip {
  const hkx = ctx.hkx
  const times = Array.from({ length: hkx.numFrames }, (_, i) => i / hkx.fps)
  const boneQuats: Record<string, Quat[]> = {}
  const bonePositions: Record<string, Vec3[]> = {}

  for (let f = 0; f < hkx.numFrames; f++) {
    const { rotations, positions } = retargetFrame(ctx, f)
    for (const [name, q] of Object.entries(rotations)) {
      if (!boneQuats[name]) boneQuats[name] = []
      boneQuats[name].push(q)
    }
    for (const [name, p] of Object.entries(positions)) {
      if (!bonePositions[name]) bonePositions[name] = []
      bonePositions[name].push(p)
    }
  }

  const boneTracks: RetargetedBoneTrack[] = []
  for (const [mmdName, quats] of Object.entries(boneQuats)) {
    let orig = mmdName
    for (const [er, mmd] of Object.entries(ER_BONE_MAP)) {
      if (mmd === mmdName) {
        orig = er
        break
      }
    }
    boneTracks.push({ name: mmdName, originalName: orig, times: [...times], quats })
  }

  const positionTracks: RetargetedPositionTrack[] = []
  for (const [mmdName, positions] of Object.entries(bonePositions)) {
    if (positions.length !== hkx.numFrames) continue
    const srcIdx = mmdName === "センター" ? ctx.centerPosIdx : ctx.rootPosIdx
    const orig = srcIdx >= 0 ? hkx.bones[srcIdx].name : "Root"
    positionTracks.push({ name: mmdName, originalName: orig, times: [...times], positions })
  }

  return { name: hkx.name, duration: hkx.duration, fps: hkx.fps, boneTracks, positionTracks }
}

export function retargetHkxClip(hkx: HkxAnimation, options?: HkxRetargetOptions): RetargetedClip {
  return retargetHkxClipWithCtx(createRetargetContext(hkx, options))
}

/* ============================================================================
 * Debug helper.
 * ========================================================================= */

/** Dump ER skeleton (bones + ref poses + world positions/rotations) as JSON. */
export function logHkxSkeletonDefaultsToConsole(hkx: HkxAnimation): void {
  const n = hkx.bones.length
  const bindLocal: Q4[] = new Array(n)
  const bindLocalPos: [number, number, number][] = new Array(n)
  for (let i = 0; i < n; i++) {
    const r = hkx.bones[i].referencePose.rotation
    const t = hkx.bones[i].referencePose.translation
    bindLocal[i] = q4Normalize([r[0], r[1], r[2], r[3]])
    bindLocalPos[i] = [t[0], t[1], t[2]]
  }
  const worldRot = fkWorldRotations(hkx, bindLocal)
  const worldPos = fkWorldPositions(hkx, bindLocal, bindLocalPos)
  const bones = hkx.bones.map((b, i) => ({
    name: b.name,
    parentIndex: b.parentIndex,
    refTranslation: [...b.referencePose.translation],
    refRotation: [...b.referencePose.rotation],
    bindWorldPosition: worldPos[i],
    bindWorldRotation: worldRot[i],
  }))
  console.log("[hkx-skeleton.json]\n" + JSON.stringify({ skeletonName: hkx.name, bones }, null, 2))
}
