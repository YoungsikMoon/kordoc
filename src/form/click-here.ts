/**
 * 누름틀(CLICK_HERE fieldBegin) 인식·채우기 — 정부 표준 서식(기안문) 지원
 *
 * HWPX의 누름틀은 `<hp:ctrl><hp:fieldBegin type="CLICK_HERE" name="…">…</hp:fieldBegin>
 * </hp:ctrl>` 과 `<hp:ctrl><hp:fieldEnd beginIDRef="…"/></hp:ctrl>` 쌍으로 표시되고,
 * 실제 값은 두 ctrl **사이의** run 콘텐츠다. 안내문(placeholder)은 fieldBegin의
 * Clickhere Command 파라미터에만 있고 본문 텍스트가 아니므로, 채우기는 안내문과
 * 값을 비교하지 않고 무조건 사이 영역을 값으로 치환한다 — 값이 안내문과 동일해도
 * 침묵 유실이 없다 (rhwp 코어 결함 #3380 교훈).
 *
 * 치환은 filler-hwpx와 같은 철학의 원본 XML splice — fieldEnd·안내문 파라미터·둘러싼
 * run(charPr)을 1바이트도 건드리지 않고 사이 영역만 바꾼다. 값을 넣으면 fieldBegin 의 수정
 * 표시(dirty)만 "1" 로 켠다 — 미수정(dirty=0) 필드의 값이 안내문과 같으면 한컴은 화면에만 흐리게
 * 보이고 인쇄하지 않으며 kordoc 파서도 그렇게 읽는다(v4.14.3). 한컴이 직접 채운 필드도 dirty=1.
 */

import JSZip from "jszip"
import { escapeXmlText, decodeXmlEntities } from "../roundtrip/source-map.js"
import { applySplices, findElementEnd, type ScanParagraph, type SpliceEdit } from "../roundtrip/source-map.js"
import { alignToRaw, commonEnds } from "../roundtrip/inline-edit.js"
import { normalizeLabel, type ValueCursor } from "./match.js"
import type { FormField } from "../types.js"
import { precheckZipSize } from "../utils.js"
import { readZipEntry } from "../hwpx/parser-shared.js"

/** 문서에서 발견한 누름틀 필드 */
export interface ClickHereField {
  /** 누름틀 이름 (fieldBegin name 속성) */
  name: string
  /** 안내문 — 필드가 비어 있을 때 한글이 표시하는 문구 (Clickhere Direction 파라미터) */
  placeholder?: string
  /** begin~end 사이 현재 텍스트 — 빈 서식이면 "" (안내문은 값이 아니다) */
  value: string
  /** 0-based 섹션 번호 */
  section: number
}

/** 스캔된 누름틀 영역 — start/end는 값이 들어가는 사이 영역의 원본 XML 오프셋 */
interface ClickHereRegion {
  name: string
  placeholder?: string
  /** 값 영역 시작 (fieldBegin ctrl 닫힘 직후) */
  start: number
  /** 값 영역 끝 (fieldEnd ctrl 열림 직전) */
  end: number
  /** 태그 네임스페이스 접두사 (예: "hp:") — 삽입 요소도 같은 접두사 사용 */
  prefix: string
  /** fieldBegin 여는 태그 범위 — 값을 넣을 때 수정 표시(dirty)만 켠다 */
  beginTagStart: number
  beginTagEnd: number
}

const FIELD_BEGIN_RE = /<([A-Za-z0-9_]+:)?fieldBegin\b([^>]*?)(\/?)>/g

function attrOf(attrs: string, name: string): string | undefined {
  const m = attrs.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`))
  return m ? m[1] : undefined
}

/** Clickhere Command 파라미터에서 안내문 추출 — `Direction:wstring:<N>:` 뒤 N자(UTF-16) */
function extractPlaceholder(fieldBeginXml: string): string | undefined {
  // 파서(section-walker clickHereGuide)와 같은 순서 — stringParam Direction, 없으면 Command 의 Direction
  const d = fieldBeginXml.match(/<(?:[A-Za-z0-9_]+:)?stringParam\b[^>]*\bname="Direction"[^>]*>([^<]*)</)
  if (d) return decodeXmlEntities(d[1]) || undefined
  const m = fieldBeginXml.match(/Direction:wstring:(\d+):/)
  if (!m) return undefined
  const start = (m.index ?? 0) + m[0].length
  const n = parseInt(m[1], 10)
  if (!Number.isFinite(n) || n < 0 || n > 1000) return undefined
  return decodeXmlEntities(fieldBeginXml.slice(start, start + n))
}

/** 사이 영역의 표시 텍스트 — 태그 제거, lineBreak/br→\n, tab→\t */
function regionText(inner: string): string {
  return decodeXmlEntities(
    inner
      .replace(/<(?:[A-Za-z0-9_]+:)?(?:lineBreak|br)\b[^>]*\/?>/g, "\n")
      .replace(/<(?:[A-Za-z0-9_]+:)?tab\b[^>]*\/?>/g, "\t")
      .replace(/<[^>]+>/g, ""),
  )
}

/**
 * 섹션 XML에서 CLICK_HERE 누름틀 영역을 문서 순서로 스캔.
 * 겹치는(중첩된) 영역은 뒤엣것을 버려 splice 충돌을 막는다.
 */
export function scanClickHereRegions(xml: string): ClickHereRegion[] {
  const regions: ClickHereRegion[] = []
  FIELD_BEGIN_RE.lastIndex = 0
  let m: RegExpExecArray | null
  let lastEnd = -1
  while ((m = FIELD_BEGIN_RE.exec(xml)) !== null) {
    const prefix = m[1] ?? ""
    const attrs = m[2]
    const selfClosed = m[3] === "/"
    if ((attrOf(attrs, "type") ?? "").toUpperCase() !== "CLICK_HERE") continue
    const name = attrOf(attrs, "name")
    if (name === undefined) continue
    const id = attrOf(attrs, "id")

    // fieldBegin 요소 끝 찾기 (파라미터 자식 포함)
    let beginElemEnd: number
    if (selfClosed) {
      beginElemEnd = FIELD_BEGIN_RE.lastIndex
    } else {
      const closeTag = `</${prefix}fieldBegin>`
      const ci = xml.indexOf(closeTag, FIELD_BEGIN_RE.lastIndex)
      if (ci < 0) continue
      beginElemEnd = ci + closeTag.length
    }
    const fieldBeginXml = xml.slice(m.index, beginElemEnd)

    // fieldBegin을 감싼 ctrl 닫힘 직후가 값 영역 시작 (ctrl 없는 비표준 배치도 허용)
    const ctrlClose = `</${prefix}ctrl>`
    let start = beginElemEnd
    let wrapped = false
    if (xml.startsWith(ctrlClose, beginElemEnd)) {
      start = beginElemEnd + ctrlClose.length
      wrapped = true
    }

    // 짝 fieldEnd 찾기 — id가 있으면 beginIDRef 일치 우선, 없으면 다음 fieldEnd
    const feRe = new RegExp(`<${prefix}fieldEnd\\b[^>]*>`, "g")
    feRe.lastIndex = start
    let end = -1
    let fe: RegExpExecArray | null
    while ((fe = feRe.exec(xml)) !== null) {
      const ref = attrOf(fe[0], "beginIDRef")
      if (id !== undefined && ref !== undefined && ref !== id) continue
      end = fe.index
      break
    }
    if (end < 0) continue

    // fieldEnd를 감싼 ctrl 열림까지 영역에 포함 (fieldBegin과 대칭)
    const ctrlOpen = `<${prefix}ctrl>`
    if (wrapped && xml.slice(end - ctrlOpen.length, end) === ctrlOpen) {
      end -= ctrlOpen.length
    }

    if (start > end) continue
    if (start < lastEnd) continue // 중첩/역전 — 앞선 영역 우선
    lastEnd = end
    regions.push({
      name: decodeXmlEntities(name),
      placeholder: extractPlaceholder(fieldBeginXml),
      start,
      end,
      prefix,
      beginTagStart: m.index,
      beginTagEnd: m.index + m[0].length,
    })
  }
  return regions
}

/** 채울 값의 XML 조각 — \n은 문단 내 강제 줄바꿈(lineBreak)으로 (rhwp fill-fields 동일 계약) */
function valueXml(value: string, prefix: string): string {
  if (value === "") return ""
  const lines = value.split("\n").map(escapeXmlText)
  return `<${prefix}t>${lines.join(`<${prefix}lineBreak/>`)}</${prefix}t>`
}

/** 누름틀 영역을 값으로 채우는 splice — 사이 영역을 값으로 바꾸고(같으면 바이트 보존), 값이 있으면 수정 표시(dirty)를 켠다.
 *  빈 값은 안내문 노출 그대로(미수정 유지) */
function regionFillSplices(xml: string, region: ClickHereRegion, value: string): SpliceEdit[] {
  const out: SpliceEdit[] = []
  if (value !== "") {
    const tag = xml.slice(region.beginTagStart, region.beginTagEnd)
    if (attrOf(tag, "dirty") !== "1") {
      const dirtyTag = /\sdirty="[^"]*"/.test(tag)
        ? tag.replace(/(\sdirty=")[^"]*"/, (_, head: string) => head + '1"')
        : tag.replace(/(\/?>)$/, ' dirty="1"$1')
      out.push({ start: region.beginTagStart, end: region.beginTagEnd, replacement: dirtyTag })
    }
  }
  const replacement = valueXml(value, region.prefix)
  if (xml.slice(region.start, region.end) !== replacement) out.push({ start: region.start, end: region.end, replacement })
  return out
}

/**
 * patch: 문단 글 편집이 미기입 누름틀 자리에 글을 넣는 것(넣은 자리와 누름틀 사이가 공백뿐)이면 그 글을 안내문 대신 누름틀 안에
 * 넣는 splice — 한글에서 누름틀을 눌러 입력한 것과 같다(fillClickHereInXml 과 같은 꼴: 값은 앞 run 글자 모양, dirty="1").
 * origPlain 은 안내문을 뺀 IR 평문(마크다운)이다. 그런 편집이 아니면 null
 */
export function clickHereEditSplices(para: ScanParagraph, xml: string, origPlain: string, newPlain: string): SpliceEdit[] | null {
  const paraEnd = findElementEnd(xml, para.start)
  if (paraEnd < 0) return null
  // 미기입(dirty≠1)이고 값 자리 글이 안내문 그대로인 누름틀 — 파서 section-walker 와 같은 판정. 문단 조각만 훑는다
  const isGuide = (r: ClickHereRegion): boolean => {
    if (r.placeholder === undefined || attrOf(xml.slice(r.beginTagStart, r.beginTagEnd), "dirty") === "1") return false
    const v = regionText(xml.slice(r.start, r.end))
    return v === r.placeholder || v.trimEnd() === r.placeholder
  }
  const guides = scanClickHereRegions(xml.slice(para.start, paraEnd))
    .map(r => ({ ...r, start: r.start + para.start, end: r.end + para.start, beginTagStart: r.beginTagStart + para.start, beginTagEnd: r.beginTagEnd + para.start }))
    .filter(isGuide)
  if (!guides.length) return null
  // 안내문 hp:t 를 뺀 보이는 글과 누름틀마다 그 앞 글 길이
  let visible = ""
  const visAt = new Map<ClickHereRegion, number>()
  for (const t of para.tRanges) {
    if (t.selfClosing) continue
    const g = guides.find(r => t.contentStart >= r.start && t.contentEnd <= r.end)
    if (g) { if (!visAt.has(g)) visAt.set(g, visible.length); continue }
    const raw = xml.slice(t.contentStart, t.contentEnd)
    if (/[<&]/.test(raw)) return null
    visible += raw
  }
  const pos = alignToRaw(visible, origPlain)
  const { p, s } = commonEnds(origPlain, newPlain)
  const inserted = newPlain.slice(p, newPlain.length - s)
  if (!pos || origPlain.length - s !== p || !inserted.trim()) return null
  const at = p < pos.length ? pos[p] : pos.length ? pos[pos.length - 1] + 1 : 0
  for (const [g, vis] of visAt) {
    if (visible.slice(Math.min(at, vis), Math.max(at, vis)).trim()) continue
    return regionFillSplices(xml, g, /\s$/.test(visible.slice(0, vis)) ? inserted.trimStart() : inserted)
  }
  return null
}

/** fillClickHereInXml 결과 */
export interface ClickHereFillOutcome {
  /** 치환 적용된 XML — 변경 없으면 null */
  xml: string | null
  /** 채운 필드 기록 (filler-hwpx filled와 동일 형태) */
  filled: FormField[]
  /** 매칭된 정규화 키 — 이후 라벨 매칭에서 제외할 대상 */
  matchedKeys: Set<string>
  /** 고친 자리(치환 뒤 xml 좌표): 그 문단의 줄 배치 캐시만 지우는 데 쓴다 */
  changedAt: number[]
}

/**
 * 섹션 XML의 누름틀을 값으로 채움 — 누름틀 name(정규화)과 정확히 일치하는 키만.
 * 접두사 매칭은 하지 않는다: 누름틀 이름은 서식 제작자가 정한 명시적 계약이라
 * 근사 매칭이 오히려 오폭이다.
 */
export function fillClickHereInXml(
  xml: string,
  cursor: ValueCursor,
  blockedLabels?: Set<string>,
): ClickHereFillOutcome {
  const filled: FormField[] = []
  const matchedKeys = new Set<string>()
  const splices: SpliceEdit[] = []

  for (const region of scanClickHereRegions(xml)) {
    const key = normalizeLabel(region.name)
    if (!key || blockedLabels?.has(key)) continue
    if (!cursor.has(key)) continue
    const value = cursor.consume(key)
    if (value === undefined) continue // 배열 값 소진 — 이후 등장은 채우지 않음

    matchedKeys.add(key)
    filled.push({ label: region.name, value, row: -1, col: -1, key, source: "clickhere" })
    splices.push(...regionFillSplices(xml, region, value))
  }

  // 치환 뒤 좌표: 앞선 치환의 길이 차를 누적한다 (applySplices 와 같은 시작 위치 정렬)
  const changedAt: number[] = []
  let delta = 0
  for (const s of [...splices].sort((a, b) => a.start - b.start)) {
    changedAt.push(s.start + delta)
    delta += s.replacement.length - (s.end - s.start)
  }
  return {
    xml: splices.length > 0 ? applySplices(xml, splices) : null,
    filled,
    matchedKeys,
    changedAt,
  }
}

/**
 * HWPX의 CLICK_HERE 누름틀 필드 목록 — 이름·안내문·현재값을 문서 순서로 반환.
 * 표준 서식(기안문 등)이 요구하는 필드를 채우기 전에 조사하는 용도.
 */
export async function extractClickHereFields(hwpxBuffer: ArrayBuffer): Promise<ClickHereField[]> {
  precheckZipSize(hwpxBuffer) // 파싱 경로와 같은 ZIP bomb 가드
  const zip = await JSZip.loadAsync(hwpxBuffer)
  const sectionPaths = Object.keys(zip.files)
    .filter(name => /[Ss]ection\d+\.xml$/i.test(name))
    .sort()
  const fields: ClickHereField[] = []
  for (let si = 0; si < sectionPaths.length; si++) {
    const xml = await readZipEntry(zip.file(sectionPaths[si])!, "text")
    for (const r of scanClickHereRegions(xml)) {
      fields.push({
        name: r.name,
        ...(r.placeholder !== undefined ? { placeholder: r.placeholder } : {}),
        value: regionText(xml.slice(r.start, r.end)),
        section: si,
      })
    }
  }
  return fields
}
