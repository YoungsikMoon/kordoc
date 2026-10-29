import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { createXmlParser } from "../src/hwpx/parser-shared.js"

const hp = 'xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph"'
const seg = (v: number) => `<hp:linesegarray><hp:lineseg textpos="0" vertpos="${v}" vertsize="1000" textheight="1000" baseline="850" spacing="600" horzpos="0" horzsize="9000"/></hp:linesegarray>`
const innerRow = (r: number) => `<hp:tr><hp:tc><hp:subList><hp:p><hp:run><hp:t>칸</hp:t></hp:run>${seg(0)}</hp:p></hp:subList><hp:cellAddr colAddr="0" rowAddr="${r}"/><hp:cellSpan colSpan="1" rowSpan="1"/><hp:cellSz width="8000" height="1000"/><hp:cellMargin left="0" right="0" top="0" bottom="0"/></hp:tc></hp:tr>`
// 10행(10000) 표 — 한컴이 쪽에서 갈라 sz 에 첫 쪽 조각 2000 만 적었다
const inner = `<hp:tbl textWrap="TOP_AND_BOTTOM" pageBreak="CELL" rowCnt="10" colCnt="1"><hp:sz width="8000" height="2000"/><hp:pos treatAsChar="0" vertRelTo="PARA" vertOffset="0"/><hp:outMargin left="0" right="0" top="0" bottom="0"/>${Array.from({ length: 10 }, (_, r) => innerRow(r)).join("")}</hp:tbl>`
const outer = (wrapInCell: boolean) => {
  const cell = `<hp:tc><hp:subList><hp:p><hp:run><hp:t>머리</hp:t></hp:run>${seg(0)}</hp:p><hp:p><hp:run>${inner}<hp:t/></hp:run>${seg(1600)}</hp:p><hp:p><hp:run><hp:t>표 뒤</hp:t></hp:run>${seg(3800)}</hp:p></hp:subList>` +
    `<hp:cellAddr colAddr="0" rowAddr="0"/><hp:cellSpan colSpan="1" rowSpan="1"/><hp:cellSz width="9000" height="20000"/><hp:cellMargin left="0" right="0" top="0" bottom="0"/></hp:tc>`
  const t = `<hp:tbl rowCnt="1" colCnt="1"><hp:sz width="9000" height="7000"/><hp:tr>${cell}</hp:tr></hp:tbl>`
  return createXmlParser().parseFromString(wrapInCell ? `<hp:tbl ${hp} rowCnt="1" colCnt="1"><hp:tr><hp:tc><hp:subList><hp:p><hp:run>${t}</hp:run></hp:p></hp:subList><hp:cellAddr colAddr="0" rowAddr="0"/><hp:cellSpan colSpan="1" rowSpan="1"/></hp:tc></hp:tr></hp:tbl>` : t.replace("<hp:tbl ", `<hp:tbl ${hp} `), "text/xml").documentElement as unknown as Element
}

describe("render: 칸 안 쪽을 넘는 떠 있는 표 뒤 문단", () => {
  it("앞 문단의 쪽을 넘는 표 바닥보다 위에 저장된 다음 문단 첫 줄은 쪽 나눔이다 — 본문 높이를 모르거나 칸 안 표의 칸이면 종전대로", async () => {
    const { cellLineBoxes } = await import("../src/render/table-pages.js")
    const { collectCells } = await import("../src/render/para-model.js")
    const parts = (t: Element, bodyH?: number) => cellLineBoxes(collectCells(t)[0], bodyH).map(b => b.part)
    // 표 위 = 앞 줄 끝 1600, 잰 높이 10000 → 바닥 11600 > 본문 7000 — "표 뒤" 3800 은 표가 끝나는 쪽
    assert.deepEqual(parts(outer(false), 7000), [0, 0, 1])
    assert.deepEqual(parts(outer(false)), [0, 0, 0])
    const nested = outer(true).getElementsByTagName("hp:tbl")[0] as unknown as Element
    assert.deepEqual(parts(nested, 7000), [0, 0, 0])
  })
})
