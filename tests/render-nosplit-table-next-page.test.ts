import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { createXmlParser } from "../src/hwpx/parser-shared.js"

const hp = 'xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph"'
const seg = `<hp:lineseg textpos="0" vertpos="0" vertsize="1000" textheight="1000" baseline="850" spacing="600" horzpos="0" horzsize="9000"/>`
const row = (r: number) => `<hp:tr><hp:tc><hp:subList><hp:p><hp:run><hp:t>가</hp:t></hp:run><hp:linesegarray>${seg}</hp:linesegarray></hp:p></hp:subList>` +
  `<hp:cellAddr colAddr="0" rowAddr="${r}"/><hp:cellSpan colSpan="1" rowSpan="1"/><hp:cellSz width="10000" height="2000"/><hp:cellMargin left="0" right="0" top="141" bottom="141"/></hp:tc></hp:tr>`
const table = (pageBreak: string) => createXmlParser().parseFromString(
  `<hp:tbl ${hp} pageBreak="${pageBreak}" rowCnt="3" colCnt="1"><hp:sz width="10000" height="6000"/><hp:pos treatAsChar="0" vertRelTo="PARA"/>${row(0)}${row(1)}${row(2)}</hp:tbl>`, "text/xml").documentElement as unknown as Element

describe("render: 나누지 않는 표(pageBreak NONE)", () => {
  it("쪽 바닥에서 넘치면 행으로 가르지 않고 표째 다음 쪽 맨 위 — 나누는 표는 종전대로 행 단위", async () => {
    const { planTableRows } = await import("../src/render/table-pages.js")
    const { collectCells, measureTableRowHeights } = await import("../src/render/para-model.js")
    const plan = (t: Element) => planTableRows(t, collectCells(t), measureTableRowHeights(t), 4000, 0, 7000).map(ps => ps.map(p => [p.page, p.y]))
    // 표 위 4000, 쪽 7000: 첫 행만 이 쪽에 든다
    assert.deepEqual(plan(table("NONE")), [[[1, 0]], [[1, 2000]], [[1, 4000]]])
    assert.deepEqual(plan(table("TABLE")).map(ps => ps[0][0]), [0, 1, 1])
  })
})
