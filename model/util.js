// chi-plugin 公共工具函数（sync.js / update.js 共用）
import { createHash } from "node:crypto"
import { readFileSync, statSync } from "node:fs"
import path from "node:path"

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(readFileSync(file, "utf8"))
  } catch {
    return fallback
  }
}

export function toLocalName(srcPath, dishName) {
  const ext = (path.extname(srcPath) || ".jpg").toLowerCase()
  if (dishName) return dishName + ext
  return createHash("sha1").update(srcPath).digest("hex").slice(0, 16) + ext
}

export function deriveDishName(srcPath, dishNames) {
  const parts = srcPath.split("/")
  const fname = parts[parts.length - 1].replace(/\.[^.]+$/, "")
  if (dishNames.has(fname)) return fname
  const dir = parts.length > 1 ? parts[parts.length - 2] : null
  if (dir && dishNames.has(dir)) return dir
  return null
}

export function encodePath(srcPath) {
  return srcPath.split("/").map(encodeURIComponent).join("/")
}

export function fileSize(file) {
  try {
    return statSync(file).size
  } catch {
    return 0
  }
}
/**
 * 带重试与超时的 fetch：多镜像轮换、指数退避。
 * sync.js / update.js 共用，消除两处近乎相同的 retry 循环。
 */
export async function fetchWithRetry(urls, { timeout = 15000, retry = 4, headers = {} } = {}) {
  const list = Array.isArray(urls) ? urls : [urls]
  let lastErr
  for (let attempt = 1; attempt <= retry; attempt++) {
    const url = list[(attempt - 1) % list.length]
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(timeout),
        headers: { "User-Agent": "node", ...headers },
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const buf = Buffer.from(await res.arrayBuffer())
      if (!buf.length) throw new Error("空响应")
      return buf
    } catch (err) {
      lastErr = err
      if (attempt < retry) await new Promise((r) => setTimeout(r, 1000 * attempt))
    }
  }
  throw lastErr
}