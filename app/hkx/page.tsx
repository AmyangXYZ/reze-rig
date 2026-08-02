"use client"

import { Engine, Model, Quat, Vec3 } from "reze-engine"
import { useCallback, useEffect, useRef, useState } from "react"
import * as THREE from "three"
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
import { AdvancedDynamicTexture, TextBlock } from "@babylonjs/gui"
import Loading from "@/components/loading"
import { loadHkxJson, type HkxAnimation } from "@/lib/hkx-loader"
import {
  computeHkxMmdFrame,
  computeHkxMmdFrameWithCtx,
  createRetargetContext,
  ER_BONE_MAP,
  logHkxSkeletonDefaultsToConsole,
  retargetHkxClip,
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

type ThreeSceneBundle = {
  engine: BabylonEngine
  scene: Scene
  camera: ArcRotateCamera
}

const MMD_MAPPABLE_BONES = new Set(Object.keys(ER_BONE_MAP))

function rotateVecByQuat(q: Quat, v: Vec3): Vec3 {
  const t = q.clone().multiply(new Quat(v.x, v.y, v.z, 0))
  const r = t.multiply(q.clone().conjugate())
  return new Vec3(r.x, r.y, r.z)
}

function computeMappedOnlyWorldPositions(anim: AnimData, frameIdx: number): Vec3[] {
  const n = anim.bones.length
  const wPos: Vec3[] = new Array(n)
  const wRot: Quat[] = new Array(n)
  const boneToTrack = new Map<number, number>()
  for (let t = 0; t < anim.trackToBone.length; t++) boneToTrack.set(anim.trackToBone[t], t)
  const frame = frameIdx >= 0 ? anim.frames[frameIdx] : null

  for (let i = 0; i < n; i++) {
    const ref = anim.refPose[i]
    const name = anim.bones[i].name
    const track = boneToTrack.get(i)
    const useAnim = frame && track !== undefined && MMD_MAPPABLE_BONES.has(name)
    const lr = useAnim
      ? new Quat(frame[track].rotation[0], frame[track].rotation[1], frame[track].rotation[2], frame[track].rotation[3])
      : new Quat(ref.rotation[0], ref.rotation[1], ref.rotation[2], ref.rotation[3])
    const lt = useAnim
      ? new Vec3(frame[track].translation[0], frame[track].translation[1], frame[track].translation[2])
      : new Vec3(ref.translation[0], ref.translation[1], ref.translation[2])
    const pi = anim.bones[i].parentIndex
    if (pi < 0) {
      wRot[i] = lr
      wPos[i] = lt
    } else {
      wRot[i] = wRot[pi].clone().multiply(lr)
      const rp = rotateVecByQuat(wRot[pi], lt)
      wPos[i] = new Vec3(rp.x + wPos[pi].x, rp.y + wPos[pi].y, rp.z + wPos[pi].z)
    }
  }

  return wPos
}

export default function HkxComparePage() {
  const threeContainerRef = useRef<HTMLDivElement>(null)
  const threeCanvasRef = useRef<HTMLCanvasElement>(null)
  const mmdCanvasRef = useRef<HTMLCanvasElement>(null)

  const sceneRef = useRef<ThreeSceneBundle | null>(null)
  const sceneMeshRefs = useRef<Array<{ dispose: () => void }>>([])
  const skeletonMeshRefs = useRef<Array<{ dispose: () => void }>>([])
  const jointSpheresRef = useRef<Array<Mesh | null>>([])
  const boneLinesRef = useRef<LinesMesh | null>(null)
  const boneArrowRefs = useRef<LinesMesh[]>([])
  const boneLineMatRef = useRef<StandardMaterial | null>(null)
  const boneLabelUiRef = useRef<AdvancedDynamicTexture | null>(null)
  const boneLabelRefs = useRef<TextBlock[]>([])
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
  const [threeError, setThreeError] = useState<string | null>(null)
  const [currentFrame, setCurrentFrame] = useState(0)
  const [totalFrames, setTotalFrames] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [animIds, setAnimIds] = useState<string[]>([])
  const [animId, setAnimId] = useState("")
  const [animInfo, setAnimInfo] = useState("")
  const [clipReady, setClipReady] = useState(false)
  const [hoveredBone, setHoveredBone] = useState<string | null>(null)
  const [showRefPose, setShowRefPose] = useState(false)
  const showRefPoseRef = useRef(false)
  const [showNonMmdBones, setShowNonMmdBones] = useState(false)
  const showNonMmdBonesRef = useRef(false)
  const [showBoneLabels, setShowBoneLabels] = useState(true)
  const showBoneLabelsRef = useRef(true)
  const [mappedFkDebugMode, setMappedFkDebugMode] = useState(false)
  const mappedFkDebugModeRef = useRef(false)
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

  const applyThreeSkeleton = useCallback((anim: AnimData, frameIdx: number) => {
    const spheres = jointSpheresRef.current
    const scene = sceneRef.current?.scene
    if (!scene) return
    const worldPos = mappedFkDebugModeRef.current
      ? computeMappedOnlyWorldPositions(anim, frameIdx)
      : computeWorldPositions(anim, frameIdx)
    for (let i = 0; i < anim.bones.length && i < spheres.length; i++) {
      const sphere = spheres[i]
      if (!sphere) continue
      sphere.position.copyFromFloats(worldPos[i].x, worldPos[i].y, worldPos[i].z)
    }
    const lines: Vector3[][] = []
    for (let i = 0; i < anim.bones.length; i++) {
      const iMappable = MMD_MAPPABLE_BONES.has(anim.bones[i].name)
      if (!showNonMmdBonesRef.current && !iMappable) continue
      const pi = anim.bones[i].parentIndex
      if (pi < 0) continue
      const pMappable = MMD_MAPPABLE_BONES.has(anim.bones[pi].name)
      if (!showNonMmdBonesRef.current && !pMappable) continue
      lines.push([new Vector3(worldPos[pi].x, worldPos[pi].y, worldPos[pi].z), new Vector3(worldPos[i].x, worldPos[i].y, worldPos[i].z)])
    }
    if (boneLinesRef.current) {
      boneLinesRef.current.dispose()
      boneLinesRef.current = null
    }
    for (const arrow of boneArrowRefs.current) arrow.dispose()
    boneArrowRefs.current = []
    if (lines.length === 0) return
    const boneLine = MeshBuilder.CreateLineSystem("hkx-bones-lines", { lines, updatable: false }, scene)
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
      const arrows = MeshBuilder.CreateLineSystem("hkx-bone-arrows", { lines: arrowLines, updatable: false }, scene)
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

      const threeFrame = showRefPoseRef.current ? -1 : frameIdx
      applyThreeSkeleton(anim, threeFrame)

      if (!model) return

      const ctx = retargetCtxRef.current
      const { rotations, positions } = ctx
        ? computeHkxMmdFrameWithCtx(ctx, frameIdx)
        : computeHkxMmdFrame(hkx, frameIdx)
      model.rotateBones(rotations, 1000 / 30)
      if (Object.keys(positions).length > 0) {
        model.moveBones(positions)
      }
    },
    [applyThreeSkeleton],
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
    showRefPoseRef.current = false
    setShowRefPose(false)
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
    const labelUi = boneLabelUiRef.current
    for (const label of boneLabelRefs.current) labelUi?.removeControl(label)
    boneLabelRefs.current = []

    const spheres: Array<Mesh | null> = new Array(anim.bones.length).fill(null)
    const matMappable = new StandardMaterial("mat-mappable", scene)
    matMappable.disableLighting = true
    matMappable.diffuseColor = Color3.White()
    matMappable.emissiveColor = Color3.White()
    const matImportant = new StandardMaterial("mat-important", scene)
    matImportant.disableLighting = true
    matImportant.diffuseColor = Color3.FromHexString("#66ddff")
    matImportant.emissiveColor = Color3.FromHexString("#66ddff")
    const matNormal = new StandardMaterial("mat-normal", scene)
    matNormal.disableLighting = true
    matNormal.diffuseColor = Color3.FromHexString("#88ff00")
    matNormal.emissiveColor = Color3.FromHexString("#88ff00")
    const matRoot = new StandardMaterial("mat-root", scene)
    matRoot.disableLighting = true
    matRoot.diffuseColor = Color3.FromHexString("#ff0044")
    matRoot.emissiveColor = Color3.FromHexString("#ff0044")
    skeletonMeshRefs.current.push(matMappable, matImportant, matNormal, matRoot)

    for (let i = 0; i < anim.bones.length; i++) {
      const name = anim.bones[i].name
      if (name === "L_Foot_Target2" || name === "R_Foot_Target2") continue
      const isMappable = MMD_MAPPABLE_BONES.has(name)
      if (!showNonMmdBonesRef.current && !isMappable) continue
      const isImportant = HKX_IMPORTANT_BONES.has(name)
      const isRoot = name === "Master" || name === "RootPos"
      const diameter = isMappable || isImportant || isRoot ? 0.028 : 0.018
      const sphere = MeshBuilder.CreateSphere(`hkx-joint-${i}`, { diameter, segments: 8 }, scene)
      sphere.material = isRoot ? matRoot : isMappable ? matMappable : isImportant ? matImportant : matNormal
      sphere.metadata = { boneName: name, boneIdx: i }
      spheres[i] = sphere
      skeletonMeshRefs.current.push(sphere)
      if (showBoneLabelsRef.current && labelUi) {
        const label = new TextBlock(`hkx-label-${i}`, name)
        label.color = isRoot ? "#ff5577" : isMappable ? "#ffffff" : "#88ff00"
        label.fontSize = 16
        label.outlineWidth = 2
        label.outlineColor = "black"
        label.resizeToFit = true
        label.textHorizontalAlignment = TextBlock.HORIZONTAL_ALIGNMENT_CENTER
        label.textVerticalAlignment = TextBlock.VERTICAL_ALIGNMENT_CENTER
        label.isHitTestVisible = false
        labelUi.addControl(label)
        label.linkWithMesh(sphere)
        label.linkOffsetY = -24
        boneLabelRefs.current.push(label)
      }
    }
    jointSpheresRef.current = spheres

    const boneLine = MeshBuilder.CreateLineSystem(
      "hkx-bones-lines",
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

  const rebuildThreeSkeleton = useCallback(() => {
    const anim = animDataRef.current
    const scene = sceneRef.current?.scene
    if (!anim || !scene) return
    buildSkeleton(anim, scene)
    applyThreeSkeleton(anim, showRefPoseRef.current ? -1 : currentFrameRef.current)
  }, [buildSkeleton, applyThreeSkeleton])

  const loadAnimation = useCallback(
    async (id: string) => {
      stopPlayback()
      modelRef.current?.resetAllBones()
      setLoadingAnim(true)
      setAnimInfo(`Loading ${id}...`)
      showRefPoseRef.current = false
      setShowRefPose(false)

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

        // One-shot: uncomment to dump the ER skeleton JSON to the console.
        // if (!loggedHkxExportRef.current) {
        //   loggedHkxExportRef.current = true
        //   logHkxSkeletonDefaultsToConsole(hkx)
        // }

        const scene = sceneRef.current?.scene
        if (scene) buildSkeleton(anim, scene)

        const clip = retargetHkxClipWithCtx(retargetCtx)
        setClipReady(clip.boneTracks.length > 0 || (clip.positionTracks?.length ?? 0) > 0)
        setClipDuration(hkx.duration)
        setTotalFrames(hkx.numFrames)
        setCurrentFrame(0)
        setAnimInfo(
          `${id} · ${hkx.duration.toFixed(1)}s · ${hkx.numFrames}f@${hkx.fps} · ${clip.boneTracks.length} rot · ${clip.positionTracks?.length ?? 0} pos`,
        )
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
    const hkx = hkxRef.current
    if (!hkx) return
    const ctx = retargetCtxRef.current
    const clip = ctx ? retargetHkxClipWithCtx(ctx) : retargetHkxClip(hkx)
    const hasData = clip.boneTracks.length > 0 || (clip.positionTracks?.length ?? 0) > 0
    if (!hasData) return
    downloadBlob(convertToVMD(clip, 30), `${animId}_er_mmd.vmd`)
  }, [animId])

  const initThree = useCallback(() => {
    const container = threeContainerRef.current
    const canvas = threeCanvasRef.current
    if (!container || !canvas) return () => { }

    try {
      const engine = new BabylonEngine(canvas, true, { preserveDrawingBuffer: true, stencil: true })
      engine.setHardwareScalingLevel(1 / Math.min(window.devicePixelRatio, 2))
      const scene = new Scene(engine)
      scene.clearColor = Color3.FromHexString("#111122").toColor4(1)
      const labelUi = AdvancedDynamicTexture.CreateFullscreenUI("hkx-bone-label-ui", true, scene)
      boneLabelUiRef.current = labelUi

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
      minorMat.emissiveColor = Color3.FromHexString("#222233")
      minorGrid.material = minorMat
      minorGrid.color = Color3.FromHexString("#222233")

      const centerGrid = MeshBuilder.CreateLineSystem(
        "grid-center",
        { lines: [[new Vector3(-half, 0, 0), new Vector3(half, 0, 0)], [new Vector3(0, 0, -half), new Vector3(0, 0, half)]] },
        scene,
      )
      const centerMat = new StandardMaterial("grid-center-mat", scene)
      centerMat.disableLighting = true
      centerMat.emissiveColor = Color3.FromHexString("#334455")
      centerGrid.material = centerMat
      centerGrid.color = Color3.FromHexString("#334455")
      sceneMeshRefs.current.push(minorGrid, minorMat, centerGrid, centerMat, labelUi)

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
        boneLabelRefs.current = []
        boneLabelUiRef.current = null
        engine.dispose()
        sceneRef.current = null
      }
    } catch (e) {
      setThreeError(e instanceof Error ? e.message : String(e))
      return () => { }
    }
  }, [])

  const initEngine = useCallback(async () => {
    const canvas = mmdCanvasRef.current
    if (!canvas) return
    try {
      const engine = new Engine(canvas, {
        world: { color: new Vec3(0.9, 0.9, 0.9) },
        camera: { distance: 35, target: new Vec3(0, 9, 0) },
      })
      engineRef.current = engine
      await engine.init()
      const model = await engine.loadModel("/models/reze/reze.pmx")
      modelRef.current = model
      // engine.addGround({
      // 	width: 200,
      // 	height: 200,
      // 	fadeEnd: 100,
      // 	fadeStart: 50,
      // 	diffuseColor: new Vec3(0.0, 0.0, 0.05),
      // })
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
    const threeCleanup = initThree()
    void bootstrapPage()
    return () => {
      stopPlayback()
      threeCleanup?.()
      engineRef.current?.dispose()
    }
  }, [initThree, bootstrapPage, stopPlayback])

  const handleSliderChange = useCallback(
    (value: number[]) => {
      const frame = Math.round(value[0])
      showRefPoseRef.current = false
      setShowRefPose(false)
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

  const toggleRefPose = useCallback(() => {
    setShowRefPose((prev) => {
      const next = !prev
      showRefPoseRef.current = next
      if (next) stopPlayback()
      queueMicrotask(() => {
        const anim = animDataRef.current
        const model = modelRef.current
        const ctx = retargetCtxRef.current
        if (!anim) return
        applyThreeSkeleton(anim, next ? -1 : currentFrameRef.current)
        if (!model) return
        if (next && ctx) {
          const { rotations, positions } = computeHkxMmdFrameWithCtx(ctx, 0)
          model.resetAllBones()
          model.rotateBones(rotations, 1000 / 30)
          if (Object.keys(positions).length > 0) model.moveBones(positions)
          return
        }
        applyFrame(currentFrameRef.current)
      })
      return next
    })
  }, [stopPlayback, applyThreeSkeleton, applyFrame])

  useEffect(() => {
    showRefPoseRef.current = showRefPose
  }, [showRefPose])

  useEffect(() => {
    showNonMmdBonesRef.current = showNonMmdBones
    rebuildThreeSkeleton()
  }, [showNonMmdBones, rebuildThreeSkeleton])

  useEffect(() => {
    showBoneLabelsRef.current = showBoneLabels
    rebuildThreeSkeleton()
  }, [showBoneLabels, rebuildThreeSkeleton])

  useEffect(() => {
    mappedFkDebugModeRef.current = mappedFkDebugMode
    rebuildThreeSkeleton()
  }, [mappedFkDebugMode, rebuildThreeSkeleton])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== "Space") return
      const target = event.target as HTMLElement | null
      const tag = target?.tagName
      if (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        target?.isContentEditable
      ) {
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

  const panelError = engineError || threeError

  const fmtTime = (t: number) => {
    const m = Math.floor(Math.abs(t) / 60)
    const s = Math.floor(Math.abs(t) % 60)
    return `${t < 0 ? "-" : ""}${m}:${s.toString().padStart(2, "0")}`
  }
  const curTime = clipDuration > 0 ? (currentFrame / Math.max(totalFrames - 1, 1)) * clipDuration : 0
  const remTime = clipDuration - curTime

  return (
    <div className="fixed inset-0 flex w-full h-full flex-col overflow-hidden touch-none bg-black">
      <header className="z-40 flex shrink-0 select-none items-center justify-between gap-3 border-b border-white/10 bg-black/90 px-4 py-2">
        <div className="flex min-w-0 items-center gap-4">
          <Link href="/">
            <h1
              className="text-2xl font-light tracking-[0.2em] text-white uppercase cursor-pointer"
              style={{ textShadow: "0 0 20px rgba(255,255,255,0.3), 0 2px 10px rgba(0,0,0,0.5)" }}
            >
              HKX · FK / MMD
            </h1>
          </Link>
          {hoveredBone && (
            <span className="text-cyan-300 text-sm font-mono bg-black/50 px-2 py-0.5 rounded truncate max-w-[min(30vw,200px)]">
              {hoveredBone}
            </span>
          )}
          <span className="text-white/45 text-xs font-mono truncate max-w-[min(28vw,240px)] hidden lg:inline">
            {animInfo}
          </span>
        </div>

        <div className="flex max-h-[44vh] w-full max-w-[min(100%,74rem)] flex-wrap items-center justify-end gap-2 overflow-y-auto rounded-md bg-black/35 p-1">
          {animIds.map((id) => (
            <Button
              key={id}
              size="sm"
              variant={animId === id && !showRefPose ? "default" : "outline"}
              onClick={() => {
                showRefPoseRef.current = false
                setShowRefPose(false)
                handleAnimChange(id)
              }}
              disabled={loading || loadingAnim}
              className={`text-xs px-2 py-1 h-7 ${animId === id && !showRefPose ? "bg-white text-black hover:bg-white/90" : ""}`}
            >
              {id.replace("a000_", "")}
            </Button>
          ))}
          <Button
            size="sm"
            variant={showRefPose ? "default" : "outline"}
            onClick={toggleRefPose}
            disabled={loading || loadingAnim}
            className={showRefPose ? "bg-cyan-500 text-black hover:bg-cyan-400 h-7" : "h-7"}
          >
            Ref Pose
          </Button>
          <Button
            size="sm"
            variant={showNonMmdBones ? "default" : "outline"}
            onClick={() => setShowNonMmdBones((v) => !v)}
            disabled={loading || loadingAnim}
            className={showNonMmdBones ? "bg-purple-500 text-black hover:bg-purple-400 h-7" : "h-7"}
          >
            {showNonMmdBones ? "All Bones" : "MMD Bones"}
          </Button>
          <Button
            size="sm"
            variant={showBoneLabels ? "default" : "outline"}
            onClick={() => setShowBoneLabels((v) => !v)}
            disabled={loading || loadingAnim}
            className={showBoneLabels ? "bg-sky-500 text-black hover:bg-sky-400 h-7" : "h-7"}
          >
            {showBoneLabels ? "Labels On" : "Labels Off"}
          </Button>
          <Button
            size="sm"
            variant={mappedFkDebugMode ? "default" : "outline"}
            onClick={() => setMappedFkDebugMode((v) => !v)}
            disabled={loading || loadingAnim}
            className={mappedFkDebugMode ? "bg-amber-400 text-black hover:bg-amber-300 h-7" : "h-7"}
          >
            {mappedFkDebugMode ? "Mapped FK" : "Full FK"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={handleExportVmd}
            disabled={loading || loadingAnim || !clipReady}
            className="gap-1 h-7"
            title="ER→MMD retarget (30fps VMD)"
          >
            <Download className="w-4 h-4" />
            VMD
          </Button>
        </div>
      </header>

      <div className="relative min-h-0 flex-1">
        <div className="flex h-full min-h-0 w-full">
          <div ref={threeContainerRef} className="relative min-h-0 w-1/2 min-w-0 border-r border-white/10">
            <span className="pointer-events-none absolute left-2 top-2 z-10 text-[10px] uppercase tracking-wider text-white/50">
              HKX Source
            </span>
            <canvas ref={threeCanvasRef} className="block h-full w-full touch-none" />
          </div>
          <div className="relative min-h-0 w-1/2 min-w-0">
            <span className="pointer-events-none absolute left-2 top-2 z-10 text-[10px] uppercase tracking-wider text-white/50">
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
  )
}
