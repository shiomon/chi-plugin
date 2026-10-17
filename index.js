import plugin from "../../lib/plugins/plugin.js"
import { readFileSync, writeFileSync, mkdirSync, renameSync, rmSync } from "node:fs"
import { readFile } from "node:fs/promises"

import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import puppeteer from "../../lib/puppeteer/puppeteer.js"
import { ensureImagesSynced, getLocalImage } from "./model/sync.js"
import { syncFromUpstream, cleanupInvalid } from "./model/update.js"
import { generateRecipeHTML, generateHelpHTML, HELP_ROWS } from "./view/recipe.js"
import { CATEGORY_ALIASES } from "./model/parse.js"

const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url))
const dishesPath = path.join(PLUGIN_DIR, "data", "dishes.json")
const indexPath = path.join(PLUGIN_DIR, "data", "index.json")

/** 主指令：发「吃什么」或「今天吃什么」都可以（硬编正则） */
const CMD_REG = "^[#/]?(?:今天吃什么|吃什么)(?:\\s*(.+?))?\\s*$"
/** 从消息中剥离指令前缀（硬编） */
const CMD_STRIP = /^[#/\s]*(?:今天吃什么|吃什么)/
/** 按钮回调发送的指令词（硬编） */
const CMD = "吃什么"

/** 非 QQBot（无按钮）时，结果末尾附的可用指令提示（硬编） */
const NON_QQ_TIP_BASE = `可发：${CMD}`
const NON_QQ_TIP_DISH = `${NON_QQ_TIP_BASE}丨${CMD} 做法 <菜名>丨${CMD} 视频 <菜名>丨${CMD} 分类`
const NON_QQ_TIP_RECIPE = `${NON_QQ_TIP_BASE}丨${CMD} 视频 <菜名>丨${CMD} 分类`

/** B 站搜索前缀（硬编） */
const BILI_SEARCH = "https://search.bilibili.com/all?keyword="
/** 做法长图模板与渲染名（硬编） */
const RECIPE_TPL = path.join(PLUGIN_DIR, "resources", "recipe.html")
const RECIPE_RENDER_NAME = "吃什么/做法"

/** 单条文本上限，超出截断（硬编） */
const MAX_TEXT = 1600
/** 简介截取到第一个句号；无句号时按此上限兜底截断（硬编） */
const DESC_MAX = 120
/** 插件加载后延迟多久开始后台同步菜图（硬编，毫秒） */
const SYNC_START_DELAY = 5000
/** 运行期是否自动联网同步菜图（硬编）：方案A 要求运行期零联网，默认关闭；联网同步改走「吃什么同步」指令 */
const AUTO_SYNC = false

/** 随机开头词（硬编） */
const OPENERS = ["推荐", "尝尝这个", "来点这个", "安利", "安排上", "私藏"]


const LIST_KEYWORDS = ["分类", "列表", "菜单", "有哪些", "list"]
/** 「帮助」指令关键字（硬编） */
const HELP_KEYWORDS = ["帮助", "help", "说明", "?", "？"]

function loadIndex() {
  return JSON.parse(readFileSync(path.join(PLUGIN_DIR, "data", "index.json"), "utf8"))
}

function loadDish(id) {
  return JSON.parse(readFileSync(path.join(PLUGIN_DIR, "data", "dishes", `${id}.json`), "utf8"))
}

const INDEX_FIELDS = ["id", "name", "category", "categoryName", "image", "difficulty", "calories", "time", "desc", "md", "imageSource"]

function splitDishes() {
  const raw = JSON.parse(readFileSync(dishesPath, "utf8"))
  const index = {
    categories: raw.categories,
    dishes: raw.dishes.map(d => {
      const o = {}
      for (const k of INDEX_FIELDS) o[k] = d[k]
      return o
    })
  }
  const indexTmp = indexPath + ".tmp"
  writeFileSync(indexTmp, JSON.stringify(index, null, 2) + "\n")
  renameSync(indexTmp, indexPath)
  const dir = path.join(PLUGIN_DIR, "data", "dishes")
  const tmpDir = dir + ".tmp"
  rmSync(tmpDir, { recursive: true, force: true })
  mkdirSync(tmpDir, { recursive: true })
  for (const d of raw.dishes) {
    const fp = path.join(tmpDir, `${d.id}.json`)
    mkdirSync(path.dirname(fp), { recursive: true })
    writeFileSync(fp, JSON.stringify(d, null, 2) + "\n")
  }
  rmSync(dir, { recursive: true, force: true })
  renameSync(tmpDir, dir)
}

function randomOf(arr) {
  return arr[Math.floor(Math.random() * arr.length)]
}

/** B 站搜索该菜名 */
function biliUrl(name) {
  return BILI_SEARCH + encodeURIComponent(name)
}

function matchCategory(arg, data) {
  if (!arg) return null
  const cats = (data || loadIndex()).categories
  for (const c of cats) {
    if (arg === c.key || arg === c.name) return c.key
  }
  for (const [key, aliases] of Object.entries(CATEGORY_ALIASES)) {
    if (aliases.includes(arg)) return key
  }
  return null
}

function findDish(name, data) {
  const n = (name || "").trim()
  if (!n) return null
  const dishes = (data || loadIndex()).dishes
  const exact = dishes.find((d) => d.name === n)
  if (exact) return exact
  const cands = dishes.filter((d) => d.name.includes(n))
  return cands.length ? cands.sort((a, b) => a.name.length - b.name.length)[0] : null
}

/** 按 id（分类/菜名）或菜名定位一道菜 */
function findByKey(key, data) {
  const k = (key || "").trim()
  if (!k) return null
  const d = data || loadIndex()
  const byId = d.dishes.find((x) => x.id === k)
  return byId || findDish(k, d)
}

/** 简介只取第一段（截到第一个句号为止；无句号时兜底截断） */
function briefDesc(desc) {
  const t = String(desc || "").trim()
  if (!t) return ""
  const i = t.indexOf("。")
  if (i >= 0) return t.slice(0, i + 1)
  return t.length > DESC_MAX ? `${t.slice(0, DESC_MAX)}…` : t
}

/** 精简卡片：随机开头词 + 菜名 → 分类引用块 → 简介引用块 */
function buildCardText(dish) {
  const lines = [`${randomOf(OPENERS)}「${dish.name}」`, `> 分类：${dish.categoryName}`]
  const d = briefDesc(dish.desc)
  if (d) lines.push(`> ${d}`)
  const text = lines.join("\n")
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text
}

/** 估算显示宽度：CJK/全角字符算 2、其余算 1（用于文本两列对齐） */
function eastWidth(s) {
  let w = 0
  for (const ch of s)
    w += /[\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1
  return w
}

function buildCategoryList(isQQ, data) {
  const d = data || loadIndex()
  const cats = d.categories
  const half = Math.ceil(cats.length / 2)
  const label = (c) => `${c.name}（${c.count}）`
  const pairs = []
  for (let i = 0; i < half; i++) {
    const right = cats[i + half]
    pairs.push([label(cats[i]), right ? label(right) : ""])
  }
  const colW = Math.max(...pairs.map(([l]) => eastWidth(l)))
  const rows = pairs.map(([l, r]) => `${l}${" ".repeat(colW - eastWidth(l) + 2)}${r}`)
  const lines = [`共收录 ${d.dishes.length} 道菜谱，${cats.length} 个分类：`, ""]
  if (!isQQ) {
    lines.push(`> 可发「${CMD} (分类名)」随一道，`, `> 也可具体菜：如「${CMD} 宫保鸡丁」`, ">")
  }
  lines.push(...rows.map((r) => `> ${r}`))
  return lines.join("\n")
}

/** 独立帮助文案：列出全部可用指令（两列对齐，硬编） */
function buildHelpText() {
  const colW = Math.max(...HELP_ROWS.map(([l]) => eastWidth(l)))
  const body = HELP_ROWS.map(([l, r]) => `${l}${" ".repeat(colW - eastWidth(l) + 2)}${r}`)
  return [`【${CMD}帮助】`, ...body, "官机环境下上述操作也可点击按钮完成～"].join("\n")
}

/** 分类列表的 QQBot 键盘：前两行各 4 个分类，第三行「随机 + 剩余分类」（硬编） */
const CATS_PER_ROW = 4
const CATS_HEAD_ROWS = 2
function buildCategoryKeyboard(data) {
  const cats = (data || loadIndex()).categories
  const head = CATS_PER_ROW * CATS_HEAD_ROWS
  const rows = []
  for (let i = 0; i < head; i += CATS_PER_ROW) {
    rows.push(cats.slice(i, i + CATS_PER_ROW).map((c) => ({ text: c.name, callback: `${CMD} ${c.name}` })))
  }
  const tail = cats.slice(head).map((c) => ({ text: c.name, callback: `${CMD} ${c.name}` }))
  rows.push([{ text: "吃什么", callback: CMD }, ...tail])
  return segment.button(...rows)
}

function isQQBot(e) {
  return e?.bot?.version?.id === "QQBot" || e?.adapter_id === "QQBot"
}

function at(e) {
  return e.group_id ? [segment.at(e.user_id), "\n"] : []
}

/** 出菜后的 QQBot 键盘：随机 / 做法(渲染图) / 分类 */
function buildKeyboard(dish) {
  return segment.button([
    { text: "吃什么", callback: CMD },
    { text: "做法", callback: `${CMD} 做法 ${dish.id}` },
    { text: "分类", callback: `${CMD} 分类` },
  ])
}

/** 做法结果的 QQBot 键盘：随机 / 视频 / 分类（已在做法图内，无需「做法」按钮） */
function buildRecipeKeyboard(dish) {
  return segment.button([
    { text: "吃什么", callback: CMD },
    { text: "视频", link: biliUrl(dish.name) },
    { text: "分类", callback: `${CMD} 分类` },
  ])
}

/** 截断数组前 n 项为顿号分隔字符串（replySync / replyCleanup 共用） */
function cut(arr, n = 12) {
  return arr.slice(0, n).join("、") + (arr.length > n ? " …" : "")
}

/** 统一处理 e.reply 返回的错误日志（消除 5 处重复判断） */
function checkReplyError(res) {
  if (res?.error?.length)
    logger?.warn?.(`[今天吃什么] 回复失败：${Array.isArray(res.error) ? res.error.join(" | ") : res.error}`)
}

/** puppeteer 截图前等待 @font-face 字体加载完毕，避免 emoji 渲染为 tofu/X。
 *  shotium support_script:false 不支持 beforeScreenshot 钩子，此函数仅 puppeteer 生效；
 *  shotium 下已用 base64 data URI 内联字体规避（见 view/recipe.js FONT_CSS）。 */
const WAIT_FONTS = async (page) => { await page.evaluate(() => document.fonts.ready) }


export class TodayEat extends plugin {
  constructor() {
    super({
      name: "吃什么",
      dsc: "随机推荐一道菜，附成菜图、简介与菜谱做法",
      event: "message",
      priority: 500,
      rule: [{ reg: CMD_REG, fnc: "eatWhat" }],
    })
  }

  async init() {
    if (!AUTO_SYNC) return
    setTimeout(() => {
      ensureImagesSynced()
        .then(() => logger?.info?.("[今天吃什么] 菜图库就绪"))
        .catch((err) => logger?.warn?.(`[今天吃什么] 菜图库同步失败：${err.message}`))
    }, SYNC_START_DELAY)
  }

  async eatWhat(e) {
    const msg = (e.msg || "").trim()
    const arg = msg.replace(CMD_STRIP, "").trim()

    const syncArg = arg.match(/^(?:同步|更新)\s*(写入)?\s*$/)
    if (syncArg) return this.replySync(e, syncArg[1] === "写入")

    if (arg === "清理" || arg === "删除不符合") return this.replyCleanup(e)

    const fixImgArg = arg.match(/^补图\s*(.+?)\s*$/)
    if (fixImgArg) return this.replyFixImage(e, fixImgArg[1])

    const recipeArg = arg.match(/^做法\s*(.+?)\s*$/)
    if (recipeArg) {
      const d = findByKey(recipeArg[1])
      if (d) return this.replyRecipe(e, d)
      return this.replyText(e, `没有找到「${recipeArg[1]}」的做法～`)
    }

    const videoArg = arg.match(/^视频\s*(.+?)\s*$/)
    if (videoArg) return this.replyVideo(e, videoArg[1])

    if (arg === "做法" || arg === "视频")
      return this.replyText(e, `「${arg}」要带上菜名哦，如：「${CMD} ${arg} 宫保鸡丁」`)

    if (HELP_KEYWORDS.includes(arg)) return this.replyHelp(e)

    if (arg === "") {
      const pool = loadIndex().dishes
      if (!pool.length) return this.replyText(e, "菜谱数据为空，请管理员发「吃什么 同步」更新～")
      return this.replyDish(e, randomOf(pool))
    }
    if (LIST_KEYWORDS.includes(arg)) return this.replyCategoryList(e)

    const data = loadIndex()
    const catKey = matchCategory(arg, data)
    if (catKey) {
      const pool = data.dishes.filter((d) => d.category === catKey)
      if (pool.length) return this.replyDish(e, randomOf(pool))
    }

    const dish = findDish(arg, data)
    if (dish) return this.replyDish(e, dish)

    return this.replyText(
      e,
      `没有找到「${arg}」这道菜～\n发「${CMD}」随便来一道，或发「${CMD} 分类」看可用分类`
    )
  }

  async replyText(e, text) {
    const res = await e.reply(text)
    checkReplyError(res)
    return true
  }

  /** 「同步 [写入]」：拉取 HowToCook 官网重建数据/图（仅管理员；默认预演不写入） */
  async replySync(e, apply) {
    if (!e.isMaster) return this.replyText(e, `「${CMD} 同步」仅限管理员使用～`)
    await this.replyText(
      e,
      apply
        ? "开始从 HowToCook 官网同步并写入…（约 1 分钟，请稍候）"
        : "开始从 HowToCook 官网同步（预演，不写入）…（约 1 分钟，请稍候）"
    )
    let report
    try {
      report = await syncFromUpstream({ apply, logger })
    } catch (err) {
      logger?.error?.(`[今天吃什么] 官网同步失败：${err.message}`)
      return this.replyText(e, `同步失败：${err.message}`)
    }
    const lines = [`【官网同步 · ${apply ? "已写入" : "预演"}】`]
    lines.push(`菜品 ${report.total} 道｜有图 ${report.withImage} 道`)
    lines.push(`新增 ${report.added.length}｜移除 ${report.removed.length}`)
    if (report.added.length) lines.push(`新增菜：${cut(report.added)}`)
    lines.push(`缺图 ${report.noImage.length}${report.noImage.length ? "：" + cut(report.noImage) : ""}`)
    lines.push(`缺简介 ${report.noDesc.length}${report.noDesc.length ? "：" + cut(report.noDesc) : ""}`)
    lines.push(`缺做法 ${report.noRecipe.length}${report.noRecipe.length ? "：" + cut(report.noRecipe) : ""}`)
    if (report.invalid.length) lines.push(`不符合 ${report.invalid.length}：${cut(report.invalid)}`)
    if (report.errors.length) lines.push(`解析错误 ${report.errors.length}`)
    if (apply) lines.push(`图片下载失败 ${report.failedImages.length}`)
    lines.push(`必须图 ${report.requiredCount}｜冗余图 ${report.optionalCount}`)
    if (report.skipped?.length) {
      lines.push(`\n已跳过 ${report.skipped.length} 道不符合的菜：${cut(report.skipped)}`)
      lines.push(`如需收录：发「${CMD} 补图 <菜名>」并附带一张图片`)
    }
    if (!apply) lines.push(`\n确认无误后发「${CMD} 同步 写入」执行写入`)
    if (report.applied) {
      lines.push(`\n已备份旧数据到 data/dishes.json.bak`)
      lines.push(`如数据异常：将 .bak 覆盖回 dishes.json 后重启即可恢复`)
      lines.push(`详细步骤见 data/恢复说明.txt`)
      splitDishes()
    }
    return this.replyText(e, lines.join("\n"))
  }

  /** 「清理」：删除 dishes.json 中不符合（缺图/缺简介/缺做法）的菜（仅管理员） */
  async replyCleanup(e) {
    if (!e.isMaster) return this.replyText(e, `「${CMD} 清理」仅限管理员使用～`)
    await this.replyText(e, "开始清理不符合菜（缺图/缺简介/缺做法）…")
    let r
    try {
      r = await cleanupInvalid({ logger })
    } catch (err) {
      logger?.error?.(`[今天吃什么] 清理失败：${err.message}`)
      return this.replyText(e, `清理失败：${err.message}`)
    }
    if (!r.applied) return this.replyText(e, `【清理】当前 ${r.totalAfter} 道菜全部符合，无需清理～`)
    splitDishes()
    const lines = [`【清理 · 已写入】`]
    lines.push(`删除 ${r.removed.length} 道：${cut(r.removed)}`)
    lines.push(`菜品 ${r.totalBefore} → ${r.totalAfter}｜有图 ${r.withImageBefore} → ${r.withImageAfter}`)
    lines.push(`\n已备份旧数据到 data/dishes.json.bak`)
    lines.push(`如误删：将 .bak 覆盖回 dishes.json 后重启即可恢复`)
    lines.push(`详细步骤见 data/恢复说明.txt`)
    return this.replyText(e, lines.join("\n"))
  }

  /** 「补图 <菜名>」：管理员发图片+指令，自动补齐缺图菜（仅管理员） */
  async replyFixImage(e, name) {
    if (!e.isMaster) return this.replyText(e, `「${CMD} 补图」仅限管理员使用～`)
    const data = loadIndex()
    const dish = findByKey(name, data)
    if (!dish) return this.replyText(e, `未找到「${name}」，请确认菜名或先同步后补图～`)
    const imgSeg = e.message?.find((m) => m.type === "image")
    const imgUrl = imgSeg?.url || (Array.isArray(e.img) && e.img[0]) || null
    if (!imgUrl) return this.replyText(e, `请附带一张图片再发指令～\n用法：[图片] ${CMD} 补图 ${dish.name}`)
    try {
      const res = await fetch(imgUrl, { signal: AbortSignal.timeout(30000) })
      if (!res.ok) throw new Error(`下载图片失败 HTTP ${res.status}`)
      const buf = Buffer.from(await res.arrayBuffer())
      if (!buf.length) throw new Error("图片数据为空")
      const fileName = dish.name + ".jpg"
      const imgDir = path.join(PLUGIN_DIR, "resources", "image")
      mkdirSync(imgDir, { recursive: true })
      const imgTmp = path.join(imgDir, fileName + ".tmp")
      writeFileSync(imgTmp, buf)
      renameSync(imgTmp, path.join(imgDir, fileName))
      const syncedPath = path.join(PLUGIN_DIR, "resources", "synced.json")
      const synced = JSON.parse(readFileSync(syncedPath, "utf8"))
      const customPath = `custom/${dish.name}.jpg`
      const idx = synced.images.findIndex((i) => i && i.path === customPath)
      const entry = { path: customPath, local_file: fileName, size: buf.length }
      if (idx >= 0) synced.images[idx] = entry
      else synced.images.push(entry)
      const syncTmp = syncedPath + ".tmp"
      writeFileSync(syncTmp, JSON.stringify(synced, null, 2) + "\n")
      renameSync(syncTmp, syncedPath)

      const raw = JSON.parse(readFileSync(dishesPath, "utf8"))
      const d = raw.dishes.find((x) => x.name === dish.name)
      if (d) d.image = customPath
      raw.withImage = raw.dishes.filter((x) => x.image).length
      const dishTmp = dishesPath + ".tmp"
      writeFileSync(dishTmp, JSON.stringify(raw, null, 2) + "\n")
      renameSync(dishTmp, dishesPath)
      splitDishes()
      return this.replyText(e, [
        `【补图 · 已完成】`,
        `菜名：${dish.name}`,
        `图片：${customPath} → ${fileName}（${(buf.length / 1024).toFixed(1)}KB）`,
        `当前有图：${raw.withImage} / ${raw.dishes.length} 道`,
      ].join("\n"))
    } catch (err) {
      logger?.error?.(`[今天吃什么] 补图失败：${err.message}`)
      return this.replyText(e, `补图失败：${err.message}`)
    }
  }

  /** 「视频 <菜名>」：回复该菜的 B 站搜索链接（非 QQBot 无链接按钮时用） */
  async replyVideo(e, key) {
    const d = findByKey(key)
    if (!d) return this.replyText(e, `没有找到「${key}」这道菜～`)
    const res = await e.reply([...at(e), `「${d.name}」视频：${biliUrl(d.name)}`])
    checkReplyError(res)
    return true
  }

  /** 分类列表：文本 + 每个分类的按钮（每行 4 个） */
  async replyCategoryList(e) {
    try {
      const data = loadIndex()
      const seg = [buildCategoryList(isQQBot(e), data)]
      if (isQQBot(e)) seg.push("\n", buildCategoryKeyboard(data))
      const res = await e.reply([...at(e), ...seg])
      checkReplyError(res)
      return true
    } catch (err) {
      logger?.error?.(`[今天吃什么] 分类列表失败：${err.message}`)
      return this.replyText(e, `分类列表生成失败：${err.message}`)
    }
  }

  async replyDish(e, dish) {
    let text = buildCardText(dish)
    let local = null
    try {
      local = getLocalImage(dish.image)
    } catch (err) {
      logger?.warn?.(`[今天吃什么] 取本地菜图失败：${err.message}`)
    }
    if (!local && dish.image)
      text += "\n\n（这道菜的成菜图本地缺失，管理员可发「吃什么同步」补齐）"

    const seg = []
    if (local) {
      let img
      try {
        img = segment.image(await readFile(local))
      } catch (err) {
        logger?.warn?.(`[今天吃什么] 读取菜图失败：${err.message}`)
        img = segment.image(pathToFileURL(local).href)
      }
      seg.push(img, "\n")
    }
    seg.push(text)
    if (isQQBot(e)) seg.push("\n", buildKeyboard(dish))
    else seg.push("\n\n", NON_QQ_TIP_DISH)
    const res = await e.reply([...at(e), ...seg])
    checkReplyError(res)
    return true
  }

  /** 渲染做法长图：菜图 + 食材 + 步骤 + 小贴士，拼成一张长图 */
  async replyRecipe(e, dish) {
    dish = loadDish(dish.id)
    let imageUrl = ""
    try {
      const local = getLocalImage(dish.image)
      if (local) imageUrl = pathToFileURL(local).href
    } catch (err) {
      logger?.warn?.(`[今天吃什么] 取本地菜图失败：${err.message}`)
    }

    let img = null
    const shotId = `recipe-${dish.id.replace(/[^\w\u4e00-\u9fa5]/g, "_")}`.slice(0, 80)
    try {
      img = await puppeteer.screenshot(RECIPE_RENDER_NAME, {
        tplFile: RECIPE_TPL,
        saveId: shotId,
        imgType: "png",
        pageGotoParams: { waitUntil: "load" },
        beforeScreenshot: WAIT_FONTS,
        html: generateRecipeHTML(dish, imageUrl),
      })
    } catch (err) {
      logger?.error?.(`[今天吃什么] 做法图渲染失败：${err.message}`)
    }

    if (!img) return this.replyText(e, `「${dish.name}」的做法图生成失败了，稍后再试试～`)

    const res = await e.reply([...at(e), img, "\n", isQQBot(e) ? buildRecipeKeyboard(dish) : NON_QQ_TIP_RECIPE])
    checkReplyError(res)
    return true
  }

  /** 渲染帮助卡片图；渲染失败降级纯文本 */
  async replyHelp(e) {
    let img = null
    try {
      img = await puppeteer.screenshot("吃什么/帮助", {
        tplFile: RECIPE_TPL,
        saveId: "help",
        imgType: "png",
        pageGotoParams: { waitUntil: "load" },
        beforeScreenshot: WAIT_FONTS,
        html: generateHelpHTML(),
      })
    } catch (err) {
      logger?.error?.(`[今天吃什么] 帮助图渲染失败：${err.message}`)
    }
    if (!img) return this.replyText(e, buildHelpText())
    const seg = [img]
    if (isQQBot(e)) seg.push("\n", segment.button([
      { text: "吃什么", callback: CMD },
      { text: "分类", callback: `${CMD} 分类` },
    ]))
    const res = await e.reply([...at(e), ...seg])
    checkReplyError(res)
    return true
  }
}

export const apps = { TodayEat }