import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { restoreGlyphs } from "../src/ocr/glyph-restore.js"

// 60×34 흰 상자 — 칸 0 여는 괄호, 칸 2 한글, 칸 4 닫는 괄호 (stepPx 10 → 글자 자리 x 5·25·45)
const W = 60, H = 34
function page(openLens: boolean, closeLens: boolean): Uint8Array {
  const rgba = new Uint8Array(W * H * 4).fill(255)
  const rect = (x0: number, y0: number, x1: number, y1: number) => {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const p = (y * W + x) * 4; rgba[p] = rgba[p + 1] = rgba[p + 2] = 0 }
  }
  // 렌즈 꼴(【】) — 위아래 끝이 넓고 가운데로 좁아지는 속 찬 조각, 곧은 [ ] — 가는 줄기와 위아래 변
  const lens = (x: number, right: boolean) => { for (let y = 4; y < 30; y++) { const k = 4 + Math.round(4 * Math.abs(y - 17) / 13); rect(right ? x + 8 - k : x, y, right ? x + 8 : x + k, y + 1) } }
  if (openLens) lens(1, false); else { rect(2, 4, 4, 30); rect(2, 4, 9, 6); rect(2, 28, 9, 30) }
  rect(15, 6, 35, 28) // 한글
  if (closeLens) lens(41, true); else { rect(46, 4, 48, 30); rect(41, 4, 48, 6); rect(41, 28, 48, 30) }
  return rgba
}
const box = { x: 0, y: 0, w: W, h: H }

describe("괄호 짝 일관성 — 한쪽만 렌즈 꼴이면 [ ] 로 둔다", () => {
  it("양쪽 다 렌즈 꼴이면 【】", () => {
    assert.equal(restoreGlyphs(page(true, true), W, box, "[가]", [0, 2, 4], 10), "【가】")
  })
  it("여는 쪽만 렌즈 꼴(흐림으로 한쪽 끝만 번짐)이면 [ ] 그대로", () => {
    assert.equal(restoreGlyphs(page(true, false), W, box, "[가]", [0, 2, 4], 10), "[가]")
  })
})
