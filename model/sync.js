import { existsSync } from "node:fs"
import { mkdir, rename, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { readJson, toLocalName, deriveDishName, encodePath, fileSize, fetchWithRetry } from "./util.js"

const MODEL_DIR = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = path.resolve(MODEL_DIR, "..")
const IMAGES_INDEX = path.join(PLUGIN_DIR, "data", "images.json")
const DISHES_INDEX = path.join(PLUGIN_DIR, "data", "dishes.json")
const RESOURCE_DIR = path.join(PLUGIN_DIR, "resources")
const IMAGE_DIR = path.join(RESOURCE_DIR, "image")
const SYNCED_INDEX = path.join(RESOURCE_DIR, "synced.json")

/** 首装全量同步的并发数 / 单图超时 / 重试次数（硬编） */
const SYNC_CONCURRENCY = 6
const FETCH_TIMEOUT = 15000
const FETCH_RETRY = 4


let syncPromise = null


function loadSource() {
  const raw = readJson(IMAGES_INDEX)
  // 新结构：required（必须集，随包/校验用）+ optional（冗余过程图，不校验）。
  // 兼容旧结构：images（全量）。两者均以 images 字段对外暴露。
  const list = raw?.required || raw?.images
  if (!raw || !Array.isArray(list) || !list.length)
    throw new Error("data/images.json 无效或为空")
  return { ...raw, images: list }
}

function loadSyncedStore() {
  const store = readJson(SYNCED_INDEX) || { images: [] }
  if (!Array.isArray(store.images)) return { images: [] }
  return store
}


/** 依次尝试的镜像前缀：jsDelivr CDN 优先，GitHub raw 兜底（实测 gitmirror 不可用） */
function buildMirrors(source) {
  const repo = source.source || "Anduin2017/HowToCook"
  const branch = source.branch || "master"
  const mirrors = [`https://cdn.jsdelivr.net/gh/${repo}@${branch}/`]
  if (source.base) mirrors.push(source.base)
  return mirrors
}

function prevMap() {
  const map = new Map()
  for (const rec of loadSyncedStore().images) {
    if (rec && typeof rec.path === "string") map.set(rec.path, rec)
  }
  return map
}

/** 所有图片均已落盘且大小与索引一致 */
export function isImageReady() {
  try {
    const source = loadSource()
    const map = prevMap()
    for (const img of source.images) {
      const rec = map.get(img.path)
      if (!rec) return false
      if (fileSize(path.join(IMAGE_DIR, rec.local_file)) !== rec.size) return false
    }
    return true
  } catch {
    return false
  }
}

async function fetchImage(mirrors, srcPath) {
  const p = encodePath(srcPath)
  return fetchWithRetry(mirrors.map((m) => m + p), { timeout: FETCH_TIMEOUT, retry: FETCH_RETRY })
}

async function syncOne(img, mirrors, prev, dishNames) {
  const localFile = toLocalName(img.path, deriveDishName(img.path, dishNames))
  const target = path.join(IMAGE_DIR, localFile)
  if (img.builtin) {
    const size = fileSize(target)
    if (!size) throw new Error("本地预置图缺失")
    return { path: img.path, local_file: localFile, size }
  }
  const reuse = prev.get(img.path)
  if (reuse) {
    const local = path.join(IMAGE_DIR, reuse.local_file)
    if (fileSize(local) === reuse.size && reuse.size === img.size) return reuse
  }
  const buf = await fetchImage(mirrors, img.path)
  const tmp = target + ".tmp"
  await writeFile(tmp, buf)
  await rename(tmp, target)
  return { path: img.path, local_file: localFile, size: buf.length }
}

async function runSync(log) {
  const source = loadSource()
  const mirrors = buildMirrors(source)
  await mkdir(IMAGE_DIR, { recursive: true })

  const dishes = readJson(DISHES_INDEX, [])
  const dishNames = new Set((Array.isArray(dishes) ? dishes : dishes.dishes || []).map(d => d.name))
  const prev = prevMap()
  const total = source.images.length
  const records = new Array(total)
  let next = 0
  let done = 0
  let failed = 0

  const workers = Array.from({ length: Math.min(SYNC_CONCURRENCY, total) }, async () => {
    while (next < total) {
      const index = next++
      const img = source.images[index]
      try {
        records[index] = await syncOne(img, mirrors, prev, dishNames)
      } catch (err) {
        failed++
        log?.warn?.(`[今天吃什么] 菜图同步跳过：${img.path} :: ${err.message}`)
      }
      done++
      if (done % 100 === 0) log?.info?.(`[今天吃什么] 菜图同步进度：${done}/${total}`)
    }
  })
  await Promise.all(workers)

  const valid = records.filter(Boolean)
  if (!valid.length) throw new Error("所有菜图下载失败")

  const store = {
    base: source.base,
    mirrors,
    synced_at: new Date().toISOString(),
    count: valid.length,
    images: valid,
  }
  const tmpFile = SYNCED_INDEX + ".tmp"
  await mkdir(RESOURCE_DIR, { recursive: true })
  await writeFile(tmpFile, `${JSON.stringify(store, null, 2)}\n`, "utf8")
  await rename(tmpFile, SYNCED_INDEX)


  log?.info?.(`[今天吃什么] 菜图同步完成：${valid.length}/${total}（失败 ${failed}）`)
  return store
}

/** 幂等：已就绪直接返回，否则触发一次全量同步 */
export function ensureImagesSynced(opts = {}) {
  const log = opts.logger || globalThis.logger || null
  if (isImageReady()) return Promise.resolve(loadSyncedStore())
  syncPromise ??= runSync(log).finally(() => {
    syncPromise = null
  })
  return syncPromise
}

/** 源相对路径 -> 本地绝对路径，不存在返回 null */
export function getLocalImage(srcPath) {
  if (!srcPath) return null
  const rec = loadSyncedStore().images.find((r) => r && r.path === srcPath)
  if (!rec) return null
  const file = path.join(IMAGE_DIR, rec.local_file)
  return existsSync(file) ? file : null
}