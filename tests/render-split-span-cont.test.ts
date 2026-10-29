import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { createXmlParser } from "../src/hwpx/parser-shared.js"

const hp = 'xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph"'
const lines = (vs: number[]) => vs.map(v => `<hp:lineseg textpos="0" vertpos="${v}" vertsize="1000" textheight="1000" baseline="850" spacing="600" horzpos="0" horzsize="4000"/>`).join("")
const tc = (col: number, row: number, rs: number, h: number, vs: number[]) =>
  `<hp:tc><hp:subList><hp:p><hp:run><hp:t>가</hp:t></hp:run><hp:linesegarray>${lines(vs)}</hp:linesegarray></hp:p></hp:subList>` +
  `<hp:cellAddr colAddr="${col}" rowAddr="${row}"/><hp:cellSpan colSpan="1" rowSpan="${rs}"/><hp:cellSz width="5000" height="${h}"/><hp:cellMargin left="0" right="0" top="141" bottom="141"/></hp:tc>`
// 두 행 병합 칸(0열)을 쪽에서 갈라 저장 — 둘째 부분 줄 셋(0·1600·3200). 둘째 행 1열 칸도 갈라 저장(한 줄씩)
const table = () => createXmlParser().parseFromString(`<hp:tbl ${hp} pageBreak="CELL" rowCnt="3" colCnt="2"><hp:sz width="10000" height="3000"/><hp:outMargin left="0" right="0" top="0" bottom="0"/>` +
  `<hp:tr>${tc(0, 0, 2, 3000, [0, 1600, 0, 1600, 3200])}${tc(1, 0, 1, 1500, [0])}</hp:tr>` +
  `<hp:tr>${tc(1, 1, 1, 1500, [0, 0])}</hp:tr>` +
  `<hp:tr>${tc(0, 2, 1, 1500, [0])}${tc(1, 2, 1, 1500, [0])}</hp:tr></hp:tbl>`, "text/xml").documentElement as unknown as Element

describe("render: 갈라 저장한 여러 행 칸이 끝나는 행", () => {
  it("다음 쪽 조각은 그 병합 칸 둘째 부분 내용까지 서고 다음 행은 그 아래", async () => {
    const { planTableRows } = await import("../src/render/table-pages.js")
    const { collectCells, measureTableRowHeights } = await import("../src/render/para-model.js")
    const t = table()
    const plan = planTableRows(t, collectCells(t), measureTableRowHeights(t), 4000, 0, 7000)
    const cont = plan[1].find(p => p.page === 1)!
    // 병합 칸 둘째 부분: 줄 바닥 4200 + 칸 위아래 여백 282
    assert.ok(cont.h >= 4482, `이어진 조각 ${cont.h}`)
    assert.equal(plan[2][0].page, 1)
    assert.ok(plan[2][0].y >= cont.y + 4482, `다음 행 ${plan[2][0].y}`)
  })
})
