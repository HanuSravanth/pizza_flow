"use client";

// Daily sales chart for the admin dashboard: pizzas sold per day by default,
// toggled to revenue vs. discount per day (same unit, so one axis either way —
// never both measures on the same chart at once).

import { useState } from "react";
import { formatPaise } from "@/lib/format";

export interface DailyPoint {
  date: string; // "2026-07-03"
  pizzas: number;
  revenue: number; // rupees
  discount: number; // rupees
}

const HEIGHT = 220;
const PAD = { top: 14, right: 14, bottom: 28, left: 44 };
const BAR_MAX = 22;

// Pick a "nice" axis top and evenly-spaced ticks that are always whole numbers,
// so labels read 0/10/20/30/40 rather than 12.5→13, 37.5→38 artefacts.
function niceScale(rawMax: number, targetTicks = 4): { max: number; ticks: number[] } {
  if (rawMax <= 0) return { max: 4, ticks: [0, 1, 2, 3, 4] };
  const rawStep = rawMax / targetTicks;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const norm = rawStep / magnitude;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * magnitude;
  const max = Math.ceil(rawMax / step) * step;
  const ticks: number[] = [];
  for (let t = 0; t <= max + step / 2; t += step) ticks.push(Math.round(t));
  return { max, ticks };
}

function shortDate(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

// Rect with rounded top corners, square baseline — per mark spec.
function roundedTopPath(x: number, y: number, w: number, h: number, r: number): string {
  if (h <= 0) return "";
  const radius = Math.min(r, w / 2, h);
  return `M${x},${y + h} L${x},${y + radius} Q${x},${y} ${x + radius},${y} L${x + w - radius},${y} Q${x + w},${y} ${x + w},${y + radius} L${x + w},${y + h} Z`;
}

export function AdminDailyChart({ data }: { data: DailyPoint[] }) {
  const [mode, setMode] = useState<"pizzas" | "money">("pizzas");
  const [hover, setHover] = useState<number | null>(null);

  const width = 700;
  const innerW = width - PAD.left - PAD.right;
  const innerH = HEIGHT - PAD.top - PAD.bottom;
  const slot = innerW / data.length;
  const hasData = data.some((d) => d.pizzas > 0 || d.revenue > 0);

  const { max: maxValue, ticks: yTicks } =
    mode === "pizzas"
      ? niceScale(Math.max(1, ...data.map((d) => d.pizzas)))
      : niceScale(Math.max(1, ...data.map((d) => Math.max(d.revenue, d.discount))));

  const scaleY = (v: number) => (innerH * v) / (maxValue || 1);

  return (
    <div className="card daily-chart-card">
      <div className="daily-chart-head">
        <h2>{mode === "pizzas" ? "Pizzas sold per day" : "Revenue & discount per day"}</h2>
        <div className="seg-toggle" role="tablist" aria-label="Chart metric">
          <button
            type="button"
            role="tab"
            aria-selected={mode === "pizzas"}
            className={mode === "pizzas" ? "seg active" : "seg"}
            onClick={() => setMode("pizzas")}
          >
            Pizzas sold
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "money"}
            className={mode === "money" ? "seg active" : "seg"}
            onClick={() => setMode("money")}
          >
            Revenue & discount
          </button>
        </div>
      </div>

      {!hasData ? (
        <p className="page-sub" style={{ margin: 0 }}>
          No orders in the selected range yet.
        </p>
      ) : (
        <div className="daily-chart-wrap">
          <svg
            viewBox={`0 0 ${width} ${HEIGHT}`}
            className="daily-chart-svg"
            role="img"
            aria-label={mode === "pizzas" ? "Pizzas sold per day" : "Revenue and discount per day"}
          >
            {yTicks.map((t, i) => {
              const y = PAD.top + innerH - scaleY(t);
              return (
                <g key={i}>
                  <line x1={PAD.left} x2={width - PAD.right} y1={y} y2={y} className="chart-gridline" />
                  <text x={PAD.left - 8} y={y + 4} textAnchor="end" className="chart-axis-label">
                    {mode === "pizzas" ? t : `₹${t}`}
                  </text>
                </g>
              );
            })}

            {data.map((d, i) => {
              const x = PAD.left + i * slot;
              const centerX = x + slot / 2;
              const baseY = PAD.top + innerH;
              const hit = (
                <rect
                  key="hit"
                  x={x}
                  y={PAD.top}
                  width={slot}
                  height={innerH}
                  fill="transparent"
                  onMouseEnter={() => setHover(i)}
                  onMouseLeave={() => setHover(null)}
                />
              );

              if (mode === "pizzas") {
                const barW = Math.min(BAR_MAX, slot * 0.55);
                const h = scaleY(d.pizzas);
                return (
                  <g key={d.date}>
                    {hit}
                    <path
                      d={roundedTopPath(centerX - barW / 2, baseY - h, barW, h, 4)}
                      className={hover === i ? "bar bar-brand bar-hover" : "bar bar-brand"}
                    />
                  </g>
                );
              }

              const barW = Math.min(BAR_MAX, slot * 0.3);
              const gap = 2;
              const rh = scaleY(d.revenue);
              const dh = scaleY(d.discount);
              return (
                <g key={d.date}>
                  {hit}
                  <path
                    d={roundedTopPath(centerX - barW - gap / 2, baseY - rh, barW, rh, 4)}
                    className={hover === i ? "bar bar-brand bar-hover" : "bar bar-brand"}
                  />
                  <path
                    d={roundedTopPath(centerX + gap / 2, baseY - dh, barW, dh, 4)}
                    className={hover === i ? "bar bar-amber bar-hover" : "bar bar-amber"}
                  />
                </g>
              );
            })}

            <line
              x1={PAD.left}
              x2={width - PAD.right}
              y1={PAD.top + innerH}
              y2={PAD.top + innerH}
              className="chart-axis"
            />

            {data.map((d, i) => (
              <text
                key={d.date}
                x={PAD.left + i * slot + slot / 2}
                y={HEIGHT - 8}
                textAnchor="middle"
                className="chart-axis-label"
              >
                {shortDate(d.date)}
              </text>
            ))}
          </svg>

          {hover !== null && (
            <div
              className="chart-tooltip"
              style={{ left: `${((PAD.left + hover * slot + slot / 2) / width) * 100}%` }}
            >
              <strong>{shortDate(data[hover].date)}</strong>
              {mode === "pizzas" ? (
                <div>
                  {data[hover].pizzas} pizza{data[hover].pizzas === 1 ? "" : "s"} sold
                </div>
              ) : (
                <>
                  <div>
                    <span className="dot dot-brand" /> Revenue{" "}
                    {formatPaise(Math.round(data[hover].revenue * 100))}
                  </div>
                  <div>
                    <span className="dot dot-amber" /> Discount{" "}
                    {formatPaise(Math.round(data[hover].discount * 100))}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      )}

      {mode === "money" && hasData && (
        <div className="chart-legend">
          <span>
            <span className="dot dot-brand" /> Revenue
          </span>
          <span>
            <span className="dot dot-amber" /> Discount
          </span>
        </div>
      )}
    </div>
  );
}
