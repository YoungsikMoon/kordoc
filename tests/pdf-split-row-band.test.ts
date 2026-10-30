import { describe, it } from "node:test"
import assert from "node:assert/strict"
import type { IRTable } from "../src/types.js"
import { joinSplitParts } from "../src/pdf/table-parts.js"

const make = (rows: string[][]): IRTable => ({ rows: rows.length, cols: 3, hasHeader: false,
  cells: rows.map(row => row.map(text => ({ text, rowSpan: 1, colSpan: 1 }))) })

// 앞 쪽: "통신사·통신기술·전송기술" 세 행 옆 3행 병합 칸 / 뒤 쪽: 첫 띠에 그 병합 칸 나머지(2행 칸), 다음 행 "전자통신기술"
function join(bandLabel = "") {
  const prev = make([["방송통신", "통신사", "기술사:"], ["", "통신기술", ""], ["", "전송기술", ""]])
  prev.cells[0][2].rowSpan = 3
  const next = make([["", bandLabel, "기능사:"], ["", "전자통신기술", ""], ["", "다음 직류", "다음 자격"]])
  next.cells[0][2].rowSpan = 2
  return joinSplitParts(prev, [0, 100, 200, 300], next, [0, 100, 200, 300])!
}

describe("쪽 경계에서 갈린 행의 띠", () => {
  it("뒤 조각 첫 행의 한 행 칸이 모두 비고 글은 앞 쪽 병합 칸의 나머지뿐이면 앞 행에 합친다", () => {
    const r = join()
    assert.equal(r.split, true)
    assert.equal(r.table.rows, 5)
    assert.equal(r.table.cells[0][2].rowSpan, 4)
    assert.equal(r.table.cells[3][1].text, "전자통신기술")
  })
  it("뒤 조각 첫 행 한 행 칸에 글이 있으면 새 행이다", () => {
    const r = join("새 직류")
    assert.equal(r.split, false)
    assert.equal(r.table.rows, 6)
  })
})
