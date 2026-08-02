"use client"

// Persistent bottom transport: play/pause · scrub · time · loop.
// Ported from reze-design's AnimPlayer, single-model, loop default-ON.

import { memo, useEffect, useRef, useState, type RefObject } from "react"
import type { Engine, Model } from "reze-engine"
import { Pause, Play, Repeat } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Slider } from "@/components/ui/slider"

/** A single scrub step past this reads as a teleport rather than motion —
 *  rigid bodies see it as enormous velocity and hair/skirts detonate. */
const SEEK_SETTLE_SECONDS = 0.35

const fmt = (s: number) => {
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${sec.toString().padStart(2, "0")}`
}

const AT_END_EPS = 0.02

type Progress = { current: number; duration: number; playing: boolean; paused: boolean }

export const AnimPlayer = memo(function AnimPlayer({
  engineRef,
  modelRef,
  hasClip,
}: {
  engineRef: RefObject<Engine | null>
  modelRef: RefObject<Model | null>
  hasClip: boolean
}) {
  const [progress, setProgress] = useState<Progress>({ current: 0, duration: 0, playing: false, paused: false })
  const [loop, setLoop] = useState(true)
  const loopRef = useRef(loop)
  useEffect(() => {
    loopRef.current = loop
  })
  const [dragVal, setDragVal] = useState<number | null>(null)

  useEffect(() => {
    let raf = 0
    let last: Progress = { current: -1, duration: -1, playing: false, paused: false }
    // No display quantum: the playhead is judged against a 60 Hz render, so any
    // throttle reads as stepping. `progress` re-renders only this small subtree,
    // and while nothing plays `current` stops changing, so the loop idles.
    const tick = () => {
      raf = requestAnimationFrame(tick)
      const m = modelRef.current
      if (!m) {
        if (last.current !== 0 || last.duration !== 0 || last.playing || last.paused) {
          last = { current: 0, duration: 0, playing: false, paused: false }
          setProgress(last)
        }
        return
      }
      const p = m.getAnimationProgress()
      if (p.current !== last.current || p.duration !== last.duration || p.playing !== last.playing || p.paused !== last.paused) {
        last = { current: p.current, duration: p.duration, playing: p.playing, paused: p.paused }
        setProgress(last)
      }
      if (loopRef.current && !p.playing && !p.paused && p.duration > 0 && p.current >= p.duration - AT_END_EPS) {
        // End → frame 0 teleports every bone; settle physics with it.
        m.seek(0)
        engineRef.current?.resetPhysics()
        m.play()
      }
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [engineRef, modelRef])

  const toggle = () => {
    const m = modelRef.current
    if (!m) return
    const p = m.getAnimationProgress()
    if (p.playing) {
      m.pause()
    } else if (p.paused) {
      m.play() // resume from where it was paused
    } else if (p.duration > 0) {
      // Clip loaded but stopped (ended, or scrubbed while stopped).
      if (p.current >= p.duration - AT_END_EPS) {
        m.seek(0)
        engineRef.current?.resetPhysics() // same end→0 teleport as the loop path
      }
      m.play()
    }
  }

  // Space toggles play/pause globally (unless typing in a field).
  const toggleRef = useRef(toggle)
  useEffect(() => {
    toggleRef.current = toggle
  })
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "Space") return
      const t = e.target as HTMLElement | null
      if (t && (["INPUT", "TEXTAREA", "BUTTON", "SELECT"].includes(t.tagName) || t.isContentEditable)) return
      e.preventDefault()
      toggleRef.current()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  // What is measured is the largest SINGLE step of the interaction, not total
  // travel: a slow drag is a thousand small steps and resets nothing; clicking
  // the far end of the track is one big step and resets once, on release.
  const biggestStep = useRef(0)
  const seek = (v: number) => {
    biggestStep.current = Math.max(biggestStep.current, Math.abs(v - (dragVal ?? progress.current)))
    setDragVal(v)
    modelRef.current?.seek(v)
  }
  const endSeek = () => {
    setDragVal(null)
    if (biggestStep.current > SEEK_SETTLE_SECONDS) engineRef.current?.resetPhysics()
    biggestStep.current = 0
  }

  const current = dragVal ?? progress.current

  return (
    <div className="flex items-center gap-2 rounded-full border border-white/10 bg-zinc-950/70 py-1 pr-3 pl-3 backdrop-blur-xs">
      <Button
        variant="ghost"
        size="icon"
        className="size-7 shrink-0 rounded-full hover:bg-white/5 hover:text-foreground disabled:opacity-40"
        disabled={!hasClip}
        onClick={toggle}
        aria-label={progress.playing ? "Pause" : "Play"}
      >
        {progress.playing ? <Pause className="size-4" /> : <Play className="size-4 translate-x-px" />}
      </Button>
      <span className="shrink-0 text-xs leading-none text-muted-foreground tabular-nums">{fmt(current)}</span>
      <Slider
        className="w-[min(24rem,42vw)] [&_[data-slot=slider-thumb]]:size-2.5 [&_[data-slot=slider-thumb]]:hover:ring-2 [&_[data-slot=slider-track]]:h-1"
        value={[current]}
        min={0}
        max={Math.max(progress.duration, 0.01)}
        step={0.01}
        disabled={!hasClip}
        onValueChange={([v]) => seek(v)}
        onValueCommit={endSeek}
      />
      <span className="shrink-0 text-xs leading-none text-muted-foreground tabular-nums">{fmt(progress.duration)}</span>
      <Button
        variant="ghost"
        size="icon"
        className={loop ? "size-7 shrink-0 rounded-full text-blue-400" : "size-7 shrink-0 rounded-full text-muted-foreground hover:text-foreground"}
        onClick={() => setLoop((v) => !v)}
        title={loop ? "Loop on" : "Loop off"}
        aria-label={loop ? "Loop on" : "Loop off"}
      >
        <Repeat className="size-4" strokeWidth={loop ? 2.4 : 1.6} />
      </Button>
    </div>
  )
})
