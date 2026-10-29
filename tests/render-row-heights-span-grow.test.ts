import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { solveRowHeights } from "../src/render/layout.js"

describe("render: 여러 행 칸이 행들보다 높으면 행이 자란다", () => {
  it("저장 높이가 한 행 칸으로 정해진 그 행들 합보다 크면 모자란 만큼 마지막 행이 자란다", () => {
    // 법령 서식 제목: 5행 병합 칸 4406, 그 행들은 한 행 칸 666 씩(합 3330) — 한컴 표 sz 는 키운 합과 같다(+1076)
    const h = solveRowHeights([
      { rowAddr: 0, rowSpan: 5, height: 4406 },
      { rowAddr: 0, rowSpan: 5, height: 2995 },
      ...[0, 1, 2, 3, 4].map(r => ({ rowAddr: r, rowSpan: 1, height: 666 })),
    ], 5)
    assert.deepEqual(h, [666, 666, 666, 666, 1742])
  })
  it("끝 행이 위인 칸부터 채워 겹친 칸이 같은 모자람을 두 번 키우지 않는다", () => {
    // 행 0~3 칸 5000 이 먼저 나와도 행 0~1 칸 3000 이 행 1 을 키운 뒤면 이미 찬다 — 합 5000(문서 순서로 키우면 6000)
    const h = solveRowHeights([
      { rowAddr: 0, rowSpan: 4, height: 5000 },
      { rowAddr: 0, rowSpan: 2, height: 3000 },
      ...[0, 1, 2, 3].map(r => ({ rowAddr: r, rowSpan: 1, height: 1000 })),
    ], 4)
    assert.deepEqual(h, [1000, 2000, 1000, 1000])
  })
  it("표 높이(저장 sz)를 넘겨 키우지 않는다 — 쪽을 넘는 표의 sz 는 첫 쪽 조각이라 이미 넘으면 그대로", () => {
    const cells = [{ rowAddr: 0, rowSpan: 2, height: 3000 }, { rowAddr: 0, rowSpan: 1, height: 1000 }, { rowAddr: 1, rowSpan: 1, height: 1000 }]
    assert.deepEqual(solveRowHeights(cells, 2, 2500), [1000, 1500])
    assert.deepEqual(solveRowHeights(cells, 2, 1800), [1000, 1000])
  })
  it("이미 표 높이를 넘은 표라도 칸 내용이 넘쳐 키우는 여러 행 칸은 키운다 — 저장 높이로만 키우는 칸은 그대로", () => {
    const rows = [{ rowAddr: 0, rowSpan: 1, height: 1000 }, { rowAddr: 1, rowSpan: 1, height: 1000 }]
    // 내용 3000(≥ 칸 높이) — sz 1800 을 넘어도 마지막 행이 2000 으로
    assert.deepEqual(solveRowHeights([{ rowAddr: 0, rowSpan: 2, height: 3000, contentH: 3000 }, ...rows], 2, 1800), [1000, 2000])
    // 내용 1500(< 저장 3000) — 종전대로 sz 에 묶여 그대로
    assert.deepEqual(solveRowHeights([{ rowAddr: 0, rowSpan: 2, height: 3000, contentH: 1500 }, ...rows], 2, 1800), [1000, 1000])
  })
  it("쪽을 넘는 표에서도 쪽 조각만큼 크지 않은 여러 행 칸은 저장 높이로 키운다 — 쪽 조각 크기 칸은 그대로", () => {
    // 같은 판 한컴 PDF: 84행 3쪽 표(sz 62240 = 첫 쪽 조각)의 4행 칸 9448 > 행 합 8547 → 마지막 행 +901,
    // 같은 행에서 끝나는 35행 칸 61900(쪽 경계를 걸친 쪽 조각)은 남은 모자람을 키우지 않았다
    const rows = Array.from({ length: 10 }, (_, r) => ({ rowAddr: r, rowSpan: 1, height: 1000 }))
    const h = solveRowHeights([{ rowAddr: 5, rowSpan: 2, height: 2500 }, { rowAddr: 0, rowSpan: 10, height: 10800 }, ...rows], 10, 6000)
    assert.equal(h[6], 1500)
    assert.equal(h[9], 1000)
  })
  it("한 행 칸이 없는 행은 위에서부터 그 행에서 끝나는 칸으로 정한다 — 먼저 나온 큰 병합 칸이 정하지 않는다", () => {
    // 같은 판 서식: 3행 큰 칸 5000 이 문서 순서로 먼저 나와도 둘째 행은 2행 칸 1666 − 1382 = 284, 셋째 행은 3행 칸 3866 에 맞춰 자란다
    const h = solveRowHeights([
      { rowAddr: 0, rowSpan: 3, height: 5000 },
      { rowAddr: 0, rowSpan: 1, height: 1382 },
      { rowAddr: 0, rowSpan: 2, height: 1666 },
      { rowAddr: 0, rowSpan: 3, height: 3866 },
      { rowAddr: 2, rowSpan: 1, height: 1666 },
    ], 3, 3866)
    assert.deepEqual(h, [1382, 284, 2200])
  })
})
