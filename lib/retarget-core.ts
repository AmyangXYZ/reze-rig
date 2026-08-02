import { Quat, Vec3 } from "reze-engine"

/**
 * Source-agnostic skeletal retarget → MMD (VMD-ready clip).
 *
 * Extracted from the HKX (Elden Ring) retarget after it converged; the FBX
 * frontend feeds the same core. A frontend supplies:
 *   - the source skeleton (parent tree + bind-pose locals, in MMD's coordinate
 *     convention: LEFT-handed Y-up — convert handedness before the core),
 *   - a per-frame sampler of local transforms at a uniform fps,
 *   - a source-name → MMD-bone-name map,
 *   - the target model's bind-pose world positions for the mapped MMD bones
 *     (measured from the actual loaded PMX, so any target model works).
 *
 * Core idea — absolute-pose segment alignment:
 *
 *   Δ_src    = R_src · B_src⁻¹      (world rotation delta from the source's own bind)
 *   W_target = Δ_src · F⁻¹          (F = F_mmd · F_src⁻¹)
 *
 * F is the shortest-arc swing between MAPPED-PAIR segment directions — the same
 * anatomical segment (bone → its mapped child/children) measured on each
 * skeleton's own bind pose — so F⁻¹·d_mmd = d_src exactly and the MMD segment
 * points where the source segment points every frame, bind included, with no
 * roll injected. PMX bones have identity local rest rotations, so the VMD
 * local key is just the world-target delta between a mapped bone and its
 * nearest mapped ancestor:
 *
 *   q_vmd(b) = W_target(parent)⁻¹ · W_target(b)
 *
 * Unmapped intermediate source bones (extra spine links, twist helpers, …)
 * are absorbed into the next mapped descendant by this cancellation.
 */

/* ============================================================================
 * Quaternion / vector helpers (Q4 = [x, y, z, w]).
 * ========================================================================= */

export type Q4 = [number, number, number, number]
export type V3 = [number, number, number]

export function q4Mul(a: Q4, b: Q4): Q4 {
  const [ax, ay, az, aw] = a
  const [bx, by, bz, bw] = b
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ]
}

export function q4Conj(q: Q4): Q4 {
  return [-q[0], -q[1], -q[2], q[3]]
}

export function q4Normalize(q: Q4): Q4 {
  const l = Math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3])
  return l > 1e-10 ? [q[0] / l, q[1] / l, q[2] / l, q[3] / l] : [0, 0, 0, 1]
}

export function q4Rot(q: Q4, v: V3): V3 {
  const t = q4Mul(q, [v[0], v[1], v[2], 0])
  const r = q4Mul(t, q4Conj(q))
  return [r[0], r[1], r[2]]
}

/**
 * Shortest-arc rotation taking unit vector `from` to unit vector `to` — a pure
 * swing, no roll about the segment. Antiparallel inputs return a 180° rotation
 * about an arbitrary perpendicular (callers gate on dot > 0, so it never fires
 * in the alignment path).
 */
export function q4FromTo(from: V3, to: V3): Q4 {
  const dot = from[0] * to[0] + from[1] * to[1] + from[2] * to[2]
  if (dot >= 0.999999) return [0, 0, 0, 1]
  if (dot <= -0.999999) {
    const perp: V3 = Math.abs(from[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]
    const ax = from[1] * perp[2] - from[2] * perp[1]
    const ay = from[2] * perp[0] - from[0] * perp[2]
    const az = from[0] * perp[1] - from[1] * perp[0]
    const al = Math.hypot(ax, ay, az) || 1
    return [ax / al, ay / al, az / al, 0]
  }
  const cx = from[1] * to[2] - from[2] * to[1]
  const cy = from[2] * to[0] - from[0] * to[2]
  const cz = from[0] * to[1] - from[1] * to[0]
  return q4Normalize([cx, cy, cz, 1 + dot])
}

/* ============================================================================
 * Public types.
 * ========================================================================= */

export interface SourceBone {
  name: string
  /** Index into the source bone array; -1 for roots. Parents must precede children. */
  parentIndex: number
  /** Bind-pose local rotation, already in MMD's left-handed Y-up convention. */
  bindLocalRot: Q4
  /** Bind-pose local translation, already in MMD's left-handed Y-up convention. */
  bindLocalPos: V3
}

export interface RetargetSource {
  bones: SourceBone[]
  numFrames: number
  fps: number
  /**
   * Local transform of bone `boneIdx` at frame `frame` (MMD convention).
   * Return null to hold the bind pose for that bone.
   */
  sample(boneIdx: number, frame: number): { rot: Q4; pos: V3 } | null
}

export interface TranslationExport {
  /** Source bone whose world displacement from bind is exported. */
  srcBone: string
  /** MMD bone receiving the translation track. */
  mmdBone: string
  /** Export only the displacement BEYOND this bone's (e.g. Root beyond Master). */
  subtractSrcBone?: string
  /**
   * Express the offset in this MMD bone's animated frame (its VMD parent) so
   * whole-body turns don't skew it. Omit for world-frame roots.
   */
  frameOfMmdBone?: string
}

export interface RetargetCoreOptions {
  /** Source bone name → MMD bone name. */
  nameMap: Record<string, string>
  /**
   * Target model's bind-pose world positions keyed by MMD bone name (only the
   * mapped bones are needed). Without it, every bone falls back to plain world
   * delta — poses inherit the bind mismatch between the two skeletons.
   */
  targetPositions?: Record<string, V3>
  /** Source-units → MMD-units scale for translation exports. */
  positionScale: number
  translationExports?: TranslationExport[]
  /**
   * Per-MMD-bone constant right-multiplied onto W_target — cancels a constant
   * source reference-pose error (e.g. the ER c2190 head roll). See the HKX
   * adapter for the measurement method.
   */
  refPoseBias?: Record<string, Q4>
}

export interface MappedBone {
  srcName: string
  mmdName: string
  srcIdx: number
  /** Nearest mapped ancestor adjusted to the PMX semi-standard (its MMD name). */
  parentMmdName: string | null
  /**
   * Frame-alignment swing `F` (shortest arc, d_src → d_mmd), used as
   * `W_target = Δ · F⁻¹`. `null` → plain delta (no mapped child, no target
   * positions, or the segment directions disagree by ≥90°).
   */
  frameAlign: Q4 | null
  /** Bind-pose segment-direction agreement; null if not computed. */
  alignDot: number | null
}

export interface RetargetCoreContext {
  source: RetargetSource
  mappedBones: MappedBone[]
  /** Source bind world rotations (one per source bone). */
  bindWorldRot: Q4[]
  /** Source bind world positions (one per source bone). */
  bindWorldPos: V3[]
  positionScale: number
  translationExports: (TranslationExport & { srcIdx: number; subtractSrcIdx: number })[]
  refPoseBias: Record<string, Q4>
}

export interface FrameResult {
  rotations: Record<string, Quat>
  positions: Record<string, Vec3>
}

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
 * Control bones, not limb segments: their rotation is whole-body / hip
 * orientation, and an alignment offset on them swings every descendant's
 * POSITION (child orientations cancel via the parent-local subtraction,
 * positions don't) — it reads as a constant structural tilt.
 */
const CONTROL_BONES = new Set(["全ての親", "センター"])

/* ============================================================================
 * FK helpers.
 * ========================================================================= */

function fkWorldRotations(bones: SourceBone[], localRot: Q4[]): Q4[] {
  const n = bones.length
  const out: Q4[] = new Array(n)
  for (let i = 0; i < n; i++) {
    const pi = bones[i].parentIndex
    out[i] = pi < 0 ? localRot[i] : q4Mul(out[pi], localRot[i])
  }
  return out
}

function fkWorldPositions(bones: SourceBone[], localRot: Q4[], localPos: V3[]): V3[] {
  const n = bones.length
  const wRot: Q4[] = new Array(n)
  const wPos: V3[] = new Array(n)
  for (let i = 0; i < n; i++) {
    const pi = bones[i].parentIndex
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

/* ============================================================================
 * Context creation.
 * ========================================================================= */

export function createCoreContext(source: RetargetSource, options: RetargetCoreOptions): RetargetCoreContext {
  const bones = source.bones
  const n = bones.length

  const bindLocal: Q4[] = bones.map((b) => q4Normalize(b.bindLocalRot))
  const bindLocalPos: V3[] = bones.map((b) => b.bindLocalPos)
  const bindWorldRot = fkWorldRotations(bones, bindLocal)
  const bindWorldPos = fkWorldPositions(bones, bindLocal, bindLocalPos)

  const nameToIdx = new Map<string, number>()
  for (let i = 0; i < n; i++) if (!nameToIdx.has(bones[i].name)) nameToIdx.set(bones[i].name, i)

  // Pass 1: mapped bone list with nearest mapped ancestor (true + engine-adjusted).
  const mappedBones: MappedBone[] = []
  const trueParentByMmd = new Map<string, string | null>()
  for (const [srcName, mmdName] of Object.entries(options.nameMap)) {
    const srcIdx = nameToIdx.get(srcName)
    if (srcIdx === undefined) continue

    let parentMmdName: string | null = null
    let p = bones[srcIdx].parentIndex
    while (p >= 0) {
      const parentMmd = options.nameMap[bones[p].name]
      if (parentMmd) {
        parentMmdName = parentMmd
        break
      }
      p = bones[p].parentIndex
    }
    trueParentByMmd.set(mmdName, parentMmdName)

    // 上半身's real PMX parent chain is 腰 ← グルーブ ← センター — it never inherits
    // 下半身 (source spines usually sit under the pelvis, so the walk lands on
    // 下半身). 腰/グルーブ are never animated here, so its effective parent is
    // センター. The legs are NOT overridden: their real chain is 腰キャンセル左/右
    // ← 下半身, and the キャンセル bones cancel 腰's rotation (which stays
    // identity), not 下半身's — the engine really does apply 下半身's rotation to
    // the leg chain, so leg locals must subtract it.
    if (parentMmdName === "下半身" && mmdName === "上半身") {
      parentMmdName = "センター"
    }

    mappedBones.push({ srcName, mmdName, srcIdx, parentMmdName, frameAlign: null, alignDot: null })
  }

  // Pass 2: frame alignment from MAPPED-PAIR segment directions — the same
  // anatomical segment measured on both skeletons: bone → its mapped child(ren),
  // source bind positions on one side, target PMX positions on the other.
  // (Averaging ALL PMX children instead poisons bones whose children aren't the
  // skeletal continuation — 頭 averages eyes + hair physics, 足首 picks up
  // non-toe helpers — which showed up as a constant head tilt and a flipped
  // ankle.) F is the SHORTEST-ARC swing d_src → d_mmd: it injects no roll, so
  // the MMD bone keeps its natural roll and source twist arrives only via Δ.
  // (An earlier form built full forward+up frames with up = source local Y;
  // rigs with per-joint axis flips — Mixamo mirrors sides — then picked up 180°
  // roll between parent and child.) Gate at dot > 0: below that the segments
  // are different anatomy, not a rest-angle difference.
  const targetPos = options.targetPositions ?? {}
  const mappedChildren = new Map<string, MappedBone[]>()
  for (const b of mappedBones) {
    const tp = trueParentByMmd.get(b.mmdName)
    if (!tp) continue
    const arr = mappedChildren.get(tp)
    if (arr) arr.push(b)
    else mappedChildren.set(tp, [b])
  }

  for (const bone of mappedBones) {
    if (CONTROL_BONES.has(bone.mmdName)) continue
    const children = mappedChildren.get(bone.mmdName)
    const mmdPos = targetPos[bone.mmdName]
    if (!children || children.length === 0 || !mmdPos) continue

    const dSrc: V3 = [0, 0, 0]
    const dMmd: V3 = [0, 0, 0]
    let usable = 0
    for (const c of children) {
      const cMmdPos = targetPos[c.mmdName]
      if (!cMmdPos) continue
      const ep = bindWorldPos[bone.srcIdx]
      const ec = bindWorldPos[c.srcIdx]
      dSrc[0] += ec[0] - ep[0]; dSrc[1] += ec[1] - ep[1]; dSrc[2] += ec[2] - ep[2]
      dMmd[0] += cMmdPos[0] - mmdPos[0]; dMmd[1] += cMmdPos[1] - mmdPos[1]; dMmd[2] += cMmdPos[2] - mmdPos[2]
      usable++
    }
    if (usable === 0) continue
    const lSrc = Math.hypot(dSrc[0], dSrc[1], dSrc[2])
    const lMmd = Math.hypot(dMmd[0], dMmd[1], dMmd[2])
    // Tiny averages mean the children straddle the bone (下半身's legs + spine
    // nearly cancel) — no meaningful segment direction.
    if (lSrc < 1e-4 || lMmd < 1e-4) continue
    const uSrc: V3 = [dSrc[0] / lSrc, dSrc[1] / lSrc, dSrc[2] / lSrc]
    const uMmd: V3 = [dMmd[0] / lMmd, dMmd[1] / lMmd, dMmd[2] / lMmd]
    const dot = uSrc[0] * uMmd[0] + uSrc[1] * uMmd[1] + uSrc[2] * uMmd[2]
    bone.alignDot = dot
    if (dot <= 0) continue

    // W_target = Δ · conj(F) needs conj(F)·d_mmd = d_src, i.e. F·d_src = d_mmd.
    bone.frameAlign = q4FromTo(uSrc, uMmd)
  }

  // Fingers: per-segment absolute alignment is ill-conditioned — the source
  // binds fingers curled while MMD binds them straight (dot ≈ 0.1–0.3), so the
  // shortest arc picks near-arbitrary bend planes and some poses hyperextend
  // backward. Inherit the wrist's F instead: q_vmd then equals the source's
  // hand-relative finger rotation conjugated into the aligned hand frame — the
  // bend axis comes from the source's actual motion, never from a bind arc.
  const byMmdName = new Map(mappedBones.map((b) => [b.mmdName, b]))
  for (const bone of mappedBones) {
    if (!bone.mmdName.includes("指")) continue
    let anchor: MappedBone | undefined
    let p = bone.parentMmdName
    while (p) {
      const pb = byMmdName.get(p)
      if (!pb) break
      if (!pb.mmdName.includes("指")) {
        anchor = pb
        break
      }
      p = pb.parentMmdName
    }
    bone.frameAlign = anchor?.frameAlign ?? null
  }

  const translationExports = (options.translationExports ?? []).flatMap((t) => {
    const srcIdx = nameToIdx.get(t.srcBone)
    if (srcIdx === undefined) return []
    const subtractSrcIdx = t.subtractSrcBone !== undefined ? nameToIdx.get(t.subtractSrcBone) ?? -1 : -1
    if (t.subtractSrcBone !== undefined && subtractSrcIdx < 0) return []
    return [{ ...t, srcIdx, subtractSrcIdx }]
  })

  return {
    source,
    mappedBones,
    bindWorldRot,
    bindWorldPos,
    positionScale: options.positionScale,
    translationExports,
    refPoseBias: options.refPoseBias ?? {},
  }
}

/* ============================================================================
 * Per-frame retarget.
 * ========================================================================= */

export function retargetCoreFrame(ctx: RetargetCoreContext, frameIdx: number): FrameResult {
  const { source, mappedBones, bindWorldRot, bindWorldPos } = ctx
  const bones = source.bones
  const n = bones.length
  if (frameIdx < 0 || frameIdx >= source.numFrames) return { rotations: {}, positions: {} }

  // Step 1: animated local transforms (sampler, falling back to bind).
  const animLocal: Q4[] = new Array(n)
  const animLocalPos: V3[] = new Array(n)
  for (let i = 0; i < n; i++) {
    const s = source.sample(i, frameIdx)
    if (s) {
      animLocal[i] = s.rot
      animLocalPos[i] = s.pos
    } else {
      animLocal[i] = bones[i].bindLocalRot
      animLocalPos[i] = bones[i].bindLocalPos
    }
  }

  // Step 2: FK → animated source world rotations.
  const animWorldRot = fkWorldRotations(bones, animLocal)

  // Step 3: per mapped bone, absolute-pose alignment (see module doc).
  const targetByMmd: Record<string, Q4> = {}
  for (const bone of mappedBones) {
    const delta = q4Mul(animWorldRot[bone.srcIdx], q4Conj(bindWorldRot[bone.srcIdx]))
    let target = bone.frameAlign ? q4Mul(delta, q4Conj(bone.frameAlign)) : delta
    const refBias = ctx.refPoseBias[bone.mmdName]
    if (refBias) target = q4Mul(target, refBias)
    targetByMmd[bone.mmdName] = q4Normalize(target)
  }

  // Step 4: q_vmd = W_target(mmd_parent)⁻¹ · W_target(bone).
  const rotations: Record<string, Quat> = {}
  for (const bone of mappedBones) {
    const target = targetByMmd[bone.mmdName]
    const parentTarget = bone.parentMmdName ? targetByMmd[bone.parentMmdName] : null
    const local = parentTarget ? q4Mul(q4Conj(parentTarget), target) : target
    const nq = q4Normalize(local)
    rotations[bone.mmdName] = new Quat(nq[0], nq[1], nq[2], nq[3])
  }

  // Step 5: translation exports (world displacement from bind, scaled).
  const positions: Record<string, Vec3> = {}
  if (ctx.translationExports.length > 0) {
    const worldPos = fkWorldPositions(bones, animLocal, animLocalPos)
    for (const t of ctx.translationExports) {
      const wp = worldPos[t.srcIdx]
      const bp = bindWorldPos[t.srcIdx]
      let d: V3 = [wp[0] - bp[0], wp[1] - bp[1], wp[2] - bp[2]]
      if (t.subtractSrcIdx >= 0) {
        const sw = worldPos[t.subtractSrcIdx]
        const sb = bindWorldPos[t.subtractSrcIdx]
        d = [d[0] - (sw[0] - sb[0]), d[1] - (sw[1] - sb[1]), d[2] - (sw[2] - sb[2])]
      }
      if (t.frameOfMmdBone) {
        const frame = targetByMmd[t.frameOfMmdBone]
        if (frame) d = q4Rot(q4Conj(frame), d)
      }
      positions[t.mmdBone] = new Vec3(d[0] * ctx.positionScale, d[1] * ctx.positionScale, d[2] * ctx.positionScale)
    }
  }

  return { rotations, positions }
}

/* ============================================================================
 * Clip assembly.
 * ========================================================================= */

export function retargetCoreClip(ctx: RetargetCoreContext, clipName: string): RetargetedClip {
  const { source } = ctx
  const times = Array.from({ length: source.numFrames }, (_, i) => i / source.fps)
  const boneQuats: Record<string, Quat[]> = {}
  const bonePositions: Record<string, Vec3[]> = {}

  for (let f = 0; f < source.numFrames; f++) {
    const { rotations, positions } = retargetCoreFrame(ctx, f)
    for (const [name, q] of Object.entries(rotations)) {
      if (!boneQuats[name]) boneQuats[name] = []
      boneQuats[name].push(q)
    }
    for (const [name, p] of Object.entries(positions)) {
      if (!bonePositions[name]) bonePositions[name] = []
      bonePositions[name].push(p)
    }
  }

  const srcNameByMmd = new Map(ctx.mappedBones.map((b) => [b.mmdName, b.srcName]))
  const boneTracks: RetargetedBoneTrack[] = []
  for (const [mmdName, quats] of Object.entries(boneQuats)) {
    boneTracks.push({ name: mmdName, originalName: srcNameByMmd.get(mmdName) ?? mmdName, times: [...times], quats })
  }

  const positionTracks: RetargetedPositionTrack[] = []
  for (const [mmdName, positions] of Object.entries(bonePositions)) {
    if (positions.length !== source.numFrames) continue
    const exp = ctx.translationExports.find((t) => t.mmdBone === mmdName)
    positionTracks.push({ name: mmdName, originalName: exp?.srcBone ?? mmdName, times: [...times], positions })
  }

  return {
    name: clipName,
    duration: source.numFrames / source.fps,
    fps: source.fps,
    boneTracks,
    positionTracks,
  }
}
