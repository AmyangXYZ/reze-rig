import { Vec3, type CameraKeyframe } from 'reze-engine';
import { eulerToQuaternionByOrder, FBX_ROTATION_ORDERS, parseFbxTree, type FBXNode, type FBXProperty } from './fbx';
import { q4Rot, type Q4, type V3 } from './retarget-core';

/**
 * Camera FBX → MMD camera track.
 *
 * An FBX states a shot as a camera node: translation and rotation curves, with
 * the lens on its attribute as a focal length over a film back. MMD states it as
 * a point looked at, how far back the eye sits from it, an euler orientation and
 * a whole-degree vertical field of view. This reads the first and writes the
 * second, one key per frame, converting the scene: its units to MMD's, right-
 * handed to left-handed.
 */

const FBX_TICKS_PER_SECOND = 46186158000;
const FPS = 30;
const MM_PER_INCH = 25.4;
const DEG = Math.PI / 180;
/** MMD's unit is 8 cm. */
const MMD_UNITS_PER_METRE = 12.5;
/** A standard MMD figure — 1.6 m, 20 units — carries her head bone 1.41 m
 *  above her ankles. */
const MMD_FIGURE_HEIGHT = 1.41 * MMD_UNITS_PER_METRE;

/** The camera as the file states it, sampled at 30fps in the file's own frame. */
export interface FbxCamera {
	name: string;
	frames: FbxCameraFrame[];
}

export interface FbxCameraFrame {
	position: V3;
	/** Where the lens points, and the top of the frame. Unit length. */
	forward: V3;
	up: V3;
	/** Vertical field of view, degrees. */
	fovY: number;
}

interface Curve {
	times: number[];
	values: number[];
}

/** One animatable number: its curve when keyed, its property value otherwise. */
interface Channel {
	curve: Curve | null;
	value: number;
}

function sampleChannel(ch: Channel, t: number): number {
	const c = ch.curve;
	if (!c || c.times.length === 0) return ch.value;
	const n = c.times.length;
	if (t <= c.times[0]) return c.values[0];
	if (t >= c.times[n - 1]) return c.values[n - 1];
	let lo = 0;
	let hi = n - 1;
	while (hi - lo > 1) {
		const mid = (lo + hi) >> 1;
		if (c.times[mid] <= t) lo = mid;
		else hi = mid;
	}
	const span = c.times[hi] - c.times[lo];
	const w = span > 0 ? (t - c.times[lo]) / span : 0;
	return c.values[lo] + (c.values[hi] - c.values[lo]) * w;
}

/** Properties70 by name, template defaults first so the object's own values win. */
function properties(node: FBXNode | undefined, into = new Map<string, FBXProperty[]>()): Map<string, FBXProperty[]> {
	const p70 = node?.nodes.find((n) => n.name === 'Properties70');
	for (const p of p70?.nodes ?? []) {
		if (p.name === 'P') into.set(String(p.props[0]), p.props.slice(4));
	}
	return into;
}

function template(definitions: FBXNode | undefined, objectType: string): FBXNode | undefined {
	const type = definitions?.nodes.find((n) => n.name === 'ObjectType' && n.props[0] === objectType);
	return type?.nodes.find((n) => n.name === 'PropertyTemplate');
}

function num(props: Map<string, FBXProperty[]>, name: string, i = 0, fallback = 0): number {
	const v = props.get(name)?.[i];
	return typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : fallback;
}

function readCurve(node: FBXNode): Curve {
	const times = node.nodes.find((n) => n.name === 'KeyTime')?.props[0];
	const values = node.nodes.find((n) => n.name === 'KeyValueFloat')?.props[0];
	return {
		times: Array.isArray(times) ? times.map((t) => Number(t) / FBX_TICKS_PER_SECOND) : [],
		values: Array.isArray(values) ? values.map(Number) : [],
	};
}

/**
 * The camera in a camera FBX: an animated camera and no skeleton. Null for
 * anything else, so a character file with a camera parked in its scene still
 * converts as the motion it is.
 */
export function readCameraFbx(buffer: ArrayBuffer): FbxCamera | null {
	const tree = parseFbxTree(buffer);
	const objects = tree.node('Objects')?.fbxNode;
	const conns = tree.node('Connections')?.fbxNode.nodes.filter((c) => c.name === 'C') ?? [];
	const definitions = tree.node('Definitions')?.fbxNode;
	if (!objects) return null;
	if (objects.nodes.some((o) => o.name === 'Model' && o.props[2] === 'LimbNode')) return null;

	const byId = new Map<number, FBXNode>();
	for (const o of objects.nodes) byId.set(Number(o.props[0]), o);

	const attr = objects.nodes.find((o) => o.name === 'NodeAttribute' && o.props[2] === 'Camera');
	if (!attr) return null;
	const attrId = Number(attr.props[0]);
	const modelId = conns
		.map((c) => (c.props[0] === 'OO' && Number(c.props[1]) === attrId ? Number(c.props[2]) : NaN))
		.find((id) => byId.get(id)?.name === 'Model');
	const model = modelId !== undefined ? byId.get(modelId) : undefined;
	if (!model || modelId === undefined) return null;
	const parent = conns.find((c) => c.props[0] === 'OO' && Number(c.props[1]) === modelId);
	if (parent && byId.get(Number(parent.props[2]))?.name === 'Model') {
		throw new Error('camera is parented under another node — export it in world space');
	}

	// Curves reach a property through its curve node: curve → node ("d|X"),
	// node → object ("Lcl Translation").
	const curvesOf = (curveNodeId: number): Map<string, Curve> => {
		const out = new Map<string, Curve>();
		for (const c of conns) {
			if (c.props[0] !== 'OP' || Number(c.props[2]) !== curveNodeId) continue;
			const curve = byId.get(Number(c.props[1]));
			if (curve?.name === 'AnimationCurve') out.set(String(c.props[3]).replace(/^d\|/, ''), readCurve(curve));
		}
		return out;
	};
	const animated = new Map<string, Map<string, Curve>>();
	for (const c of conns) {
		if (c.props[0] !== 'OP') continue;
		const to = Number(c.props[2]);
		if (to !== modelId && to !== attrId) continue;
		if (byId.get(Number(c.props[1]))?.name !== 'AnimationCurveNode') continue;
		animated.set(String(c.props[3]), curvesOf(Number(c.props[1])));
	}
	if (!animated.has('Lcl Translation') && !animated.has('Lcl Rotation')) return null;

	const nodeProps = properties(model, properties(template(definitions, 'Model')));
	const lensProps = properties(attr, properties(template(definitions, 'NodeAttribute')));
	const channel = (props: Map<string, FBXProperty[]>, name: string, axis: string, i: number): Channel => ({
		curve: animated.get(name)?.get(axis) ?? null,
		value: num(props, name, i),
	});
	const vector = (name: string) => (['X', 'Y', 'Z'] as const).map((a, i) => channel(nodeProps, name, a, i));
	const translation = vector('Lcl Translation');
	const rotation = vector('Lcl Rotation');
	const order = FBX_ROTATION_ORDERS[num(nodeProps, 'RotationOrder')] ?? 'XYZ';
	const euler = (name: string) => eulerToQuaternionByOrder(
		num(nodeProps, name, 0) * DEG, num(nodeProps, name, 1) * DEG, num(nodeProps, name, 2) * DEG, 'XYZ',
	);
	const pre = euler('PreRotation');
	const postInv = euler('PostRotation').conjugate();

	// The lens. A focal length over the film back's height is the vertical angle
	// directly; files that key an angle instead say which one it is.
	const apertureMode = num(lensProps, 'ApertureMode', 0, 2);
	const focal = channel(lensProps, 'FocalLength', 'FocalLength', 0);
	const fov = channel(lensProps, 'FieldOfView', 'FieldOfView', 0);
	const fovYChannel = channel(lensProps, 'FieldOfViewY', 'FieldOfViewY', 0);
	const filmHeightMm = num(lensProps, 'FilmHeight', 0, 0.612) * MM_PER_INCH;
	const aspect = num(lensProps, 'AspectWidth', 0, 16) / num(lensProps, 'AspectHeight', 0, 9);
	const fovYAt = (t: number): number => {
		if (apertureMode === 3) return (2 * Math.atan(filmHeightMm / (2 * sampleChannel(focal, t)))) / DEG;
		if (apertureMode === 2) return sampleChannel(fov, t);
		if (apertureMode === 0) return sampleChannel(fovYChannel, t);
		return (2 * Math.atan(Math.tan((sampleChannel(fov, t) * DEG) / 2) / aspect)) / DEG;
	};

	let start = Infinity;
	let end = -Infinity;
	for (const curves of animated.values()) {
		for (const c of curves.values()) {
			if (c.times.length === 0) continue;
			start = Math.min(start, c.times[0]);
			end = Math.max(end, c.times[c.times.length - 1]);
		}
	}
	if (!Number.isFinite(start)) return null;

	const frames: FbxCameraFrame[] = [];
	const count = Math.round((end - start) * FPS) + 1;
	for (let f = 0; f < count; f++) {
		const t = start + f / FPS;
		const lcl = eulerToQuaternionByOrder(
			sampleChannel(rotation[0], t) * DEG, sampleChannel(rotation[1], t) * DEG, sampleChannel(rotation[2], t) * DEG, order,
		);
		const q = pre.clone().multiply(lcl).multiply(postInv).normalize();
		const r: Q4 = [q.x, q.y, q.z, q.w];
		// An FBX camera looks down its +X with +Y up.
		frames.push({
			position: [sampleChannel(translation[0], t), sampleChannel(translation[1], t), sampleChannel(translation[2], t)],
			forward: q4Rot(r, [1, 0, 0]),
			up: q4Rot(r, [0, 1, 0]),
			fovY: fovYAt(t),
		});
	}
	return { name: String(model.props[1]), frames };
}

const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalize = (v: V3): V3 => {
	const l = Math.hypot(v[0], v[1], v[2]) || 1;
	return [v[0] / l, v[1] / l, v[2] / l];
};

/** How far down the view axis a point sits; its straight-line distance for the
 *  rare shot that looks away from it. */
function depthOf(p: V3, eye: V3, forward: V3): number {
	const v: V3 = [p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]];
	const depth = v[0] * forward[0] + v[1] * forward[1] + v[2] * forward[2];
	return depth > 0 ? depth : Math.hypot(v[0], v[1], v[2]);
}

/** Along the view axis to its nearest pass by the origin's vertical line; the
 *  eye's own distance from that line when the shot looks away from it. */
function axisDepth(eye: V3, forward: V3): number {
	const flat = forward[0] * forward[0] + forward[2] * forward[2];
	const along = flat > 1e-6 ? -(eye[0] * forward[0] + eye[2] * forward[2]) / flat : 0;
	return along > 0 ? along : Math.hypot(eye[0], eye[2]);
}

/** The multiple of 2π that puts `angle` nearest `previous`. */
function unwrap(angle: number, previous: number): number {
	return angle + 2 * Math.PI * Math.round((previous - angle) / (2 * Math.PI));
}

/**
 * MMD units per unit of the scene a camera was shot in.
 *
 * A file's declared unit is not the scene's: the Unity export writes
 * UnitScaleFactor 1 (centimetres) over values in its own world units, and a
 * game world need not be metres at all — 109501's heroine stands 2.23 units
 * to her head bone, a 2.2 m woman if those were metres. The one thing in the
 * scene that knows its size is the figure filmed in it, so her bind-pose
 * height (ankles to head bone, measureFigureHeight) sets the unit: she becomes
 * a standard MMD figure, and the scene scales with her. Without a figure the
 * scene is taken as metres.
 */
export function sceneScale(figureHeight: number | null): number {
	return figureHeight ? MMD_FIGURE_HEIGHT / figureHeight : MMD_UNITS_PER_METRE;
}

/**
 * The shot as MMD camera keyframes, one per frame.
 *
 * Scene: positions scale by `scale` (sceneScale). MMD is left-handed, so Z
 * mirrors: the same handedness conversion the motion goes through, which keeps
 * the two in one world.
 *
 * Orientation: MMD builds the camera as fromEuler(−r) — yaw about Y, then pitch
 * about X, then roll about Z (reze-engine camera.ts, after babylon-mmd) — and
 * looks down that rotation's +Z with +Y up. Yaw and roll are unwrapped frame to
 * frame, because MMD interpolates the euler angles themselves and a wrap from
 * +179° to −179° would swing the long way round between two keys.
 *
 * Target: the figure the shot films (`subject`, MMD world) carried onto the
 * view axis, so the keyframes read in MMD as a camera looking at her. Without
 * one, where the view axis passes the vertical line through the scene origin,
 * where she stands.
 *
 * Lens: MMD stores the vertical angle in whole degrees. Keyed every frame, a
 * zoom turns into a staircase that pops her size ~4% per degree, so the eye
 * slides along the view axis by the rounded fraction: at the target the frame
 * spans exactly what the source's did, and she zooms smoothly. An angle that is
 * already whole leaves the eye where the source put it.
 */
export function cameraToMmd(camera: FbxCamera, scale: number, subject?: (t: number) => V3): CameraKeyframe[] {
	const keys: CameraKeyframe[] = [];
	let yaw = 0;
	let roll = 0;
	camera.frames.forEach((frame, i) => {
		const p = frame.position;
		const eye: V3 = [p[0] * scale, p[1] * scale, -p[2] * scale];
		const forward = normalize([frame.forward[0], frame.forward[1], -frame.forward[2]]);
		const rawUp: V3 = [frame.up[0], frame.up[1], -frame.up[2]];
		const up = normalize(cross(forward, cross(rawUp, forward)));
		const right = cross(up, forward);

		const pitch = Math.asin(Math.max(-1, Math.min(1, -forward[1])));
		yaw = i === 0 ? Math.atan2(forward[0], forward[2]) : unwrap(Math.atan2(forward[0], forward[2]), yaw);
		roll = i === 0 ? Math.atan2(right[1], up[1]) : unwrap(Math.atan2(right[1], up[1]), roll);

		const reach = Math.max(1, subject ? depthOf(subject(i / FPS), eye, forward) : axisDepth(eye, forward));
		const fov = Math.max(1, Math.round(frame.fovY));
		const back = (reach * Math.tan((frame.fovY * DEG) / 2)) / Math.tan((fov * DEG) / 2);

		keys.push({
			frame: i,
			distance: -back,
			target: new Vec3(eye[0] + forward[0] * reach, eye[1] + forward[1] * reach, eye[2] + forward[2] * reach),
			rotation: new Vec3(-pitch, -yaw, -roll),
			fov,
		});
	});
	return keys;
}
