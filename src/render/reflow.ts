/**
 * Tier-2 reflow — 조판 캐시(linesegarray)가 없는 문단에 좌표를 합성 주입한다.
 *
 * 한컴은 저장 시 각 줄의 좌표(vertpos/horzpos/…)를 linesegarray로 캐시한다.
 * markdownToHwpx 산출물·에이전트 생성본·편집본엔 이 캐시가 없어 svg-render가
 * KordocError로 거부한다. reflow는 `simulateWrap`(수평, 실측 98% 일치)과 세로 모델
 * (실측 — `.claude/plans/render-poc/findings.md`)로 lineseg를 계산해 DOM
 * `<hp:p>`에 `<hp:linesegarray>`를 append → 그 뒤는 기존 렌더 파이프가 그대로 소비한다.
 *
 * 세로 모델(HWPUNIT): textheight = 줄 지배 charPr.height, baseline = round(0.85×th),
 * 줄 pitch = round(th × lineSpacing%/100), spacing(leading) = pitch − th.
 * 문단 세로 흐름 = 본문영역 로컬 누적(다음문단 = 이전끝 + pitch + next + prev).
 *
 * 원칙: 한컴본 캐시는 절대 건드리지 않는다(Tier-1 무회귀). segs가 있는 문단은 건너뛴다.
 * Phase 3(v4.0.4): 개체 세로 흐름 — float(TOP_AND_BOTTOM)는 텍스트를 outMargin 포함
 * 개체 아래로 밀고, PAGE/PAPER 앵커·BEHIND/IN_FRONT는 흐름 불참, inline 표는 실효높이
 * +leading 전진. 혼합 캐시 문서는 캐시 문단의 한컴 좌표로 커서를 이어 받는다
 * (seoul 코퍼스 자기일관성 59/59 — 36264961 전 문단 d=0 실측).
 */

import { buildPara, findFirst, isDeletedControl, measureTableHeight, tabAdvance, paraHeadAdvance, captionExtra, OBJ_TAGS, type ExtentMemo, type ParaObj } from "./para-model.js"
import { squareTableOver, bulletEmptyHost, hasTbFloat, m0Objs, bandTableOver, splitFloatTableRemainder, spacesHost, subFloatBottoms, pageBottomReserve, columnWidthIn, reflowSubListsIn, reflowTablesIn, splitWhole, splitNotesLast, splitMovedLast, type SubFloat } from "./reflow-tables.js"
import { nextParaNumber, type NumberCounters } from "./para-number.js"
import { simulateWrap, hancomCharWidth, hancomEmWidth, faceClassForReflow, mulDiv, syntheticBoldEm, type WrapMode } from "../hwpx/text-metrics.js"
import { BEFORE_2024_WIDTH } from "../hwpx/face-width-fix.js"
import { fontSpaceEm, fontHasGlyph } from "../hwpx/font-metrics.js"
import { DEFAULT_CHAR, DEFAULT_PARA_GEOM, type RenderCharStyle, type RenderStyles, type RenderParaGeom } from "./head-styles.js"
import { findChildByLocalName } from "../hwpx/parser-shared.js"
import { toInt32 } from "./layout.js"
import { cachedParagraphBottom } from "./reflow-cache.js"
import { appendNarrowLineFragments } from "./reflow-fragments.js"
import { lineBorderBox } from "./reflow-borders.js"

/** 표 높이 측정용 새 memo — reflow 는 줄을 고쳐 쓰므로 캐시는 매번 새로, 문단 기하는 떠 있는 개체 위치(문단 위 간격 앞)에 쓴다 */
const geomMemo = (styles: RenderStyles): ExtentMemo => ({ cell: new WeakMap(), table: new WeakMap(), paraGeom: styles.paraGeom })

/** lineseg flags 고정값 (한컴 저장본 실측 — 0x60000) */
const LINESEG_FLAGS = "393216"
/** baseline / textheight 비율 (실측 94/94 일치) */
const BASELINE_RATIO = 0.85

/**
 * 글꼴에 어울리는 줄 높이(fontLineHeight)의 글꼴 위·아래 높이(em 비) — 한컴 저장 lineseg 실측:
 * 맑은 고딕 1200 → 줄 1598·기준선 1307(2230/2048 + 497/2048), 바탕·돋움·굴림·HY 계열 1000 → 1000·858(1758/2048 + 290/2048),
 * 휴먼명조 1000 → 1054·859, KoPub돋움체 Light 1200 → 1320·1020. 표에 없는 글꼴(옛 HFT 등)은 높이 그대로·기준선 85%.
 * 셋째 값이 참이면 아래 높이를 반올림한다 — 맑은 고딕 아래 496/2048: 1100 → 266, 1200 → 291, 2000 → 484, 2100 → 509(한컴 저장본 칸 제목 줄 2662·2796)
 */
const FONT_LINE_METRICS: Array<[RegExp, number, number, boolean?]> = [
  [/^맑은 고딕/, 2230 / 2048, 496 / 2048, true],
  [/^(바탕|돋움|굴림|궁서)(체)?$|^한컴바탕$|^HY/, 1758 / 2048, 290 / 2048],
  [/^휴먼명조$/, 0.859, 0.195],
  [/^KoPub(World)?(돋움|바탕)체 Light$/, 0.85, 0.25],
]
function fontLineMetrics(face: string | undefined, hft?: boolean): [number, number, boolean?] | undefined {
  if (!face || hft && face.trim() === "한컴바탕") return undefined
  for (const [re, a, d, up] of FONT_LINE_METRICS) if (re.test(face.trim())) return [a, d, up]
  return undefined
}

function ln(el: Element): string {
  return (el.tagName || "").replace(/^[^:]+:/, "")
}

function elements(el: Element): Element[] {
  const out: Element[] = []
  const kids = el.childNodes
  if (!kids) return out
  for (let i = 0; i < kids.length; i++) if (kids[i].nodeType === 1) out.push(kids[i] as Element)
  return out
}

function num(el: Element | null, attr: string, fallback = 0): number {
  return el ? toInt32(el.getAttribute(attr) ?? undefined, fallback) : fallback
}

/** 문단의 합성 linesegarray 줄들의 vertpos를 delta만큼 이동 (페이지 로컬 리셋용) */
function shiftParaVert(p: Element, delta: number): void {
  for (const lsa of elements(p)) {
    if (ln(lsa) !== "linesegarray") continue
    for (const seg of elements(lsa)) {
      if (ln(seg) !== "lineseg") continue
      seg.setAttribute("vertpos", String(num(seg, "vertpos") + delta))
    }
  }
}

export interface ReflowGeom {
  BODY_W: number
  BODY_H: number
}

/** 조합형 자모 — 첫소리(L)·가운뎃소리(V)·끝소리(T) */
const isJamoL = (cp: number): boolean => (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0xa960 && cp <= 0xa97c)
const isJamoV = (cp: number): boolean => (cp >= 0x1160 && cp <= 0x11a7) || (cp >= 0xd7b0 && cp <= 0xd7c6)
const isJamoT = (cp: number): boolean => (cp >= 0x11a8 && cp <= 0x11ff) || (cp >= 0xd7cb && cp <= 0xd7fb)
const isJamoLV = (cp: number): boolean => isJamoL(cp) || isJamoV(cp)
const isJamoVT = (cp: number): boolean => isJamoV(cp) || isJamoT(cp)
/** 옛한글 자모 잇기 — 첫소리·가운뎃소리 뒤의 가운뎃소리·끝소리 자모는 앞 글자에 합쳐져 폭이 없다(ᄒ+ᆞ+ᆫ = 1em) */
export const joinsJamo = (prevCp: number, cp: number): boolean => isJamoVT(cp) && isJamoLV(prevCp)

/** 한컴 언어 분류 '영문'(U+0250 미만·U+1E00~1FFF·‘’“” 등 U+2018~201F) — 그 글자는 영문 글꼴·장평·자간·상대크기로 잰다 */
const isLatinCp = (cp: number): boolean => cp < 0x250 || (cp >= 0x1e00 && cp < 0x2000) || (cp >= 0x2018 && cp < 0x2020)

/**
 * 한컴 언어 분류 — 글자는 제 언어 칸(fontRef)의 글꼴·장평·자간·상대크기로 잰다(한글 2022 줄 나눔: 칸마다 장평을 달리 준 글자 129종).
 * 한글(자모·음절) · 영문 · 한자(CJK 한자) · 일어(가나·〒) · 기호(나머지 — 문장부호·화살표·도형·「」、。·원문자·단위·전각·그리스·키릴).
 * 사용자 영역(PUA)은 한글 칸 그대로 둔다(미측정)
 */
export function hancomLangOf(cp: number): "latin" | "hangul" | "hanja" | "japanese" | "symbol" {
  if (isLatinCp(cp)) return "latin"
  if ((cp >= 0x1100 && cp < 0x1200) || (cp >= 0x3130 && cp < 0x3190) || (cp >= 0xa960 && cp < 0xa980) || (cp >= 0xac00 && cp < 0xd800)) return "hangul"
  if ((cp >= 0x3400 && cp < 0x4dc0) || (cp >= 0x4e00 && cp < 0xa000) || (cp >= 0xf900 && cp < 0xfb00) || (cp >= 0x20000 && cp < 0x30000)) return "hanja"
  if ((cp >= 0x3040 && cp < 0x3100) || (cp >= 0x31f0 && cp < 0x3200) || cp === 0x3012) return "japanese"
  if ((cp >= 0xe000 && cp < 0xf900) || cp >= 0xf0000) return "hangul"
  return "symbol"
}

/**
 * 한컴 조판의 글자 폭과 그 중 자간 몫(HWPUNIT). 글자는 제 언어(한글/영문)의 글꼴·장평·상대크기로, 첨자는 크기 16/25 로 잰다.
 * 공백은 한글 크기·장평으로 재고 자간만 영문 값을 쓴다(한컴 저장본과 같은 규칙)
 */
export function glyphWidth(ch: string, st: RenderCharStyle, fallback = true): { w: number; sp: number } {
  const cp = ch.codePointAt(0)!
  const space = cp === 0x20 || cp === 0xa0
  const lang = space ? "hangul" : hancomLangOf(cp)
  const L = space || lang === "hangul" ? undefined : st[lang]
  const rel = space ? st.rel ?? 100 : L ? L.rel : st.rel ?? 100
  let h = rel !== 100 ? mulDiv(st.height, rel, 100) : st.height
  if (!space && st.script) h = mulDiv(h, 16, 25)
  const ratio = L ? L.ratio : st.ratio
  const spacing = space ? st.latin?.spacing ?? st.spacing : L ? L.spacing : st.spacing
  // 진하게 HFT 글자는 굵은 글꼴 폭표(HCI Tulip Bold 등)에 그 글자가 있으면 그것으로 잰다(획 넓히기 없이)
  // Batang(영문 이름)은 2024 이전 판에선 바탕 — 한글 2022 는 Batang 으로 적힌 문서를 다시 저장하면 바탕으로 적고 줄 나눔도 바탕과 같다.
  // 2024 판은 한컴바탕으로 잰다(2024 저장본 Batang 문단 두 줄+ 1,342 → 1,384 / 1,451)
  const face1 = L?.face ?? st.face
  const face0 = face1 === "Batang" ? st.before2024 ? "바탕" : "한컴바탕" : face1
  const boldFace = !space && st.bold && (L ? L.hft : st.hft) && face0 && fontHasGlyph(`${face0} Bold`, cp) ? `${face0} Bold` : undefined
  // 한글 2024 이전 판은 일부 기호 폭이 2024 와 다르다(BEFORE_2024_WIDTH) — 그 폭(em×1000)으로 잰다
  // 2024 새 빌드는 휴먼명조 ‘ ’ 도 같은 폭 312(한컴 저장본: 2024 3901 저장 휴먼명조 문단 — 종전 216·588 이면 ‘강력’ 줄이 한 글자 일찍 끊긴다)
  // 휴먼명조 ‧(U+2027)은 2024 초기 빌드(“ ” 반각 전, 3901 미만)도 옛 폭 0.173em(한컴 저장본: 2024 빌드 2725 문단이 그 폭으로 한 줄)
  const oldEm = st.halfQuote && face0 === "휴먼명조" && (cp === 0x201c || cp === 0x201d) ? 500 : st.halfQuote && !st.before2024 && face0 === "휴먼명조" && (cp === 0x2018 || cp === 0x2019) ? 312 : st.before2024 && face0 && !(face0 === "신명조" && (st.halfQuote || (L?.face ? L.hft : st.hft))) ? BEFORE_2024_WIDTH[face0]?.[cp] : !st.halfQuote && face0 === "휴먼명조" && cp === 0x2027 ? BEFORE_2024_WIDTH[face0]?.[cp] : undefined
  const fc = faceClassForReflow(boldFace ?? face0)
  // 글꼴 빈칸(useFontSpace="1"): 빈칸도 글자처럼 4·MulDiv(글꼴 빈칸 폭, ⌊크기/4⌋, 1000) — 반각이 아니다
  const fsEm = space && st.fontSpace ? fontSpaceEm(st.face) : undefined
  if (fsEm !== undefined) {
    const q = Math.trunc(h / 4), b = ratio === 100 ? 4 * mulDiv(fsEm, q, 1000) : 4 * Math.trunc(fsEm * q * ratio / 100000)
    const s = spacing ? 4 * mulDiv(Math.trunc(b / 4), spacing, 100) : 0
    return { w: b + s, sp: s }
  }
  const bAdd = !space && st.bold && !boldFace ? syntheticBoldEm(L?.face ?? st.face, L ? L.hft : st.hft) : 0
  if (oldEm !== undefined) {
    const b0 = hancomEmWidth(oldEm + bAdd, h, ratio, 0), w0 = spacing ? hancomEmWidth(oldEm + bAdd, h, ratio, spacing) : b0
    return { w: w0, sp: w0 - b0 }
  }
  const base = hancomCharWidth(ch, h, ratio, 0, fc, bAdd, fallback)
  const w = spacing ? hancomCharWidth(ch, h, ratio, spacing, fc, bAdd, fallback) : base
  return { w, sp: w - base }
}

/** 어울림(SQUARE·TIGHT·THROUGH) 개체가 글 흐름에서 차지하는 영역 — 그 흐름(본문·칸) 좌표 */
interface WrapZone { top: number; bottom: number; left: number; right: number; flow: string; anchor?: number; carry?: number; nextPage?: boolean }

/** 줄 pitch(다음 줄 vertpos 증분, HWPUNIT) — lineSpacing type별 */
function pitchFor(height: number, geom: RenderParaGeom): number {
  const v = geom.lineSpacingValue
  switch (geom.lineSpacingType) {
    // 줄 간격 몫(spacing)은 4 HWPUNIT 단위 — 높이를 먼저 ⌊h/4⌋ 로 내린 뒤 %를 곱해 0에서 먼 쪽으로 반올림한다. 한컴 저장 lineseg 실측:
    // 1400 × 155% → 4·round(350 × 0.55 = 192.5) = 772, 1500 × 90% → −152, 1250 × 160% → 4·round(312 × 0.6 = 187.2) = 748(750 아님),
    // 1270 × 155% → 696. 100% 미만이면 spacing 은 음수다
    case "PERCENT": { const e = (Math.trunc(height / 4) * (v - 100)) / 100; return height + 4 * Math.sign(e) * Math.floor(Math.abs(e) + 0.5) }
    case "FIXED": return Math.max(0, v) // 고정 줄높이(HWPUNIT) — 0 이면 줄이 겹친다(한컴 저장본: 고정 0 문단의 줄 13개 모두 spacing = −줄 높이)
    case "AT_LEAST": return Math.max(v, height)
    default: return Math.round(height * 1.6) // BETWEEN_LINES 등 — 기본 160% 근사
  }
}

/**
 * 문단 하나의 linesegarray를 합성해 p에 삽입.
 * @returns 세로 흐름 갱신값 (캐시 있어 건너뛴 경우 null)
 */
function reflowPara(
  p: Element,
  doc: Document,
  styles: RenderStyles,
  areaW: number,
  startV: number,
  mode: WrapMode,
  zones: WrapZone[] = [],
  nums: NumberCounters = new Map(),
  /** 본문 흐름인가 — 표 칸 등 하위 목록에서는 떠 있는 위아래 배치 개체가 글을 밀지 않는다 */
  bodyFlow = true,
  /** 쪽 본문 높이(본문 흐름일 때) — 쪽 바닥을 넘는 어울림 개체는 통째로 다음 쪽 위로 */
  pageH = 0,
): { paraBottom: number; floatFloor: number; textBottom: number; spaceAfter: number } | null {
  const m = buildPara(p)
  const geom = styles.paraGeom.get(m.paraPrId ?? "") ?? DEFAULT_PARA_GEOM
  // 문단 번호는 조판 캐시가 있는 문단도 센다(뒤 문단 번호가 밀리지 않게)
  const numText = nextParaNumber(nums, geom)
  if (m.segs.length > 0) return null // 이미 캐시 있음 — Tier-1 무회귀

  // 실텍스트 + UTF-16 유닛 → chars 슬롯 인덱스 매핑 (서로게이트 쌍은 슬롯 1개, 유닛 2개).
  // 폭은 글자마다 제 charPr(글꼴·크기·장평·자간)로 — 부호 run 과 압축된 내용 run 이 섞인 문단도 한컴과 같게.
  // 탭은 "\t" 한 글자로 넣고 폭 = 탭 전진폭(첫 줄 기준 — 항목부호 뒤 내어쓰기용 자동 탭).
  // 묶음 빈칸은 U+00A0 — 공백 폭이지만 줄을 끊지 않는다("2026. 9. 23."·"3억 원")
  const realIdx: number[] = []
  /** 오른쪽 탭 자리(text 의 UTF-16 위치) */
  const rightTabs = new Set<number>()
  /** 오른쪽 탭 폭 다시 재기 — widths 자리·탭 앞 x·탭 뒤 글 폭(줄 폭이 정해진 뒤 맞춘다) */
  const rightTabFit: Array<{ wi: number; x: number; after: number }> = []
  const widths: number[] = []
  const spacings: number[] = []
  let text = ""
  let x = Math.max(geom.marginIntent, 0) // 탭 정지점은 왼쪽 여백 기준 — 첫 줄 들여쓰기만큼 들어가서 시작
  // 글자처럼 취급하는 개체(treatAsChar 표·그림)는 폭(outMargin 좌우 포함)을 가진 글자 하나로 줄 채우기에 넣는다 —
  // 한컴도 개체를 그 폭의 글자로 줄에 채운다. 넓은 표 두 개는 줄을 하나씩 차지한다(정답 lineseg textpos 0·8)
  const inlineAt = new Map<number, ParaObj>()
  for (const o of m.objs) if (o.inline) inlineAt.set(o.index, o)
  for (let i = 0; i < m.chars.length; i++) {
    const c = m.chars[i]
    const io = inlineAt.get(i)
    if (io) {
      const adv = io.omL + io.width + io.omR
      realIdx.push(i); widths.push(adv); spacings.push(0); text += "\ufffc"; x += adv
      continue
    }
    if (c.tab) {
      let adv = tabAdvance(x, true, geom, c.tabW)
      if (c.tabRight) {
        rightTabs.add(text.length)
        // 오른쪽 탭은 한컴이 조판 때마다 탭 폭을 다시 잰다 — 저장 폭으로 탭 뒤 글이 줄 끝을 넘으면 줄 끝에서 끝나게 줄인다
        // (한컴 저장본: 차례 "…작성·활용⇥ 259" 가 저장 탭 폭으로는 31 넘치지만 한 줄)
        let after = 0
        for (let k = i + 1; k < m.chars.length && !m.chars[k].tab; k++) {
          const ck = m.chars[k]
          if (!ck.ch) continue
          after += glyphWidth(ck.ch, (ck.prId != null ? styles.charPr.get(ck.prId) : undefined) ?? DEFAULT_CHAR).w
        }
        rightTabFit.push({ wi: widths.length, x, after })
      }
      realIdx.push(i); widths.push(adv); spacings.push(0); text += "\t"; x += adv
      continue
    }
    if (c.ctrl) {
      // 컨트롤 — 줄의 내용으로 친다(뒤에서 넘치는 개체는 다음 줄로). 주석 머리 번호("1)")처럼 글을 그리는 컨트롤은
      // 그 글 폭의 한 덩어리(미주 lineseg 실측: 8.0pt 문단이 "1) " 몫만큼 일찍 꺾인다), 쪽 번호·필드 등은 폭 0
      let w = 0
      if (c.ctrlText) {
        const st0 = (c.prId != null ? styles.charPr.get(c.prId) : undefined) ?? DEFAULT_CHAR
        // 주석 번호 폭은 한글 2024 가 진하게를 빼고 잰다(2024 저장 시험지 미주 +15) — 2024 이전 판은 진하게 그대로(한글 2022 재조판)
        const st1a = styles.before2024 ? st0 : { ...st0, bold: false }
        // 주석 머리 번호("17)")에는 자간을 매기지 않는다(한글 2022 줄 나눔: 바탕 9pt 자간 −5 각주 130개 — 자간을 넣으면 두 자리 번호 문단이 한 글자 더 든다)
        const st1 = c.ctrlSup ? st1a : { ...st1a, spacing: 0, ...(st1a.latin ? { latin: { ...st1a.latin, spacing: 0 } } : {}) }
        // 각주·미주 본문 참조 번호는 글자 크기의 3/4 로 잰다(한글 2022 줄 나눔: 번호 1~3자리 모두 75~77% 에서 맞는다. 위첨자 16/25 는 좁다)
        const st = c.ctrlSup ? { ...st1, height: mulDiv(st1.height, 3, 4) } : st1
        for (const ch of c.ctrlText) w += glyphWidth(ch, st).w
      }
      realIdx.push(i); widths.push(w); spacings.push(0); text += w > 0 ? "\ufffc" : c.fieldEnd ? "\ufdd0" : "\u2060"; x += w
      continue
    }
    if (c.br) {
      // 강제 줄바꿈 — 그 뒤 글은 새 줄(simulateWrap 이 \n 에서 끊는다)
      realIdx.push(i); widths.push(0); spacings.push(0); text += "\n"; x = Math.max(0, -geom.marginIntent)
      continue
    }
    if (c.ch === "") continue
    const st = (c.prId != null ? styles.charPr.get(c.prId) : undefined) ?? DEFAULT_CHAR
    // 폭 테이블: 고정폭 글꼴(굴림체류)은 전용 클래스 — 함초롬 테이블(한글 0.97em)로 재면 줄당 1~2자
    // 과대적재로 wrap 이 어긋난다 (seoul 코퍼스 3건 실측). 폭표 없는 한글 글꼴은 한글 1em(faceClassForReflow).
    // 글자 폭은 한컴처럼 글자마다 4 단위로 양자화하고, 언어별 글꼴·장평·자간·상대크기와 첨자 크기를 따른다(glyphWidth)
    // 옛한글: 첫소리 자모 뒤의 가운뎃소리·끝소리 자모는 한 글자로 합쳐진다 — 폭은 첫소리 자리의 한 글자 몫뿐(ᄒ+ᆞ+ᆫ = 1em)
    const cp = c.ch.codePointAt(0)!
    const joins = joinsJamo(text.codePointAt(text.length - 1) ?? 0, cp)
    const { w, sp } = joins ? { w: 0, sp: 0 } : glyphWidth(c.ch, st)
    for (let u = 0; u < c.ch.length; u++) { realIdx.push(i); widths.push(u === 0 ? w : 0); spacings.push(u === 0 ? sp : 0) }
    text += c.nb ? "\u00a0" : c.ch
    x += w
  }

  // 문단 지배 charPr — 첫 실문자 우선(줄 높이·기준선. 가로 폭은 위 widths 가 글자별로 잰다)
  let domChar = DEFAULT_CHAR
  for (const c of m.chars) {
    if (c.ch !== "" && c.prId != null) {
      const st = styles.charPr.get(c.prId)
      if (st) { domChar = st; break }
    }
  }
  // 실문자가 없는 문단(빈 줄·개체 전용)도 run의 charPrIDRef가 줄높이를 지배한다 —
  // DEFAULT_CHAR(1000)로 재면 빈 문단 pitch가 본문(예: 1300→2080)보다 작아 이후
  // 문단 전체가 위로 밀린다 (seoul 코퍼스 36264961 실측 −480×빈줄 누적)
  if (domChar === DEFAULT_CHAR) {
    for (const run of elements(p)) {
      if (ln(run) !== "run") continue
      const st = styles.charPr.get(run.getAttribute("charPrIDRef") ?? "")
      if (st) { domChar = st; break }
    }
  }
  const height = domChar.height || 1000

  const marginL = geom.marginLeft
  // 한컴은 영역 폭(본문·단·칸 안쪽)을 4 HWPUNIT 단위로 내린 뒤 문단 여백을 빼고, 1440(0.5 cm) 보다 좁히지 않는다
  // (저장 lineseg horzsize 실측: 본문 48190 → 48188, 본문 39686 − 왼쪽 여백 1850 → 37834(빼고 내리면 37836), 칸 폭 200~1400 → 1440)
  const avail = Math.max(1440, Math.floor(areaW / 4) * 4 - marginL - geom.marginRight)
  // hanging(intent<0): 둘째 줄부터 |intent| 더 들어감 → contWidth 축소·contHorz 우측 이동.
  // 들여쓰기(intent>0)는 첫 줄을 그만큼 좁혀 채운다 — lineseg horzsize 는 한컴처럼 들여쓰기를 빼지 않은 폭으로 둔다
  const firstWidth = avail
  // 글머리표: 글자 폭 + 간격(textOffset — % 면 글자 크기의 %)만큼 첫 줄이, autoIndent 면 둘째 줄부터도 좁게 찬다
  // (한컴 저장 lineseg 260문단: 맞는 문단 65 → 235. 간격을 글머리표 폭의 % 로 보면 224)
  // 문단 번호도 같다 — 머리 글("1."·"가)") 폭 + 간격 (한컴 저장본 번호 문단 대조)
  const bu = geom.bullet ?? (numText && geom.number ? { ch: numText, ...geom.number } : undefined)
  const bst = (bu?.charPrId != null ? styles.charPr.get(bu.charPrId) : undefined) ?? domChar
  let headW = 0
  if (bu) for (const ch of bu.ch) headW += glyphWidth(ch, bst, bu.useInstWidth !== false).w
  const bulletW = bu ? paraHeadAdvance(bu, height, headW) : 0
  const contBullet = bu?.autoIndent ? bulletW : 0
  // 칸 subList lineWrap="SQUEEZE"(자간 줄여 한 줄)면 글은 줄을 바꾸지 않는다 — 명시적 줄 나눔만(한컴 저장본 SQUEEZE 칸 문단 4,316개 전부 한 줄, 줄 나눔 있는 35개만 여러 줄).
  // 문단 모양의 한 줄로 입력(breakSetting lineWrap="SQUEEZE")도 같다(한컴 저장본: 돋움체 칸 "(mansikzang@korea.kr)" 10500 이 칸 폭 9680 에 한 줄. 줄 수 +56)
  const squeeze = (p.parentNode as Element | null)?.getAttribute?.("lineWrap") === "SQUEEZE" || !!geom.squeeze
  const NO_WRAP = 1e9
  // 2024 이전 판은 들여쓰기와 글머리표 몫 중 큰 쪽만 첫 줄을 좁힌다(한컴 2022 저장본·2022 재조판: 들여쓰기 295·글머리표 1356 문단이 45251 + 295 폭에 한 줄),
  // 2024 는 둘을 더한다(2024 저장 글머리표 문서)
  // 들여쓰기가 줄 폭 이상이면 한컴은 들여쓰기를 두지 않는다(한컴 저장본: 들여쓰기 32580 문단이 폭 6108 칸에 "담당 공무원" 한 줄)
  const intentPos = geom.marginIntent >= avail ? 0 : Math.max(0, geom.marginIntent)
  const firstWrapWidth = squeeze ? NO_WRAP : Math.max(500, avail - (styles.before2024 && bulletW > 0 ? Math.max(intentPos, bulletW) : intentPos + bulletW))
  // 한글 2024 저장본의 번호·글머리표 문단은 공백 압축(condense) 없이 채운다(같은 문서를 압축 0 으로 바꿔 다시 조판하면 저장본 줄 나눔과 같다) —
  // 초기 빌드(early2024)는 압축한다
  const condenseUse = !styles.before2024 && !styles.early2024 && (geom.number || geom.bullet) ? 0 : geom.condense
  for (const r of rightTabFit) {
    const edge = avail - bulletW
    if (r.x + widths[r.wi] + r.after > edge && edge - r.x - r.after >= 0) widths[r.wi] = edge - r.x - r.after
  }
  // 내어쓰기(intent<0)는 둘째 줄부터 그만큼 좁게 채우되, lineseg 의 horzpos·horzsize 는 들여쓰기처럼 바꾸지 않는다
  // (한컴 저장본 내어쓰기 문단 수천 개 전부 둘째 줄 horzpos = 왼쪽 여백 — 그리기가 내어쓰기만큼 민다)
  const contSegWidth = avail
  // 내어쓰기로 남는 폭이 한 글자도 안 되면(칸 7496 에 −10152) 한컴은 둘째 줄부터도 온 폭으로 채운다 — 폭 500 으로 묶으면 한 글자씩 끊긴다
  const hang = avail + Math.min(0, geom.marginIntent) - contBullet
  const contWidth = squeeze ? NO_WRAP : hang < height ? avail - contBullet : hang
  const contHorz = marginL

  // 문단 paraPr의 breakSetting이 있으면 그 선언(어절/글자)을 따르고, 없으면 호출자 모드
  const paraMode = geom.wrapMode ?? mode
  const pitch = pitchFor(height, geom)

  // ── 떠 있는 개체(treatAsChar=0)의 세로 흐름 (Phase 3 — 한컴 실측 모델, 36264961) ──
  // · TOP_AND_BOTTOM + PARA 앵커: 개체가 문단 상단을 차지하고 텍스트는 outTop+개체높이+outBottom 아래부터 흐른다
  //   (두문 결재표 실측: 140+16653+852=17645 정확 일치)
  // · SQUARE·TIGHT·THROUGH(어울림) + PARA 앵커: 글이 개체 둘레로 흐른다 — 개체 영역(위 = max(문단 시작 + vertOffset, 앵커 줄 위),
  //   아래 = 위 + 높이 + outBottom, 옆 = horzOffset − outLeft ~ + 폭 + outRight)과 세로로 겹치는 줄은 남는 폭으로 줄고
  //   (정답 lineseg horzpos 12994 = 그림 폭 12144 + outRight 850), 개체는 다음 문단을 밀지 않는다
  // · BEHIND_TEXT/IN_FRONT_OF_TEXT 또는 PAGE/PAPER 앵커: 본문 흐름에 불참 (페이지 하단 직인 스탬프가 커서를 밀던 것 제거) — 단 용지 기준 어울림 개체는
  //   본문 좌표로 옮긴 영역이 같은 쪽 줄을 좁히고, 용지 기준 위 정렬 위아래 배치 개체는 온 폭 띠가 된다
  let floatBelow = 0 // 텍스트 시작을 아래로 미는 float 개체 바닥 (문단 로컬)
  let firstFloatVo = 0 // 첫 위아래 배치 개체의 vertOffset — 글 시작보다 아래면 개체는 글 사이에 끼는 띠가 된다
  /** 앵커 글자가 첫 줄 뒤에 있는 위아래 배치 개체(앵커 칸 위치·높이) — 그 앵커 줄 앞에 낀다 */
  const lineFloats: Array<{ index: number; h: number }> = []
  let objBottom = startV
  // 글자처럼 취급하는 글상자는 안 글이 sz 보다 길면 그 글 높이만큼 자란다(한컴 저장본: sz 1249 인 조건 상자 줄 높이 = 안 글 바닥 7629 + 안 여백 425×2)
  const effHOf = (o: ParaObj): number => (o.tag === "tbl" ? Math.max(o.height, measureTableHeight(o.el, geomMemo(styles))) : o.inline ? Math.max(o.height, drawTextHeight(o.el)) : o.height) + captionExtra(o.el)
  let cellFloatBottom = 0, cellTextBelow = 0
  // 칸 안 위아래 배치 개체의 호스트가 공백뿐이면 그 줄은 개체 아래로 내려간다(빈 문단은 제자리) — 한컴 저장본: 칸 안 공백 호스트 8개 중 7개가
  // 개체 바닥 아래(18538 + 1920 + 바깥 283×2 + 표 8328 = 29352), 글자 없는 호스트는 130개가 제자리
  const spacesOnly = spacesHost(p)
  const zoneStart = zones.length
  // 본문의 공백뿐인 호스트는 글 있는 문단처럼 띠를 따른다 — 줄이 개체 세로 오프셋 안에 들면 제자리, 아니면 개체 아래
  // (한컴 저장본: 공백 호스트 29개 중 27개 — 오프셋 289 표 6252 뒤 줄 68526 = 61703 + 289 + 141 + 6252 + 141, 오프셋 1624 위 줄 1500 은 제자리)
  // 겹침 허용(allowOverlap) 위아래 배치 그림만 든 빈 문단도 줄이 그림 아래로 간다(한컴 저장본: 그림 35580 + 바깥 852×2 + 캡션 뒤 줄 39136, 빈 문단 3개 모두 — 같은 꼴 글상자 8개는 제자리)
  const OVP = bodyFlow && m.objs.length > 0 && !m.chars.some(c => c.ch !== "" && c.ch.trim() !== "") && m.objs.every(o => !o.inline && o.tag === "pic" && o.el.getAttribute("textWrap") === "TOP_AND_BOTTOM" && findChildByLocalName(o.el, "pos")?.getAttribute("allowOverlap") === "1")
  // 글머리표 문단인 빈 호스트에 위아래 배치 표만 있으면 줄도 표 아래로 간다(한컴 저장본: 그런 문단 5개 모두 줄이 표 아래, 글머리표 없는 빈 호스트 345개 중 줄 위 306)
  const spacesText = bodyFlow && (spacesOnly || !!OVP || bulletEmptyHost(p, geom))
  const textish = m.chars.some(c => c.ch !== "" && !c.nb && c.ch.trim() !== "") || m.objs.some(o => o.inline) || spacesText
  for (const o of m.objs) {
    if (o.inline) continue
    const pos = findChildByLocalName(o.el, "pos")
    const om = findChildByLocalName(o.el, "outMargin")
    const outT = num(om, "top"), outB = num(om, "bottom")
    const wrapAttr = o.el.getAttribute("textWrap") ?? ""
    if (wrapAttr === "BEHIND_TEXT" || wrapAttr === "IN_FRONT_OF_TEXT") continue
    const vertRel = pos?.getAttribute("vertRelTo") ?? "PARA"
    // 용지 기준 어울림 개체 — 본문 좌표(용지 좌표에서 본문 원점을 뺀다)로 영역을 둔다. 같은 쪽의 뒤 문단 줄도 피해 간다
    // (한컴 저장본: 용지 왼쪽 3872 + 바깥 852 그림 35840 옆 줄 horzpos 37164 = 3872 − 왼쪽 여백 4252 + 852 + 35840 + 852)
    // 용지 기준 위 정렬 위아래 배치 개체는 같은 쪽 뒤 글이 겹치지 못하는 온 폭 띠다 — 띠에 닿는 줄부터 띠 아래로, 쪽에 안 들면 다음 쪽
    // (한컴 PDF: 용지 위 48283 그림 27084 에 닿은 문단이 새 쪽 800 — 종전엔 흐름에서 빼 그림 자리에 글을 겹쳤다)
    const paperBand = wrapAttr === "TOP_AND_BOTTOM" && (pos?.getAttribute("vertAlign") ?? "TOP") === "TOP"
    if (vertRel === "PAPER" && bodyFlow && (wrapAttr !== "TOP_AND_BOTTOM" || paperBand)) {
      const [oxL, oyT, paperW] = paperOrigin(p)
      const hRel = pos?.getAttribute("horzRelTo") ?? "COLUMN", hAlign = pos?.getAttribute("horzAlign") ?? "LEFT"
      const ho = num(pos, "horzOffset"), base = hRel === "PAPER" ? -oxL : hRel === "PARA" ? marginL : 0, span = hRel === "PAPER" ? paperW : hRel === "PARA" ? avail : areaW
      const x0 = base + (hAlign === "RIGHT" ? span - ho - o.width : hAlign === "CENTER" ? (span - o.width) / 2 + ho : ho)
      const vo0 = Math.max(0, num(pos, "vertOffset")), top = vertRel === "PAPER" ? vo0 - oyT : vo0
      const omLx = num(om, "left"), omRx = num(om, "right")
      const xs = hAlign === "RIGHT" ? x0 - omRx : hAlign === "CENTER" ? x0 : x0 + omLx
      // 세로도 가로처럼 개체 자리 = 오프셋 + 바깥 위 — 영역 아래 = 오프셋 + 바깥 위 + 높이 + 바깥 아래
      // (한컴 저장본: 용지 위 5668(= 본문 위) 그림 26440, 바깥 852 — 27360 줄까지 좁고 28800 줄부터 온 폭)
      zones.push({ top, bottom: top + outT + effHOf(o) + outB, left: paperBand ? -1e9 : xs - omLx, right: paperBand ? 1e9 : xs + o.width + omRx, flow: o.el.getAttribute("textFlow") ?? "BOTH_SIDES", anchor: o.index })
      continue
    }
    if (vertRel === "PAGE" || vertRel === "PAPER") continue
    const vo = Math.max(0, num(pos, "vertOffset"))
    // vertOffset 은 부호 없는 32비트로 저장된다(4294960072 = −7224) — 위로 올린 개체는 문단 위에서 멈춘다
    const voRaw = num(pos, "vertOffset"), voSigned = Math.max(0, voRaw >= 2 ** 31 ? voRaw - 2 ** 32 : voRaw)
    const effH = effHOf(o)
    // 단(문단) 밖으로 완전히 나간 위아래 배치 개체는 이 흐름의 글을 밀지 않는다 — 한컴 저장본: 가운데 정렬 + horzOffset 22531 로 단 오른쪽 밖에
    // 놓인 그림(20400)의 빈 앵커 문단 다음 줄이 바로 이어진다(시험지 문서 9개)
    if (wrapAttr === "TOP_AND_BOTTOM") {
      const hR = pos?.getAttribute("horzRelTo") ?? "COLUMN", hA = pos?.getAttribute("horzAlign") ?? "LEFT"
      const hoff = num(pos, "horzOffset"), b0 = hR === "PARA" ? marginL : 0, sp = hR === "PARA" ? avail : areaW
      const xL = b0 + (hA === "RIGHT" ? sp - hoff - o.width : hA === "CENTER" ? (sp - o.width) / 2 + hoff : hoff)
      if ((hR === "COLUMN" || hR === "PARA") && (xL >= areaW || xL + o.width <= 0)) continue
    }
    if (wrapAttr === "TOP_AND_BOTTOM") {
      // 표 칸 안에서는 그 문단의 글을 밀지 않는다(한컴 저장본: 칸 안 떠 있는 위아래 개체 문단 202개 중 201개가 첫 줄 vertpos 0) —
      // 다음 문단은 개체 바닥(문단 위치 + vertOffset + 바깥 위 + 높이 + 바깥 아래) 아래에서 시작한다(칸 안 위아래 개체 뒤 문단 114개)
      // 같은 문단의 위아래 배치 개체는 겹치지 않고 차례로 쌓인다 — 위치 = max(앞 개체 바닥, vertOffset)
      // (한컴 저장본: 보도자료 머리 표 셋 3481·2797·12846 + 바깥 여백 283×2 씩 = 첫 줄 vertpos 20822)
      if (bodyFlow) {
        // 앵커 글자가 첫 줄 뒤에 있으면 개체는 그 앵커 줄 위에 끼고, 그 줄부터 개체 아래로(한컴 저장본: 연락처 문단 인라인 표 줄 56218,
        // 떠 있는 표 3764 + 566 뒤 둘째 줄 64776) — 줄을 나눈 뒤 정한다
        if (voSigned === 0 && textish) { lineFloats.push({ index: o.index, h: outT + effH + outB }); continue }
        if (floatBelow === 0) firstFloatVo = voSigned
        floatBelow = Math.max(floatBelow, voSigned) + outT + effH + outB
      } else if (spacesOnly) cellTextBelow = Math.max(cellTextBelow, voSigned + outT + effH + outB)
      else cellFloatBottom = Math.max(cellFloatBottom, voSigned + outT + effH + outB)
      continue
    }
    const hRel = pos?.getAttribute("horzRelTo") ?? "COLUMN", hAlign = pos?.getAttribute("horzAlign") ?? "LEFT"
    const ho = num(pos, "horzOffset"), base = hRel === "PARA" ? marginL : 0, span = hRel === "PARA" ? avail : areaW
    const x0 = base + (hAlign === "RIGHT" ? span - ho - o.width : hAlign === "CENTER" ? (span - o.width) / 2 + ho : ho)
    const top = startV - (bodyFlow && vertRel === "PARA" && wrapAttr === "SQUARE" ? geom.spaceBefore : 0) + vo
    // 개체 자리 = 오프셋 + 바깥 왼쪽(오른쪽 정렬은 − 바깥 오른쪽) — 한컴 PDF 실측(렌더러와 같다). 영역은 바깥 여백까지
    const omLx = num(om, "left"), omRx = num(om, "right")
    const xs = hAlign === "RIGHT" ? x0 - omRx : hAlign === "CENTER" ? x0 : x0 + omLx
    // carry: 쪽 바닥을 넘어 다음 쪽 위로 옮겨질 때 그 쪽 위부터 막는 높이(바깥 위 + 높이 + 바깥 아래 — 세로 오프셋은 버린다, 칸 안 넘김과 같다.
    // 한컴 저장본: 오프셋 3566 + 바깥 510 + 그림 25554 + 캡션 3450 인 그림이 넘어간 쪽에서 30000 줄까지 좁고 32000 줄부터 온 폭)
    // 쪽 바닥을 넘는 개체는 이 쪽에 두지 않고 통째로 다음 쪽 맨 위로 — 이 쪽 줄은 좁히지 않는다(한컴 저장본: 바닥 근처 문단의 어울림 그림 22713 이
    // 그 문단과 뒤 문단 줄을 온 폭으로 두고 다음 쪽 첫 줄부터 좁힌다)
    const nextPage = pageH > 0 && top + effH + outB > pageH
    zones.push({ top: nextPage ? -1 : top, bottom: nextPage ? -1 : top + effH + outB, left: xs - omLx, right: xs + o.width + omRx, flow: o.el.getAttribute("textFlow") ?? "BOTH_SIDES", anchor: nextPage ? undefined : o.index, carry: outT + effH + outB, ...(nextPage ? { nextPage } : {}) })
  }
  // 글 없는 문단(개체·컨트롤만)은 줄이 제자리에 남고 개체가 문단 바닥을 민다 — 한컴 저장본: 두문 표만 있는 첫 문단 줄 vertpos 0, 다음 문단 17645
  // 글자처럼 취급하는 개체(인라인 표·그림)도 줄을 차지하는 내용이다 — 한컴 저장본: 떠 있는 머리 표(4741 + 바깥 566) 아래 인라인 표 줄 vertpos 5307
  const hasText = textish
  // 그런 개체가 둘 이상이면 빈 줄도 그 아래로 내려간다(한컴 저장본: 머리 표 셋인 첫 문단 19개 중 17개, 하나면 181개 중 178개가 제자리)
  const nFloat = m.objs.filter(o => !o.inline && o.el.getAttribute("textWrap") === "TOP_AND_BOTTOM" && (findChildByLocalName(o.el, "pos")?.getAttribute("vertRelTo") ?? "PARA") === "PARA").length
  // 위아래 배치 개체는 문단 영역 맨 위(문단 위 간격 앞)에 놓이고, 글은 max(위 간격 뒤, 개체 바닥)에서 시작한다 — 위 간격을 개체 아래에 더하지 않는다.
  // 글 없는 문단의 개체 바닥은 다음 문단 첫 줄의 바닥선이다(그 문단 위 간격도 더하지 않는다). 한컴 저장본: 위 간격 1000 인 두문 표 문단 첫 줄 17645
  // (= 140 + 16653 + 852), 위 간격 500 인 빈 문단의 표 25320 + 10895 = 다음 문단 36215
  const areaTop = bodyFlow ? startV - (geom.spaceBefore ?? 0) : startV
  let floatFloor = 0
  if (!hasText && nFloat < 2) { objBottom = areaTop + floatBelow; if (bodyFlow) floatFloor = objBottom; floatBelow = 0 }
  // 글 있는 문단에서 개체가 글 시작보다 아래에 놓이면(vertOffset) 글을 밀지 않고 띠가 된다 — 띠와 겹치는 줄부터 띠 아래로
  // (한컴 저장본: vertOffset 6770 표 위 두 줄은 문단 위치 그대로 25805·27885)
  let band: [number, number] | undefined
  if (floatBelow > 0 && hasText && areaTop + firstFloatVo > startV) {
    band = [areaTop + firstFloatVo, areaTop + floatBelow]; floatBelow = 0
    // 띠는 뒤 문단에도 영역으로 남는다 — 띠 위에서 끝나는 뒤 문단은 제자리, 띠에 닿는 문단부터 띠 아래로
    // (한컴 저장본: 오프셋 3022 표 띠 36235~ 위의 빈 문단 35213 은 그대로, 그다음 문단이 표 바닥 54688)
  }
  let textStartV = floatBelow > 0 ? Math.max(startV, areaTop + floatBelow) : startV
  if (cellTextBelow > 0) textStartV = Math.max(textStartV, startV + cellTextBelow)
  // 앞 문단의 어울림 개체가 첫 줄 자리를 거의 다 덮으면(남는 틈 1440 미만) 문단은 그 개체 아래에서 시작한다
  // (한컴 저장본: 본문보다 넓은 어울림 그림 아래 문단들이 그림 바닥 41121 부터. 틈에 한 글자씩 넣던 것)
  // 문단이 글자처럼 취급한 개체로 시작하면 그 개체(바깥 여백 포함)가 들 틈이어야 한다(한컴 저장본: 폭 41552 인라인 표가 앞 문단 그림 옆 틈 25139 에 안 들어 그림 아래 27183)
  const firstInline = m.objs.find(o => o.inline)
  const needW = firstInline && !m.chars.slice(0, firstInline.index).some(c => c.ch !== "" && c.ch.trim() !== "") ? Math.max(1440, firstInline.omL + firstInline.width + firstInline.omR) : 1440
  for (let guard = 0; guard < 8 && zoneStart > 0; guard++) {
    const y0 = textStartV, y1 = y0 + height
    let free: Array<[number, number]> = [[marginL, marginL + avail]], bottom = -1
    for (const z of zones.slice(0, zoneStart)) {
      if (!(y1 > z.top && y0 < z.bottom)) continue
      bottom = Math.max(bottom, z.bottom)
      free = free.flatMap(([a, b]): Array<[number, number]> => (z.right <= a || z.left >= b ? [[a, b] as [number, number]] : [[a, Math.max(a, z.left)] as [number, number], [Math.min(b, z.right), b] as [number, number]]).filter(([c, d]) => d - c > 0))
    }
    if (bottom < 0 || free.some(([a, b]) => b - a >= needW)) break
    textStartV = bottom
  }

  /** 줄 i 의 [horzpos, horzsize] — 어울림 개체와 세로로 겹치면 남는 폭(넓은 쪽, LEFT_ONLY/RIGHT_ONLY 는 그쪽) */
  const lineBox: Array<[number, number] | undefined> = []
  /** 줄 i 가 양쪽에 걸친 어울림 개체 사이에 남긴 조각들(왼쪽부터) — 둘 이상일 때만 */
  const lineParts: Array<Array<[number, number]> | undefined> = []
  const collisionHeights: number[] = []
  const boxAt = (i: number): [number, number] | undefined => {
    if (!zones.length) return undefined
    if (i in lineBox) return lineBox[i]
    const y0 = textStartV + i * pitch, y1 = y0 + Math.max(height, collisionHeights[i] ?? 0)
    let free: Array<[number, number]> = [[marginL, marginL + avail]], hit = false, flow = "BOTH_SIDES"
    for (const z of zones) {
      if (!(y1 > z.top && y0 < z.bottom)) continue
      hit = true; flow = z.flow
      free = free.flatMap(([a, b]): Array<[number, number]> => {
        const parts: Array<[number, number]> = z.right <= a || z.left >= b ? [[a, b]] : [[a, Math.max(a, z.left)], [Math.min(b, z.right), b]]
        return parts.filter(([c, d]) => d - c > 0)
      })
    }
    let box: [number, number] | undefined
    if (hit) {
      const pick = flow === "LEFT_ONLY" ? free[0] : flow === "RIGHT_ONLY" ? free[free.length - 1] : free.reduce((x, y) => (y[1] - y[0] > x[1] - x[0] ? y : x), free[0] ?? [marginL, marginL])
      box = pick ? [pick[0], pick[1] - pick[0]] : [marginL, 0]
      if (flow === "BOTH_SIDES" && free.length > 1) lineParts[i] = free
    }
    lineBox[i] = box
    return box
  }
  const lineWidth = zones.length
    ? (i: number): number => {
        const b = boxAt(i)
        // 한글 2024 는 왼쪽 어울림 개체가 깎은 줄에서 개체 오른쪽에 문단 왼쪽 여백을 한 번 더 띄운다 — 저장 horzpos 는 개체 끝 그대로
        // (2024 저장본: 왼쪽 여백 850 문단, 개체 끝 2269·폭 35149 줄 넷의 나눔이 모두 폭 34299 로만 맞는다. 같은 문서의 한글 2022 재조판은 35149)
        const w = b ? b[1] - (!styles.before2024 && b[0] > marginL ? marginL : 0) : avail
        return Math.max(500, i === 0 ? w - intentPos - bulletW : w + Math.min(0, geom.marginIntent) - contBullet)
      }
    : undefined
  const own = zones.slice(zoneStart)
  if (own.length && text.length) {
    // 이 문단의 어울림 개체는 앵커 글자가 놓인 줄보다 위로 가지 않는다 — 개체 영역 없이 먼저 나눠 앵커 줄을 찾는다
    // (한컴 저장본: vertOffset 0 인 그림이 셋째 줄에 앵커되면 첫 두 줄은 온 폭, 셋째 줄부터 좁다. 어울림 문단 줄 시작 일치 20 → 61 / 73)
    const keep = zones.slice(0, zoneStart)
    const saved = zones.splice(0, zones.length, ...keep)
    lineBox.length = 0
    const pre = simulateWrap(text, firstWrapWidth, contWidth, height, 100, paraMode, { widths, spacings, condensePct: condenseUse, kinsoku: "hancom", before2024: styles.before2024, lineWidth: zones.length ? lineWidth : undefined, latinBreak: geom.latinBreak , rightTabs })
    zones.splice(0, zones.length, ...saved)
    lineBox.length = 0
    for (const z of own) {
      const k = realIdx.indexOf(z.anchor!)
      if (k < 0) continue
      let li = 0
      for (let j = 1; j < pre.starts.length; j++) if (pre.starts[j] <= k) li = j
      const h = z.bottom - z.top, lineTop = textStartV + li * pitch
      if (lineTop > z.top) { z.top = lineTop; z.bottom = lineTop + h }
      // 앵커 글자가 줄 중간이고 개체가 그 줄 위보다 아래서 시작하면 앵커 줄은 좁히지 않는다(한컴 저장본: 문단 끝에 앵커한 오프셋 2650 그림 옆 둘째 줄이 온 폭)
      else if (z.top > lineTop && k > pre.starts[li]) z.top = Math.max(z.top, lineTop + pitch)
    }
  }
  // 글 있는 문단의 어울림 개체가 첫 줄 자리를 다 덮으면(남는 틈 1440 미만) 글은 그 개체 아래에서 시작한다
  // (한컴 저장본: 본문 폭 어울림 표 아래 한 줄 — 틈에 한 글자씩 넣던 것. 그림만 있는 문단은 줄이 제자리)
  if (own.length && textish) {
    for (let guard = 0; guard < 8; guard++) {
      const y0 = textStartV, y1 = y0 + height
      let free: Array<[number, number]> = [[marginL, marginL + avail]], bottom = -1
      for (const z of zones) {
        if (!(y1 > z.top && y0 < z.bottom)) continue
        bottom = Math.max(bottom, z.bottom)
        free = free.flatMap(([a, b]): Array<[number, number]> => (z.right <= a || z.left >= b ? [[a, b] as [number, number]] : [[a, Math.max(a, z.left)] as [number, number], [Math.min(b, z.right), b] as [number, number]]).filter(([c, d]) => d - c > 0))
      }
      if (bottom < 0 || free.some(([a, b]) => b - a >= 1440)) break
      textStartV = bottom
      lineBox.length = 0; lineParts.length = 0
    }
  }
  const wrapLines = () => text.length === 0
    ? { lines: 1, starts: [0], lastLineWidth: 0 }
    : simulateWrap(text, firstWrapWidth, contWidth, height, 100, paraMode, { widths, spacings, condensePct: condenseUse, kinsoku: "hancom", before2024: styles.before2024, lineWidth, latinBreak: geom.latinBreak , rightTabs })
  let wrap = wrapLines()
  // 그림이 밀려난 줄도 충돌을 발견한 높이는 유지한다. 다시 넓혀 같은 그림을 끌어오는 진동을 막는다.
  if (zones.length) for (let pass = 0; pass < text.length; pass++) {
    let changed = false
    for (const o of m.objs) if (o.inline) {
      const k = realIdx.indexOf(o.index), om = findChildByLocalName(o.el, "outMargin")
      if (k < 0) continue
      let li = 0
      for (let j = 1; j < wrap.starts.length; j++) if (wrap.starts[j] <= k) li = j
      const h = num(om, "top") + effHOf(o) + num(om, "bottom")
      if (h > Math.max(height, collisionHeights[li] ?? 0)) { collisionHeights[li] = h; changed = true }
    }
    if (!changed) break
    lineBox.length = 0; lineParts.length = 0
    wrap = wrapLines()
  }

  // · inline(treatAsChar=1): 그 줄의 높이가 된다 — outMargin 포함 높이
  /** 줄마다 인라인 개체 높이(outMargin 위아래 포함)의 최대 — 그 줄 높이가 된다 */
  const lineObjH = new Array<number>(wrap.starts.length).fill(0)
  /** 줄마다 인라인 개체의 기준선 위 높이(윗부분) 최대 — 수식은 높이 × baseLine%, 그 밖의 개체는 85% */
  const lineObjAsc = new Array<number>(wrap.starts.length).fill(0)
  /** 줄마다 '줄 간격에 영향'(pos affectLSpacing="1") 개체가 있는지 — 그 줄은 줄 간격 몫을 개체까지 든 줄 높이로 잰다 */
  const lineObjLs = new Array<boolean>(wrap.starts.length).fill(false)
  const lineOf = (slot: number): number => {
    let li = 0
    for (let k = 1; k < wrap.starts.length; k++) if ((wrap.starts[k] < realIdx.length ? realIdx[wrap.starts[k]] : Infinity) <= slot) li = k
    return li
  }
  for (const o of m.objs) {
    if (!o.inline) continue
    const om = findChildByLocalName(o.el, "outMargin")
    const li = lineOf(o.index)
    const h = num(om, "top") + effHOf(o) + num(om, "bottom")
    // 폭을 넘긴 표를 시도했던 컨트롤 전용 줄은 점유 높이를 남긴다. 실제 줄 전진은 글자 높이 그대로다.
    if (o.tag === "tbl" && li > 0 && o.omL + o.width + o.omR > (lineWidth?.(li - 1) ?? (li === 1 ? firstWrapWidth : contWidth))
      && /^[\u2060\ufdd0]+$/.test(text.slice(wrap.starts[li - 1], wrap.starts[li]))) collisionHeights[li - 1] = Math.max(collisionHeights[li - 1] ?? 0, h)
    lineObjH[li] = Math.max(lineObjH[li], h)
    if (findChildByLocalName(o.el, "pos")?.getAttribute("affectLSpacing") === "1") lineObjLs[li] = true
    // 수식 기준선: 한컴 저장 lineseg 631줄 전부 일치(높이 900·baseLine 86 → 774)
    const bl = o.tag === "equation" ? Number(o.el.getAttribute("baseLine")) : NaN
    lineObjAsc[li] = Math.max(lineObjAsc[li], Math.round(h * (Number.isFinite(bl) ? bl / 100 : BASELINE_RATIO)))
  }

  const lsa = doc.createElement("hp:linesegarray")
  // 가운데 배치 세로쓰기 하위 목록의 자동 기준선은 글줄 중앙이다(저장본 29문단).
  const subList = p.parentNode as Element | null
  const verticalCenter = subList?.getAttribute?.("vertAlign") === "CENTER" && ["VERTICAL", "VERTICALALL"].includes(subList.getAttribute("textDirection") ?? "")
  let v = textStartV
  let firstAcc = 0
  // 실텍스트 없는 문단(인라인 표·개체만)의 textpos는 0 — chars.length로 폴백하면
  // planLines의 plan.start가 개체 index보다 커져 advanceTo 가로 전진에서 개체가
  // 전부 빠지고 같은 x에 겹쳐 그려진다 (공문 결재란 라벨표∩스탬프표 겹침의 원인)
  // 첫 줄은 늘 0 — 문단 앞 컨트롤(구역·단 정의, 개체) 슬롯도 첫 줄에 속한다(한컴 저장 lineseg)
  // 줄 나눔으로 끝난 문단의 마지막 빈 줄은 문단 끝 칸에서 시작한다(한컴 저장본: "·네이버AI⏎" 둘째 줄 textpos 8)
  const textposOf = wrap.starts.map((startReal, li) => (li === 0 ? 0 : startReal < realIdx.length ? realIdx[startReal] : realIdx.length ? m.chars.length : 0))
  const heightOf = (prId: string | null): number => (prId != null ? styles.charPr.get(prId)?.height : undefined) || 0
  /** 줄 li 의 글자 높이 — 그 줄 슬롯의 글자와 그 자리 run(마지막 줄은 문단 끝 빈 run 까지) 중 가장 큰 글자 크기.
   *  한컴 저장 lineseg 실측: 표 run 1200 + 문단 끝 빈 run 1500 → 줄간격 180% 의 spacing 1200(1500 기준) */
  const lineTextH = (li: number): number => {
    const s = textposOf[li], last = li === wrap.starts.length - 1, e = last ? m.chars.length : textposOf[li + 1]
    let h = 0
    for (let k = s; k < e; k++) h = Math.max(h, heightOf(m.chars[k].prId))
    for (const r of m.runs) if (r.at >= s && (last ? r.at <= e : r.at < e)) h = Math.max(h, heightOf(r.prId))
    // 문단 번호·글머리표 머리 글은 첫 줄의 글이다 — 머리 글자 모양이 더 크면 첫 줄이 그 높이(한컴 저장본: 1000 문제 발문의 번호 글자 1200 → 줄 1200·간격 960)
    if (li === 0 && bu?.charPrId != null) h = Math.max(h, heightOf(bu.charPrId))
    return h || height
  }
  /** 글꼴에 어울리는 줄 높이 — 줄 li 의 글자마다 글꼴 위·아래 높이로 [줄 높이, 기준선]. 글 없는 줄·표에 없는 글꼴만이면 undefined */
  const fontLineOf = (li: number): [number, number] | undefined => {
    if (!geom.fontLineHeight) return undefined
    const s = textposOf[li], e = li === wrap.starts.length - 1 ? m.chars.length : textposOf[li + 1]
    // ASCII 공백뿐인 줄은 명목 높이 그대로, 글이 있는 줄은 공백 run의 글꼴 높이도 포함한다.
    if (!m.chars.slice(s, e).some(c => c.ch && c.ch !== " ")) return undefined
    let h = 0, b = 0, any = false
    for (let k = s; k < e; k++) {
      const c = m.chars[k]
      if (!c.ch) continue
      const st = c.prId != null ? styles.charPr.get(c.prId) : undefined
      if (!st) continue
      const cp = c.ch.codePointAt(0)!
      const font = c.ch !== " " && st.latin && isLatinCp(cp) ? st.latin : st
      const fm = fontLineMetrics(font.face, font.hft)
      any = true
      // 글꼴 줄 높이 = 반올림한 ascent + 버린 descent(한컴 저장본: 맑은 고딕 1100 → 1198 + 266 = 1464, 1200 → 1307 + 291 = 1598)
      h = Math.max(h, fm ? Math.round(st.height * fm[0]) + (fm[2] ? Math.round : Math.trunc)(st.height * fm[1]) : st.height)
      b = Math.max(b, fm ? Math.round(st.height * fm[0]) : Math.round(st.height * BASELINE_RATIO))
    }
    return any ? [h, b] : undefined
  }
  const natW = widths.reduce((a, w) => a + w, 0) + spacings.reduce((a, w) => a + w, 0)
  for (let li = 0; li < wrap.starts.length; li++) {
    const textpos = textposOf[li]
    // 개체가 있는 줄은 개체 높이가 줄 높이·글자 높이, 기준선은 그 85% (한컴 저장 lineseg 실측: 표 h 3679 + 여백 566 = 4245, 기준선 3608).
    // 줄 간격 몫은 그 줄 글자 높이로 정한다(개체 줄도 — 표 줄 spacing −600 = 1500 × (60% − 100%))
    const fl = fontLineOf(li)
    // 테두리 있는 글자는 글자 상자가 테두리만큼 크다 — 줄 글 높이는 위·아래 테두리까지, 줄 높이(vertsize)는 위 테두리까지
    // (한컴 저장본: 1000 글자 0.15mm 테두리 → 1042·1084, 1200 글자 0.1mm → 1228·1256, 1100 줄의 1000 테두리 글자는 그대로)
    const [boxTop, boxAll, emptyBorder] = lineBorderBox(m, styles, textposOf[li], textposOf[li + 1] ?? m.chars.length)
    const textH0 = fl ? Math.max(fl[0], lineTextH(li)) : lineTextH(li)
    const textH = Math.max(textH0, boxAll)
    // 글 없이 수식만 든 줄은 수식이 글자보다 낮아도 줄 높이가 수식 높이다 — 줄 간격은 글자 높이로(한컴 저장본: 높이 32 수식 줄 vertsize 32, spacing 720 = 1200 × 60%)
    const objOnly = lineObjH[li] > 0 && lineObjH[li] < textH && (() => { const s0 = textposOf[li], e = li === wrap.starts.length - 1 ? m.chars.length : textposOf[li + 1]; for (let k = s0; k < e; k++) { const c = m.chars[k]; if (c.ch && c.ch.trim() !== "") return false } return m.objs.some(o => o.inline && o.tag === "equation" && lineOf(o.index) === li) })()
    // 글 없이 표만 든 문단 끝 줄은 줄 높이가 표(바깥 여백 포함)와 문단 끝 run 의 글자 크기 중 큰 것 — 표를 담은 run 의 글자 크기는 줄 높이에
    // 들지 않고 줄 간격 몫만 정한다(한컴 저장본: 2600 run 의 1848 표 + 1500 빈 run → 줄 2414·간격 −260 = 2600 × 90%, 표와 빈 글이 한 2600 run 이면 2600).
    // 기준선도 그 둘로(2414 × 85% = 2052)
    const endH = li === wrap.starts.length - 1 && lineObjH[li] > 0 && lineObjH[li] < textH && !m.chars.slice(textposOf[li]).some(c => c.ch && c.ch.trim() !== "") &&
      m.objs.some(o => o.inline && o.tag === "tbl" && lineOf(o.index) === li) ? heightOf(m.runs[m.runs.length - 1]?.prId ?? null) : -1
    const lineH = objOnly ? lineObjH[li] : endH >= 0 ? Math.max(lineObjH[li], endH) : Math.max(textH, lineObjH[li])
    // 줄간격 100% 미만이면 음수 — 다음 줄·문단이 그만큼 겹쳐 올라온다. '줄 간격에 영향' 개체 줄은 개체까지 든 줄 높이로
    // (한컴 저장본: 140% 문단의 표 줄 60333 → spacing 24132, 그 표 아닌 개체 줄은 글자 높이 1300 → 520)
    // 고정 줄 간격은 개체 줄도 그 간격만 나아간다(한컴 저장본: 고정 1800 문단의 표 줄 20500 → spacing −18700)
    const spBase = lineObjLs[li] || geom.lineSpacingType === "FIXED" ? lineH : textH
    const spacing = pitchFor(spBase, geom) - spBase
    if (band && v < band[1] && v + lineH > band[0]) v = band[1]
    // 이 줄에 앵커된(첫 줄이 아니면) 위아래 배치 개체는 줄 위에 끼고 줄은 그 아래 — 첫 줄 앵커는 종전대로 문단 위를 차지
    for (const lf of lineFloats) if (lineOf(lf.index) === li) { if (li > 0) v += lf.h; else { firstAcc += lf.h; v = Math.max(v, areaTop + firstAcc) } }
    const vertpos = v
    // 다음 줄 첫 글자가 큰 run의 시작이면 앞줄 점유 상자에도 든다. 글높이·기준선·줄 전진은 자체 높이를 유지한다.
    const nextStart = textposOf[li + 1], nextChar = m.chars[nextStart]
    const boundaryH = !m.objs.length && !geom.fontLineHeight && nextChar?.ch.trim() &&
      m.runs.some(r => r.at === nextStart && r.prId === nextChar.prId) ? heightOf(nextChar.prId) : 0
    const occupiedH = Math.max(lineH, collisionHeights[li] ?? 0, boundaryH)
    v += lineH + spacing
    const isFirst = li === 0
    const seg = doc.createElement("hp:lineseg")
    seg.setAttribute("textpos", String(textpos))
    seg.setAttribute("vertpos", String(vertpos))
    seg.setAttribute("vertsize", String(emptyBorder ? textH0 : occupiedH === textH && boxAll > textH0 ? Math.max(textH0, boxTop) : occupiedH))
    seg.setAttribute("textheight", String(lineH))
    // 기준선 = 글자(높이의 85%)와 개체 윗부분 중 가장 높은 것 — 줄 높이는 그 둘의 합이 아니라 가장 큰 높이다(수식 1650·1050 줄 → 1650, 기준선 924).
    // 문단 세로 정렬이 가운데면 기준선이 줄 가운데(개체 줄 2817 → 1408, 글 줄 1100 → 550), 아래면 줄 바닥(1100 → 1100)
    // 위 정렬이면 0(한컴 저장본: 세로 정렬 TOP 문단의 줄 668개 모두 baseline 0)
    seg.setAttribute("baseline", String(geom.vertAlign === "TOP" ? 0 : geom.vertAlign === "CENTER" || verticalCenter && (!geom.vertAlign || geom.vertAlign === "BASELINE") ? Math.floor(lineH / 2) : geom.vertAlign === "BOTTOM" ? lineH : endH >= 0 ? Math.max(Math.round(endH * BASELINE_RATIO), lineObjAsc[li]) : Math.max(fl ? fl[1] : Math.round(textH0 * BASELINE_RATIO), boxTop > textH0 ? Math.round(boxTop * BASELINE_RATIO) : 0, lineObjAsc[li])))
    seg.setAttribute("spacing", String(spacing))
    let box = boxAt(li)
    // 한 줄 문단이 양쪽에 빈 자리를 남긴 어울림 개체 옆에 오고 글이 왼쪽 조각에 다 들면, 왼쪽 조각에 두고 남은 조각마다
    // 문단 끝 다음 자리의 빈 조각을 둔다(한컴 저장본: 그림 양옆 빈 문단 [0, 왼쪽] [1, 오른쪽], "   - QR코드" [0, 왼쪽] [10, 오른쪽] — 같은 vertpos)
    // 1440(0.2인치)보다 좁은 조각은 비운다 — 한글 2022 재조판: 왼쪽 조각 1439 는 오른쪽 조각 하나, 1440 은 두 조각
    const fit = wrap.starts.length === 1 && lineObjH[li] === 0 ? lineParts[li]?.filter(([a, b]) => b - a >= 1440) : undefined
    const parts = fit && fit.length > 1 && natW <= fit[0][1] - fit[0][0] - Math.max(0, geom.marginIntent) ? fit : undefined
    if (parts) box = [parts[0][0], parts[0][1] - parts[0][0]]
    seg.setAttribute("horzpos", String(box ? box[0] : isFirst ? marginL : contHorz))
    seg.setAttribute("horzsize", String(box ? box[1] : isFirst ? firstWidth : contSegWidth))
    seg.setAttribute("flags", LINESEG_FLAGS)
    if (paraMode === "charAll" && !inlineAt.size && !geom.marginIntent && !bulletW && !condenseUse && appendNarrowLineFragments(lsa, seg, lineParts[li], box,
      { text, widths, spacings, slots: realIdx, start: wrap.starts[li], end: wrap.starts[li + 1] ?? text.length })) continue
    lsa.appendChild(seg)
    for (const [a, b] of parts?.slice(1) ?? []) {
      const more = seg.cloneNode(false) as Element
      more.setAttribute("textpos", String(m.chars.length + 1))
      more.setAttribute("horzpos", String(a))
      more.setAttribute("horzsize", String(b - a))
      lsa.appendChild(more)
    }
  }
  p.appendChild(lsa)

  // 문단 바닥 = 텍스트 줄 흐름(float 개체 아래부터)과 개체 바닥 중 큰 쪽.
  // 표는 셀 콘텐츠 성장으로 선언 sz보다 커질 수 있어 drawTable과 같은 실효 높이를 쓴다
  // (셀 lineseg 필요 — reflowBlockFlow가 reflowTablesIn을 먼저 돌린다).
  const textBottom = v
  // 칸 안 개체 바닥은 다음 문단의 하한이다 — 문단 아래·위 간격을 그 위에 더하지 않는다(한컴 저장본: 아래 간격 300 문단의 표 바닥 25319 = 다음 문단 첫 줄)
  if (cellFloatBottom > 0) floatFloor = Math.max(floatFloor, startV + cellFloatBottom)
  if (band) zones.push({ top: band[0], bottom: band[1], left: -1e9, right: 1e9, flow: "BOTH_SIDES" })
  return { paraBottom: Math.max(textBottom, objBottom), floatFloor, textBottom, spaceAfter: geom.spaceAfter }
}

/** 문단에 앵커된, 쪽 위에 붙은 위아래 배치 개체가 차지하는 띠 [위, 아래](바깥 여백 포함). 없으면 [0, 0] */
const originMemo = new WeakMap<object, [number, number, number]>()
/** 본문 영역의 용지 위 원점 [왼쪽, 위]과 용지 폭 — 왼쪽 여백 + 제본(LEFT), 위 여백 + 머리말 (+ 제본 TOP_BOTTOM) */
function paperOrigin(p: Element): [number, number, number] {
  const d = p.ownerDocument as unknown as object
  const hit = originMemo.get(d)
  if (hit) return hit
  const pagePr = (p.ownerDocument?.getElementsByTagName("hp:pagePr")[0] ?? null) as unknown as Element | null
  const mg = pagePr ? findChildByLocalName(pagePr, "margin") : null
  const tb = pagePr?.getAttribute("gutterType") === "TOP_BOTTOM", gut = num(mg, "gutter")
  const o: [number, number, number] = [num(mg, "left", 8504) + (tb ? 0 : gut), num(mg, "top", 5668) + num(mg, "header") + (tb ? gut : 0), num(pagePr, "width", 59528)]
  originMemo.set(d, o)
  return o
}

/** 쪽이 넘어갈 때 — 쪽 바닥을 넘는 문단 기준 어울림 개체는 다음 쪽 위로 옮겨 그 쪽의 줄을 좁힌다(나머지 영역은 버린다).
 *  한컴 저장본: 쪽 아래 56427 문단의 그림(오프셋 3566, 높이 25554, 바깥 510)이 다음 쪽 0~30000 줄을 좁히고 32000 줄부터 온 폭 */
function carryZones(zones: WrapZone[], bodyH: number, oneColumn: boolean): void {
  // 다단(단 폭 흐름)은 개체가 다음 단으로 가므로 옮기지 않는다(시험지 2단 문서: 옮기면 손해)
  const moved = oneColumn ? zones.filter(z => z.carry !== undefined && (z.bottom > bodyH || z.nextPage)).map(z => ({ ...z, top: 0, bottom: z.carry!, carry: undefined, nextPage: undefined })) : []
  zones.length = 0
  zones.push(...moved)
}

/** 자란 표로 볼 높이 차(HWPUNIT) — 다시 짠 칸 줄과 한컴 줄의 글꼴 근사 차이보다 크고 한 줄보다 작게 */
const STALE_SLACK = 500

/** 문단에 든 글자처럼 취급 표 중 캐시 없는 칸 문단이 있는 표 — 칸 글을 다시 짜므로 저장 높이보다 자랄 수 있다 */
function regrownInlineTables(p: Element): Element[] {
  const out: Element[] = []
  for (const run of elements(p)) {
    if (ln(run) !== "run") continue
    for (const o of elements(run)) {
      if (ln(o) !== "tbl" || findChildByLocalName(o, "pos")?.getAttribute("treatAsChar") !== "1") continue
      if (Array.from(o.getElementsByTagName("*") as unknown as Element[]).some(e => ln(e) === "p" && !findChildByLocalName(e, "linesegarray"))) out.push(o)
    }
  }
  return out
}

function pageTopBand(p: Element): [number, number] {
  let top = Infinity, bot = 0
  for (const run of elements(p)) {
    if (ln(run) !== "run") continue
    for (const o of elements(run)) {
      if (!OBJ_TAGS.has(ln(o)) || o.getAttribute("textWrap") !== "TOP_AND_BOTTOM") continue
      const pos = findChildByLocalName(o, "pos")
      if (pos?.getAttribute("treatAsChar") === "1" || pos?.getAttribute("vertRelTo") !== "PAGE" || (pos?.getAttribute("vertAlign") ?? "TOP") !== "TOP") continue
      const om = findChildByLocalName(o, "outMargin"), sz = findChildByLocalName(o, "sz")
      const h = ln(o) === "tbl" ? Math.max(num(sz, "height"), measureTableHeight(o)) : num(sz, "height")
      const vo = Math.max(0, num(pos, "vertOffset"))
      top = Math.min(top, vo); bot = Math.max(bot, vo + num(om, "top") + h + num(om, "bottom"))
    }
  }
  return bot > 0 ? [top, bot] : [0, 0]
}

/** 도형 글상자(drawText)의 글 높이 — 안 글 lineseg 바닥 + 안 여백 위·아래. 글상자가 없으면 0 */
function drawTextHeight(el: Element): number {
  const dt = findChildByLocalName(el, "drawText")
  const sub = dt ? findChildByLocalName(dt, "subList") : null
  if (!sub) return 0
  let bottom = 0
  for (const q of elements(sub)) {
    if (ln(q) !== "p") continue
    const lsa = findChildByLocalName(q, "linesegarray")
    for (const seg of lsa ? elements(lsa) : []) if (ln(seg) === "lineseg") bottom = Math.max(bottom, num(seg, "vertpos") + num(seg, "vertsize"))
  }
  const tm = findChildByLocalName(dt!, "textMargin")
  return bottom > 0 ? bottom + num(tm, "top") + num(tm, "bottom") : 0
}

/** 구역 각주 모양의 간격(secPr footNotePr noteSpacing) — 구분선 위·아래, 각주 사이 */
function footNoteSpacing(root: Element): { above: number; below: number; between: number } {
  const pr = root.getElementsByTagName("hp:footNotePr")[0] as unknown as Element | undefined
  const sp = pr ? findChildByLocalName(pr, "noteSpacing") : null
  return { above: num(sp, "aboveLine", 850), below: num(sp, "belowLine", 567), between: num(sp, "betweenNotes", 283) }
}

/** 각주 하위 목록 높이 — lineseg 바닥(이미 reflow 된 것) */
function footNoteBottom(fn: Element): number {
  const sub = findChildByLocalName(fn, "subList")
  let bottom = 0
  for (const q of sub ? elements(sub) : []) {
    if (ln(q) !== "p") continue
    const lsa = findChildByLocalName(q, "linesegarray")
    for (const seg of lsa ? elements(lsa) : []) if (ln(seg) === "lineseg") bottom = Math.max(bottom, num(seg, "vertpos") + num(seg, "vertsize"))
  }
  return bottom
}

/** 문단에 든 각주마다 [높이, 참조 글자 자리] — 본문 참조는 그 컨트롤 칸, 표 칸·글상자 안 각주는 그 개체 칸 */
function footNoteRefs(p: Element): Array<[number, number]> {
  const m = buildPara(p)
  const out: Array<[number, number]> = []
  m.chars.forEach((c, i) => { if (c.note && ln(c.note) === "footNote") out.push([footNoteBottom(c.note), i]) })
  for (const o of m.objs) for (const fn of Array.from(o.el.getElementsByTagName("hp:footNote") as unknown as Element[])) out.push([footNoteBottom(fn), o.index])
  return out
}

/** 문단에 든 각주마다 높이 — 하위 목록 lineseg 바닥(이미 reflow 된 것). 문단 안 표 칸·글상자에 붙은 각주도 그 쪽 각주다 */
function footNoteHeights(p: Element, ownOnly = false): number[] {
  const out: number[] = []
  // (한컴 저장본: 그림 표 칸 안 각주 4줄이 있는 쪽은 본문 바닥이 그만큼 올라 다음 제목이 새 쪽으로)
  for (const fn of Array.from(p.getElementsByTagName("hp:footNote") as unknown as Element[])) {
    const sub = findChildByLocalName(fn, "subList")
    if (!sub) continue
    // ownOnly: 쪽에서 갈리는 떠 있는 표(CELL·TABLE) 칸 안의 각주는 뺀다
    if (ownOnly) {
      let a: Node | null = fn.parentNode, inSplit = false
      while (a && a !== p) { const e = a as Element; if (ln(e) === "tbl" && (e.getAttribute("pageBreak") === "CELL" || e.getAttribute("pageBreak") === "TABLE") && findChildByLocalName(e, "pos")?.getAttribute("treatAsChar") !== "1") inSplit = true; a = a.parentNode }
      if (inSplit) continue
    }
    let bottom = 0
    for (const q of elements(sub)) {
      if (ln(q) !== "p") continue
      const lsa = findChildByLocalName(q, "linesegarray")
      for (const seg of lsa ? elements(lsa) : []) if (ln(seg) === "lineseg") bottom = Math.max(bottom, num(seg, "vertpos") + num(seg, "vertsize"))
    }
    out.push(bottom)
  }
  return out
}

/**
 * 한 블록 컨테이너(본문 root 또는 셀 subList) 안 문단들을 세로 흐름으로 reflow.
 * @param bodyH 최상위(본문)일 때만 >0 — 문단 단위 자동 페이지 나눔(vertpos 페이지 로컬 리셋).
 *   셀 subList는 0(페이지 나눔 없음).
 */
function reflowBlockFlow(
  container: Element,
  doc: Document,
  styles: RenderStyles,
  areaW: number,
  mode: WrapMode,
  counter: { n: number; bodyW?: number; endNoteW?: number; nums?: NumberCounters },
  bodyH: number,
): void {
  let cursorV = 0
  let prevSpaceAfter = 0
  /** 앞 문단(글 없는)의 떠 있는 개체 바닥 — 다음 문단 첫 줄은 그 아래(간격을 더하지 않는다) */
  let floatFloor = 0
  /** 이 쪽(단)에 놓인 각주 수·높이 합 */
  let pageNotes = 0, pageFoot = 0
  /** 쪽 끝 줄과 함께 안 들어 다음 쪽으로 넘긴 각주 수·높이 */
  let carryNotes = 0, carryFoot = 0
  /** 앞 문단까지 이 쪽에 놓인 내용 바닥(끝 줄 바닥, 쪽을 넘긴 표는 그 나머지 바닥) — 넘친 각주를 잴 때 */
  let contentBottom = 0
  /** 떠 있는 표가 쪽 바닥을 넘어 나뉘어 이 문단 뒤로 새 쪽이 시작됐다 — 앞 쪽 각주는 새 쪽 각주 영역에 들지 않는다 */
  let splitPage = false
  const footSp = footNoteSpacing(container)
  /** 이 흐름에 앵커된 어울림 개체 영역 — 뒤 문단의 줄도 피해 간다 */
  const zones: WrapZone[] = []
  /** 이 쪽에서 글이 내려갈 수 있는 바닥 — 쪽 아래에 붙은 위아래 배치 개체(결재란 표 등)가 있으면 그만큼 올라온다 */
  let pageLimit = bodyH
  /** 바로 앞에 놓은 문단(쪽에 걸치지 않고 제자리에 놓인 경우만) — '다음 문단과 함께' 처리용 */
  let prevPlaced: { p: Element; startV: number; top: number; h: number; spaceAfter: number; keepWithNext: boolean } | undefined
  // 구역 본문의 다단(colPr colCount>1) — 단 정의가 나온 문단부터 단 폭으로 채운다(한컴 다단 편집 lineseg horzsize 실측)
  const bodyFlow = areaW === counter.bodyW && bodyH > 0
  // 첫 빈 줄 감추기(secPr visibility hideFirstEmptyLine) — 새 쪽 맨 위에 올 빈 문단(이어진 둘까지)은 앞 쪽 바닥 아래에 남긴다(새 쪽은 다음 글부터)
  const vis = bodyH > 0 ? findFirst(container, "visibility") : null
  const hideFirstEmpty = vis?.getAttribute("hideFirstEmptyLine") === "1"
  /** 이어서 쪽 바닥 아래에 감춘 빈 문단 수 — 둘까지만 감추고 셋째부터는 새 쪽 맨 위에 놓는다
   *  (한컴 저장본: 빈 문단 둘이 같은 자리 74144·74144 에 감춰지고 다음 개체 문단이 새 쪽 0, 이어진 빈 문단 셋째는 새 쪽 0) */
  let hidPrev = 0
  // 칸 안 다단 — 단 폭으로 채우고, 단 나누기 문단은 다음 단 맨 위(한컴 저장본: 2단 칸의 단 나누기 문단 vertpos 0, 줄 폭 19420)
  const cellW = areaW
  let cellCols = 1, cellCol = 0
  /** 칸 글로 자란 표를 지났다 — 뒤 문단의 저장 자리는 모두 옛 표 높이 기준이라 흐름 끝까지 다시 짠다 */
  let staleRest = false
  for (const p of elements(container)) {
    if (ln(p) !== "p") continue
    if (bodyFlow) { const colW = columnWidthIn(p, counter.bodyW!); if (colW !== undefined) areaW = colW }
    else if (bodyH === 0) {
      const colW = columnWidthIn(p, cellW)
      if (colW !== undefined) { cellCols = colW === cellW ? 1 : Math.round((cellW + 1) / (colW + 1)); areaW = colW }
      if (cellCols > 1 && cellCol < cellCols - 1 && cursorV > 0 && p.getAttribute("columnBreak") === "1") { cellCol++; cursorV = 0; prevSpaceAfter = 0 }
    }
    // 문단 안 표 셀을 먼저 셀 로컬 좌표로 reflow (본문 세로 흐름과 무관) —
    // reflowPara의 표 실효높이 측정이 셀 lineseg를 읽으므로 호스트 문단보다 앞서야 한다
    const regrown = regrownInlineTables(p)
    reflowTablesIn(p, doc, styles, mode, counter, reflowBlockFlow)
    reflowSubListsIn(p, doc, styles, mode, counter, reflowBlockFlow, bodyFlow ? areaW : undefined)
    const g = styles.paraGeom.get(p.getAttribute("paraPrIDRef") ?? "")
    const cursorBefore = cursorV
    let startV = Math.max(cursorV + prevSpaceAfter + (g?.spaceBefore ?? 0), floatFloor)
    floatFloor = 0
    // 쪽 위에 붙은 위아래 배치 개체(vertRelTo=PAGE·vertAlign=TOP, 두문 결재표 등)는 그 아래부터 글을 놓는다(한컴 저장본: 첫 줄 vertpos 17304 = 표 바닥)
    if (bodyH > 0) { const [top, bot] = pageTopBand(p); if (bot > 0 && top <= startV && startV < bot) startV = bot }
    // 낡은 조판 캐시 — 한컴은 열 때 늘 다시 짜서 칸 글이 늘어난 표는 행이 자라고 뒤 문단이 밀린다. 캐시를 믿으면 옛 자리에 그려 자란 표와
    // 겹쳤다(패치로 칸 글만 늘린 표). 칸 글을 다시 짠 글자처럼 취급 표가 저장 높이보다 자라면 그 문단부터 흐름 끝까지 캐시를 버리고 다시 짠다
    // (뒤 문단 하나만 버리면 밀려 넘어간 쪽에서 다음 캐시 문단을 새 쪽 첫 줄로 보고 옛 자리, 쪽 아래에 그렸다)
    staleRest ||= regrown.some(t => measureTableHeight(t, geomMemo(styles)) > num(findChildByLocalName(t, "sz"), "height") + STALE_SLACK)
    const lsaC = staleRest ? findChildByLocalName(p, "linesegarray") : null
    if (lsaC) p.removeChild(lsaC)
    const numsBefore: NumberCounters = new Map([...(counter.nums ?? [])].map(([k, v]) => [k, v.slice()]))
    const zonesBefore = zones.length
    let res = reflowPara(p, doc, styles, areaW, startV, mode, zones, counter.nums, bodyH > 0, bodyH)
    // 앞 문단의 띠에 밀려 첫 줄이 띠 아래로 간 문단은 앵커 개체도 함께 옮긴다 — 띠 바닥에서 다시 조판
    // (한컴 저장본: 띠 표 바닥 22846 에 밀린 위 간격 1416 문단의 표가 22846 − 1416 + 오프셋 2638 에, 다음 문단은 그 바닥 35236)
    if (res && bodyFlow) {
      const lsa0 = findChildByLocalName(p, "linesegarray"), s0 = lsa0 ? elements(lsa0).find(e => ln(e) === "lineseg") : undefined
      const v0 = s0 ? num(s0, "vertpos") : startV
      const bandZ = v0 > startV ? zones.slice(0, zonesBefore).find(z => z.left <= -1e8 && z.bottom === v0 && z.top < v0) : undefined
      if (bandZ && hasTbFloat(p)) {
        p.removeChild(lsa0!)
        zones.length = zonesBefore
        res = reflowPara(p, doc, styles, areaW, v0, mode, zones, new Map([...numsBefore].map(([k, v]) => [k, v.slice()])), bodyH > 0, bodyH)
        startV = v0
      }
    }
    if (!res) {
      // 캐시 보유 문단(Tier-1) — 한컴 실좌표로 커서를 전진시킨다. 혼합 캐시 문서
      // (한컴 저장본을 프로그램 편집해 일부 문단만 캐시가 없는 경우)에서 캐시 없는
      // 문단이 흐름 위치 대신 0에 겹쳐 그려지던 결함 수정 (36264961 실측: 캐시 문단
      // p18 57165+1300+780 → 캐시 없는 p19가 정확히 59245에 붙는다).
      const lsa = findChildByLocalName(p, "linesegarray")
      if (lsa) {
        const bottom = cachedParagraphBottom(lsa, bodyFlow)
        if (Number.isFinite(bottom)) {
          cursorV = bottom
          prevSpaceAfter = g?.spaceAfter ?? 0
        }
      }
      continue
    }
    const paraH = res.paraBottom - startV
    // 페이지 넘김은 줄 단위다: 줄 vertpos + vertsize 가 본문 높이를 넘으면 그 줄부터 다음 쪽 맨 위(0)에서 이어진다
    // (간격 몫은 넣지 않는다 — 한컴 저장본에서 쪽에 걸친 문단 97개 중 86개, 나머지는 칸 안 쪽 나눔). 문단 첫 줄은 쪽보다 높아도
    // 쪽 중간에서 넘치면 새 쪽 맨 위로(한컴 저장본: 쪽 높이 표 75704 뒤 쪽보다 153 높은 표 문단이 새 쪽 0, 68984 의 표 줄 71603 도 새 쪽 0).
    // 명시적 쪽 나눔(hp:p pageBreak="1" — 한컴 '쪽 나누기' 저장 속성)과 첫 줄부터 넘치는 문단은 문단째 다음 쪽으로.
    // 단 나누기(hp:p columnBreak="1")도 같다 — 새 단 맨 위(다단 문서는 단마다 본문 높이로 쪽처럼 흐른다)
    const explicitBreak = bodyH > 0 && startV > 0 && (p.getAttribute("pageBreak") === "1" || p.getAttribute("columnBreak") === "1" || !!g?.pageBreakBefore)
    const lines = bodyH > 0 ? elements(findChildByLocalName(p, "linesegarray") ?? p).filter(e => ln(e) === "lineseg") : []
    // 쪽 아래에 붙은 위아래 배치 개체(vertRelTo=PAGE·vertAlign=BOTTOM)는 그 쪽 바닥을 개체 몫만큼 올린다 — 앵커 문단이 그 위에 못 들어가면
    // 문단째(개체와 함께) 다음 쪽으로(한컴 저장본: 결재란 표 26793 이 붙은 끝 문단이 새 쪽 0 에서 시작)
    const reserve = bodyH > 0 ? pageBottomReserve(p) : 0
    // 쪽 아래 각주 영역은 본문 바닥을 올린다 — 이 쪽에 놓인 문단의 각주 + 이 문단의 각주, 구분선 위·아래 간격과 각주 사이 간격 포함
    // (한컴 저장본: 각주 900·2072 둘인 쪽은 본문 71714 − (850 + 567 + 2972 + 283) = 67042 까지, 68136 에 닿는 줄은 다음 쪽)
    const fns = bodyH > 0 ? footNoteHeights(p) : []
    const footArea = (n: number, sum: number): number => (n > 0 ? footSp.above + footSp.below + sum + footSp.between * (n - 1) : 0)
    const fnSum = fns.reduce((a, b) => a + b, 0)
    const limFoot = bodyH - footArea(pageNotes + fns.length, pageFoot + fnSum)
    const lim = Math.min(reserve > 0 ? Math.min(pageLimit, bodyH - reserve) : pageLimit, limFoot)
    // 쪽에서 갈리는 떠 있는 표의 칸 안 각주는 앵커 줄과 함께 세지 않는다 — 표를 행으로 가를 때 행이 놓인 쪽의 각주로 센다
    // (한컴 저장본: 칸 안 각주 6개인 7행 표의 빈 앵커 줄 53532 는 제자리, 표는 행마다 각주 영역을 올리며 갈린다)
    const fnsOwn = fns.length ? footNoteHeights(p, true) : fns, ownSum = fnsOwn.reduce((a, b) => a + b, 0)
    const limOwn = fnsOwn.length < fns.length ? Math.min(reserve > 0 ? Math.min(pageLimit, bodyH - reserve) : pageLimit, bodyH - footArea(pageNotes + fnsOwn.length, pageFoot + ownSum)) : lim
    // 줄마다 쪽 바닥 — 그 줄까지 참조된 각주만 이 쪽 각주 영역에 든다(쪽에 걸친 문단: 뒤 줄의 각주는 다음 쪽)
    const refs = bodyH > 0 && fns.length ? footNoteRefs(p) : []
    const tpOf = (seg: Element): number => num(seg, "textpos")
    const limAt = (i: number): number => {
      if (!refs.length) return lim
      const end = i + 1 < lines.length ? tpOf(lines[i + 1]) : Number.POSITIVE_INFINITY
      // 둘째 줄부터는 그 줄 자신의 각주를 빼고 잰다 — 줄은 들고 각주만 안 들면 줄은 이 쪽, 각주는 다음 쪽(아래)
      const inn = refs.filter(([, at]) => at < (i > 0 ? tpOf(lines[i]) : end))
      const base = reserve > 0 ? Math.min(pageLimit, bodyH - reserve) : pageLimit
      return Math.min(base, bodyH - footArea(pageNotes + inn.length, pageFoot + inn.reduce((a, [h]) => a + h, 0)))
    }
    // 줄 바닥이 쪽 바닥과 같으면 넘친 것으로 본다(+1) — 저장본에 본문 높이에서 딱 끝나는 줄은 없고, 그런 줄은 다음 쪽 맨 위(한컴 저장본: 68718 + 1300 = 70018 인 줄이 새 쪽 0)
    const lineBottom = (seg: Element): number => num(seg, "vertpos") + num(seg, "vertsize") + (reserve > 0 ? num(seg, "spacing") : 0) + 1
    let firstOver = lines.length > 0 && startV > 0 && lineBottom(lines[0]) > (limOwn !== lim ? limOwn : limAt(0))
    // 글머리표 빈 호스트의 줄은 표 아래 — 넘침은 줄이 아니라 표(행 나눔)로 본다
    const BUH = bodyH > 0 && bulletEmptyHost(p, g)
    if (firstOver && BUH) firstOver = false
    let hidden = false
    if (firstOver && hideFirstEmpty && lines.length === 1 && hidPrev < 2) {
      const pm = buildPara(p)
      if (pm.objs.length === 0 && !pm.chars.some(c => c.ch.trim() !== "")) { firstOver = false; hidden = true }
    }
    /** 줄 단위 쪽 넘김으로 뒤 줄들이 옮겨 간 양(음수) — 0 이면 쪽이 안 나뉘었다 */
    let off = 0
    // 넘치는 첫 줄 번호 — 외톨이줄 보호면 쪽 끝 첫 줄 하나만 남기지 않고(문단째), 다음 쪽에 마지막 줄 하나만 보내지 않는다(한 줄 앞에서)
    let cut = -1
    if (!explicitBreak && !firstOver && lines.length > 1) {
      cut = lines.findIndex((seg, i) => i > 0 && lineBottom(seg) > limAt(i) && num(seg, "vertsize") <= bodyH)
      if (cut > 0 && g?.widowOrphan && lines.length >= 3 && cut === lines.length - 1) cut--
    }
    // 외톨이줄 보호로 첫 줄만 남거나, 문단 보호(keepLines)면 쪽에 걸치지 않고 문단째 넘긴다
    const orphan = (cut === 1 && !!g?.widowOrphan) || (cut > 0 && !!g?.keepLines)
    if (cut > 0 && !orphan) {
      for (let i = cut; i < lines.length; i++) {
        const seg = lines[i]
        let vp = num(seg, "vertpos") + off
        const vs = num(seg, "vertsize")
        if (i === cut || (vp > 0 && vp + vs > bodyH && vs <= bodyH)) { off -= vp; vp = 0; carryZones(zones, bodyH, areaW === counter.bodyW) }
        seg.setAttribute("vertpos", String(vp))
      }
    }
    if (explicitBreak || firstOver || orphan || (bodyH > 0 && startV > 0 && lines.length === 0 && res.paraBottom > bodyH && paraH <= bodyH)) {
      // 다음 쪽으로 옮기는 문단이 옛 자리에서 넣은 제 개체 영역은 버린다 — 새 쪽에서 다시 조판하면 새 자리에 다시 생긴다(남기면 넘어간 개체로 새 쪽 위를 막는다.
      // 한컴 PDF: 쪽 나누기 빈 문단의 어울림 표 55942 가 새 쪽 맨 위, 줄도 0)
      const own = zones.length > zonesBefore
      zones.length = zonesBefore
      if (zones.length || own) {
        // 앞 쪽의 어울림 개체는 새 쪽 줄을 좁히지 않는다 — 비우고 새 쪽 상단에서 다시 조판(쪽 바닥을 넘어 옮겨지는 개체만 남긴다)
        carryZones(zones, bodyH, areaW === counter.bodyW)
        const lsa = findChildByLocalName(p, "linesegarray")
        if (lsa) p.removeChild(lsa)
        const zb = zones.length
        const sb0 = g?.spaceBefore ?? 0
        let moveRes = reflowPara(p, doc, styles, areaW, sb0, mode, zones, new Map([...numsBefore].map(([k, v]) => [k, v.slice()])), true, bodyH)! // 번호는 이미 셌다 — 센 직전 상태로 다시
        // 옮겨 온 개체 띠에 밀린 첫 줄이면 앵커 표도 그 아래로(위 띠 규칙과 같다)
        const lsaM = findChildByLocalName(p, "linesegarray"), sM = lsaM ? elements(lsaM).find(e => ln(e) === "lineseg") : undefined
        const vM = sM ? num(sM, "vertpos") : sb0
        if (vM > sb0 && zones.slice(0, zb).some(z => z.left <= -1e8 && z.bottom === vM && z.top < vM) && hasTbFloat(p)) {
          p.removeChild(lsaM!); zones.length = zb
          moveRes = reflowPara(p, doc, styles, areaW, vM, mode, zones, new Map([...numsBefore].map(([k, v]) => [k, v.slice()])), true, bodyH)!
        }
        cursorV = moveRes.paraBottom
        // 새 쪽 맨 위로 옮긴 글 없는 문단의 어울림 표가 그 쪽보다 길면 그 쪽부터 행 단위로 나눈다
        if (bodyH > 0 && squareTableOver(p, 0, bodyH)) {
          const split2 = splitFloatTableRemainder(p, 0, bodyH, bodyH, styles)
          if (split2 !== undefined) { cursorV = 0; floatFloor = split2; zones.length = 0; splitPage = true }
        }
      } else {
        // 새 페이지 상단으로 이동 → 프리패스가 vertpos 역행 감지. 문단 위 간격은 새 쪽에서도 남는다(한컴 저장본: 새 쪽 첫 줄 vertpos = prev 1200)
        const top = g?.spaceBefore ?? 0
        shiftParaVert(p, top - startV)
        cursorV = paraH + top
        // 새 쪽으로 옮겨서도 쪽보다 높으면(쪽 나누기 문단의 긴 떠 있는 표) 그 표를 그 쪽부터 나눈다
        if (bodyH > 0 && (top + paraH > bodyH || squareTableOver(p, top, bodyH))) {
          const split2 = splitFloatTableRemainder(p, top, bodyH, bodyH, styles)
          if (split2 !== undefined) { cursorV = 0; floatFloor = split2; zones.length = 0; splitPage = true }
        }
        // 앞 문단이 '다음 문단과 함께'면 그 문단도 새 쪽으로 — 앞 문단을 새 쪽 위에 두고 이 문단을 그 아래로
        if (prevPlaced?.keepWithNext && prevPlaced.startV > prevPlaced.top) {
          shiftParaVert(prevPlaced.p, prevPlaced.top - prevPlaced.startV)
          const base = prevPlaced.top + prevPlaced.h + prevPlaced.spaceAfter
          shiftParaVert(p, base)
          cursorV += base
        }
      }
    } else {
      cursorV = (res.floatFloor > 0 && off === 0 ? res.textBottom : res.paraBottom) + off
      if (res.floatFloor > 0 && off === 0) floatFloor = res.floatFloor
      // 글 없는 앵커 문단의 떠 있는 위아래 배치 표가 쪽 바닥을 넘으면 행 단위로 다음 쪽으로 나뉜다 — 다음 문단은 다음 쪽의 남은 행 아래
      // (한컴 저장본: 1쪽에 행 바닥 + outMargin 아래가 본문 높이 안에 드는 22행, 2쪽에 8행 × 1482 + 141 = 다음 문단 vertpos 11997)
      // 표는 문단 위 여백 앞에서 가른다 — 글머리표 빈 호스트 경로와 같다(한컴 저장본: 위 여백 500 문단의 2행 칸 안 나눔 표의 첫 조각
      // 11,058(= 저장 표 높이 12,840 − 앞 행 1,782)은 위 여백 앞에서 재야 쪽 바닥 안에 든다)
      const split = bodyH > 0 && off === 0 && (res.paraBottom > lim || squareTableOver(p, startV, lim)) ? splitFloatTableRemainder(p, startV - (g?.spaceBefore ?? 0), limOwn, bodyH, styles, false, { n0: pageNotes + fnsOwn.length, s0: pageFoot + ownSum, area: footArea }) : undefined
      // 오프셋 둔 표가 첫 행부터 안 들어 통째로 다음 쪽 맨 위로 가면(다음 쪽에 다 들 때) 이 쪽은 표 자리부터 띠 — 그 위에 드는 뒤 글은 이 쪽에 남고,
      // 다음 쪽 글은 그 표 아래에서(한컴 저장본: 오프셋 3022 그림 표 23062 의 빈 앵커 59941 뒤 문단 61941 은 제자리, 그다음은 새 쪽 23628 = 283 + 23062 + 283)
      const tEl = split !== undefined && splitWhole ? m0Objs(p) : undefined
      const tVo = tEl ? num(findChildByLocalName(tEl, "pos"), "vertOffset") : 0
      const tOm = tEl ? findChildByLocalName(tEl, "outMargin") : null
      if (tEl && tVo > 0 && tVo < 2 ** 31 && num(tOm, "top") + measureTableHeight(tEl) + num(tOm, "bottom") <= bodyH) {
        const tTop = startV - (g?.spaceBefore ?? 0) + tVo
        zones.push({ top: tTop, bottom: Math.max(bodyH + 1, tTop + 1), left: -1e9, right: 1e9, flow: "BOTH_SIDES", carry: split })
        floatFloor = 0; cursorV = res.textBottom
      } else if (split !== undefined && splitMovedLast) {
        cursorV = 0; floatFloor = split; zones.length = 0; splitPage = true
        // 줄이 표 아래에 있는 호스트(글머리표 빈 문단)는 줄도 마지막 쪽의 표 나머지 아래로
        const own = BUH ? elements(findChildByLocalName(p, "linesegarray") ?? p).filter(e => ln(e) === "lineseg") : []
        if (own.length) {
          const d = split - num(own[0], "vertpos")
          for (const sg of own) sg.setAttribute("vertpos", String(num(sg, "vertpos") + d))
          cursorV = res.textBottom + d; floatFloor = 0
        }
      }
      // 글 있는 앵커 문단도 옆에 글 들 폭이 없는 어울림 나눔 표가 쪽 바닥을 넘으면 행 단위로 나뉘고, 문단 글은 마지막 쪽의 표 아래로 간다
      // (한컴 저장본: 폭 47903 표가 다음 쪽에서 끝난 뒤 앵커 글 줄이 표 바닥 아래, 다음 문단도 그 아래)
      else if (bodyH > 0 && off === 0 && squareTableOver(p, startV, lim, true, areaW)) {
        const split3 = splitFloatTableRemainder(p, startV, lim, bodyH, styles, true)
        const lsa = findChildByLocalName(p, "linesegarray")
        const own = lsa ? elements(lsa).filter(e => ln(e) === "lineseg") : []
        // 글 줄이 표 위끝(문단 위 + 세로 오프셋 + 바깥 여백 위)보다 위에서 끝나면 글은 제자리, 다음 문단만 마지막 쪽의 표 나머지 아래로
        // (한컴 저장본: 오프셋 2829 어울림 36행 표의 앵커 글 한 줄 41803 은 첫 쪽 제자리, 다음 문단은 셋째 쪽 표 나머지 아래 29276)
        const sq = m0Objs(p), sqPos = sq ? findChildByLocalName(sq, "pos") : null
        const sqVo = num(sqPos, "vertOffset"), sqTop = startV + Math.max(0, sqVo >= 2 ** 31 ? sqVo - 2 ** 32 : sqVo) + num(sq ? findChildByLocalName(sq, "outMargin") : null, "top")
        if (split3 !== undefined && sq && own.length && own.every(sg => num(sg, "vertpos") + num(sg, "vertsize") <= sqTop)) {
          cursorV = 0; floatFloor = split3; zones.length = 0; splitPage = true
        } else if (split3 !== undefined && own.length) {
          const d = split3 - num(own[0], "vertpos")
          for (const sg of own) sg.setAttribute("vertpos", String(num(sg, "vertpos") + d))
          cursorV = res.textBottom + d; zones.length = 0; splitPage = true
        }
      }
      // 글 있는 문단의 띠(글 아래 오프셋) 위아래 배치 표가 쪽 바닥을 넘으면 행 단위로 나뉜다 — 문단 글은 제자리(띠 위), 다음 문단은 마지막 쪽의 표 아래
      // (한컴 저장본: 오프셋 2636 표의 앵커 "조직 및 인력" 7100 은 제자리, 다음 문단은 다음 쪽 표 나머지 아래 68152). 넘침은 칸 내용 높이로 본다(묵은 칸 높이는 안 봄)
      else if (bodyH > 0 && off === 0 && bandTableOver(p, startV - (g?.spaceBefore ?? 0), lim)) {
        const BU = BUH
        const split4 = splitFloatTableRemainder(p, startV - (g?.spaceBefore ?? 0), BU ? limOwn : lim, bodyH, styles, true, BU ? { n0: pageNotes + fnsOwn.length, s0: pageFoot + ownSum, area: footArea } : undefined)
        if (split4 !== undefined) {
          cursorV = 0; floatFloor = split4; zones.length = 0; splitPage = true
          const own = BU && splitMovedLast ? elements(findChildByLocalName(p, "linesegarray") ?? p).filter(e => ln(e) === "lineseg") : []
          if (own.length) {
            const d = split4 - num(own[0], "vertpos")
            for (const sg of own) sg.setAttribute("vertpos", String(num(sg, "vertpos") + d))
            cursorV = res.textBottom + d; floatFloor = 0
          }
        }
      }
    }
    // 쪽 바닥 아래에 감춘 빈 문단은 높이를 차지하지 않는다 — 커서·아래 간격을 그 문단 앞 그대로 둔다
    // (한컴 저장본: 감춘 빈 문단이 이어지면 56197·56197 처럼 겹치고, 위 간격 800 인 감춘 문단 55899 뒤 위 간격 0 문단은 55099)
    const keepCursor = hidden && !explicitBreak
    hidPrev = hidden ? hidPrev + 1 : 0
    prevPlaced = off === 0 && !(explicitBreak || firstOver || orphan) ? { p, startV, top: g?.spaceBefore ?? 0, h: paraH, spaceAfter: res.spaceAfter, keepWithNext: !!g?.keepWithNext } : undefined
    // 새 쪽으로 넘어갔으면 바닥을 되돌리고, 이 문단의 쪽 아래 개체가 있는 쪽이면 그 몫을 남긴다
    const moved = explicitBreak || firstOver || orphan || off !== 0
    pageLimit = reserve > 0 ? bodyH - reserve : moved ? bodyH : Math.min(pageLimit, reserve > 0 ? bodyH - reserve : pageLimit)
    if (moved && refs.length && cut > 0 && !orphan && !explicitBreak && !firstOver) {
      // 쪽에 걸친 문단: 넘어간 줄의 각주만 새 쪽 각주
      // 쪽 끝 줄의 각주가 그 줄과 함께 안 들면(줄만 남았으면) 그 각주도 다음 쪽
      // (한컴 저장본: 각주 900 참조 줄 68915 는 각주 영역 850 + 567 + 900 과 함께 본문 71714 에 안 들지만 그 쪽 끝 줄로 남는다)
      const lastKept = lines[cut - 1], fromKept = tpOf(lastKept)
      const keptRefs = refs.filter(([, at]) => at >= fromKept && at < tpOf(lines[cut]))
      const before = refs.filter(([, at]) => at < fromKept)
      const pushed = keptRefs.length && cut > 1 && lineBottom(lastKept) > bodyH - footArea(pageNotes + before.length + keptRefs.length, pageFoot + [...before, ...keptRefs].reduce((a2, [h]) => a2 + h, 0))
      const from = pushed ? fromKept : tpOf(lines[cut]), mv = refs.filter(([, at]) => at >= from)
      pageNotes = mv.length; pageFoot = mv.reduce((a, [h]) => a + h, 0)
      pageNotes += carryNotes; pageFoot += carryFoot; carryNotes = 0; carryFoot = 0
    } else if (moved) {
      // 앞 쪽 각주가 그 쪽 내용 바닥 아래에 다 안 들면 남는 몫은 다음 쪽 각주 영역으로 이어진다(본문이 먼저 — 각주 많은 표가 그 쪽에 다 들고,
      // 한컴 저장본: 칸 안 각주 18개 표 다음 쪽은 본문이 30000 근처에서 끊긴다)
      {
        const prevBottom = off !== 0 && cut > 0 ? num(lines[cut - 1], "vertpos") + num(lines[cut - 1], "vertsize") : contentBottom
        const excess = footArea(pageNotes, pageFoot) - (bodyH - prevBottom)
        if (excess > 0 && pageNotes > 0) { carryNotes += 1; carryFoot += excess }
      }
      pageNotes = fns.length + carryNotes; pageFoot = fnSum + carryFoot; carryNotes = 0; carryFoot = 0
    } else if (splitPage) { pageNotes = splitNotesLast.n; pageFoot = splitNotesLast.s; carryNotes = 0; carryFoot = 0 } else {
      // 쪽 끝 줄이 제 각주와 함께 안 드는데 문단이 그 쪽에서 끝났으면 그 각주는 다음 쪽 각주 영역으로 넘어간다
      const last = lines[lines.length - 1]
      const lastRefs = last && lines.length > 1 ? refs.filter(([, at]) => at >= tpOf(last)) : []
      const lastSum = lastRefs.reduce((a, [h]) => a + h, 0)
      if (lastRefs.length && lineBottom(last) > bodyH - footArea(pageNotes + fns.length, pageFoot + fnSum)) {
        pageNotes += fns.length - lastRefs.length; pageFoot += fnSum - lastSum; carryNotes += lastRefs.length; carryFoot += lastSum
      } else { pageNotes += fns.length; pageFoot += fnSum }
    }
    {
      const lsa2 = findChildByLocalName(p, "linesegarray"), segs2 = lsa2 ? elements(lsa2).filter(e => ln(e) === "lineseg") : [], lastSeg = segs2[segs2.length - 1]
      const lb = lastSeg ? num(lastSeg, "vertpos") + num(lastSeg, "vertsize") : 0
      contentBottom = splitPage ? floatFloor : keepCursor ? contentBottom : Math.max(lb, res.floatFloor > 0 && off === 0 ? floatFloor : 0)
    }
    splitPage = false
    if (keepCursor) cursorV = cursorBefore
    else prevSpaceAfter = res.spaceAfter
    counter.n++
  }
}

/**
 * section root의 조판 캐시 없는 문단에 linesegarray를 합성 주입한다(표 셀 재귀 포함).
 * 반환: 합성한 문단 수.
 * (Phase 2~3: 최상위 텍스트 + 표 셀 내부. 개체 밀어내기·자동 페이지 분할은 후속.)
 */
export function reflowSection(
  root: Element,
  styles: RenderStyles,
  geom: ReflowGeom,
  mode: WrapMode = "keep",
): number {
  const doc = root.ownerDocument as unknown as Document
  // 미주는 구역 끝에 모여 놓인다 — 폭은 구역 끝의 단 폭(중간에 2단으로 바뀐 구역의 미주 lineseg 폭 = 그 단 폭)
  let endNoteW: number | undefined
  for (const p of elements(root)) if (ln(p) === "p") endNoteW = columnWidthIn(p, geom.BODY_W) ?? endNoteW
  const counter = { n: 0, bodyW: geom.BODY_W, endNoteW, nums: new Map() as NumberCounters }
  reflowBlockFlow(root, doc, styles, geom.BODY_W, mode, counter, geom.BODY_H)
  if (geom.BODY_H > 0) flowEndNotes(root, geom.BODY_H)
  return counter.n
}

/**
 * 구역 끝 미주를 단(쪽) 높이로 흘린다 — 미주 줄은 미주 첫 줄 기준(0)으로 적히고, 단 바닥을 넘는 줄부터 다음 단 맨 위 0 에서 다시 센다.
 * 미주는 본문 끝 줄 바닥 + 구분선 위·아래 간격에서 시작하고, 미주 사이는 앞 미주 끝 줄 바닥 + 미주 사이 간격
 * (한컴 저장본: 2단 시험지 해설 미주 46개, 단 높이 75117·미주 사이 1984 로 흘리면 단 넘김 902곳 중 894곳이 맞는다)
 */
function flowEndNotes(root: Element, bodyH: number): void {
  const notes: Element[] = []
  let last: Element | undefined
  for (const p of elements(root)) {
    if (ln(p) !== "p") continue
    const lsa = findChildByLocalName(p, "linesegarray"), segs = lsa ? elements(lsa).filter(e => ln(e) === "lineseg") : []
    if (segs.length) last = segs[segs.length - 1]
    for (const run of elements(p)) if (ln(run) === "run") for (const ctrl of elements(run)) if (ln(ctrl) === "ctrl") {
      // 렌더(endNoteLayout)와 같은 미주 — 지워진 변경 추적 미주는 뺀다
      const en = findChildByLocalName(ctrl, "endNote"), sub = en && !isDeletedControl(en) ? findChildByLocalName(en, "subList") : null
      if (sub) notes.push(sub)
    }
  }
  if (!notes.length || !last) return
  const pr = findFirst(root, "endNotePr"), sp = pr ? findChildByLocalName(pr, "noteSpacing") : null
  let y = num(last, "vertpos") + num(last, "vertsize") + num(sp, "aboveLine", 0) + num(sp, "belowLine", 567)
  /** 단 바닥을 넘어 다음 단 맨 위로 옮겨 간 개체 몫 — 다음 단 첫 줄은 그 아래에서 */
  let pend = 0
  notes.forEach((sub, ni) => {
    if (ni > 0) y += num(sp, "betweenNotes", 283)
    // 첫 단 조각은 미주 첫 줄 기준(off = 미주 시작 자리), 단을 넘긴 뒤로는 그 단 맨 위 기준
    let base = y, off = y, shift = 0
    // 단 바닥을 넘는 위아래 배치 개체는 칸 안 나눔처럼 다음 단 맨 위로 옮겨 가고 이 단의 뒤 글은 개체에 밀리지 않는다(한컴 저장본: 그림 11694 뒤 줄이
    // 앞 줄 + 1352 에 그대로). 칸 안 나눔(CELL) 표는 드는 행만 남기고 나머지 행 + 바깥 위아래 여백이 다음 단 맨 위 — 뒤 글은 그 아래
    // (한컴 저장본: 3행 표의 첫 행 1182 가 단 바닥에 남고 다음 단 첫 줄 283 + 1182 + 1407 + 283 = 3155)
    let forced: { at: number; rem: number } | undefined
    const floats = subFloatBottoms(sub), done = new Set<SubFloat>()
    for (const q of elements(sub)) {
      if (ln(q) !== "p") continue
      const lsa = findChildByLocalName(q, "linesegarray")
      for (const seg of lsa ? elements(lsa) : []) {
        if (ln(seg) !== "lineseg") continue
        const raw0 = num(seg, "vertpos"), vs = num(seg, "vertsize")
        for (const f of floats) {
          if (done.has(f) || raw0 < f.bottom) continue
          done.add(f)
          if (!(base + f.lineBottom - shift <= bodyH && base + f.bottom - shift > bodyH)) continue
          if (f.rows?.length && f.el?.getAttribute("pageBreak") === "CELL") {
            let yy = base + f.bottom - f.carry - shift + f.outT!, k = 0
            while (k < f.rows.length && yy + f.rows[k] <= bodyH) yy += f.rows[k++]
            if (k === f.rows.length) continue
            forced = { at: f.bottom, rem: f.outT! + f.rows.slice(k).reduce((a, b) => a + b, 0) + f.outB! }
            continue
          }
          shift += f.bottom - f.hostEnd; pend = Math.max(pend, f.carry)
        }
        const raw = raw0 - shift
        let v = base + raw
        if (forced && raw0 >= forced.at) { base = forced.rem - forced.at + shift; v = base + raw; off = 0; forced = undefined }
        else if (v + vs > bodyH && v > 0) { base = pend - raw; v = pend; off = 0; pend = 0 }
        seg.setAttribute("vertpos", String(v - off))
        y = v + vs
      }
    }
  })
}
