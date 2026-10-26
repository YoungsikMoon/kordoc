import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { cellEdgeVerticals } from "../src/ocr/pdf-ocr.js"

const seg = (x1: number, y1: number, x2: number, y2: number) => ({ x1, y1, x2, y2, thicknessPx: 2 })

describe("cellEdgeVerticals — 검출 박스를 가를 표 칸 경계", () => {
  it("위아래 끝이 가로 괘선에 닿는 세로선만, 끝이 뜬 여백선·단 구분선은 뺀다", () => {
    const r = {
      horizontals: [seg(0, 0, 200, 0), seg(0, 100, 200, 100)],
      verticals: [seg(100, 0, 100, 100), seg(150, 20, 150, 80), seg(300, 0, 300, 100)],
    }
    assert.deepEqual(cellEdgeVerticals(r).map(v => v.x1), [100])
  })
})
