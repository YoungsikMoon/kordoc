import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { createXmlParser } from "../src/hwpx/parser-shared.js"

const hp = 'xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph"'
const para = (v: number, h: number) => `<hp:p><hp:run><hp:t>가</hp:t></hp:run><hp:linesegarray><hp:lineseg textpos="0" vertpos="${v}" vertsize="${h}" textheight="${h}" baseline="850" spacing="600" horzpos="0" horzsize="9000"/></hp:linesegarray></hp:p>`
// 첫 문단 0 다음 문단도 0 — 한컴이 둘째 문단을 다음 쪽 맨 위로 갈라 저장한 칸, 표 sz 는 첫 쪽 조각
const table = (cellH: number) => createXmlParser().parseFromString(`<hp:tbl ${hp} pageBreak="CELL" rowCnt="1" colCnt="1"><hp:sz width="10000" height="5000"/><hp:pos treatAsChar="0" vertRelTo="PARA"/>` +
  `<hp:tr><hp:tc><hp:subList vertAlign="TOP">${para(0, 1000)}${para(0, 3000)}</hp:subList><hp:cellAddr colAddr="0" rowAddr="0"/><hp:cellSpan colSpan="1" rowSpan="1"/><hp:cellSz width="10000" height="${cellH}"/>` +
  `<hp:cellMargin left="0" right="0" top="0" bottom="0"/></hp:tc></hp:tr></hp:tbl>`, "text/xml").documentElement as unknown as Element

describe("render: 쪽 안에 드는 것처럼 보이는 갈라 저장한 칸", () => {
  it("칸 저장 높이가 표 높이보다 크면 저장 자리에서 가른다 — 작으면 종전대로 한 조각", async () => {
    const { planTableRows } = await import("../src/render/table-pages.js")
    const { collectCells, measureTableRowHeights } = await import("../src/render/para-model.js")
    const pages = (t: Element) => planTableRows(t, collectCells(t), measureTableRowHeights(t), 1000, 0, 7000)[0].map(p => p.page)
    assert.deepEqual(pages(table(9000)), [0, 1])
    assert.deepEqual(pages(table(846)), [0])
  })
})
