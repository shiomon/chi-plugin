// 方案A：官网同步模块
// 运行期零联网：本模块仅在「吃什么同步」指令下被调用。
// 默认 dry-run（只拉取+对比+校验，不改任何文件）；传 apply=true 才写回数据与图。
import { readFileSync } from "node:fs"
import { mkdir, rename, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { readJson, toLocalName, deriveDishName, encodePath, fileSize, fetchWithRetry } from "./util.js"
import { parseCore, pickImage, CAT_NAMES, baseNameNoExt } from "./parse.js"

const MODEL_DIR = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = path.resolve(MODEL_DIR, "..")
const DATA_DIR = path.join(PLUGIN_DIR, "data")
const RESOURCE_DIR = path.join(PLUGIN_DIR, "resources")
const IMAGE_DIR = path.join(RESOURCE_DIR, "image")
const DISHES_INDEX = path.join(DATA_DIR, "dishes.json")
const IMAGES_INDEX = path.join(DATA_DIR, "images.json")
const XCF_MAP = path.join(DATA_DIR, "xcf_map.json")
const SYNCED_INDEX = path.join(RESOURCE_DIR, "synced.json")

const REPO = "Anduin2017/HowToCook"
const BRANCH = "master"
const RAW = `https://raw.githubusercontent.com/${REPO}/${BRANCH}/`
const TREE_API = `https://api.github.com/repos/${REPO}/git/trees/${BRANCH}?recursive=1`
const MIRRORS = [`https://cdn.jsdelivr.net/gh/${REPO}@${BRANCH}/`, RAW]

const CONCURRENCY = 6
const FETCH_TIMEOUT = 20000
const FETCH_RETRY = 4

async function backupFile(file) {
  try {
    await writeFile(`${file}.bak`, readFileSync(file))
  } catch (err) {
    logger?.warn?.(`[今天吃什么] 备份失败 ${file}：${err.message}`)
  }
}

async function atomicWrite(file, obj) {
  const tmp = file + ".tmp"
  await writeFile(tmp, `${JSON.stringify(obj, null, 2)}\n`, "utf8")
  await rename(tmp, file)
}

/** 同名菜去重（上游存在同名 md，如 dishes/soup/陈皮排骨汤.md 与 同名子目录版）：
 *  优先有图；其次「目录版」md（md 位于同名子目录内）；再按 md 字典序稳定取一。 */
function dedupeByName(list) {
  const scoreOf = (d) => {
    let s = 0
    if (d.image) s += 100
    const dir = path.posix.dirname(d.md)
    if (path.posix.basename(dir) === baseNameNoExt(d.md)) s += 10
    return s
  }
  const best = new Map()
  for (const d of list) {
    const cur = best.get(d.name)
    if (!cur || scoreOf(d) > scoreOf(cur) || (scoreOf(d) === scoreOf(cur) && d.md < cur.md)) {
      best.set(d.name, d)
    }
  }
  return [...best.values()]
}

async function fetchText(srcPath) {
  const urls = MIRRORS.map((base) => base + encodePath(srcPath))
  const buf = await fetchWithRetry(urls, { timeout: FETCH_TIMEOUT, retry: MIRRORS.length })
  return buf.toString("utf8")
}

async function pool(items, limit, fn, onProgress) {
  const ret = new Array(items.length)
  let i = 0
  let done = 0
  async function worker() {
    while (i < items.length) {
      const k = i++
      ret[k] = await fn(items[k], k)
      done++
      if (done % 25 === 0) onProgress?.(`进度 ${done}/${items.length}`)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return ret
}

async function fetchTree() {
  const res = await fetch(TREE_API, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
    headers: { "User-Agent": "node", Accept: "application/vnd.github+json" },
  })
  if (!res.ok) throw new Error(`GitHub tree API HTTP ${res.status}`)
  const json = await res.json()
  if (!Array.isArray(json.tree)) throw new Error("tree 响应异常")
  return json.tree
}

/** 按新的 required 列表补齐本地图片，返回 synced 记录（含全部 required） */
async function materializeImages(required, prevSynced) {
  const prev = new Map((prevSynced?.images || []).map((r) => [r.path, r]))
  const dishes = readJson(DISHES_INDEX, [])
  const dishNames = new Set((Array.isArray(dishes) ? dishes : dishes.dishes || []).map(d => d.name))
  await mkdir(IMAGE_DIR, { recursive: true })
  const records = new Array(required.length)
  const failed = []
  let i = 0
  async function worker() {
    while (i < required.length) {
      const idx = i++
      const img = required[idx]
      const localFile = toLocalName(img.path, deriveDishName(img.path, dishNames))
      const target = path.join(IMAGE_DIR, localFile)
      try {
        if (img.builtin) {
          const size = fileSize(target)
          if (!size) throw new Error("本地预置图缺失")
          records[idx] = { path: img.path, local_file: localFile, size }
          continue
        }
        const reuse = prev.get(img.path)
        if (reuse && fileSize(path.join(IMAGE_DIR, reuse.local_file)) === reuse.size && reuse.size === img.size) {
          records[idx] = reuse
          continue
        }
        const buf = await fetchWithRetry([MIRRORS[0] + encodePath(img.path)], { timeout: FETCH_TIMEOUT }).catch(() =>
          fetchWithRetry([RAW + encodePath(img.path)], { timeout: FETCH_TIMEOUT })
        )
        const tmp = target + ".tmp"
        await writeFile(tmp, buf)
        await rename(tmp, target)
        records[idx] = { path: img.path, local_file: localFile, size: buf.length }
      } catch (err) {
        failed.push(`${img.path} :: ${err.message}`)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, required.length) }, worker))
  const valid = records.filter(Boolean)
  return { records: valid, failed }
}

/** 校验菜品完整性：图 / 简介(≥20字) / 做法(步骤+食材) 三项缺一不可 */
export function validateDishes(dishes) {
  const noImage = dishes.filter((d) => !d.image).map((d) => d.name)
  const noDesc = dishes.filter((d) => !d.desc || d.desc.length < 20).map((d) => d.name)
  const noRecipe = dishes
    .filter((d) => !(d.steps && d.steps.length) || !(d.ingredients && d.ingredients.length))
    .map((d) => d.name)
  const invalid = [...new Set([...noImage, ...noDesc, ...noRecipe])]
  return { noImage, noDesc, noRecipe, invalid }
}

/**
 * 同步官网。
 * @param {{apply?:boolean, onProgress?:(m:string)=>void, logger?:any}} opts
 * @returns 同步报告 + 重建结果
 */
export async function syncFromUpstream(opts = {}) {
  const apply = opts.apply === true
  const onProgress = typeof opts.onProgress === "function" ? opts.onProgress : null
  const log = opts.logger || globalThis.logger || null

  // 1. 上游仓库树
  const tree = await fetchTree()
  const blobs = tree.filter((t) => t.type === "blob")
  const dishMd = blobs.filter(
    (t) => /^dishes\/([^/]+)\/.+\.md$/i.test(t.path) && !/^dishes\/template\//.test(t.path)
  )
  const imageBlobs = blobs.filter(
    (t) => /\.(jpe?g|png|webp)$/i.test(t.path) && !/^dishes\/template\//.test(t.path)
  )
  const imgByDir = {}
  for (const im of imageBlobs) {
    const d = path.posix.dirname(im.path)
    ;(imgByDir[d] ||= []).push(im)
  }

  const prevDishes = readJson(DISHES_INDEX)?.dishes || []
  const prevNames = new Set(prevDishes.map((d) => d.name))
  const xcfMap = readJson(XCF_MAP)?.map || {}

  // 2. 解析全部 md
  const errors = []
  const rawDishes = []
  await pool(dishMd, CONCURRENCY, async (t) => {
    const cat = t.path.split("/")[1]
    try {
      const md = await fetchText(t.path)
      const core = parseCore(md)
      const img = pickImage(t.path, core.name, imgByDir)
      let image = img ? img.path : null
      if (!image && xcfMap[core.name]) image = xcfMap[core.name].path
      rawDishes.push({
        id: cat + "/" + core.name,
        md: t.path,
        name: core.name,
        category: cat,
        categoryName: CAT_NAMES[cat] || cat,
        difficulty: core.difficulty,
        calories: core.calories,
        time: core.time,
        desc: core.desc,
        ingredients: core.ingredients,
        steps: core.steps,
        tips: core.tips,
        video: core.video,
        refs: core.refs,
        image,
      })
    } catch (err) {
      errors.push(t.path + " :: " + err.message)
    }
  }, onProgress)

  let dishes = dedupeByName(rawDishes)
  dishes.sort(
    (a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name, "zh")
  )
  let catList = Object.keys(CAT_NAMES)
    .map((k) => ({ key: k, name: CAT_NAMES[k], count: dishes.filter((d) => d.category === k).length }))
    .filter((c) => c.count > 0)
  let withImage = dishes.filter((d) => d.image).length

  // 3. 生成 required / optional
  const usedOfficial = new Set(
    dishes.map((d) => d.image).filter((p) => p && !String(p).startsWith("xcf/"))
  )
  const xcfEntries = []
  for (const [name, v] of Object.entries(xcfMap)) {
    if (dishes.some((d) => d.name === name && d.image === v.path))
      xcfEntries.push({ path: v.path, size: v.size, builtin: true })
  }
  const required = [
    ...xcfEntries,
    ...imageBlobs.filter((i) => usedOfficial.has(i.path)).map((i) => ({ path: i.path, size: i.size })),
  ]
  const optional = imageBlobs
    .filter((i) => !usedOfficial.has(i.path))
    .map((i) => ({ path: i.path, size: i.size }))

  // 4. 校验：图 / 简介 / 做法 三项缺一不可
  const { noImage, noDesc, noRecipe, invalid } = validateDishes(dishes)
  const added = dishes.filter((d) => !prevNames.has(d.name)).map((d) => d.name)
  const nowNames = new Set(dishes.map((d) => d.name))
  const removed = [...prevNames].filter((n) => !nowNames.has(n))

  const report = {
    total: dishes.length,
    withImage,
    noImage,
    noDesc,
    noRecipe,
    invalid,
    added,
    removed,
    requiredCount: required.length,
    optionalCount: optional.length,
    errors,
    applied: false,
    blocked: false,
    failedImages: [],
    skipped: [],
  }

  if (!apply) {
    onProgress?.(`预演完成：${dishes.length} 菜 / 有图 ${withImage}`)
    return report
  }
  if (invalid.length) {
    onProgress?.(`跳过 ${invalid.length} 道不符合项，只写入符合的菜`)
    const invalidSet = new Set(invalid)
    dishes = dishes.filter((d) => !invalidSet.has(d.name))
    report.skipped = invalid
    withImage = dishes.filter((d) => d.image).length
    catList = Object.keys(CAT_NAMES)
      .map((k) => ({ key: k, name: CAT_NAMES[k], count: dishes.filter((d) => d.category === k).length }))
      .filter((c) => c.count > 0)
    report.total = dishes.length
    report.withImage = withImage
  }

  // 5. 写回：先补齐图，再原子替换数据文件
  onProgress?.("补齐菜图…")
  const prevSynced = readJson(SYNCED_INDEX)
  const { records, failed } = await materializeImages(required, prevSynced)
  report.failedImages = failed

  const ts = new Date().toISOString().replace(/[:.]/g, "-")
  await mkdir(DATA_DIR, { recursive: true })
  await backupFile(DISHES_INDEX)
  await backupFile(IMAGES_INDEX)

  const newDishes = {
    version: ts.slice(0, 10),
    source: REPO,
    branch: BRANCH,
    categories: catList,
    total: dishes.length,
    withImage,
    dishes,
  }
  const newImages = {
    version: ts.slice(0, 10),
    source: REPO,
    branch: BRANCH,
    base: RAW,
    count: required.length,
    optional_count: optional.length,
    required,
    optional,
  }
  const newSynced = {
    base: RAW,
    mirrors: MIRRORS,
    synced_at: new Date().toISOString(),
    count: records.length,
    images: records,
  }


  await atomicWrite(DISHES_INDEX, newDishes)
  await atomicWrite(IMAGES_INDEX, newImages)
  await atomicWrite(SYNCED_INDEX, newSynced)

  report.applied = true
  log?.info?.(`[今天吃什么] 官网同步完成：${dishes.length} 菜 / 有图 ${withImage} / 失败图 ${failed.length}`)
  onProgress?.(`同步完成：${dishes.length} 菜 / 有图 ${withImage}`)
  return report
}

/**
 * 清理不符合菜：删除缺图/缺简介/缺做法的菜，重算统计并原子写回 dishes.json。
 * @param {{logger?:any}} opts
 */
export async function cleanupInvalid(opts = {}) {
  const log = opts.logger || globalThis.logger || null
  const raw = readJson(DISHES_INDEX)
  if (!raw || !Array.isArray(raw.dishes)) throw new Error("dishes.json 不可读")
  const before = raw.dishes.length
  const beforeWithImage = raw.withImage
  const { invalid } = validateDishes(raw.dishes)
  if (!invalid.length) {
    return { removed: [], totalBefore: before, totalAfter: before, withImageBefore: beforeWithImage, withImageAfter: raw.withImage, applied: false }
  }
  const invalidSet = new Set(invalid)
  const dishes = raw.dishes.filter((d) => !invalidSet.has(d.name))
  const countMap = {}
  for (const d of dishes) countMap[d.category] = (countMap[d.category] || 0) + 1
  const categories = (raw.categories || []).map((c) => ({ ...c, count: countMap[c.key] || 0 }))
  const withImage = dishes.filter((d) => d.image).length
  const ts = new Date().toISOString().replace(/[:.]/g, "-")
  await mkdir(DATA_DIR, { recursive: true })
  await backupFile(DISHES_INDEX)
  const newObj = { ...raw, categories, total: dishes.length, withImage, dishes }
  await atomicWrite(DISHES_INDEX, newObj)
  log?.info?.(`[今天吃什么] 清理不符合菜 ${invalid.length} 道，剩余 ${dishes.length} 道`)
  return { removed: invalid, totalBefore: before, totalAfter: dishes.length, withImageBefore: beforeWithImage, withImageAfter: withImage, applied: true }
}