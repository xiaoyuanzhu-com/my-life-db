// Raw SVG assets (bundled via Vite ?raw).
import appleHealthSvg from "~/assets/apple-health.svg?raw";
import appleNotesSvg from "~/assets/apple-notes.svg?raw";
import yuqueSvg from "~/assets/yuque.svg?raw";

// Raster image assets (bundled as URL by Vite).
import bearImg from "~/assets/bear.png";
import flomoImg from "~/assets/flomo.webp";

// Existing icons.
import notion from "thesvg/notion";
import obsidian from "thesvg/obsidian";
import telegram from "thesvg/telegram";
import google from "thesvg/google";
import wechat from "thesvg/wechat";
import x from "thesvg/x";

// Health & fitness.
import garmin from "thesvg/garmin";
import strava from "thesvg/strava";
import fitbit from "thesvg/fitbit";
import peloton from "thesvg/peloton";
import xiaomi from "thesvg/xiaomi";

// Social.
import instagram from "thesvg/instagram";
import facebook from "thesvg/facebook";
import linkedin from "thesvg/linkedin";
import tiktok from "thesvg/tiktok";
import xiaohongshu from "thesvg/xiaohongshu";
import bilibili from "thesvg/bilibili";
import douban from "thesvg/douban";
import zhihu from "thesvg/zhihu";
import reddit from "thesvg/reddit";
import mastodon from "thesvg/mastodon";
import bluesky from "thesvg/bluesky";
import sinaWeibo from "thesvg/sina-weibo";

// Chat.
import whatsapp from "thesvg/whatsapp";
import discord from "thesvg/discord";
import slack from "thesvg/slack";
import signal from "thesvg/signal";
import imessage from "thesvg/imessage";
import line from "thesvg/line";
import qq from "thesvg/qq";
import bytedance from "thesvg/bytedance";

// AI chats.
import openaiChatgpt from "thesvg/openai-chatgpt";
import claudeAi from "thesvg/claude-ai";
import claudeCode from "thesvg/claude-code";
import gemini from "thesvg/gemini";
import microsoftCopilot from "thesvg/microsoft-copilot";
import perplexity from "thesvg/perplexity";
import grokXai from "thesvg/grok-xai";
import deepseek from "thesvg/deepseek";
import kimi from "thesvg/kimi";
import doubao from "thesvg/doubao";
import notebooklm from "thesvg/notebooklm";

// Notes.
import evernote from "thesvg/evernote";
import logseq from "thesvg/logseq";
import microsoftOnenote from "thesvg/microsoft-onenote";
import simplenote from "thesvg/simplenote";
import affine from "thesvg/affine";
import joplin from "thesvg/joplin";
import siyuan from "thesvg/siyuan";

// Cloud.
import dropbox from "thesvg/dropbox";
import icloud from "thesvg/icloud";
import microsoftOnedrive from "thesvg/microsoft-onedrive";
import baidu from "thesvg/baidu";

// Media.
import spotify from "thesvg/spotify";
import appleMusic from "thesvg/apple-music";
import youtube from "thesvg/youtube";
import netflix from "thesvg/netflix";
import amazonKindle from "thesvg/amazon-kindle";
import goodreads from "thesvg/goodreads";
import letterboxd from "thesvg/letterboxd";

// Productivity / other.
import todoist from "thesvg/todoist";
import ticktick from "thesvg/ticktick";
import github from "thesvg/github";

// Finance.
import alipay from "thesvg/alipay";
import venmo from "thesvg/venmo";
import paypal from "thesvg/paypal";

import type { App } from "~/types/apps";

const SVG_BY_ID: Record<string, string> = {
  // Existing.
  notion: notion.variants.default,
  obsidian: obsidian.variants.default,
  telegram: telegram.variants.default,
  google: google.variants.default,
  wechat: wechat.variants.default,
  twitter: x.variants.default,

  // Health.
  "apple-health": appleHealthSvg,
  garmin: garmin.variants.default,
  strava: strava.variants.default,
  fitbit: fitbit.variants.default,
  peloton: peloton.variants.default,
  "mi-fitness": xiaomi.variants.default,

  // Social.
  instagram: instagram.variants.default,
  facebook: facebook.variants.default,
  linkedin: linkedin.variants.default,
  tiktok: tiktok.variants.default,
  xiaohongshu: xiaohongshu.variants.default,
  bilibili: bilibili.variants.default,
  douban: douban.variants.default,
  zhihu: zhihu.variants.default,
  reddit: reddit.variants.default,
  mastodon: mastodon.variants.default,
  bluesky: bluesky.variants.default,
  weibo: sinaWeibo.variants.default,

  // Chat.
  whatsapp: whatsapp.variants.default,
  discord: discord.variants.default,
  slack: slack.variants.default,
  signal: signal.variants.default,
  imessage: imessage.variants.default,
  line: line.variants.default,
  qq: qq.variants.default,
  feishu: bytedance.variants.default,

  // AI chats.
  chatgpt: openaiChatgpt.variants.default,
  claude: claudeAi.variants.default,
  "claude-code": claudeCode.variants.default,
  gemini: gemini.variants.default,
  copilot: microsoftCopilot.variants.default,
  perplexity: perplexity.variants.default,
  grok: grokXai.variants.default,
  deepseek: deepseek.variants.default,
  kimi: kimi.variants.default,
  doubao: doubao.variants.default,
  notebooklm: notebooklm.variants.default,

  // Notes.
  evernote: evernote.variants.default,
  logseq: logseq.variants.default,
  "apple-notes": appleNotesSvg,
  "microsoft-onenote": microsoftOnenote.variants.default,
  simplenote: simplenote.variants.default,
  affine: affine.variants.default,
  joplin: joplin.variants.default,
  siyuan: siyuan.variants.default,
  yuque: yuqueSvg,

  // Cloud.
  dropbox: dropbox.variants.default,
  "icloud-drive": icloud.variants.default,
  onedrive: microsoftOnedrive.variants.default,
  "baidu-netdisk": baidu.variants.default,

  // Media.
  spotify: spotify.variants.default,
  "apple-music": appleMusic.variants.default,
  youtube: youtube.variants.default,
  netflix: netflix.variants.default,
  kindle: amazonKindle.variants.default,
  goodreads: goodreads.variants.default,
  letterboxd: letterboxd.variants.default,

  // Productivity / other.
  todoist: todoist.variants.default,
  ticktick: ticktick.variants.default,
  github: github.variants.mono,

  // Finance.
  alipay: alipay.variants.default,
  venmo: venmo.variants.default,
  paypal: paypal.variants.default,
  // wechat-pay: reuse the WeChat logo.
  "wechat-pay": wechat.variants.default,
};

const IMG_BY_ID: Record<string, string> = {
  bear: bearImg,
  flomo: flomoImg,
};

// Prefix `id="x"` / `url(#x)` / `href="#x"` / `xlink:href="#x"` so multiple
// inlined SVGs with overlapping gradient ids don't collide (telegram and
// obsidian both ship `id="a"`; google and netflix chain gradients via
// xlink:href). Handle href and xlink:href in a single pass so we don't
// double-scope (an earlier two-pass version rewrote `xlink:href="#a"` into
// `xlink:href="#scope-scope-a"` via word-boundary overlap).
function scopeSvgIds(svg: string, scope: string): string {
  return svg
    .replace(/id="([^"]+)"/g, `id="${scope}-$1"`)
    .replace(/url\(#([^)]+)\)/g, `url(#${scope}-$1)`)
    .replace(/\b(xlink:href|href)="#([^"]+)"/g, `$1="#${scope}-$2"`);
}

export function AppIconTile({ app, name }: { app: App; name?: string }) {
  const svg = SVG_BY_ID[app.id];
  const img = IMG_BY_ID[app.id];
  const label = name ?? app.name;
  return (
    <div className="h-20 w-20 rounded-[1.4rem] bg-white flex items-center justify-center overflow-hidden shadow-sm shrink-0 text-black">
      {svg ? (
        <div
          className="h-[65%] w-[65%] [&_svg]:w-full [&_svg]:h-full"
          dangerouslySetInnerHTML={{ __html: scopeSvgIds(svg, app.id) }}
        />
      ) : img ? (
        <img
          src={img}
          alt=""
          className="h-[65%] w-[65%] object-contain"
        />
      ) : (
        <span className="text-sm font-semibold text-gray-400">
          {label[0]}
        </span>
      )}
    </div>
  );
}
