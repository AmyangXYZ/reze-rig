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
  const yawRef = useRef(-0.4)
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
        // Yaw about Y, then orthographic: screen-x from rotated x, screen-y from height.
        const rx = x * cos - z * sin
        return [W / 2 + rx * scale, H / 2 - (p[1] - cy) * scale]
      }

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, W, H)

      // Ground line at the skeleton's bind floor.
      const groundY = H / 2 - (minY - cy) * scale
      ctx.strokeStyle = "rgba(255,255,255,0.12)"
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(10, groundY)
      ctx.lineTo(W - 10, groundY)
      ctx.stroke()

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
  const report =
    `${info.profile} · ${info.mappedCount} bones` +
    (info.unmapped.length > 0 ? ` · ${info.unmapped.length} unmapped` : "")
  const fullReport = `${report} · scale ${info.scale.toFixed(3)}` +
    (info.unmapped.length > 0 ? `\nunmapped: ${info.unmapped.join(", ")}` : "")
  return (
    <div className="pointer-events-auto w-[320px] select-none overflow-hidden rounded-lg border border-white/10 bg-zinc-950/70 backdrop-blur-xs">
      <div className="flex items-center gap-2 overflow-hidden px-3 py-1.5" title={fullReport}>
        <span className="shrink-0 text-[10px] uppercase tracking-wider text-white/40">Source</span>
        <span className="overflow-hidden whitespace-nowrap font-mono text-[11px] text-white/60">{report}</span>
      </div>
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
