/** Page decorations are separate stories: their line positions never split body pages. */
import { findChildByLocalName } from "../hwpx/parser-shared.js"
import { buildPara, elements, findFirst, isDeletedControl, ln, num } from "./para-model.js"

export interface PageStory { sub: Element; page: number; x: number; y: number; width: number; layer?: -2 | 2 }
export function pageStories(root: Element, masters: Element[], paraPages: Map<Element, number[]>, pageCount: number, pageBase: number,
  geom: { ML: number; MT: number; PH: number; BODY_W: number }): PageStory[] {
  const secPr = findFirst(root, "secPr"), visibility = secPr && findChildByLocalName(secPr, "visibility")
  const pagePr = secPr && findChildByLocalName(secPr, "pagePr"), margin = pagePr && findChildByLocalName(pagePr, "margin")
  const declarations: Array<{ el: Element; page: number; kind: string }> = []
  const hidden = new Map<number, Set<string>>()
  for (const p of elements(root)) if (ln(p) === "p") {
    const page = paraPages.get(p)?.[0] ?? 0
    for (const run of elements(p)) if (ln(run) === "run") for (const ctrl of elements(run)) if (ln(ctrl) === "ctrl") {
      for (const el of elements(ctrl)) {
        if (isDeletedControl(el)) continue
        const kind = ln(el)
        if (kind === "header" || kind === "footer") declarations.push({ el, page, kind })
        else if (kind === "pageHiding") {
          const kinds = hidden.get(page) ?? new Set<string>()
          for (const name of ["Header", "Footer", "MasterPage"]) if (num(el, `hide${name}`)) kinds.add(name)
          hidden.set(page, kinds)
        }
      }
    }
  }
  const parity = (type: string, n: number): boolean => type === "BOTH" || (type === "ODD" && n % 2 === 1) || (type === "EVEN" && n % 2 === 0)
  const out: PageStory[] = []
  for (let page = 0; page < pageCount; page++) {
    const n = pageBase + page + 1
    const hides = (name: string): boolean => hidden.get(page)?.has(name) === true || (page === 0 && num(visibility, `hideFirst${name}`) !== 0)
    if (!hides("MasterPage")) {
      // ODD/EVEN replace BOTH on their pages; they are not an overlay.
      const matching = masters.filter(m => m.getAttribute("type") === (n % 2 ? "ODD" : "EVEN"))
      const both = masters.filter(m => (m.getAttribute("type") || "BOTH") === "BOTH")
      const normal = (matching.length ? matching : both).slice(-1)
      const specific = masters.filter(m => m.getAttribute("type") === "LAST_PAGE" ? page === pageCount - 1 : m.getAttribute("type") === "OPTIONAL_PAGE" && num(m, "pageNumber") === page + 1)
      const special = specific.slice(-1)
      const selected = special.length && !num(special[0], "pageDuplicate") ? special : [...normal, ...special]
      for (const master of selected) {
        const sub = findChildByLocalName(master, "subList")
        if (sub) out.push({ sub, page, x: geom.ML, y: geom.MT, width: geom.BODY_W, layer: num(master, "pageFront") ? 2 : -2 })
      }
    }
    for (const kind of ["header", "footer"]) {
      if (hides(kind === "header" ? "Header" : "Footer")) continue
      const eligible = declarations.filter(d => d.kind === kind && d.page <= page && parity(d.el.getAttribute("applyPageType") || "BOTH", n))
      const decl = eligible[eligible.length - 1]
      const sub = decl && findChildByLocalName(decl.el, "subList")
      if (sub) out.push({ sub, page, x: geom.ML, y: kind === "header" ? num(margin, "top", 5668) : geom.PH - num(margin, "bottom", 4252) - num(margin, "footer"), width: geom.BODY_W })
    }
  }
  return out
}

/** 각주 구분선 — 쪽 아래 각주 영역 맨 위 */
export interface NoteRule { page: number; x: number; y: number; length: number; widthMm: number; color: string }

/**
 * 쪽 아래 각주 — 쪽마다 그 쪽에 놓인 문단의 각주를 모아 본문 바닥에서 각주 영역만큼 위에 놓는다(reflow 의 쪽 바닥 계산과 같은 모양):
 * 영역 = 구분선 위 간격(aboveLine) + 구분선 아래 간격(belowLine) + 각주 높이 합 + 각주 사이 간격(betweenNotes) × (개수 − 1).
 * 구분선은 왼쪽 여백에서 길이만큼(length −1 = 기본 5cm, 한컴 PDF 실측 14173). 각주 높이는 하위 목록 lineseg 바닥
 */
export function footNoteStories(root: Element, paraPages: Map<Element, number[]>, geom: { ML: number; MT: number; BODY_W: number; BODY_H: number }): { stories: PageStory[]; rules: NoteRule[] } {
  const pr = findFirst(root, "footNotePr")
  const sp = pr ? findChildByLocalName(pr, "noteSpacing") : null, line = pr ? findChildByLocalName(pr, "noteLine") : null
  const above = num(sp, "aboveLine", 850), below = num(sp, "belowLine", 567), between = num(sp, "betweenNotes", 283)
  const byPage = new Map<number, Array<{ sub: Element; h: number }>>()
  for (const p of elements(root)) if (ln(p) === "p") {
    const pages = paraPages.get(p) ?? []
    // 각주는 참조 글자가 든 줄의 쪽 — 쪽에 걸친 문단의 뒤 줄 각주는 다음 쪽(한컴 PDF: 쪽 바닥을 넘어 다음 쪽 첫 줄에 든 참조의 각주가 그 쪽 아래)
    const m = pages.length > 1 ? buildPara(p) : null
    for (const run of elements(p)) if (ln(run) === "run") for (const ctrl of elements(run)) if (ln(ctrl) === "ctrl") {
      const fn = findChildByLocalName(ctrl, "footNote")
      const sub = fn && !isDeletedControl(fn) ? findChildByLocalName(fn, "subList") : null
      if (!sub) continue
      let page = pages[0] ?? 0
      if (m) { const at = m.chars.findIndex(c => c.note === fn); if (at >= 0) { let k = 0; m.segs.forEach((sg, i) => { if (sg.textpos <= at) k = i }); page = pages[k] ?? page } }
      let h = 0
      for (const q of elements(sub)) if (ln(q) === "p") {
        const lsa = findChildByLocalName(q, "linesegarray")
        for (const seg of lsa ? elements(lsa) : []) if (ln(seg) === "lineseg") h = Math.max(h, num(seg, "vertpos") + num(seg, "vertsize"))
      }
      const list = byPage.get(page) ?? []
      list.push({ sub, h })
      byPage.set(page, list)
    }
  }
  const stories: PageStory[] = [], rules: NoteRule[] = []
  const lenAttr = num(line, "length", -1), widthMm = Number.parseFloat(line?.getAttribute("width") ?? "0.12") || 0.12
  const lineType = line?.getAttribute("type") ?? "SOLID"
  for (const [page, notes] of byPage) {
    const area = above + below + notes.reduce((a, n) => a + n.h, 0) + between * (notes.length - 1)
    const top = geom.MT + geom.BODY_H - area
    if (lineType !== "NONE") rules.push({ page, x: geom.ML, y: top + above, length: lenAttr > 0 ? lenAttr : 14173, widthMm, color: line?.getAttribute("color") ?? "#000000" })
    let y = top + above + below
    for (const n of notes) { stories.push({ sub: n.sub, page, x: geom.ML, y, width: geom.BODY_W }); y += n.h + between }
  }
  return { stories, rules }
}

/**
 * 미주 — 구역 본문 끝(마지막 줄 바닥) 뒤에 차례로 흘린다. 구분선은 본문 끝 + aboveLine, 미주는 구분선 + belowLine 부터, 미주 사이는 betweenNotes.
 * 단(colPr)을 채우면 다음 단, 마지막 단이면 다음 쪽 맨 위로 줄 단위로 넘어간다. 미주 하위 목록 lineseg 는 미주마다 0 부터인 지역 좌표라
 * 여기서 쪽 로컬 vertpos 와 단 오프셋을 더한 horzpos 로 다시 쓴다(한컴 PDF: 2단 시험지 미주 구분선 = 본문 끝 줄 바닥, 첫 미주 = 그 아래 576)
 */
export function endNoteLayout(root: Element, paraPages: Map<Element, number[]>, geom: { ML: number; MT: number; BODY_W: number; BODY_H: number }): { paras: Array<{ p: Element; pages: number[] }>; rules: NoteRule[]; pageCount: number } | null {
  const notes: Element[] = []
  let last: { seg: Element; page: number } | null = null
  /** 구역 끝에 걸린 단 정의 — 미주는 구역 끝의 단으로 흐른다(한컴 PDF: 1단으로 시작해 2단으로 바뀐 구역의 미주가 두 단) */
  let endColPr: Element | null = null
  for (const p of elements(root)) if (ln(p) === "p") {
    const lsa = findChildByLocalName(p, "linesegarray"), segs = lsa ? elements(lsa).filter(e => ln(e) === "lineseg") : []
    const pages = paraPages.get(p) ?? []
    if (segs.length) last = { seg: segs[segs.length - 1], page: pages[segs.length - 1] ?? pages[0] ?? 0 }
    for (const run of elements(p)) if (ln(run) === "run") for (const ctrl of elements(run)) if (ln(ctrl) === "ctrl") {
      endColPr = findChildByLocalName(ctrl, "colPr") ?? endColPr
      const en = findChildByLocalName(ctrl, "endNote")
      const sub = en && !isDeletedControl(en) ? findChildByLocalName(en, "subList") : null
      if (sub) notes.push(sub)
    }
  }
  if (!notes.length || !last) return null
  const pr = findFirst(root, "endNotePr")
  const sp = pr ? findChildByLocalName(pr, "noteSpacing") : null, line = pr ? findChildByLocalName(pr, "noteLine") : null
  const above = num(sp, "aboveLine", 0), below = num(sp, "belowLine", 567), between = num(sp, "betweenNotes", 283)
  const colPr = endColPr ?? findFirst(root, "colPr"), nCol = Math.max(1, num(colPr, "colCount", 1)), gap = nCol > 1 ? num(colPr, "sameGap", 0) : 0
  const colW = (geom.BODY_W - gap * (nCol - 1)) / nCol
  let page = last.page
  let col = nCol > 1 ? Math.min(nCol - 1, Math.max(0, Math.round(num(last.seg, "horzpos") / (colW + gap)))) : 0
  let y = num(last.seg, "vertpos") + num(last.seg, "vertsize") + above
  const rules: NoteRule[] = []
  const lenAttr = num(line, "length", -1), widthMm = Number.parseFloat(line?.getAttribute("width") ?? "0.12") || 0.12
  if ((line?.getAttribute("type") ?? "SOLID") !== "NONE") rules.push({ page, x: geom.ML + col * (colW + gap), y: geom.MT + y, length: lenAttr > 0 ? lenAttr : 14173, widthMm, color: line?.getAttribute("color") ?? "#000000" })
  y += below
  const next = (): void => { if (++col >= nCol) { col = 0; page++ } y = 0 }
  const out: Array<{ p: Element; pages: number[] }> = []
  notes.forEach((sub, ni) => {
    if (ni > 0) y += between
    let base = y
    // 미주 줄 vertpos 는 미주 첫 줄 기준(0)이고, 단을 넘긴 문단은 그 문단 첫 줄 기준 0 부터 다시 센다 — 되돌아간 줄은 앞 줄(+간격) 뒤에 잇고,
    // 단 넘김은 줄이 단 바닥을 넘을 때 일어난다(한컴 PDF 시험지 해설: 되돌아간 2298 줄은 왼쪽 단 바닥, 다음 줄 2750 이 오른쪽 단 맨 위 0,
    // 떠 있는 그래프 6852 + 97 − 2750 = 4199 ↔ PDF 4197)
    let prevRaw = Number.NEGATIVE_INFINITY, flowEnd = y
    for (const q of elements(sub)) if (ln(q) === "p") {
      const lsa = findChildByLocalName(q, "linesegarray"), segs = lsa ? elements(lsa).filter(e => ln(e) === "lineseg") : []
      const pages: number[] = []
      for (const seg of segs) {
        const raw = num(seg, "vertpos")
        if (raw < prevRaw) base = flowEnd - raw
        prevRaw = raw
        let v = base + raw
        const vs = num(seg, "vertsize")
        if (v + vs > geom.BODY_H && v > 0) { const shift = v; next(); base -= shift; v = 0 }
        seg.setAttribute("vertpos", String(v))
        seg.setAttribute("horzpos", String(num(seg, "horzpos") + col * (colW + gap)))
        pages.push(page)
        y = v + vs
        flowEnd = y + num(seg, "spacing")
      }
      out.push({ p: q, pages })
    }
  })
  return { paras: out, rules, pageCount: page + 1 }
}

