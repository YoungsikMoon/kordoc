import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { restoreGlyphs } from "../src/ocr/glyph-restore.js"

// 80×36 흰 상자 — 칸 0 「(앞에서 읽힘), 칸 1 한글, 칸 3 쉼표 자리 기호, 칸 5 한글
const W = 80, H = 36
function page(closeCorner: boolean): Uint8Array {
  const rgba = new Uint8Array(W * H * 4).fill(255)
  const rect = (x0: number, y0: number, x1: number, y1: number) => {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const p = (y * W + x) * 4; rgba[p] = rgba[p + 1] = rgba[p + 2] = 0 }
  }
  rect(2, 4, 9, 6); rect(2, 4, 4, 17) // 「
  rect(10, 4, 24, 30) // 한글
  if (closeCorner) { rect(28, 28, 38, 30); rect(36, 17, 38, 30) } // 」 — 오른쪽 줄기 + 밑변
  else { rect(31, 25, 35, 29); rect(32, 29, 34, 33) } // 쉼표 — 점 + 꼬리
  rect(45, 4, 60, 30) // 한글
  return rgba
}
const box = { x: 0, y: 0, w: W, h: H }

describe("쉼표로 읽은 닫는 홑낫표", () => {
  it("짝 없는 「 뒤 쉼표 자리가 」 꼴이면 」", () => {
    assert.equal(restoreGlyphs(page(true), W, box, "「가,나", [0, 1, 3, 5], 10), "「가」나")
  })
  it("진짜 쉼표·짝 없는 「 이 없는 줄은 그대로", () => {
    assert.equal(restoreGlyphs(page(false), W, box, "「가,나", [0, 1, 3, 5], 10), "「가,나")
    assert.equal(restoreGlyphs(page(true), W, box, "가가,나", [0, 1, 3, 5], 10), "가가,나")
  })
})

describe("따옴표로 읽은 여는 홑낫표", () => {
  // 칸 0 자리 기호(「 꼴 또는 작은 따옴표), 칸 1 한글, 칸 3 」, 칸 5 한글
  function quotePage(corner: boolean): Uint8Array {
    const rgba = new Uint8Array(W * H * 4).fill(255)
    const rect = (x0: number, y0: number, x1: number, y1: number) => {
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const p = (y * W + x) * 4; rgba[p] = rgba[p + 1] = rgba[p + 2] = 0 }
    }
    if (corner) { rect(2, 4, 9, 6); rect(2, 4, 4, 17) } else { rect(3, 4, 7, 8); rect(4, 8, 6, 11) } // 「 / 작은 따옴표(글자 높이 27%)
    rect(10, 4, 24, 30)
    rect(28, 28, 38, 30); rect(36, 17, 38, 30)
    rect(45, 4, 60, 30)
    return rgba
  }
  it("뒤가 한글인 ' 자리가 「 꼴이면 「, 짝 쉼표도 」 로", () => {
    assert.equal(restoreGlyphs(quotePage(true), W, box, "'가,나", [0, 1, 3, 5], 10), "「가」나")
  })
  it("작은 따옴표는 그대로", () => {
    assert.ok(!restoreGlyphs(quotePage(false), W, box, "'가,나", [0, 1, 3, 5], 10).includes("「"))
  })
})
