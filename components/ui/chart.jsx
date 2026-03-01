"use client";

import * as React from "react";
import { ResponsiveContainer, Tooltip as RechartsTooltip } from "recharts";
import { cn } from "../../lib/utils";

function ChartContainer({ className, children }) {
  return (
    <div className={cn("h-[132px] w-full", className)}>
      <ResponsiveContainer width="100%" height="100%">
        {children}
      </ResponsiveContainer>
    </div>
  );
}

const ChartTooltip = RechartsTooltip;

function ChartTooltipContent({ active, payload, label }) {
  if (!active || !payload?.length) {
    return null;
  }

  const point = payload[0]?.payload ?? {};
  const count = typeof point.count === "number" ? point.count : 0;

  return (
    <div className="rounded-md border border-slate-700 bg-slate-950/95 px-2.5 py-1.5 text-[11px] text-slate-100 shadow-md">
      <p className="font-mono text-cyan-200">{label ?? point.range ?? "bin"}</p>
      <p>{count} chunk(s)</p>
    </div>
  );
}

export { ChartContainer, ChartTooltip, ChartTooltipContent };
