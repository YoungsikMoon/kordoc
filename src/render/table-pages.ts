/**
 * 쪽을 넘는 본문 표의 행 배치 — 표 그리기(drawTable)와 쪽 프리패스가 같은 계획을 쓴다.
 * 행 바닥이 본문 바닥을 넘으면: 칸 안 나눔(pageBreak=CELL) 표는 행을 칸 줄 경계에서 갈라 남은 줄을 다음 쪽 맨 위(머리 행 아래)에,
 * 그 밖의 표는 그 행부터 다음 쪽으로 넘긴다. 쪽마다 적어도 한 행(조각)은 놓는다. 칸을 가르는 규칙은 reflow 와 같다 —
 * 칸마다 (칸 위 여백 + 줄 바닥) ≤ 남은 높이 − 칸 아래 여백 인 줄까지 이 쪽, 남은 줄에 칸 위아래 여백을 더한 높이가 다음 쪽 조각.
 */

import { elements, ln, num, cellColumns, cellContentExtent, type CellModel } from "./para-model.js"
import { findChildByLocalName } from "../hwpx/parser-shared.js"
import { subFloatBottoms } from "./reflow-tables.js"

/**
 * 행 하나가 한 쪽에 놓인 조각 — page 는 표 시작 쪽에서 센 쪽 차이, y 는 절대 위치. range 는 칸마다 이 조각에 그릴 내용 vertpos [from, to).
 * place 는 이 조각에 옮겨 그릴 칸 안 떠 있는 개체의 위(절대 y)
 */
/** fill — 칸 줄에 앵커한 떠 있는 표가 이 조각 바닥 너머로 이어진다(칸 세로 정렬 없이 저장 자리에 그린다) */
export interface RowPiece { page: number; y: number; h: number; range?: Map<Element, [number, number]>; place?: Map<Element, number>; fill?: boolean }

/** 칸 문단의 겹치지 않는(allowOverlap=0) 떠 있는 문단 기준 개체 — 위 오프셋(음수는 0)과 바깥 여백 포함 높이 */
function stackedFloats(c: CellModel): Array<{ el: Element; vo: number; h: number; omT: number }> {
  const out: Array<{ el: Element; vo: number; h: number; omT: number }> = []
  for (const p of c.sub ? elements(c.sub) : []) if (ln(p) === "p") for (const run of elements(p)) if (ln(run) === "run") for (const o of elements(run)) {
    if (ln(o) !== "pic") continue
    const pos = findChildByLocalName(o, "pos")
    if (!pos || pos.getAttribute("treatAsChar") === "1" || (pos.getAttribute("vertRelTo") ?? "PARA") !== "PARA" || pos.getAttribute("allowOverlap") !== "0") continue
    const wrap = o.getAttribute("textWrap") ?? "TOP_AND_BOTTOM"
    if (wrap !== "SQUARE" && wrap !== "TOP_AND_BOTTOM") continue
    const om = findChildByLocalName(o, "outMargin"), raw = num(pos, "vertOffset")
    out.push({ el: o, vo: Math.max(0, raw >= 2 ** 31 ? raw - 2 ** 32 : raw), h: num(findChildByLocalName(o, "sz"), "height") + num(om, "top") + num(om, "bottom"), omT: num(om, "top") })
  }
  return out
}

/**
 * 칸 subList 최상위 문단 줄 — 연속 좌표 [위, 아래]와 그 줄. 한컴이 이미 칸을 쪽에서 갈라 저장한 칸은 줄 vertpos 가 다음 쪽 기준 0 으로
 * 되돌아간다(한컴 저장본: 20020 → 0) — 되돌아가는 곳마다 앞 줄 끝(+간격)에 잇는다. 첫 줄(vertpos 0)만 앞 쪽에 남기고 가른 칸은
 * 다음 줄도 0 이라 되돌아가지 않는다 — 같은 vertpos 가 같거나 왼쪽 가로 위치에서 다시 오면 그것도 쪽 나눔이다(본문 쪽 판정과 같다)
 */
export function cellLineBoxes(c: CellModel): Array<{ seg: Element; top: number; bottom: number; part: number; origin: number }> {
  const out: Array<{ seg: Element; top: number; bottom: number; part: number; origin: number }> = []
  let shift = 0, prevV = Number.NEGATIVE_INFINITY, prevH = 0, prevSavedEnd = 0, prevEnd = 0, part = 0
  // 칸 안 다단은 되돌아감이 다음 단이다 — 쪽 나눔으로 잇지 않는다
  const cols = cellColumns(c.sub)
  for (const p of c.sub ? elements(c.sub) : []) if (ln(p) === "p") {
    const lsa = findChildByLocalName(p, "linesegarray")
    for (const sg of lsa ? elements(lsa) : []) if (ln(sg) === "lineseg") {
      const v = num(sg, "vertpos"), hz = num(sg, "horzpos")
      // 앞 줄이 그 자리에서 끝났으면(간격 음수로 겹친 빈 문단) 같은 vertpos 라도 쪽 나눔이 아니다
      if ((v < prevV || (v === prevV && hz <= prevH && prevSavedEnd > v)) && !cols) { shift = prevEnd - v; part++ }
      prevV = v
      prevH = hz
      prevSavedEnd = v + num(sg, "vertsize") + num(sg, "spacing")
      const top = v + shift, bottom = top + num(sg, "vertsize")
      prevEnd = bottom + num(sg, "spacing")
      // origin = 이 부분(쪽)의 저장 좌표 0 의 연속 좌표 — 쪽 안 줄 위치는 저장 vertpos 그대로(앞 간격 포함)
      out.push({ seg: sg, top, bottom, part, origin: shift })
    }
  }
  return out
}
function cellLines(c: CellModel): [number, number][] {
  return cellLineBoxes(c).map(b => [b.top, b.bottom])
}

/**
 * @param rowH 행 높이(그리기와 같은 값)
 * @param ty 표 위(절대), MT·BODY_H 본문 위·높이. BODY_H 0 이면 나누지 않는다
 * @returns 행마다 조각 목록
 */
/**
 * 갈린 칸 줄(seg, 그 줄 위 절대 y)에 앵커한 떠 있는 표가 쪽을 넘으면 그 표 마지막 조각의 쪽 차이와 바닥(절대). nested 는 그런 칸 안의 표 계획.
 * contMT 는 이어진 쪽에서 그 칸 내용이 시작하는 자리(바깥 표의 이어진 쪽 위 + 칸 위 여백) — 안쪽 표는 거기서 다시 시작한다
 */
export type CellFloatSpan = (seg: Element, top: number, contMT?: number) => { pages: number; endY: number; el?: Element } | undefined

/**
 * 여러 행 칸의 저장 부분(칸 줄 vertpos 되돌아감) 경계 행 — 부분마다 그 높이(+칸 여백)를 채운 다음 행에서 다음 부분이 시작한다.
 * 부분 높이를 채우는 행 경계가 칸 안에 없으면 버린다
 */
export function spanPartRows(cells: CellModel[], rowY: number[]): Set<number> {
  const out = new Set<number>()
  for (const c of cells) {
    if (c.rs < 2) continue
    const bs = cellLineBoxes(c)
    const parts = bs.length ? bs[bs.length - 1].part : 0
    let s = c.ra
    for (let k = 0; k < parts; k++) {
      const inK = bs.filter(b => b.part === k)
      if (!inK.length) break
      const ext = Math.max(...inK.map(b => b.bottom)) - inK[0].origin + c.marginT + c.marginB
      let r = s + 1
      while (r < c.ra + c.rs && rowY[r] - rowY[s] < ext - 100) r++
      if (r >= c.ra + c.rs) break
      out.add(r); s = r
    }
  }
  return out
}

/** 글 없는 문단에서 앞 위아래 배치 개체 뒤에 앵커한 문단 기준 위아래 배치 표인가 */
function coAnchoredFollower(tbl: Element): boolean {
  const isTb = (o: Element): boolean => {
    const pos = findChildByLocalName(o, "pos")
    return !!pos && pos.getAttribute("treatAsChar") !== "1" && (pos.getAttribute("vertRelTo") ?? "PARA") === "PARA" && (o.getAttribute("textWrap") ?? "TOP_AND_BOTTOM") === "TOP_AND_BOTTOM"
  }
  const p = tbl.parentNode?.parentNode as Element | null
  if (!p || ln(p) !== "p" || !isTb(tbl)) return false
  let seen = false
  for (const run of elements(p)) if (ln(run) === "run") for (const o of elements(run)) {
    if (ln(o) === "t" && (o.textContent ?? "").trim() !== "") return false
    if (o === tbl) return seen
    if ((ln(o) === "tbl" || ln(o) === "pic") && isTb(o)) seen = true
  }
  return false
}

export function planTableRows(tbl: Element, cells: CellModel[], rowH: number[], ty: number, MT: number, BODY_H: number, slack = 0, floatSpan?: CellFloatSpan, nested = false, contMT = MT): RowPiece[][] {
  // 갈린 칸 안의 표는 아래 여백으로 넘치지 않는다 — 본문 바닥에서 가른다(한컴 PDF: 칸 안 서식 표가 본문 바닥 아래 34pt 를 다음 쪽 맨 위에)
  if (nested) slack = 0
  const nRows = rowH.length
  const rowY = [0]
  for (const h of rowH) rowY.push(rowY[rowY.length - 1] + h)
  const plain = (): RowPiece[][] => rowH.map((h, r) => [{ page: 0, y: ty + rowY[r], h }])
  const pageBottom = MT + BODY_H
  // 첫 쪽에서 표 전체가 아래 여백 안에서 끝나면 가르지 않는다(한컴 PDF: 쪽보다 조금 큰 서식 표 하나짜리 문서가 1쪽)
  // 겹치지 않게 쌓이는 칸 안 개체가 행보다 높으면 쌓은 높이로 판정한다(아래 쌓기 조각)
  const stackOver = tbl.getAttribute("pageBreak") === "CELL" && rowH.some((h, r) => {
    const rc = cells.filter(c => c.ra === r && c.rs === 1)
    if (rc.length !== 1) return false
    const st = stackedFloats(rc[0])
    return st.length >= 2 && st.reduce((a, f) => a + f.h, 0) > h
  })
  // 한컴이 칸 줄을 쪽에서 갈라 저장한 표(칸 안 줄 vertpos 가 되돌아감)는 아래 여백으로 넘치지 않는다 — 저장본이 이미 다음 쪽 조각을 적었다
  // (한컴 PDF: 아래 여백 안에서 끝날 서식 표가 칸 줄 되돌아간 자리부터 2쪽)
  if (slack > 0 && ty + rowY[nRows] > pageBottom && ty + rowY[nRows] <= pageBottom + slack && cells.some(c => cellLineBoxes(c).some(b => b.part > 0))) slack = 0
  // 저장 표 높이(sz)가 안쪽 행 경계와 같아도 — 한컴이 첫 쪽 조각만 sz 에 적었다(행 사이에서 가른 표) — 넘침 여유를 주지 않는다
  // (같은 판이 저장·인쇄한 한컴 PDF: sz 71,649 = 26행 경계인 27행 표의 마지막 행이 다음 쪽)
  if (slack > 0 && ty + rowY[nRows] > pageBottom && ty + rowY[nRows] <= pageBottom + slack) {
    const declared = num(findChildByLocalName(tbl, "sz"), "height")
    if (rowY.some((v, k) => k > 0 && k < nRows && Math.abs(v - declared) <= 2)) slack = 0
  }
  if (BODY_H <= 0 || (ty + rowY[nRows] <= pageBottom + slack) && !stackOver) return plain()
  // 글자처럼 취급하는 표는 쪽에서 가르지 않는다 — 쪽 맨 위에 있으면 그 쪽에 잘리고(한컴 PDF: 용지를 6567 넘는 인라인 서식 표도 1쪽),
  // 아니면 표째 다음 쪽 맨 위로(한컴 PDF: 앞 표 아래 49105 에 저장된 인라인 표가 다음 쪽에 찍힌다)
  if (findChildByLocalName(tbl, "pos")?.getAttribute("treatAsChar") === "1") {
    // 넘침은 저장된 표 높이(sz)로 판정 — 칸 안 떠 있는 개체까지 잰 높이는 한컴 줄 높이보다 클 수 있다(쪽 영역 밖 그림)
    const declared = num(findChildByLocalName(tbl, "sz"), "height") || rowY[nRows]
    if (ty - MT < 2000 || ty + declared <= pageBottom + slack) return plain()
    return rowH.map((h, r) => [{ page: 1, y: MT + rowY[r], h }])
  }
  let hdrRows = 0
  if (tbl.getAttribute("repeatHeader") === "1") while (hdrRows < nRows && cells.some(c => c.ra === hdrRows) && cells.filter(c => c.ra === hdrRows).every(c => c.el.getAttribute("header") === "1")) hdrRows++
  // 이어진 쪽의 표는 본문 위 + 표 바깥 위 여백에서 다시 시작한다(한컴 PDF: 바깥 위 여백 283 인 표의 이어진 쪽 칸 틀이 본문 위 아래 2.8pt)
  // 갈린 칸 안의 표는 이어진 쪽에서 그 칸 내용 위(contMT)부터 — 한컴 PDF: 바깥 표 여백 141·칸 위 여백 283 아래 안쪽 표 여백 141 에서 다시 시작
  const contTop = contMT + num(findChildByLocalName(tbl, "outMargin"), "top") + rowY[hdrRows]
  const outB = num(findChildByLocalName(tbl, "outMargin"), "bottom")
  const cellSplit = tbl.getAttribute("pageBreak") === "CELL"
  const out: RowPiece[][] = []
  // 문단을 따라 흐르는 표가 쪽 위가 아닌 자리에서 첫 행을 못 놓으면(칸 첫 줄도 안 들거나 행이 넘치면) 다음 행처럼 표째 다음 쪽 맨 위로
  // (같은 판이 저장·인쇄한 한컴 PDF: 쪽 바닥 72749 에 앵커한 위아래 배치 10행 표가 통째 다음 쪽 — 저장본도 표 뒤 문단이 다음 쪽 vertpos 23096 = 표 sz)
  const flows = (findChildByLocalName(tbl, "pos")?.getAttribute("vertRelTo") ?? "PARA") === "PARA"
  let page = 0, y = ty, first = !flows || ty - MT < 2000
  // 같은 글 없는 문단에 앞 위아래 배치 개체와 함께 앵커해 그 아래 쌓인 표는 한 쪽에 다 들면 가르지 않고 표째 다음 쪽 맨 위로
  // (한컴 PDF: 쪽 높이 표 아래 쌓인 21행 표가 1쪽에 머리 행만 남기지 않고 2쪽 본문 위 + 바깥 위 여백에서 시작)
  if (!first && coAnchoredFollower(tbl)) {
    const outT = num(findChildByLocalName(tbl, "outMargin"), "top")
    if (outT + rowY[nRows] + outB <= BODY_H) return rowH.map((h, r) => [{ page: 1, y: contMT + outT + rowY[r], h }])
  }
  const spanStarts = cellSplit ? spanPartRows(cells, rowY) : new Set<number>()
  for (let r = 0; r < nRows; r++) {
    let h = rowH[r]
    const pieces: RowPiece[] = []
    // 여러 행 칸을 한컴이 쪽에서 갈라 저장했으면 다음 부분이 시작하는 행부터 다음 쪽(같은 판 PDF: 세 행 칸 "다음 상한까지 …" 의
    // 둘째 부분 50~1000 이 다음 쪽 "범주Ⅲ" 행부터, 앞 쪽은 첫 부분 높이를 채운 행까지)
    if (!first && r >= hdrRows && spanStarts.has(r)) { page++; y = contTop; first = true }
    // 칸 안 나눔은 이 행의 한 행짜리 칸 줄로 가른다(reflow 와 같다) — 여러 행에 걸친 칸은 가르지 않고 그 행 위치에 그린다
    const rowCells = cells.filter(c => c.ra === r && c.rs === 1)
    const splittable = cellSplit && r >= hdrRows && rowCells.length > 0
    // 한 칸 행의 겹치지 않는 떠 있는 개체가 쪽을 넘게 쌓이면 개체째 다음 쪽 맨 위로 — 조각은 그 쪽 개체 바닥 + 칸 아래 여백까지
    // (한컴 PDF: 칸 하나의 쪽 높이 사진 다섯 장이 쪽마다 한 장, 둘째 쪽부터는 위 오프셋 −3360 을 버리고 칸 위 여백 아래)
    const stack = splittable && rowCells.length === 1 ? stackedFloats(rowCells[0]) : []
    if (stack.length >= 2) {
      const c = rowCells[0]
      let top = y, bottom = y + c.marginT, k = 0
      const pcs: RowPiece[] = []
      let place = new Map<Element, number>()
      for (const f of stack) {
        let at = k === 0 ? top + c.marginT + f.vo : bottom
        if (k > 0 && at + f.h > pageBottom - c.marginB) {
          pcs.push({ page, y: top, h: bottom - top + c.marginB, range: new Map([[c.el, pcs.length ? [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY] : [0, Number.POSITIVE_INFINITY]]]), place })
          page++; top = contTop; place = new Map(); at = top + c.marginT; bottom = at
        }
        place.set(f.el, at + f.omT)
        bottom = Math.max(bottom, at + f.h); k++
      }
      if (pcs.length) {
        pcs.push({ page, y: top, h: bottom - top + c.marginB, range: new Map([[c.el, [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY]]]), place })
        out.push(pcs)
        y = bottom + c.marginB; first = false
        continue
      }
    }
    // 한컴이 이 행을 이미 쪽에서 갈라 저장했으면(칸 줄 vertpos 되돌아감) 그 자리 그대로 가른다
    const boxes = splittable ? new Map(rowCells.map(c => [c.el, cellLineBoxes(c)] as const)) : undefined
    const hParts = boxes ? Math.max(0, ...[...boxes.values()].flatMap(bs => bs.map(b => b.part))) : 0
    if (boxes && hParts > 0) {
      // 첫 조각의 첫 줄도 이 쪽 남은 자리에 안 들면 행째 다음 쪽에서 가른다 — 칸 줄 나눔과 같은 판정(위 여백 + 줄 바닥 ≤ 남은 높이 − 아래 여백)
      // (같은 판이 저장·인쇄한 한컴 PDF: 쪽 바닥 858 남은 자리의 갈라 저장한 행은 다음 쪽 맨 위부터 저장 줄 0~73600)
      if (!first && rowCells.some(c => { const b = (boxes.get(c.el) ?? []).find(x => x.part === 0); return !!b && c.marginT + b.bottom - b.origin > pageBottom - y - c.marginB })) { page++; y = contTop; first = true }
      const declared = num(findChildByLocalName(tbl, "sz"), "height")
      /** 부분 첫 줄에 앵커한 표로 이미 앞 쪽을 채운 줄 — 아래 '부분 줄의 표' 넘김에서 다시 세지 않는다 */
      const led = new Set<Element>()
      let firstPh = 0
      for (let k = 0; k <= hParts; k++) {
        // 부분 첫 줄이 그 줄에 앵커한 쪽을 넘는 표의 끝 쪽 기준으로 저장됐으면(표 아래로 밀린 줄) 표는 이 부분 시작 쪽 맨 위부터 그리고,
        // 부분 줄은 표가 끝나는 쪽에서 — 사이 쪽은 줄 없는 조각(한컴 PDF: 칸이 갈린 뒤 첫 줄 30744 = 네 쪽에 걸친 표 끝 쪽 아래의 줄, 표는 앞 쪽 맨 위)
        if (k > 0 && floatSpan) {
          let lead = 0, place: Map<Element, number> | undefined
          for (const c of rowCells) {
            const b = (boxes.get(c.el) ?? []).find(x => x.part === k)
            if (!b) continue
            const f = floatSpan(b.seg, y + c.marginT, contTop + c.marginT)
            if (f?.el && f.pages > 0 && f.pages > lead && Math.abs(contTop + c.marginT + b.top - b.origin - f.endY) < 3000) { lead = f.pages; place = new Map([[f.el, y + c.marginT]]); led.add(b.seg) }
          }
          if (lead > 0) {
            const none = new Map(rowCells.map(c => [c.el, [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY] as [number, number]]))
            for (let e = 0; e < lead; e++) pieces.push({ page: page + e, y: contTop, h: pageBottom - contTop, range: none, place: e === 0 ? place : undefined })
            page += lead
          }
        }
        const range = new Map<Element, [number, number]>()
        let ext = 0, toNext = 0
        for (const c of rowCells) {
          const bs = boxes.get(c.el) ?? []
          const inK = bs.filter(b => b.part === k), next = bs.find(b => b.part > k)
          // 조각 원점 = 이 부분의 저장 좌표 0 — 첫 줄 앞 간격(저장 vertpos)을 살린다(한컴 PDF: 갈린 칸 쪽 첫 줄이 vertpos 1000 만큼 아래)
          const from = inK[0]?.origin ?? next?.origin ?? Number.POSITIVE_INFINITY
          range.set(c.el, [from, next?.top ?? Number.POSITIVE_INFINITY])
          if (inK.length) ext = Math.max(ext, inK[inK.length - 1].bottom - from + c.marginT + c.marginB)
          // 마지막 조각은 그 조각 줄에 앵커한 위아래 배치 개체 바닥까지 — 한컴 PDF: 갈린 칸 둘째 쪽 끝 줄에 앵커한 6행 표(8556) 아래 칸 여백까지가 조각
          if (k === hParts && inK.length && c.sub) for (const f of subFloatBottoms(c.sub)) {
            const b = bs.find(x => x.seg === f.seg)
            if (b && b.part === k) ext = Math.max(ext, b.top + f.bottom - f.v0 - from + c.marginT + c.marginB)
          }
          if (inK.length && next) toNext = Math.max(toNext, next.top - from + c.marginT + c.marginB)
        }
        const last = k === hParts
        // 한컴은 갈라 저장한 표의 sz 높이에 첫 쪽 높이를 담는다(PDF: 첫 쪽 상자 65300, sz 65362) — 가운데 쪽은 다음 쪽 첫 줄 위까지 + 칸 여백(PDF 68820, 계산 68810)
        // (sz 가 첫 부분 내용보다 작으면 저장값이 첫 쪽 높이가 아니다 — 쪽 바닥까지). 첫 쪽 조각은 그 행 칸 저장 높이와 이 쪽 내용 중 큰 것을 넘지 않는다
        // (같은 판이 저장·인쇄한 한컴 PDF: 48행 표의 갈린 행 첫 쪽 칸 틀이 칸 높이 2116 에서 끝나고 쪽 바닥까지 17pt 가 빈다 — 가운데 칸 글도 그 안에서 맞춘다)
        const cellH = Math.max(0, ...rowCells.map(c => num(findChildByLocalName(c.el, "cellSz"), "height")))
        const firstH = Math.min(declared > 0 && ty + declared - y >= ext ? Math.min(pageBottom - y, ty + declared - y) : pageBottom - y, Math.max(ext, cellH))
        // 두 쪽에 갈린 행의 가운데·아래 정렬 칸(칸 높이 고정 표는 모든 칸)은 글이 덜 차도 저장 높이만큼 선다 — 다음 쪽 조각은 칸 저장 높이에서
        // 첫 쪽 조각을 뺀 만큼(조판과 같은 규칙. 같은 판 PDF: 가운데 정렬 63,539 칸의 다음 쪽 조각 305.58pt, 남은 글만 세면 304.26pt)
        // (몫이 다음 쪽에 다 들지 않으면 칸 저장 높이는 두 쪽 나눔과 맞지 않는다 — 한컴이라면 또 갈랐을 것이니 남은 글만 센다)
        const share = last && k === 1 ? Math.max(0, ...rowCells.filter(c => tbl.getAttribute("noAdjust") === "1" || /^(CENTER|BOTTOM)$/.test(c.sub?.getAttribute("vertAlign") ?? "")).map(c => c.h - firstPh).filter(v => v <= pageBottom - contTop)) : 0
        const ph = last ? Math.max(ext, share) : k === 0 ? firstH : toNext > 0 ? Math.min(pageBottom - contTop, toNext) : pageBottom - contTop
        if (k === 0) firstPh = ph
        pieces.push({ page, y, h: ph, range })
        if (!last) {
          // 이 부분 줄에 앵커한 떠 있는 표가 쪽을 넘으면(칸 안 중첩 표) 다음 부분은 그 표가 끝나는 쪽 — 사이 쪽은 줄 없는 조각(칸 틀만).
          // 다음 부분 첫 줄이 표 끝보다 위에 저장돼 있으면 그다음 쪽(한컴 PDF: 쪽 셋에 걸친 칸 안 표 뒤 칸 글이 표 끝 쪽 아래)
          let span = 0, spanEnd = 0
          if (floatSpan) for (const c of rowCells) {
            const bs = (boxes.get(c.el) ?? []).filter(b => b.part === k), from = bs[0]?.origin ?? 0
            for (const b of bs) { if (led.has(b.seg)) continue; const f = floatSpan(b.seg, y + c.marginT + b.top - from, contTop + c.marginT); if (f && f.pages > span) { span = f.pages; spanEnd = f.endY } }
          }
          if (span > 0) {
            const nextTop = Math.min(...rowCells.map(c => { const b = (boxes.get(c.el) ?? []).find(x => x.part === k + 1); return b ? contTop + c.marginT + b.top - b.origin : Number.POSITIVE_INFINITY }))
            const skip = nextTop < spanEnd - 100 ? span + 1 : span
            for (let e = 1; e < skip; e++) pieces.push({ page: page + e, y: contTop, h: pageBottom - contTop, range: new Map(rowCells.map(c => [c.el, [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY]])) })
            page += skip
          } else page++
          y = contTop; first = true
        } else h = ph
      }
      out.push(pieces)
      y += h; first = false
      continue
    }
    // 갈라 저장되지 않은 칸의 줄에 앵커한 떠 있는 표가 쪽을 넘으면 칸 틀은 그 표가 끝나는 쪽까지 잇는다 — 칸 줄은 다 첫 조각,
    // 사이 쪽은 줄 없는 조각, 끝 쪽 조각은 표 바닥 + 칸 아래 여백까지(같은 판이 저장·인쇄한 한컴 PDF: 칸 하나짜리 별표 서식 안의 26행 표가 세 쪽)
    if (boxes && floatSpan) {
      let span = 0, spanEnd = 0, mB = 0
      for (const c of rowCells) for (const b of boxes.get(c.el) ?? []) {
        const f = floatSpan(b.seg, y + c.marginT + b.top, contTop + c.marginT)
        if (f && f.pages > span) { span = f.pages; spanEnd = f.endY; mB = c.marginB }
      }
      if (span > 0) {
        const none = new Map(rowCells.map(c => [c.el, [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY] as [number, number]]))
        pieces.push({ page, y, h: pageBottom - y, range: new Map(rowCells.map(c => [c.el, [0, Number.POSITIVE_INFINITY] as [number, number]])), fill: true })
        for (let e = 1; e < span; e++) pieces.push({ page: page + e, y: contTop, h: pageBottom - contTop, range: none, fill: true })
        page += span
        const endH = Math.max(0, spanEnd - contTop) + mB
        pieces.push({ page, y: contTop, h: endH, range: none })
        out.push(pieces)
        y = contTop + endH; first = false
        continue
      }
    }
    // 칸 안 나눔 표도 행 바닥 + 표 바깥 아래 여백이 본문 바닥 안이어야 그 쪽에 다 놓인다 — 조판(splitTableRows)과 같은 판정
    // (같은 판 한컴 PDF: 남은 10,527 에 행 바닥 10,389 가 들어도 바깥 아래 283 을 더하면 넘어 그 행부터 다음 쪽, 저장 sz 9,107 = 앞 쪽 몫)
    if (splittable && y + h + outB > pageBottom) {
      const from = new Map<Element, number>()
      const lines = new Map(rowCells.map(c => [c.el, cellLines(c)] as const))
      while (y + h + outB > pageBottom && BODY_H > rowY[hdrRows]) {
        const avail = pageBottom - y - outB
        let rem = 0, placed = false, allFit = true, blocked = false
        const cuts: [Element, number, number][] = []
        for (const c of rowCells) {
          const off = from.get(c.el) ?? 0
          const ls = (lines.get(c.el) ?? []).filter(l => l[0] >= off)
          if (!ls.length) { cuts.push([c.el, off, off]); continue }
          const end = Math.max(...ls.map(l => l[1]))
          const k = ls.findIndex(l => c.marginT + (l[1] - off) > avail - c.marginB)
          if (k < 0) { cuts.push([c.el, off, end + 1]); continue }
          allFit = false
          if (k > 0) placed = true
          // 첫 줄부터 못 놓는 칸이 있으면(그림 줄 등) 행을 가르지 않고 행째 다음 쪽 — 한컴 PDF: 섬네일 칸이 안 드는 수상작 행이 글 칸 첫 줄까지 다음 쪽
          else if (off === 0) blocked = true
          cuts.push([c.el, off, ls[k][0]])
          rem = Math.max(rem, end - ls[k][0] + c.marginT + c.marginB)
        }
        if (allFit) {
          // 칸 글은 다 들어가고 행 높이만 쪽을 넘는다 — 다음 쪽에 통째로 들어가는 행이면 행째 다음 쪽(한컴 PDF: 저장 높이 21905 사진 행이
          // 쪽 바닥에서 잘리지 않고 다음 쪽 맨 위에서 시작), 다음 쪽에도 안 들어가면 이 쪽 바닥까지(남는 높이는 버린다)
          // 이 행에서 시작하는 여러 행 칸의 글도 이 쪽 조각에 들어야 한다(같은 판 한컴 PDF: 두 줄 병합 칸이 쪽 바닥 남은 자리에 안 드는 연락처 표가 통째 다음 쪽)
          const spanCells = cells.filter(c => c.ra === r && c.rs > 1)
          if (!first && h <= pageBottom - contTop && [...rowCells, ...spanCells].some(c => cellContentExtent(c) + c.marginT + c.marginB > avail)) { page++; y = contTop; first = true; break }
          // 갈린 칸 안의 표는 남는 행 높이를 버리지 않고 다음 쪽 맨 위에 잇는다(같은 PDF: 빈 행 조각 34pt). 본문 표는 이 쪽 바닥까지
          if (nested && avail > 0) {
            pieces.push({ page, y, h: avail, range: new Map(rowCells.map(c => [c.el, [from.get(c.el) ?? 0, Number.POSITIVE_INFINITY]])) })
            for (const c of rowCells) from.set(c.el, Number.POSITIVE_INFINITY)
            page++; y = contTop; first = true; h -= avail
            continue
          }
          h = avail
          break
        }
        if (blocked && !first) { page++; y = contTop; first = true; continue }
        if (!placed) {
          // 이 쪽에 한 줄도 못 놓는다 — 쪽 맨 위면 그대로 넘치게 두고, 아니면 행째 다음 쪽
          if (first) break
          page++; y = contTop; first = true
          continue
        }
        pieces.push({ page, y, h: avail, range: new Map(cuts.map(([el, a, b]) => [el, [a, b]])) })
        for (const [el, , b] of cuts) from.set(el, b)
        page++; y = contTop; first = true; h = rem
      }
      pieces.push({ page, y, h, range: new Map(rowCells.map(c => [c.el, [from.get(c.el) ?? 0, Number.POSITIVE_INFINITY]])) })
      out.push(pieces)
      y += h; first = false
      continue
    }
    // 행 단위 표는 행 바닥 + 표 바깥 아래 여백이 본문 바닥을 넘으면 그 행부터 다음 쪽 — reflow 와 같은 판정(한컴 PDF: 바깥 아래 141 인
    // 96행 표가 바닥 70018 에 행 바닥 69901 이 드는데도 그 행을 다음 쪽 머리 행 아래로 넘긴다). 칸 안 나눔 표의 행은 위에서 칸 줄로 가른다
    if (!first && y + h + (cellSplit ? 0 : outB) > pageBottom && r >= hdrRows) { page++; y = contTop; first = true }
    // 칸을 쪼개지 않는 표(나눔 TABLE)는 여러 행 칸이 묶은 행들을 쪼갤 수 없다 — 묶음 첫 행에서 묶음 전체가 이 쪽에 안 들면 묶음째 다음 쪽
    // (한컴 PDF: 두 행 병합 칸 "3 BOM 자동 작성 정확도" 묶음의 첫 행이 앞 쪽에 들어도 두 행을 함께 다음 쪽 맨 위로)
    else if (!first && tbl.getAttribute("pageBreak") === "TABLE" && r >= hdrRows && !cells.some(c => c.ra < r && c.ra + c.rs > r)) {
      let end = r + 1
      for (let grown = true; grown;) { grown = false; for (const c of cells) if (c.ra >= r && c.ra < end && c.ra + c.rs > end) { end = c.ra + c.rs; grown = true } }
      const groupH = rowY[Math.min(end, nRows)] - rowY[r]
      if (end > r + 1 && y + groupH + outB > pageBottom && groupH <= pageBottom - contTop) { page++; y = contTop; first = true }
    }
    out.push([{ page, y, h }])
    y += h; first = false
  }
  return out
}
