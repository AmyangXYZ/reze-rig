"use client"

import { Engine, Model, Vec3 } from "reze-engine"
import { useCallback, useEffect, useRef, useState } from "react"
import {
  ArcRotateCamera,
  Color3,
  Engine as BabylonEngine,
  HemisphericLight,
  Mesh,
  MeshBuilder,
  LinesMesh,
  PointerEventTypes,
  Scene,
  StandardMaterial,
  Vector3,
} from "@babylonjs/core"
import Loading from "@/components/loading"
import { loadHkxJson, type HkxAnimation } from "@/lib/hkx-loader"
import {
  computeHkxMmdFrameWithCtx,
  createRetargetContext,
  ER_BONE_MAP,
  retargetHkxClipWithCtx,
  type HkxRetargetContext,
  type MmdSkeletonDump,
} from "@/lib/hkx-retarget"
import { computeWorldPositions, HKX_IMPORTANT_BONES, loadAnimJson, type AnimData } from "@/lib/hkx-view"
import { convertToVMD, downloadBlob } from "@/lib/vmd-writer"
import { Button } from "@/components/ui/button"
import { Slider } from "@/components/ui/slider"
import { Play, Pause, Download } from "lucide-react"
import Link from "next/link"

type HkxManifest = {
  skeleton: string
  animations: string[]
}

type SourceSceneBundle = {
  engine: BabylonEngine
  scene: Scene
  camera: ArcRotateCamera
}

const MMD_MAPPABLE_BONES = new Set(Object.keys(ER_BONE_MAP))

export default function EldenRingPage() {
  const sourceContainerRef = useRef<HTMLDivElement>(null)
  const sourceCanvasRef = useRef<HTMLCanvasElement>(null)
  const mmdCanvasRef = useRef<HTMLCanvasElement>(null)

  const sceneRef = useRef<SourceSceneBundle | null>(null)
  const sceneMeshRefs = useRef<Array<{ dispose: () => void }>>([])
  const skeletonMeshRefs = useRef<Array<{ dispose: () => void }>>([])
  const jointSpheresRef = useRef<Array<Mesh | null>>([])
  const boneLinesRef = useRef<LinesMesh | null>(null)
  const boneArrowRefs = useRef<LinesMesh[]>([])
  const boneLineMatRef = useRef<StandardMaterial | null>(null)
  const animDataRef = useRef<AnimData | null>(null)

  const engineRef = useRef<Engine | null>(null)
  const modelRef = useRef<Model | null>(null)
  const hkxRef = useRef<HkxAnimation | null>(null)
  const retargetCtxRef = useRef<HkxRetargetContext | null>(null)
  const mmdSkeletonRef = useRef<MmdSkeletonDump | null>(null)

  const playRafRef = useRef<number | null>(null)
  const playStartRef = useRef(0)
  const frameAtPlayStart = useRef(0)
  const currentFrameRef = useRef(0)

  const [loading, setLoading] = useState(true)
  const [loadingAnim, setLoadingAnim] = useState(false)
  const [engineError, setEngineError] = useState<string | null>(null)
  const [sourceError, setSourceError] = useState<string | null>(null)
  const [currentFrame, setCurrentFrame] = useState(0)
  const [totalFrames, setTotalFrames] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [animIds, setAnimIds] = useState<string[]>([])
  const [animId, setAnimId] = useState("")
  const [animInfo, setAnimInfo] = useState("")
  const [clipReady, setClipReady] = useState(false)
  const [hoveredBone, setHoveredBone] = useState<string | null>(null)
  const [clipDuration, setClipDuration] = useState(0)

  const findContainer = useCallback((json: Record<string, unknown>) => {
    const variants = (json as { namedVariants?: { variant?: Record<string, unknown> }[] }).namedVariants ?? []
    for (const entry of variants) {
      const variant = entry?.variant
      if (!variant) continue
      if (Array.isArray(variant.skeletons) || Array.isArray(variant.animations) || Array.isArray(variant.bindings)) {
        return variant
      }
    }
    return null
  }, [])

  const applySourceSkeleton = useCallback((anim: AnimData, frameIdx: number) => {
    const spheres = jointSpheresRef.current
    const scene = sceneRef.current?.scene
    if (!scene) return
    const worldPos = computeWorldPositions(anim, frameIdx)
    for (let i = 0; i < anim.bones.length && i < spheres.length; i++) {
      const sphere = spheres[i]
      if (!sphere) continue
      sphere.position.copyFromFloats(worldPos[i].x, worldPos[i].y, worldPos[i].z)
    }
    const lines: Vector3[][] = []
    for (let i = 0; i < anim.bones.length; i++) {
      if (!MMD_MAPPABLE_BONES.has(anim.bones[i].name)) continue
      const pi = anim.bones[i].parentIndex
      if (pi < 0) continue
      if (!MMD_MAPPABLE_BONES.has(anim.bones[pi].name)) continue
      lines.push([
        new Vector3(worldPos[pi].x, worldPos[pi].y, worldPos[pi].z),
        new Vector3(worldPos[i].x, worldPos[i].y, worldPos[i].z),
      ])
    }
    if (boneLinesRef.current) {
      boneLinesRef.current.dispose()
      boneLinesRef.current = null
    }
    for (const arrow of boneArrowRefs.current) arrow.dispose()
    boneArrowRefs.current = []
    if (lines.length === 0) return
    const boneLine = MeshBuilder.CreateLineSystem("er-bones-lines", { lines, updatable: false }, scene)
    boneLine.material = boneLineMatRef.current
    boneLine.color = Color3.FromHexString("#4488ff")
    boneLinesRef.current = boneLine
    skeletonMeshRefs.current.push(boneLine)
    const arrowLines: Vector3[][] = []
    const arrowLen = 0.075
    const arrowWidth = 0.018
    const up = new Vector3(0, 1, 0)
    for (const seg of lines) {
      const a = seg[0]
      const b = seg[1]
      const dir = b.subtract(a)
      const dLen = dir.length()
      if (dLen < 1e-6) continue
      const d = dir.scale(1 / dLen)
      let side = Vector3.Cross(d, up)
      if (side.lengthSquared() < 1e-6) {
        side = Vector3.Cross(d, new Vector3(1, 0, 0))
      }
      side = side.normalize()
      const back = d.scale(-arrowLen)
      const left = b.add(back).add(side.scale(arrowWidth))
      const right = b.add(back).add(side.scale(-arrowWidth))
      arrowLines.push([left, b], [right, b])
    }
    if (arrowLines.length > 0) {
      const arrows = MeshBuilder.CreateLineSystem("er-bone-arrows", { lines: arrowLines, updatable: false }, scene)
      arrows.material = boneLineMatRef.current
      arrows.color = Color3.FromHexString("#ffd84d")
      boneArrowRefs.current.push(arrows)
      skeletonMeshRefs.current.push(arrows)
    }
  }, [])

  const applyFrame = useCallback(
    (frameIdx: number) => {
      const model = modelRef.current
      const hkx = hkxRef.current
      const anim = animDataRef.current
      if (!hkx || !anim || frameIdx < 0 || frameIdx >= hkx.numFrames) return

      currentFrameRef.current = frameIdx
      setCurrentFrame(frameIdx)

      applySourceSkeleton(anim, frameIdx)

      const ctx = retargetCtxRef.current
      if (!model || !ctx) return

      const { rotations, positions } = computeHkxMmdFrameWithCtx(ctx, frameIdx)
      model.rotateBones(rotations, 1000 / 30)
      if (Object.keys(positions).length > 0) {
        model.moveBones(positions)
      }
    },
    [applySourceSkeleton],
  )

  const stopPlayback = useCallback(() => {
    if (playRafRef.current !== null) {
      cancelAnimationFrame(playRafRef.current)
      playRafRef.current = null
    }
    setIsPlaying(false)
  }, [])

  const startPlayback = useCallback(() => {
    const hkx = hkxRef.current
    if (!hkx) return
    setIsPlaying(true)
    playStartRef.current = performance.now()
    frameAtPlayStart.current = currentFrameRef.current

    const tick = () => {
      const h = hkxRef.current
      if (!h) return
      const elapsed = (performance.now() - playStartRef.current) / 1000
      const frameDelta = Math.floor(elapsed * h.fps)
      let frame = frameAtPlayStart.current + frameDelta
      if (frame >= h.numFrames) {
        frame = frame % h.numFrames
        playStartRef.current = performance.now()
        frameAtPlayStart.current = 0
      }
      applyFrame(frame)
      playRafRef.current = requestAnimationFrame(tick)
    }
    playRafRef.current = requestAnimationFrame(tick)
  }, [applyFrame])

  const buildSkeleton = useCallback((anim: AnimData, scene: Scene) => {
    for (const m of skeletonMeshRefs.current) m.dispose()
    skeletonMeshRefs.current = []

    const spheres: Array<Mesh | null> = new Array(anim.bones.length).fill(null)
    const matMappable = new StandardMaterial("mat-mappable", scene)
    matMappable.disableLighting = true
    matMappable.diffuseColor = Color3.White()
    matMappable.emissiveColor = Color3.White()
    const matImportant = new StandardMaterial("mat-important", scene)
    matImportant.disableLighting = true
    matImportant.diffuseColor = Color3.FromHexString("#66ddff")
    matImportant.emissiveColor = Color3.FromHexString("#66ddff")
    const matRoot = new StandardMaterial("mat-root", scene)
    matRoot.disableLighting = true
    matRoot.diffuseColor = Color3.FromHexString("#ff0044")
    matRoot.emissiveColor = Color3.FromHexString("#ff0044")
    skeletonMeshRefs.current.push(matMappable, matImportant, matRoot)

    for (let i = 0; i < anim.bones.length; i++) {
      const name = anim.bones[i].name
      if (!MMD_MAPPABLE_BONES.has(name)) continue
      const isImportant = HKX_IMPORTANT_BONES.has(name)
      const isRoot = name === "Master" || name === "RootPos"
      const sphere = MeshBuilder.CreateSphere(`er-joint-${i}`, { diameter: 0.028, segments: 8 }, scene)
      sphere.material = isRoot ? matRoot : isImportant ? matImportant : matMappable
      sphere.metadata = { boneName: name, boneIdx: i }
      spheres[i] = sphere
      skeletonMeshRefs.current.push(sphere)
    }
    jointSpheresRef.current = spheres

    const boneLine = MeshBuilder.CreateLineSystem(
      "er-bones-lines",
      { lines: [[new Vector3(0, 0, 0), new Vector3(0, 0, 0)]], updatable: true },
      scene,
    )
    const lineMat = new StandardMaterial("mat-lines", scene)
    lineMat.disableLighting = true
    lineMat.emissiveColor = Color3.FromHexString("#4488ff")
    boneLineMatRef.current = lineMat
    boneLine.material = lineMat
    boneLine.color = Color3.FromHexString("#4488ff")
    boneLinesRef.current = boneLine
    skeletonMeshRefs.current.push(boneLine, lineMat)
  }, [])

  const loadAnimation = useCallback(
    async (id: string) => {
      stopPlayback()
      modelRef.current?.resetAllBones()
      setLoadingAnim(true)
      setAnimInfo(`Loading ${id}…`)

      try {
        const [animResp, skeletonResp] = await Promise.all([fetch(`/hkx/${id}.json`), fetch("/hkx/skeleton.json")])
        if (!animResp.ok) throw new Error(`Failed to load /hkx/${id}.json (${animResp.status})`)
        if (!skeletonResp.ok) throw new Error(`Failed to load /hkx/skeleton.json (${skeletonResp.status})`)
        const animJson = await animResp.json()
        const skeletonJson = await skeletonResp.json()

        const mergedJson = (() => {
          const animContainer = findContainer(animJson)
          const skeletonContainer = findContainer(skeletonJson)
          if (!animContainer || !skeletonContainer) return animJson
          if ((animContainer.skeletons as unknown[] | undefined)?.length) return animJson
          const animVariants = (animJson as { namedVariants?: { variant?: Record<string, unknown> }[] }).namedVariants ?? []
          const targetIndex = animVariants.findIndex((entry) => entry?.variant === animContainer)
          if (targetIndex < 0) return animJson
          return {
            ...(animJson as Record<string, unknown>),
            namedVariants: [
              ...animVariants.slice(0, targetIndex),
              {
                ...(animVariants[targetIndex] as Record<string, unknown>),
                variant: {
                  ...animContainer,
                  skeletons: skeletonContainer.skeletons,
                },
              },
              ...animVariants.slice(targetIndex + 1),
            ],
          }
        })()

        const hkx = loadHkxJson(mergedJson)
        const anim = loadAnimJson(mergedJson)

        hkxRef.current = hkx
        animDataRef.current = anim
        const retargetCtx = createRetargetContext(hkx, { mmdSkeleton: mmdSkeletonRef.current ?? undefined })
        retargetCtxRef.current = retargetCtx

        const scene = sceneRef.current?.scene
        if (scene) buildSkeleton(anim, scene)

        const clip = retargetHkxClipWithCtx(retargetCtx)
        setClipReady(clip.boneTracks.length > 0 || (clip.positionTracks?.length ?? 0) > 0)
        setClipDuration(hkx.duration)
        setTotalFrames(hkx.numFrames)
        setCurrentFrame(0)
        setAnimInfo(`${hkx.duration.toFixed(1)}s · ${hkx.numFrames}f @ ${hkx.fps}fps`)
        applyFrame(0)
      } catch (err) {
        console.error(err)
        retargetCtxRef.current = null
        setClipReady(false)
        setAnimInfo(`Error loading ${id}`)
      } finally {
        setLoadingAnim(false)
      }
    },
    [stopPlayback, buildSkeleton, applyFrame, findContainer],
  )

  const handleExportVmd = useCallback(() => {
    const ctx = retargetCtxRef.current
    if (!ctx) return
    const clip = retargetHkxClipWithCtx(ctx)
    const hasData = clip.boneTracks.length > 0 || (clip.positionTracks?.length ?? 0) > 0
    if (!hasData) return
    downloadBlob(convertToVMD(clip, 30), `${animId}_er_mmd.vmd`)
  }, [animId])

  const initSourceScene = useCallback(() => {
    const container = sourceContainerRef.current
    const canvas = sourceCanvasRef.current
    if (!container || !canvas) return () => { }

    try {
      const engine = new BabylonEngine(canvas, true, { preserveDrawingBuffer: true, stencil: true })
      engine.setHardwareScalingLevel(1 / Math.min(window.devicePixelRatio, 2))
      const scene = new Scene(engine)
      scene.clearColor = Color3.FromHexString("#1c1c1e").toColor4(1)

      const camera = new ArcRotateCamera("cam", -Math.PI / 2, Math.PI / 3, 6, new Vector3(0, 0.8, 0), scene)
      camera.attachControl(canvas, true)
      camera.lowerRadiusLimit = 0.08
      camera.upperRadiusLimit = 30
      camera.wheelDeltaPercentage = 0.006

      const light = new HemisphericLight("hemi", new Vector3(0, 1, 0), scene)
      light.intensity = 1.0
      const gridSize = 4
      const divisions = 20
      const half = gridSize / 2
      const step = gridSize / divisions
      const minorLines: Vector3[][] = []
      for (let i = 0; i <= divisions; i++) {
        const p = -half + i * step
        if (Math.abs(p) < 1e-8) continue
        minorLines.push([new Vector3(-half, 0, p), new Vector3(half, 0, p)])
        minorLines.push([new Vector3(p, 0, -half), new Vector3(p, 0, half)])
      }
      const minorGrid = MeshBuilder.CreateLineSystem("grid-minor", { lines: minorLines }, scene)
      const minorMat = new StandardMaterial("grid-minor-mat", scene)
      minorMat.disableLighting = true
      minorMat.emissiveColor = Color3.FromHexString("#2a2a30")
      minorGrid.material = minorMat
      minorGrid.color = Color3.FromHexString("#2a2a30")

      const centerGrid = MeshBuilder.CreateLineSystem(
        "grid-center",
        { lines: [[new Vector3(-half, 0, 0), new Vector3(half, 0, 0)], [new Vector3(0, 0, -half), new Vector3(0, 0, half)]] },
        scene,
      )
      const centerMat = new StandardMaterial("grid-center-mat", scene)
      centerMat.disableLighting = true
      centerMat.emissiveColor = Color3.FromHexString("#3d3d46")
      centerGrid.material = centerMat
      centerGrid.color = Color3.FromHexString("#3d3d46")
      sceneMeshRefs.current.push(minorGrid, minorMat, centerGrid, centerMat)

      const pointerObserver = scene.onPointerObservable.add((pointerInfo) => {
        if (pointerInfo.type !== PointerEventTypes.POINTERMOVE) return
        const pick = scene.pick(scene.pointerX, scene.pointerY)
        const boneName = pick?.pickedMesh?.metadata?.boneName
        setHoveredBone(typeof boneName === "string" ? boneName : null)
      })

      const resize = () => {
        const w = container.clientWidth
        const h = container.clientHeight
        if (w < 1 || h < 1) return
        engine.resize()
      }

      const ro = new ResizeObserver(() => resize())
      ro.observe(container)
      resize()

      engine.runRenderLoop(() => {
        scene.render()
      })

      sceneRef.current = { engine, scene, camera }

      return () => {
        ro.disconnect()
        if (pointerObserver) scene.onPointerObservable.remove(pointerObserver)
        for (const m of sceneMeshRefs.current) m.dispose()
        sceneMeshRefs.current = []
        for (const m of skeletonMeshRefs.current) m.dispose()
        skeletonMeshRefs.current = []
        engine.dispose()
        sceneRef.current = null
      }
    } catch (e) {
      setSourceError(e instanceof Error ? e.message : String(e))
      return () => { }
    }
  }, [])

  const initEngine = useCallback(async () => {
    const canvas = mmdCanvasRef.current
    if (!canvas) return
    try {
      const engine = new Engine(canvas, {
        world: { color: new Vec3(1, 1, 1), strength: 0.35 },
        sun: { color: new Vec3(1, 1, 1), strength: 2.0, direction: new Vec3(0.395, -0.358, 0.846) },
        background: new Vec3(0.11, 0.11, 0.118),
        camera: { distance: 35, target: new Vec3(0, 9, 0) },
      })
      engineRef.current = engine
      await engine.init()
      const model = await engine.loadModel("/models/reze/reze.pmx")
      modelRef.current = model
      // This page drives the skeleton directly (rotateBones/moveBones per frame),
      // so the engine must not also run IK or physics against it.
      engine.setIKEnabled(false)
      engine.setPhysicsEnabled(false)
      engine.runRenderLoop()
      model.setMorphWeight("抗穿模", 0.5)
    } catch (error) {
      setEngineError(error instanceof Error ? error.message : "Unknown error")
    }
  }, [])

  const bootstrapPage = useCallback(async () => {
    await initEngine()
    const [manifestResp, mmdSkelResp] = await Promise.all([
      fetch("/hkx/manifest.json"),
      fetch("/mmd-skeleton.json"),
    ])
    if (!manifestResp.ok) throw new Error(`Failed to load /hkx/manifest.json (${manifestResp.status})`)
    if (mmdSkelResp.ok) {
      mmdSkeletonRef.current = (await mmdSkelResp.json()) as MmdSkeletonDump
    }
    const manifest = (await manifestResp.json()) as HkxManifest
    const ids = manifest.animations ?? []
    setAnimIds(ids)
    if (ids.length > 0) {
      const defaultId = ids.includes("a000_002100") ? "a000_002100" : ids[0]
      setAnimId(defaultId)
      await loadAnimation(defaultId)
    }
    setLoading(false)
  }, [initEngine, loadAnimation])

  useEffect(() => {
    const sourceCleanup = initSourceScene()
    void bootstrapPage()
    return () => {
      stopPlayback()
      sourceCleanup?.()
      engineRef.current?.dispose()
    }
  }, [initSourceScene, bootstrapPage, stopPlayback])

  const handleSliderChange = useCallback(
    (value: number[]) => {
      const frame = Math.round(value[0])
      if (isPlaying) {
        playStartRef.current = performance.now()
        frameAtPlayStart.current = frame
      }
      applyFrame(frame)
    },
    [applyFrame, isPlaying],
  )

  const handleAnimChange = useCallback(
    async (id: string) => {
      setAnimId(id)
      await loadAnimation(id)
      startPlayback()
    },
    [loadAnimation, startPlayback],
  )

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== "Space") return
      const target = event.target as HTMLElement | null
      const tag = target?.tagName
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable) {
        return
      }
      event.preventDefault()
      if (isPlaying) {
        stopPlayback()
      } else {
        startPlayback()
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [isPlaying, startPlayback, stopPlayback])

  const panelError = engineError || sourceError

  const fmtTime = (t: number) => {
    const m = Math.floor(Math.abs(t) / 60)
    const s = Math.floor(Math.abs(t) % 60)
    return `${t < 0 ? "-" : ""}${m}:${s.toString().padStart(2, "0")}`
  }
  const curTime = clipDuration > 0 ? (currentFrame / Math.max(totalFrames - 1, 1)) * clipDuration : 0
  const remTime = clipDuration - curTime

  return (
    <div className="fixed inset-0 flex w-full h-full flex-col overflow-hidden touch-none bg-[#1c1c1e]">
      <header className="z-40 flex h-12 shrink-0 select-none items-center justify-between gap-4 border-b border-white/10 px-4">
        <div className="flex min-w-0 items-center gap-4">
          <Link href="/">
            <h1
              className="cursor-pointer text-lg font-light uppercase tracking-[0.25em] text-white"
              style={{ textShadow: "0 0 20px rgba(255,255,255,0.3), 0 2px 10px rgba(0,0,0,0.5)" }}
            >
              Elden Ring → VMD
            </h1>
          </Link>
          <span className="hidden font-mono text-xs text-white/40 sm:inline">{animInfo}</span>
          {hoveredBone && (
            <span className="truncate rounded bg-white/10 px-2 py-0.5 font-mono text-xs text-cyan-300">
              {hoveredBone}
            </span>
          )}
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={handleExportVmd}
          disabled={loading || loadingAnim || !clipReady}
          className="h-8 gap-1.5"
        >
          <Download className="h-4 w-4" />
          Download VMD
        </Button>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-32 shrink-0 flex-col border-r border-white/10">
          <div className="px-3 py-2 text-[10px] uppercase tracking-wider text-white/40">
            Animations · {animIds.length}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
            {animIds.map((id) => (
              <button
                key={id}
                onClick={() => handleAnimChange(id)}
                disabled={loading || loadingAnim}
                className={`mb-0.5 block w-full rounded px-2 py-1 text-left font-mono text-xs transition-colors ${
                  animId === id
                    ? "bg-white text-black"
                    : "text-white/60 hover:bg-white/10 hover:text-white"
                } disabled:opacity-50`}
              >
                {id.replace("a000_", "")}
              </button>
            ))}
          </div>
        </aside>

        <div className="relative min-h-0 min-w-0 flex-1">
          <div className="flex h-full min-h-0 w-full">
            <div ref={sourceContainerRef} className="relative min-h-0 w-1/2 min-w-0 border-r border-white/10">
              <span className="pointer-events-none absolute left-3 top-2 z-10 text-[10px] uppercase tracking-wider text-white/40">
                Elden Ring · HKX
              </span>
              <canvas ref={sourceCanvasRef} className="block h-full w-full touch-none" />
            </div>
            <div className="relative min-h-0 w-1/2 min-w-0">
              <span className="pointer-events-none absolute left-3 top-2 z-10 text-[10px] uppercase tracking-wider text-white/40">
                MMD Retarget
              </span>
              <canvas ref={mmdCanvasRef} className="block h-full w-full touch-none" />
            </div>
          </div>

          {panelError && (
            <div className="absolute inset-0 z-[60] flex items-center justify-center bg-black/85 p-6 text-sm text-red-300">
              {panelError}
            </div>
          )}

          {loading && !panelError && <Loading loading={loading} />}

          {!loading && !panelError && totalFrames > 0 && (
            <div className="pointer-events-none absolute bottom-4 left-4 right-4 z-50 flex justify-center">
              <div className="pointer-events-auto mx-auto w-full max-w-4xl px-2 pr-4">
                <div className="rounded-full bg-black/30 px-2 py-1 pr-4 backdrop-blur-xs">
                  <div className="flex items-center gap-3">
                    {!isPlaying ? (
                      <Button onClick={startPlayback} size="icon" variant="ghost" aria-label="Play">
                        <Play />
                      </Button>
                    ) : (
                      <Button onClick={stopPlayback} size="icon" variant="ghost" aria-label="Pause">
                        <Pause />
                      </Button>
                    )}

                    <div className="font-mono text-sm tabular-nums text-white">{fmtTime(curTime)}</div>

                    <div className="min-w-0 flex-1">
                      <Slider
                        value={[currentFrame]}
                        onValueChange={handleSliderChange}
                        min={0}
                        max={Math.max(totalFrames - 1, 1)}
                        step={1}
                        className="w-full"
                      />
                    </div>

                    <div className="text-right font-mono text-sm tabular-nums text-muted-foreground">
                      {fmtTime(-remTime)}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
