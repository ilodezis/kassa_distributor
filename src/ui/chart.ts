// "Факт vs target": a bar per manager (actual registers) with the target drawn as a line.
// Plain SVG, coloured through CSS classes so it follows the light/dark theme.

import type { ChartPoint } from "../core/distribute.ts";
import { h, s } from "./dom.ts";

/** Round axis ticks from 0 to just above `max`. */
export function niceTicks(max: number, wanted = 6): number[] {
  if (!(max > 0)) return [0, 1];
  const rough = max / (wanted - 1);
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((candidate) => candidate >= rough) ?? 10 * magnitude;
  const ticks: number[] = [];
  for (let value = 0; value < max + step; value += step) {
    ticks.push(Math.round(value * 1e6) / 1e6);
    if (value >= max) break;
  }
  return ticks;
}

function shorten(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

export function renderChart(points: readonly ChartPoint[]): HTMLElement {
  const margin = { top: 44, right: 24, bottom: 150, left: 56 };
  const band = 34;
  const plotWidth = Math.max(900, points.length * band);
  const plotHeight = 300;
  const width = margin.left + plotWidth + margin.right;
  const height = margin.top + plotHeight + margin.bottom;

  const ticks = niceTicks(Math.max(0, ...points.flatMap((p) => [p.fact_total, p.target_total])));
  const top = ticks[ticks.length - 1]!;
  const y = (value: number) => margin.top + plotHeight - (value / top) * plotHeight;
  const bandWidth = points.length > 0 ? plotWidth / points.length : plotWidth;
  const x = (index: number) => margin.left + bandWidth * (index + 0.5);

  const svg = s("svg", {
    class: "chart",
    viewBox: `0 0 ${width} ${height}`,
    width,
    height,
    role: "img",
    "aria-label": "Факт против таргета по менеджерам",
  });

  svg.append(s("text", { class: "chart-title", x: margin.left, y: 24 }, "Факт vs target"));

  // Legend
  const legendX = margin.left + plotWidth - 190;
  svg.append(
    s("rect", { class: "bar", x: legendX, y: 14, width: 12, height: 12, rx: 2 }),
    s("text", { class: "chart-legend", x: legendX + 18, y: 24 }, "fact_total"),
    s("line", { class: "target-line", x1: legendX + 96, y1: 20, x2: legendX + 112, y2: 20 }),
    s("circle", { class: "target-dot", cx: legendX + 104, cy: 20, r: 3.5 }),
    s("text", { class: "chart-legend", x: legendX + 120, y: 24 }, "target_total"),
  );

  // Grid and y axis
  for (const tick of ticks) {
    svg.append(
      s("line", { class: "grid", x1: margin.left, x2: margin.left + plotWidth, y1: y(tick), y2: y(tick) }),
      s("text", { class: "axis-label", x: margin.left - 8, y: y(tick) + 4, "text-anchor": "end" }, tick),
    );
  }
  svg.append(
    s("text", { class: "axis-title", transform: `translate(14 ${margin.top + plotHeight / 2}) rotate(-90)`, "text-anchor": "middle" }, "Кассы"),
  );

  // Bars
  points.forEach((point, index) => {
    const barWidth = bandWidth * 0.62;
    const barTop = y(point.fact_total);
    svg.append(
      s(
        "rect",
        { class: "bar", x: x(index) - barWidth / 2, y: barTop, width: barWidth, height: margin.top + plotHeight - barTop, rx: 2 },
        s("title", {}, `${point.manager}\nфакт ${point.fact_total}, цель ${point.target_total}`),
      ),
    );
  });

  // Target line
  if (points.length > 0) {
    svg.append(
      s("polyline", {
        class: "target-line",
        fill: "none",
        points: points.map((p, i) => `${x(i)},${y(p.target_total)}`).join(" "),
      }),
    );
    points.forEach((point, index) => {
      svg.append(s("circle", { class: "target-dot", cx: x(index), cy: y(point.target_total), r: 3.5 }));
    });
  }

  // X labels, rotated so long names stay readable
  points.forEach((point, index) => {
    const labelY = margin.top + plotHeight + 14;
    svg.append(
      s(
        "text",
        { class: "axis-label", x: x(index), y: labelY, "text-anchor": "end", transform: `rotate(-45 ${x(index)} ${labelY})` },
        shorten(point.manager, 26),
      ),
    );
  });

  svg.append(s("line", { class: "axis", x1: margin.left, x2: margin.left + plotWidth, y1: y(0), y2: y(0) }));

  return h("div", { class: "chart-scroll" }, svg);
}
