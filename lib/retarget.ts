import { Quat } from 'reze-engine';
import type { AnimationClip, BoneRestPose, BoneTrack } from './fbx';
import {
	createCoreContext,
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

function canonicalizeBoneName(rawName: string): string {
	const stripped = rawName.replace(/^mixamorig\d*:/i, '').trim();
	const ueKey = stripped.toLowerCase();
	return UE_MANNEQUIN_TO_MIXAMO[ueKey] ?? stripped;
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

function quatIdentity(): Quat {
	return new Quat(0, 0, 0, 1);
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
	return new Quat(-q.x, -q.y, -q.z, q.w);
}

function lclBindQuat(rest: BoneRestPose | null): Quat {
	if (!rest?.lclRotation) return quatIdentity();
	return eulerToQuatZXY(rest.lclRotation[0], rest.lclRotation[1], rest.lclRotation[2]);
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

function retargetOneClip(clip: AnimationClip, opts?: RetargetOptions): RetargetedClip {
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

	const source: RetargetSource = {
		bones,
		numFrames,
		fps: OUTPUT_FPS,
		sample(boneIdx, frame) {
			const b = bones[boneIdx];
			if (!b.track && !b.posTimes) return null;
			const time = frame / OUTPUT_FPS;
			const rot = b.track
				? lhQ4(applyPrePost(sampleBoneTrack(b.track, time), b.pre, b.postInv))
				: b.bindLocalRot;
			const pos = b.posTimes && b.posValues
				? lhV3(samplePositions(b.posTimes, b.posValues, time))
				: b.bindLocalPos;
			return { rot, pos };
		},
	};

	const targetPositions = opts?.targetPositions ?? undefined;

	const core = createCoreContext(source, {
		nameMap: BONE_MAP,
		targetPositions,
		positionScale: DEFAULT_POSITION_SCALE, // patched below once bind FK exists
		translationExports: positionTrackByCanonical.has('Hips')
			? [{ srcBone: 'Hips', mmdBone: 'センター' }]
			: [],
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

	reportOnce(clip, core, trackByCanonical);

	const out = retargetCoreClip(core, clip.name);
	return { ...out, duration };
}

function depthOf(c: string, parentCache: Map<string, string | null>, guard = 0): number {
	if (guard > 64) return guard;
	const p = parentCache.get(c);
	return p ? depthOf(p, parentCache, guard + 1) + 1 : 0;
}

/** One console line per clip: detected profile, scale, and what didn't map. */
function reportOnce(clip: AnimationClip, core: RetargetCoreContext, trackByCanonical: Map<string, BoneTrack>): void {
	if (reportedClips.has(clip.name)) return;
	reportedClips.add(clip.name);
	const profile = isUEMannequinClip(clip) ? 'UE-Mannequin/Unity' : 'Mixamo-style';
	const unmapped = [...trackByCanonical.keys()].filter(c => !BONE_MAP[c] && c !== 'Root' && c !== 'Spine1');
	const aligned = core.mappedBones.filter(b => b.frameAlign).length;
	console.log(
		`[retarget] "${clip.name}": ${profile}, scale=${core.positionScale.toFixed(4)}, ` +
		`${core.mappedBones.length} mapped (${aligned} aligned), unmapped tracks: ${unmapped.join(', ') || 'none'}`,
	);
}
