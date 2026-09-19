import { VMDLoader, VMDWriter, type MorphKeyframe, type PmxDocument } from 'reze-engine';
import { parseFbxTree, type FBXNode } from './fbx';

type V3 = [number, number, number];

/**
 * FBX blend-shape animation → MMD morph tracks.
 *
 * An FBX animates a blend shape through its channel's DeformPercent, 0–100.
 * MMD animates a morph by name, 0–1. Reading is generic; naming is not, and
 * MORPH_MAP carries the one face rig mapped so far.
 */

const FBX_TICKS_PER_SECOND = 46186158000;
const FPS = 30;
/** Weight error a dropped key may leave behind. */
const KEY_TOLERANCE = 1e-3;

/** One blend-shape channel over time, weights 0–1. */
export interface MorphTrack {
	name: string;
	times: number[];
	weights: number[];
}

/** Every blend-shape channel the file animates, by channel name. */
export function readMorphTracks(buffer: ArrayBuffer): MorphTrack[] {
	const tree = parseFbxTree(buffer);
	const objects = tree.node('Objects')?.fbxNode;
	const conns = tree.node('Connections')?.fbxNode.nodes.filter((c) => c.name === 'C') ?? [];
	if (!objects) return [];
	const byId = new Map<number, FBXNode>();
	for (const o of objects.nodes) byId.set(Number(o.props[0]), o);

	const tracks: MorphTrack[] = [];
	for (const c of conns) {
		if (c.props[0] !== 'OP' || c.props[3] !== 'DeformPercent') continue;
		const curveNode = byId.get(Number(c.props[1]));
		const channel = byId.get(Number(c.props[2]));
		if (curveNode?.name !== 'AnimationCurveNode' || channel?.props[2] !== 'BlendShapeChannel') continue;
		const link = conns.find((l) => l.props[0] === 'OP' && Number(l.props[2]) === Number(c.props[1]));
		const curve = link ? byId.get(Number(link.props[1])) : undefined;
		const times = curve?.nodes.find((n) => n.name === 'KeyTime')?.props[0];
		const values = curve?.nodes.find((n) => n.name === 'KeyValueFloat')?.props[0];
		if (!Array.isArray(times) || !Array.isArray(values) || times.length === 0) continue;
		tracks.push({
			// Exporters leave stray whitespace in channel names ("EB_Up_R\t").
			name: String(channel.props[1]).trim(),
			times: times.map((t) => Number(t) / FBX_TICKS_PER_SECOND),
			weights: values.map((v) => Number(v) / 100),
		});
	}
	return tracks;
}

/** The source channel that shuts both eyes: where each face's lids are found. */
const BLINK_CHANNEL = 'Eye_Close';
/** The MMD morph that shuts both eyes. */
const BLINK_MORPH = 'まばたき';

/**
 * Source channel → MMD morphs it drives, as candidates in order of preference.
 * A candidate lists morphs driven together at the channel's weight; the first
 * whose morphs all exist on the target model is used.
 *
 * The face rig is 托特's (109501) from her game. Her MMD model is built from
 * the same face mesh — ×8, Z mirrored, every vertex landing on its own — so
 * each channel has an exact 托特 morph, found by displacement field (cos
 * 0.96–1.00 at equal strength). Its author named shapes by their look, which is
 * why Mouth_a is え1 and Mouth_A is あ.
 *
 * The reze model is built on the same rig. It keeps some of the rig's names,
 * renames the rest, and splits many into _L/_R halves grouped under the
 * both-sides name; its candidates come first where it has them. Those were
 * matched by geometry against reze's own face (aligned through the shapes both
 * keep under one name), except the mouth vowels, whose open-jaw fields all look
 * alike and which follow the vowel.
 *
 * The last candidate is the MMD standard morph, for a model with neither.
 */
export const MORPH_MAP: Record<string, string[][]> = {
	EB_Angry_L: [['真面目_L'], ['真面目']],
	EB_Angry_R: [['真面目_R'], ['真面目']],
	EB_Komari_L: [['困る_L'], ['困る']],
	EB_Komari_R: [['困る_R'], ['困る']],
	EB_Relax_L: [['にこり_L'], ['にこり']],
	EB_Relax_R: [['にこり_R'], ['にこり']],
	EB_Down_L: [['下_L'], ['下']],
	EB_Down_R: [['下_R'], ['下']],
	EB_Up_L: [['上_L'], ['上']],
	EB_Up_R: [['上_R'], ['上']],

	Pupil_R_R: [['Pupil_R_R']],
	Pupil_R_L: [['Pupil_R_L']],
	Pupil_L_R: [['Pupil_L_R']],
	Pupil_L_L: [['Pupil_L_L']],
	Pupil_Up_R: [['Pupil_Up_R']],
	Pupil_Up_L: [['Pupil_Up_L']],
	Pupil_Down_R: [['Pupil_Down_R']],
	Pupil_Down_L: [['Pupil_Down_L']],
	Pupil_Odorok1_R: [['Pupil_Odorok1_R'], ['瞳小']],
	Pupil_Odorok1_L: [['Pupil_Odorok1_L'], ['瞳小']],
	Pupil_Odorok2_R: [['Pupil_Odorok2_R'], ['瞳小']],
	Pupil_Odorok2_L: [['Pupil_Odorok2_L'], ['瞳小']],

	// まばたき is reze's two halves grouped; driven apart, each eye is fitted alone.
	Eye_Close: [['ウィンク２', 'ウィンク２右'], ['まばたき']],
	Eye_Wink_L: [['ウィンク']],
	Eye_Wink_R: [['ウィンク右']],
	Eye_Open_L: [['びっくり_L'], ['びっくり']],
	Eye_Open_R: [['びっくり_R'], ['びっくり']],
	Eye_Half_Closed: [['じと目_L2', 'じと目_R2'], ['じと目1'], ['じと目']],
	Eye_Jitom: [['じと目']],
	Eye_Angry: [['ｷﾘｯ']],
	Eye_Komari: [['Eye_Komari_L', 'Eye_Komari_R'], ['眼角下']],
	Eye_Eyelid_Up: [['Eye_Eyelid_Up_L', 'Eye_Eyelid_Up_R'], ['眼睑上']],
	Eye_Rotate: [['Eye_Rotate_L', 'Eye_Rotate_R'], ['眼角下1']],

	Mouth_a: [['え1'], ['あ']],
	Mouth_i: [['い']],
	Mouth_u: [['お1'], ['う']],
	Mouth_e: [['ワ1'], ['え']],
	Mouth_o: [['お']],
	Mouth_A: [['あ２'], ['あ']],
	Mouth_U: [['う２'], ['ワ'], ['う']],
	Mouth_E: [['え２'], ['口角下げ1'], ['え']],
	Mouth_Laugh: [['口角上げ']],
	Mouth_Unhappy1: [['口角下げ']],
	Mouth_Unhappy2: [['口角下げ２'], ['倒ω'], ['口角下げ']],
	Mouth_Small: [['Mouth_Small'], ['口横缩げ']],
	Mouth_Big: [['Mouth_Big'], ['口横広げ']],
	Mouth_Offest_R: [['Mouth_Offest_R']],
	Mouth_Offest_L: [['Mouth_Offest_L']],
	Mouth_Offest_Up: [['Mouth_Offest_Up']],
	Mouth_Offest_Down: [['Mouth_Offest_Down']],
	Z_Zuijiao_UP_R: [['Z_Zuijiao_UP_R'], ['にやり２1']],
	Z_Zuijiao_UP_L: [['Z_Zuijiao_UP_L'], ['にやり２']],
};

function sampleAt(track: MorphTrack, t: number): number {
	const { times, weights } = track;
	const n = times.length;
	if (t <= times[0]) return weights[0];
	if (t >= times[n - 1]) return weights[n - 1];
	let lo = 0;
	let hi = n - 1;
	while (hi - lo > 1) {
		const mid = (lo + hi) >> 1;
		if (times[mid] <= t) lo = mid;
		else hi = mid;
	}
	const span = times[hi] - times[lo];
	const w = span > 0 ? (t - times[lo]) / span : 0;
	return weights[lo] + (weights[hi] - weights[lo]) * w;
}

/**
 * The frames a linear curve needs to pass within KEY_TOLERANCE of every
 * sample: from each kept key, reach as far as the straight line to the next
 * holds, and keep the frame where it stops holding.
 */
function keepFrames(values: number[]): number[] {
	const kept = [0];
	let from = 0;
	for (let to = 2; to < values.length; to++) {
		for (let f = from + 1; f < to; f++) {
			const line = values[from] + ((values[to] - values[from]) * (f - from)) / (to - from);
			if (Math.abs(line - values[f]) > KEY_TOLERANCE) {
				from = to - 1;
				kept.push(from);
				break;
			}
		}
	}
	if (values.length > 1) kept.push(values.length - 1);
	return kept;
}

/**
 * A face's eyelids: per eye, how much each morph opens (+) or shuts (−) the
 * gap between the lid centres at full weight, as a fraction of the eye's
 * opening; and how big the eye is, its opening over the distance between eyes.
 */
export interface Eyelids {
	L: Map<string, number>;
	R: Map<string, number>;
	size: number;
}

/**
 * Find the lids and measure every morph against them.
 *
 * The upper-lid centre is the vertex the blink drops furthest, and how far it
 * drops is the eye's opening. It lands on the lower lid, so the lower-lid
 * centre is the vertex nearest that landing point which some morph moving the
 * upper lid also moves — a lid, never the eyeball or iris behind it — and
 * which the blink does not pull down with the upper lid. A blink may lift the
 * lower lid to meet it (托特's does, 0.033), so a lifted vertex still counts.
 * Eyes are told apart by the side of X they sit on.
 */
function measureEyelids(position: (i: number) => V3, fields: Map<string, Map<number, V3>>, blink: string): Eyelids | null {
	const blinkField = fields.get(blink);
	if (!blinkField) return null;
	const sides: Partial<Eyelids> = {};
	const uppers: number[] = [];
	let openings = 0;
	for (const [side, sign] of [['L', 1], ['R', -1]] as const) {
		let upper = -1;
		for (const [i, d] of blinkField) if (position(i)[0] * sign > 0 && (upper < 0 || d[1] < blinkField.get(upper)![1])) upper = i;
		if (upper < 0) return null;
		const drop = blinkField.get(upper)!;
		const at = position(upper);
		const landing: V3 = [at[0] + drop[0], at[1] + drop[1], at[2] + drop[2]];
		const pulled = -0.1 * Math.hypot(...drop);
		let lower = -1;
		let best = Infinity;
		for (const field of fields.values()) {
			if (!field.has(upper)) continue;
			for (const i of field.keys()) {
				const p = position(i);
				const moved = blinkField.get(i);
				if (i === upper || p[0] * sign <= 0 || (moved && moved[1] < pulled)) continue;
				const dist = Math.hypot(p[0] - landing[0], p[1] - landing[1], p[2] - landing[2]);
				if (dist < best) {
					best = dist;
					lower = i;
				}
			}
		}
		const opening = -drop[1];
		if (lower < 0 || !(opening > 0)) return null;
		const perMorph = new Map<string, number>();
		for (const [name, field] of fields) {
			const change = (field.get(upper)?.[1] ?? 0) - (field.get(lower)?.[1] ?? 0);
			if (change !== 0) perMorph.set(name, change / opening);
		}
		sides[side] = perMorph;
		uppers.push(upper);
		openings += opening / 2;
	}
	const spacing = Math.abs(position(uppers[0])[0] - position(uppers[1])[0]);
	return { ...(sides as Eyelids), size: openings / spacing };
}

/** The source face's eyelids, from the blend shapes on the mesh the blink channel deforms. */
export function readSourceEyelids(buffer: ArrayBuffer): Eyelids | null {
	const tree = parseFbxTree(buffer);
	const objects = tree.node('Objects')?.fbxNode;
	const conns = tree.node('Connections')?.fbxNode.nodes.filter((c) => c.name === 'C') ?? [];
	if (!objects) return null;
	const byId = new Map<number, FBXNode>();
	for (const o of objects.nodes) byId.set(Number(o.props[0]), o);
	const parent = (node: FBXNode, test: (n: FBXNode) => boolean) =>
		conns.map((c) => (Number(c.props[1]) === Number(node.props[0]) ? byId.get(Number(c.props[2])) : undefined)).find((n) => n && test(n));
	const numbers = (node: FBXNode, name: string) => {
		const v = node.nodes.find((n) => n.name === name)?.props[0];
		return Array.isArray(v) ? v.map(Number) : [];
	};

	// Shape → its channel → its blend shape → the mesh it deforms.
	const byMesh = new Map<FBXNode, Map<string, Map<number, V3>>>();
	for (const shape of objects.nodes) {
		if (shape.name !== 'Geometry' || shape.props[2] !== 'Shape') continue;
		const channel = parent(shape, (n) => n.props[2] === 'BlendShapeChannel');
		const deformer = channel && parent(channel, (n) => n.props[2] === 'BlendShape');
		const mesh = deformer && parent(deformer, (n) => n.name === 'Geometry');
		if (!channel || !mesh) continue;
		const idx = numbers(shape, 'Indexes');
		const d = numbers(shape, 'Vertices');
		const field = new Map<number, V3>(idx.map((v, k) => [v, [d[3 * k], d[3 * k + 1], d[3 * k + 2]]]));
		if (!byMesh.has(mesh)) byMesh.set(mesh, new Map());
		byMesh.get(mesh)!.set(String(channel.props[1]).trim(), field);
	}
	for (const [mesh, fields] of byMesh) {
		if (!fields.has(BLINK_CHANNEL)) continue;
		const base = numbers(mesh, 'Vertices');
		return measureEyelids((i) => [base[3 * i], base[3 * i + 1], base[3 * i + 2]], fields, BLINK_CHANNEL);
	}
	return null;
}

/** The target model's eyelids, group morphs expanded into the vertex morphs they add. */
export function readTargetEyelids(doc: PmxDocument): Eyelids | null {
	const expand = (index: number, seen: Set<number>): Map<number, V3> => {
		const out = new Map<number, V3>();
		for (const o of doc.morphs[index].offsets) {
			if (o.kind === 'vertex') {
				const d = out.get(o.index) ?? [0, 0, 0];
				out.set(o.index, [d[0] + o.offset[0], d[1] + o.offset[1], d[2] + o.offset[2]]);
			} else if (o.kind === 'group' && !seen.has(o.index)) {
				for (const [i, v] of expand(o.index, new Set([...seen, index]))) {
					const d = out.get(i) ?? [0, 0, 0];
					out.set(i, [d[0] + v[0] * o.influence, d[1] + v[1] * o.influence, d[2] + v[2] * o.influence]);
				}
			}
		}
		return out;
	};
	const fields = new Map<string, Map<number, V3>>();
	doc.morphs.forEach((m, i) => {
		const field = expand(i, new Set());
		if (field.size) fields.set(m.name, field);
	});
	return measureEyelids((i) => doc.vertices[i].position, fields, BLINK_MORPH);
}

/**
 * Keep each eye's visible opening the source's size, and a shut eye shut.
 *
 * The target's eye need not be the source's size: reze's opens 13% less than
 * 托特's against the distance between her eyes. Closing it by the same
 * fraction leaves less eye showing, and reads as half-asleep. So each frame,
 * per eye, the source's opening is scaled by the ratio of the two eyes' sizes
 * (never past fully open), and the morphs shutting that eye are scaled until
 * the lid gap is that. The scale may also rise — never past weight 1 — which
 * is what keeps an eye the source shuts shut. The morphs that open an eye are
 * left as they are.
 */
function fitEyelids(
	byMorph: Map<string, number[]>,
	source: Map<string, number[]>,
	lids: { source: Eyelids; target: Eyelids },
	count: number,
): void {
	const ratio = lids.source.size / lids.target.size;
	for (let f = 0; f < count; f++) {
		const keep = new Map<string, number>();
		for (const side of ['L', 'R'] as const) {
			let open = 1;
			for (const [channel, share] of lids.source[side]) open += (source.get(channel)?.[f] ?? 0) * share;
			const want = Math.min(1, Math.max(0, open) * ratio);
			let shut = 0;
			let rest = 0;
			let heaviest = 0;
			for (const [morph, values] of byMorph) {
				const share = lids.target[side].get(morph) ?? 0;
				if (share < 0) {
					shut += values[f] * share;
					heaviest = Math.max(heaviest, values[f]);
				} else rest += values[f] * share;
			}
			if (shut > -1e-6) continue;
			const k = Math.max(0, Math.min(1 / heaviest, (want - 1 - rest) / shut));
			// A morph shutting both eyes keeps the larger of the two scales, so the
			// eye that needs it most stays as shut as the source had it.
			for (const [morph] of byMorph) {
				if ((lids.target[side].get(morph) ?? 0) < 0) keep.set(morph, Math.max(keep.get(morph) ?? 0, k));
			}
		}
		for (const [morph, k] of keep) byMorph.get(morph)![f] *= k;
	}
}

const survives = new Map<string, boolean>();

/**
 * Whether a VMD can name this morph. The field is 15 bytes of Shift-JIS, and a
 * character outside it is dropped on write — 托特's 口横缩げ and 眼睑上 carry
 * simplified 缩 and 睑 — leaving a name that matches no morph. Asked of the
 * engine's own writer and loader, whose round trip is what playback sees.
 */
function survivesVmd(name: string): boolean {
	let known = survives.get(name);
	if (known === undefined) {
		const morphTracks = new Map([[name, [{ morphName: name, frame: 0, weight: 1 }]]]);
		const read = VMDLoader.loadFromBuffer(new VMDWriter().write({ boneTracks: new Map(), morphTracks, frameCount: 1 }));
		known = read.some((k) => k.morphFrames.some((m) => m.morphName === name));
		survives.set(name, known);
	}
	return known;
}

/**
 * MMD morph tracks for a model with the given morph names (every candidate's
 * first choice when none are given), skipping any a VMD cannot name. Channels landing on one morph take the
 * larger weight. With both faces' eyelids, each eye keeps the source's opening
 * (fitEyelids). Returns the tracks, and the source channels nothing took.
 */
export function toMmdMorphTracks(
	tracks: MorphTrack[],
	targetMorphs?: Set<string>,
	lids?: { source: Eyelids; target: Eyelids },
): { morphTracks: Map<string, MorphKeyframe[]>; unmapped: string[] } {
	const end = Math.max(0, ...tracks.map((t) => t.times[t.times.length - 1] ?? 0));
	const count = Math.round(end * FPS) + 1;
	const byMorph = new Map<string, number[]>();
	const source = new Map<string, number[]>();
	const unmapped: string[] = [];
	for (const track of tracks) {
		const values = Array.from({ length: count }, (_, f) => sampleAt(track, f / FPS));
		source.set(track.name, values);
		const candidates = MORPH_MAP[track.name] ?? [];
		const chosen = candidates.find((c) => c.every((m) => (!targetMorphs || targetMorphs.has(m)) && survivesVmd(m)));
		if (!chosen) {
			unmapped.push(track.name);
			continue;
		}
		for (const morph of chosen) {
			const into = byMorph.get(morph);
			byMorph.set(morph, into ? into.map((v, f) => Math.max(v, values[f])) : values.slice());
		}
	}
	if (lids) fitEyelids(byMorph, source, lids, count);
	const morphTracks = new Map<string, MorphKeyframe[]>();
	for (const [morphName, values] of byMorph) {
		if (values.every((v) => Math.abs(v) <= KEY_TOLERANCE)) continue;
		morphTracks.set(morphName, keepFrames(values).map((frame) => ({ morphName, frame, weight: values[frame] })));
	}
	return { morphTracks, unmapped };
}
