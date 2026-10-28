import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { closingParens, footerInkBox, placeholderSquares, rowHeadDashes, rowTailBoxes } from "../src/ocr/engine.js"

const W = 400, H = 600
function page(): Uint8Array {
  const rgba = new Uint8Array(W * H * 4).fill(255)
  const rect = (x0: number, y0: number, x1: number, y1: number) => {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const p = (y * W + x) * 4; rgba[p] = rgba[p + 1] = rgba[p + 2] = 0 }
  }
  rect(170, 572, 182, 574); rect(198, 566, 200, 580); rect(216, 572, 228, 574) // "-   1   -" (높이 14px = 쪽의 2.3%)
  return rgba
}

describe("footerInkBox — 검출기가 놓친 쪽 번호", () => {
  it("쪽 아래 가운데 띠의 상자 밖 잉크 외곽을 낸다", () => {
    assert.deepEqual(footerInkBox(page(), W, H, []), { x: 166, y: 562, w: 66, h: 22 })
  })
  it("이미 검출 상자에 든 잉크는 보지 않는다", () => {
    assert.equal(footerInkBox(page(), W, H, [{ x: 160, y: 560, w: 80, h: 25 }]), null)
  })
})

describe("closingParens — 서식 칸에서 멀리 떨어진 닫는 괄호", () => {
  const W2 = 300, H2 = 60
  function line(paren: boolean, rule: boolean): Uint8Array {
    const rgba = new Uint8Array(W2 * H2 * 4).fill(255)
    const dot = (x: number, y: number) => { const p = (y * W2 + x) * 4; rgba[p] = rgba[p + 1] = rgba[p + 2] = 0 }
    if (paren) for (let y = 20; y < 40; y++) { const x = 200 + Math.round(3 * Math.sin(((y - 20) / 19) * Math.PI)); dot(x, y); dot(x + 1, y) }
    if (rule) for (let y = 0; y < H2; y++) { dot(250, y); dot(251, y) }
    return rgba
  }
  const it0 = { text: "(전화 :", x: 20, y: 18, w: 80, h: 24, confidence: 0.99 }
  it("휜 조각 하나면 ) 를 낸다", () => {
    assert.deepEqual(closingParens(line(true, false), W2, [it0]).map(i => i.text), [")"])
  })
  it("띠 밖으로 이어지는 칸 테두리는 괄호가 아니다", () => {
    assert.deepEqual(closingParens(line(false, true), W2, [it0]), [])
  })
})

describe("placeholderSquares — 검출기가 놓친 서식 빈칸 네모", () => {
  const W3 = 300, H3 = 80
  function page(): Uint8Array {
    const rgba = new Uint8Array(W3 * H3 * 4).fill(255)
    const rect = (x0: number, y0: number, x1: number, y1: number) => {
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const p = (y * W3 + x) * 4; rgba[p] = rgba[p + 1] = rgba[p + 2] = 0 }
    }
    const box = (x: number, y: number, s: number) => { rect(x, y, x + s, y + 2); rect(x, y + s - 2, x + s, y + s); rect(x, y, x + 2, y + s); rect(x + s - 2, y, x + s, y + s) }
    box(20, 20, 20); box(44, 20, 20); rect(68, 29, 76, 32); box(80, 20, 20) // □□-□
    box(200, 20, 20) // 검출 상자 안(이미 읽은 글)
    box(150, 60, 8) // 작은 표시 네모
    return rgba
  }
  it("같은 줄 네모를 이어 □ 무리로, 막대는 - 로", () => {
    const got = placeholderSquares(page(), W3, H3, [{ text: "가", x: 195, y: 15, w: 30, h: 30, confidence: 1 }])
    assert.deepEqual(got.map(i => i.text), ["□□-□"])
  })
  it("잡티가 붙어 막대 꼴이 아닌 막대도 틈 가운데 가로 줄이면 - 로", () => {
    const rgba = page()
    for (let y = 32; y < 40; y++) { const p = (y * W3 + 70) * 4; rgba[p] = rgba[p + 1] = rgba[p + 2] = 0 } // 막대 아래로 늘어진 잡티
    assert.deepEqual(placeholderSquares(rgba, W3, H3, [{ text: "가", x: 195, y: 15, w: 30, h: 30, confidence: 1 }]).map(i => i.text), ["□□-□"])
  })
})

describe("rowTailBoxes — 줄 끝 홑 쪽 번호", () => {
  const W4 = 400, H4 = 60
  function page(extra: boolean): Uint8Array {
    const rgba = new Uint8Array(W4 * H4 * 4).fill(255)
    const rect = (x0: number, y0: number, x1: number, y1: number) => {
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const p = (y * W4 + x) * 4; rgba[p] = rgba[p + 1] = rgba[p + 2] = 0 }
    }
    rect(340, 12, 343, 32) // 가는 "1"
    if (extra) rect(250, 12, 270, 32) // 다른 무리(표 칸 글)
    return rgba
  }
  const row = [{ text: "1. 사업 개요", x: 20, y: 10, w: 150, h: 24, confidence: 1 }]
  it("한글 줄 오른쪽 끝 잉크 무리 하나면 상자를 낸다", () => {
    assert.equal(rowTailBoxes(page(false), W4, row).length, 1)
  })
  it("무리가 둘이면·한글 없는 줄이면 내지 않는다", () => {
    assert.equal(rowTailBoxes(page(true), W4, row).length, 0)
    assert.equal(rowTailBoxes(page(false), W4, [{ ...row[0], text: "1. Overview" }]).length, 0)
  })
})

describe("rowHeadDashes — 줄 머리 대시", () => {
  const W5 = 300, H5 = 60
  function page(): Uint8Array {
    const rgba = new Uint8Array(W5 * H5 * 4).fill(255)
    for (let y = 26; y < 29; y++) for (let x = 40; x < 60; x++) { const p = (y * W5 + x) * 4; rgba[p] = rgba[p + 1] = rgba[p + 2] = 0 }
    return rgba
  }
  it("한글로 여는 줄 앞 짧은 가로 막대는 - 아이템", () => {
    const got = rowHeadDashes(page(), W5, [{ text: "영농지원과", x: 80, y: 15, w: 120, h: 28, confidence: 1 }])
    assert.deepEqual(got.map(i => i.text), ["-"])
  })
  it("상자 테두리에 닿는 조직도 연결선은 대시가 아니다", () => {
    const rgba = page()
    for (let y = 5; y < 55; y++) for (const x of [62, 63]) { const p = (y * W5 + x) * 4; rgba[p] = rgba[p + 1] = rgba[p + 2] = 200 }
    assert.deepEqual(rowHeadDashes(rgba, W5, [{ text: "감사관", x: 80, y: 15, w: 120, h: 28, confidence: 1 }]), [])
  })
  it("한글로 열지 않는 제목(【목차】) 앞 장식 막대는 넣지 않는다", () => {
    assert.deepEqual(rowHeadDashes(page(), W5, [{ text: "【목차】", x: 80, y: 15, w: 120, h: 28, confidence: 1 }]), [])
  })
})
