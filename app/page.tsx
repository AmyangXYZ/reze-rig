"use client"

import { Engine, Model, Vec3 } from "reze-engine"
import { useCallback, useEffect, useRef, useState } from "react"
import Loading from "@/components/loading"
import { FBXLoader } from "@/lib/fbx"
import { buildBindReferenceFromClip, measureTargetPositions, retargetClips } from "@/lib/retarget"
import type { AnimationClip, BoneRestPose } from "@/lib/fbx"
import { downloadArrayBuffer, toEngineClip } from "@/lib/engine-clip"
import { unzipToFiles } from "@/lib/uploads"
import { AnimPlayer } from "@/components/anim-player"
import { Button } from "@/components/ui/button"
import Link from "next/link"
import Image from "next/image"
import type { MaterialPresetMap } from "reze-engine"

const DEFAULT_MODEL_KEY = "thoth"

/** Fill the gaps in the engine's built-in CN name hints for the Thoth PMX
 *  (grouping mirrors reze-design's hand-authored scene doc for this model). */
const THOTH_STYLE_OVERRIDES: MaterialPresetMap = {
  body: ["手"],
  metal: ["指甲"],
}

export default function Home() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const engineRef = useRef<Engine | null>(null)
  const modelRef = useRef<Model | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const modelInputRef = useRef<HTMLInputElement>(null)
  const ueBindRefRef = useRef<Map<string, BoneRestPose> | null>(null)
  /** Target model's bind-pose bone positions, re-measured on every model swap. */
  const targetPositionsRef = useRef<Record<string, [number, number, number]> | null>(null)
  /** Engine registry key of the currently loaded model (for removeModel on swap). */
  const currentModelKeyRef = useRef(DEFAULT_MODEL_KEY)
  /** Last parsed source clips — re-retargeted when the target model changes. */
  const lastSourceRef = useRef<{ clips: AnimationClip[]; fileName?: string } | null>(null)
  const [engineError, setEngineError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [converting, setConverting] = useState(false)
  const [clipLoaded, setClipLoaded] = useState(false)
  const [vmdFileName, setVmdFileName] = useState<string | null>(null)
  /** Zip contained several PMX files — user picks which one to load. */
  const [modelPick, setModelPick] = useState<{ files: File[]; paths: string[] } | null>(null)

  /** Retarget parsed clips to the CURRENT model and start playback. */
  const convertAndPlay = useCallback(async (rawClips: AnimationClip[], fileName?: string) => {
    const engine = engineRef.current
    const model = modelRef.current
    if (!engine || !model) return

    const mmdClips = retargetClips(rawClips, {
      bindReference: ueBindRefRef.current,
      targetPositions: targetPositionsRef.current,
    })
    if (mmdClips.length === 0) return

    const clip = mmdClips[0]
    model.loadClip("default", toEngineClip(clip))
    model.show("default")
    engine.resetPhysics()
    model.play()

    setVmdFileName(fileName || clip.name + ".vmd")
    setClipLoaded(true)
  }, [])

  const loadFBXAndPlay = useCallback(async (fbxUrl: string, fileName?: string) => {
    setConverting(true)
    try {
      const fbxLoader = new FBXLoader()
      const isJson =
        (fileName?.toLowerCase().endsWith(".json") ?? false) ||
        fbxUrl.split("?")[0].toLowerCase().endsWith(".json")
      const rawClips = isJson
        ? await fbxLoader.loadJsonAsync(fbxUrl)
        : await fbxLoader.loadAsync(fbxUrl)

      lastSourceRef.current = { clips: rawClips, fileName }
      await convertAndPlay(rawClips, fileName)
    } catch (error) {
      console.error("Error loading FBX:", error)
      setEngineError(error instanceof Error ? error.message : "Conversion error")
    } finally {
      setConverting(false)
    }
  }, [convertAndPlay])

  /** Swap the target model, re-measure it, and re-retarget the current motion. */
  const loadModelFromFiles = useCallback(async (files: File[], pmxFile: File) => {
    const engine = engineRef.current
    if (!engine) return
    setConverting(true)
    try {
      const key = `u_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`
      try {
        engine.removeModel(currentModelKeyRef.current)
      } catch {
        /* stale key */
      }
      const model = await engine.loadModel(key, { files, pmxFile })
      modelRef.current = model
      currentModelKeyRef.current = key
      await engine.autoStyleGroups(key)
      await new Promise((r) => requestAnimationFrame(r))
      targetPositionsRef.current = measureTargetPositions((n) => model.getBoneWorldPosition(n))
      const src = lastSourceRef.current
      if (src) await convertAndPlay(src.clips, src.fileName)
    } catch (e) {
      console.error("Model load failed:", e)
      window.alert(e instanceof Error ? e.message : String(e))
    } finally {
      setConverting(false)
    }
  }, [convertAndPlay])

  const handleModelZip = useCallback(async (file: File) => {
    try {
      const files = await unzipToFiles(file)
      const pmxs = files.filter((f) => f.name.toLowerCase().endsWith(".pmx"))
      if (pmxs.length === 0) {
        window.alert("No .pmx file found in this zip.")
        return
      }
      if (pmxs.length === 1) {
        await loadModelFromFiles(files, pmxs[0])
      } else {
        setModelPick({ files, paths: pmxs.map((f) => f.name).sort((a, b) => a.localeCompare(b)) })
      }
    } catch (e) {
      window.alert(e instanceof Error ? e.message : String(e))
    }
  }, [loadModelFromFiles])

  const initEngine = useCallback(async () => {
    if (canvasRef.current) {
      try {
        // Lit-studio palette (reze-design's neutral empty-scene defaults): white
        // world+sun, dark #1c1c1e backdrop, charcoal ground. Colors below are the
        // linear-light equivalents of those sRGB hexes.
        const engine = new Engine(canvasRef.current, {
          world: { color: new Vec3(1, 1, 1), strength: 0.1 },
          sun: { color: new Vec3(1, 1, 1), strength: 2.0, direction: new Vec3(0.395, -0.358, 0.846) },
          background: new Vec3(0.11, 0.11, 0.118),
          camera: { distance: 35, target: new Vec3(0, 9, 0) },
        })
        engineRef.current = engine
        await engine.init()
        const model = await engine.loadModel(
          DEFAULT_MODEL_KEY,
          "/models/托特-扉页之吻/苍鹭·托特「扉页之吻」黑衣.pmx"
        )
        modelRef.current = model
        await engine.autoStyleGroups(DEFAULT_MODEL_KEY, THOTH_STYLE_OVERRIDES)
        engine.addGround({
          width: 200,
          height: 200,
          fadeEnd: 100,
          fadeStart: 50,
          diffuseColor: new Vec3(0.042, 0.042, 0.047),
          opacity: 0.42,
        })
        // IK stays ON: the exported VMD carries per-chain IK-disable frames and
        // engine 0.27 honors them. Physics on too — seeks call resetPhysics so
        // scrubbing can't explode the cloth.

        setLoading(false)
        engine.runRenderLoop()

        // Measure the model's bind-pose bone positions (drives segment alignment
        // and auto translation scale). Needs a settled frame, before any clip plays.
        await new Promise((r) => requestAnimationFrame(r))
        targetPositionsRef.current = measureTargetPositions((n) => model.getBoneWorldPosition(n))

        // Pre-load Idle.fbx as the canonical bind reference for UE-Mannequin / Unity
        // Humanoid clips. Some Unity per-pose exports (Run_Lfoot, Run_Stop_*) stash the
        // first animation frame as the rest pose; the retarget needs an actual bind to
        // subtract against.
        try {
          const refLoader = new FBXLoader()
          const refClips = await refLoader.loadAsync("/fbx/Idle.fbx")
          if (refClips[0]) ueBindRefRef.current = buildBindReferenceFromClip(refClips[0])
        } catch (e) {
          console.warn("Failed to load UE bind reference (Idle.fbx):", e)
        }

        // Auto-load demo FBX file
        await loadFBXAndPlay("/fbx/Rumba Dancing.fbx", "Rumba Dancing.vmd")

        setEngineError(null)
      } catch (error) {
        setEngineError(error instanceof Error ? error.message : "Unknown error")
      }
    }
  }, [loadFBXAndPlay])

  const handleFBXUpload = useCallback(async (file: File) => {
    const blobUrl = URL.createObjectURL(file)
    try {
      await loadFBXAndPlay(blobUrl, file.name.replace(/\.fbx$/i, '.vmd'))
    } finally {
      URL.revokeObjectURL(blobUrl)
    }
  }, [loadFBXAndPlay])

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file && /\.(fbx|json)$/i.test(file.name)) {
      handleFBXUpload(file)
    }
    // Reset input so same file can be selected again
    e.target.value = ''
  }, [handleFBXUpload])

  const handleUploadClick = useCallback(() => {
    fileInputRef.current?.click()
  }, [])

  useEffect(() => {
    void (async () => {
      initEngine()
    })()

    return () => {
      if (engineRef.current) {
        engineRef.current.dispose()
      }
    }
  }, [initEngine])

  return (
    <div className="fixed inset-0 w-full h-full overflow-hidden touch-none">
      <header className="absolute top-0 left-0 right-0 px-4 md:px-6 py-2 flex items-center gap-2 z-50 w-full select-none flex flex-row justify-between">
        <div className="flex items-center gap-2">
          <Link href="/">
            <h1
              className="text-2xl font-light tracking-[0.2em] md:tracking-[0.3em] text-white uppercase letter-spacing-wider"
              style={{
                textShadow: "0 0 20px rgba(255, 255, 255, 0.3), 0 2px 10px rgba(0, 0, 0, 0.5)",
                fontFamily: "var(--font-geist-sans)",
                fontWeight: 400,
              }}
            >
              REZE RIG
            </h1>
          </Link>
        </div>

        <div className="flex items-center gap-3">
          {/* Target model swap (PMX zip) — separate from the motion in/out pair */}
          <input
            ref={modelInputRef}
            type="file"
            accept=".zip,application/zip"
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) void handleModelZip(file)
              e.target.value = ""
            }}
            className="hidden"
          />
          <Button
            variant="outline"
            size="sm"
            onClick={() => modelInputRef.current?.click()}
            disabled={loading || converting}
          >
            Upload Model
          </Button>

          {/* Motion in → VMD out, as one group */}
          <input
            ref={fileInputRef}
            type="file"
            accept=".fbx,.json,application/json"
            onChange={handleFileChange}
            className="hidden"
          />
          <div className="flex items-center overflow-hidden rounded-md border border-white/15">
            <Button
              onClick={handleUploadClick}
              disabled={loading || converting}
              size="sm"
              className="rounded-none"
            >
              {converting ? "Converting..." : "Upload FBX"}
            </Button>
            <div className="h-6 w-px bg-white/15" />
            <Button
              size="sm"
              className="rounded-none bg-black hover:bg-black/80 text-white"
              onClick={() => {
                const buf = modelRef.current?.exportVmd("default")
                if (buf && vmdFileName) downloadArrayBuffer(buf, vmdFileName)
              }}
              disabled={loading || converting || !clipLoaded || !vmdFileName}
            >
              Download VMD
            </Button>
          </div>

          {/* GitHub Link */}
          <Button variant="outline" size="icon" asChild className="hover:bg-black hover:text-white rounded-full bg-black! size-7">
            <Link href="https://github.com/AmyangXYZ/Mixamo-MMD" target="_blank">
              <Image src="/github-mark-white.svg" alt="GitHub" width={17} height={17} />
            </Link>
          </Button>
        </div>
      </header>


      {engineError && (
        <div className="absolute inset-0 w-full h-full flex items-center justify-center text-white p-6 z-50 text-lg font-medium">
          Engine Error: {engineError}
        </div>
      )}
      {loading && !engineError && <Loading loading={loading} />}

      <canvas ref={canvasRef} className="absolute inset-0 w-full h-full touch-none z-1 bg-[#1c1c1e]" />

      {/* Transport */}
      {!loading && !engineError && (
        <div className="absolute bottom-4 left-4 right-4 z-50 flex justify-center">
          <AnimPlayer engineRef={engineRef} modelRef={modelRef} hasClip={clipLoaded} />
        </div>
      )}

      {/* Multiple PMX in the uploaded zip — pick one */}
      {modelPick && (
        <div
          className="absolute inset-0 z-[70] flex items-center justify-center bg-black/70"
          onClick={() => setModelPick(null)}
        >
          <div
            className="w-[min(28rem,90vw)] rounded-xl border border-white/10 bg-zinc-950/90 p-4 backdrop-blur-sm"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 text-sm text-white/80">This zip contains several PMX files — choose one:</div>
            <div className="max-h-[50vh] space-y-1 overflow-y-auto">
              {modelPick.paths.map((p) => (
                <button
                  key={p}
                  className="block w-full truncate rounded px-3 py-2 text-left text-sm text-white/70 hover:bg-white/10 hover:text-white"
                  onClick={() => {
                    const f = modelPick.files.find((x) => x.name === p)
                    setModelPick(null)
                    if (f) void loadModelFromFiles(modelPick.files, f)
                  }}
                >
                  {p}
                </button>
              ))}
            </div>
            <div className="mt-3 text-right">
              <Button size="sm" variant="ghost" onClick={() => setModelPick(null)}>
                Cancel
              </Button>
            </div>
          </div>
        </div>
      )}

      {!clipLoaded && (
        <div className="absolute z-10 left-6 bottom-4">
          <h1
            className="text-md text-white"
            style={{
              textShadow: "0 0 20px rgba(255, 255, 255, 0.2), 0 2px 10px rgba(0, 0, 0, 0.3)",
              fontFamily: "var(--font-geist-sans)",
              fontWeight: 400,
            }}
          >
            Powered by [ <Link href="https://github.com/AmyangXYZ/reze-engine" target="_blank" className="text-blue-200 font-medium">Reze Engine</Link> ]
          </h1>
        </div>
      )}
    </div>
  )
}
