/**
 * 레이아웃 보존 렌더 — 순수 계산 유틸 (XML 무접촉).
 * 좌표 산식은 .claude/plans/render-poc/findings.md에서 실측 검증된 모델.
 * 단위: HWPUNIT(1/7200in), pt 변환은 /100.
 */

/** HWPX 좌표 속성은 uint32로 저장된 음수가 섞여 있다 (예: vertOffset=4294967103 = -193) */
export function toInt32(v: string | undefined, fallback = 0): number {
  if (v == null || v === "") return fallback
  const n = Number(v)
  if (!Number.isFinite(n)) return fallback
  return n > 0x7fffffff ? n - 0x100000000 : n
}

/** 셀 하나가 주는 경계 제약: boundary[a] + size = boundary[b] */
export interface SpanConstraint {
  a: number
  b: number
  size: number
}

/**
 * 표 열 경계 솔버 — 경계 전파.
 * 결재문서 트레일러처럼 41열 그리드에 span-1 셀이 거의 없어도,
 * x[ca+cs] = x[ca] + w 제약을 고정점까지 전파하면 전 경계가 풀린다 (실측 검증).
 * 미해결 경계는 인접 확정 경계 사이 균등 보간.
 */
export function solveBoundaries(constraints: SpanConstraint[], count: number, total?: number): number[] {
  const x = new Array<number | undefined>(count + 1).fill(undefined)
  x[0] = 0
  if (total != null && total > 0) x[count] = total
  let changed = true
  let guard = 0
  while (changed && guard++ < count + 8) {
    changed = false
    for (const c of constraints) {
      if (c.a < 0 || c.b > count || c.a >= c.b) continue
      const xa = x[c.a]
      const xb = x[c.b]
      if (xa != null && xb == null) {
        x[c.b] = xa + c.size
        changed = true
      } else if (xb != null && xa == null) {
        x[c.a] = xb - c.size
        changed = true
      }
    }
  }
  // 잔여 미해결 경계 — 좌우 확정 경계 사이 균등 보간
  let i = 0
  while (i <= count) {
    if (x[i] != null) { i++; continue }
    let lo = i - 1
    let hi = i
    while (hi <= count && x[hi] == null) hi++
    const loV = x[lo] as number
    const hiV = hi <= count ? (x[hi] as number) : loV + (hi - lo) * 1000
    const n = hi - lo
    for (let k = 1; k < n; k++) x[lo + k] = loV + ((hiV - loV) * k) / n
    if (hi > count) x[count] = hiV
    i = hi
  }
  // 단조 보정 (모순 제약 방어)
  const out = x as number[]
  for (let k = 1; k <= count; k++) if (out[k] < out[k - 1]) out[k] = out[k - 1]
  return out
}

/**
 * 열 경계 = 칸을 왼쪽부터 이은 가장 긴 길(x[b] = max(x[a] + 칸 너비), 열 너비는 음수가 아니다). 행마다 칸 너비 합이 다르게 저장된
 * 표에서 한컴은 경계마다 거기서 끝나는 칸 중 가장 먼 끝을 잡는다 — 그 길의 끝이 표 sz 너비와 같다. 전체 폭 칸은 끝만 정하므로 빼고
 * 잰다(빼지 않으면 그 칸 하나로 끝이 늘 표 너비가 된다). tight[k] 는 경계 k 가 그 가장 긴 길 위에 있는가(x[k] + 끝까지 가장 긴 길 = 끝).
 * 닿지 않는 경계가 있으면 null
 */
export function longestPathBoundaries(constraints: SpanConstraint[], count: number): { x: number[]; tight: boolean[] } | null {
  const inner = constraints.filter(c => c.a >= 0 && c.b <= count && c.a < c.b && !(c.a === 0 && c.b === count))
  const x = new Array<number>(count + 1).fill(Number.NEGATIVE_INFINITY)
  x[0] = 0
  for (let k = 1; k <= count; k++) {
    for (const c of inner) if (c.b === k && x[c.a] > Number.NEGATIVE_INFINITY) x[k] = Math.max(x[k], x[c.a] + c.size)
    if (x[k] === Number.NEGATIVE_INFINITY) return null
    x[k] = Math.max(x[k], x[k - 1])
  }
  const y = new Array<number>(count + 1).fill(Number.NEGATIVE_INFINITY)
  y[count] = 0
  for (let k = count - 1; k >= 0; k--) {
    y[k] = y[k + 1]
    for (const c of inner) if (c.a === k && y[c.b] > Number.NEGATIVE_INFINITY) y[k] = Math.max(y[k], c.size + y[c.b])
  }
  return { x, tight: x.map((v, k) => Math.abs(v + y[k] - x[count]) <= 2) }
}

/**
 * 표 열 경계 — 기본은 전파식(solveBoundaries). 가장 긴 길의 끝이 표 sz 너비(total)와 같고 전파식과 다른 경계가 모두 그 길 위에
 * 있으면 가장 긴 길을 쓴다(같은 판 PDF: 통계표 열 경계 9개가 0.1pt 안, 전파식은 먼저 나온 칸 너비로 4~23pt 어긋났다 — 코퍼스 표
 * 10,968개 중 46개가 이 조건)
 */
export function tableColumnBoundaries(constraints: SpanConstraint[], count: number, total?: number, noExactRow = false): number[] {
  const prop = solveBoundaries(constraints, count, total)
  if (!total || total <= 0) return prop
  const lp = longestPathBoundaries(constraints, count)
  // 칸 너비 합이 표 너비와 같은 행이 없으면(표 너비가 가장 긴 길에서 나왔으면) 길 위에 있지 않은 경계도 가장 긴 길 값 —
  // 같은 판 PDF: 그런 서식 표의 열 경계 11개가 다 가장 긴 길(전파식 7개). 같은 행이 있으면 종전대로 길 위 경계만(원자력 서식은 전파식이 맞다)
  return lp && Math.abs(lp.x[count] - total) <= 2 && (noExactRow || lp.x.every((v, k) => Math.abs(v - prop[k]) <= 2 || lp.tight[k])) ? lp.x : prop
}

/**
 * 표 행 높이 솔버 — rowSpan=1 셀의 max가 기본, rowSpan>1은 잔여 균등분배.
 * h=1 더미 셀(헤어라인 행 장식)이 섞이므로 열과 달리 max 방식이 안전.
 * grow: 셀 콘텐츠(사진 등)가 설계 높이를 넘으면 초과분만큼 행이 자란다 —
 * 사진대지 실측: 설계 16441 + 사진 22209 → 행 22209, 표 sz 합치 정확 일치.
 */
export function solveRowHeights(
  cells: { rowAddr: number; rowSpan: number; height: number; contentH?: number }[],
  rowCount: number,
  maxTotal = Number.POSITIVE_INFINITY,
  shrinkLast = false,
): number[] {
  const h = new Array<number>(rowCount).fill(0)
  for (const c of cells) {
    if (c.rowSpan === 1 && c.rowAddr >= 0 && c.rowAddr < rowCount) {
      h[c.rowAddr] = Math.max(h[c.rowAddr], c.height)
    }
  }
  // 콘텐츠 초과 성장 (rowSpan=1 셀만 — 사진 셀 케이스). 여러 행 칸의 잔여 분배보다 먼저 — 자란 행만큼 잔여가 준다
  // (한컴 PDF: 4행 병합 칸 17749 안의 사진 행이 10419 → 10690 으로 자라 병합 칸 마지막 행이 100, 먼저 나누면 384)
  for (const c of cells) {
    if (c.rowSpan === 1 && c.contentH != null && c.rowAddr >= 0 && c.rowAddr < rowCount) {
      if (c.contentH > h[c.rowAddr]) h[c.rowAddr] = c.contentH
    }
  }
  // rowSpan>1 셀 — 포함 행 중 미확정(0) 행에 잔여를 준다. 미확정 행이 하나뿐인 칸부터 되풀이해 풀고(엇갈려 병합한 표는 그것만으로
  // 행 높이가 다 정해진다), 더 못 풀 때만 남은 칸을 문서 순서로 균등 분배한다
  const spans = cells.filter(c => c.rowSpan > 1).map(c => {
    const rows: number[] = []
    for (let r = c.rowAddr; r < Math.min(c.rowAddr + c.rowSpan, rowCount); r++) rows.push(r)
    return { c, rows }
  })
  const done = new Set<number>()
  const solve = (k: number, evenOnly: boolean): boolean => {
    const { c, rows } = spans[k]
    const known = rows.reduce((s, r) => s + h[r], 0)
    const missing = rows.filter(r => h[r] === 0)
    if (missing.length === 0) { done.add(k); return false }
    if (evenOnly && missing.length !== 1) return false
    done.add(k)
    if (c.height <= known) return false
    const each = (c.height - known) / missing.length
    for (const r of missing) h[r] = each
    return true
  }
  // 미확정 행은 위에서부터 — 그 행에서 끝나는 여러 행 칸의 (저장 높이 − 앞 행 합) 중 큰 값(앞 행이 다 정해진 칸만). 문서 순서로 풀면
  // 위에서 시작한 큰 병합 칸이 아래 행을 먼저 정했다(같은 판 PDF: 13행 칸 22322 가 정한 28행 1953 대신 2행 칸 1666 − 27행 1382 = 284,
  // 29행은 3행 칸 3866 에 맞춰 2200 — 칸 틀 16.5pt·22.1pt)
  for (let r = 0; r < rowCount; r++) {
    if (h[r] !== 0) continue
    let need = 0
    for (const { c, rows } of spans) if (rows[rows.length - 1] === r && rows.slice(0, -1).every(q => h[q] > 0)) need = Math.max(need, c.height - rows.slice(0, -1).reduce((t, q) => t + h[q], 0))
    if (need > 0) h[r] = need
  }
  for (let again = true; again;) { again = false; for (let k = 0; k < spans.length; k++) if (!done.has(k) && solve(k, true)) again = true }
  for (let k = 0; k < spans.length; k++) if (!done.has(k)) solve(k, false)
  // 여러 행 칸의 저장 높이가 (한 행 칸으로 이미 정해진) 그 행들 합보다 크면 모자란 만큼 마지막 행이 자란다 — 끝 행이 위인 칸부터
  // 채워 겹친 칸이 같은 모자람을 두 번 키우지 않게 하고, 표 높이(maxTotal, 저장 sz)를 넘겨 키우지 않는다(쪽을 넘는 표의 sz 는 첫 쪽 조각).
  // 한컴 저장 표 sz: 이런 칸이 있는 표 105개 중 78개가 키운 합과 같고, 키우지 않은 합과 같은 표는 없다
  // (같은 판 PDF: 2행 병합 칸 882 의 두 행이 2 + 782 → 8.75pt)
  let total = h.reduce((s, x) => s + x, 0)
  const overSz = total > maxTotal
  for (const { c, rows } of [...spans].sort((a, b) => a.rows[a.rows.length - 1] - b.rows[b.rows.length - 1] || b.rows[0] - a.rows[0])) {
    const known = rows.reduce((s, r) => s + h[r], 0)
    // 행 합이 이미 표 높이를 넘은(쪽을 넘는) 표라도 칸 내용이 넘쳐 키우는 칸은 키운다 — 내용은 쪽 조각과 무관하다
    // (한컴 PDF: 84행 3쪽 표의 3행 병합 칸 내용 6942 > 저장 5786, 마지막 행 2254 → 3700). 저장 높이가 표 높이(첫 쪽 조각)의 절반 이하인
    // 칸도 저장 높이로 키운다 — 쪽 조각일 수 없는 칸이다(같은 표의 4행 칸 9448 > 행 합 8547 → 마지막 행 +901, PDF 27.6pt).
    // 쪽 경계를 걸친 35행 칸 61900(쪽 조각)은 한컴도 남은 모자람을 키우지 않았다
    const add = Math.min(c.height - known, overSz && ((c.contentH != null && c.contentH >= c.height) || c.height <= maxTotal / 2) ? Number.POSITIVE_INFINITY : maxTotal - total)
    if (rows.length && add > 0) { h[rows[rows.length - 1]] += add; total += add }
  }
  // 칸 저장 높이로 쌓은 행 합이 표 높이(sz)를 넘으면 마지막 행이 줄어 표 높이에 맞는다 — 마지막 행 칸 내용이 줄인 행에 다 들 때만
  // (쪽을 넘는 표의 sz 는 첫 쪽 조각이라 줄이면 내용이 안 든다). 본문 표만 — 칸 안 표는 줄지 않고 넘친다(같은 판 PDF: 칸 안 빈 서식 표 뒤 빈 쪽). 같은 판 한컴 PDF: 칸 16425 세 행 사진 표(sz 48016)의 마지막 행 15166,
  // 칸 21090 인 마지막 행(sz 22537 − 앞 행 1764 = 20773, PDF 20749~20773)
  const last = rowCount - 1, over = total - maxTotal
  const lastCells = cells.filter(c => c.rowAddr + c.rowSpan - 1 === last)
  // 마지막 행까지 내려오는 여러 행 칸은 그 칸 내용이 줄인 칸 높이(행 합 − 넘침)에 들면 된다(같은 판 PDF: 17행 "계속" 칸이 걸친 표의 마지막 행 2149 − 488)
  const spanH = (c: { rowAddr: number; rowSpan: number }) => h.slice(c.rowAddr, c.rowAddr + c.rowSpan).reduce((t, x) => t + x, 0)
  if (shrinkLast && over > 0 && last >= 0 && lastCells.length && lastCells.every(c => c.contentH != null && c.contentH <= (c.rowSpan === 1 ? h[last] : spanH(c)) - over)) h[last] -= over
  return h
}

// 자연폭 계산은 hwpx/text-metrics.ts의 함초롬바탕 실측 advance 테이블(measureTextWidth)을 재사용한다.
