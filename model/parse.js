// HowToCook md 解析器（插件内置版）
// 来源：.htc-build/lib_parse.mjs + build_data.js 的 pickImage，产品化进插件，供官网同步使用。
import path from "node:path"

export const CAT_NAMES = {
  meat_dish: "肉菜",
  vegetable_dish: "素菜",
  staple: "主食",
  aquatic: "水产",
  breakfast: "早餐",
  soup: "汤羹",
  drink: "饮品",
  dessert: "甜点",
  "semi-finished": "半成品",
  condiment: "调料",
}

export const CATEGORY_ALIASES = {
  meat_dish: ["肉菜", "荤菜", "肉", "肉类"],
  vegetable_dish: ["素菜", "蔬菜", "青菜", "素"],
  staple: ["主食", "饭", "米饭", "面", "面条", "粉"],
  aquatic: ["水产", "海鲜", "河鲜", "鱼", "虾", "蟹"],
  breakfast: ["早餐", "早饭"],
  soup: ["汤羹", "汤", "煲汤"],
  drink: ["饮品", "饮料", "喝的", "喝"],
  dessert: ["甜点", "甜品", "甜"],
  "semi-finished": ["半成品", "预制"],
  condiment: ["调料", "酱料", "蘸料"],
}

export function baseNameNoExt(p) {
  return path.posix.basename(p).replace(/\.[^.]+$/, "")
}

/** 从同目录候选图中选主图：优先同名 → 成品/摆盘 → 第一张 */
export function pickImage(mdPath, dishName, imgByDir) {
  const dir = path.posix.dirname(mdPath)
  const mdBase = baseNameNoExt(mdPath)
  const isSubdir = path.posix.basename(dir) === mdBase
  let cands
  if (isSubdir) {
    cands = imgByDir[dir] || []
  } else {
    cands = (imgByDir[dir] || []).filter((c) => {
      const b = baseNameNoExt(c.path)
      return b === mdBase || b === dishName
    })
  }
  if (!cands.length) return null
  const same = cands.find((c) => {
    const b = baseNameNoExt(c.path)
    return b === dishName || b === mdBase
  })
  if (same) return same
  const hint = cands.find((c) => /成品|摆盘|预览|完成/.test(c.path))
  if (hint) return hint
  return cands[0]
}

function cleanLine(s) {
  return String(s)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\\\*/g, "×")
    .replace(/\*/g, "")
    .replace(/`/g, "")
    .replace(/^\s*#{1,6}\s*/, "")
    .replace(/^\s*[-*+]\s*/, "")

    .trim()
}

function isJunk(s) {
  if (!s) return true
  if (/^[-*#>`|~=]+$/.test(s)) return true
  if (/^!\[/.test(s)) return true
  return false
}

function sections(body) {
  const out = {}
  const re = /^##\s+(.+?)\s*$/gm
  const marks = []
  let m
  while ((m = re.exec(body))) marks.push({ title: m[1].trim(), start: re.lastIndex, headStart: m.index })
  for (let i = 0; i < marks.length; i++) {
    const start = marks[i].start
    const stop = i + 1 < marks.length ? marks[i + 1].headStart : body.length
    out[marks[i].title] = body.slice(start, stop)
  }
  return out
}

function cleanList(text) {
  return text
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s && !/^!\[/.test(s) && !/^```/.test(s))
    .map((s) => cleanLine(s))
    .filter((s) => !isJunk(s))
}

// 规则（对齐官方 md）：
//   - ``` 围栏代码块整段跳过
//   - 图片行 `![...](...)` 跳过，其后的图片说明丢弃
//   - 引用块行 `>` 跳过（引用说明不属于步骤）
//   - ### 及以上小标题 -> 新分组
//   - 有序列表 `1.` -> 新步骤项
//   - 无序列表 `- * +`（后须有空白）-> 子项并到上一步骤（以「；」连接）
//   - 其它散文行：仅当紧邻上一步骤（中间无空行、且非图片说明）时作为续行并入；
//     以空行分隔的独立散文段（说明/作者注等）一律丢弃，不并入步骤
function parseSteps(opText) {
  const groups = []
  let cur = { title: null, items: [] }
  let inCode = false
  let blankSince = true
  let afterImage = false
  const push = () => {
    if (cur.title || cur.items.length) groups.push(cur)
  }
  for (const raw of opText.split("\n")) {
    const line = raw.trim()
    if (/^```/.test(line)) {
      inCode = !inCode
      blankSince = false
      continue
    }
    if (inCode) continue
    if (!line) {
      blankSince = true
      continue
    }
    if (/^>/.test(line)) {
      blankSince = false
      continue
    }
    if (/^!\[/.test(line)) {
      afterImage = true
      blankSince = false
      continue
    }
    const gm = line.match(/^#{3,}\s*(.+)$/)
    if (gm) {
      push()
      const t = cleanLine(gm[1])
      cur = { title: t || null, items: [] }
      blankSince = true
      afterImage = false
      continue
    }
    if (/^#{1,2}\s/.test(line)) {
      blankSince = false
      continue
    }
    const li = line.match(/^\d+\s*[.、)]\s*(.+)$/)
    if (li) {
      const c = cleanLine(li[1])
      if (c && !isJunk(c)) cur.items.push({ sub: false, text: c })
      blankSince = false
      afterImage = false
      continue
    }
    const sub = line.match(/^[-*+]\s+(.+)$/)
    if (sub) {
      const c = cleanLine(sub[1])
      if (c && !isJunk(c)) cur.items.push({ sub: true, text: c })
      blankSince = false
      afterImage = false
      continue
    }
    if (!afterImage && !blankSince && cur.items.length) {
      const c = cleanLine(line)
      if (c && !isJunk(c)) cur.items[cur.items.length - 1].text += c
    }
    blankSince = false
  }
  push()
  return groups.filter((g) => g.items.length)
}

const FIXED_TAIL = /如果您遵循本指南/

function extractDesc(body) {
  const firstH2 = body.search(/^##\s/m)
  const introBlock = firstH2 >= 0 ? body.slice(0, firstH2) : body
  const descLines = introBlock
    .split("\n")
    .map((s) => s.trim())
    .filter(
      (s) => s && !/^!\[/.test(s) && !/预估烹饪难度/.test(s) && !/预估卡路里/.test(s)
    )
  return descLines
    .join(" ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\\\*/g, "×")
    .replace(/\*/g, "")
    .trim()
}

function extractTime(desc) {
  const timeM = desc.match(
    /(?:总共|全程|大约|约需|预计|耗时|约|需)\s*(?:需要)?\s*(\d+(?:\.\d+)?)\s*(?:[-~–—到至]\s*(\d+(?:\.\d+)?))?\s*(分钟|小时|天)/
  )
  return timeM ? timeM[1] + (timeM[2] ? "-" + timeM[2] : "") + timeM[3] : null
}

function extractVideo(refs) {
  return (
    refs.find((l) =>
      /(bilibili\.com|b23\.tv|youtube\.com|youtu\.be|douyin\.com|ixigua\.com|xiachufang\.com|weibo\.com|zhihu\.com|v\.qq\.com|youku\.com|iqiyi\.com)/i.test(
        l.url
      )
    ) || null
  )
}

/** 解析单篇 md 正文，返回菜对象（不含 id/image，由调用方补） */
export function parseCore(md) {
  const titleM = md.match(/^#\s+(.+?)\s*$/m)
  let name = titleM ? titleM[1].trim() : ""
  name = name.replace(/的做法$/, "").trim()
  const body = md.replace(/^#\s+.+$/m, "")

  const diffM = body.match(/预估烹饪难度：\s*(★+)/)
  const difficulty = diffM ? diffM[1].length : null
  const calM = body.match(/预估卡路里：\s*(\d+)\s*大卡/)
  const calories = calM ? parseInt(calM[1], 10) : null

  const desc = extractDesc(body)
  const time = extractTime(desc)

  const sec = sections(body)
  const ingredients = cleanList(sec["必备原料和工具"] || "")
  const steps = parseSteps(sec["操作"] || "")
  const calc = cleanList(sec["计算"] || "")

  const addRaw = sec["附加内容"] || ""
  const refs = [...addRaw.matchAll(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g)].map((x) => ({
    text: x[1].trim(),
    url: x[2].trim(),
  }))
  const tips = addRaw
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s && !FIXED_TAIL.test(s) && !/^!\[/.test(s) && !/^```/.test(s))
    .map((s) => cleanLine(s))
    .map((s) => s.replace(/\[[^\]]*\]\(https?:\/\/[^)\s]+\)/g, "").trim())
    .filter((s) => s && !isJunk(s))

  const video = extractVideo(refs)
  return {
    name,
    difficulty,
    calories,
    time,
    desc,
    ingredients,
    steps,
    calc,
    tips,
    video: video ? { text: video.text, url: video.url } : null,
    refs: refs.length ? refs : undefined,
  }
}