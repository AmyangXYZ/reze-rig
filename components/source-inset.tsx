"use client"

// Ground-truth inset: the parsed source skeleton, drawn with a plain 2D canvas
// and synced to the model's playback clock. Header carries the conversion
// report (rig profile · mapped bones · scale). Drag to orbit.

import { memo, useEffect, useRef, type RefObject } from "react"
import type { Model } from "reze-engine"
import type { SourcePreview } from "@/lib/retarget"

const W = 320
const H = 380

export const SourceInset = memo(function SourceInset({
  preview,
  modelRef,
}: {
  preview: SourcePreview
  modelRef: RefObject<Model | null>
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  /** Front view by default, matching the main scene's camera; drag to orbit. */
  const yawRef = useRef(0)
  const dragRef = useRef<{ x: number; yaw: number } | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = W * dpr
    canvas.height = H * dpr
    const ctx = canvas.getContext("2d")
    if (!ctx) return

    // Frame the skeleton once from its bind pose: vertical span → scale.
    const bind = preview.positionsAt(0)
    let minY = Infinity
    let maxY = -Infinity
    for (const p of bind) {
      if (p[1] < minY) minY = p[1]
      if (p[1] > maxY) maxY = p[1]
    }
    const span = Math.max(maxY - minY, 1e-3)
    const scale = (H * 0.82) / span
    const cy = (minY + maxY) / 2

    let raf = 0
    let lastKey = ""
    const draw = () => {
      raf = requestAnimationFrame(draw)
      const t = modelRef.current?.getAnimationProgress().current ?? 0
      const yaw = yawRef.current
      const key = `${t.toFixed(3)}|${yaw.toFixed(3)}`
      if (key === lastKey) return
      lastKey = key

      const pos = preview.positionsAt(t)
      const cos = Math.cos(yaw)
      const sin = Math.sin(yaw)
      // Slight downward camera tilt so depth reads — without it the Z axis
      // would project onto the X axis and the ground cross collapses to a line.
      const PITCH = 0.26
      const cosP = Math.cos(PITCH)
      const sinP = Math.sin(PITCH)
      // Root motion stays visible but the camera follows the hips laterally so
      // locomotion clips don't walk out of the frame.
      let cx = 0
      let cz = 0
      const rootIdx = preview.bones.findIndex((b) => b.name === "Hips")
      if (rootIdx >= 0) {
        cx = pos[rootIdx][0]
        cz = pos[rootIdx][2]
      }
      const project = (p: [number, number, number]): [number, number] => {
        const x = p[0] - cx
        const z = p[2] - cz
        // Yaw about Y, then a pitched orthographic view.
        const rx = x * cos - z * sin
        const rz = x * sin + z * cos
        return [W / 2 + rx * scale, H / 2 - ((p[1] - cy) * cosP - rz * sinP) * scale]
      }

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, W, H)

      // Ground cross under the character: X and Z axes at the bind floor.
      const axisLen = span * 0.6
      const drawAxis = (a: [number, number, number], b: [number, number, number], color: string) => {
        const pa = project(a)
        const pb = project(b)
        ctx.strokeStyle = color
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(pa[0], pa[1])
        ctx.lineTo(pb[0], pb[1])
        ctx.stroke()
      }
      drawAxis([cx - axisLen, minY, cz], [cx + axisLen, minY, cz], "rgba(255,130,130,0.35)")
      drawAxis([cx, minY, cz - axisLen], [cx, minY, cz + axisLen], "rgba(130,160,255,0.4)")

      const pts = pos.map(project)
      // Bones: mapped bright, unmapped dimmed.
      for (let i = 0; i < preview.bones.length; i++) {
        const pi = preview.bones[i].parentIndex
        if (pi < 0) continue
        const bright = preview.bones[i].mapped && preview.bones[pi].mapped
        ctx.strokeStyle = bright ? "rgba(102,153,255,0.95)" : "rgba(255,255,255,0.18)"
        ctx.lineWidth = bright ? 1.5 : 1
        ctx.beginPath()
        ctx.moveTo(pts[pi][0], pts[pi][1])
        ctx.lineTo(pts[i][0], pts[i][1])
        ctx.stroke()
      }
      for (let i = 0; i < preview.bones.length; i++) {
        const bright = preview.bones[i].mapped
        ctx.fillStyle = bright ? "rgba(255,255,255,0.95)" : "rgba(255,255,255,0.25)"
        const r = bright ? 1.8 : 1.2
        ctx.beginPath()
        ctx.arc(pts[i][0], pts[i][1], r, 0, Math.PI * 2)
        ctx.fill()
      }
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [preview, modelRef])

  const info = preview.info
  const report = info.bindMissing
    ? `${info.profile} · bind pose missing`
    : `${info.profile} · ${info.mappedCount} bones` +
      (info.unmapped.length > 0 ? ` · ${info.unmapped.length} unmapped` : "")
  const fullReport = `${report} · scale ${info.scale.toFixed(3)}` +
    (info.unmapped.length > 0 ? `\nunmapped: ${info.unmapped.join(", ")}` : "")
  return (
    <div className="pointer-events-auto w-[320px] select-none overflow-hidden rounded-lg border border-white/10 bg-zinc-950/70 backdrop-blur-xs">
      <div className="flex items-center gap-2 overflow-hidden px-3 py-1.5" title={fullReport}>
        <span className="shrink-0 text-[10px] uppercase tracking-wider text-white/40">Source</span>
        <span
          className={`overflow-hidden whitespace-nowrap font-mono text-[11px] ${info.bindMissing ? "text-amber-300" : "text-white/60"}`}
        >
          {report}
        </span>
      </div>
      {info.bindMissing && (
        <p className="px-3 pb-2 text-[11px] leading-snug text-amber-300/80">
          Its rest pose is just frame 1, so the rig&apos;s real bind is missing. Drop the pack&apos;s T-pose file — a
          still, single-frame FBX — to convert correctly.
        </p>
      )}
      <canvas
        ref={canvasRef}
        style={{ width: W, height: H }}
        className="block cursor-ew-resize touch-none"
        onPointerDown={(e) => {
          dragRef.current = { x: e.clientX, yaw: yawRef.current }
          e.currentTarget.setPointerCapture(e.pointerId)
        }}
        onPointerMove={(e) => {
          const d = dragRef.current
          if (d) yawRef.current = d.yaw + (e.clientX - d.x) * 0.01
        }}
        onPointerUp={() => {
          dragRef.current = null
        }}
      />
    </div>
  )
})
