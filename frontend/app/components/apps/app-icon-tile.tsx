import type { ComponentType, SVGProps } from "react";
import { HeartPulse } from "lucide-react";

import notion from "thesvg/notion";
import obsidian from "thesvg/obsidian";
import telegram from "thesvg/telegram";
import googleDrive from "thesvg/google-drive";
import wechat from "thesvg/wechat";
import x from "thesvg/x";

import type { App } from "~/types/apps";
import { cn } from "~/lib/utils";

type IconConfig = {
  // Inline raw SVG (from thesvg) OR a React component (Lucide / custom).
  // Provide exactly one.
  svg?: string;
  Component?: ComponentType<SVGProps<SVGSVGElement>>;
  // Tile background as a CSS color string.
  bg: string;
  // Glyph color when using a Component, or to tint a `mono`-variant SVG.
  // Defaults to white. Mono SVGs need `fill: currentColor` + this color.
  fg?: string;
};

// Per-app icon mapping. Mono variants are tinted via currentColor (`fg`);
// default variants render with their built-in colors.
const ICON_BY_ID: Record<string, IconConfig> = {
  "apple-health": {
    Component: HeartPulse,
    bg: "#FFFFFF",
    fg: "#FA114F",
  },
  notion: { svg: notion.variants.mono, bg: "#000000", fg: "#FFFFFF" },
  obsidian: { svg: obsidian.variants.default, bg: "#7C3AED" },
  telegram: { svg: telegram.variants.mono, bg: "#26A5E4", fg: "#FFFFFF" },
  "google-drive": { svg: googleDrive.variants.default, bg: "#FFFFFF" },
  wechat: { svg: wechat.variants.mono, bg: "#07C160", fg: "#FFFFFF" },
  twitter: { svg: x.variants.mono, bg: "#000000", fg: "#FFFFFF" },
};

// Tailwind size presets.
const SIZE = {
  md: { tile: "h-16 w-16 rounded-2xl", glyph: "h-9 w-9" },
  lg: { tile: "h-20 w-20 rounded-[1.4rem]", glyph: "h-12 w-12" },
} as const;

interface Props {
  app: App;
  size?: keyof typeof SIZE;
  className?: string;
}

export function AppIconTile({ app, size = "md", className }: Props) {
  const cfg = ICON_BY_ID[app.id];
  const dim = SIZE[size];
  const fg = cfg?.fg ?? "#FFFFFF";

  return (
    <div
      className={cn(
        dim.tile,
        "flex items-center justify-center overflow-hidden shadow-sm shrink-0",
        className,
      )}
      style={{ background: cfg?.bg ?? "#9CA3AF", color: fg }}
    >
      {cfg?.Component ? (
        <cfg.Component
          className={dim.glyph}
          color={fg}
          strokeWidth={2.4}
          fill={app.id === "apple-health" ? fg : "none"}
        />
      ) : cfg?.svg ? (
        <div
          className={cn(
            dim.glyph,
            "flex items-center justify-center",
            "[&_svg]:w-full [&_svg]:h-full [&_svg]:fill-current",
          )}
          // SVG strings are bundled at build time from the `thesvg` package;
          // they are not user input.
          dangerouslySetInnerHTML={{ __html: cfg.svg }}
        />
      ) : (
        <span className="text-lg font-semibold" style={{ color: fg }}>
          {app.name[0]}
        </span>
      )}
    </div>
  );
}
