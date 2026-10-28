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

describe("줄 머리 도형 ○ 뒤 라틴 대문자 약어", () => {
  // 칸 0 가는 고리(높이 22, 획 1px), 칸 2~4 대문자, 칸 6 한글 — 키 26 글자 띠
  function ringPage(thick: number): Uint8Array {
    const rgba = new Uint8Array(W * H * 4).fill(255)
    const rect = (x0: number, y0: number, x1: number, y1: number) => {
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const p = (y * W + x) * 4; rgba[p] = rgba[p + 1] = rgba[p + 2] = 0 }
    }
    const cx = 11, cy = 17, r = 10
    for (let y = 0; y < H; y++) for (let x = 0; x < 24; x++) { const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy); if (d <= r && d > r - thick) rect(x, y, x + 1, y + 1) }
    rect(26, 6, 30, 30); rect(33, 6, 41, 30); rect(44, 6, 52, 30); rect(56, 4, 76, 30)
    return rgba
  }
  it("획이 가는 도형 고리면 ○ 로 바꾸고 띄운다", () => {
    assert.equal(restoreGlyphs(ringPage(1), W, box, "OICT가", [1, 2.8, 3.7, 4.8, 6.6], 10), "○ ICT가")
  })
  it("획이 굵은 라틴 O 는 그대로", () => {
    assert.equal(restoreGlyphs(ringPage(4), W, box, "OICT가", [1, 2.8, 3.7, 4.8, 6.6], 10), "OICT가")
  })
})

describe("고리만 든 칸", () => {
  function cellPage(inner: boolean): Uint8Array {
    const rgba = new Uint8Array(W * H * 4).fill(255)
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const d = Math.hypot(x + 0.5 - 40, y + 0.5 - 18)
      if ((d <= 12 && d > 11) || (inner && d <= 6 && d > 5)) { const p = (y * W + x) * 4; rgba[p] = rgba[p + 1] = rgba[p + 2] = 0 }
    }
    return rgba
  }
  it("가는 고리 하나만 든 칸의 O 는 ○", () => {
    assert.equal(restoreGlyphs(cellPage(false), W, box, "O", [4], 10), "○")
  })
  it("이중 고리 ◎ 는 ○ 로 바꾸지 않는다", () => {
    assert.notEqual(restoreGlyphs(cellPage(true), W, box, "O", [4], 10), "○")
  })
})

describe("C 로 읽은 줄 머리 고리", () => {
  function headPage(open: boolean): Uint8Array {
    const rgba = new Uint8Array(W * H * 4).fill(255)
    for (let y = 0; y < H; y++) for (let x = 0; x < 24; x++) {
      const d = Math.hypot(x + 0.5 - 11, y + 0.5 - 17)
      if (d <= 10 && d > 9 && !(open && x > 15 && Math.abs(y + 0.5 - 17) < 5)) { const p = (y * W + x) * 4; rgba[p] = rgba[p + 1] = rgba[p + 2] = 0 }
    }
    for (let y = 4; y < 30; y++) for (let x = 28; x < 70; x++) if (x % 14 < 11) { const p = (y * W + x) * 4; rgba[p] = rgba[p + 1] = rgba[p + 2] = 0 }
    return rgba
  }
  it("닫힌 가는 고리면 ○", () => {
    assert.equal(restoreGlyphs(headPage(false), W, box, "C제2차", [1, 3.4, 4.8, 6.2], 10), "○제2차")
  })
  it("오른쪽이 트인 진짜 C 는 그대로", () => {
    assert.equal(restoreGlyphs(headPage(true), W, box, "C제2차", [1, 3.4, 4.8, 6.2], 10), "C제2차")
  })
})

describe("가운뎃점으로 읽은 작은 고리 。", () => {
  it("· 자리 잉크가 아래쪽 작은 고리면 。", () => {
    const rgba = new Uint8Array(W * H * 4).fill(255)
    const dot = (x: number, y: number) => { const p = (y * W + x) * 4; rgba[p] = rgba[p + 1] = rgba[p + 2] = 0 }
    for (let y = 4; y < 30; y++) for (let x = 4; x < 24; x++) dot(x, y) // 한글 칸
    for (let y = 0; y < H; y++) for (let x = 26; x < 38; x++) { const d = Math.hypot(x + 0.5 - 32, y + 0.5 - 25); if (d <= 4.5 && d > 3) dot(x, y) } // 。
    for (let y = 4; y < 30; y++) for (let x = 40; x < 60; x++) dot(x, y)
    assert.equal(restoreGlyphs(rgba, W, box, "가·나", [1, 3.1, 5], 10), "가。나")
  })
})
