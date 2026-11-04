import { motion, useMotionValue, useSpring, useTransform, animate } from "motion/react";
import { useEffect, useRef, type ReactNode } from "react";
import { Area, AreaChart, ResponsiveContainer, YAxis } from "recharts";
import { cn } from "@/lib/utils";

export function Panel({ className, children, delay = 0 }: { className?: string; children: ReactNode; delay?: number }) {
  return (
    <motion.section
      initial={{ opacity: 0, y: 16, scale: 0.985 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ type: "spring", stiffness: 220, damping: 26, delay }}
      className={cn("rounded-3xl border border-border bg-card p-5 shadow-soft", className)}
    >
      {children}
    </motion.section>
  );
}

export function PageHeader({ eyebrow, title, children }: { eyebrow: string; title: ReactNode; children?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <motion.p initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">
          {eyebrow}
        </motion.p>
        <motion.h1
          initial={{ opacity: 0, y: 10, filter: "blur(6px)" }}
          animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
          transition={{ duration: 0.5 }}
          className="mt-1 text-3xl font-bold md:text-4xl"
        >
          {title}
        </motion.h1>
      </div>
      {children}
    </div>
  );
}

/** Number that springs to its new value. */
export function Counter({ value, decimals = 0, suffix = "" }: { value: number; decimals?: number; suffix?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const prev = useRef(0);
  useEffect(() => {
    const c = animate(prev.current, value, {
      duration: 0.8,
      ease: [0.22, 1, 0.36, 1],
      onUpdate: (v) => { if (ref.current) ref.current.textContent = v.toFixed(decimals) + suffix; },
    });
    prev.current = value;
    return () => c.stop();
  }, [value, decimals, suffix]);
  return <span ref={ref} className="tabular-nums">{(0).toFixed(decimals) + suffix}</span>;
}

/** Circular gauge drawn with a spring-animated stroke. */
export function Ring({ value, size = 84, stroke = 9, tone = "primary", children }: { value: number; size?: number; stroke?: number; tone?: "primary" | "accent" | "success" | "warning"; children?: ReactNode }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const toneCls = { primary: "stroke-primary", accent: "stroke-accent", success: "stroke-success", warning: "stroke-warning" }[tone];
  return (
    <div className="relative grid place-items-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} strokeWidth={stroke} className="fill-none stroke-muted" />
        <motion.circle
          cx={size / 2} cy={size / 2} r={r} strokeWidth={stroke} strokeLinecap="round"
          className={cn("fill-none", toneCls)}
          strokeDasharray={c}
          animate={{ strokeDashoffset: c - (c * Math.min(100, value)) / 100 }}
          transition={{ type: "spring", stiffness: 60, damping: 16 }}
        />
      </svg>
      <div className="absolute inset-0 grid place-items-center text-center">{children}</div>
    </div>
  );
}

export function Spark({ data, tone = "primary", height = 56 }: { data: { t: number; v: number }[]; tone?: "primary" | "accent" | "success"; height?: number }) {
  const color = `var(--${tone})`;
  const id = `g-${tone}`;
  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 4, right: 0, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.35} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <YAxis hide domain={[0, 100]} />
          <Area type="monotone" dataKey="v" stroke={color} strokeWidth={2.2} fill={`url(#${id})`} isAnimationActive={false} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Card that tilts toward the cursor in 3D. */
export function TiltCard({ children, className, onClick }: { children: ReactNode; className?: string; onClick?: () => void }) {
  const x = useMotionValue(0.5);
  const y = useMotionValue(0.5);
  const rx = useSpring(useTransform(y, [0, 1], [6, -6]), { stiffness: 200, damping: 18 });
  const ry = useSpring(useTransform(x, [0, 1], [-6, 6]), { stiffness: 200, damping: 18 });
  const glowX = useTransform(x, (v) => `${v * 100}%`);
  const glowY = useTransform(y, (v) => `${v * 100}%`);
  return (
    <motion.div
      onClick={onClick}
      onPointerMove={(e) => {
        const b = e.currentTarget.getBoundingClientRect();
        x.set((e.clientX - b.left) / b.width);
        y.set((e.clientY - b.top) / b.height);
      }}
      onPointerLeave={() => { x.set(0.5); y.set(0.5); }}
      style={{ rotateX: rx, rotateY: ry, transformPerspective: 900 }}
      whileHover={{ y: -4 }}
      className={cn("group relative overflow-hidden rounded-3xl border border-border bg-card shadow-soft transition-shadow hover:shadow-lift", className)}
    >
      <motion.div
        aria-hidden
        className="pointer-events-none absolute -inset-px opacity-0 transition-opacity duration-300 group-hover:opacity-100"
        style={{ background: useTransform([glowX, glowY], ([gx, gy]) => `radial-gradient(260px circle at ${gx} ${gy}, color-mix(in oklab, var(--primary) 10%, transparent), transparent 70%)`) }}
      />
      <div className="relative">{children}</div>
    </motion.div>
  );
}

export function HueAvatar({ hue, label, size = 44 }: { hue: number; label: string; size?: number }) {
  return (
    <div
      className="grid shrink-0 place-items-center rounded-2xl font-display text-sm font-bold text-primary-foreground"
      style={{ width: size, height: size, background: `linear-gradient(135deg, oklch(0.7 0.15 ${hue}), oklch(0.55 0.18 ${hue + 40}))` }}
    >
      {label.slice(0, 2).toUpperCase()}
    </div>
  );
}

export function Pill({ tone = "muted", children, pulse }: { tone?: "muted" | "success" | "warning" | "destructive" | "primary" | "accent"; children: ReactNode; pulse?: boolean }) {
  const map = {
    muted: "bg-muted text-muted-foreground",
    success: "bg-success-soft text-success",
    warning: "bg-warning-soft text-foreground",
    destructive: "bg-destructive-soft text-destructive",
    primary: "bg-primary-soft text-primary",
    accent: "bg-accent-soft text-accent",
  } as const;
  const dot = { muted: "bg-muted-foreground", success: "bg-success", warning: "bg-warning", destructive: "bg-destructive", primary: "bg-primary", accent: "bg-accent" }[tone];
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold", map[tone])}>
      <span className="relative flex size-1.5">
        {pulse && <span className={cn("absolute inset-0 animate-ping rounded-full opacity-70", dot)} />}
        <span className={cn("relative size-1.5 rounded-full", dot)} />
      </span>
      {children}
    </span>
  );
}

