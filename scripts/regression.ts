/**
 * Golden-output regression for the conversion corpus.
 *
 * Usage:  npx esbuild scripts/regression.ts --bundle --platform=node --format=esm \
 *           --outfile=<tmp>/regression.mjs && node <tmp>/regression.mjs [--update]
 *
 * Every verified conversion is pinned here: the rig profile, how many bones
 * mapped and aligned, the auto scale, and a checksum over every exported
 * rotation and translation. A change to the retarget that alters any of them
 * fails loudly, which is what makes "don't change the animations that already
 * work" checkable rather than a promise. `--update` re-pins, and the diff it
 * produces is the review.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import type { Quat } from "reze-engine"

import { parseFbxToAnimationClips, animationClipsFromJson, type AnimationClip } from "../lib/fbx"
import { buildBindReferenceFromClip, createSourcePreview, pickMotionClip, retargetClips } from "../lib/retarget"

const ROOT = process.cwd()
const GOLDEN = join(ROOT, "scripts", "regression.golden.json")

/** The site's own settings, so the pin tracks what users actually get. */
const OPTIONS = { footIK: true }

const CASES = [
  "public/fbx/Rumba Dancing.fbx",
  "public/fbx/Snake Hip Hop Dance.fbx",
  "public/fbx/Taunt.fbx",
  "public/fbx/Arms Down.fbx",
  "public/fbx/Idle.fbx",
  "public/fbx/Run_Lfoot.fbx",
  "public/fbx/Run_Start_L0.fbx",
  "public/fbx/Run_Start_R180.fbx",
  "public/fbx/Run_Stop_Lfoot.fbx",
  "public/fbx/dance-graceful.json",
]

interface Row {
  profile: string
  mapped: number
  aligned: number
  scale: number
  bindMissing: boolean
  frames: number
  rotationSum: number
  translationSum: number
}

function load(file: string): AnimationClip {
  const path = join(ROOT, file)
  if (file.endsWith(".json")) return pickMotionClip(animationClipsFromJson(readFileSync(path, "utf8")))!
  const b = readFileSync(path)
  return pickMotionClip(parseFbxToAnimationClips(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer))!
}

/** Order-independent, sign-independent, and sensitive to a change anywhere. */
function checksum(values: number[]): number {
  let sum = 0
  for (const v of values) sum += Math.round(v * 1e5) / 1e5
  return Math.round(sum * 1e4) / 1e4
}

function measure(file: string, targetPositions: Record<string, [number, number, number]>, bindReference: Map<string, never> | null): Row {
  const clip = load(file)
  const opts = { targetPositions, bindReference: bindReference ? [bindReference] : undefined, ...OPTIONS } as Parameters<typeof retargetClips>[1]
  const info = createSourcePreview(clip, opts).info
  const [out] = retargetClips([clip], opts)
  const rot: number[] = []
  for (const t of out.boneTracks) for (const q of t.quats as Quat[]) rot.push(Math.abs(q.x) + Math.abs(q.y) + Math.abs(q.z) + Math.abs(q.w))
  const pos: number[] = []
  for (const t of out.positionTracks) for (const p of t.positions) pos.push(p.x + p.y + p.z)
  return {
    profile: info.profile,
    mapped: info.mappedCount,
    aligned: info.alignedCount,
    scale: Math.round(info.scale * 1e4) / 1e4,
    bindMissing: info.bindMissing,
    frames: out.boneTracks[0]?.times.length ?? 0,
    rotationSum: checksum(rot),
    translationSum: checksum(pos),
  }
}

function main(): void {
  const update = process.argv.includes("--update")
  const dump = JSON.parse(readFileSync(join(ROOT, "public", "mmd-skeleton.json"), "utf8")) as {
    bones: { name: string; worldPosition: number[] }[]
  }
  const targetPositions: Record<string, [number, number, number]> = {}
  for (const b of dump.bones) targetPositions[b.name] = [b.worldPosition[0], b.worldPosition[1], b.worldPosition[2]]

  // The bundled UE bind, exactly as the site preloads it.
  let bindReference: Map<string, never> | null = null
  try {
    bindReference = buildBindReferenceFromClip(load("public/fbx/Idle.fbx")) as Map<string, never>
  } catch {
    /* absent in a trimmed checkout */
  }

  const current: Record<string, Row> = {}
  for (const file of CASES) {
    if (!existsSync(join(ROOT, file))) continue
    current[file] = measure(file, targetPositions, bindReference)
  }

  if (update || !existsSync(GOLDEN)) {
    writeFileSync(GOLDEN, JSON.stringify(current, null, 2) + "\n")
    console.log(`pinned ${Object.keys(current).length} conversions → ${GOLDEN.replace(ROOT + "/", "")}`)
    return
  }

  const golden = JSON.parse(readFileSync(GOLDEN, "utf8")) as Record<string, Row>
  let failed = 0
  for (const [file, now] of Object.entries(current)) {
    const was = golden[file]
    if (!was) {
      console.log(`NEW      ${file} (not pinned — run with --update)`)
      continue
    }
    const diffs = (Object.keys(now) as (keyof Row)[]).filter((k) => now[k] !== was[k])
    if (diffs.length === 0) {
      console.log(`ok       ${file}`)
      continue
    }
    failed++
    console.log(`CHANGED  ${file}`)
    for (const k of diffs) console.log(`           ${k}: ${was[k]} → ${now[k]}`)
  }
  for (const file of Object.keys(golden)) {
    if (!(file in current)) console.log(`MISSING  ${file} (pinned but not converted)`)
  }
  console.log(failed === 0 ? `\nall ${Object.keys(current).length} conversions unchanged` : `\n${failed} conversion(s) changed`)
  if (failed > 0) process.exitCode = 1
}

main()
