import { Quat, Vec3 } from 'reze-engine';
import type { AnimationClip, BoneRestPose, BoneTrack } from './fbx';
import {
	createCoreContext,
	fkWorldPositions,
	q4Conj,
	q4FromTo,
	q4Mul,
	q4Normalize,
	q4Rot,
	retargetCoreClip,
	type Q4,
	type RetargetCoreContext,
	type RetargetedClip,
	type RetargetSource,
	type SourceBone,
	type V3,
} from './retarget-core';

/**
 * FBX → MMD frontend for the retarget core (lib/retarget-core.ts — the
 * algorithm and its derivation live there).
 *
 * This file owns what is FBX-specific:
 *  - name canonicalization (Mixamo prefix, UE-Mannequin / Unity-Humanoid table),
 *  - bind extraction from Pre/Post/Lcl rotations, with the bind-reference
 *    override for Unity per-pose exports whose "rest" is a stride snapshot,
 *  - topology from the file's real Connections hierarchy when present,
 *    falling back to the canonical humanoid table,
 *  - handedness: FBX is right-handed Y-up, MMD left-handed Y-up. Local
 *    rotations convert as q → (−x, −y, z, w) and translations as (x, y, −z);
 *    the conversion is conjugation by the Z-mirror, so converting every local
 *    before the core is equivalent to converting composed world transforms.
 *  - translation scale, auto-derived from the two skeletons' hip heights when
 *    the target model's bone positions are provided.
 */

export type { RetargetedClip, RetargetedBoneTrack, RetargetedPositionTrack } from './retarget-core';

/* ============================================================================
 * Name canonicalization (profiles).
 * ========================================================================= */

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

/**
 * 3ds Max Biped ("Bip001 L Thigh" style) → canonical Mixamo-style names. Keys are
 * the part after the Bip prefix, lowercased, separators normalized to one space.
 * Fingers: Finger0 = thumb … Finger4 = pinky, segments 01/02; Nub tips, Footsteps
 * and Twist helpers stay unmapped on purpose.
 */
const BIPED_TO_MIXAMO: Record<string, string> = {
	'pelvis': 'Hips',
	'spine': 'Spine',
	'spine1': 'Spine1',
	'spine2': 'Spine2',
	'spine3': 'Spine2',
	'neck': 'Neck',
	'neck1': 'Neck',
	'head': 'Head',
	'r clavicle': 'RightShoulder',
	'r upperarm': 'RightArm',
	'r forearm': 'RightForeArm',
	'r hand': 'RightHand',
	'l clavicle': 'LeftShoulder',
	'l upperarm': 'LeftArm',
	'l forearm': 'LeftForeArm',
	'l hand': 'LeftHand',
	'r thigh': 'RightUpLeg',
	'r calf': 'RightLeg',
	'r foot': 'RightFoot',
	'r toe0': 'RightToeBase',
	'l thigh': 'LeftUpLeg',
	'l calf': 'LeftLeg',
	'l foot': 'LeftFoot',
	'l toe0': 'LeftToeBase',
	'l finger0': 'LeftHandThumb1',
	'l finger01': 'LeftHandThumb2',
	'l finger02': 'LeftHandThumb3',
	'l finger1': 'LeftHandIndex1',
	'l finger11': 'LeftHandIndex2',
	'l finger12': 'LeftHandIndex3',
	'l finger2': 'LeftHandMiddle1',
	'l finger21': 'LeftHandMiddle2',
	'l finger22': 'LeftHandMiddle3',
	'l finger3': 'LeftHandRing1',
	'l finger31': 'LeftHandRing2',
	'l finger32': 'LeftHandRing3',
	'l finger4': 'LeftHandPinky1',
	'l finger41': 'LeftHandPinky2',
	'l finger42': 'LeftHandPinky3',
	'r finger0': 'RightHandThumb1',
	'r finger01': 'RightHandThumb2',
	'r finger02': 'RightHandThumb3',
	'r finger1': 'RightHandIndex1',
	'r finger11': 'RightHandIndex2',
	'r finger12': 'RightHandIndex3',
	'r finger2': 'RightHandMiddle1',
	'r finger21': 'RightHandMiddle2',
	'r finger22': 'RightHandMiddle3',
	'r finger3': 'RightHandRing1',
	'r finger31': 'RightHandRing2',
	'r finger32': 'RightHandRing3',
	'r finger4': 'RightHandPinky1',
	'r finger41': 'RightHandPinky2',
	'r finger42': 'RightHandPinky3',
};

function canonicalizeBoneName(rawName: string): string {
	const stripped = rawName.replace(/^mixamorig\d*:/i, '').trim();
	const ueKey = stripped.toLowerCase();
	const ue = UE_MANNEQUIN_TO_MIXAMO[ueKey];
	if (ue) return ue;
	// 3ds Max Biped: "Bip001 L Thigh" / "Bip01_Spine1" — strip the Bip prefix,
	// normalize separators, look up. The bare "Bip001" root stays unmapped.
	const bip = stripped.match(/^bip\d*[\s_]+(.+)$/i);
	if (bip) {
		const key = bip[1].replace(/[\s_]+/g, ' ').trim().toLowerCase();
		const mapped = BIPED_TO_MIXAMO[key];
		if (mapped) return mapped;
	}
	return stripped;
}

/* ============================================================================
 * Canonical → MMD map (same conventions as the validated HKX path).
 * ========================================================================= */

/**
 * Hips carries the pelvis rotation → 下半身 (its translation exports to
 * センター separately). Spine2 is deliberately unmapped: the world-delta
 * cancellation folds it into shoulders/neck, matching MMD's two-spine layout.
 */
const BONE_MAP: Record<string, string> = {
	Hips: '下半身',
	// Three source spine joints onto MMD's two: the deepest (Spine2, the chest)
	// lands on 上半身2 and Spine1 folds into it — see the same note in
	// lib/hkx-retarget.ts. Mapping Spine1→上半身2 loses chest bend on deep bows.
	Spine: '上半身',
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
	RightToe_End: '右つま先',
	LeftUpLeg: '左足',
	LeftLeg: '左ひざ',
	LeftFoot: '左足首',
	LeftToeBase: '左足先EX',
	LeftToe_End: '左つま先',
	// MMD thumbs are 親指０/１/２ (the ０ is the metacarpal) — there is no 親指３.
	RightHandThumb1: '右親指０',
	RightHandThumb2: '右親指１',
	RightHandThumb3: '右親指２',
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
	LeftHandThumb1: '左親指０',
	LeftHandThumb2: '左親指１',
	LeftHandThumb3: '左親指２',
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
 * Fallback topology for clips without a Connections hierarchy (JSON dumps).
 * `Root` is included so Unity exports (root → pelvis) propagate the scene-root
 * rotation into Hips; Mixamo clips have no root track — it contributes identity.
 */
const FALLBACK_PARENT: Record<string, string | null> = {
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
	LeftToe_End: 'LeftToeBase',
	RightUpLeg: 'Hips',
	RightLeg: 'RightUpLeg',
	RightFoot: 'RightLeg',
	RightToeBase: 'RightFoot',
	RightToe_End: 'RightToeBase',
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

/** Legacy Mixamo-in-cm scale, used only when the target model isn't measurable. */
const DEFAULT_POSITION_SCALE = 1 / 12.5;

const OUTPUT_FPS = 30;

/* ============================================================================
 * FBX rotation plumbing (Pre/Post/Lcl → parent-local quats).
 * ========================================================================= */

// Lcl, Pre, and Post rotations all use the same intrinsic-ZYX euler composition here
// (Three.FBXLoader convention; the historical "ZXY" label for Lcl was the same formula).
// Engine `Quat.fromEulerOrder(x, y, z, "ZYX")` is exactly that composition.

function preQuat(rest: BoneRestPose | null): Quat {
	if (!rest?.preRotation) return Quat.identity();
	return Quat.fromEulerOrder(rest.preRotation[0], rest.preRotation[1], rest.preRotation[2], "ZYX");
}

function postQuatInv(rest: BoneRestPose | null): Quat {
	if (!rest?.postRotation) return Quat.identity();
	return Quat.fromEulerOrder(rest.postRotation[0], rest.postRotation[1], rest.postRotation[2], "ZYX").conjugate();
}

function lclBindQuat(rest: BoneRestPose | null): Quat {
	if (!rest?.lclRotation) return Quat.identity();
	return Quat.fromEulerOrder(rest.lclRotation[0], rest.lclRotation[1], rest.lclRotation[2], "ZYX");
}

/** qPre · q · qPost⁻¹ — applied to either bind Lcl or per-frame Lcl identically. */
function applyPrePost(q: Quat, pre: Quat, postInv: Quat): Quat {
	return pre.clone().multiply(q).multiply(postInv);
}

/** Right-handed Y-up → left-handed Y-up (conjugation by the Z-mirror). */
function lhQ4(q: Quat): Q4 {
	return [-q.x, -q.y, q.z, q.w];
}

function lhV3(v: [number, number, number] | null): V3 {
	return v ? [v[0], v[1], -v[2]] : [0, 0, 0];
}

/* ============================================================================
 * Track sampling (slerp).
 * ========================================================================= */

function sampleBoneTrack(track: BoneTrack, time: number): Quat {
	if (track.times.length === 0) return Quat.identity();
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
	return Quat.slerp(track.quats[idx - 1], track.quats[idx], u);
}

function samplePositions(times: number[], positions: [number, number, number][], time: number): [number, number, number] {
	if (times.length === 0) return [0, 0, 0];
	const idx = times.findIndex(t => t >= time);
	if (idx === -1) return positions[positions.length - 1];
	if (idx === 0 || times[idx] === time) return positions[idx];
	const t0 = times[idx - 1];
	const t1 = times[idx];
	const u = (time - t0) / (t1 - t0);
	const p0 = positions[idx - 1];
	const p1 = positions[idx];
	return [p0[0] + (p1[0] - p0[0]) * u, p0[1] + (p1[1] - p0[1]) * u, p0[2] + (p1[2] - p0[2]) * u];
}

/* ============================================================================
 * Bind-reference support (Unity per-pose exports).
 * ========================================================================= */

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
		const stripped = t.name.replace(/^mixamorig\d*:/i, '').trim().toLowerCase();
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

/* ============================================================================
 * Retarget.
 * ========================================================================= */

/**
 * Measure the loaded model's bind-pose world positions for every MMD bone the
 * retarget can output. Call once after the model loads (bind pose, before any
 * animation), with e.g. `(n) => model.getBoneWorldPosition(n)`.
 */
export function measureTargetPositions(
	getPos: (mmdName: string) => { x: number; y: number; z: number } | null,
): Record<string, V3> {
	const out: Record<string, V3> = {};
	for (const mmdName of new Set(Object.values(BONE_MAP))) {
		try {
			const p = getPos(mmdName);
			if (p) out[mmdName] = [p.x, p.y, p.z];
		} catch {
			// bone missing on this model — that bone falls back to plain delta
		}
	}
	return out;
}

export interface RetargetOptions {
	/**
	 * Override rest poses keyed by canonical bone name. Some Unity/UE per-pose
	 * exports (e.g., mid-cycle "stride pose" clips) embed the first animation
	 * frame as the rest pose, which makes "delta from rest" reference the wrong
	 * baseline. Build this from a known-good clip (an idle, or the rig's
	 * bind/T-pose file). Applied only when the clip looks UE/Unity-shaped.
	 */
	bindReference?: Map<string, BoneRestPose> | null;
	/**
	 * The target MMD model's bind-pose world positions keyed by MMD bone name
	 * (PMX units), measured from the loaded model. Enables absolute segment
	 * alignment — without it every bone falls back to plain world delta and the
	 * pose inherits the bind mismatch — and auto-derives the translation scale
	 * from the two skeletons' hip heights.
	 */
	targetPositions?: Record<string, V3> | null;
	/**
	 * Strip horizontal root motion (Mixamo's "In Place"): the exported
	 * translation keeps its vertical component — jumps and crouches survive —
	 * while X/Z stay at the origin.
	 */
	inPlace?: boolean;
	/**
	 * Export foot-IK target tracks (左足ＩＫ/右足ＩＫ) from the FK ankle trajectory
	 * instead of disabling the chains. Deltas are bind-relative, so at contact the
	 * target lands at the TARGET model's own ankle bind height — heeled models
	 * ground correctly without per-model offsets. Toe IK stays off (foot pitch
	 * keeps coming from the FK 足首 rotation).
	 */
	footIK?: boolean;
}

function calculateDuration(clip: AnimationClip): number {
	if (clip.duration > 0) return clip.duration;
	let max = 0;
	for (const t of clip.tracks) for (const tt of t.times) if (tt > max) max = tt;
	for (const p of clip.positionTracks ?? []) for (const tt of p.times) if (tt > max) max = tt;
	return max;
}

interface FbxSourceBone extends SourceBone {
	track: BoneTrack | null;
	pre: Quat;
	postInv: Quat;
	/** Position track (canonical Hips), converted lazily during sampling. */
	posTimes: number[] | null;
	posValues: [number, number, number][] | null;
}

const reportedClips = new Set<string>();

export function retargetClips(clips: AnimationClip[], opts?: RetargetOptions): RetargetedClip[] {
	return clips.map(c => retargetOneClip(c, opts));
}

/* ============================================================================
 * Global frame alignment.
 * ========================================================================= */

/** Bone pairs whose bind-pose difference gives a skeleton's up / side axis. */
const SRC_UP_PROBES: [string, string][] = [['Hips', 'Head'], ['Hips', 'Neck'], ['Hips', 'Spine2'], ['Hips', 'Spine1'], ['Hips', 'Spine']];
const SRC_SIDE_PROBES: [string, string][] = [['RightUpLeg', 'LeftUpLeg'], ['RightArm', 'LeftArm'], ['RightShoulder', 'LeftShoulder']];
const MMD_UP_PROBES: [string, string][] = [['下半身', '頭'], ['下半身', '首'], ['下半身', '上半身2'], ['下半身', '上半身']];
const MMD_SIDE_PROBES: [string, string][] = [['右足', '左足'], ['右腕', '左腕'], ['右肩', '左肩']];

/**
 * How far the measurement may sit from the exact axis rotation blamed for it.
 * Two rigs never agree perfectly — different proportions tilt the measured
 * frame by a few degrees — so the correction is only trusted when an axis
 * error explains nearly all of what was measured.
 */
const FRAME_FIX_TOLERANCE_DEG = 25;

/** The 24 right-handed signed-permutation bases: every exact axis rotation. */
const AXIS_ROTATIONS: [V3, V3, V3][] = (() => {
	const out: [V3, V3, V3][] = [];
	for (const perm of [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]) {
		for (let signs = 0; signs < 8; signs++) {
			const cols = [0, 1, 2].map((i) => {
				const v: V3 = [0, 0, 0];
				v[perm[i]] = (signs >> i) & 1 ? -1 : 1;
				return v;
			}) as [V3, V3, V3];
			if (vDot(vCross(cols[0], cols[1]), cols[2]) > 0) out.push(cols);
		}
	}
	return out;
})();

function vSub(a: V3, b: V3): V3 {
	return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function vNormalize(v: V3): V3 | null {
	const l = Math.hypot(v[0], v[1], v[2]);
	return l > 1e-6 ? [v[0] / l, v[1] / l, v[2] / l] : null;
}

function vDot(a: V3, b: V3): number {
	return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function vCross(a: V3, b: V3): V3 {
	return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/** Component of `v` perpendicular to unit `axis`, normalized. */
function vReject(v: V3, axis: V3): V3 | null {
	const d = vDot(v, axis);
	return vNormalize([v[0] - d * axis[0], v[1] - d * axis[1], v[2] - d * axis[2]]);
}

/** First probe pair whose bones both exist and span a usable direction. */
function probeAxis(pairs: [string, string][], posOf: (name: string) => V3 | null): V3 | null {
	for (const [from, to] of pairs) {
		const a = posOf(from);
		const b = posOf(to);
		if (!a || !b) continue;
		const dir = vNormalize(vSub(b, a));
		if (dir) return dir;
	}
	return null;
}

/** Rotation taking the source's (up, side) frame onto the target's. */
function frameAlignQuat(upSrc: V3, sideSrc: V3, upTgt: V3, sideTgt: V3): Q4 {
	const g1 = q4FromTo(upSrc, upTgt);
	// Twist about the target's up until the sides agree. Signed angle rather
	// than another shortest arc: at exactly 180° — a rig facing backwards —
	// shortest-arc would pick an arbitrary perpendicular axis.
	const a = vReject(q4Rot(g1, sideSrc), upTgt);
	const b = vReject(sideTgt, upTgt);
	if (!a || !b) return g1;
	const ang = Math.atan2(vDot(vCross(a, b), upTgt), vDot(a, b));
	const h = ang / 2;
	const s = Math.sin(h);
	const g2: Q4 = [upTgt[0] * s, upTgt[1] * s, upTgt[2] * s, Math.cos(h)];
	return q4Normalize(q4Mul(g2, g1));
}

function q4AngleDeg(q: Q4): number {
	return (2 * Math.acos(Math.min(1, Math.abs(q[3]))) * 180) / Math.PI;
}

/**
 * Nearest exact axis rotation to `q` — a quarter or half turn about cardinal
 * axes, which is the only kind of frame error a file format actually produces.
 * Snapping means an axis-swapped file converts to exactly what the same file
 * upright would, instead of also having its rig's own few-degree bind offset
 * quietly removed.
 */
function snapToAxisRotation(q: Q4): Q4 {
	const image: [V3, V3, V3] = [q4Rot(q, [1, 0, 0]), q4Rot(q, [0, 1, 0]), q4Rot(q, [0, 0, 1])];
	let best = AXIS_ROTATIONS[0];
	let bestScore = -Infinity;
	for (const cols of AXIS_ROTATIONS) {
		const score = vDot(cols[0], image[0]) + vDot(cols[1], image[1]) + vDot(cols[2], image[2]);
		if (score > bestScore) {
			bestScore = score;
			best = cols;
		}
	}
	return frameAlignQuat([1, 0, 0], [0, 1, 0], best[0], best[1]);
}

/**
 * The rotation that carries the SOURCE skeleton's bind frame onto the TARGET
 * model's — the fix for files whose world frame isn't the target's.
 *
 * An FBX may be authored Z-up, or carry its up-axis conversion on a node above
 * the animated bones (which this parser never sees, keeping only nodes that
 * have animation curves). Either way the parsed skeleton stands along the wrong
 * axis, and absolute segment alignment then faithfully poses the model in that
 * same wrong frame: the whole body reads as face-down. GlobalSettings can't
 * settle it — exporters disagree with their own data, and a file that both
 * declares Z-up and bakes the conversion into a root node would be corrected
 * twice.
 *
 * So measure, the way the rest of this pipeline does. Up (hips → head) and side
 * (right → left leg) come from each skeleton's own BIND pose — never from the
 * animation, whose frame 0 may legitimately be lying down — and one frame
 * rotates onto the other.
 */
function measureFrameFix(
	bindWorld: V3[],
	idxByCanonical: Map<string, number>,
	targetPositions: Record<string, V3> | undefined,
): { q: Q4; deg: number } | null {
	if (!targetPositions) return null;
	const srcPos = (name: string): V3 | null => {
		const i = idxByCanonical.get(name);
		return i === undefined ? null : bindWorld[i];
	};
	const tgtPos = (name: string): V3 | null => targetPositions[name] ?? null;

	const upSrc = probeAxis(SRC_UP_PROBES, srcPos);
	const sideSrc = probeAxis(SRC_SIDE_PROBES, srcPos);
	const upTgt = probeAxis(MMD_UP_PROBES, tgtPos);
	const sideTgt = probeAxis(MMD_SIDE_PROBES, tgtPos);
	if (!upSrc || !sideSrc || !upTgt || !sideTgt) return null;

	const measured = frameAlignQuat(upSrc, sideSrc, upTgt, sideTgt);
	const snapped = snapToAxisRotation(measured);
	const deg = q4AngleDeg(snapped);
	if (deg < 1) return null; // frames already agree up to rig differences
	// Only correct what an axis error explains: a rig that simply sits at an odd
	// angle is left to the per-bone alignment, which is built for exactly that.
	const residual = q4AngleDeg(q4Mul(measured, q4Conj(snapped)));
	return residual <= FRAME_FIX_TOLERANCE_DEG ? { q: snapped, deg } : null;
}

interface FbxCore {
	source: RetargetSource
	core: RetargetCoreContext
	trackByCanonical: Map<string, BoneTrack>
	duration: number
	/** Global frame correction applied to the source, in degrees (0 = none). */
	frameFixDeg: number
}

/** Parse one clip into a retarget-ready source skeleton + core context. */
function buildFbxCore(clip: AnimationClip, opts?: RetargetOptions): FbxCore {
	const duration = calculateDuration(clip);
	const numFrames = Math.max(2, Math.round(duration * OUTPUT_FPS) + 1);

	// Apply the bind reference only when it actually matches the rig — using a UE
	// reference on a Mixamo clip (or vice versa) would corrupt the bind because the
	// two encode bind orientation differently (Mixamo: Pre/Post + identity Lcl;
	// UE: large Lcl, no Pre/Post).
	const bindRef = opts?.bindReference && isUEMannequinClip(clip) ? opts.bindReference : null;

	// First track per canonical name (raw FBX may have e.g. mixamorig:Hips and a
	// duplicate model node).
	const trackByCanonical = new Map<string, BoneTrack>();
	for (const t of clip.tracks) {
		const c = canonicalizeBoneName(t.name);
		if (!trackByCanonical.has(c)) trackByCanonical.set(c, t);
	}

	// Topology: the file's real Connections hierarchy when present (walk raw-name
	// parents to the nearest tracked bone), else the canonical humanoid table.
	const parentOfCanonical = (c: string, rawName: string): string | null => {
		if (clip.hierarchy && clip.hierarchy.size > 0) {
			let p = clip.hierarchy.get(rawName)?.parent ?? null;
			while (p) {
				const pc = canonicalizeBoneName(p);
				if (trackByCanonical.has(pc) && pc !== c) return pc;
				p = clip.hierarchy.get(p)?.parent ?? null;
			}
			return null;
		}
		const p = FALLBACK_PARENT[c];
		return p !== undefined ? p : null;
	};

	// Topologically ordered bone list (parents before children).
	const order: string[] = [];
	const seen = new Set<string>();
	const parentCache = new Map<string, string | null>();
	const visit = (c: string): void => {
		if (seen.has(c)) return;
		seen.add(c);
		const track = trackByCanonical.get(c);
		const parent = track ? parentOfCanonical(c, track.name) : FALLBACK_PARENT[c] ?? null;
		parentCache.set(c, parent);
		if (parent && (trackByCanonical.has(parent) || FALLBACK_PARENT[parent] !== undefined)) visit(parent);
		order.push(c);
	};
	// Seed with every canonical name we can see (tracked bones + fallback chain roots).
	for (const c of trackByCanonical.keys()) visit(c);
	// Re-order so parents precede children (visit() appends after recursing into
	// the parent, but a child seeded first still lands after its parent).
	order.sort((a, b) => depthOf(a, parentCache) - depthOf(b, parentCache));

	const positionTrackByCanonical = new Map<string, { times: number[]; positions: [number, number, number][] }>();
	for (const p of clip.positionTracks ?? []) {
		const c = canonicalizeBoneName(p.name);
		if (!positionTrackByCanonical.has(c)) positionTrackByCanonical.set(c, { times: p.times, positions: p.positions });
	}

	const bones: FbxSourceBone[] = [];
	const idxByCanonical = new Map<string, number>();
	for (const c of order) {
		const track = trackByCanonical.get(c) ?? null;
		const rest = bindRef?.get(c) ?? track?.restPose ?? null;
		const pre = preQuat(rest);
		const postInv = postQuatInv(rest);
		const bindLocal = applyPrePost(lclBindQuat(rest), pre, postInv);
		const parent = parentCache.get(c) ?? null;
		const pos = positionTrackByCanonical.get(c) ?? null;
		// Mixamo omits rest translations for zero-rotation joints — including Hips.
		// A zero bind position would make the translation export's "delta from
		// bind" equal the ABSOLUTE world position (~100cm × scale: the model
		// launches upward and sideways). For a bone with a position track, its
		// first sample is the baseline: the clip starts at the model's own spot.
		const bindT = rest?.lclTranslation ?? pos?.positions[0] ?? null;
		idxByCanonical.set(c, bones.length);
		bones.push({
			name: c,
			parentIndex: parent !== null ? idxByCanonical.get(parent) ?? -1 : -1,
			bindLocalRot: lhQ4(bindLocal),
			bindLocalPos: lhV3(bindT),
			track,
			pre,
			postInv,
			posTimes: pos?.times ?? null,
			posValues: pos?.positions ?? null,
		});
	}

	// Set once the source's world frame is measured against the target's; the
	// root bones carry it, so every descendant inherits it through FK.
	let frameFix: Q4 | null = null;

	const source: RetargetSource = {
		bones,
		numFrames,
		fps: OUTPUT_FPS,
		sample(boneIdx, frame) {
			const b = bones[boneIdx];
			if (!b.track && !b.posTimes) return null;
			const time = frame / OUTPUT_FPS;
			let rot = b.track
				? lhQ4(applyPrePost(sampleBoneTrack(b.track, time), b.pre, b.postInv))
				: b.bindLocalRot;
			let pos = b.posTimes && b.posValues
				? lhV3(samplePositions(b.posTimes, b.posValues, time))
				: b.bindLocalPos;
			if (frameFix && b.parentIndex < 0) {
				rot = q4Normalize(q4Mul(frameFix, rot));
				pos = q4Rot(frameFix, pos);
			}
			return { rot, pos };
		},
	};

	const targetPositions = opts?.targetPositions ?? undefined;

	// Global frame check, before anything reads the skeleton: measure the bind
	// pose as parsed, and if it doesn't stand the way the target model does,
	// rotate the roots so it does. Bind locals move with the sampler above, so
	// the core sees one consistent frame.
	const fix = measureFrameFix(
		fkWorldPositions(bones, bones.map((b) => b.bindLocalRot), bones.map((b) => b.bindLocalPos)),
		idxByCanonical,
		targetPositions,
	);
	if (fix) {
		frameFix = fix.q;
		for (const b of bones) {
			if (b.parentIndex >= 0) continue;
			b.bindLocalRot = q4Normalize(q4Mul(fix.q, b.bindLocalRot));
			b.bindLocalPos = q4Rot(fix.q, b.bindLocalPos);
		}
	}

	const core = createCoreContext(source, {
		nameMap: BONE_MAP,
		targetPositions,
		positionScale: DEFAULT_POSITION_SCALE, // patched below once bind FK exists
		translationExports: [
			...(positionTrackByCanonical.has('Hips') ? [{ srcBone: 'Hips', mmdBone: 'センター' }] : []),
			...(opts?.footIK
				? [
					{ srcBone: 'LeftFoot', mmdBone: '左足ＩＫ' },
					{ srcBone: 'RightFoot', mmdBone: '右足ＩＫ' },
				]
				: []),
		],
	});

	// Auto scale: ratio of the two skeletons' hip heights at bind. Works for cm,
	// m or inch exports without knowing the unit. (Hips bind height comes from
	// the rest translation, or the position track's first sample — see bindT.)
	const hipsIdx = idxByCanonical.get('Hips');
	const targetHipsY = targetPositions?.['下半身']?.[1];
	if (hipsIdx !== undefined && targetHipsY !== undefined && targetHipsY > 1e-4) {
		const srcHipsY = core.bindWorldPos[hipsIdx][1];
		if (srcHipsY > 1e-4) core.positionScale = targetHipsY / srcHipsY;
	}

	return { source, core, trackByCanonical, duration, frameFixDeg: fix?.deg ?? 0 };
}

function retargetOneClip(clip: AnimationClip, opts?: RetargetOptions): RetargetedClip {
	const { core, trackByCanonical, duration, frameFixDeg } = buildFbxCore(clip, opts);
	reportOnce(clip, core, trackByCanonical, frameFixDeg);
	const out = retargetCoreClip(core, clip.name);
	// In place: センター loses its horizontal path outright; every other exported
	// translation (the foot-IK targets) subtracts that SAME path, so feet keep
	// oscillating around the body instead of running off without it.
	let positionTracks = out.positionTracks;
	if (opts?.inPlace) {
		const center = out.positionTracks.find((t) => t.name === 'センター');
		// In place removes TRAVEL, never SWAY. A stationary clip (idle, turn in
		// place) has no travel to remove: its root only shifts weight side to
		// side, and the leg rotations are authored to compensate for exactly
		// that shift. Delete the shift and — with leg IK disabled on export —
		// the uncancelled compensation slides the feet across the floor.
		// Cyclic vs travelling is decided by net displacement over path length:
		// a walk cycle goes somewhere (ratio → 1), a weight shift returns home
		// (ratio → 0). Self-scaling, no magic distance threshold.
		let net = 0;
		let path = 0;
		if (center && center.positions.length > 1) {
			const ps = center.positions;
			const first = ps[0];
			const last = ps[ps.length - 1];
			net = Math.hypot(last.x - first.x, last.z - first.z);
			for (let i = 1; i < ps.length; i++) {
				path += Math.hypot(ps[i].x - ps[i - 1].x, ps[i].z - ps[i - 1].z);
			}
		}
		if (path > 1e-6 && net / path < 0.25) {
			return { ...out, positionTracks: out.positionTracks, duration };
		}
		positionTracks = out.positionTracks.map((t) => {
			if (t.name === 'センター') return { ...t, positions: t.positions.map((p) => new Vec3(0, p.y, 0)) };
			return {
				...t,
				positions: t.positions.map((p, i) => {
					const c = center?.positions[i];
					return new Vec3(p.x - (c?.x ?? 0), p.y, p.z - (c?.z ?? 0));
				}),
			};
		});
	}
	return { ...out, positionTracks, duration };
}

/* ============================================================================
 * Source preview (skeleton inset).
 * ========================================================================= */

export interface SourcePreviewBone {
	name: string
	parentIndex: number
	/** Has an MMD counterpart (drawn bright vs dimmed). */
	mapped: boolean
}

export interface SourcePreviewInfo {
	profile: string
	mappedCount: number
	alignedCount: number
	scale: number
	unmapped: string[]
}

export interface SourcePreview {
	bones: SourcePreviewBone[]
	duration: number
	info: SourcePreviewInfo
	/** Source-skeleton world positions (source units, MMD-handed) at time t seconds. */
	positionsAt(t: number): V3[]
}

/**
 * Ground-truth view of the parsed source: the same skeleton, sampler and
 * alignment context the retarget itself uses, exposed for the inset panel.
 */
export function createSourcePreview(clip: AnimationClip, opts?: RetargetOptions): SourcePreview {
	const { source, core, trackByCanonical, duration } = buildFbxCore(clip, opts);

	const bones: SourcePreviewBone[] = source.bones.map((b) => ({
		name: b.name,
		parentIndex: b.parentIndex,
		mapped: BONE_MAP[b.name] !== undefined,
	}));

	const unmapped = [...trackByCanonical.keys()].filter(c => !BONE_MAP[c] && c !== 'Root' && c !== 'Spine1');
	const info: SourcePreviewInfo = {
		profile: isUEMannequinClip(clip) ? 'UE / Unity' : 'Mixamo',
		mappedCount: core.mappedBones.length,
		alignedCount: core.mappedBones.filter(b => b.frameAlign).length,
		scale: core.positionScale,
		unmapped,
	};

	const n = source.bones.length;
	return {
		bones,
		duration,
		info,
		positionsAt(t: number): V3[] {
			// Fractional frame: the FBX sampler slerps the original curves at
			// continuous time, so the preview stays display-rate smooth instead of
			// stepping at the export's 30fps quantum.
			const frame = Math.max(0, Math.min(source.numFrames - 1, t * OUTPUT_FPS));
			const rot: Q4[] = new Array(n);
			const pos: V3[] = new Array(n);
			for (let i = 0; i < n; i++) {
				const s = source.sample(i, frame);
				rot[i] = s ? s.rot : source.bones[i].bindLocalRot;
				pos[i] = s ? s.pos : source.bones[i].bindLocalPos;
			}
			return fkWorldPositions(source.bones, rot, pos);
		},
	};
}

function depthOf(c: string, parentCache: Map<string, string | null>, guard = 0): number {
	if (guard > 64) return guard;
	const p = parentCache.get(c);
	return p ? depthOf(p, parentCache, guard + 1) + 1 : 0;
}

/** One console line per clip: detected profile, scale, and what didn't map. */
function reportOnce(
	clip: AnimationClip,
	core: RetargetCoreContext,
	trackByCanonical: Map<string, BoneTrack>,
	frameFixDeg = 0,
): void {
	if (reportedClips.has(clip.name)) return;
	reportedClips.add(clip.name);
	const profile = isUEMannequinClip(clip) ? 'UE-Mannequin/Unity' : 'Mixamo-style';
	const unmapped = [...trackByCanonical.keys()].filter(c => !BONE_MAP[c] && c !== 'Root' && c !== 'Spine1');
	const aligned = core.mappedBones.filter(b => b.frameAlign).length;
	console.log(
		`[retarget] "${clip.name}": ${profile}, scale=${core.positionScale.toFixed(4)}, ` +
		`${core.mappedBones.length} mapped (${aligned} aligned)` +
		(frameFixDeg > 0 ? `, world frame corrected ${frameFixDeg.toFixed(0)}°` : '') +
		`, unmapped tracks: ${unmapped.join(', ') || 'none'}`,
	);
}
