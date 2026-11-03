import { useEffect, useState } from "react";

/** Simulated telemetry: a rolling series that drifts around a base value. */
export function useLiveSeries(base: number, spread = 15, length = 32, ms = 1100) {
  const [data, setData] = useState(() =>
    Array.from({ length }, (_, i) => ({ t: i, v: base + Math.sin(i / 3) * spread * 0.5 })),
  );
  useEffect(() => {
    const id = setInterval(() => {
      setData((prev) => {
        const last = prev[prev.length - 1];
        const next = Math.max(2, Math.min(98, last.v + (Math.random() - 0.5) * spread));
        const pulled = next + (base - next) * 0.15;
        return [...prev.slice(1), { t: last.t + 1, v: pulled }];
      });
    }, ms);
    return () => clearInterval(id);
  }, [base, spread, ms]);
  return data;
}

export function useTicker(ms = 1000) {
  const [n, setN] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setN((x) => x + 1), ms);
    return () => clearInterval(id);
  }, [ms]);
  return n;
}
