import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { createXmlParser } from "../src/hwpx/parser-shared.js"

const hp = 'xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph"'
const seg = `<hp:lineseg textpos="0" vertpos="0" vertsize="1000" textheight="1000" baseline="850" spacing="600" horzpos="0" horzsize="9000"/>`
const row = (r: number) => `<hp:tr><hp:tc><hp:subList><hp:p><hp:run><hp:t>가</hp:t></hp:run><hp:linesegarray>${seg}</hp:linesegarray></hp:p></hp:subList>` +
  `<hp:cellAddr colAddr="0" rowAddr="${r}"/><hp:cellSpan colSpan="1" rowSpan="1"/><hp:cellSz width="10000" height="2000"/><hp:cellMargin left="0" right="0" top="141" bottom="141"/></hp:tc></hp:tr>`
const tbl = (rows: number) => `<hp:tbl textWrap="TOP_AND_BOTTOM" pageBreak="CELL" rowCnt="${rows}" colCnt="1"><hp:sz width="10000" height="${rows * 2000}"/>` +
  `<hp:pos treatAsChar="0" vertRelTo="PARA"/><hp:outMargin left="0" right="0" top="200" bottom="200"/>${Array.from({ length: rows }, (_, r) => row(r)).join("")}</hp:tbl>`
const para = (text: string) => createXmlParser().parseFromString(
  `<hp:p ${hp}><hp:run><hp:t>${text}</hp:t>${tbl(1)}${tbl(3)}</hp:run></hp:p>`, "text/xml").documentElement as unknown as Element

describe("render: 같은 문단에 앞 표와 함께 앵커한 위아래 배치 표", () => {
  it("쪽 바닥에서 넘치면 한 쪽에 드는 표는 가르지 않고 표째 다음 쪽 맨 위 + 바깥 위 여백 — 글 있는 문단·첫 표는 종전대로 행 나눔", async () => {
    const { planTableRows } = await import("../src/render/table-pages.js")
    const { collectCells, measureTableRowHeights } = await import("../src/render/para-model.js")
    const plan = (t: Element) => planTableRows(t, collectCells(t), measureTableRowHeights(t), 4000, 0, 7000).map(ps => ps.map(p => [p.page, p.y]))
    const second = (p: Element) => p.getElementsByTagName("hp:tbl")[1] as unknown as Element
    // 표 위 4000, 쪽 7000: 3행(6000)이 넘친다 — 쪽 2에 200 부터
    assert.deepEqual(plan(second(para(""))), [[[1, 200]], [[1, 2200]], [[1, 4200]]])
    assert.deepEqual(plan(second(para("글"))).map(ps => ps[0][0]), [0, 1, 1])
    assert.deepEqual(plan(para("").getElementsByTagName("hp:tbl")[0] as unknown as Element).map(ps => ps[0][0]), [0])
  })
})
