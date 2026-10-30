/** 떠 있는 개체의 기준계와 문단 원점 해석. 그리기 문맥에서 필요한 기하만 받는다. */
import { findChildByLocalName } from "../hwpx/parser-shared.js"
import { num, measureTableHeight, type ParaObj, type ParaModel, type ExtentMemo } from "./para-model.js"

interface AnchorContext {
  geom: { PW: number; PH: number; ML: number; MT: number; BODY_W: number; BODY_H: number }
  extentMemo: ExtentMemo
  bodyDx?: (page: number) => number
  page: number
}

/**
 * 글 없는 문단(위아래 개체 하나)의 줄이 개체에 밀려 저장됐는가 — 줄 = 문단 영역 위 + 바깥 위 + 저장 높이 + 바깥 아래.
 * 그런 줄은 제자리가 아니라 밀어내기 규칙을 따른다(한컴 저장본: 빈 문단 줄 68081 = 앞 문단 끝 7365 + 그림 60716)
 */
export function linePushedBy(o: ParaObj, lineV: number, paraTop: number | undefined): boolean {
  if (paraTop === undefined) return false
  const om = findChildByLocalName(o.el, "outMargin")
  // 문단 기준 아래 오프셋도 개체 몫이다(한컴 저장본: vertOffset 750 표에 밀린 빈 문단 줄 33738 = 앞 문단 끝 29540 + 750 + 바깥 여백 + 표 2882)
  const pos = findChildByLocalName(o.el, "pos")
  const raw = num(pos, "vertOffset"), vo = (pos?.getAttribute("vertRelTo") ?? "PARA") === "PARA" ? Math.max(0, raw >= 2 ** 31 ? raw - 2 ** 32 : raw) : 0
  return Math.abs(lineV - (vo + num(om, "top") + o.height + num(om, "bottom")) - paraTop) <= 10
}

export function anchorObject(o: ParaObj, ox: number, oy: number, baseV: number, areaW: number, ctx: AnchorContext, anchorLineV?: number, stayLine: number | false = false, paraStartV?: number, lineH?: number, lineSB = 0, anchorAt: "end" | "mid" | "top" = "end"): { x: number; y: number } {
  const { PW, PH, ML, MT, BODY_W, BODY_H } = ctx.geom
  const pos = findChildByLocalName(o.el, "pos")
  const om = findChildByLocalName(o.el, "outMargin")
  const omT = num(om, "top"), omB = num(om, "bottom")
  // 표는 셀 콘텐츠 성장으로 선언 sz보다 커질 수 있다 — reflow가 실효높이로 밀어낸 만큼
  // 되돌려야 표가 뒤 문단 위에 겹치지 않는다 (한컴 저장본은 sz가 실높이라 차이 없음)
  const w = o.width, h = o.tag === "tbl" ? Math.max(o.height, measureTableHeight(o.el, ctx.extentMemo)) : o.height
  if (!pos) return { x: ox, y: oy + baseV }
  const voRaw = num(pos, "vertOffset"), voS = voRaw >= 2 ** 31 ? voRaw - 2 ** 32 : voRaw
  // 문단 기준 개체를 위로 올린 오프셋(부호 없는 32비트 저장 −12126)은 문단 위에서 멈춘다 — reflow 와 같은 규칙(꼬리말 글상자가 121pt 위로 뜨던 것)
  const vo = (pos.getAttribute("vertRelTo") ?? "PARA") === "PARA" ? Math.max(0, voS) : voS
  const ho = num(pos, "horzOffset")
  const vrel = pos.getAttribute("vertRelTo") ?? "PARA"
  const hrel = pos.getAttribute("horzRelTo") ?? "PARA"
  const va = pos.getAttribute("vertAlign") ?? "TOP"
  const ha = pos.getAttribute("horzAlign") ?? "LEFT"
  const wrap = o.el.getAttribute("textWrap") ?? "TOP_AND_BOTTOM"

  let y: number
  if (vrel === "PAPER") {
    // 용지 기준 세로도 가로처럼 바깥 여백을 더한다(한컴 PDF: 바깥 위 852 인 용지 기준 그림이 vertOffset 5720 보다 8.5pt 아래)
    y = va === "BOTTOM" ? PH - h - vo - omB : va === "CENTER" ? (PH - h) / 2 + vo : vo + omT
  } else if (vrel === "PAGE") {
    y = va === "BOTTOM" ? MT + BODY_H - h - vo : va === "CENTER" ? MT + (BODY_H - h) / 2 + vo : MT + vo
  } else if (wrap === "TOP_AND_BOTTOM") {
    // PARA 밀어내기 역산 — 호스트 문단 vp가 개체(여백 포함)만큼 밀렸다는 모델 (실측 일치).
    // 음수면 밀지 않은 개체(빈 호스트 줄 등)로 보고 현재 흐름 y 사용.
    // 앵커 글자가 든 줄 기준 — 첫 줄 뒤에 앵커된 개체는 그 줄 위에 끼어 있다(reflow 와 같은 규칙, 한컴 저장본 연락처 표)
    const lineV = anchorLineV ?? baseV
    // 줄을 민 개체는 줄 바로 위에서 끝난다 — 아래 오프셋도 줄 위쪽 몫이다(문단 위 + 오프셋 + 바깥 위 + 높이 + 바깥 아래 = 줄)
    const pushed = lineV - (vo + omT + h + omB)
    // 글 없는 문단(위아래 개체 하나)의 줄은 제자리 — 개체는 줄 위치에서 시작한다(reflow 와 같은 규칙, 저장본 178/181). 꼬리말 글상자가 꼬리말 위로 뜨던 것
    // 글을 밀지 않은(줄 아래에 놓인) 첫 줄 앵커 개체는 문단 영역 위(앞 문단 끝, 위 간격 앞) 기준 — 한컴 PDF: 위 간격 뒤 줄 20056 의
    // 표가 앞 문단 끝 18856 + vertOffset 에 찍힌다(줄 기준이면 12pt 아래)
    // 첫 줄 뒤 앵커 개체가 세로 오프셋으로 앵커 줄보다 아래 놓이면 줄을 밀지 않는다 — 개체 위 = 앵커 줄 위 + 오프셋
    // (한컴 PDF: 인라인 표 줄 다음 줄에 앵커한 vertOffset 8455 로고 표가 그 줄 위 + 84.55pt + 바깥 위, 미는 모델이면 42.5pt 위)
    // 첫 줄에 앵커한 개체도 오프셋이 그 줄 높이 이상이면 줄 아래 — 줄을 밀지 않고 문단 영역 위(줄 − 위 간격) + 오프셋(한컴 저장본: 글 뒤에 앵커한
    // vertOffset 1877 표 아래 문단이 줄 24922 + 1877 + 표 높이, 미는 모델이면 앞 표 위에 겹쳐 그렸다). 앞 문단 줄 끝이 아니라 줄 자리에서 잰다 —
    // 앞 문단의 떠 있는 표 아래로 밀려 저장된 줄(한컴 저장본: 표 끝 34181 에 저장된 그림 문단 줄, 그림은 그 아래 783)
    // 줄이 바로 이 개체에 밀려 저장됐으면(문단 위 + 오프셋 + 개체 = 줄) 줄 아래가 아니다
    const below = lineH !== undefined && vo + omT >= lineH && !(paraStartV !== undefined && Math.abs(pushed - paraStartV) <= 10)
    const anchor = below ? lineV - lineSB : stayLine !== false ? lineV - stayLine : pushed >= -100 ? pushed : paraStartV !== undefined ? paraStartV : lineV
    y = oy + anchor + omT + vo
  } else {
    // BEHIND_TEXT/IN_FRONT/SQUARE — 문단을 밀지 않는 개체는 문단 원점 흐름 배치(어울림은 앵커 줄보다 위로 못 간다), 바깥 위 여백만큼 아래
    // (한컴 PDF: 바깥 위 850 인 어울림 사진이 vertOffset 자리보다 8.5pt 아래 — 가로가 바깥 왼쪽을 더하는 것과 같다)
    const origin = vrel === "PARA" && wrap === "SQUARE" ? paraStartV ?? baseV : baseV
    // 첫 줄 뒤 줄에 앵커한 어울림 개체는 그 줄 위 + 오프셋(위아래 배치의 나중 줄 앵커와 같다 — 같은 판 한컴 PDF: 여섯째 줄 24640 에 앵커한
    // vertOffset 2080 사진이 24640 + 2080, 문단 위 + 오프셋이면 20.5pt 위)
    // 문단 끝(뒤 글 없음)에 앵커한 것만 그 줄 기준. 문단 중간 글자 앵커는 앵커 줄보다 위로 못 가지만, 첫 줄부터 앵커 줄만큼 좁게 저장된
    // 문단(anchorAt "top")은 문단 위 기준(같은 판 한컴 PDF: 둘째 줄 글자에 앵커한 vertOffset 0 사진이 첫 줄 자리)
    const later = vrel === "PARA" && wrap === "SQUARE" && anchorAt === "end" && anchorLineV !== undefined && anchorLineV > baseV
    const midLater = vrel === "PARA" && wrap === "SQUARE" && anchorAt === "top" && anchorLineV !== undefined && anchorLineV > baseV
    y = later ? oy + anchorLineV + vo + omT : oy + Math.max(origin + vo, wrap === "SQUARE" && !midLater && anchorLineV !== undefined ? anchorLineV : -Infinity) + omT
  }

  let x: number
  // 바깥 여백: 왼쪽 정렬은 오프셋 + 바깥 왼쪽, 오른쪽 정렬은 − 바깥 오른쪽(한컴 PDF: 바깥 왼쪽 283 인 떠 있는 표 x = 왼 여백 + 2.83pt)
  const omL = num(om, "left"), omR = num(om, "right")
  if (hrel === "PAGE") {
    x = ha === "RIGHT" ? ML + BODY_W - w - ho - omR : ha === "CENTER" ? ML + (BODY_W - w) / 2 + ho : ML + ho + omL
  } else if (hrel === "PAPER") {
    // 용지 기준은 맞쪽 이동 묶음 밖 좌표 — 묶음 이동만큼 되돌린다
    x = (ha === "RIGHT" ? PW - w - ho - omR : ha === "CENTER" ? (PW - w) / 2 + ho : ho + omL) - (ctx.bodyDx?.(ctx.page) ?? 0)
  } else {
    // PARA/COLUMN — 현재 텍스트 영역 기준 (셀 안이면 셀 내부 폭. COLUMN을 페이지
    // 단으로 읽으면 셀 안 개체가 페이지 왼쪽으로 튄다 — 사진대지 우측 셀 실측)
    x = ha === "RIGHT" ? ox + areaW - w - ho - omR : ha === "CENTER" ? ox + (areaW - w) / 2 + ho : ox + ho + omL
  }
  return { x, y }
}

/**
 * 한 문단의 겹침 금지(allowOverlap 0) 문단 기준 어울림 개체 둘 이상 — 앵커 글자 순으로, 가로로 겹치는 앞 개체 아래로 쌓은 위(문단 영역 위 기준, 바깥 위 여백 앞).
 * 앞 개체에 밀려 내려간 개체만 담는다(제 오프셋 자리에 드는 개체는 종전 배치)
 */
export function squareStackTops(m: ParaModel, memo: ExtentMemo): Map<Element, number> {
  const out = new Map<Element, number>()
  const sq = m.objs.filter(q => {
    const pos = findChildByLocalName(q.el, "pos")
    return !q.inline && q.el.getAttribute("textWrap") === "SQUARE" && pos?.getAttribute("allowOverlap") === "0" && (pos.getAttribute("vertRelTo") ?? "PARA") === "PARA"
  }).sort((a, b) => a.index - b.index)
  if (sq.length < 2) return out
  const placed: { x0: number; x1: number; bottom: number }[] = []
  for (const q of sq) {
    const pos = findChildByLocalName(q.el, "pos"), om = findChildByLocalName(q.el, "outMargin"), raw = num(pos, "vertOffset")
    const x0 = num(pos, "horzOffset"), x1 = x0 + num(om, "left") + q.width + num(om, "right")
    const own = Math.max(0, raw >= 2 ** 31 ? raw - 2 ** 32 : raw)
    const below = Math.max(0, ...placed.filter(r => r.x0 < x1 && x0 < r.x1).map(r => r.bottom))
    const top = Math.max(below, own)
    if (below > own) out.set(q.el, top)
    placed.push({ x0, x1, bottom: top + num(om, "top") + (q.tag === "tbl" ? Math.max(q.height, measureTableHeight(q.el, memo)) : q.height) + num(om, "bottom") })
  }
  return out
}
