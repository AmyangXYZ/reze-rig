"use client"

import { Engine, Model, Vec3 } from "reze-engine"
import { useCallback, useEffect, useRef, useState } from "react"
import Loading from "@/components/loading"
import { FBXLoader } from "@/lib/fbx"
import { buildBindReferenceFromClip, measureTargetPositions, retargetClips } from "@/lib/retarget"
import type { BoneRestPose } from "@/lib/fbx"
import { convertToVMD, downloadBlob, getBlobURL } from "@/lib/vmd-writer"
import { Button } from "@/components/ui/button"
import { Slider } from "@/components/ui/slider"
import { Play, Pause } from "lucide-react"
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
  const ueBindRefRef = useRef<Map<string, BoneRestPose> | null>(null)
  /** Target model's bind-pose bone positions, measured once after load. */
  const targetPositionsRef = useRef<Record<string, [number, number, number]> | null>(null)
  const [engineError, setEngineError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [converting, setConverting] = useState(false)
  const [vmdBlob, setVmdBlob] = useState<Blob | null>(null)
  const [vmdFileName, setVmdFileName] = useState<string | null>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [isPaused, setIsPaused] = useState(false)
  const [progress, setProgress] = useState({ current: 0, duration: 0, percentage: 0 })

  const loadFBXAndPlay = useCallback(async (fbxUrl: string, fileName?: string) => {
    const engine = engineRef.current
    const model = modelRef.current
    if (!engine || !model) return

    setConverting(true)

    try {
      const fbxLoader = new FBXLoader()
      const isJson =
        (fileName?.toLowerCase().endsWith(".json") ?? false) ||
        fbxUrl.split("?")[0].toLowerCase().endsWith(".json")
      const rawClips = isJson
        ? await fbxLoader.loadJsonAsync(fbxUrl)
        : await fbxLoader.loadAsync(fbxUrl)

      const mmdClips = retargetClips(rawClips, {
        bindReference: ueBindRefRef.current,
        targetPositions: targetPositionsRef.current,
      })

      if (mmdClips.length > 0) {
        const clip = mmdClips[0]
        const vmd = convertToVMD(clip, 30)
        const vmdFileName = fileName || clip.name + '.vmd'
        const vmdUrl = getBlobURL(vmd)

        setVmdBlob(vmd)
        setVmdFileName(vmdFileName)

        await model.loadVmd("default", vmdUrl)
        model.show("default")
        engine.resetPhysics()

        const prog = model.getAnimationProgress()
        setProgress(prog)

        model.playAnimation()
        setIsPlaying(true)
        setIsPaused(false)
      }
    } catch (error) {
      console.error("Error loading FBX:", error)
      setEngineError(error instanceof Error ? error.message : "Conversion error")
    } finally {
      setConverting(false)
    }
  }, [])

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

  // Format time as M:SS or MM:SS (with leading zero)
  const formatTime = useCallback((seconds: number): string => {
    const mins = Math.floor(seconds / 60)
    const secs = Math.floor(seconds % 60)
    return `${mins}:${secs.toString().padStart(2, "0")}`
  }, [])

  // Format remaining time (negative time shows as "-0:23")
  const formatRemainingTime = useCallback((current: number, duration: number): string => {
    const remaining = duration - current
    if (remaining <= 0) return "0:00"
    const mins = Math.floor(remaining / 60)
    const secs = Math.floor(remaining % 60)
    return `-${mins}:${secs.toString().padStart(2, "0")}`
  }, [])

  // Update progress using requestAnimationFrame for smooth updates
  useEffect(() => {
    let rafId: number | null = null

    const updateProgress = () => {
      if (modelRef.current && isPlaying && !isPaused) {
        const prog = modelRef.current?.getAnimationProgress()
        setProgress(prog || { current: 0, duration: 0, percentage: 0 })

        // Auto-pause when animation ends
        if (prog?.percentage >= 100) {
          setIsPlaying(false)
          setIsPaused(false)
        } else {
          rafId = requestAnimationFrame(updateProgress)
        }
      }
    }

    if (isPlaying && !isPaused) {
      rafId = requestAnimationFrame(updateProgress)
    }

    return () => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId)
      }
    }
  }, [isPlaying, isPaused])

  // Play animation
  const handlePlay = useCallback(async () => {
    if (engineRef.current) {
      // If animation has ended (at 100%), restart from beginning
      if (progress.percentage >= 100) {
        modelRef.current?.seekAnimation(0)
        engineRef.current.resetPhysics()
        setProgress({ ...progress, current: 0, percentage: 0 })
        await new Promise((resolve) => requestAnimationFrame(resolve))
      }
      modelRef.current?.playAnimation()
      setIsPlaying(true)
      setIsPaused(false)
    }
  }, [progress])

  // Pause animation
  const handlePause = useCallback(() => {
    if (modelRef.current) {
      modelRef.current.pauseAnimation()
      setIsPaused(true)
    }
  }, [])

  // Resume animation
  const handleResume = useCallback(() => {
    if (modelRef.current) {
      modelRef.current.playAnimation()
      setIsPaused(false)
    }
  }, [])

  // Seek to position
  const handleSeek = useCallback(
    (value: number[]) => {
      if (engineRef.current && progress.duration > 0) {
        const seekTime = (value[0] / 100) * progress.duration
        modelRef.current?.seekAnimation(seekTime)
        engineRef.current.resetPhysics()
        setProgress({ ...progress, current: seekTime, percentage: value[0] })
      }
    },
    [progress]
  )

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

  useEffect(() => {
    void (async () => {
      if (engineRef.current && progress.percentage >= 100 && progress.duration > 1 / 30) {
        handlePlay()
      }
    })()
  }, [progress, handlePlay])

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
              FBX to VMD
            </h1>
          </Link>
        </div>

        <div className="flex items-center gap-3">
          {/* Upload Button */}
          <input
            ref={fileInputRef}
            type="file"
            accept=".fbx,.json,application/json"
            onChange={handleFileChange}
            className="hidden"
          />
          <Button
            onClick={handleUploadClick}
            disabled={loading || converting}
            size="sm"
          >
            {converting ? "Converting..." : "Upload FBX"}
          </Button>

          {/* Download Button */}
          {vmdBlob && vmdFileName && (
            <Button
              size="sm"
              className="bg-black hover:bg-black/80 text-white"
              onClick={() => {
                downloadBlob(vmdBlob, vmdFileName)
              }}
              disabled={loading || converting || !vmdBlob || !vmdFileName}
            >
              Download VMD
            </Button>
          )}

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

      {/* Player Controls */}
      {!loading && !engineError && vmdBlob && (
        <div className="absolute bottom-4 left-4 right-4 z-50">
          <div className="max-w-4xl mx-auto px-2 pr-4 bg-black/30 backdrop-blur-xs rounded-full outline-none">
            {/* Single Row: Play/Pause - Time - Slider - Remaining Time */}
            <div className="flex items-center gap-3">
              {/* Play/Pause Button (Left) */}
              {!isPlaying ? (
                <Button onClick={handlePlay} size="icon" variant="ghost" aria-label="Play">
                  <Play />
                </Button>
              ) : isPaused ? (
                <Button onClick={handleResume} size="icon" variant="ghost" aria-label="Resume">
                  <Play />
                </Button>
              ) : (
                <Button onClick={handlePause} size="icon" variant="ghost" aria-label="Pause">
                  <Pause />
                </Button>
              )}

              {/* Start Time */}
              <div className="text-white text-sm font-mono tabular-nums">{formatTime(progress.current)}</div>

              {/* Progress Slider */}
              <div className="flex-1">
                <Slider
                  value={[progress.percentage]}
                  onValueChange={handleSeek}
                  min={0}
                  max={100}
                  step={0.001}
                  className="w-full"
                  disabled={progress.duration === 0}
                />
              </div>

              {/* Remaining Time (Right) */}
              <div className="text-muted-foreground text-sm font-mono tabular-nums text-right">
                {formatRemainingTime(progress.current, progress.duration)}
              </div>
            </div>
          </div>
        </div>
      )}

      {!vmdBlob && (
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
