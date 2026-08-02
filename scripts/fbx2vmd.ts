/**
 * Batch FBX→VMD converter (node-side, no browser, no GPU).
 *
 * Usage:  npx esbuild scripts/fbx2vmd.ts --bundle --platform=node --format=esm \
 *           --outfile=<tmp>/fbx2vmd.mjs && node <tmp>/fbx2vmd.mjs <files-or-dirs...> \
 *           [--out <dir>] [--in-place] [--bind-ref <idle.fbx>]
 *
 * Directories are scanned recursively for .fbx; each clip writes <out>/<basename>.vmd
 * (filename preserved, output flattened). Target positions come from
 * public/mmd-skeleton.json (same dump the validate harness uses). The bind
 * reference defaults to an Idle.fbx found among the inputs — Unity/UE per-pose
 * exports embed a mid-cycle stride as their rest pose, so anchoring them to the
 * idle keeps "delta from rest" honest; Mixamo-shaped clips ignore it.
 */
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from "node:fs"
import { basename, join } from "node:path"

import { parseFbxToAnimationClips } from "../lib/fbx"
import { buildBindReferenceFromClip, retargetClips } from "../lib/retarget"
import { toEngineClip } from "../lib/engine-clip"
import { VMDWriter, PmxLoader } from "reze-engine"

interface MmdSkeletonDump {
  bones: { name: string; worldPosition: number[] }[]
}

/** Bind-pose world positions measured from the actual target PMX — the CLI twin of the
 *  site's live measureTargetPositions. Never a canned skeleton dump: alignment (foot
 *  direction especially — heels!) must respect the model the VMDs will play on. */
function measurePmxTargetPositions(pmxPath: string): Record<string, [number, number, number]> {
  const buf = readFileSync(pmxPath)
  const model = PmxLoader.loadFromBuffer(toArrayBuffer(buf))
  const bones = model.getSkeleton().bones
  const world: ([number, number, number] | null)[] = new Array(bones.length).fill(null)
  const compute = (i: number): [number, number, number] => {
    const cached = world[i]
    if (cached) return cached
    const b = bones[i]
    const p: [number, number, number] = b.parentIndex >= 0 ? compute(b.parentIndex) : [0, 0, 0]
    const w: [number, number, number] = [
      p[0] + b.bindTranslation[0],
      p[1] + b.bindTranslation[1],
      p[2] + b.bindTranslation[2],
    ]
    world[i] = w
    return w
  }
  const out: Record<string, [number, number, number]> = {}
  for (let i = 0; i < bones.length; i++) {
    if (!(bones[i].name in out)) out[bones[i].name] = compute(i)
  }
  return out
}

function collectFbx(path: string, out: string[]): void {
  const st = statSync(path)
  if (st.isDirectory()) {
    for (const entry of readdirSync(path)) collectFbx(join(path, entry), out)
  } else if (/\.fbx$/i.test(path)) {
    out.push(path)
  }
}

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
}

function main(): void {
  const args = process.argv.slice(2)
  const inputs: string[] = []
  let outDir: string | null = null
  let inPlace = false
  let footIK = false
  let bindRefPath: string | null = null
  let targetPmxPath: string | null = null
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--out") outDir = args[++i]
    else if (args[i] === "--in-place") inPlace = true
    else if (args[i] === "--foot-ik") footIK = true
    else if (args[i] === "--bind-ref") bindRefPath = args[++i]
    else if (args[i] === "--target-pmx") targetPmxPath = args[++i]
    else inputs.push(args[i])
  }
  if (inputs.length === 0) {
    console.error(
      "usage: fbx2vmd <files-or-dirs...> [--out <dir>] [--target-pmx <model.pmx>] [--in-place] [--foot-ik] [--bind-ref <idle.fbx>]"
    )
    process.exit(1)
  }

  const files: string[] = []
  for (const input of inputs) collectFbx(input, files)
  files.sort()
  if (files.length === 0) {
    console.error("no .fbx files found")
    process.exit(1)
  }

  let targetPositions: Record<string, [number, number, number]>
  if (targetPmxPath) {
    targetPositions = measurePmxTargetPositions(targetPmxPath)
    console.log(`target skeleton: measured from ${targetPmxPath}`)
  } else {
    // Legacy fallback; prefer --target-pmx so alignment respects the actual model.
    const mmdSkel = JSON.parse(readFileSync(join(process.cwd(), "public", "mmd-skeleton.json"), "utf8")) as MmdSkeletonDump
    targetPositions = {}
    for (const b of mmdSkel.bones) {
      targetPositions[b.name] = [b.worldPosition[0], b.worldPosition[1], b.worldPosition[2]]
    }
    console.log("target skeleton: public/mmd-skeleton.json (pass --target-pmx to measure the real model)")
  }

  const refFile = bindRefPath ?? files.find((f) => basename(f).toLowerCase() === "idle.fbx") ?? null
  let bindReference: ReturnType<typeof buildBindReferenceFromClip> | null = null
  if (refFile) {
    const refClips = parseFbxToAnimationClips(toArrayBuffer(readFileSync(refFile)))
    if (refClips[0]) {
      bindReference = buildBindReferenceFromClip(refClips[0])
      console.log(`bind reference: ${refFile}`)
    }
  }

  if (outDir) mkdirSync(outDir, { recursive: true })
  const writer = new VMDWriter()

  let ok = 0
  for (const file of files) {
    const name = basename(file).replace(/\.fbx$/i, "")
    try {
      const clips = parseFbxToAnimationClips(toArrayBuffer(readFileSync(file)))
      if (clips.length === 0) throw new Error("no animation clips")
      if (clips.length > 1) console.warn(`${name}: ${clips.length} clips, converting the first`)
      const [mmd] = retargetClips([clips[0]], { targetPositions, bindReference, inPlace, footIK })
      const vmd = writer.write(toEngineClip(mmd))
      const outPath = join(outDir ?? join(file, ".."), `${name}.vmd`)
      writeFileSync(outPath, Buffer.from(vmd))
      console.log(`${name}.vmd  (${(vmd.byteLength / 1024).toFixed(0)} KB)`)
      ok++
    } catch (e) {
      console.error(`FAILED ${name}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  console.log(`${ok}/${files.length} converted`)
  process.exit(ok === files.length ? 0 : 1)
}

main()
