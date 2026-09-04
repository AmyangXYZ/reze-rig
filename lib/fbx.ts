import { inflate } from 'pako';
import { Quat } from 'reze-engine';

// ============================================================
// FBX Parser - Pure FBX binary parsing and animation extraction
// No MMD-specific conversions - returns raw animation data
// ============================================================

export type FBXProperty = boolean | number | bigint | string | boolean[] | number[] | bigint[] | ArrayBuffer;

export interface FBXNode {
	name: string;
	props: FBXProperty[];
	nodes: FBXNode[];
}

export type FBXData = FBXNode[];


// Animation data structures
export interface BoneHierarchy {
	parent: string | null;  // Parent bone name, or null if root
	children: string[];      // Child bone names
}

export interface AnimationClip {
	name: string;
	duration: number;
	tracks: BoneTrack[];
	positionTracks: PositionTrack[];
	hierarchy?: Map<string, BoneHierarchy>;  // Bone name -> hierarchy info
	/**
	 * Bone name → its WORLD transform when the mesh was skinned, as a 16-float
	 * column-major matrix (FBX `TransformLink` on each skin cluster). This is the
	 * skeleton's true bind pose, and unlike the Model nodes' rest properties it
	 * survives an exporter that writes the current frame as the rest pose.
	 * Present only for files that ship a skinned mesh.
	 */
	bindPoses?: Map<string, number[]>;
}

export interface BoneRestPose {
	lclRotation: [number, number, number];  // Euler in radians
	lclTranslation: [number, number, number] | null;  // Bone position (head_local)
	preRotation: [number, number, number] | null;
	postRotation: [number, number, number] | null;
}

export interface BoneTrack {
	name: string;
	original_name: string;
	times: number[];
	quats: Quat[];
	restPose: BoneRestPose | null;  // Rest pose for computing world quaternions
}

export interface PositionTrack {
	name: string;
	original_name: string;
	times: number[];
	positions: [number, number, number][];  // [x, y, z] for each keyframe
}

function degToRad(degrees: number): number {
	return degrees * Math.PI / 180;
}

/** Older JSON mixed rad `lclRotation` with deg `preRotation`/`postRotation` (FBX Properties70). */
function prePostEulerJsonToRadIfNeeded(a: number, b: number, c: number): [number, number, number] {
	const m = Math.max(Math.abs(a), Math.abs(b), Math.abs(c));
	if (m > 2.5) return [degToRad(a), degToRad(b), degToRad(c)];
	return [a, b, c];
}

/** Deserialize animation clips exported as JSON (e.g. Unity/Tool dump matching our AnimationClip shape). */
export function animationClipsFromJson(text: string): AnimationClip[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (e) {
		throw new Error(`Invalid animation JSON: ${e instanceof Error ? e.message : String(e)}`);
	}
	const list = Array.isArray(parsed) ? parsed : [parsed];
	const clips: AnimationClip[] = [];
	for (const item of list) {
		if (!item || typeof item !== 'object') continue;
		const o = item as Record<string, unknown>;
		const name = typeof o.name === 'string' ? o.name : 'Clip';
		const duration = typeof o.duration === 'number' ? o.duration : -1;
		const rawTracks = Array.isArray(o.tracks) ? o.tracks : [];
		const rawPos = Array.isArray(o.positionTracks) ? o.positionTracks : [];

		const tracks: BoneTrack[] = rawTracks.map((t) => {
			const tr = t as Record<string, unknown>;
			const boneName = String(tr.name ?? '');
			const times = (tr.times as number[]) || [];
			const rawQuats = (tr.quats as Array<{ x: number; y: number; z: number; w: number }>) || [];
			const quats = rawQuats.map((q) => new Quat(Number(q.x), Number(q.y), Number(q.z), Number(q.w)));
			let restPose: BoneRestPose | null = null;
			if (tr.restPose && typeof tr.restPose === 'object') {
				const rp = tr.restPose as Record<string, unknown>;
				const lr = rp.lclRotation;
				const lt = rp.lclTranslation;
				const pr = rp.preRotation;
				const por = rp.postRotation;
				if (Array.isArray(lr) && lr.length >= 3) {
					restPose = {
						lclRotation: [Number(lr[0]), Number(lr[1]), Number(lr[2])],
						lclTranslation: Array.isArray(lt) && lt.length >= 3
							? [Number(lt[0]), Number(lt[1]), Number(lt[2])]
							: null,
						preRotation: Array.isArray(pr) && pr.length >= 3
							? prePostEulerJsonToRadIfNeeded(Number(pr[0]), Number(pr[1]), Number(pr[2]))
							: null,
						postRotation: Array.isArray(por) && por.length >= 3
							? prePostEulerJsonToRadIfNeeded(Number(por[0]), Number(por[1]), Number(por[2]))
							: null,
					};
				}
			}
			return {
				name: boneName,
				original_name: typeof tr.original_name === 'string' ? tr.original_name : boneName,
				times,
				quats,
				restPose,
			};
		});

		const positionTracks: PositionTrack[] = rawPos.map((p) => {
			const pt = p as Record<string, unknown>;
			const pname = String(pt.name ?? '');
			const posList = (pt.positions as unknown[]) || [];
			const positions: [number, number, number][] = posList.map((row) => {
				if (Array.isArray(row) && row.length >= 3) {
					return [Number(row[0]), Number(row[1]), Number(row[2])];
				}
				if (row && typeof row === 'object' && 'x' in row && 'y' in row && 'z' in row) {
					const v = row as Record<string, number>;
					return [Number(v.x), Number(v.y), Number(v.z)];
				}
				return [0, 0, 0];
			});
			return {
				name: pname,
				original_name: typeof pt.original_name === 'string' ? pt.original_name : pname,
				times: (pt.times as number[]) || [],
				positions,
			};
		});

		if (tracks.length === 0 && positionTracks.length === 0) continue;
		// Optional, and worth carrying: without it the topology falls back to the
		// canonical humanoid table, which drops any unmapped bone sitting between
		// two mapped ones (Character Creator's Pelvis, between hip and thighs)
		// along with the rotation it was folding into its children.
		let hierarchy: Map<string, BoneHierarchy> | undefined;
		if (o.hierarchy && typeof o.hierarchy === 'object') {
			hierarchy = new Map();
			for (const [boneName, raw] of Object.entries(o.hierarchy as Record<string, unknown>)) {
				const h = (raw ?? {}) as Record<string, unknown>;
				hierarchy.set(boneName, {
					parent: typeof h.parent === 'string' ? h.parent : null,
					children: Array.isArray(h.children) ? h.children.map(String) : [],
				});
			}
		}
		clips.push({
			name,
			duration,
			tracks,
			positionTracks,
			hierarchy,
		});
	}
	if (clips.length === 0) {
		if (looksLikeReallusionSidecar(parsed)) {
			throw new Error('That JSON is Character Creator\'s material sidecar, not animation — upload the .fbx beside it.');
		}
		throw new Error('Animation JSON contained no tracks');
	}
	return clips;
}

/**
 * Reallusion Character Creator / iClone write a material-and-physics sidecar
 * named after the FBX, which reads as "the skeleton must be in the JSON". It
 * isn't: the FBX carries the whole rig, and this file is for material import.
 */
function looksLikeReallusionSidecar(parsed: unknown): boolean {
	if (!parsed || typeof parsed !== 'object') return false;
	for (const value of Object.values(parsed as Record<string, unknown>)) {
		if (!value || typeof value !== 'object') continue;
		const o = value as Record<string, unknown>;
		if ('Object' in o && ('Version' in o || 'Scene' in o)) return true;
	}
	return false;
}

export class FBXReaderNode {
	public fbxNode: FBXNode;

	constructor(fbxNode: FBXNode) {
		this.fbxNode = fbxNode;
	}

	private nodeFilter(a?: string | { [index: number]: FBXProperty }, b?: { [index: number]: FBXProperty }) {
		let name: string | undefined = undefined;
		let propFilter: { [index: number]: FBXProperty } | undefined = undefined;
		if (typeof a === 'string') {
			name = a;
			if (typeof b !== 'undefined') propFilter = b;
		} else propFilter = a;

		let filter: (node: FBXNode) => boolean;
		if (typeof propFilter !== 'undefined') {
			const propFilterFunc = (node: FBXNode) => {
				for (const prop in propFilter) {
					const index = parseInt(prop);
					if (node.props[index] !== propFilter![index]) return false;
				}
				return true;
			};

			if (typeof name !== 'undefined') {
				filter = (node) => node.name === name && propFilterFunc(node);
			} else {
				filter = propFilterFunc;
			}
		} else {
			filter = (node) => node.name === name;
		}

		return filter;
	}

	/**
	 * Returns the first matching node
	 * @param name filter for node name
	 * @param propFilter filter for property by index and value
	 */
	node(name: string, propFilter?: { [index: number]: FBXProperty }): FBXReaderNode | undefined;
	node(propFilter?: { [index: number]: FBXProperty }): FBXReaderNode | undefined;
	node(a?: string | { [index: number]: FBXProperty }, b?: { [index: number]: FBXProperty }): FBXReaderNode | undefined {
		const node = this.fbxNode.nodes.find(this.nodeFilter(a, b));
		if (typeof node === 'undefined') return;
		return new FBXReaderNode(node);
	}

	/**
	 * Returns all matching nodes
	 * @param name filter for node name
	 * @param propFilter filter for property by index and value
	 */
	nodes(name: string, propFilter?: { [index: number]: FBXProperty }): FBXReaderNode[];
	nodes(propFilter?: { [index: number]: FBXProperty }): FBXReaderNode[];
	nodes(a?: string | { [index: number]: FBXProperty }, b?: { [index: number]: FBXProperty }): FBXReaderNode[] {
		const nodes = this.fbxNode.nodes.filter(this.nodeFilter(a, b)).map((node) => new FBXReaderNode(node));
		return nodes;
	}

	/**
	 * Returns the value of the property
	 * @param index index of the property
	 * @param type test for property type, otherwise return undefined
	 */
	prop(index: number, type: 'boolean'): boolean | undefined;
	prop(index: number, type: 'number'): number | undefined;
	prop(index: number, type: 'bigint'): bigint | undefined;
	prop(index: number, type: 'string'): string | undefined;
	prop(index: number, type: 'boolean[]'): boolean[] | undefined;
	prop(index: number, type: 'number[]'): number[] | undefined;
	prop(index: number, type: 'bigint[]'): bigint[] | undefined;
	prop(index: number): FBXProperty | undefined;
	prop(
		index: number,
		type?: 'boolean' | 'number' | 'bigint' | 'string' | 'boolean[]' | 'number[]' | 'bigint[]'
	): FBXProperty | undefined {
		const prop = this.fbxNode.props[index];
		if (typeof type === 'undefined') return prop;
		if (type === 'boolean') return typeof prop === 'boolean' ? prop : undefined;
		if (type === 'number') return typeof prop === 'number' ? prop : undefined;
		if (type === 'bigint') return typeof prop === 'bigint' ? prop : undefined;
		if (type === 'string') return typeof prop === 'string' ? prop : undefined;
		// array types
		if (!Array.isArray(prop)) return undefined;
		if (prop.length == 0) return prop;
		if (type === 'boolean[]') return typeof prop[0] === 'boolean' ? prop : undefined;
		if (type === 'number[]') return typeof prop[0] === 'number' ? prop : undefined;
		if (type === 'bigint[]') return typeof prop[0] === 'bigint' ? prop : undefined;
		return undefined;
	}
}

export class FBXReader extends FBXReaderNode {
	public fbx: FBXData;

	constructor(fbx: FBXData) {
		const rootNode: FBXNode = {
			name: '',
			props: [],
			nodes: fbx,
		};

		super(rootNode);

		this.fbx = fbx;
	}
}

// FBX Loader - animation only
export class FBXLoader {
	private path: string = '';

	constructor() {}

	setPath(path: string): this {
		this.path = path;
		return this;
	}

	async loadAsync(url: string): Promise<AnimationClip[]> {
		return new Promise((resolve, reject) => {
			this.load(url, resolve, undefined, reject);
		});
	}

	/** Fetch URL as text and parse animation JSON (Unity-style dumps, same schema as AnimationClip). */
	async loadJsonAsync(url: string): Promise<AnimationClip[]> {
		const res = await fetch(this.path + url);
		if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
		return animationClipsFromJson(await res.text());
	}

	private static urlLooksLikeJson(url: string): boolean {
		const u = url.split('?')[0].toLowerCase();
		return u.endsWith('.json') || u.endsWith('.json/');
	}

	load(
		url: string,
		onLoad?: (clips: AnimationClip[]) => void,
		onProgress?: (progress: ProgressEvent) => void,
		onError?: (error: Error) => void
	) {
		const fullUrl = this.path + url;
		const asJson = FBXLoader.urlLooksLikeJson(fullUrl) || FBXLoader.urlLooksLikeJson(url);
		const fetchPromise = asJson
			? fetch(fullUrl).then(r => {
				if (!r.ok) throw new Error(`HTTP error! status: ${r.status}`);
				return r.text().then(t => ({ kind: 'json' as const, text: t }));
			})
			: fetch(fullUrl).then(r => {
				if (!r.ok) throw new Error(`HTTP error! status: ${r.status}`);
				return r.arrayBuffer().then(buf => ({ kind: 'binary' as const, buffer: buf }));
			});

		fetchPromise
			.then(payload => {
				try {
					if (payload.kind === 'json') {
						if (onLoad) onLoad(animationClipsFromJson(payload.text));
						return;
					}
					const fbxData = this.parse(payload.buffer);
					const reader = new FBXReader(fbxData);
					const clips = new AnimationParser(reader).parse();
					if (onLoad) onLoad(clips);
				} catch (e) {
					const error = e instanceof Error ? e : new Error(String(e));
					if (onError) {
						onError(error);
					} else {
						console.error(e);
					}
				}
			})
			.catch(error => {
				if (onError) {
					onError(error instanceof Error ? error : new Error(String(error)));
				} else {
					console.error(error);
				}
			});
	}

	private parse(buffer: ArrayBuffer): FBXData {
		const binary = new Uint8Array(buffer);
		return parseBinary(binary);
	}
}

// Animation Parser - extracts only animation data
class AnimationParser {
	private reader: FBXReader;

	constructor(reader: FBXReader) {
		this.reader = reader;
	}

	parse(): AnimationClip[] {
		const clips: AnimationClip[] = [];

		// Find AnimationStack nodes
		const objects = this.reader.node('Objects');
		if (!objects) return clips;

		const animationStacks = objects.nodes('AnimationStack');
		
		for (const stack of animationStacks) {
			const clip = this.parseAnimationStack(stack);
			if (clip) clips.push(clip);
		}

		return clips;
	}

	private parseAnimationStack(stack: FBXReaderNode): AnimationClip | null {
		const name = stack.prop(1, 'string') || 'Animation';
		
		// Find connected AnimationLayer
		const connections = this.reader.node('Connections');
		if (!connections) return null;

		const stackId = stack.prop(0, 'number');
		if (stackId === undefined) return null;

		// Find layers connected to this stack
		// Connection format: C: "OO", <from>, <to>, <relationship>
		// We want connections where <to> is stackId
		const allConnections = connections.nodes('C');
		const layerNodes = allConnections.filter(c => {
			const toId = c.prop(2, 'number');
			return toId === stackId;
		});
		
		if (layerNodes.length === 0) return null;

		const tracks: BoneTrack[] = [];
		const positionTracks: PositionTrack[] = [];

		// Process each layer
		for (const layerConn of layerNodes) {
			// Connection format: C: "OO", <from>, <to>, <relationship>
			// layerConn.prop(1) is from (layer ID), prop(2) is to (stack ID)
			const layerId = layerConn.prop(1, 'number');
			if (layerId === undefined) continue;

			const objects = this.reader.node('Objects');
			if (!objects) continue;

			const layer = objects.node('AnimationLayer', { 0: layerId });
			if (!layer) continue;

			// Find curve nodes connected to this layer
			// Connections where <to> is layerId
			const allConnections = this.reader.node('Connections');
			if (!allConnections) continue;
			const allLayerConns = allConnections.nodes('C');
			const layerCurveNodes = allLayerConns.filter(c => {
				const toId = c.prop(2, 'number');
				return toId === layerId;
			});
			
			for (const curveNodeConn of layerCurveNodes) {
				// Connection format: C: "OO", <from>, <to>, <relationship>
				// curveNodeConn.prop(1) is from (curveNode ID), prop(2) is to (layer ID)
				const curveNodeId = curveNodeConn.prop(1, 'number');
				if (curveNodeId === undefined) continue;

				const curveNode = objects.node('AnimationCurveNode', { 0: curveNodeId });
				if (!curveNode) continue;

				// Get model ID from connection
				// Find connections where <from> is curveNodeId and has a relationship
				const allConns = this.reader.node('Connections');
				if (!allConns) continue;
				const allCurveConns = allConns.nodes('C');
				const modelConn = allCurveConns.find(c => {
					const fromId = c.prop(1, 'number');
					const rel = c.prop(3, 'string');
					return fromId === curveNodeId && rel && rel !== '';
				});

				if (!modelConn) continue;

				const modelId = modelConn.prop(2, 'number'); // to is the model
				if (modelId === undefined) continue;

				const model = objects.node('Model', { 0: modelId });
				if (!model) continue;

				const modelName = model.prop(1, 'string') || '';
				
				// Get rotation data from model (like Three.js)
				const preRotation = this.getPreRotation(model);
				const postRotation = this.getPostRotation(model);
				const lclRotation = this.getLclRotation(model);
				const lclTranslation = this.getLclTranslation(model);
				const eulerOrder = this.getRotationOrder(model);
				
				// Extract rest pose for bone hierarchy computation. FBX omits any
				// property whose value is the default — Mixamo drops Lcl Rotation for
				// zero-rotation joints (several RIGHT-side bones) while their
				// Lcl Translation and PreRotation still exist. Gating on lclRotation
				// alone silently discarded those, collapsing right-side bind
				// positions to the origin; a missing rotation just means zero.
				const restPose: BoneRestPose | null = (lclRotation || lclTranslation || preRotation || postRotation) ? {
					lclRotation: lclRotation ?? [0, 0, 0],
					lclTranslation: lclTranslation,
					preRotation: preRotation && preRotation.length >= 3 ? [preRotation[0], preRotation[1], preRotation[2]] as [number, number, number] : null,
					postRotation: postRotation && postRotation.length >= 3 ? [postRotation[0], postRotation[1], postRotation[2]] as [number, number, number] : null,
				} : null;
				
				// Parse rotation tracks (quaternions)
				const track = this.parseCurveNode(curveNode, modelName, preRotation, postRotation, eulerOrder, restPose);
				if (track) tracks.push(track);
				
				// Parse position tracks (translations)
				const posTrack = this.parsePositionCurveNode(curveNode, modelName);
				if (posTrack) positionTracks.push(posTrack);
			}
		}

		if (tracks.length === 0 && positionTracks.length === 0) return null;

		// Build bone hierarchy from Connections
		const hierarchy = this.buildBoneHierarchy(tracks.map(t => t.name));
		const bindPoses = this.extractBindPoses();

		return {
			name,
			duration: -1,
			tracks,
			positionTracks,
			hierarchy,
			bindPoses: bindPoses.size > 0 ? bindPoses : undefined
		};
	}

	/**
	 * Bind-pose world matrices from the skin. Each cluster binds one bone to the
	 * mesh and records `TransformLink`, that bone's world transform at bind time —
	 * the authoritative bind, written when the character was skinned rather than
	 * when this clip was exported.
	 */
	private extractBindPoses(): Map<string, number[]> {
		const out = new Map<string, number[]>();
		const objects = this.reader.node('Objects');
		if (!objects) return out;

		const modelName = new Map<number, string>();
		for (const m of objects.nodes('Model')) {
			const id = m.prop(0, 'number');
			const name = m.prop(1, 'string');
			if (id !== undefined && name) modelName.set(id, name);
		}

		// A bone Model connects INTO its cluster: C: "OO", boneId, clusterId.
		const boneOfCluster = new Map<number, string>();
		for (const c of this.reader.node('Connections')?.nodes('C') ?? []) {
			if (c.prop(0, 'string') !== 'OO') continue;
			const from = c.prop(1, 'number');
			const to = c.prop(2, 'number');
			if (from === undefined || to === undefined) continue;
			const name = modelName.get(from);
			if (name && !boneOfCluster.has(to)) boneOfCluster.set(to, name);
		}

		for (const d of objects.nodes('Deformer')) {
			if (d.prop(2, 'string') !== 'Cluster') continue;
			const id = d.prop(0, 'number');
			if (id === undefined) continue;
			const bone = boneOfCluster.get(id);
			const link = d.fbxNode.nodes.find(n => n.name === 'TransformLink');
			const m = link?.props[0];
			if (bone && Array.isArray(m) && m.length === 16 && !out.has(bone)) {
				out.set(bone, m as number[]);
			}
		}

		// A BindPose node records the same thing for files that ship no skin —
		// an animation-only export can still carry one, and it covers every node
		// rather than only those the mesh happens to be weighted to.
		for (const pose of objects.nodes('Pose')) {
			if (pose.prop(2, 'string') !== 'BindPose') continue;
			for (const entry of pose.fbxNode.nodes) {
				if (entry.name !== 'PoseNode') continue;
				const nodeId = entry.nodes.find(n => n.name === 'Node')?.props[0];
				const matrix = entry.nodes.find(n => n.name === 'Matrix')?.props[0];
				if (typeof nodeId !== 'number' || !Array.isArray(matrix) || matrix.length !== 16) continue;
				const bone = modelName.get(nodeId);
				if (bone && !out.has(bone)) out.set(bone, matrix as number[]);
			}
		}
		return out;
	}

	private buildBoneHierarchy(boneNames: string[]): Map<string, BoneHierarchy> {
		const hierarchy = new Map<string, BoneHierarchy>();
		const allConns = this.reader.node('Connections');
		if (!allConns) return hierarchy;

		// Initialize all bones
		for (const boneName of boneNames) {
			hierarchy.set(boneName, { parent: null, children: [] });
		}

		// Find parent-child relationships
		// Connection format: C: "OO", <child_model_id>, <parent_model_id>, ""
		// Or: C: "OO", <child_model_id>, <parent_model_id>, "LimbNode" (for bones)
		const allConnsList = allConns.nodes('C');
		const objects = this.reader.node('Objects');
		if (!objects) return hierarchy;

		// Build a map of model ID -> bone name
		const modelIdToName = new Map<number, string>();
		for (const boneName of boneNames) {
			// Find model with this name
			const model = objects.nodes('Model').find(m => {
				const name = m.prop(1, 'string');
				return name === boneName || name?.replace(/^mixamorig:?/i, '') === boneName.replace(/^mixamorig:?/i, '');
			});
			if (model) {
				const modelId = model.prop(0, 'number');
				if (modelId !== undefined) {
					modelIdToName.set(modelId, boneName);
				}
			}
		}

		// Process connections to find parent-child relationships
		for (const conn of allConnsList) {
			const childId = conn.prop(1, 'number');
			const parentId = conn.prop(2, 'number');

			// Only process "OO" (object-to-object) connections
			const connType = conn.prop(0, 'string');
			if (connType !== 'OO') continue;
			if (childId === undefined || parentId === undefined) continue;

			const childName = modelIdToName.get(childId);
			const parentName = modelIdToName.get(parentId);

			if (childName && parentName && hierarchy.has(childName) && hierarchy.has(parentName)) {
				// Set parent-child relationship
				const childHier = hierarchy.get(childName)!;
				const parentHier = hierarchy.get(parentName)!;
				childHier.parent = parentName;
				parentHier.children.push(childName);
			}
		}

		return hierarchy;
	}

	private getPreRotation(model: FBXReaderNode): number[] | null {
		// Check Properties70 first (newer format)
		// Properties70 format: P: "PreRotation", "Vector3D", "", "A", x, y, z
		// So prop(4) = x, prop(5) = y, prop(6) = z
		const props70 = model.node('Properties70');
		if (props70) {
			const preRotProp = props70.node('P', { 0: 'PreRotation' });
			if (preRotProp) {
				// Try as individual numbers first (Properties70 format)
				const x = preRotProp.prop(4, 'number');
				const y = preRotProp.prop(5, 'number');
				const z = preRotProp.prop(6, 'number');
				if (x !== undefined && y !== undefined && z !== undefined) {
					return [degToRad(x), degToRad(y), degToRad(z)];
				}
				// Fallback: try as array
				const rot = preRotProp.prop(4, 'number[]');
				if (rot && rot.length >= 3) {
					return [degToRad(rot[0]), degToRad(rot[1]), degToRad(rot[2])];
				}
			}
		}
		// Also check direct property (older format)
		const preRotDirect = model.node('PreRotation');
		if (preRotDirect) {
			const rot = preRotDirect.prop(0, 'number[]');
			if (rot && rot.length >= 3) {
				return [degToRad(rot[0]), degToRad(rot[1]), degToRad(rot[2])];
			}
		}
		return null;
	}

	private getPostRotation(model: FBXReaderNode): number[] | null {
		// Check Properties70 first (newer format)
		// Properties70 format: P: "PostRotation", "Vector3D", "", "A", x, y, z
		// So prop(4) = x, prop(5) = y, prop(6) = z
		const props70 = model.node('Properties70');
		if (props70) {
			const postRotProp = props70.node('P', { 0: 'PostRotation' });
			if (postRotProp) {
				// Try as individual numbers first (Properties70 format)
				const x = postRotProp.prop(4, 'number');
				const y = postRotProp.prop(5, 'number');
				const z = postRotProp.prop(6, 'number');
				if (x !== undefined && y !== undefined && z !== undefined) {
					return [degToRad(x), degToRad(y), degToRad(z)];
				}
				// Fallback: try as array
				const rot = postRotProp.prop(4, 'number[]');
				if (rot && rot.length >= 3) {
					return [degToRad(rot[0]), degToRad(rot[1]), degToRad(rot[2])];
				}
			}
		}
		// Also check direct property (older format)
		const postRotDirect = model.node('PostRotation');
		if (postRotDirect) {
			const rot = postRotDirect.prop(0, 'number[]');
			if (rot && rot.length >= 3) {
				return [degToRad(rot[0]), degToRad(rot[1]), degToRad(rot[2])];
			}
		}
		return null;
	}

	/**
	 * The order the file's three rotation channels compose in.
	 *
	 * FBX omits the property when it is the default, which is why every Mixamo
	 * rig here reports nothing — they are all plain XYZ. Exporters that pick
	 * another order say so, and taking their word for it matters most exactly
	 * where it is hardest to see: at gimbal lock, two channels swing to equal
	 * and opposite extremes that cancel only in the intended order. Compose
	 * them in any other and a knee bent to 85° acquires an 80° twist.
	 */
	private getRotationOrder(model: FBXReaderNode): string {
		const props = model.node('Properties70')?.nodes('P') ?? [];
		for (const p of props) {
			if (p.prop(0, 'string') !== 'RotationOrder') continue;
			const v = p.prop(4, 'number');
			return FBX_ROTATION_ORDERS[Number(v)] ?? 'XYZ';
		}
		return 'XYZ';
	}

	private getLclRotation(model: FBXReaderNode): [number, number, number] | null {
		// Check Properties70 first (newer format)
		const props70 = model.node('Properties70');
		if (props70) {
			const lclRotProp = props70.node('P', { 0: 'Lcl Rotation' });
			if (lclRotProp) {
				const x = lclRotProp.prop(4, 'number');
				const y = lclRotProp.prop(5, 'number');
				const z = lclRotProp.prop(6, 'number');
				if (x !== undefined && y !== undefined && z !== undefined) {
					// Convert from degrees to radians
					return [x * Math.PI / 180, y * Math.PI / 180, z * Math.PI / 180];
				}
			}
		}
		// Also check direct property (older format)
		const lclRotDirect = model.node('Lcl Rotation');
		if (lclRotDirect) {
			const rot = lclRotDirect.prop(0, 'number[]');
			if (rot && rot.length >= 3) {
				// Convert from degrees to radians
				return [rot[0] * Math.PI / 180, rot[1] * Math.PI / 180, rot[2] * Math.PI / 180];
			}
		}
		return null;
	}

	private getLclTranslation(model: FBXReaderNode): [number, number, number] | null {
		// Check Properties70 first (newer format)
		const props70 = model.node('Properties70');
		if (props70) {
			const lclTransProp = props70.node('P', { 0: 'Lcl Translation' });
			if (lclTransProp) {
				const x = lclTransProp.prop(4, 'number');
				const y = lclTransProp.prop(5, 'number');
				const z = lclTransProp.prop(6, 'number');
				if (x !== undefined && y !== undefined && z !== undefined) {
					return [x, y, z];
				}
			}
		}
		// Also check direct property (older format)
		const lclTransDirect = model.node('Lcl Translation');
		if (lclTransDirect) {
			const trans = lclTransDirect.prop(0, 'number[]');
			if (trans && trans.length >= 3) {
				return [trans[0], trans[1], trans[2]];
			}
		}
		return null;
	}

	private parseCurveNode(curveNode: FBXReaderNode, modelName: string, preRotation: number[] | null = null, postRotation: number[] | null = null, eulerOrder: string = 'XYZ', restPose: BoneRestPose | null = null): BoneTrack | null {
		const attrName = curveNode.prop(1, 'string') || '';

		// Only parse rotation (quaternion) tracks
		if (attrName !== 'R') return null;

		// Find connected AnimationCurves
		const connections = this.reader.node('Connections');
		if (!connections) return null;

		const curveNodeId = curveNode.prop(0, 'number');
		if (curveNodeId === undefined) return null;

		// Find connections where <to> is curveNodeId
		const allConns = connections.nodes('C');
		const curveConns = allConns.filter(c => {
			const toId = c.prop(2, 'number');
			return toId === curveNodeId;
		});
		
		const curves: { x?: { times: number[], values: number[] }, y?: { times: number[], values: number[] }, z?: { times: number[], values: number[] } } = {};

		for (const conn of curveConns) {
			const relationship = conn.prop(3, 'string') || '';
			// Connection format: C: "OO", <from>, <to>, <relationship>
			// <from> is the curve ID
			const curveId = conn.prop(1, 'number');
			if (curveId === undefined) continue;

			const objects = this.reader.node('Objects');
			if (!objects) continue;

			const curve = objects.node('AnimationCurve', { 0: curveId });
			if (!curve) continue;

			// Get key times and values
			// These are stored as properties, not child nodes
			// KeyTime is typically prop index 4, KeyValueFloat is prop index 5
			// But let's search for them by name in child nodes first
			const keyTime = curve.node('KeyTime');
			const keyValueFloat = curve.node('KeyValueFloat');

			// If not found as nodes, try as properties
			let times: number[] = [];
			let values: number[] = [];
			
			if (keyTime) {
				const timeArray = keyTime.prop(0, 'number[]');
				if (timeArray) {
					times = timeArray.map(t => convertFBXTimeToSeconds(t));
				}
			} else {
				// Try finding KeyTime in properties (usually index 4)
				const timeProp = curve.prop(4, 'number[]');
				if (timeProp) {
					times = timeProp.map(t => convertFBXTimeToSeconds(t));
				}
			}

			if (keyValueFloat) {
				const valueArray = keyValueFloat.prop(0, 'number[]');
				if (valueArray) {
					values = valueArray;
				}
			} else {
				// Try finding KeyValueFloat in properties (usually index 5)
				const valueProp = curve.prop(5, 'number[]');
				if (valueProp) {
					values = valueProp;
				}
			}

			if (times.length === 0 || values.length === 0) continue;
			if (times.length !== values.length) {
				console.warn(`parseCurveNode: times.length (${times.length}) !== values.length (${values.length}) for relationship "${relationship}"`);
				continue;
			}

			// Match axis relationships more precisely (e.g., "d|X", "d|Y", "d|Z" or just "X", "Y", "Z")
			// Check for exact axis match or axis at end of relationship string (after pipe separator)
			if (relationship === 'X' || relationship.endsWith('|X')) {
				curves.x = { times, values };
			} else if (relationship === 'Y' || relationship.endsWith('|Y')) {
				curves.y = { times, values };
			} else if (relationship === 'Z' || relationship.endsWith('|Z')) {
				curves.z = { times, values };
			}
		}

		// Generate quaternion track with default values for missing axes
		// Some FBX files only animate certain axes (e.g., Y and Z but not X).
		// Provide synthetic curves with zero rotation for missing axes.
		const hasAnyAxis = curves.x || curves.y || curves.z;
		if (!hasAnyAxis) return null;

		// Merge all times from available curves
		const allTimes = new Set<number>();
		[curves.x, curves.y, curves.z].forEach(c => {
			if (c) c.times.forEach(t => allTimes.add(t));
		});
		const mergedTimes = Array.from(allTimes).sort((a, b) => a - b);
		if (mergedTimes.length === 0) return null;

		// For missing axes, create synthetic curves with zero values at all times
		const x = curves.x || { times: mergedTimes, values: new Array(mergedTimes.length).fill(0) };
		const y = curves.y || { times: mergedTimes, values: new Array(mergedTimes.length).fill(0) };
		const z = curves.z || { times: mergedTimes, values: new Array(mergedTimes.length).fill(0) };

		const { times, quats } = this.generateQuaternions({
			x, y, z
		}, preRotation, postRotation, eulerOrder);
		if (quats.length === 0) return null;

		return {
			name: modelName,
			original_name: modelName,
			times,
			quats,
			restPose
		};
	}

	private parsePositionCurveNode(curveNode: FBXReaderNode, modelName: string): PositionTrack | null {
		const attrName = curveNode.prop(1, 'string') || '';

		// Only parse translation (T) tracks
		if (attrName !== 'T') return null;

		// Find connected AnimationCurves
		const connections = this.reader.node('Connections');
		if (!connections) return null;

		const curveNodeId = curveNode.prop(0, 'number');
		if (curveNodeId === undefined) return null;

		// Find connections where <to> is curveNodeId
		const allConns = connections.nodes('C');
		const curveConns = allConns.filter(c => {
			const toId = c.prop(2, 'number');
			return toId === curveNodeId;
		});
		
		const curves: { x?: { times: number[], values: number[] }, y?: { times: number[], values: number[] }, z?: { times: number[], values: number[] } } = {};

		for (const conn of curveConns) {
			const relationship = conn.prop(3, 'string') || '';
			const curveId = conn.prop(1, 'number');
			if (curveId === undefined) continue;

			const objects = this.reader.node('Objects');
			if (!objects) continue;

			const curve = objects.node('AnimationCurve', { 0: curveId });
			if (!curve) continue;

			const keyTime = curve.node('KeyTime');
			const keyValueFloat = curve.node('KeyValueFloat');
			const keyValueDouble = curve.node('KeyValueDouble');

			let times: number[] = [];
			let values: number[] = [];
			
			if (keyTime) {
				const timeArray = keyTime.prop(0, 'number[]');
				if (timeArray) {
					times = timeArray.map(t => convertFBXTimeToSeconds(t));
				}
			} else {
				const timeProp = curve.prop(4, 'number[]');
				if (timeProp) {
					times = timeProp.map(t => convertFBXTimeToSeconds(t));
				}
			}

			if (keyValueFloat) {
				const valueArray = keyValueFloat.prop(0, 'number[]');
				if (valueArray) {
					values = valueArray;
				}
			} else if (keyValueDouble) {
				const valueArray = keyValueDouble.prop(0, 'number[]');
				if (valueArray) {
					values = valueArray;
				}
			} else {
				// Try property indices - check both float and double arrays
				const valuePropFloat = curve.prop(5, 'number[]');
				const valuePropDouble = curve.prop(5, 'number[]'); // Some FBX files use double precision
				if (valuePropFloat && Array.isArray(valuePropFloat) && valuePropFloat.length > 0) {
					values = valuePropFloat;
				} else if (valuePropDouble && Array.isArray(valuePropDouble) && valuePropDouble.length > 0) {
					values = valuePropDouble;
				}
			}

			if (times.length === 0 || values.length === 0) continue;
			if (times.length !== values.length) continue;

			if (relationship === 'X' || relationship.endsWith('|X')) {
				curves.x = { times, values };
			} else if (relationship === 'Y' || relationship.endsWith('|Y')) {
				curves.y = { times, values };
			} else if (relationship === 'Z' || relationship.endsWith('|Z')) {
				curves.z = { times, values };
			}
		}

		// Handle partial axis animation: fill in missing axes with zero values
		const hasAnyAxis = curves.x || curves.y || curves.z;
		if (!hasAnyAxis) return null;

		const roundTime = (t: number) => Math.round(t * 1000000) / 1000000;
		const allTimes = new Set<number>();
		if (curves.x) curves.x.times.forEach(t => allTimes.add(roundTime(t)));
		if (curves.y) curves.y.times.forEach(t => allTimes.add(roundTime(t)));
		if (curves.z) curves.z.times.forEach(t => allTimes.add(roundTime(t)));
		const times = Array.from(allTimes).sort((a, b) => a - b);
		if (times.length === 0) return null;

		// For missing axes, create synthetic curves with zero values
		const x = curves.x || { times, values: new Array(times.length).fill(0) };
		const y = curves.y || { times, values: new Array(times.length).fill(0) };
		const z = curves.z || { times, values: new Array(times.length).fill(0) };

		const positions: [number, number, number][] = [];
		for (const time of times) {
			const xVal = this.interpolateValue(x.times, x.values, time);
			const yVal = this.interpolateValue(y.times, y.values, time);
			const zVal = this.interpolateValue(z.times, z.values, time);
			positions.push([xVal, yVal, zVal]);
		}

		if (positions.length === 0) return null;

		return {
			name: modelName,
			original_name: modelName,
			times,
			positions
		};
	}

	private interpolateValue(times: number[], values: number[], targetTime: number): number {
		if (times.length === 0 || values.length === 0) return 0;
		if (times.length !== values.length) {
			console.warn(`interpolateValue: times.length (${times.length}) !== values.length (${values.length})`);
			return 0;
		}
		if (targetTime <= times[0]) return values[0];
		if (targetTime >= times[times.length - 1]) return values[values.length - 1];

		// Find surrounding keyframes
		for (let i = 0; i < times.length - 1; i++) {
			if (targetTime >= times[i] && targetTime <= times[i + 1]) {
				const t = (targetTime - times[i]) / (times[i + 1] - times[i]);
				return values[i] + (values[i + 1] - values[i]) * t;
			}
		}
		return values[values.length - 1];
	}

	private generateQuaternions(curves: { x: { times: number[], values: number[] }, y: { times: number[], values: number[] }, z: { times: number[], values: number[] } }, _preRotation: number[] | null = null, _postRotation: number[] | null = null, eulerOrder: string = 'XYZ'): { times: number[], quats: Quat[] } {
		// Interpolate rotations using quaternion slerp (like Three.js)
		// This handles rotations >= 180 degrees properly
		const interpolated = this.interpolateRotations(curves.x, curves.y, curves.z, eulerOrder);
		const times = interpolated[0];
		const values = interpolated[1];

		// Do **not** multiply Pre/Post onto R keys: Mixamo (and our sandwich + calibration) assume
		// sampled quats are **Lcl ZXY** only; bind `q_a` uses Pre·Lcl·Post⁻¹ separately. Folding
		// Pre·Post into keys was tried and wrenches limbs/torso (~180° style blowups).
		void _preRotation;
		void _postRotation;

		const quats: Quat[] = [];

		// Validate that values.length is a multiple of 3
		if (values.length % 3 !== 0) {
			console.warn(`generateQuaternions: values.length (${values.length}) is not a multiple of 3`);
			return { times: [], quats: [] };
		}

		// Validate that times and values arrays match
		if (times.length !== values.length / 3) {
			console.warn(`generateQuaternions: times.length (${times.length}) !== values.length/3 (${values.length / 3})`);
			return { times: [], quats: [] };
		}

		// Convert Euler values to quaternions
		for (let i = 0; i < values.length; i += 3) {
			const xRad = values[i];
			const yRad = values[i + 1];
			const zRad = values[i + 2];

			const quat = eulerToQuaternionByOrder(xRad, yRad, zRad, eulerOrder);
			let resultQuat = new Quat(quat.x, quat.y, quat.z, quat.w);

			// Handle quaternion unrolling (prevent flips between frames)
			if (i > 0) {
				const prevQuat = quats[quats.length - 1];
				const dot = prevQuat.x * resultQuat.x + prevQuat.y * resultQuat.y +
				           prevQuat.z * resultQuat.z + prevQuat.w * resultQuat.w;
				if (dot < 0) {
					resultQuat = new Quat(-resultQuat.x, -resultQuat.y, -resultQuat.z, -resultQuat.w);
				}
			}

			quats.push(resultQuat);
		}

		return { times, quats };
	}
	
	// Interpolate rotations using quaternion slerp (like Three.js)
	// This properly handles rotations >= 180 degrees by converting to quaternions first
	// Merges all keyframe times from all three axes and interpolates each axis independently
	private interpolateRotations(curvex: { times: number[], values: number[] }, curvey: { times: number[], values: number[] }, curvez: { times: number[], values: number[] }, eulerOrder: string): [number[], number[]] {
		const times: number[] = [];
		const values: number[] = [];
		
		// Merge all times from all three curves
		// Round times to 6 decimal places to handle floating point precision issues
		const roundTime = (t: number) => Math.round(t * 1000000) / 1000000;
		const allTimes = new Set<number>();
		curvex.times.forEach(t => allTimes.add(roundTime(t)));
		curvey.times.forEach(t => allTimes.add(roundTime(t)));
		curvez.times.forEach(t => allTimes.add(roundTime(t)));
		const mergedTimes = Array.from(allTimes).sort((a, b) => a - b);
		
		if (mergedTimes.length === 0) return [[], []];
		
		// Interpolate each axis at each merged time
		const interpolatedValues: Array<[number, number, number]> = [];
		for (const time of mergedTimes) {
			const xVal = this.interpolateValue(curvex.times, curvex.values, time);
			const yVal = this.interpolateValue(curvey.times, curvey.values, time);
			const zVal = this.interpolateValue(curvez.times, curvez.values, time);
			interpolatedValues.push([xVal, yVal, zVal]);
		}
		
		// Add first frame
		if (interpolatedValues.length > 0) {
			const first = interpolatedValues[0];
			times.push(mergedTimes[0]);
			values.push(degToRad(first[0]));
			values.push(degToRad(first[1]));
			values.push(degToRad(first[2]));
		}
		
		// Process remaining frames with quaternion slerp for large rotations
		for (let i = 1; i < interpolatedValues.length; i++) {
			const initialValue = interpolatedValues[i - 1];
			const currentValue = interpolatedValues[i];
			
			if (isNaN(initialValue[0]) || isNaN(initialValue[1]) || isNaN(initialValue[2]) ||
			    isNaN(currentValue[0]) || isNaN(currentValue[1]) || isNaN(currentValue[2])) {
				continue;
			}
			
			const initialValueRad = initialValue.map(degToRad);
			const currentValueRad = currentValue.map(degToRad);
			
			const valuesSpan = [
				currentValue[0] - initialValue[0],
				currentValue[1] - initialValue[1],
				currentValue[2] - initialValue[2],
			];
			
			const absoluteSpan = [
				Math.abs(valuesSpan[0]),
				Math.abs(valuesSpan[1]),
				Math.abs(valuesSpan[2]),
			];
			
			// If any axis has span >= 180, interpolate using quaternion slerp
			if (absoluteSpan[0] >= 180 || absoluteSpan[1] >= 180 || absoluteSpan[2] >= 180) {
				const maxAbsSpan = Math.max(...absoluteSpan);
				const numSubIntervals = Math.ceil(maxAbsSpan / 180); // Use ceil to ensure smooth interpolation
				
				// Convert to quaternions
				const E1 = eulerToQuaternionByOrder(initialValueRad[0], initialValueRad[1], initialValueRad[2], eulerOrder);
				const E2 = eulerToQuaternionByOrder(currentValueRad[0], currentValueRad[1], currentValueRad[2], eulerOrder);
				
				const Q1 = new Quat(E1.x, E1.y, E1.z, E1.w);
				let Q2 = new Quat(E2.x, E2.y, E2.z, E2.w);
				
				// Check unroll
				if (Q1.x * Q2.x + Q1.y * Q2.y + Q1.z * Q2.z + Q1.w * Q2.w < 0) {
					Q2 = new Quat(-Q2.x, -Q2.y, -Q2.z, -Q2.w);
				}
				
				// Interpolate using slerp
				const initialTime = mergedTimes[i - 1];
				const timeSpan = mergedTimes[i] - initialTime;
				const step = 1 / numSubIntervals;
				
				// Include intermediate frames (but not t=0, which is already added)
				for (let t = step; t < 1; t += step) {
					const Q = Quat.slerp(Q1, Q2, t);
					const E = quaternionToEulerForOrder(Q, eulerOrder);
					
					times.push(initialTime + t * timeSpan);
					values.push(E.x);
					values.push(E.y);
					values.push(E.z);
				}
				// Always include the final frame (t=1)
				times.push(mergedTimes[i]);
				values.push(degToRad(currentValue[0]));
				values.push(degToRad(currentValue[1]));
				values.push(degToRad(currentValue[2]));
			} else {
				// No interpolation needed
				times.push(mergedTimes[i]);
				values.push(degToRad(currentValue[0]));
				values.push(degToRad(currentValue[1]));
				values.push(degToRad(currentValue[2]));
			}
		}
		
		return [times, values];
	}
}

/** Parse binary FBX to clips (same pipeline as {@link FBXLoader} binary `fetch` path). */
export function parseFbxToAnimationClips(buffer: ArrayBuffer): AnimationClip[] {
	const fbxData = parseBinary(new Uint8Array(buffer));
	const reader = new FBXReader(fbxData);
	return new AnimationParser(reader).parse();
}

/** Raw node-tree access for tooling/diagnostics (per-bone properties, orders, poses). */
export function parseFbxTree(buffer: ArrayBuffer): FBXReader {
	return new FBXReader(parseBinary(new Uint8Array(buffer)));
}

// Simple BinaryReader implementation
class BinaryReader {
	binary: Uint8Array;
	offset: number;

	constructor(binary: Uint8Array) {
		this.binary = binary;
		this.offset = 0;
	}

	readUint8(): number {
		const value = this.binary[this.offset];
		this.offset += 1;
		return value;
	}

	readUint8AsBool(): boolean {
		return this.readUint8() !== 0;
	}

	readUint8AsString(): string {
		return String.fromCharCode(this.readUint8());
	}

	readUint8Array(length: number): Uint8Array {
		const value = this.binary.slice(this.offset, this.offset + length);
		this.offset += length;
		return value;
	}

	readInt16(): number {
		const value = new DataView(this.binary.buffer, this.offset, 2).getInt16(0, true);
		this.offset += 2;
		return value;
	}

	readInt32(): number {
		const value = new DataView(this.binary.buffer, this.offset, 4).getInt32(0, true);
		this.offset += 4;
		return value;
	}

	readUint32(): number {
		const value = new DataView(this.binary.buffer, this.offset, 4).getUint32(0, true);
		this.offset += 4;
		return value;
	}

	readUint64(): bigint {
		const low = this.readUint32();
		const high = this.readUint32();
		return BigInt(high) * BigInt(0x100000000) + BigInt(low);
	}

	readInt64(): number {
		const low = this.readUint32();
		const high = this.readUint32();
		
		if (high & 0x80000000) {
			// Negative number
			const negLow = (~low + 1) & 0xFFFFFFFF;
			const negHigh = (~high) & 0xFFFFFFFF;
			if (negLow === 0) {
				return -(Number(negHigh) * 0x100000000);
			}
			return -(Number(negHigh) * 0x100000000 + Number(negLow));
		}
		
		return Number(high) * 0x100000000 + Number(low);
	}

	readFloat32(): number {
		const value = new DataView(this.binary.buffer, this.offset, 4).getFloat32(0, true);
		this.offset += 4;
		return value;
	}

	readFloat64(): number {
		const value = new DataView(this.binary.buffer, this.offset, 8).getFloat64(0, true);
		this.offset += 8;
		return value;
	}

	readArrayAsString(length: number): string {
		const bytes = this.readUint8Array(length);
		// Find null terminator
		let nullIndex = bytes.indexOf(0);
		if (nullIndex === -1) nullIndex = bytes.length;
		return new TextDecoder().decode(bytes.slice(0, nullIndex));
	}
}

// Binary Parser
function parseBinary(binary: Uint8Array): FBXData {
	const MAGIC = Uint8Array.from('Kaydara FBX Binary\x20\x20\x00\x1a\x00'.split(''), (v) => v.charCodeAt(0));
	
	if (binary.length < MAGIC.length) throw new Error('Not a binary FBX file');
	const data = new BinaryReader(binary);
	
	const magic = data.readUint8Array(MAGIC.length).every((v, i) => v === MAGIC[i]);
	if (!magic) throw new Error('Not a binary FBX file');
	
	const fbxVersion = data.readUint32();
	const header64 = fbxVersion >= 7500;

	const fbx: FBXData = [];

	while (true) {
		const subnode = readNode(data, header64);
		if (subnode === null) break;
		fbx.push(subnode);
	}

	return fbx;
}

function readNode(data: BinaryReader, header64: boolean): FBXNode | null {
	const endOffset = header64 ? Number(data.readUint64()) : data.readUint32();
	if (endOffset === 0) return null;
	
	const numProperties = header64 ? Number(data.readUint64()) : data.readUint32();
	// Skip propertyListLen
	if (header64) {
		data.readUint64();
	} else {
		data.readUint32();
	}
	const nameLen = data.readUint8();
	const name = data.readArrayAsString(nameLen);

	const node: FBXNode = {
		name,
		props: [],
		nodes: [],
	};

	// Properties
	for (let i = 0; i < numProperties; ++i) {
		node.props.push(readProperty(data));
	}

	// Node List
	while (endOffset - data.offset > 13) {
		const subnode = readNode(data, header64);
		if (subnode !== null) node.nodes.push(subnode);
	}
	data.offset = endOffset;

	return node;
}

function readProperty(data: BinaryReader): FBXProperty {
	const typeCode = data.readUint8AsString();

	let value: FBXProperty;

	switch (typeCode) {
		case 'Y':
			value = data.readInt16();
			break;
		case 'C':
			value = data.readUint8AsBool();
			break;
		case 'I':
			value = data.readInt32();
			break;
		case 'F':
			value = data.readFloat32();
			break;
		case 'D':
			value = data.readFloat64();
			break;
		case 'L':
			value = data.readInt64();
			// Convert BigInt when possible
			if (typeof value === 'number') {
				if (value < Number.MIN_SAFE_INTEGER || value > Number.MAX_SAFE_INTEGER) {
					// Keep as is
				} else {
					value = Number(value);
				}
			}
			break;
		case 'f':
			value = readPropertyArray(data, (r) => r.readFloat32()) as number[];
			break;
		case 'd':
			value = readPropertyArray(data, (r) => r.readFloat64()) as number[];
			break;
		case 'l':
			value = readPropertyArray(data, (r) => r.readInt64()) as number[];
			// Convert BigInt array when possible
			for (let i = 0; i < value.length; ++i) {
				const v = (value as number[])[i];
				if (v < Number.MIN_SAFE_INTEGER || v > Number.MAX_SAFE_INTEGER) continue;
				(value as number[])[i] = Number(v);
			}
			break;
		case 'i':
			value = readPropertyArray(data, (r) => r.readInt32()) as number[];
			break;
		case 'b':
			value = readPropertyArray(data, (r) => r.readUint8AsBool()) as boolean[];
			break;
		case 'S':
			value = data.readArrayAsString(data.readUint32());
			// Replace '\x00\x01' by '::' and flip like in the text files
			if (typeof value === 'string' && value.indexOf('\x00\x01') !== -1) {
				value = value.split('\x00\x01').reverse().join('::');
			}
			break;
		case 'R':
			value = Array.from(data.readUint8Array(data.readUint32()));
			break;
		default:
			throw new Error(`Unknown Property Type ${typeCode.charCodeAt(0)}`);
	}

	return value;
}

function readPropertyArray(data: BinaryReader, reader: (r: BinaryReader) => number | boolean): number[] | boolean[] {
	const arrayLength = data.readUint32();
	const encoding = data.readUint32();
	const compressedLength = data.readUint32();
	let arrayData = new BinaryReader(data.readUint8Array(compressedLength));

	if (encoding === 1) {
		// Decompress using pako
		const decompressed = inflate(arrayData.binary);
		arrayData = new BinaryReader(new Uint8Array(decompressed));
	}

	const value: (number | boolean)[] = [];
	for (let i = 0; i < arrayLength; ++i) {
		value.push(reader(arrayData));
	}

	return value as number[] | boolean[];
}

// Utility functions

function convertFBXTimeToSeconds(time: number): number {
	return time / 46186158000;
}


/**
 * Intrinsic **ZYX** Euler → quaternion — matches Three.js `Quaternion.setFromEuler` / FBXLoader **default** `RotationOrder` for **PreRotation** and **PostRotation** (not the animated Lcl order).
 */
function eulerToQuatIntrinsicZYX(x: number, y: number, z: number): Quat {
	return Quat.fromEulerOrder(x, y, z, "ZYX");
}

/** FBX's RotationOrder enum, in its own numbering. 6 is spherical XYZ, which
 *  no rig here uses; it falls back to the default. */
const FBX_ROTATION_ORDERS: Record<number, string> = {
	0: 'XYZ', 1: 'XZY', 2: 'YZX', 3: 'YXZ', 4: 'ZXY', 5: 'ZYX', 6: 'XYZ',
};

/** An FBX order names the axes in the sequence they are applied; the quaternion
 *  helper names them in composition sequence, which is the reverse. */
const REVERSED_ORDER: Record<string, Parameters<typeof Quat.fromEulerOrder>[3]> = {
	XYZ: 'ZYX', XZY: 'YZX', YZX: 'XZY', YXZ: 'ZXY', ZXY: 'YXZ', ZYX: 'XYZ',
};

// Historically this took the label 'ZXY' and composed intrinsic ZYX — correct
// only because every rig it ever saw was really the FBX default, XYZ. It now
// reads the order the file declares and reverses it into composition sequence,
// which leaves those files on exactly the same path.
function eulerToQuaternionByOrder(x: number, y: number, z: number, order: string): Quat {
	const composition = REVERSED_ORDER[order];
	if (!composition) return Quat.identity();
	return Quat.fromEulerOrder(x, y, z, composition);
}

/** Full local rest **Pre·Lcl·Post⁻¹** (Three.FBXLoader-compatible): Lcl **ZXY** (see {@link AnimationParser} curves), Pre/Post **ZYX**, Post stored inverted in file. */
export function bindQuatFromBoneRestPose(rest: BoneRestPose | null): Quat | null {
	if (!rest?.lclRotation || rest.lclRotation.length < 3) return null;
	const t = eulerToQuaternionByOrder(rest.lclRotation[0], rest.lclRotation[1], rest.lclRotation[2], 'XYZ');
	let q = new Quat(t.x, t.y, t.z, t.w);
	if (rest.preRotation && rest.preRotation.length >= 3) {
		const qPre = eulerToQuatIntrinsicZYX(rest.preRotation[0], rest.preRotation[1], rest.preRotation[2]);
		q = qPre.multiply(q);
	}
	if (rest.postRotation && rest.postRotation.length >= 3) {
		const qPost = eulerToQuatIntrinsicZYX(rest.postRotation[0], rest.postRotation[1], rest.postRotation[2]);
		// Three.FBXLoader: postRotation quaternion is inverted before multiply
		q = q.multiply(new Quat(-qPost.x, -qPost.y, -qPost.z, qPost.w));
	}
	return q.normalize();
}

/** LclRotation only — matches parent-local `R` keys from {@link AnimationParser} / {@link generateQuaternions}. */
export function bindQuatFromRestPoseLclOnly(rest: BoneRestPose | null): Quat | null {
	if (!rest?.lclRotation || rest.lclRotation.length < 3) return null;
	const t = eulerToQuaternionByOrder(rest.lclRotation[0], rest.lclRotation[1], rest.lclRotation[2], 'XYZ');
	return new Quat(t.x, t.y, t.z, t.w).normalize();
}

/**
 * FBX joint rest **Pre·Lcl** (ZXY eulers, radians) — Mixamo limbs often have ~0 Lcl + large Pre; sandwich `q_a` must include Pre or it reads as identity vs calibrated T-pose table.
 * `R` curves still animate Lcl only in our parser; this does not change key sampling, only the per-clip bind quaternion used for Mixamo→MMD sandwich.
 */
export function bindQuatFromRestPosePreLcl(rest: BoneRestPose | null): Quat | null {
	if (!rest) return null;
	const e = (x: number, y: number, z: number) => eulerToQuaternionByOrder(x, y, z, 'XYZ');
	const toQ = (t: { x: number; y: number; z: number; w: number }) => new Quat(t.x, t.y, t.z, t.w);
	if (rest.lclRotation && rest.lclRotation.length >= 3) {
		let q = toQ(e(rest.lclRotation[0], rest.lclRotation[1], rest.lclRotation[2]));
		if (rest.preRotation && rest.preRotation.length >= 3) {
			q = eulerToQuatIntrinsicZYX(rest.preRotation[0], rest.preRotation[1], rest.preRotation[2]).multiply(q);
		}
		return q.normalize();
	}
	if (rest.preRotation && rest.preRotation.length >= 3) {
		return eulerToQuatIntrinsicZYX(rest.preRotation[0], rest.preRotation[1], rest.preRotation[2]);
	}
	return null;
}

/**
 * Decompose back to the Euler triple this file's curves are written in.
 *
 * Only the >=180° subdivision path needs this, and it needs it badly: it turns a
 * slerped quaternion back into angles, so a decomposition that disagrees with the
 * composition writes a key nothing else can read. Wraps are where that path fires,
 * and a wrapped channel at gimbal lock — an arm held at X=+85° whose Y crosses
 * -360° — lands on both problems at once.
 *
 * Default-order files keep the original decomposition, mismatch and all, so their
 * output does not move.
 */
function quaternionToEulerForOrder(q: Quat, order: string): { x: number, y: number, z: number } {
	const composition = REVERSED_ORDER[order];
	if (!composition || order === 'XYZ') return quaternionToEuler(q);
	const e = Quat.toEulerOrder(q, composition);
	return { x: e.x, y: e.y, z: e.z };
}

// NOTE: this decomposition is intrinsic ZXY (engine `Quat.toEulerOrder(q, "ZXY")`),
// while every euler→quat composition in this file is intrinsic ZYX — the pair does not
// round-trip for large angles (kept as-is to preserve existing retarget output; the
// mismatch only affects the >=180° slerp-subdivision path in interpolateRotations).
function quaternionToEuler(q: Quat): { x: number, y: number, z: number } {
    const qx = q.x, qy = q.y, qz = q.z, qw = q.w;
    
    // R[2][1] = 2(qy*qz + qw*qx) = sin(rx)
    const sinX = 2 * (qy * qz + qw * qx);
    let rx: number, ry: number, rz: number;
    
    if (Math.abs(sinX) >= 0.9999) {
        // Gimbal lock: X rotation is ±90°
        // At gimbal lock, Y and Z rotations become coupled
        // We can only determine Y+Z, so we arbitrarily set Z=0
        rx = Math.sign(sinX) * Math.PI / 2;
        rz = 0;
        // Compute Y rotation from the remaining degrees of freedom
        // R[0][1] = 2(qx*qy - qw*qz) = sin(ry+rz) at gimbal lock
        // R[1][1] = 1 - 2(qx² + qz²) = cos(ry+rz) at gimbal lock
        ry = Math.atan2(
            2 * (qx * qy + qw * qz),  // Note: + instead of - due to gimbal lock
            1 - 2 * (qy * qy + qz * qz)
        );
    } else {
        rx = Math.asin(sinX);
        // R[2][0] = 2(qx*qz - qw*qy)
        // R[2][2] = 1 - 2(qx² + qy²)
        // ry = atan2(-R[2][0], R[2][2])
        ry = Math.atan2(
            -(2 * (qx * qz - qw * qy)),
            1 - 2 * (qx * qx + qy * qy)
        );
        
        // R[0][1] = 2(qx*qy - qw*qz)
        // R[1][1] = 1 - 2(qx² + qz²)
        // rz = atan2(-R[0][1], R[1][1])
        rz = Math.atan2(
            -(2 * (qx * qy - qw * qz)),
            1 - 2 * (qx * qx + qz * qz)
        );
    }
    
    return { x: rx, y: ry, z: rz };
}