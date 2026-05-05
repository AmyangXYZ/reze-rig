import { Quat, Vec3 } from 'reze-engine';
import type { AnimationClip, BoneRestPose, BoneTrack } from './fbx';

// ============================================================
// Textbook skeletal retarget (rotation-based, identity target bind).
//
// Per source bone b with FBX `Pre` / `Post` rotations and Lcl key q:
//   LBP_b = qPre · qLclBind · qPost⁻¹                  (parent-local rest)
//   LP_b(t) = qPre · qLcl(t) · qPost⁻¹                 (parent-local at time t)
//   WB_b = WB_parent · LBP_b                            (world rest, BFS)
//   W_b(t) = W_parent(t) · LP_b(t)                      (world at t, BFS)
//   Δworld_b(t) = W_b(t) · WB_b⁻¹                       (world delta from rest)
//
// MMD target bones bind = identity (the PMX is in T-pose, no per-bone bind orientation).
// Therefore target world rotation = axisSwap(Δworld_b(t)), and the VMD parent-local key
// is WT_parent(t)⁻¹ · WT_b(t) — propagated only through bones that exist in BONE_MAP.
// (Source-side propagation includes a `Root` bone above Hips for Unity exports; MMD output
// drops it because the MMD model has no equivalent.)
// ============================================================

/** UE / Unity Humanoid → canonical Mixamo-style bone names. */
const UE_MANNEQUIN_TO_MIXAMO: Record<string, string> = {
	root: 'Root',
	pelvis: 'Hips',
	spine_01: 'Spine',
	spine_02: 'Spine1',
	spine_03: 'Spine2',
	neck_01: 'Neck',
	head: 'Head',
	clavicle_r: 'RightShoulder',
	upperarm_r: 'RightArm',
	lowerarm_r: 'RightForeArm',
	hand_r: 'RightHand',
	clavicle_l: 'LeftShoulder',
	upperarm_l: 'LeftArm',
	lowerarm_l: 'LeftForeArm',
	hand_l: 'LeftHand',
	thigh_r: 'RightUpLeg',
	calf_r: 'RightLeg',
	foot_r: 'RightFoot',
	ball_r: 'RightToeBase',
	thigh_l: 'LeftUpLeg',
	calf_l: 'LeftLeg',
	foot_l: 'LeftFoot',
	ball_l: 'LeftToeBase',
	thumb_01_r: 'RightHandThumb1',
	thumb_02_r: 'RightHandThumb2',
	thumb_03_r: 'RightHandThumb3',
	index_01_r: 'RightHandIndex1',
	index_02_r: 'RightHandIndex2',
	index_03_r: 'RightHandIndex3',
	middle_01_r: 'RightHandMiddle1',
	middle_02_r: 'RightHandMiddle2',
	middle_03_r: 'RightHandMiddle3',
	ring_01_r: 'RightHandRing1',
	ring_02_r: 'RightHandRing2',
	ring_03_r: 'RightHandRing3',
	pinky_01_r: 'RightHandPinky1',
	pinky_02_r: 'RightHandPinky2',
	pinky_03_r: 'RightHandPinky3',
	thumb_01_l: 'LeftHandThumb1',
	thumb_02_l: 'LeftHandThumb2',
	thumb_03_l: 'LeftHandThumb3',
	index_01_l: 'LeftHandIndex1',
	index_02_l: 'LeftHandIndex2',
	index_03_l: 'LeftHandIndex3',
	middle_01_l: 'LeftHandMiddle1',
	middle_02_l: 'LeftHandMiddle2',
	middle_03_l: 'LeftHandMiddle3',
	ring_01_l: 'LeftHandRing1',
	ring_02_l: 'LeftHandRing2',
	ring_03_l: 'LeftHandRing3',
	pinky_01_l: 'LeftHandPinky1',
	pinky_02_l: 'LeftHandPinky2',
	pinky_03_l: 'LeftHandPinky3',
};

/** Canonical Mixamo-style name → MMD/PMX bone name (target VMD output). */
const BONE_MAP: Record<string, string> = {
	Hips: 'センター',
	Spine: '腰',
	Spine1: '上半身',
	Spine2: '上半身2',
	Neck: '首',
	Head: '頭',
	RightShoulder: '右肩',
	RightArm: '右腕',
	RightForeArm: '右ひじ',
	RightHand: '右手首',
	LeftShoulder: '左肩',
	LeftArm: '左腕',
	LeftForeArm: '左ひじ',
	LeftHand: '左手首',
	RightUpLeg: '右足',
	RightLeg: '右ひざ',
	RightFoot: '右足首',
	RightToeBase: '右足先EX',
	LeftUpLeg: '左足',
	LeftLeg: '左ひざ',
	LeftFoot: '左足首',
	LeftToeBase: '左足先EX',
	RightHandThumb1: '右親指１',
	RightHandThumb2: '右親指２',
	RightHandThumb3: '右親指３',
	RightHandIndex1: '右人指１',
	RightHandIndex2: '右人指２',
	RightHandIndex3: '右人指３',
	RightHandMiddle1: '右中指１',
	RightHandMiddle2: '右中指２',
	RightHandMiddle3: '右中指３',
	RightHandRing1: '右薬指１',
	RightHandRing2: '右薬指２',
	RightHandRing3: '右薬指３',
	RightHandPinky1: '右小指１',
	RightHandPinky2: '右小指２',
	RightHandPinky3: '右小指３',
	LeftHandThumb1: '左親指１',
	LeftHandThumb2: '左親指２',
	LeftHandThumb3: '左親指３',
	LeftHandIndex1: '左人指１',
	LeftHandIndex2: '左人指２',
	LeftHandIndex3: '左人指３',
	LeftHandMiddle1: '左中指１',
	LeftHandMiddle2: '左中指２',
	LeftHandMiddle3: '左中指３',
	LeftHandRing1: '左薬指１',
	LeftHandRing2: '左薬指２',
	LeftHandRing3: '左薬指３',
	LeftHandPinky1: '左小指１',
	LeftHandPinky2: '左小指２',
	LeftHandPinky3: '左小指３',
};

/**
 * Source-side hierarchy keyed by canonical name. `Root` is included so Unity exports
 * (root → pelvis) propagate the scene-root rotation into Hips world rest/animation.
 * Mixamo clips have no `root` track — Root just contributes identity.
 */
const SOURCE_PARENT: Record<string, string | null> = {
	Root: null,
	Hips: 'Root',
	Spine: 'Hips',
	Spine1: 'Spine',
	Spine2: 'Spine1',
	Neck: 'Spine2',
	Head: 'Neck',
	LeftShoulder: 'Spine2',
	LeftArm: 'LeftShoulder',
	LeftForeArm: 'LeftArm',
	LeftHand: 'LeftForeArm',
	RightShoulder: 'Spine2',
	RightArm: 'RightShoulder',
	RightForeArm: 'RightArm',
	RightHand: 'RightForeArm',
	LeftUpLeg: 'Hips',
	LeftLeg: 'LeftUpLeg',
	LeftFoot: 'LeftLeg',
	LeftToeBase: 'LeftFoot',
	RightUpLeg: 'Hips',
	RightLeg: 'RightUpLeg',
	RightFoot: 'RightLeg',
	RightToeBase: 'RightFoot',
	LeftHandThumb1: 'LeftHand',  LeftHandThumb2: 'LeftHandThumb1',  LeftHandThumb3: 'LeftHandThumb2',
	LeftHandIndex1: 'LeftHand',  LeftHandIndex2: 'LeftHandIndex1',  LeftHandIndex3: 'LeftHandIndex2',
	LeftHandMiddle1: 'LeftHand', LeftHandMiddle2: 'LeftHandMiddle1', LeftHandMiddle3: 'LeftHandMiddle2',
	LeftHandRing1: 'LeftHand',   LeftHandRing2: 'LeftHandRing1',    LeftHandRing3: 'LeftHandRing2',
	LeftHandPinky1: 'LeftHand',  LeftHandPinky2: 'LeftHandPinky1',  LeftHandPinky3: 'LeftHandPinky2',
	RightHandThumb1: 'RightHand',  RightHandThumb2: 'RightHandThumb1',  RightHandThumb3: 'RightHandThumb2',
	RightHandIndex1: 'RightHand',  RightHandIndex2: 'RightHandIndex1',  RightHandIndex3: 'RightHandIndex2',
	RightHandMiddle1: 'RightHand', RightHandMiddle2: 'RightHandMiddle1', RightHandMiddle3: 'RightHandMiddle2',
	RightHandRing1: 'RightHand',   RightHandRing2: 'RightHandRing1',    RightHandRing3: 'RightHandRing2',
	RightHandPinky1: 'RightHand',  RightHandPinky2: 'RightHandPinky1',  RightHandPinky3: 'RightHandPinky2',
};

// ============================================================
// Output types (consumed by lib/vmd-writer.ts)
// ============================================================

export interface RetargetedBoneTrack {
	name: string;
	originalName: string;
	times: number[];
	quats: Quat[];
}

export interface RetargetedPositionTrack {
	name: string;
	originalName: string;
	times: number[];
	positions: Vec3[];
}

export interface RetargetedClip {
	name: string;
	duration: number;
	fps: number;
	boneTracks: RetargetedBoneTrack[];
	positionTracks: RetargetedPositionTrack[];
}

export const POSITION_SCALE = 1 / 12.5;
export const POSITION_OFFSET_Y = -8.3;

// ============================================================
// Quaternion helpers
// ============================================================

function quatIdentity(): Quat {
	return new Quat(0, 0, 0, 1);
}

function quatInverse(q: Quat): Quat {
	return new Quat(-q.x, -q.y, -q.z, q.w);
}

function eulerToQuatZXY(x: number, y: number, z: number): Quat {
	const cz = Math.cos(z / 2), cx = Math.cos(x / 2), cy = Math.cos(y / 2);
	const sz = Math.sin(z / 2), sx = Math.sin(x / 2), sy = Math.sin(y / 2);
	return new Quat(
		sx * cy * cz - cx * sy * sz,
		cx * sy * cz + sx * cy * sz,
		cx * cy * sz - sx * sy * cz,
		cx * cy * cz + sx * sy * sz,
	).normalize();
}

/** Intrinsic ZYX (Three.FBXLoader convention for Pre/Post Rotation). */
function eulerToQuatIntrinsicZYX(x: number, y: number, z: number): Quat {
	const c1 = Math.cos(x / 2), s1 = Math.sin(x / 2);
	const c2 = Math.cos(y / 2), s2 = Math.sin(y / 2);
	const c3 = Math.cos(z / 2), s3 = Math.sin(z / 2);
	return new Quat(
		s1 * c2 * c3 - c1 * s2 * s3,
		c1 * s2 * c3 + s1 * c2 * s3,
		c1 * c2 * s3 - s1 * s2 * c3,
		c1 * c2 * c3 + s1 * s2 * s3,
	).normalize();
}

function preQuat(rest: BoneRestPose | null): Quat {
	if (!rest?.preRotation) return quatIdentity();
	return eulerToQuatIntrinsicZYX(rest.preRotation[0], rest.preRotation[1], rest.preRotation[2]);
}

function postQuatInv(rest: BoneRestPose | null): Quat {
	if (!rest?.postRotation) return quatIdentity();
	const q = eulerToQuatIntrinsicZYX(rest.postRotation[0], rest.postRotation[1], rest.postRotation[2]);
	return quatInverse(q);
}

function lclBindQuat(rest: BoneRestPose | null): Quat {
	if (!rest?.lclRotation) return quatIdentity();
	return eulerToQuatZXY(rest.lclRotation[0], rest.lclRotation[1], rest.lclRotation[2]);
}

/** qPre · q · qPost⁻¹ — applied to either bind Lcl or per-frame Lcl identically. */
function applyPrePost(q: Quat, pre: Quat, postInv: Quat): Quat {
	return pre.clone().multiply(q).multiply(postInv);
}

/**
 * Map FBX-frame world quaternion → engine MMD-frame quaternion. Empirically `(x, y, -z, -w)`
 * (mirrors X & Y axes; equivalent to a right-handed → left-handed Y-up swap on rotation sign).
 * Same swap the legacy retarget used; left intact for parity with the working Mixamo path.
 */
function fbxWorldToMmd(q: Quat): Quat {
	return new Quat(q.x, q.y, -q.z, -q.w);
}

// ---------- A-pose target-bind compensation ----------
// MMD model mesh is skinned in A-pose: at "bone identity" the arms display rotated ~35°
// down. To make source's bind pose display as itself on the MMD mesh, we post-multiply each
// arm-chain bone's MMD-frame world rotation by a per-side BIAS — the rotation that takes the
// MMD mesh's natural A-pose arm direction to the source's actual bind arm direction. With
// cross-bone parent propagation enabled (parent_target_world subtracted when computing each
// child's local), the parent's bias is automatically undone in the child's local rotation —
// no manual "undo" pre-multiply needed. The bias becomes identity when the source rig is
// already in A-pose.
const ARM_ANGLE_RAD = (35 * Math.PI) / 180;

/** MMD mesh A-pose direction (in MMD frame: +X right, +Y up, +Z forward). */
const MMD_LEFT_ARM_DIR_AT_BIND: [number, number, number] = [Math.cos(ARM_ANGLE_RAD), -Math.sin(ARM_ANGLE_RAD), 0];
const MMD_RIGHT_ARM_DIR_AT_BIND: [number, number, number] = [-Math.cos(ARM_ANGLE_RAD), -Math.sin(ARM_ANGLE_RAD), 0];

const LEFT_ARM_CHAIN = [
	'LeftArm', 'LeftForeArm', 'LeftHand',
	'LeftHandThumb1', 'LeftHandThumb2', 'LeftHandThumb3',
	'LeftHandIndex1', 'LeftHandIndex2', 'LeftHandIndex3',
	'LeftHandMiddle1', 'LeftHandMiddle2', 'LeftHandMiddle3',
	'LeftHandRing1', 'LeftHandRing2', 'LeftHandRing3',
	'LeftHandPinky1', 'LeftHandPinky2', 'LeftHandPinky3',
];
const RIGHT_ARM_CHAIN = [
	'RightArm', 'RightForeArm', 'RightHand',
	'RightHandThumb1', 'RightHandThumb2', 'RightHandThumb3',
	'RightHandIndex1', 'RightHandIndex2', 'RightHandIndex3',
	'RightHandMiddle1', 'RightHandMiddle2', 'RightHandMiddle3',
	'RightHandRing1', 'RightHandRing2', 'RightHandRing3',
	'RightHandPinky1', 'RightHandPinky2', 'RightHandPinky3',
];

function rotateVec3ByQuat(v: [number, number, number], q: Quat): [number, number, number] {
	const px = v[0], py = v[1], pz = v[2];
	const qx = q.x, qy = q.y, qz = q.z, qw = q.w;
	const tx = 2 * (qy * pz - qz * py);
	const ty = 2 * (qz * px - qx * pz);
	const tz = 2 * (qx * py - qy * px);
	return [
		px + qw * tx + (qy * tz - qz * ty),
		py + qw * ty + (qz * tx - qx * tz),
		pz + qw * tz + (qx * ty - qy * tx),
	];
}

/** Shortest-arc rotation that takes unit vector `from` to unit vector `to`. */
function quatFromVec3(from: [number, number, number], to: [number, number, number]): Quat {
	const fl = Math.hypot(from[0], from[1], from[2]) || 1;
	const tl = Math.hypot(to[0], to[1], to[2]) || 1;
	const fx = from[0] / fl, fy = from[1] / fl, fz = from[2] / fl;
	const tx = to[0] / tl, ty = to[1] / tl, tz = to[2] / tl;
	const dot = fx * tx + fy * ty + fz * tz;
	if (dot >= 0.999999) return quatIdentity();
	if (dot <= -0.999999) {
		// Antiparallel: 180° rotation around any perpendicular axis.
		const perp: [number, number, number] = Math.abs(fx) < 0.9 ? [1, 0, 0] : [0, 1, 0];
		const ax = fy * perp[2] - fz * perp[1];
		const ay = fz * perp[0] - fx * perp[2];
		const az = fx * perp[1] - fy * perp[0];
		const al = Math.hypot(ax, ay, az) || 1;
		return new Quat(ax / al, ay / al, az / al, 0);
	}
	const cx = fy * tz - fz * ty;
	const cy = fz * tx - fx * tz;
	const cz = fx * ty - fy * tx;
	return new Quat(cx, cy, cz, 1 + dot).normalize();
}

/** Pick the dominant axis of `v` (returned with sign) — used to detect bone-axis from child translation. */
function dominantAxis(v: [number, number, number]): [number, number, number] {
	const ax = Math.abs(v[0]), ay = Math.abs(v[1]), az = Math.abs(v[2]);
	if (ax >= ay && ax >= az) return [Math.sign(v[0]) || 1, 0, 0];
	if (ay >= az) return [0, Math.sign(v[1]) || 1, 0];
	return [0, 0, Math.sign(v[2]) || 1];
}

/** Mirror a vector across the FBX→MMD axis swap (Z negation), matching `fbxWorldToMmd` for vectors. */
function fbxVecToMmd(v: [number, number, number]): [number, number, number] {
	return [v[0], v[1], -v[2]];
}

// ============================================================
// Bone name canonicalization
// ============================================================

function canonicalizeBoneName(rawName: string): string {
	const stripped = rawName.replace(/^mixamorig:/i, '').trim();
	const ueKey = stripped.toLowerCase();
	return UE_MANNEQUIN_TO_MIXAMO[ueKey] ?? stripped;
}

// ============================================================
// Per-clip rest-pose resolution
// ============================================================

interface BoneInfo {
	rest: BoneRestPose | null;
	pre: Quat;
	postInv: Quat;
	lclBind: Quat;
	/** Parent-local rest orientation: qPre · qLclBind · qPost⁻¹. */
	parentLocalBind: Quat;
	/** Cumulative world rest orientation in source FBX frame. */
	worldBind: Quat;
}

function buildBoneInfoMap(clip: AnimationClip, bindRef?: Map<string, BoneRestPose> | null): Map<string, BoneInfo> {
	const restByCanonical = new Map<string, BoneRestPose | null>();
	for (const t of clip.tracks) {
		const c = canonicalizeBoneName(t.name);
		if (restByCanonical.has(c)) continue;
		// Prefer bind-reference rest when provided. Per-clip rest pose in some Unity/UE
		// exports (e.g., mid-cycle "stride pose" clips) is a snapshot of frame 0 rather
		// than the canonical T/A bind, which makes the world-delta computation reference
		// the wrong baseline. The bind reference (extracted from a known-good clip such
		// as Idle.fbx) gives the actual canonical bind for the rig.
		const ref = bindRef?.get(c);
		restByCanonical.set(c, ref ?? t.restPose ?? null);
	}

	// BFS topological order: parent before child.
	const order: string[] = [];
	const seen = new Set<string>();
	const visit = (b: string): void => {
		if (seen.has(b)) return;
		const p = SOURCE_PARENT[b];
		if (p) visit(p);
		seen.add(b);
		order.push(b);
	};
	for (const b of Object.keys(SOURCE_PARENT)) visit(b);

	const out = new Map<string, BoneInfo>();
	for (const b of order) {
		const rest = restByCanonical.get(b) ?? null;
		const pre = preQuat(rest);
		const postInv = postQuatInv(rest);
		const lclBind = lclBindQuat(rest);
		const parentLocalBind = applyPrePost(lclBind, pre, postInv);
		const parent = SOURCE_PARENT[b];
		const parentWB = parent ? out.get(parent)?.worldBind ?? quatIdentity() : quatIdentity();
		const worldBind = parentWB.clone().multiply(parentLocalBind);
		out.set(b, { rest, pre, postInv, lclBind, parentLocalBind, worldBind });
	}
	return out;
}

// ============================================================
// Sampling
// ============================================================

function sampleBoneTrack(track: BoneTrack, time: number): Quat {
	if (track.times.length === 0) return quatIdentity();
	const idx = track.times.findIndex(t => t >= time);
	if (idx === -1) {
		const last = track.quats[track.quats.length - 1];
		return new Quat(last.x, last.y, last.z, last.w);
	}
	if (idx === 0 || track.times[idx] === time) {
		const q = track.quats[idx];
		return new Quat(q.x, q.y, q.z, q.w);
	}
	const t0 = track.times[idx - 1];
	const t1 = track.times[idx];
	const u = (time - t0) / (t1 - t0);
	const q0 = track.quats[idx - 1];
	const q1 = track.quats[idx];
	let dot = q0.x * q1.x + q0.y * q1.y + q0.z * q1.z + q0.w * q1.w;
	let q1x = q1.x, q1y = q1.y, q1z = q1.z, q1w = q1.w;
	if (dot < 0) {
		q1x = -q1x; q1y = -q1y; q1z = -q1z; q1w = -q1w;
		dot = -dot;
	}
	if (dot > 0.9995) {
		return new Quat(
			q0.x + (q1x - q0.x) * u,
			q0.y + (q1y - q0.y) * u,
			q0.z + (q1z - q0.z) * u,
			q0.w + (q1w - q0.w) * u,
		).normalize();
	}
	const angle = Math.acos(Math.min(1, dot));
	const sinA = Math.sin(angle);
	const w0 = Math.sin((1 - u) * angle) / sinA;
	const w1 = Math.sin(u * angle) / sinA;
	return new Quat(
		w0 * q0.x + w1 * q1x,
		w0 * q0.y + w1 * q1y,
		w0 * q0.z + w1 * q1z,
		w0 * q0.w + w1 * q1w,
	).normalize();
}

// ============================================================
// Retarget
// ============================================================

function calculateDuration(clip: AnimationClip): number {
	if (clip.duration > 0) return clip.duration;
	let max = 0;
	for (const t of clip.tracks) for (const tt of t.times) if (tt > max) max = tt;
	for (const p of clip.positionTracks ?? []) for (const tt of p.times) if (tt > max) max = tt;
	return max;
}

const dumpedClips = new Set<string>();

function dumpWorldBindOnce(clipName: string, info: Map<string, BoneInfo>): void {
	if (dumpedClips.has(clipName)) return;
	dumpedClips.add(clipName);
	const fmt = (q: Quat): [number, number, number, number] =>
		[Number(q.x.toFixed(5)), Number(q.y.toFixed(5)), Number(q.z.toFixed(5)), Number(q.w.toFixed(5))];
	const wb: Record<string, [number, number, number, number]> = {};
	const lbp: Record<string, [number, number, number, number]> = {};
	const lcl: Record<string, [number, number, number, number]> = {};
	for (const b of ['Root', ...Object.keys(BONE_MAP)]) {
		const i = info.get(b);
		if (!i) continue;
		wb[b] = fmt(i.worldBind);
		lbp[b] = fmt(i.parentLocalBind);
		lcl[b] = fmt(i.lclBind);
	}
	console.log(`[retarget] "${clipName}" worldBind:`, wb);
	console.log(`[retarget] "${clipName}" parentLocalBind:`, lbp);
	console.log(`[retarget] "${clipName}" lclBind:`, lcl);
}

/**
 * Detect the rig's bone-forward axis once per clip — Mixamo uses bone-Y, UE-Mannequin
 * uses bone-X. We probe well-known limb children whose `lclTranslation` (in the parent's
 * local frame) is the bone's forward direction, falling back to bone-Y if nothing usable
 * is available. Mixamo's exporter writes `null` rest pose for any joint whose `lclRotation`
 * is exactly zero — including `RightForeArm`, `RightLeg`, etc. — so per-bone detection
 * misses; using a rig-wide default keeps both arms in sync.
 */
function detectLimbAxis(info: Map<string, BoneInfo>): [number, number, number] {
	const probes = [
		'LeftForeArm', 'RightForeArm', 'LeftArm', 'RightArm',
		'LeftLeg', 'RightLeg', 'LeftFoot', 'RightFoot',
		'Spine1', 'Spine2', 'Spine',
	];
	for (const c of probes) {
		const t = info.get(c)?.rest?.lclTranslation;
		if (!t) continue;
		if (Math.hypot(t[0], t[1], t[2]) < 0.5) continue;
		return dominantAxis(t);
	}
	return [0, 1, 0];
}

/**
 * Calibrate the per-side A-pose bias from the source rig's bind pose. We take the
 * rig-wide bone-forward axis through the arm bone's `worldBind` to get the arm's bind
 * direction in source world, map it to the MMD frame, and return the rotation that
 * takes the MMD mesh's A-pose arm direction onto that source direction. Mixamo (T-pose)
 * → ~35° around Z; UE-Mannequin / Unity Humanoid (A-pose) → ~identity.
 */
function computeArmBias(
	armBone: string,
	tipAxis: [number, number, number],
	mmdMeshDir: [number, number, number],
	info: Map<string, BoneInfo>,
): Quat {
	const armInfo = info.get(armBone);
	if (!armInfo) return quatIdentity();
	const srcDir = rotateVec3ByQuat(tipAxis, armInfo.worldBind);
	const srcDirMmd = fbxVecToMmd(srcDir);
	return quatFromVec3(mmdMeshDir, srcDirMmd);
}

export interface RetargetOptions {
	/**
	 * Override rest poses keyed by canonical bone name. When provided, the retarget
	 * uses these instead of each clip's own track `restPose`. Some Unity/UE per-pose
	 * exports (e.g., mid-cycle "stride pose" clips) embed the first animation frame
	 * as the rest pose, which makes "delta from rest" reference the wrong baseline.
	 * Building this map from a known-good clip (an idle, or the rig's bind/T-pose
	 * file) gives the retarget a stable canonical bind to subtract against.
	 */
	bindReference?: Map<string, BoneRestPose> | null;
}

/**
 * Whether a clip's bones look like UE-Mannequin / Unity Humanoid (vs Mixamo). We probe
 * names that are unique to UE-Mannequin (e.g., `pelvis`, `spine_01`, `upperarm_l`) —
 * not generics like `head` that both rigs share.
 */
const UE_DISTINCTIVE_NAMES = new Set([
	'pelvis', 'spine_01', 'spine_02', 'spine_03', 'neck_01',
	'clavicle_l', 'clavicle_r', 'upperarm_l', 'upperarm_r',
	'lowerarm_l', 'lowerarm_r', 'thigh_l', 'thigh_r', 'calf_l', 'calf_r',
]);
export function isUEMannequinClip(clip: AnimationClip): boolean {
	for (const t of clip.tracks) {
		const stripped = t.name.replace(/^mixamorig:/i, '').trim().toLowerCase();
		if (UE_DISTINCTIVE_NAMES.has(stripped)) return true;
	}
	return false;
}

/** Extract a canonical-bone-name → BoneRestPose map from a clip whose first frame is the bind. */
export function buildBindReferenceFromClip(clip: AnimationClip): Map<string, BoneRestPose> {
	const map = new Map<string, BoneRestPose>();
	for (const t of clip.tracks) {
		if (!t.restPose) continue;
		const c = canonicalizeBoneName(t.name);
		if (!map.has(c)) map.set(c, t.restPose);
	}
	return map;
}

export function retargetClips(clips: AnimationClip[], opts?: RetargetOptions): RetargetedClip[] {
	return clips.map(c => retargetOneClip(c, opts));
}

function retargetOneClip(clip: AnimationClip, opts?: RetargetOptions): RetargetedClip {
	const duration = calculateDuration(clip);
	// Apply the bind reference only when it actually matches the rig — using a UE
	// reference on a Mixamo clip (or vice versa) would corrupt the bind because the
	// two encode bind orientation differently (Mixamo: Pre/Post + identity Lcl;
	// UE: large Lcl, no Pre/Post).
	const useBindRef = opts?.bindReference && isUEMannequinClip(clip) ? opts.bindReference : null;
	const info = buildBoneInfoMap(clip, useBindRef);
	dumpWorldBindOnce(clip.name, info);

	// First track per canonical name (raw FBX may have e.g. mixamorig:Hips and a duplicate model node).
	const animByCanonical = new Map<string, BoneTrack>();
	for (const t of clip.tracks) {
		const c = canonicalizeBoneName(t.name);
		if (SOURCE_PARENT[c] !== undefined && !animByCanonical.has(c)) {
			animByCanonical.set(c, t);
		}
	}

	// Per-side arm bias, derived from the source rig's bind. Maps the MMD mesh's
	// natural A-pose arm direction onto the source's actual bind arm direction so the
	// source's rest pose displays as itself on the A-pose-skinned MMD mesh. T-pose source
	// → ~35° around Z; A-pose source → ~identity. We use a rig-wide bone-axis detection
	// because Mixamo's exporter omits rest data for zero-rotation joints (e.g. RightForeArm).
	const limbAxis = detectLimbAxis(info);
	const armBiasL = computeArmBias('LeftArm', limbAxis, MMD_LEFT_ARM_DIR_AT_BIND, info);
	const armBiasR = computeArmBias('RightArm', limbAxis, MMD_RIGHT_ARM_DIR_AT_BIND, info);
	const MMD_BIND_BIAS: Record<string, Quat> = {};
	for (const b of LEFT_ARM_CHAIN) MMD_BIND_BIAS[b] = armBiasL;
	for (const b of RIGHT_ARM_CHAIN) MMD_BIND_BIAS[b] = armBiasR;

	// MMD parent chain: same as SOURCE_PARENT minus the synthetic Root link above Hips.
	const mmdParentOf = (b: string): string | null => {
		const p = SOURCE_PARENT[b];
		return p && p !== 'Root' ? p : null;
	};

	// Sample source world rotation at any time t by walking the canonical source chain.
	// Memoized per (bone, time) to keep recursion linear.
	const srcWorldCache = new Map<string, Quat>();
	const srcWorldAt = (b: string, t: number): Quat => {
		const key = b + '@' + t;
		const cached = srcWorldCache.get(key);
		if (cached) return cached.clone();
		const parent = SOURCE_PARENT[b] ?? null;
		const parentW = parent ? srcWorldAt(parent, t) : quatIdentity();
		const bInfo = info.get(b);
		if (!bInfo) {
			srcWorldCache.set(key, parentW.clone());
			return parentW;
		}
		const track = animByCanonical.get(b);
		const lcl = track ? sampleBoneTrack(track, t) : bInfo.lclBind.clone();
		const lp = applyPrePost(lcl, bInfo.pre, bInfo.postInv);
		const w = parentW.clone().multiply(lp);
		srcWorldCache.set(key, w.clone());
		return w;
	};

	// Target (MMD-frame) world rotation of canonical bone b at time t:
	//   axisSwap(WS(t) · WB⁻¹) · BIAS[b]
	const tgtWorldCache = new Map<string, Quat>();
	const tgtWorldAt = (b: string, t: number): Quat => {
		const key = b + '@' + t;
		const cached = tgtWorldCache.get(key);
		if (cached) return cached.clone();
		const ws = srcWorldAt(b, t);
		const bInfo = info.get(b);
		if (!bInfo) {
			tgtWorldCache.set(key, ws.clone());
			return ws;
		}
		const dW = ws.clone().multiply(quatInverse(bInfo.worldBind));
		let q = fbxWorldToMmd(dW);
		const bias = MMD_BIND_BIAS[b];
		if (bias) q = q.multiply(bias);
		tgtWorldCache.set(key, q.clone());
		return q;
	};

	const outBoneTracks: RetargetedBoneTrack[] = [];

	for (const b of Object.keys(BONE_MAP)) {
		const track = animByCanonical.get(b);
		if (!track) continue;

		// Cross-bone propagation: each MMD bone's local = parent_target_world(t)⁻¹ · target_world(t).
		// This subtracts the parent's accumulated rotation (including bias) so the runtime engine's
		// parent_runtime · child_local recomposition equals the desired source world delta.
		const parentB = mmdParentOf(b);
		const quats: Quat[] = track.times.map((t) => {
			const tgtW = tgtWorldAt(b, t);
			const parentW = parentB ? tgtWorldAt(parentB, t) : quatIdentity();
			return quatInverse(parentW).multiply(tgtW);
		});

		outBoneTracks.push({
			name: BONE_MAP[b],
			originalName: track.original_name,
			times: track.times.slice(),
			quats,
		});
	}

	// Position track: only Hips (→ センター). Source FBX gives parent-local position; rotate
	// by source parent's world rotation at sample time so VMD receives world-space offset.
	const positionTracks: RetargetedPositionTrack[] = [];
	const hipsPos = (clip.positionTracks ?? []).find(p => canonicalizeBoneName(p.name) === 'Hips');
	if (hipsPos) {
		const hipsParent = SOURCE_PARENT['Hips'];
		const parentInfo = hipsParent ? info.get(hipsParent) ?? null : null;
		const parentTrack = hipsParent ? animByCanonical.get(hipsParent) ?? null : null;

		const positions: Vec3[] = [];
		for (let i = 0; i < hipsPos.times.length; i++) {
			const time = hipsPos.times[i];
			let parentW: Quat = quatIdentity();
			if (parentInfo) {
				const rawLcl = parentTrack ? sampleBoneTrack(parentTrack, time) : parentInfo.lclBind.clone();
				const lp = applyPrePost(rawLcl, parentInfo.pre, parentInfo.postInv);
				parentW = lp; // Root has no parent → world = local.
			}
			const local = hipsPos.positions[i];
			const worldFbx = rotateVec3ByQuat(local, parentW);
			positions.push(new Vec3(
				worldFbx[0] * POSITION_SCALE,
				worldFbx[1] * POSITION_SCALE + POSITION_OFFSET_Y,
				-worldFbx[2] * POSITION_SCALE,
			));
		}
		positionTracks.push({
			name: BONE_MAP['Hips'],
			originalName: hipsPos.original_name,
			times: hipsPos.times,
			positions,
		});
	}

	return {
		name: clip.name,
		duration,
		fps: 30,
		boneTracks: outBoneTracks,
		positionTracks,
	};
}
