import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { closingParens, footerInkBox } from "../src/ocr/engine.js"

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
