import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { createXmlParser } from "../src/hwpx/parser-shared.js"

const hp = 'xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph"'
const seg = (v: number) => `<hp:lineseg textpos="0" vertpos="${v}" vertsize="1000" textheight="1000" baseline="850" spacing="600" horzpos="0" horzsize="4000"/>`
const tc = (c: number, r: number, rs: number, h: number, vs: number[]) => `<hp:tc><hp:subList vertAlign="TOP"><hp:p><hp:run><hp:t>가</hp:t></hp:run><hp:linesegarray>${vs.map(seg).join("")}</hp:linesegarray></hp:p></hp:subList>` +
  `<hp:cellAddr colAddr="${c}" rowAddr="${r}"/><hp:cellSpan colSpan="1" rowSpan="${rs}"/><hp:cellSz width="5000" height="${h}"/><hp:cellMargin left="0" right="0" top="0" bottom="0"/></hp:tc>`
const table = () => createXmlParser().parseFromString(`<hp:tbl ${hp} pageBreak="CELL" rowCnt="3" colCnt="2"><hp:sz width="10000" height="9000"/><hp:pos treatAsChar="0" vertRelTo="PARA"/>` +
  `<hp:tr>${tc(0, 0, 1, 2000, [0])}${tc(1, 0, 1, 2000, [0])}</hp:tr><hp:tr>${tc(0, 1, 2, 5000, [0, 0])}${tc(1, 1, 1, 3200, [0, 1600])}</hp:tr><hp:tr>${tc(1, 2, 1, 1800, [0])}</hp:tr></hp:tbl>`, "text/xml").documentElement as unknown as Element

describe("render: 병합 칸 저장 부분이 시작하는 행", () => {
  it("앞 행이 이미 다음 쪽으로 갈려 넘어갔으면 그 행은 또 쪽을 넘기지 않는다", async () => {
    const { planTableRows } = await import("../src/render/table-pages.js")
    const { collectCells, measureTableRowHeights } = await import("../src/render/para-model.js")
    const t = table()
    // 둘째 행(병합 칸 첫 줄과 둘째 줄 사이를 쪽 나눔으로 저장)이 쪽 바닥에서 갈려 다음 쪽에 나머지 1000 — 셋째 행은 그 아래(종전엔 한 쪽 더 넘김)
    const plan = planTableRows(t, collectCells(t), measureTableRowHeights(t), 3000, 0, 7000).map(ps => ps.map(p => [p.page, p.y]))
    assert.deepEqual(plan, [[[0, 3000]], [[0, 5000], [1, 0]], [[1, 1000]]])
  })
})
