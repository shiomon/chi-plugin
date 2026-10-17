import fs from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")

/** 内置 emoji 字体目录（resources/fonts），做法长图零外网依赖 */
const FONT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "resources", "fonts")

/**
 * 本地 @font-face 规则：用 file:// 绝对路径引用 woff2 字体。
 * font-display:block 阻塞渲染等待字体加载（兼容 shotium 无 beforeScreenshot 钩子）。
 * usedCP 从本文件源码自动提取所有 emoji codepoint，模板新增 emoji 时自动覆盖。
 */
const FONT_CSS = (() => {
  const selfSource = fs.readFileSync(fileURLToPath(import.meta.url), "utf8")
  const usedCP = new Set()
  for (const ch of selfSource) {
    const cp = ch.codePointAt(0)
    if (cp >= 0x1f000 || (cp >= 0x2600 && cp <= 0x27ff) || (cp >= 0x2b00 && cp <= 0x2bff))
      usedCP.add(cp)
  }
  const inRange = (cp, s) => {
    for (const part of s.split(",")) {
      const m = part.trim().match(/U\+([0-9a-fA-F]+)(?:-([0-9a-fA-F]+))?/i)
      if (!m) continue
      const lo = parseInt(m[1], 16)
      const hi = m[2] ? parseInt(m[2], 16) : lo
      if (cp >= lo && cp <= hi) return true
    }
    return false
  }
  try {
    const css = fs.readFileSync(path.join(FONT_DIR, "emoji.css"), "utf8")
    const fontDirUrl = pathToFileURL(FONT_DIR).href + "/"
    const lines = []
    for (const line of css.trim().split("\n")) {
      const rangeMatch = line.match(/unicode-range:([^;]+)/)
      if (!rangeMatch || ![...usedCP].some(cp => inRange(cp, rangeMatch[1]))) continue
      lines.push(line
        .replace(/font-display:\s*swap/, "font-display:block")
        .replace(/url\("__FONT_DIR__\/([^"]+\.woff2)"\)/g, (_, name) =>
          `url("${fontDirUrl}${name}")`))
    }
    return lines.join("\n")
  } catch (e) {
    console.warn("[今天吃什么] emoji 字体加载失败，emoji 可能渲染为 tofu：", e?.message || e)
    return ""
  }
})()

/** 难度满星数（硬编） */
const DIFF_MAX = 5
/** 参考资料标题展示上限（硬编） */
const REF_TITLE_MAX = 60

function stars(n) {
  const k = Math.max(0, Math.min(DIFF_MAX, Number(n) || 0))
  return "★".repeat(k) + "☆".repeat(DIFF_MAX - k)
}

function clip(s, n) {
  const t = String(s ?? "")
  return t.length > n ? `${t.slice(0, n)}…` : t
}

/** 合并去重 refs 与 video，得到参考资料列表 */
function refList(dish) {
  const out = []
  const seen = new Set()
  const push = (r) => {
    if (!r || !r.url || seen.has(r.url)) return
    seen.add(r.url)
    out.push({ text: r.text || r.url, url: r.url })
  }
  for (const r of dish.refs || []) push(r)
  push(dish.video)
  return out
}

/** 生成做法长图 HTML：菜图卡片浮于渐变底图之上，食材 / 步骤 / 小贴士 / 参考资料在下 */
export function generateRecipeHTML(dish, imageUrl = "") {
  const hero = imageUrl
    ? `<div class="hero"><img src="${esc(imageUrl)}" alt=""></div>`
    : ""
  const ings = (dish.ingredients || []).map((i) => `<span class="ing">${esc(i)}</span>`).join("")
  let stepNo = 0
  const steps = (dish.steps || [])
    .map((s) => {
      const title = s.title ? `<div class="step-title">${esc(s.title)}</div>` : ""
      const items = (s.items || []).map((t) => {
        const text = typeof t === "string" ? t : t.text
        if (typeof t === "object" && t.sub) {
          return `<div class="step-sub"><p class="step-text">${esc(text)}</p></div>`
        }
        return `<div class="step"><div class="step-no">${++stepNo}</div><div class="step-body"><p class="step-text">${esc(text)}</p></div></div>`
      }).join("")
      return `${title}${items}`
    })
    .join("")

  const calcArr = dish.calc || []
  const calc = calcArr.length
    ? `<div class="card"><h2>📊 计算</h2><ul class="calc">${calcArr
        .map((c) => `<li>${esc(c)}</li>`).join("")}</ul></div>`
    : ""


  const meta = []
  if (typeof dish.calories === "number") meta.push(`<span class="m">🔥 ${dish.calories} 大卡</span>`)
  if (dish.time) meta.push(`<span class="m">⏱ ${esc(dish.time)}</span>`)
  if (dish.difficulty) meta.push(`<span class="m">难度 ${stars(dish.difficulty)}</span>`)
  const metaRow = meta.length ? `<div class="meta">${meta.join("")}</div>` : ""

  const tipsArr = dish.tips || []
  const tips = tipsArr.length
    ? `<div class="card"><h2>💡 附加内容</h2><ul class="tips">${tipsArr
        .map((t) => `<li>${esc(t)}</li>`)
        .join("")}</ul></div>`
    : ""

  const refs = refList(dish)
  const refCard = refs.length
    ? `<div class="card"><h2>📎 参考资料</h2><ul class="refs">${refs
        .map((r) => `<li><span class="ref-t">${esc(clip(r.text, REF_TITLE_MAX))}</span><span class="ref-u">${esc(r.url)}</span></li>`)
        .join("")}</ul></div>`
    : ""

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
${FONT_CSS}
* { margin:0; padding:0; box-sizing:border-box; }
body { margin:0; }
#container { width:720px; padding:20px 20px 32px; background:linear-gradient(135deg,#fdfcf8 0%,#e9f0e6 100%); font-family:'Noto Sans CJK SC','Noto Sans SC','Noto Color Emoji','Microsoft YaHei','PingFang SC',sans-serif; color:#222; }
.hero { position:relative; border-radius:20px; overflow:hidden; box-shadow:0 0 30px rgba(0,0,0,0.20); margin-bottom:18px; }
.hero img { width:100%; display:block; max-height:420px; object-fit:cover; }

.head { padding:0 4px; }
.title { font-size:34px; font-weight:800; line-height:1.25; }
.cat { display:inline-block; margin-top:10px; font-size:14px; color:#b3541e; background:#fdece0; border-radius:20px; padding:3px 14px; }
.meta { display:flex; flex-wrap:wrap; gap:10px; margin-top:14px; }
.m { font-size:15px; color:#55684d; background:rgba(255,255,255,0.85); border-radius:12px; padding:6px 14px; box-shadow:0 0 4px rgba(0,0,0,0.05); }
.card { background:#fff; margin-top:16px; border-radius:18px; padding:18px 22px; box-shadow:0 0 20px rgba(0,0,0,0.16); }
.card h2 { font-size:20px; font-weight:800; margin-bottom:14px; }
.ings { display:flex; flex-wrap:wrap; gap:8px; }
.ing { background:#eef4ea; color:#3d6b34; border-radius:8px; padding:5px 12px; font-size:15px; }
.step { display:flex; gap:12px; margin-bottom:14px; }
.step:last-child { margin-bottom:0; }
.step-sub { padding-left:38px; margin-bottom:14px; }
.step-sub:last-child { margin-bottom:0; }
.step-no { flex:0 0 26px; width:26px; height:26px; border-radius:50%; background:#3d6b34; color:#fff; font-size:14px; font-weight:700; display:flex; align-items:center; justify-content:center; margin-top:1px; }
.step-title { font-weight:700; font-size:16px; margin-bottom:4px; }
.step-text { font-size:16px; line-height:1.75; color:#333; }

.tips, .calc { padding-left:20px; }
.tips li, .calc li { font-size:15px; line-height:1.75; margin-bottom:6px; color:#333; }
.tips li:last-child, .calc li:last-child { margin-bottom:0; }
.refs { list-style:none; }
.refs li { margin-bottom:10px; }
.refs li:last-child { margin-bottom:0; }
.ref-t { display:block; font-size:15px; line-height:1.6; color:#333; }
.ref-u { display:block; font-size:12px; color:#8a9aa8; margin-top:2px; word-break:break-all; }
</style>
</head>
<body>
<div id="container">
${hero}
<div class="head"><div class="title">${esc(dish.name)}</div><span class="cat">${esc(dish.categoryName || "")}</span>${metaRow}</div>
<div class="card"><h2>🧂 必备原料和工具</h2><div class="ings">${ings}</div></div>
${calc}
<div class="card"><h2>🍳 操作</h2>${steps}</div>
${tips}
${refCard}
</div>
</body>
</html>`
}
/** 帮助指令列表（index.js buildHelpText 与 generateHelpHTML 共用） */
export const HELP_ROWS = [
  ["吃什么", "随机来一道"],

  ["吃什么 分类", "查看分类列表"],
  ["吃什么 <分类名>", "按分类随机，如「肉菜」"],
  ["吃什么 <菜名>", "查看指定菜，如「宫保鸡丁」"],
  ["吃什么 做法 <菜名>", "查看该菜做法图"],
  ["吃什么 视频 <菜名>", "该菜 B 站视频"],
]

/** 生成帮助卡片 HTML：指令列表 + 管理员指令 + 备注 */
export function generateHelpHTML() {
  const adminRows = [
    ["吃什么 同步", "预演官网同步（不写入）"],
    ["吃什么 同步 写入", "同步并写入（跳过不符合的菜）"],
    ["吃什么 补图 <菜名>", "补齐缺图菜（发图+指令）"],
    ["吃什么 清理", "删除不符合的菜"],
  ]
  const renderRows = (rs) =>
    rs
      .map(
        ([l, r]) =>
          `<div class="row"><span class="cmd">${esc(l)}</span><span class="desc">${esc(r)}</span></div>`,
      )
      .join("")
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
${FONT_CSS}
* { margin:0; padding:0; box-sizing:border-box; }
body { margin:0; }
#container { width:640px; padding:20px 20px 32px; background:linear-gradient(135deg,#fdfcf8 0%,#e9f0e6 100%); font-family:'Noto Sans CJK SC','Noto Sans SC','Noto Color Emoji','Microsoft YaHei','PingFang SC',sans-serif; color:#222; }
.head { padding:0 4px 14px; }
.title { font-size:30px; font-weight:800; }
.sub { font-size:14px; color:#8a9aa8; margin-top:6px; }
.card { background:#fff; margin-top:14px; border-radius:18px; padding:18px 22px; box-shadow:0 0 20px rgba(0,0,0,0.16); }
.card h2 { font-size:20px; font-weight:800; margin-bottom:14px; }
.row { display:flex; align-items:baseline; gap:14px; padding:9px 0; border-bottom:1px dashed #eef2ec; }
.row:last-child { border-bottom:none; }
.cmd { flex:0 0 auto; min-width:200px; font-size:16px; font-weight:700; color:#3d6b34; white-space:nowrap; }
.desc { flex:1; font-size:15px; color:#555; }
.tag { display:inline-block; font-size:12px; color:#b3541e; background:#fdece0; border-radius:10px; padding:2px 8px; margin-left:8px; vertical-align:middle; }
.foot { margin-top:14px; font-size:13px; color:#8a9aa8; line-height:1.7; padding:0 4px; }
</style>
</head>
<body>
<div id="container">
<div class="head"><div class="title">🍽 吃什么 · 帮助</div><div class="sub">今天吃什么？随机来一道，或按分类/菜名挑～</div></div>
<div class="card"><h2>📖 指令</h2>${renderRows(HELP_ROWS)}</div>
<div class="card"><h2>🔧 管理员<span class="tag">仅主人</span></h2>${renderRows(adminRows)}</div>
<div class="foot">官机环境下上述操作也可点击按钮完成；「同步」从 HowToCook 官网拉取并校验图/简介/做法三项，不符合则阻止写入，「清理」可一键删除不符合的菜。</div>
</div>
</body>
</html>`
}