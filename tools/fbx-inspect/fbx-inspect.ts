/**
 * fbx-inspect — read what a clip actually does, out of the exported file.
 *
 * Built after a bake shipped files byte-identical to the broken ones while
 * reporting success: the correction was real, it just landed on a node nothing
 * downstream reads. A producer's own log says what it meant to do. This says
 * what is in the file.
 *
 * Reports, per clip: duration, key counts, rig profile, how the body is facing
 * at frame 0, how far it turns, and the largest single-frame jump on any bone.
 *
 * With --check it asserts those instead of printing them, and exits non-zero —
 * so a bake script can refuse to install a bad file.
 */
import { readFileSync } from "node:fs"
import { basename } from "node:path"

import { parseFbxToAnimationClips, type AnimationClip, type BoneTrack } from "../../lib/fbx"
import { detectRigProfile, mapsToMmdBone } from "../../lib/retarget"

interface Options {
	check: boolean
	facing: number | null    // expected frame-0 facing, degrees
	facingTol: number
	maxStep: number          // largest tolerated per-frame rotation, degrees
	maxStepFinger: number
	quiet: boolean
}

/**
 * Fingers get their own limit. A performance flicks a hand open inside two
 * frames — SPIN_04 snaps a ring finger across nearly the whole muscle range in
 * one 1/30s step, as authored — while the same jump on a spine or a leg is a
 * sign flip or a dropped key. One threshold for both either passes the defect
 * or fails the performance.
 */
const FINGER = /Thumb|Index|Middle|Ring|Pinky|Little/i

interface Quatish { x: number; y: number; z: number; w: number }

/** Yaw about Y, degrees, from a quaternion. */
function yawOf(q: Quatish): number {
	return (Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.x * q.x)) * 180) / Math.PI
}

/** Angle between two rotations, degrees. Sign-insensitive: q and -q are one rotation. */
function angleBetween(a: Quatish, b: Quatish): number {
	const dot = Math.abs(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w)
	return (2 * Math.acos(Math.min(1, dot)) * 180) / Math.PI
}

function shortestDelta(from: number, to: number): number {
	let d = to - from
	while (d > 180) d -= 360
	while (d < -180) d += 360
	return d
}

function findTrack(clip: AnimationClip, bone: string): BoneTrack | undefined {
	const re = new RegExp(`(^|:)${bone}$`, "i")
	return clip.tracks.find((t) => re.test(t.name) || re.test(t.original_name))
}

/** Duration from the track times. clip.duration is unset on this parse path. */
function durationOf(clip: AnimationClip): number {
	let max = 0
	for (const t of clip.tracks) {
		const last = t.times[t.times.length - 1]
		if (last > max) max = last
	}
	for (const t of clip.positionTracks) {
		const last = t.times[t.times.length - 1]
		if (last > max) max = last
	}
	return max
}

interface Report {
	name: string
	duration: number
	keys: number
	profile: string
	mapped: number
	facing: number | null       // frame-0 hips yaw
	turn: number | null         // unwrapped hips yaw across the clip
	worstStep: Step | null          // body bones
	worstFinger: Step | null
	nan: number
	problems: string[]
}

interface Step { bone: string; deg: number; key: number }

function inspect(path: string, opts: Options): Report[] {
	const buf = readFileSync(path)
	const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
	return parseFbxToAnimationClips(ab).map((clip) => {
		const problems: string[] = []
		const hips = findTrack(clip, "Hips")

		let facing: number | null = null
		let turn: number | null = null
		if (hips && hips.quats.length > 0) {
			facing = yawOf(hips.quats[0] as unknown as Quatish)
			turn = 0
			let prev = facing
			for (let i = 1; i < hips.quats.length; i++) {
				const y = yawOf(hips.quats[i] as unknown as Quatish)
				turn += shortestDelta(prev, y)
				prev = y
			}
		} else {
			problems.push("no Hips track — cannot read facing or turn")
		}

		// Largest single-frame rotation on ANY bone. A yaw-only check misses a
		// bone snapping about some other axis, which is the shape a quaternion
		// sign flip takes once the exporter has written it out as Euler.
		let worstStep: Step | null = null
		let worstFinger: Step | null = null
		let nan = 0
		for (const t of clip.tracks) {
			const isFinger = FINGER.test(t.name)
			for (let i = 0; i < t.quats.length; i++) {
				const q = t.quats[i] as unknown as Quatish
				if (!Number.isFinite(q.x + q.y + q.z + q.w)) nan++
				if (i === 0) continue
				const deg = angleBetween(t.quats[i - 1] as unknown as Quatish, q)
				if (isFinger) {
					if (!worstFinger || deg > worstFinger.deg) worstFinger = { bone: t.name, deg, key: i }
				} else if (!worstStep || deg > worstStep.deg) {
					worstStep = { bone: t.name, deg, key: i }
				}
			}
		}

		const mapped = clip.tracks.filter((t) => mapsToMmdBone(t.original_name || t.name)).length
		const keys = clip.tracks.reduce((n, t) => Math.max(n, t.times.length), 0)

		if (nan > 0) problems.push(`${nan} non-finite quaternion component(s)`)
		if (mapped === 0) problems.push("no bones map to the MMD skeleton")
		if (opts.facing !== null && facing !== null && Math.abs(shortestDelta(opts.facing, facing)) > opts.facingTol) {
			problems.push(
				`faces ${facing.toFixed(1)}° at frame 0, expected ${opts.facing.toFixed(1)}° ±${opts.facingTol}°`
			)
		}
		for (const [step, limit] of [
			[worstStep, opts.maxStep],
			[worstFinger, opts.maxStepFinger],
		] as [Step | null, number][]) {
			if (step && step.deg > limit) {
				problems.push(
					`${step.bone} jumps ${step.deg.toFixed(1)}° between keys ${step.key - 1}→${step.key} (limit ${limit}°)`
				)
			}
		}

		return {
			name: clip.name || basename(path),
			duration: durationOf(clip),
			keys,
			profile: detectRigProfile(clip),
			mapped,
			facing,
			turn,
			worstStep,
			worstFinger,
			nan,
			problems,
		}
	})
}

function main(): void {
	const args = process.argv.slice(2)
	const files: string[] = []
	const opts: Options = {
		check: false, facing: null, facingTol: 2, maxStep: 25, maxStepFinger: 90, quiet: false,
	}
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--check") opts.check = true
		else if (args[i] === "--facing") opts.facing = Number(args[++i])
		else if (args[i] === "--facing-tol") opts.facingTol = Number(args[++i])
		else if (args[i] === "--max-step") opts.maxStep = Number(args[++i])
		else if (args[i] === "--max-step-finger") opts.maxStepFinger = Number(args[++i])
		else if (args[i] === "--quiet") opts.quiet = true
		else files.push(args[i])
	}
	if (files.length === 0) {
		console.error(
			"usage: fbx-inspect <file.fbx...> [--check] [--facing <deg>] [--facing-tol <deg>]\n" +
				"                  [--max-step <deg>] [--max-step-finger <deg>] [--quiet]"
		)
		process.exit(2)
	}

	let bad = 0
	for (const file of files) {
		let reports: Report[]
		try {
			reports = inspect(file, opts)
		} catch (e) {
			console.error(`${basename(file)}: unreadable — ${e instanceof Error ? e.message : String(e)}`)
			bad++
			continue
		}
		if (reports.length === 0) {
			console.error(`${basename(file)}: no animation clips`)
			bad++
			continue
		}
		for (const r of reports) {
			const label = `${basename(file)}${reports.length > 1 ? ` · ${r.name}` : ""}`
			if (!opts.quiet) {
				console.log(`\n=== ${label} ===`)
				console.log(`  ${r.duration.toFixed(2)}s, ${r.keys} keys · ${r.profile} · ${r.mapped} bones map to MMD`)
				if (r.facing !== null) {
					console.log(`  facing at frame 0: ${r.facing.toFixed(1)}°   turn across clip: ${r.turn!.toFixed(1)}°`)
				}
				if (r.worstStep) {
					console.log(
						`  largest single-frame rotation: ${r.worstStep.deg.toFixed(1)}° on ${r.worstStep.bone} at key ${r.worstStep.key}`
					)
				}
				if (r.worstFinger) {
					console.log(
						`  largest on a finger:            ${r.worstFinger.deg.toFixed(1)}° on ${r.worstFinger.bone} at key ${r.worstFinger.key}`
					)
				}
			}
			if (r.problems.length > 0) {
				bad++
				for (const p of r.problems) console.error(`  ✗ ${label}: ${p}`)
			} else if (opts.check && !opts.quiet) {
				console.log("  ✓ passes")
			}
		}
	}

	if (opts.check) process.exit(bad > 0 ? 1 : 0)
	process.exit(0)
}

main()
