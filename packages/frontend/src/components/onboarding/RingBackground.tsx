import { useEffect, useRef } from "react";
import { cn } from "../../lib/cn";

/**
 * The welcome page's one flourish: the logo's two ring sets drawn large, so
 * they beat into a moiré. The second set leans toward the pointer and shades
 * pink to blue; a soft colour wash with grain sits under it. On the landing
 * page the rings centre behind the title; in setup they sit right of the
 * form. Drawn once and left still under reduced motion.
 */
export function RingBackground({ mode }: { mode: "landing" | "setup" }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // Read by the draw loop, so switching mode doesn't restart it.
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const redrawRef = useRef<() => void>(() => {});

  useEffect(() => {
    const cv = canvasRef.current;
    const ctx = cv?.getContext("2d");
    if (!cv || !ctx) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    let w = 0;
    let h = 0;
    let raf = 0;
    let last = 0;
    // Eased pointer lean: `t*` is where it's heading, `x`/`y` where it is.
    const ptr = { x: 0, y: 0, tx: 0, ty: 0, cx: 0, cy: 0 };

    const size = () => {
      const d = Math.min(window.devicePixelRatio || 1, 2);
      w = cv.clientWidth;
      h = cv.clientHeight;
      cv.width = w * d;
      cv.height = h * d;
      ctx.setTransform(d, 0, 0, d, 0, 0);
    };
    const rings = (cx: number, cy: number, style: string | CanvasGradient, gap: number, maxR: number) => {
      ctx.strokeStyle = style;
      ctx.beginPath();
      for (let r = gap; r < maxR; r += gap) {
        ctx.moveTo(cx + r, cy);
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
      }
      ctx.stroke();
    };
    const draw = (t: number) => {
      ctx.clearRect(0, 0, w, h);
      const land = modeRef.current === "landing";
      const narrow = w < 768;
      const bx = land ? w * 0.5 - 13 : w * (narrow ? 0.75 : 0.8);
      const by = land ? h * 0.46 : h * (narrow ? 0.3 : 0.45);
      // A slow drift, so the pattern shifts even when nothing moves.
      const ax = bx + Math.sin(t * 0.00011) * 26;
      const ay = by + Math.cos(t * 0.00008) * 20;
      const dx = 26 + Math.sin(t * 0.00017) * 16;
      const dy = Math.cos(t * 0.00013) * 9;
      ptr.cx = bx;
      ptr.cy = by;
      ptr.x += (ptr.tx - ptr.x) * 0.06;
      ptr.y += (ptr.ty - ptr.y) * 0.06;
      const maxR = Math.hypot(w, h) * 0.75;
      ctx.lineWidth = 1.05;
      const ink = ctx.createLinearGradient(land ? 0 : w * 0.4, 0, w, h);
      ink.addColorStop(0, "rgba(232,137,168,0.32)");
      ink.addColorStop(0.5, "rgba(157,136,240,0.32)");
      ink.addColorStop(1, "rgba(110,170,230,0.30)");
      rings(ax, ay, "rgba(236,236,241,0.15)", 7, maxR);
      rings(ax + dx + ptr.x, ay + dy + ptr.y, ink, 7, maxR);
    };
    // ~30 fps is plenty for a drift.
    const loop = (t: number) => {
      raf = requestAnimationFrame(loop);
      if (t - last < 33) return;
      last = t;
      draw(t);
    };
    const start = () => {
      if (!reduce && !raf) raf = requestAnimationFrame(loop);
    };
    const stop = () => {
      cancelAnimationFrame(raf);
      raf = 0;
    };

    const onMove = (e: PointerEvent) => {
      const clamp = (v: number) => Math.max(-40, Math.min(40, v));
      ptr.tx = clamp((e.clientX - ptr.cx) * 0.06);
      ptr.ty = clamp((e.clientY - ptr.cy) * 0.06);
    };
    const onResize = () => {
      size();
      draw(last);
    };
    const onVisibility = () => (document.hidden ? stop() : start());

    redrawRef.current = () => draw(last);
    size();
    draw(0);
    start();
    window.addEventListener("pointermove", onMove);
    window.addEventListener("resize", onResize);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("resize", onResize);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  // Under reduced motion nothing animates, so a mode switch redraws by hand.
  useEffect(() => redrawRef.current(), [mode]);

  return (
    <div className={cn("ring-bg", mode === "landing" && "ring-bg-landing")} aria-hidden="true">
      <div className="ring-bg-wash" />
      <canvas ref={canvasRef} className="ring-bg-canvas" />
    </div>
  );
}
