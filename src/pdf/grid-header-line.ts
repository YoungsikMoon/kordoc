/**
 * 선 격자 바로 위 무괘선 머리행.
 *
 * 몸통만 괘선으로 가르고 머리행 위·아래에는 선을 긋지 않은 표(ODL 052 "REGIONS | 2007-2010 | …", 182 슬라이드 표)는
 * 격자가 몸통에서 끝나 머리 글이 표 위 문단으로 빠진다. 격자 윗변 바로 위 한 줄이 격자 폭 안에서 열마다 따로 놓이면
 * (칸 경계를 걸친 글 없이 두 열 이상) 그 줄을 머리행으로 붙인다.
 *
 * 텍스트층 글에만 쓴다 — OCR 글은 래스터 괘선과 함께 오고 머리 위 제목 줄 조각이 열마다 흩어져 보여
 * 괴산 예산서 표를 무너뜨렸다(cellF1 0.946 → 0.444).
 */

import type { NormItem } from "./text-line.js"

/** 격자 윗변에서 머리 줄 기준선까지 허용 거리 (글자 크기 배수) */
const MAX_GAP_K = 2.2
/** 격자 폭 밖 허용 (pt) */
const EDGE_TOL = 3

/**
 * 격자(colXs, 윗변 top) 바로 위 머리 줄의 열별 글 — 없으면 null.
 * @param free 아직 어느 표·문단에도 안 쓰인 쪽 글
 */
export function headerLineAbove(free: NormItem[], colXs: number[], top: number): NormItem[][] | null {
  const x1 = colXs[0], x2 = colXs[colXs.length - 1]
  const above = free.filter(it => it.y > top && it.text.trim())
  if (above.length === 0) return null
  // 격자에 가장 가까운 줄
  const baseY = Math.min(...above.map(it => it.y))
  const line = above.filter(it => Math.abs(it.y - baseY) <= Math.max(2, it.fontSize * 0.3))
  const fs = Math.max(...line.map(it => it.fontSize))
  if (baseY - top > fs * MAX_GAP_K) return null
  // 표 캡션 줄("Table 7.1. | Types of …")은 머리행이 아니다
  const text = [...line].sort((a, b) => a.x - b.x).map(it => it.text).join(" ").trim()
  if (/^(?:Table|Figure|Fig\.|Chart|Exhibit|Diagram|Source|Note|<?표|<?그림)\s*[\dIVX]/i.test(text)) return null
  // "(단위 : …)" 가 든 줄은 표 위 머리말·단위 줄이다(괴산 예산서 "항 : 511 국고보조금등 … (단위:천원)" — 열마다 흩어져 머리행으로 붙었다)
  if (/\(단위[:：]/.test(text.replace(/\s+/g, ""))) return null
  if (line.some(it => it.seq === undefined || it.x < x1 - EDGE_TOL || it.x + it.w > x2 + EDGE_TOL)) return null
  // 같은 줄에 격자 밖 글이 있으면 본문 줄이다
  if (above.some(it => !line.includes(it) && Math.abs(it.y - baseY) <= fs * 0.5)) return null
  const cols: NormItem[][] = colXs.slice(1).map(() => [])
  for (const it of line) {
    const first = colXs.findIndex((x, k) => k < colXs.length - 1 && it.x + 1 >= x && it.x + 1 < colXs[k + 1])
    const last = colXs.findIndex((x, k) => k < colXs.length - 1 && it.x + it.w - 1 > x && it.x + it.w - 1 <= colXs[k + 1])
    if (first < 0 || first !== last) return null
    cols[first].push(it)
  }
  if (cols.filter(c => c.length > 0).length < Math.max(2, Math.ceil((colXs.length - 1) / 2))) return null
  return cols
}
