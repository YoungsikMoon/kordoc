import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { createXmlParser } from "../src/hwpx/parser-shared.js"

const hp = 'xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph"'
const seg = `<hp:lineseg textpos="0" vertpos="0" vertsize="1200" textheight="1200" baseline="1020" spacing="720" horzpos="0" horzsize="9000"/>`
const row = (r: number, h: number, va: string) => `<hp:tr><hp:tc><hp:subList vertAlign="${va}"><hp:p><hp:run><hp:t>가</hp:t></hp:run><hp:linesegarray>${seg}</hp:linesegarray></hp:p></hp:subList>` +
  `<hp:cellAddr colAddr="0" rowAddr="${r}"/><hp:cellSpan colSpan="1" rowSpan="1"/><hp:cellSz width="10000" height="${h}"/><hp:cellMargin left="141" right="141" top="0" bottom="0"/></hp:tc></hp:tr>`
const table = (h: number, va = "CENTER") => createXmlParser().parseFromString(
  `<hp:tbl ${hp} pageBreak="CELL" rowCnt="2" colCnt="1"><hp:sz width="10000" height="${2000 + h}"/><hp:pos treatAsChar="0" vertRelTo="PARA"/>${row(0, 2000, "CENTER")}${row(1, h, va)}</hp:tbl>`, "text/xml").documentElement as unknown as Element

describe("render: 쪽 바닥에서 갈린 본문 표 행의 남는 높이", () => {
  it("정렬대로 놓은 글이 이 쪽에 들고 남는 높이가 크면 다음 쪽 맨 위 빈 조각으로 잇는다 — 작거나 글이 안 들면 버린다", async () => {
    const { planTableRows } = await import("../src/render/table-pages.js")
    const { collectCells, measureTableRowHeights } = await import("../src/render/para-model.js")
    const pieces = (t: Element) => planTableRows(t, collectCells(t), measureTableRowHeights(t), 4889, 0, 10000)[1].map(p => [p.page, Math.round(p.h)])
    // 둘째 행 위 6889, 남은 3111: 저장 높이 4954 가운데 한 줄 행 → 3111 + 다음 쪽 1843
    assert.deepEqual(pieces(table(4954)), [[0, 3111], [1, 1843]])
    // 남는 높이 437 은 버린다
    assert.deepEqual(pieces(table(3548)), [[0, 3111]])
    // 아래 정렬이면 글 바닥이 행 바닥이라 이 쪽에 안 든다 — 버린다
    assert.deepEqual(pieces(table(4954, "BOTTOM")), [[0, 3111]])
  })
})
