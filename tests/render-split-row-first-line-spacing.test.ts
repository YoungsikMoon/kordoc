import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { createXmlParser } from "../src/hwpx/parser-shared.js"

const hp = 'xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph"'
const seg = (v: number) => `<hp:lineseg textpos="0" vertpos="${v}" vertsize="1200" textheight="1200" baseline="1020" spacing="720" horzpos="0" horzsize="9000"/>`
const row = (r: number, h: number, vs: number[]) => `<hp:tr><hp:tc><hp:subList vertAlign="TOP"><hp:p><hp:run><hp:t>가</hp:t></hp:run><hp:linesegarray>${vs.map(seg).join("")}</hp:linesegarray></hp:p></hp:subList>` +
  `<hp:cellAddr colAddr="0" rowAddr="${r}"/><hp:cellSpan colSpan="1" rowSpan="1"/><hp:cellSz width="10000" height="${h}"/><hp:cellMargin left="283" right="283" top="283" bottom="283"/></hp:tc></hp:tr>`
const table = (vs: number[]) => createXmlParser().parseFromString(
  `<hp:tbl ${hp} pageBreak="CELL" rowCnt="2" colCnt="1"><hp:sz width="10000" height="6006"/><hp:pos treatAsChar="0" vertRelTo="PARA"/>${row(0, 2000, [0])}${row(1, 4006, vs)}</hp:tbl>`, "text/xml").documentElement as unknown as Element

describe("render: 쪽 바닥에서 갈리는 표 행의 첫 줄", () => {
  it("뒤 줄이 있으면 첫 줄 간격까지 이 쪽에 들어야 한다 — 아니면 행째 다음 쪽, 줄 하나뿐인 칸은 간격을 안 본다", async () => {
    const { planTableRows } = await import("../src/render/table-pages.js")
    const { collectCells, measureTableRowHeights } = await import("../src/render/para-model.js")
    const pages = (t: Element) => planTableRows(t, collectCells(t), measureTableRowHeights(t), 0, 0, 3815)[1].map(p => p.page)
    // 둘째 행 위 2000, 남은 1815: 칸 위 283 + 첫 줄 1200 은 1815 − 283 안이지만 + 간격 720 이면 넘친다
    assert.deepEqual(pages(table([0, 1920])), [1])
    assert.deepEqual(pages(table([0])), [0])
  })
})
