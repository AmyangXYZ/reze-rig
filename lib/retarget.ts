import { Quat, Vec3 } from 'reze-engine';
import { bindQuatFromBoneRestPose } from './fbx';
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

/**
 * Reallusion Character Creator / iClone (`CC_Base_*`) → canonical Mixamo-style
 * names. Keys are the part after the `CC_Base_` prefix, lowercased.
 *
 * The spine runs Hip → Waist → Spine01 → Spine02, one joint deeper than the
 * canonical scheme, so Waist takes Spine and the chest lands on Spine2 — the
 * folding rule that keeps deep bends in the torso. Pelvis (between Hip and the
 * thighs) and NeckTwist02 stay unmapped and fold into their mapped children,
 * as do the twist, share, breast, toe-digit and face bones.
 */
const CC_TO_MIXAMO: Record<string, string> = {
	'hip': 'Hips',
	'waist': 'Spine',
	'spine01': 'Spine1',
	'spine02': 'Spine2',
	'necktwist01': 'Neck',
	'head': 'Head',
	'l_clavicle': 'LeftShoulder',
	'l_upperarm': 'LeftArm',
	'l_forearm': 'LeftForeArm',
	'l_hand': 'LeftHand',
	'r_clavicle': 'RightShoulder',
	'r_upperarm': 'RightArm',
	'r_forearm': 'RightForeArm',
	'r_hand': 'RightHand',
	'l_thigh': 'LeftUpLeg',
	'l_calf': 'LeftLeg',
	'l_foot': 'LeftFoot',
	'l_toebase': 'LeftToeBase',
	'r_thigh': 'RightUpLeg',
	'r_calf': 'RightLeg',
	'r_foot': 'RightFoot',
	'r_toebase': 'RightToeBase',
	'l_thumb1': 'LeftHandThumb1',
	'l_thumb2': 'LeftHandThumb2',
	'l_thumb3': 'LeftHandThumb3',
	'l_index1': 'LeftHandIndex1',
	'l_index2': 'LeftHandIndex2',
	'l_index3': 'LeftHandIndex3',
	'l_mid1': 'LeftHandMiddle1',
	'l_mid2': 'LeftHandMiddle2',
	'l_mid3': 'LeftHandMiddle3',
	'l_ring1': 'LeftHandRing1',
	'l_ring2': 'LeftHandRing2',
	'l_ring3': 'LeftHandRing3',
	'l_pinky1': 'LeftHandPinky1',
	'l_pinky2': 'LeftHandPinky2',
	'l_pinky3': 'LeftHandPinky3',
	'r_thumb1': 'RightHandThumb1',
	'r_thumb2': 'RightHandThumb2',
	'r_thumb3': 'RightHandThumb3',
	'r_index1': 'RightHandIndex1',
	'r_index2': 'RightHandIndex2',
	'r_index3': 'RightHandIndex3',
	'r_mid1': 'RightHandMiddle1',
	'r_mid2': 'RightHandMiddle2',
	'r_mid3': 'RightHandMiddle3',
	'r_ring1': 'RightHandRing1',
	'r_ring2': 'RightHandRing2',
	'r_ring3': 'RightHandRing3',
	'r_pinky1': 'RightHandPinky1',
	'r_pinky2': 'RightHandPinky2',
	'r_pinky3': 'RightHandPinky3',
};

function canonicalizeBoneName(rawName: string): string {
	const stripped = rawName.replace(/^mixamorig\d*:/i, '').trim();
	const ueKey = stripped.toLowerCase();
	const ue = UE_MANNEQUIN_TO_MIXAMO[ueKey];
	if (ue) return ue;
	// Reallusion Character Creator: "CC_Base_L_Upperarm".
	const cc = stripped.match(/^cc_base_(.+)$/i);
	if (cc) {
		const mapped = CC_TO_MIXAMO[cc[1].trim().toLowerCase()];
		if (mapped) return mapped;
	}
	// 3ds Max Biped: "Bip001 L Thigh" / "Bip01_Spine1" / "Bip001LThigh" (concatenated)
	// Strip the Bip prefix, normalize separators, look up. The bare "Bip001" root stays unmapped.
	const bip = stripped.match(/^bip\d*([\s_]*)(.+)$/i);
	if (bip) {
		let part = bip[2];
		// For concatenated names like "LThigh" or "RFinger01", insert space before uppercase letters
		// Pattern: single capital (L/R/M) followed by another capital starts a new word
		// Also handle: lowercase followed by capital (e.g., "Spine1" → "spine1")
		if (!bip[1]) {
			// No separator: "LThigh", "RFinger01", "Pelvis", "Spine1", etc.
			// Insert space before: (1) capital following single capital [L/R/M], (2) capital following lowercase
			part = part
				// LThigh → L Thigh, RFinger → R Finger, MBone → M Bone
				.replace(/^([LRM])([A-Z])/i, '$1 $2')
				// Spine1 → Spine 1, Finger01 → Finger 01 (only if digit follows capital+lowercase)
				.replace(/([a-z])([A-Z])/g, '$1 $2');
		}
		const key = part.replace(/[\s_]+/g, ' ').trim().toLowerCase();
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

/** Does this source bone name land on an MMD bone? (Tooling: clip prebaking.) */
export function mapsToMmdBone(rawName: string): boolean {
	return BONE_MAP[canonicalizeBoneName(rawName)] !== undefined;
}

/** Which naming scheme a clip is written in — for the report and the inset. */
export function detectRigProfile(clip: AnimationClip): string {
	for (const t of clip.tracks) {
		if (/^cc_base_/i.test(t.name)) return 'Character Creator';
		if (/^bip\d*[\s_]/i.test(t.name)) return 'Biped';
		if (/^mixamorig\d*:/i.test(t.name)) return 'Mixamo';
	}
	return isUEMannequinClip(clip) ? 'UE / Unity' : 'Mixamo-style';
}

/**
 * The clip a file is actually about. Character Creator and Max exports ship a
 * bind clip beside the motion ("0_T-Pose", one key at t=0) and it sorts first,
 * so taking clips[0] converts a statue. Longest span wins; a single-clip file
 * is unaffected.
 */
export function pickMotionClip(clips: AnimationClip[]): AnimationClip | null {
	let best: AnimationClip | null = null;
	let bestSpan = -1;
	for (const clip of clips) {
		let span = clip.duration > 0 ? clip.duration : 0;
		if (span <= 0) {
			for (const t of clip.tracks) {
				const last = t.times[t.times.length - 1] ?? 0;
				if (last > span) span = last;
			}
		}
		if (span > bestSpan) {
			bestSpan = span;
			best = clip;
		}
	}
	return best;
}

/** Extract a canonical-bone-name → BoneRestPose map from a clip whose first frame is the bind. */
export function buildBindReferenceFromClip(clip: AnimationClip): Map<string, BoneRestPose> {
	const map = new Map<string, BoneRestPose>();
	for (const t of clip.tracks) {
		if (!t.restPose) continue;
		const c = canonicalizeBoneName(t.name);
		if (!map.has(c)) map.set(c, t.restPose);
		// The raw name too, so a reference can be recognised as belonging to this
		// rig. Canonicalization deliberately erases which rig a name came from —
		// "Bip001 L Thigh" and "thigh_l" both become LeftUpLeg — so the canonical
		// keys alone cannot tell a matching bind from a foreign one.
		if (!map.has(t.name)) map.set(t.name, t.restPose);
	}
	return map;
}

/**
 * Does this bind reference describe the same rig as the clip? Raw bone names
 * are the evidence: a reference built from the pack's own T-pose repeats them
 * exactly, while a reference from another rig shares none of them however
 * similar the two skeletons are once canonicalized.
 */
function bindReferenceMatchesRig(clip: AnimationClip, reference: Map<string, BoneRestPose>): boolean {
	let mapped = 0;
	let found = 0;
	let compared = 0;
	let sameLength = 0;
	for (const t of clip.tracks) {
		if (!mapsToMmdBone(t.name)) continue;
		mapped++;
		const ref = reference.get(t.name);
		if (!ref) continue;
		found++;
		// Bone offsets describe the skeleton rather than the pose, so they stay
		// trustworthy even in a file whose rest rotations are its first frame.
		const mine = t.restPose?.lclTranslation;
		const theirs = ref.lclTranslation;
		if (!mine || !theirs) continue;
		const a = Math.hypot(mine[0], mine[1], mine[2]);
		const b = Math.hypot(theirs[0], theirs[1], theirs[2]);
		if (Math.max(a, b) < 1e-6) continue;
		compared++;
		if (Math.abs(a - b) / Math.max(a, b) <= 0.05) sameLength++;
	}
	if (mapped === 0 || found / mapped < 0.5) return false;
	// Names alone only identify the rig FAMILY: every 3ds Max Biped calls its
	// hip "Bip001 Pelvis", every Character Creator rig uses CC_Base_*, every UE
	// rig uses pelvis/thigh_l. A bind from one character would otherwise be
	// applied to another's motion and quietly retarget it with the wrong
	// proportions. Bone lengths are the skeleton's fingerprint — within one
	// character they agree to a fraction of a percent.
	return compared === 0 || sameLength / compared >= 0.9;
}

/** The supplied reference that belongs to this clip's rig, if any. Several may
 *  be offered — a bundled one and whatever the user dropped — and only the one
 *  built from the same skeleton may be used. */
function pickBindReference(clip: AnimationClip, opts?: RetargetOptions): Map<string, BoneRestPose> | null {
	const ref = opts?.bindReference;
	if (!ref) return null;
	const candidates = Array.isArray(ref) ? ref : [ref];
	return candidates.find((c) => bindReferenceMatchesRig(clip, c)) ?? null;
}

/**
 * A rest pose that simply repeats the clip's first frame — what several
 * exporters write when a motion is saved without its figure pose. It is not a
 * bind at all, so "delta from rest" measures from wherever the animation
 * happened to start: alignment collapses, and the hip height it implies throws
 * the translation scale out with it. The true pose cannot be recovered from
 * such a file (its Pre/Post rotations alone describe no usable pose either),
 * so this is reported rather than repaired — the pack's T-pose file supplies it.
 */
export function restPoseIsFirstFrame(clip: AnimationClip): boolean {
	let checked = 0;
	let matching = 0;
	for (const t of clip.tracks) {
		if (!t.restPose || t.quats.length === 0 || !mapsToMmdBone(t.name)) continue;
		const rest = bindQuatFromBoneRestPose(t.restPose);
		if (!rest) continue;
		checked++;
		const q = t.quats[0];
		const dot = Math.abs(rest.x * q.x + rest.y * q.y + rest.z * q.z + rest.w * q.w);
		if (dot > 0.9999) matching++;
	}
	// Every mapped bone agreeing to four decimals is a copy, not a coincidence.
	return checked >= 8 && matching === checked;
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
	bindReference?: Map<string, BoneRestPose> | Map<string, BoneRestPose>[] | null;
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
): { q: Q4 | null; deg: number } | null {
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
	if (residual <= FRAME_FIX_TOLERANCE_DEG) return { q: snapped, deg };
	// Declined — and worth saying so. The measurement found the two skeletons
	// standing differently but could not blame an axis on it, which is what a
	// posed rest pose does to the side probe. The conversion goes ahead and the
	// character can come out lying down; silence there reads as "nothing to
	// report" rather than "measured, and gave up".
	return { q: null, deg: q4AngleDeg(measured) };
}

/* ============================================================================
 * Bind pose from the skin (FBX TransformLink).
 * ========================================================================= */

/** Column-major 4x4, translation at 12..14 — the layout FBX writes. */
type Mat4 = number[];

const MAT4_IDENTITY: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function mat4Mul(a: Mat4, b: Mat4): Mat4 {
	const out = new Array<number>(16);
	for (let col = 0; col < 4; col++) {
		for (let row = 0; row < 4; row++) {
			out[col * 4 + row] =
				a[row] * b[col * 4] +
				a[4 + row] * b[col * 4 + 1] +
				a[8 + row] * b[col * 4 + 2] +
				a[12 + row] * b[col * 4 + 3];
		}
	}
	return out;
}

/** Inverse of a rotation+scale+translation matrix (no projection). */
function mat4InvertAffine(m: Mat4): Mat4 {
	const a = m[0], b = m[4], c = m[8];
	const d = m[1], e = m[5], f = m[9];
	const g = m[2], h = m[6], i = m[10];
	const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
	if (Math.abs(det) < 1e-12) return MAT4_IDENTITY.slice();
	const s = 1 / det;
	const r = [
		(e * i - f * h) * s, (f * g - d * i) * s, (d * h - e * g) * s,
		(c * h - b * i) * s, (a * i - c * g) * s, (b * g - a * h) * s,
		(b * f - c * e) * s, (c * d - a * f) * s, (a * e - b * d) * s,
	];
	const tx = m[12], ty = m[13], tz = m[14];
	return [
		r[0], r[1], r[2], 0,
		r[3], r[4], r[5], 0,
		r[6], r[7], r[8], 0,
		-(r[0] * tx + r[3] * ty + r[6] * tz),
		-(r[1] * tx + r[4] * ty + r[7] * tz),
		-(r[2] * tx + r[5] * ty + r[8] * tz),
		1,
	];
}

/** Rotation part as a quaternion, with any scale divided out. */
function mat4ToQuat(m: Mat4): Q4 {
	const sx = Math.hypot(m[0], m[1], m[2]) || 1;
	const sy = Math.hypot(m[4], m[5], m[6]) || 1;
	const sz = Math.hypot(m[8], m[9], m[10]) || 1;
	const m00 = m[0] / sx, m10 = m[1] / sx, m20 = m[2] / sx;
	const m01 = m[4] / sy, m11 = m[5] / sy, m21 = m[6] / sy;
	const m02 = m[8] / sz, m12 = m[9] / sz, m22 = m[10] / sz;
	const trace = m00 + m11 + m22;
	let x: number, y: number, z: number, w: number;
	if (trace > 0) {
		const t = Math.sqrt(trace + 1) * 2;
		w = 0.25 * t; x = (m21 - m12) / t; y = (m02 - m20) / t; z = (m10 - m01) / t;
	} else if (m00 > m11 && m00 > m22) {
		const t = Math.sqrt(1 + m00 - m11 - m22) * 2;
		w = (m21 - m12) / t; x = 0.25 * t; y = (m01 + m10) / t; z = (m02 + m20) / t;
	} else if (m11 > m22) {
		const t = Math.sqrt(1 + m11 - m00 - m22) * 2;
		w = (m02 - m20) / t; x = (m01 + m10) / t; y = 0.25 * t; z = (m12 + m21) / t;
	} else {
		const t = Math.sqrt(1 + m22 - m00 - m11) * 2;
		w = (m10 - m01) / t; x = (m02 + m20) / t; y = (m12 + m21) / t; z = 0.25 * t;
	}
	return q4Normalize([x, y, z, w]);
}

function mat4FromQuatPos(q: Q4, p: V3): Mat4 {
	const [x, y, z, w] = q;
	const x2 = x + x, y2 = y + y, z2 = z + z;
	const xx = x * x2, xy = x * y2, xz = x * z2;
	const yy = y * y2, yz = y * z2, zz = z * z2;
	const wx = w * x2, wy = w * y2, wz = w * z2;
	return [
		1 - (yy + zz), xy + wz, xz - wy, 0,
		xy - wz, 1 - (xx + zz), yz + wx, 0,
		xz + wy, yz - wx, 1 - (xx + yy), 0,
		p[0], p[1], p[2], 1,
	];
}

/**
 * The skin's bind matrices, but only if they cover every bone between a mapped
 * bone and the root. Partial coverage is refused rather than patched: rigs that
 * deform through twist helpers leave their calves and forearms unskinned, and
 * filling those gaps from a rest pose that is really frame 1 would put a true
 * bind and a false one in the same chain.
 */
function usableSkinBind(
	clip: AnimationClip,
	order: string[],
	trackByCanonical: Map<string, BoneTrack>,
): Map<string, number[]> | null {
	const skin = clip.bindPoses;
	if (!skin || skin.size === 0) return null;
	// Only MAPPED bones need a true bind: theirs is what the delta and the
	// alignment are measured from. An unmapped ancestor without one is harmless,
	// because a descendant that has one is placed from its own matrix and the
	// ancestor's error is absorbed into the local between them.
	for (const c of order) {
		if (!BONE_MAP[c]) continue;
		const raw = trackByCanonical.get(c)?.name;
		if (raw && !skin.has(raw)) return null;
	}
	return skin;
}

interface FbxCore {
	source: RetargetSource
	core: RetargetCoreContext
	trackByCanonical: Map<string, BoneTrack>
	duration: number
	/** Global frame correction applied to the source, in degrees (0 = none). */
	frameFixDeg: number
	/** A frame disagreement that was measured but refused, in degrees (0 = none). */
	frameFixDeclinedDeg: number
	/** The file carried its own bind (skin clusters or a BindPose node). */
	bindFromFile: boolean
}

/** Parse one clip into a retarget-ready source skeleton + core context. */
function buildFbxCore(clip: AnimationClip, opts?: RetargetOptions): FbxCore {
	const duration = calculateDuration(clip);
	const numFrames = Math.max(2, Math.round(duration * OUTPUT_FPS) + 1);

	// Apply the bind reference only when it actually matches the rig — using a UE
	// reference on a Mixamo clip (or vice versa) would corrupt the bind because the
	// two encode bind orientation differently (Mixamo: Pre/Post + identity Lcl;
	// UE: large Lcl, no Pre/Post).
	const bindRef = pickBindReference(clip, opts);

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

	// The skin's bind, when the file ships one and it covers every bone on a path
	// from a mapped bone to the root. All-or-nothing on that chain: a bind taken
	// partly from the skin and partly from a rest pose that is really frame 1
	// would put true and false poses in one hierarchy, which is worse than
	// either alone. Bones off that chain cannot affect a mapped bone's world
	// transform, so gaps there are harmless.
	const skinBind = usableSkinBind(clip, order, trackByCanonical);
	const bindWorld = new Map<string, Mat4>();

	const bones: FbxSourceBone[] = [];
	const idxByCanonical = new Map<string, number>();
	for (const c of order) {
		const track = trackByCanonical.get(c) ?? null;
		const rest = bindRef?.get(c) ?? track?.restPose ?? null;
		const pre = preQuat(rest);
		const postInv = postQuatInv(rest);
		let bindLocal = applyPrePost(lclBindQuat(rest), pre, postInv);
		const parent = parentCache.get(c) ?? null;
		const pos = positionTrackByCanonical.get(c) ?? null;
		// Mixamo omits rest translations for zero-rotation joints — including Hips.
		// A zero bind position would make the translation export's "delta from
		// bind" equal the ABSOLUTE world position (~100cm × scale: the model
		// launches upward and sideways). For a bone with a position track, its
		// first sample is the baseline: the clip starts at the model's own spot.
		let bindT = rest?.lclTranslation ?? pos?.positions[0] ?? null;

		if (skinBind) {
			// World bind from the skin where it exists; otherwise carry the chain
			// forward with this bone's own rest local, so a descendant that does
			// have one still re-anchors to the truth.
			const parentWorld = parent !== null ? bindWorld.get(parent) ?? MAT4_IDENTITY : MAT4_IDENTITY;
			const raw = track?.name;
			const own = raw ? skinBind.get(raw) : undefined;
			const world = own ?? mat4Mul(parentWorld, mat4FromQuatPos(
				[bindLocal.x, bindLocal.y, bindLocal.z, bindLocal.w],
				bindT ?? [0, 0, 0],
			));
			bindWorld.set(c, world);
			const local = mat4Mul(mat4InvertAffine(parentWorld), world);
			const q = mat4ToQuat(local);
			bindLocal = new Quat(q[0], q[1], q[2], q[3]);
			bindT = [local[12], local[13], local[14]];
		}

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

	// Does anything on the hip's chain animate a translation? The exported
	// センター is Hips' WORLD displacement, so travel keyed on a reference bone
	// above the pelvis is already included through FK — but asking only whether
	// HIPS itself has a position track missed exactly that shape, and a rig that
	// keys its travel on a root and leaves the pelvis rotation-only lost every
	// step of it silently. Mixamo keys the hips, UE keys both; the rigs that key
	// only the root are the ones this is for.
	const hipsCarriesTranslation = (() => {
		let c: string | null = 'Hips';
		const guard = new Set<string>();
		while (c && !guard.has(c)) {
			if (positionTrackByCanonical.has(c)) return true;
			guard.add(c);
			c = parentCache.get(c) ?? null;
		}
		return false;
	})();

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
	if (fix?.q) {
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
			...(hipsCarriesTranslation ? [{ srcBone: 'Hips', mmdBone: 'センター' }] : []),
			...(opts?.footIK
				? [
					{ srcBone: 'LeftToeBase', mmdBone: '左足ＩＫ' },
					{ srcBone: 'RightToeBase', mmdBone: '右足ＩＫ' },
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

	// Foot IK: auto-detect target model's heel status
	// Measure ankle-to-toe distance. If significant heel offset exists (ankle ahead of toe),
	// blend IK target between toe (no heel) and ankle (with heel) based on target's geometry.
	if (opts?.footIK && targetPositions) {
		const measureFootOffset = (ankleKey: string, toeKey: string): number => {
			const ankle = targetPositions[ankleKey];
			const toe = targetPositions[toeKey];
			if (!ankle || !toe) return 0;
			// Heel offset: how far back (in Z) the ankle is from toe. Positive = heel exists.
			return Math.max(0, toe[2] - ankle[2]); // toe_z - ankle_z (left-handed Y-up, Z is depth)
		};
		const leftHeelOffset = measureFootOffset('左足首', '左足先EX');
		const rightHeelOffset = measureFootOffset('右足首', '右足先EX');
		const targetHeelOffset = (leftHeelOffset + rightHeelOffset) / 2;

		console.log(`[foot-ik] target heel offset: ${targetHeelOffset.toFixed(3)} (L: ${leftHeelOffset.toFixed(3)}, R: ${rightHeelOffset.toFixed(3)})`);

		// If target has significant heel offset, adjust source bone to foot instead of toe
		if (targetHeelOffset > 0.1) {
			// Target has a heel: use foot-based IK
			console.log(`[foot-ik] detected heel, using foot-based IK`);
			core.translationExports.forEach(t => {
				if (t.mmdBone === '左足ＩＫ') t.srcBone = 'LeftFoot';
				if (t.mmdBone === '右足ＩＫ') t.srcBone = 'RightFoot';
			});
		} else {
			console.log(`[foot-ik] no heel detected, using toe-based IK`);
		}
	}

	return {
		source,
		core,
		trackByCanonical,
		duration,
		frameFixDeg: fix?.q ? fix.deg : 0,
		frameFixDeclinedDeg: fix && !fix.q ? fix.deg : 0,
		bindFromFile: skinBind !== null,
	};
}

function retargetOneClip(clip: AnimationClip, opts?: RetargetOptions): RetargetedClip {
	const { core, trackByCanonical, duration, frameFixDeg, frameFixDeclinedDeg, bindFromFile } = buildFbxCore(clip, opts);
	reportOnce(clip, core, trackByCanonical, frameFixDeg, opts, bindFromFile, frameFixDeclinedDeg);
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
		let excursion = 0;
		if (center && center.positions.length > 1) {
			const ps = center.positions;
			const first = ps[0];
			const last = ps[ps.length - 1];
			net = Math.hypot(last.x - first.x, last.z - first.z);
			for (let i = 1; i < ps.length; i++) {
				path += Math.hypot(ps[i].x - ps[i - 1].x, ps[i].z - ps[i - 1].z);
				excursion = Math.max(excursion, Math.hypot(ps[i].x - first.x, ps[i].z - first.z));
			}
		}
		// Ending where it started isn't enough to call a clip stationary: a dance
		// can roam the whole stage and come home, which reads as cyclic while
		// plainly travelling. So also ask how far it ever got. A pelvis can shift
		// about half a leg length with both feet planted; past that the character
		// stepped somewhere, and pinning it is what the toggle was asked for.
		const stanceReach = (opts?.targetPositions?.['下半身']?.[1] ?? 0) * 0.5;
		const cyclic = path > 1e-6 && net / path < 0.25;
		const stayedPut = stanceReach <= 0 || excursion <= stanceReach;
		if (cyclic && stayedPut) {
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
	/** The file's rest pose is a copy of its first frame and no matching bind
	 *  reference was supplied — see restPoseIsFirstFrame. */
	bindMissing: boolean
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
	const { source, core, trackByCanonical, duration, bindFromFile } = buildFbxCore(clip, opts);

	const bones: SourcePreviewBone[] = source.bones.map((b) => ({
		name: b.name,
		parentIndex: b.parentIndex,
		mapped: BONE_MAP[b.name] !== undefined,
	}));

	const unmapped = [...trackByCanonical.keys()].filter(c => !BONE_MAP[c] && c !== 'Root' && c !== 'Spine1');
	const info: SourcePreviewInfo = {
		profile: detectRigProfile(clip),
		mappedCount: core.mappedBones.length,
		alignedCount: core.mappedBones.filter(b => b.frameAlign).length,
		scale: core.positionScale,
		unmapped,
		bindMissing: !bindFromFile && restPoseIsFirstFrame(clip) && !pickBindReference(clip, opts),
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
	opts?: RetargetOptions,
	bindFromFile = false,
	frameFixDeclinedDeg = 0,
): void {
	if (reportedClips.has(clip.name)) return;
	reportedClips.add(clip.name);
	const profile = detectRigProfile(clip);
	const unmapped = [...trackByCanonical.keys()].filter(c => !BONE_MAP[c] && c !== 'Root' && c !== 'Spine1');
	const aligned = core.mappedBones.filter(b => b.frameAlign).length;
	console.log(
		`[retarget] "${clip.name}": ${profile}, scale=${core.positionScale.toFixed(4)}, ` +
		`${core.mappedBones.length} mapped (${aligned} aligned)` +
		(!bindFromFile && restPoseIsFirstFrame(clip) && !pickBindReference(clip, opts)
			? ', REST POSE IS FRAME 0 — supply the rig\'s T-pose file for a correct bind'
			: '') +
		(frameFixDeg > 0 ? `, world frame corrected ${frameFixDeg.toFixed(0)}°` : '') +
		(frameFixDeclinedDeg > 0
			? `, WORLD FRAME OFF BY ${frameFixDeclinedDeg.toFixed(0)}° — no axis rotation explains it, converting as-is`
			: '') +
		`, unmapped tracks: ${unmapped.join(', ') || 'none'}`,
	);
}
