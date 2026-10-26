import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { detectRulingLines } from "../src/ocr/ruling-lines.js"

// 1px = 1pt 래스터 — 위 상자 밑변과 아래 상자 윗변을 잇는 짧은 연결선(15pt, 최소 괘선 길이 20pt 미만)
const W = 160, H = 200
function canvas(): Uint8Array { return new Uint8Array(W * H * 4).fill(255) }
function rect(g: Uint8Array, x0: number, y0: number, x1: number, y1: number) {
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const p = (y * W + x) * 4; g[p] = g[p + 1] = g[p + 2] = 0 }
}
function box(g: Uint8Array, x0: number, y0: number, x1: number, y1: number) {
  rect(g, x0, y0, x1, y0 + 2); rect(g, x0, y1 - 2, x1, y1); rect(g, x0, y0, x0 + 2, y1); rect(g, x1 - 2, y0, x1, y1)
}
const bridges = (g: Uint8Array) => detectRulingLines(g, W, H, 1).verticals.filter(v => Math.abs(v.x1 - 60) <= 2 && v.y2 - v.y1 < 20)

describe("detectRulingLines — 조직도 상자 연결선", () => {
  it("같은 폭 두 닫힌 상자 사이 가운데 짧은 선은 괘선으로 살린다", () => {
    const g = canvas()
    box(g, 20, 20, 100, 60); box(g, 20, 75, 100, 140); rect(g, 59, 60, 61, 75)
    assert.equal(bridges(g).length, 1)
  })
  it("표 행 안(양옆 테두리가 이어짐)·가장자리 쪽 짧은 선은 살리지 않는다", () => {
    const row = canvas()
    rect(row, 20, 20, 100, 22); rect(row, 20, 35, 100, 37); rect(row, 20, 20, 22, 37); rect(row, 98, 20, 100, 37); rect(row, 59, 22, 61, 35)
    assert.equal(bridges(row).length, 0)
    const edge = canvas()
    box(edge, 20, 20, 100, 60); box(edge, 20, 75, 100, 140); rect(edge, 29, 60, 31, 75)
    assert.equal(detectRulingLines(edge, W, H, 1).verticals.filter(v => Math.abs(v.x1 - 30) <= 2 && v.y2 - v.y1 < 20).length, 0)
  })
})
