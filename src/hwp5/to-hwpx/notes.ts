/**
 * HWP 5.x 나머지 컨트롤 → HWPX: 머리말·꼬리말('head'·'foot'), 각주·미주('fn  '·'en  '), 자동 번호('atno'), 새 번호('nwno'),
 * 쪽 번호 위치('pgnp'), 감추기('pghd'), 쪽 번호 제어('pgct'), 책갈피('bokm'), 찾아보기 표시('idxm'), 글자 겹치기('tcps'),
 * 덧말('tdut'), 수식('eqed').
 *
 * 컨트롤 데이터는 CTRL_HEADER 의 컨트롤 id(4바이트) 뒤에 온다. 글을 담는 컨트롤(머리말·각주 …)은 자식 LIST_HEADER 와 뒤따르는
 * 형제 문단을 hp:subList 로 쓴다.
 */

import { Cur, type RecNode, el, esc, escText, color, pick, bit, bits, NUM_FORMATS } from "./util.js"
import { paragraphsXml } from "./section.js"
import { type ConvertContext, type CtrlXml, readObjCommon, objHeadAttrs, objPlacementXml, subListAttrs, listGroups, captionXml } from "./controls.js"

const NUM_TYPES = ["PAGE", "FOOTNOTE", "ENDNOTE", "PICTURE", "TABLE", "EQUATION", "TOTAL_PAGE"] as const
const PAGE_APPLY = ["BOTH", "EVEN", "ODD"] as const
const PAGE_NUM_POS = ["NONE", "TOP_LEFT", "TOP_CENTER", "TOP_RIGHT", "BOTTOM_LEFT", "BOTTOM_CENTER", "BOTTOM_RIGHT", "OUTSIDE_TOP",
  "OUTSIDE_BOTTOM", "INSIDE_TOP", "INSIDE_BOTTOM"] as const
const PAGE_STARTS = ["BOTH", "EVEN", "ODD"] as const
const COMPOSE_CIRCLES = ["CHAR", "SHAPE_CIRCLE", "SHAPE_REVERSAL_CIRCLE", "SHAPE_RECTANGLE", "SHAPE_REVERSAL_RECTANGLE", "SHAPE_TRIANGLE",
  "SHAPE_REVERSAL_TIRANGLE", "SHAPE_LIGHT", "SHAPE_RHOMBUS", "SHAPE_REVERSAL_RHOMBUS", "SHAPE_ROUNDED_RECTANGLE",
  "SHAPE_EMPTY_CIRCULATE_TRIANGLE", "SHAPE_THIN_CIRCULATE_TRIANGLE", "SHAPE_THICK_CIRCULATE_TRIANGLE"] as const
const DUTMAL_POS = ["TOP", "BOTTOM", "CENTER"] as const
const DUTMAL_ALIGN = ["JUSTIFY", "LEFT", "RIGHT", "CENTER", "DISTRIBUTE", "DISTRIBUTE_SPACE"] as const

const data = (node: RecNode): Cur => new Cur(node.rec.data, 4)
const ch = (code: number): string => (code ? String.fromCharCode(code) : "")
const ctrl = (xml: string): CtrlXml => ({ xml: `<hp:ctrl>${xml}</hp:ctrl>`, obj: false })

/** 글 목록(LIST_HEADER + 문단) → hp:subList. 머리말·꼬리말은 목록 머리에 글 너비·높이·참조 표시가 더 있다 */
function subListXml(node: RecNode, ctx: ConvertContext, sized: boolean): string {
  const g = listGroups(node.kids)[0]
  if (!g) return ""
  let extra: Array<[string, string | number]> | undefined
  if (sized) {
    const c = new Cur(g.head.rec.data, 8)
    const w = c.u32(), h = c.u32(), textRef = c.u8(), numRef = c.u8()
    extra = [["textWidth", w], ["textHeight", h], ["hasTextRef", textRef], ["hasNumRef", numRef]]
  }
  const list = subListAttrs(g.head.rec.data)
  if (extra) for (const [k, v] of extra) { const i = list.findIndex(([n]) => n === k); if (i >= 0) list[i] = [k, v] }
  return el("hp:subList", list, paragraphsXml(g.paras, ctx))
}

/** 확장 컨트롤 id → 요소 (모르는 컨트롤은 null) */
export function otherControlXml(id: string, node: RecNode, ctx: ConvertContext): CtrlXml | null {
  switch (id) {
    case "head":
    case "foot": {
      const a = data(node).u32()
      return ctrl(el(id === "head" ? "hp:header" : "hp:footer", [["id", ctx.headerFooterId++], ["applyPageType", pick(PAGE_APPLY, bits(a, 0, 2))]],
        subListXml(node, ctx, true)))
    }
    case "fn  ":
    case "en  ": {
      const c = data(node)
      const number = c.u32() & 0xffff, prefix = c.u16(), suffix = c.u16()
      c.u32()
      const instId = c.u32()
      const attrs: Array<[string, string | number]> = [["number", number]]
      if (id === "en  " || prefix) attrs.push(["prefixChar", prefix])
      attrs.push(["suffixChar", suffix], ["instId", instId])
      return ctrl(el(id === "fn  " ? "hp:footNote" : "hp:endNote", attrs, subListXml(node, ctx, false)))
    }
    case "atno": {
      const c = data(node)
      const a = c.u32(), num = c.u16(), user = c.u16(), prefix = c.u16(), suffix = c.u16()
      return ctrl(el("hp:autoNum", [["num", num], ["numType", pick(NUM_TYPES, bits(a, 0, 4))]],
        el("hp:autoNumFormat", [["type", pick(NUM_FORMATS, bits(a, 4, 8))], ["userChar", ch(user)], ["prefixChar", ch(prefix)],
          ["suffixChar", ch(suffix)], ["supscript", bit(a, 12)]])))
    }
    case "nwno": {
      const c = data(node)
      const a = c.u32(), num = c.u16()
      return ctrl(el("hp:newNum", [["num", num], ["numType", pick(NUM_TYPES, bits(a, 0, 4))]]))
    }
    case "pgnp": {
      const c = data(node)
      const a = c.u32()
      c.u16(); c.u16(); c.u16()
      const side = c.u16()
      return ctrl(el("hp:pageNum", [["pos", pick(PAGE_NUM_POS, bits(a, 8, 4))], ["formatType", pick(NUM_FORMATS, bits(a, 0, 8))], ["sideChar", ch(side)]]))
    }
    case "pghd": {
      const a = data(node).u32()
      return ctrl(el("hp:pageHiding", [["hideHeader", bit(a, 0)], ["hideFooter", bit(a, 1)], ["hideMasterPage", bit(a, 2)],
        ["hideBorder", bit(a, 3)], ["hideFill", bit(a, 4)], ["hidePageNum", bit(a, 5)]]))
    }
    case "pgct":
      return ctrl(el("hp:pageNumCtrl", [["pageStartsOn", pick(PAGE_STARTS, bits(data(node).u32(), 0, 2))]]))
    case "bokm": {
      const c = data(node)
      return ctrl(el("hp:bookmark", [["name", c.rest >= 2 ? c.str() : ""]]))
    }
    case "idxm": {
      const c = data(node)
      const first = c.str(), second = c.rest >= 2 ? c.str() : ""
      return ctrl(el("hp:indexmark", [], `<hp:firstKey>${escText(first)}</hp:firstKey>` + (second ? `<hp:secondKey>${escText(second)}</hp:secondKey>` : "")))
    }
    case "tcps": {
      const c = data(node)
      const text = c.str()
      const circle = c.u8(), size = c.i8(), expansion = c.u8(), n = c.u8()
      const ids: number[] = []
      for (let i = 0; i < n && c.rest >= 4; i++) ids.push(c.u32())
      return { obj: false, xml: el("hp:compose", [["circleType", pick(COMPOSE_CIRCLES, circle)], ["charSz", size],
        ["composeType", expansion ? "OVERLAP" : "SPREAD"], ["charPrCnt", ids.length], ["composeText", text]],
      ids.map(i => el("hp:charPr", [["prIDRef", i]])).join("")) }
    }
    case "tdut": {
      const c = data(node)
      const main = c.str(), sub = c.str()
      const pos = c.u32(), ratio = c.u32(), option = c.u32(), style = c.u32(), align = c.u32()
      return { obj: false, xml: el("hp:dutmal", [["posType", pick(DUTMAL_POS, pos)], ["szRatio", ratio], ["option", option],
        ["styleIDRef", style], ["align", pick(DUTMAL_ALIGN, align)]], `<hp:mainText>${escText(main)}</hp:mainText><hp:subText>${escText(sub)}</hp:subText>`) }
    }
    case "eqed":
      return { obj: true, xml: equationXml(node, ctx) }
    default:
      return null
  }
}

/** 수식 — 개체 공통 속성 + EQEDIT(속성·스크립트·기준 크기·색·기준선·판·글꼴) */
function equationXml(node: RecNode, ctx: ConvertContext): string {
  const o = readObjCommon(node)
  const desc = new Cur(node.rec.data, 44)
  const description = desc.rest >= 2 ? desc.str() : ""
  const eq = node.kids.find(k => k.rec.tagId === 0x58)
  const c = new Cur(eq?.rec.data ?? Buffer.alloc(0))
  const a = c.u32(), script = c.str(), baseUnit = c.u32(), textColor = c.u32(), baseLine = c.i16()
  c.u16()
  const version = c.rest >= 2 ? c.str() : "", font = c.rest >= 2 ? c.str() : ""
  const capIdx = node.kids.findIndex(k => k.rec.tagId === 0x58)
  const cap = listGroups(capIdx >= 0 ? node.kids.slice(0, capIdx) : [])[0]
  return el("hp:equation", [...objHeadAttrs(o), ["version", version], ["baseLine", baseLine], ["textColor", color(textColor)], ["baseUnit", baseUnit],
    ["lineMode", bit(a, 0) ? "LINE" : "CHAR"], ["font", font]],
  objPlacementXml(o) + (cap ? captionXml(cap, ctx) : "") + (description ? `<hp:shapeComment>${escText(description)}</hp:shapeComment>` : "")
    + `<hp:script${/^\s|\s$/.test(script) ? ' xml:space="preserve"' : ""}>${escText(script)}</hp:script>`)
}
