import { HeartPulse } from "lucide-react";

import notion from "thesvg/notion";
import obsidian from "thesvg/obsidian";
import telegram from "thesvg/telegram";
import googleDrive from "thesvg/google-drive";
import wechat from "thesvg/wechat";
import x from "thesvg/x";

import type { App } from "~/types/apps";

const SVG_BY_ID: Record<string, string> = {
  notion: notion.variants.default,
  obsidian: obsidian.variants.default,
  telegram: telegram.variants.default,
  "google-drive": googleDrive.variants.default,
  wechat: wechat.variants.default,
  twitter: x.variants.default,
};

// Prefix `id="x"` / `url(#x)` so multiple inlined SVGs with overlapping
// gradient ids don't collide (telegram and obsidian both ship `id="a"`).
function scopeSvgIds(svg: string, scope: string): string {
  return svg
    .replace(/id="([^"]+)"/g, `id="${scope}-$1"`)
    .replace(/url\(#([^)]+)\)/g, `url(#${scope}-$1)`);
}

export function AppIconTile({ app }: { app: App }) {
  const svg = SVG_BY_ID[app.id];
  return (
    <div className="h-20 w-20 rounded-[1.4rem] bg-white flex items-center justify-center overflow-hidden shadow-sm shrink-0">
      {svg ? (
        <div
          className="h-[65%] w-[65%] [&_svg]:w-full [&_svg]:h-full"
          dangerouslySetInnerHTML={{ __html: scopeSvgIds(svg, app.id) }}
        />
      ) : app.id === "apple-health" ? (
        <HeartPulse
          className="h-[65%] w-[65%]"
          color="#FA114F"
          fill="#FA114F"
          strokeWidth={2.4}
        />
      ) : (
        <span className="text-sm font-semibold text-gray-400">
          {app.name[0]}
        </span>
      )}
    </div>
  );
}
