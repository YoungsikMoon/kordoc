/**
 * 강제 줄바꿈(<hp:lineBreak/>)이 든 HWPX 문단의 바뀐 자리만 고치는 splice.
 *
 * 한컴 저장본은 줄바꿈 요소를 hp:t 안에 둔다(<hp:t>앞<hp:lineBreak/>뒤</hp:t>). hp:t 글을 훑으며 줄바꿈 요소는 "\n",
 * 탭·고정폭 빈칸 요소는 " " 한 글자로 읽어 IR 평문과 맞대고, diff 범위를 원문 좌표로 옮긴다. 고치지 않은 줄바꿈·탭·run
 * 은 그대로 남고, 새 글의 "\n" 은 같은 줄바꿈 요소로 쓴다. 맞대지 못하면 null.
 */

import { decodeXmlEntities, escapeXmlText, type ScanParagraph, type SpliceEdit } from "./source-map.js"
import { alignedTextEdits, type RawEdit } from "./inline-edit.js"

/** 문단 글 낱자 — text[from, to) 가 XML [start, end) 에서 왔다 */
export interface TextTok { from: number; to: number; start: number; end: number }

export interface ParaTokens {
  text: string
  toks: TextTok[]
  /** 이 문단의 줄바꿈 요소 표기 */
  br: string
}

/** 문단 hp:t 글을 낱자로 읽는다(줄바꿈 요소 "\n", 탭·빈칸 요소 " ", 엔티티 디코딩). 다른 내부 태그가 있으면 null */
export function paraTokens(para: ScanParagraph, xml: string, base = 0): ParaTokens | null {
  const toks: TextTok[] = []
  let text = ""
  let br = ""
  for (const t of para.tRanges) {
    if (t.selfClosing) continue
    const raw = xml.slice(t.contentStart, t.contentEnd)
    if (!br) {
      // 여는 <hp:t …> 태그의 네임스페이스를 따른다
      const ns = xml.slice(xml.lastIndexOf("<", t.contentStart - 1), t.contentStart).match(/^<([A-Za-z0-9_]+):/)?.[1]
      br = ns ? `<${ns}:lineBreak/>` : "<lineBreak/>"
    }
    for (const m of raw.matchAll(/<(?:[A-Za-z0-9_]+:)?(lineBreak|br|tab|fwSpace|hwSpace|nbSpace)\b[^>]*\/>|&[^;&<]*;|[\s\S]/gu)) {
      let ch = m[0]
      if (m[1]) ch = m[1] === "lineBreak" || m[1] === "br" ? "\n" : " "
      else if (ch === "<" || ch === "&") return null
      else if (ch.startsWith("&")) { ch = decodeXmlEntities(ch); if (ch === m[0]) return null }
      const s = t.contentStart + m.index!
      toks.push({ from: base + text.length, to: base + text.length + ch.length, start: s, end: s + m[0].length })
      text += ch
    }
  }
  return { text, toks, br }
}

/** 글 좌표 편집을 낱자 splice 로: 범위에 든 첫 낱자 자리에 새 글, 나머지 낱자는 지운다. "\n" 은 br 로 쓴다 */
export function tokenSplices(toks: TextTok[], edits: RawEdit[], br: string): SpliceEdit[] | null {
  const out: SpliceEdit[] = []
  for (const e of edits) {
    const rep = escapeXmlText(e.text).replace(/\r?\n/g, br)
    if (e.start === e.end) {
      const tk = toks.find(k => k.from === e.start) ?? toks.find(k => k.to === e.start)
      if (!tk) return null
      const at = tk.from === e.start ? tk.start : tk.end
      out.push({ start: at, end: at, replacement: rep })
      continue
    }
    let placed = false
    for (const tk of toks) {
      if (tk.to <= e.start || tk.from >= e.end) continue
      // 엔티티·서로게이트 쌍 중간에 걸린 경계
      if (tk.from < e.start || tk.to > e.end) return null
      const prev = out[out.length - 1]
      if (placed && prev.end === tk.start) prev.end = tk.end
      else out.push({ start: tk.start, end: tk.end, replacement: placed ? "" : rep })
      placed = true
    }
    if (!placed) return null
  }
  return out
}

export function lineBreakTextSplices(para: ScanParagraph, xml: string, origNorm: string, newNorm: string): SpliceEdit[] | null {
  const pt = paraTokens(para, xml)
  if (!pt || !pt.br) return null
  const edits = alignedTextEdits(pt.text, origNorm, newNorm)
  if (!edits || edits.length === 0) return null
  return tokenSplices(pt.toks, edits, pt.br)
}
