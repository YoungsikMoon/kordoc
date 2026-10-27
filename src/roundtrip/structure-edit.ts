/**
 * HWPX 패치 구조 편집 — 문단 추가·삭제와 항목 부호에 맞춘 서식 갈아입히기.
 *
 * 견본 문서를 그대로 두고 내용만 새로 쓰는 편집("이 서식대로 새 문서")은 문단 수가 원본과 달라진다. 추가 문단은
 * 같은 항목 부호(□·○·-·※·1.·가. …)를 단 원본 문단을 복제해 글만 바꾼다: 문단 모양·글자 모양·run 구성이 견본 그대로라
 * 새 줄이 옆 줄과 같은 들여쓰기·글꼴·굵기로 나온다. 같은 부호 문단이 없으면 바로 앞(없으면 뒤) 본문 문단을 복제한다.
 * 삭제는 개체(표·그림·구역 정의·컨트롤)가 없는 최상위 문단만 통째로 지우고, 개체가 있으면 글만 비운다.
 */

import { scanSectionXml, findElementEnd, applySplices, buildParagraphSplices, markerRunSplices, paraTText, type ScanParagraph, type ScanTable, type SectionScan, type SpliceEdit } from "./source-map.js"
import { minimalTextSplices, parseEmphasis, alignToRaw } from "./inline-edit.js"
import { isColorEmphasis, isRealStrikeShape } from "../hwpx/styles.js"
import { summarize, alignUnits, type MdUnit } from "./markdown-units.js"
import type { IRBlock, PatchSkip } from "../types.js"

const LINESEG_RE = /<(\w+:)?linesegarray\b[^>]*?(?:\/>|>[\s\S]*?<\/\1linesegarray>)/g

/** 문단을 지우면 함께 사라지는 개체·조판 정의 — 이것이 든 문단은 통째로 지우지 않는다 */
const OBJECT_RE = /<(?:\w+:)?(?:secPr|ctrl|tbl|pic|container|rect|ellipse|arc|polygon|curve|line|connectLine|textart|ole|equation|chart|video|drawText|switch)\b/

/** 같은 부류로 보는 항목 부호 — 원문자·이응·동그라미는 한 부류, 줄표 계열도 한 부류 */
const SYMBOL_FAMILY: Record<string, string> = {
  "○": "○", "ㅇ": "○", "◦": "○", "❍": "○", "o": "○", "●": "●",
  "-": "-", "–": "-", "―": "-", "—": "-", "－": "-",
  "·": "ㆍ", "ㆍ": "ㆍ", "∙": "ㆍ", "•": "ㆍ",
  "□": "□", "■": "■", "◇": "◇", "◆": "◆", "▣": "▣", "※": "※", "*": "*",
  "▶": "▶", "▷": "▷", "►": "▶", "▸": "▸", "▪": "▪", "✓": "✓", "⇒": "⇒", "↳": "↳",
}

/**
 * 문단 평문의 항목 부호 부류: "○", "N.", "K)", "①" … 부호가 없으면 "". 헤딩이면 "h2:" 처럼 수준을 앞에 붙인다.
 * 기호 부호는 뒤에 공백이 있어야 부호로 본다(가림 처리된 "*****" 같은 글은 부호가 아니다).
 */
export function markerClass(plain: string, headingLevel?: number): string {
  const t = plain.replace(/^\s+/, "")
  let cls = ""
  const sym = SYMBOL_FAMILY[t[0]]
  if (sym && (t.length === 1 || /\s/.test(t[1]))) cls = sym
  else if (/^붙\s*임(?:\s|$)/.test(t)) cls = "붙임"
  else if (/^[❶-❿]/.test(t)) cls = "❶"
  else if (/^[①-⑳]/.test(t)) cls = "①"
  else if (/^[㉮-㉻]/.test(t)) cls = "㉮"
  else if (/^[Ⅰ-Ⅻ][.\s]/.test(t)) cls = "Ⅰ."
  else {
    const m = /^(\(?)(\d{1,2}|[가나다라마바사아자차카타파하])([.)])(?=\s|$)/.exec(t)
    if (m) cls = `${m[1]}${/\d/.test(m[2]) ? "N" : "K"}${m[3]}`
  }
  return headingLevel ? `h${headingLevel}:${cls}` : cls
}

/** 섹션 루트 바로 아래(최상위) 문단 범위 — 문서 순서 */
export function topLevelParagraphs(xml: string): Array<{ start: number; end: number }> {
  const root = /<(?:\w+:)?sec\b[^>]*>/.exec(xml)
  if (!root) return []
  const out: Array<{ start: number; end: number }> = []
  let pos = root.index + root[0].length
  const pRe = /<(?:\w+:)?p(?=[\s>/])/y
  for (;;) {
    const lt = xml.indexOf("<", pos)
    if (lt < 0 || xml.startsWith("</", lt)) break
    const end = findElementEnd(xml, lt)
    if (end < 0) break
    pRe.lastIndex = lt
    if (pRe.test(xml)) out.push({ start: lt, end })
    pos = end
  }
  return out
}

/** pos 를 품은 최상위 문단 */
export function containingTopParagraph(tops: Array<{ start: number; end: number }>, pos: number): { start: number; end: number } | undefined {
  let lo = 0, hi = tops.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (tops[mid].end <= pos) lo = mid + 1
    else if (tops[mid].start > pos) hi = mid - 1
    else return tops[mid]
  }
  return undefined
}

/** 통째로 지워도 되는 문단 — 개체·구역 정의가 없고 쪽·단 나눔으로 시작하지 않는다 */
export function isRemovableParagraph(fragment: string): boolean {
  const open = fragment.slice(0, fragment.indexOf(">") + 1)
  if (/\b(?:pageBreak|columnBreak)="1"/.test(open)) return false
  return !OBJECT_RE.test(fragment.slice(open.length))
}

/** 갈아입힌 복제본에 원래 문단의 쪽·단 나눔을 옮긴다 — 새 쪽을 여는 문단의 부호만 바꿨는데 쪽 나눔이 사라지지 않게 */
export function keepBreaks(clone: string, targetOpen: string): string {
  let out = clone
  for (const attr of ["pageBreak", "columnBreak"]) {
    if (!new RegExp(`\\b${attr}="1"`).test(targetOpen)) continue
    out = new RegExp(`^<[^>]*?\\b${attr}=`).test(out)
      ? out.replace(new RegExp(`^(<[^>]*?)\\b${attr}="0"`), `$1${attr}="1"`)
      : out.replace(/^<([\w:]+)/, `<$1 ${attr}="1"`)
  }
  return out
}

/** 서식을 빌려 줄 원본 문단 */
export interface Donor {
  cls: string
  /** 원본 유닛 순번 — 가까운 견본을 고르는 기준 */
  unitIdx: number
  sectionIndex: number
  para: ScanParagraph
  /** 원본 문단의 IR 평문과 서식 조각 (글 치환 좌표) */
  plain: string
  segs: string[]
  /** 조각마다 강조 표지 안인지 (parseEmphasis marks) */
  marks?: boolean[]
}

/**
 * 견본 복제의 강조 글자 모양 — marked 는 파서가 마크다운 표지로 내는 굵게·기울임·밑줄·취소선, emphasis 는 거기에 색·음영
 * (isColorEmphasis, 견본 모드와 같은 기준)을 더한 것. plain 은 강조 글자 모양 → 강조만 뺀 짝: 나머지 속성(크기·글꼴·장평·
 * 자간 …)이 같은 강조 아닌 글자 모양, header 에 없으면 문서 본문에서 같은 크기로 글이 가장 많은 강조 아닌 글자 모양
 */
export interface CharStyles {
  marked: ReadonlySet<string>
  emphasis: ReadonlySet<string>
  plain: ReadonlyMap<string, string>
}

export function charStyles(headerXml: string, sectionXmls: string[]): CharStyles {
  const marked = new Set<string>(), emphasis = new Set<string>()
  const keyOf = new Map<string, string>(), heightOf = new Map<string, string>(), byKey = new Map<string, string>()
  for (const m of headerXml.matchAll(/<hh:charPr\b[^>]{0,4096}>/g)) {
    const id = /\bid="(\d{1,10})"/.exec(m[0])?.[1]
    if (!id) continue
    const close = headerXml.indexOf("</hh:charPr>", m.index!)
    const body = m[0].endsWith("/>") || close < 0 ? m[0] : headerXml.slice(m.index!, close)
    const strike = /<hh:strikeout\b[^>]{0,512}\bshape="(\w{1,20})"/.exec(body)?.[1]
    if (/<hh:(?:bold|italic)\b|\s(?:bold|italic)="(?:1|true)"/.test(body) || /<hh:underline\b[^>]{0,512}\btype="BOTTOM"/.test(body)
      || (strike !== undefined && isRealStrikeShape(strike))) marked.add(id)
    if (marked.has(id) || isColorEmphasis(m[0])) emphasis.add(id)
    // 짝 열쇠 — id 와 강조 속성(굵게·기울임·밑줄·취소선·글자색·음영)을 걷은 정의
    const key = body.replace(/\sid="\d{1,10}"/, "").replace(/\s(?:bold|italic|textColor|shadeColor)="[^"]{0,64}"/g, "")
      .replace(/<hh:(?:bold|italic|underline|strikeout)\b[^>]{0,512}>/g, "")
    keyOf.set(id, key)
    heightOf.set(id, /\bheight="(\d{1,10})"/.exec(m[0])?.[1] ?? "")
    if (!emphasis.has(id) && !byKey.has(key)) byKey.set(key, id)
  }
  // 문서 본문 기본 run — 같은 크기 강조 아닌 글자 모양 중 글이 가장 많은 것
  const used = new Map<string, number>()
  for (const xml of sectionXmls) {
    for (const m of xml.matchAll(/<(?:\w+:)?run\b[^>]{0,512}?\bcharPrIDRef="(\d{1,10})"[^>]{0,512}>\s*<(?:\w+:)?t>([^<]{1,4096})/g)) {
      if (!emphasis.has(m[1])) used.set(m[1], (used.get(m[1]) ?? 0) + m[2].length)
    }
  }
  const common = new Map<string, string>()
  for (const [id, n] of used) {
    const h = heightOf.get(id) ?? "", cur = common.get(h)
    if (cur === undefined || n > used.get(cur)!) common.set(h, id)
  }
  const plain = new Map<string, string>()
  for (const id of emphasis) {
    const p = byKey.get(keyOf.get(id)!) ?? common.get(heightOf.get(id)!)
    if (p) plain.set(id, p)
  }
  return { marked, emphasis, plain }
}

/**
 * 같은 부류에서 유닛 거리로 가장 가까운 견본 (같으면 앞 문단). near 는 자리 — 추가는 앞 유닛 순번 + 0.5,
 * 갈아입히기는 자기 순번(자기는 뺀다). 같은 부호라도 절마다 문단 모양이 달라(추진근거 ○ 과 개요 ○) 바로 옆 줄을 따른다
 */
export function pickDonor(donors: Donor[], cls: string, near: number, exclude?: number): Donor | undefined {
  let best: Donor | undefined
  for (const d of donors) {
    if (d.cls !== cls || d.unitIdx === exclude) continue
    if (!best || Math.abs(d.unitIdx - near) < Math.abs(best.unitIdx - near)) best = d
  }
  return best
}

/**
 * 견본 문단 XML 을 복제해 글만 새 글로 바꾼 문단 XML. 줄 배치 캐시는 지워(새 글은 다시 조판) 한컴이 변조 경고 없이 열고,
 * 쪽·단 나눔은 끈다(견본이 쪽 첫 문단이어도 복제본이 쪽을 넘기지 않게). 글을 넣을 자리가 없으면 null.
 *
 * 새 글의 강조 표지가 견본과 다르게 놓이면(newMarks·chars) 견본 강조 run 의 글자 모양을 강조 뺀 짝으로 바꿔 놓고 글을 넣은 뒤,
 * 새 글의 강조 조각만 견본 강조 글자 모양으로 감싼다 — 평문 "○ 서버 없음" 을 "○ **(현황)**" 견본으로 복제하면 새 글이
 * 굵은 소제목 run 에 들어 본문 전체가 굵게(통째로 굵은 파랑인 "- 안내" 견본이면 굵은 파랑) 나왔다
 */
export function cloneParagraphXml(xml: string, donor: Donor, newPlain: string, newSegs: string[], newMarks?: boolean[], chars?: CharStyles): string | null {
  const end = findElementEnd(xml, donor.para.start)
  if (end < 0) return null
  let frag = xml.slice(donor.para.start, end)
  if (!isRemovableParagraph(frag.replace(/\b(?:pageBreak|columnBreak)="1"/, ""))) return null
  const restyle = !!chars && !!newMarks && !!donor.marks
    && !(donor.segs.length === newSegs.length && donor.marks.every((m, i) => m === newMarks[i]))
  let markedCharPr = ""
  if (restyle) {
    let best = 0
    for (const m of frag.matchAll(/<(?:\w+:)?run\b[^>]{0,512}?\bcharPrIDRef="(\d{1,10})"[^>]{0,512}>/g)) {
      if (m[0].endsWith("/>") || !chars.marked.has(m[1])) continue
      const n = frag.slice(m.index! + m[0].length, findElementEnd(frag, m.index!)).replace(/<[^>]*>/g, "").replace(/\s/g, "").length
      if (n > best) { best = n; markedCharPr = m[1] }
    }
    frag = frag.replace(/(<(?:\w+:)?run\b[^>]{0,512}?\bcharPrIDRef=")(\d{1,10})"/g, (m, open: string, id: string) =>
      chars.plain.has(id) ? `${open}${chars.plain.get(id)}"` : m)
  }
  const para = scanSectionXml(frag, donor.sectionIndex).bodyParagraphs[0]
  if (!para || para.start !== 0) return null
  const splices: SpliceEdit[] | null = minimalTextSplices(para, frag, donor.plain, newPlain, donor.segs, newSegs)
    ?? markerRunSplices(para, frag, newPlain) ?? buildParagraphSplices(para, newPlain, frag)
  if (splices === null) return null
  const out = applySplices(frag, splices).replace(LINESEG_RE, "")
    .replace(/^(<[^>]*?)\bpageBreak="1"/, "$1pageBreak=\"0\"").replace(/^(<[^>]*?)\bcolumnBreak="1"/, "$1columnBreak=\"0\"")
  if (!restyle || !markedCharPr || !newMarks.some(Boolean)) return out
  return markedRuns(out, donor.sectionIndex, newPlain, newSegs, newMarks, markedCharPr) ?? out
}

/**
 * 복제본에서 강조 조각(marks)의 글을 따로 run(charPr)으로 가른다. 조각 앞뒤 빈칸은 둘레 run 에 남긴다.
 * 조각이 run 하나 안에 들지 않거나 글 좌표를 못 맞추면 null (강조 없이 둔다)
 */
function markedRuns(clone: string, sectionIndex: number, plain: string, segs: string[], marks: boolean[], charPr: string): string | null {
  const para = scanSectionXml(clone, sectionIndex).bodyParagraphs[0]
  const raw = para ? paraTText(para, clone) : null
  const pos = raw !== null ? alignToRaw(raw, plain) : null
  if (!para || !pos) return null
  const ts = para.tRanges.filter(t => !t.selfClosing)
  const P = para.runPrefix ? `${para.runPrefix}:` : ""
  /** t-도메인 위치 → 원문 위치와 그 hp:t 가 든 run 의 여는 태그 자리 (끝 위치는 hp:t 끝이어도 된다) */
  const locate = (r: number, isEnd: boolean): { at: number; run: number } | null => {
    let off = 0
    for (const t of ts) {
      const len = t.contentEnd - t.contentStart
      if (r < off + len || (isEnd && r === off + len)) return { at: t.contentStart + r - off, run: clone.lastIndexOf(`<${P}run`, t.contentStart) }
      off += len
    }
    return null
  }
  const splices: SpliceEdit[] = []
  for (let k = 0, a = 0; k < segs.length; a += segs[k].length, k++) {
    const lead = /^\s*/.exec(segs[k])![0].length, len = segs[k].trim().length
    if (!marks[k] || !len) continue
    const s = locate(pos[a + lead], false), e = locate(pos[a + lead + len - 1] + 1, true)
    if (!s || !e || s.run < 0 || s.run !== e.run) return null
    const runOpen = clone.slice(s.run, clone.indexOf(">", s.run) + 1)
    splices.push({ start: s.at, end: s.at, replacement: `</${P}t></${P}run>${runOpen.replace(/\bcharPrIDRef="\d{1,10}"/, `charPrIDRef="${charPr}"`)}<${P}t>` })
    splices.push({ start: e.at, end: e.at, replacement: `</${P}t></${P}run>${runOpen}<${P}t>` })
  }
  // 가른 자리가 hp:t 처음·끝이면 빈 run 이 남는다 — 지운다
  return applySplices(clone, splices).replace(/<(\w+:)?run\b[^>]{0,512}><\1t><\/\1t><\/\1run>/g, "")
}

// ─── 패치 적용 ───────────────────────────────────────

interface UnitLike { raw: string; kind: MdUnit["kind"]; blockIdx: number; fragment?: boolean; role?: "caption" }

/** 패처가 넘기는 원본·편집 좌표 (patcher.ts PatchCtx 와 같은 자료) */
export interface StructureEnv {
  origUnits: UnitLike[]
  origBlocks: IRBlock[]
  paraMap: Map<number, { para?: ScanParagraph; prefixStripped?: boolean; noteMarks?: string[] }>
  scans: SectionScan[]
  scanTables: ScanTable[]
  obTableOrdinals: Map<number, number>
  sectionSplices: SpliceEdit[][]
  skipped: PatchSkip[]
  /** 원본 유닛의 인라인 글 — 강조 표지는 남기고 헤딩 접두·링크만 벗긴 것 */
  inlineOf: (oi: number) => string
  /** 새 표 문단 XML (문단→표 변환과 같은 빌더) — 못 만들면 사유 */
  tableXml: (edited: MdUnit, outerParaPrId: number) => string | { reason: string }
  /** 견본 복제의 강조 글자 모양 (header 를 못 읽으면 없음 — 견본 run 그대로) */
  chars?: CharStyles
}

/** 편집 유닛 → 평문·서식 조각·헤딩 수준 */
function editedInline(raw: string): { plain: string; segs: string[]; marks: boolean[]; level?: number } {
  let text = raw.split("\n").map(l => l.trim()).filter(Boolean).join(" ")
  const hm = /^(#{1,6})\s+/.exec(text)
  if (hm) text = text.slice(hm[0].length)
  return { ...parseEmphasis(text), level: hm ? hm[1].length : undefined }
}

/**
 * 구조 편집기 — 패치 루프가 쌍마다 부른다. restyle 은 부호가 바뀐 수정, remove 는 삭제, insert 는 추가(바로 앞 원본 유닛 뒤에).
 * 셋 다 적용 건수를 돌려주고, 못 하면 사유를 skipped 에 남긴다
 */
export function createStructureEditor(env: StructureEnv) {
  const tops = env.scans.map(s => topLevelParagraphs(s.xml))
  const removed = env.scans.map(() => [] as Array<{ start: number; end: number }>)

  const loc = (oi: number): { sectionIndex: number; pos: number } | undefined => {
    const u = env.origUnits[oi]
    const block = env.origBlocks[u.blockIdx]
    if (!block) return undefined
    if (block.type === "table") {
      const ord = env.obTableOrdinals.get(u.blockIdx)
      const t = ord !== undefined && env.obTableOrdinals.size === env.scanTables.length ? env.scanTables[ord] : undefined
      return t ? { sectionIndex: t.sectionIndex, pos: t.start } : undefined
    }
    const para = env.paraMap.get(u.blockIdx)?.para
    return para ? { sectionIndex: para.sectionIndex, pos: para.start } : undefined
  }
  const topOf = (oi: number): { sectionIndex: number; start: number; end: number } | undefined => {
    const l = loc(oi)
    const top = l && containingTopParagraph(tops[l.sectionIndex], l.pos)
    return top && { sectionIndex: l.sectionIndex, ...top }
  }
  const isRemoved = (sectionIndex: number, pos: number): boolean => removed[sectionIndex].some(r => pos >= r.start && pos < r.end)
  const touched = (sectionIndex: number, start: number, end: number): boolean =>
    env.sectionSplices[sectionIndex].some(s => s.start < end && s.end > start && !(s.start === s.end && (s.start === start || s.start === end)))

  // 서식을 빌려 줄 원본 문단: 홑문단(분절·각주·자동번호·강제 줄바꿈 없음)이고 그대로 복제해도 되는 최상위 본문 문단
  const donors: Donor[] = []
  env.origUnits.forEach((u, oi) => {
    if (u.kind !== "text" || u.fragment || u.role) return
    const block = env.origBlocks[u.blockIdx]
    if (!block || (block.type !== "paragraph" && block.type !== "heading") || block.footnoteText || block.text?.includes("\n")) return
    const m = env.paraMap.get(u.blockIdx)
    if (!m?.para || m.para.kind !== "body" || m.prefixStripped || m.noteMarks?.length) return
    const top = topOf(oi)
    const xml = env.scans[m.para.sectionIndex].xml
    if (!top || top.start !== m.para.start || !isRemovableParagraph(xml.slice(top.start, top.end).replace(/\b(?:pageBreak|columnBreak)="1"/, ""))) return
    const { plain, segs, marks } = parseEmphasis(env.inlineOf(oi))
    if (!plain.trim()) return
    donors.push({ cls: markerClass(plain, block.type === "heading" ? block.level : undefined), unitIdx: oi, sectionIndex: m.para.sectionIndex, para: m.para, plain, segs, marks })
  })
  const donorOf = new Map(donors.map(d => [d.unitIdx, d]))

  /** 부호 부류가 같은 견본 → (헤딩이면 부호만 같은 견본) → 가까운 앞·뒤 견본 */
  const chooseDonor = (cls: string, near: number): Donor | undefined => {
    const same = pickDonor(donors, cls, near) ?? (cls.startsWith("h") ? pickDonor(donors, cls.slice(cls.indexOf(":") + 1), near) : undefined)
    if (same) return same
    let before: Donor | undefined
    for (const d of donors) { if (d.unitIdx < near) before = d; else return before ?? d }
    return before
  }

  const skip = (reason: string, before?: string, after?: string): number => {
    env.skipped.push({ reason, ...(before !== undefined ? { before: summarize(before) } : {}), ...(after !== undefined ? { after: summarize(after) } : {}) })
    return 0
  }

  const firstEdit = env.scans.map(() => Infinity)
  const mark = (sectionIndex: number, pos: number): void => { firstEdit[sectionIndex] = Math.min(firstEdit[sectionIndex], pos) }

  return {
    /**
     * 구조 편집 뒤 최상위 문단의 줄 배치 캐시 제거 splice — 문단이 늘거나 줄면 뒤 문단 캐시의 세로 위치(vertpos)가 낡는다.
     * 캐시를 믿고 그리는 뷰어(kordoc render)가 낡은 자리에 그려 붙임 줄이 다음 쪽 한가운데로 밀렸다(견본 재작성 실측).
     * 첫 구조 편집 앞 문단과 글을 고친 문단(패처가 따로 지운다)은 건드리지 않는다
     */
    staleCacheSplices(sectionIndex: number): SpliceEdit[] {
      const from = firstEdit[sectionIndex]
      if (from === Infinity) return []
      const xml = env.scans[sectionIndex].xml
      const out: SpliceEdit[] = []
      for (const top of tops[sectionIndex]) {
        if (top.start < from || touched(sectionIndex, top.start, top.end)) continue
        // 칸 안 문단 캐시는 칸 기준 좌표라 그대로 맞다 — 최상위 문단 자기 캐시만
        const c = ownCacheSplice(xml, top.start, top.end)
        if (c) out.push(c)
      }
      return out
    },

    /** 부호가 바뀐 글 수정 — 새 부호를 단 견본 문단을 복제해 그 자리를 갈아 끼운다. 해당 없으면 null(일반 수정으로) */
    restyle(oi: number, edited: MdUnit): number | null {
      const own = donorOf.get(oi)
      if (!own || edited.kind !== "text") return null
      const ed = editedInline(edited.raw)
      const cls = markerClass(ed.plain, ed.level)
      if (cls === own.cls) return null
      const donor = pickDonor(donors, cls, oi, oi)
      if (!donor) return null
      const top = topOf(oi)!
      if (touched(top.sectionIndex, top.start, top.end)) return null
      const clone = cloneParagraphXml(env.scans[donor.sectionIndex].xml, donor, ed.plain, ed.segs, ed.marks, env.chars)
      if (clone === null) return null
      const xml = env.scans[top.sectionIndex].xml
      env.sectionSplices[top.sectionIndex].push({ start: top.start, end: top.end, replacement: keepBreaks(clone, xml.slice(top.start, xml.indexOf(">", top.start) + 1)) })
      removed[top.sectionIndex].push(top)
      mark(top.sectionIndex, top.start)
      return 1
    },

    remove(oi: number): number {
      const u = env.origUnits[oi]
      if (u.kind === "image" || u.kind === "separator") return skip("이미지/구분선 삭제는 미지원 — 원본 유지", u.raw)
      if (u.fragment || u.role) return skip("문단 일부(강제 줄바꿈 조각·표 캡션) 삭제는 미지원 — 원본 유지", u.raw)
      const top = topOf(oi)
      if (!top) return skip("삭제할 문단 위치를 찾지 못함 (머리말·글상자·표 안 영역) — 원본 유지", u.raw)
      if (isRemoved(top.sectionIndex, top.start)) return 0
      const xml = env.scans[top.sectionIndex].xml
      const block = env.origBlocks[u.blockIdx]
      let rest = xml.slice(top.start, top.end)
      if (block?.type === "table") {
        // 표 하나만 담은 호스트 문단만 지운다 (글·다른 개체가 함께 있으면 원본 유지)
        const l = loc(oi)!
        const tEnd = findElementEnd(xml, l.pos)
        rest = xml.slice(top.start, l.pos) + xml.slice(tEnd, top.end)
        if (/<(?:\w+:)?t>[^<]*\S/.test(rest)) return skip("표 삭제 미지원 — 표와 같은 문단에 글이 있음", u.raw)
      } else {
        const para = env.paraMap.get(u.blockIdx)?.para
        if (!para || para.kind !== "body" || para.start !== top.start) return skip("본문 밖(표 칸·글상자) 문단 삭제는 미지원 — 원본 유지", u.raw)
      }
      if (!isRemovableParagraph(rest) || touched(top.sectionIndex, top.start, top.end)) {
        // 구역 정의·개체·쪽 나눔을 품은 문단은 지우면 조판이 무너진다 — 글만 비운다
        const para = block?.type !== "table" ? env.paraMap.get(u.blockIdx)?.para : undefined
        const splices = para && !touched(top.sectionIndex, top.start, top.end) ? buildParagraphSplices(para, "", xml) : null
        if (!splices) return skip("개체·구역 정의가 든 문단이라 삭제 미지원 — 원본 유지", u.raw)
        env.sectionSplices[top.sectionIndex].push(...splices)
        env.skipped.push({ reason: "개체·구역 정의·쪽 나눔이 든 문단 — 문단은 두고 글만 비움", before: summarize(u.raw), partial: true })
        return 1
      }
      env.sectionSplices[top.sectionIndex].push({ start: top.start, end: top.end, replacement: "" })
      removed[top.sectionIndex].push(top)
      mark(top.sectionIndex, top.start)
      return 1
    },

    insert(edited: MdUnit, lastOi: number | null): number {
      if (edited.kind === "image" || edited.kind === "separator") return skip("이미지/구분선 추가는 미지원", undefined, edited.raw)
      if (edited.kind === "html-table") return skip("병합표(HTML) 추가는 미지원 — GFM 표(| 헤더 | … |)로 쓰거나 원본 표를 고쳐 쓰세요", undefined, edited.raw)
      // 자리: 바로 앞 원본 유닛(위치를 아는 것)이 든 최상위 문단 뒤. 앞이 없으면 첫 원본 문단 앞(구역 정의 문단이면 불가)
      let at: { sectionIndex: number; pos: number; near: number } | undefined
      for (let k = lastOi ?? -1; k >= 0 && !at; k--) {
        const top = topOf(k)
        if (top) at = { sectionIndex: top.sectionIndex, pos: top.end, near: k + 0.5 }
      }
      if (!at) {
        for (let k = 0; k < env.origUnits.length && !at; k++) {
          const top = topOf(k)
          if (!top) continue
          if (OBJECT_RE.test(env.scans[top.sectionIndex].xml.slice(top.start, top.end))) return skip("문서 맨 앞(구역 정의 문단 앞) 추가는 미지원 — 첫 블록 뒤에 쓰세요", undefined, edited.raw)
          at = { sectionIndex: top.sectionIndex, pos: top.start, near: k - 0.5 }
        }
      }
      if (!at) return skip("추가할 자리를 찾지 못함", undefined, edited.raw)
      const xml = env.scans[at.sectionIndex].xml
      let fragment: string | null
      if (edited.kind === "gfm-table") {
        const near = chooseDonor("", at.near)
        const prId = near ? Number(/paraPrIDRef="(\d+)"/.exec(xml.slice(near.para.start, near.para.start + 400))?.[1] ?? 0) : 0
        const built = env.tableXml(edited, prId)
        if (typeof built !== "string") return skip(built.reason, undefined, edited.raw)
        fragment = built
      } else {
        const ed = editedInline(edited.raw)
        if (!ed.plain.trim()) return 0
        const donor = chooseDonor(markerClass(ed.plain, ed.level), at.near)
        if (!donor) return skip("서식을 빌릴 본문 문단이 없어 추가 미지원", undefined, edited.raw)
        fragment = cloneParagraphXml(env.scans[donor.sectionIndex].xml, donor, ed.plain, ed.segs, ed.marks, env.chars)
        if (fragment === null) return skip("견본 문단 복제 실패 — 추가 미지원", undefined, edited.raw)
      }
      env.sectionSplices[at.sectionIndex].push({ start: at.pos, end: at.pos, replacement: fragment })
      mark(at.sectionIndex, at.pos)
      return 1
    },
  }
}

/**
 * 정렬 갭(짝 없는 삭제·추가 묶음) 안의 같은 꼴 표끼리 순서대로 짝지어 수정으로 돌린다 — 견본 표를 내용만 갈아 쓴 편집은
 * 글이 거의 안 겹쳐 삭제+추가로 갈리는데, 그러면 견본 표 서식이 사라지고 새 표가 생긴다
 */
export function pairTablesInGaps(pairs: Array<[number | null, number | null]>, a: Array<{ kind: string }>, b: Array<{ kind: string }>): Array<[number | null, number | null]> {
  const isTable = (k: string): boolean => k === "gfm-table" || k === "html-table"
  const out: Array<[number | null, number | null]> = []
  let gap: Array<[number | null, number | null]> = []
  const flush = (): void => {
    const A = gap.filter(p => p[0] !== null).map(p => p[0]!)
    const B = gap.filter(p => p[1] !== null).map(p => p[1]!)
    gap = []
    const matches: Array<[number, number]> = []
    let bj = 0
    for (const ai of A) {
      if (!isTable(a[ai].kind)) continue
      let k = bj
      while (k < B.length && b[B[k]].kind !== a[ai].kind) k++
      if (k < B.length) { matches.push([ai, B[k]]); bj = k + 1 }
    }
    let ia = 0, ib = 0
    for (const [ma, mb] of matches) {
      while (A[ia] !== ma) out.push([A[ia++], null])
      while (B[ib] !== mb) out.push([null, B[ib++]])
      out.push([A[ia++], B[ib++]])
    }
    while (ia < A.length) out.push([A[ia++], null])
    while (ib < B.length) out.push([null, B[ib++]])
  }
  for (const p of pairs) {
    if (p[0] !== null && p[1] !== null) { flush(); out.push(p) } else gap.push(p)
  }
  flush()
  return out
}

/** 문단 자기 줄 배치 캐시(닫는 태그 바로 앞) 제거 splice — 안쪽 표·글상자 문단 캐시는 둔다 */
function ownCacheSplice(xml: string, start: number, end: number): SpliceEdit | null {
  const head = xml.slice(start, xml.lastIndexOf("</", end - 1)).trimEnd()
  const close = /<\/(\w+:)?linesegarray>$/.exec(head)
  const open = close ? head.lastIndexOf(`<${close[1] ?? ""}linesegarray`) : -1
  return open >= 0 ? { start: start + open, end: start + head.length, replacement: "" } : null
}

/**
 * 표 칸 안 줄 수가 바뀐 편집 — 칸 문단과 새 줄을 정렬(LCS)해 짝은 글만 고치고, 남는 원본 문단은 지우고(칸에 하나는 남김),
 * 새 줄은 같은 칸 안 같은 부호 문단을 복제해 넣는다. 본문이 통째로 틀 표 칸에 든 문서(보도자료·소식지·서식, 코퍼스 17%)의
 * 서식 베끼기에서 줄 번호 대응이 한 줄 끼우면 뒤 줄을 전부 한 문단씩 밀어 서식이 어긋나고 넘친 줄이 끝 문단에 합쳐지던 것.
 * 칸 문단 하나라도 복제·삭제가 안 되면 null (호출자가 종전 대응으로)
 */
export function restructureCellLines(
  cellParas: ScanParagraph[], newLines: string[], scans: SectionScan[], sectionSplices: SpliceEdit[][],
  norm: (t: string) => string,
): number | null {
  // 칸 안 글상자 문단은 칸 문단이 아니다 (그 뒤에 넣으면 글상자 안으로, 지우면 글상자가 빈다)
  cellParas = cellParas.filter(p => !p.inTextbox)
  if (cellParas.length === 0) return null
  const sectionIndex = cellParas[0].sectionIndex
  const xml = scans[sectionIndex].xml
  const nonEmpty = cellParas.filter(p => norm(p.text) !== "")
  const olds = nonEmpty.length ? nonEmpty : [cellParas[0]]
  const range = (p: ScanParagraph): { start: number; end: number } => ({ start: p.start, end: findElementEnd(xml, p.start) })
  if (olds.some(p => range(p).end < 0)) return null
  const donors: Donor[] = olds.flatMap((p, i) => {
    const r = range(p)
    if (!isRemovableParagraph(xml.slice(r.start, r.end).replace(/\b(?:pageBreak|columnBreak)="1"/, ""))) return []
    const plain = norm(p.text)
    return [{ cls: markerClass(plain), unitIdx: i, sectionIndex, para: p, plain, segs: [plain] }]
  })
  if (donors.length === 0) return null

  // 빈 칸: 첫 줄은 그 빈 문단에, 나머지는 복제해 뒤로 (정렬에 맡기면 빈 문단이 줄 사이에 남는다)
  const pairs: Array<[number | null, number | null]> = nonEmpty.length
    ? alignUnits(olds.map(p => norm(p.text)), newLines.map(norm))
    : newLines.map((_, k) => (k === 0 ? [0, 0] : [null, k]) as [number | null, number | null])
  const out: SpliceEdit[] = []
  let first = Infinity, remaining = cellParas.length, lastOld: number | null = null
  for (const [oi, ei] of pairs) {
    if (oi !== null && ei !== null) {
      lastOld = oi
      const p = olds[oi], line = newLines[ei]
      if (norm(p.text) === norm(line)) continue
      const cls = markerClass(line)
      const r = range(p)
      // 갈아입히기는 통째로 바꿔도 되는 문단만 (그림·각주·누름틀이 든 문단은 글만 고친다)
      const donor = cls !== markerClass(norm(p.text)) && isRemovableParagraph(xml.slice(r.start, r.end).replace(/\b(?:pageBreak|columnBreak)="1"/, ""))
        ? pickDonor(donors, cls, oi, oi) : undefined
      const clone = donor ? cloneParagraphXml(xml, donor, line, [line]) : null
      if (clone !== null) {
        out.push({ start: r.start, end: r.end, replacement: keepBreaks(clone, xml.slice(r.start, xml.indexOf(">", r.start) + 1)) })
        first = Math.min(first, r.start)
        continue
      }
      const sp = minimalTextSplices(p, xml, norm(p.text), line) ?? buildParagraphSplices(p, line, xml)
      if (sp === null) return null
      out.push(...sp)
    } else if (oi !== null) {
      lastOld = oi
      const p = olds[oi], r = range(p)
      if (remaining > 1 && isRemovableParagraph(xml.slice(r.start, r.end))) {
        out.push({ start: r.start, end: r.end, replacement: "" })
        remaining--
        first = Math.min(first, r.start)
      } else {
        const sp = buildParagraphSplices(p, "", xml)
        if (sp === null) return null
        out.push(...sp)
      }
    } else if (ei !== null) {
      const line = newLines[ei]
      if (!norm(line)) continue
      const near = lastOld === null ? -0.5 : lastOld + 0.5
      const donor = pickDonor(donors, markerClass(line), near) ?? pickDonor(donors, "", near) ?? pickDonor(donors, donors[0].cls, near)
      const clone = donor && cloneParagraphXml(xml, donor, line, [line])
      if (!clone) return null
      const at = lastOld === null ? olds[0].start : range(olds[lastOld]).end
      out.push({ start: at, end: at, replacement: clone })
      first = Math.min(first, at)
    }
  }
  // 칸 안 뒤 문단의 캐시는 칸 기준 세로 위치라 줄이 늘고 줄면 낡는다
  if (first !== Infinity) {
    for (const p of cellParas) {
      const r = range(p)
      if (r.start < first || out.some(s => s.start < r.end && s.end > r.start)) continue
      const c = ownCacheSplice(xml, r.start, r.end)
      if (c) out.push(c)
    }
  }
  sectionSplices[sectionIndex].push(...out)
  return 1
}
