/**
 * 한컴 PUA → 표준 유니코드 매핑 회귀 테스트.
 *
 * 매핑 없는 Supplementary PUA는 sanitizeText가 삭제하므로, 매핑 누락은 곧 글자 증발이다
 * (결재란 "(인)"이 통째로 사라지는 식). 한컴 PDF 대조로 확정된 것만 고정한다.
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { composeText, mapPuaText } from "../src/shared/pua.js"
import { blocksToMarkdown, sanitizeText } from "../src/table/builder.js"
import type { IRBlock } from "../src/types.js"

describe("mapPuaText — 한컴 검증 PUA (rhwp 44cabad9)", () => {
  it("결재·서명란 기호를 '(인)'으로", () => {
    assert.equal(mapPuaText("\u{F012B}"), "(인)")
  })

  it("행정업무운영 편람 글머리표", () => {
    assert.equal(mapPuaText("\u{F02FC}"), "►")
    assert.equal(mapPuaText("\u{F031C}"), "■")
  })

  it("Enter 키 픽토그램을 줄바꿈 화살표로", () => {
    assert.equal(mapPuaText("\u{F03A0}"), "↵")
  })

  it("머리말 회사명 6자", () => {
    assert.equal(mapPuaText("\u{F03EF}\u{F03F0}\u{F03F1}\u{F03F2}\u{F03F3}\u{F03F4}"), "한글과컴퓨터")
  })
})

describe("mapPuaText — rhwp 검증표 동기화분", () => {
  it("텍스트 다이어그램 괘선 조각 6종", () => {
    assert.equal(mapPuaText("\u{F0806}\u{F0807}\u{F0808}\u{F080C}\u{F080E}\u{F0810}"), "┌┬┐└┘│")
  })

  it("별도 글리프 원숫자 ⓪~⑨ — ③(F028B)도 한컴 글꼴 6종의 글리프 모양", () => {
    assert.equal(mapPuaText("\u{F0288}\u{F0289}\u{F028A}"), "⓪①②")
    assert.equal(mapPuaText("\u{F028C}\u{F0291}"), "④⑨")
    assert.equal(mapPuaText("\u{F028B}"), "③")
  })

  it("괘선·글머리 잔여 항목", () => {
    assert.equal(mapPuaText("\u{F081C}"), "┈")
    assert.equal(mapPuaText("\u{F0832}"), "═")
    assert.equal(mapPuaText("\u{F0848}"), "━")
    assert.equal(mapPuaText("\u{F02EC}"), "◇")
    assert.equal(mapPuaText("\u{F03A7}\u{F03A8}"), "⊟⊞")
  })
})

describe("mapPuaText — 사각 안 숫자와 두 자리 번호 조각 (한컴 글꼴 6종의 글리프 모양)", () => {
  it("네모 안 0~9(U+F02B0~F02B9)는 원 숫자로", () => {
    assert.equal(mapPuaText("\u{F02B0}\u{F02B1}\u{F02B2}\u{F02B9}"), "⓪①②⑨")
  })

  it("홀로 쓴 조각은 보이는 글 — 왼쪽 숫자 네모(U+F02BA~F02C2)는 원 숫자, 일의 자리(U+F0292~F029B·F02C3~F02CC)는 숫자", () => {
    // 종전 표는 U+F02B1~F02C4 를 ①~⑳ 으로 이어 매겨 F02BA 를 ⑩, F02C4 를 ⑳ 으로 읽었다
    assert.equal(mapPuaText("\u{F02BA}\u{F02C2}"), "①⑨")
    assert.equal(mapPuaText("\u{F02C3}\u{F02C4}\u{F02CC}"), "019")
    assert.equal(mapPuaText("\u{F0292}\u{F029B}"), "09")
  })

  it("이어진 십의 자리 조각 + 일의 자리 숫자는 두 자리 번호(글자 겹치기)", () => {
    assert.equal(mapPuaText("\u{F0289}\u{F0298}"), "⑯")
    assert.equal(mapPuaText("\u{F028A}\u{F0295}"), "㉓")
    assert.equal(mapPuaText("\u{F028B}\u{F029A}"), "㊳")
    assert.equal(mapPuaText("\u{F02BA}\u{F02C3}"), "⑩")
    assert.equal(mapPuaText("\u{F02BB}\u{F02CC}"), "㉙")
    assert.equal(mapPuaText("\u{F028D}\u{F0293}"), "(51)") // 원 숫자가 없는 51 이상은 괄호
    assert.equal(mapPuaText("가\u{F0289}\u{F0298}나"), "가⑯나")
  })

  it("조각 사이에 다른 글이 끼면 합치지 않는다", () => {
    assert.equal(mapPuaText("\u{F0289} \u{F0298}"), "① 6")
  })

  it("반전 숫자 조각 등 확인하지 않은 대역은 건드리지 않는다", () => {
    assert.equal(mapPuaText("\u{F029C}"), "\u{F029C}")
    assert.equal(mapPuaText("\u{F02CD}"), "\u{F02CD}")
  })
})

describe("composeText — 글자 겹치기의 글", () => {
  it("둘러싼 도형 안 숫자는 원 숫자, 그 밖은 겹친 글 그대로", () => {
    assert.equal(composeText("12", true), "⑫")
    assert.equal(composeText("12", false), "12")
    assert.equal(composeText("◯인", true), "◯인")
    assert.equal(mapPuaText(composeText("\u{F0289}\u{F0298}", false)), "⑯")
  })
})

describe("mapPuaText — 기존 동작 유지", () => {
  it("종전 매핑 회귀 없음", () => {
    assert.equal(mapPuaText("\u{F03C5}"), "□")
    assert.equal(mapPuaText("\u{F0827}"), "■")
  })

  it("네모 안 '예'(U+F00DA)는 예시 표지 [예] — 한컴 글꼴 글리프·시험지 PDF 윤곽 모두 네모 안 예(종전 ▸)", () => {
    assert.equal(mapPuaText("\u{F00DA}"), "[예]")
  })

  it("근거 없는 미등록 PUA는 추정하지 않는다 (호출부 제거 로직에 위임)", () => {
    assert.equal(mapPuaText("\u{F03E0}"), "\u{F03E0}")
  })

  it("일반 텍스트는 그대로 통과", () => {
    assert.equal(mapPuaText("일반 텍스트 123"), "일반 텍스트 123")
  })
})

describe("blocksToMarkdown — 서식 run(span) 도 PUA 계약을 탄다", () => {
  it("span 텍스트의 PUA를 표시값으로 바꾸고 미매핑 잔여는 지운다", () => {
    // 종전엔 spans 경로만 sanitize 를 건너뛰어, 굵게/밑줄이 걸린 글머리표·괘선
    // 조각이 원시 PUA 그대로 마크다운에 실렸다 (hwp3-sample10 변환본 116자).
    const blocks: IRBlock[] = [
      {
        type: "paragraph",
        text: "\u{F0810}가로 \u{F03E0}줄",
        spans: [
          { text: "\u{F0810}가로 ", bold: true },
          { text: "\u{F03E0}줄" },
        ],
      },
    ]
    const md = blocksToMarkdown(blocks)
    assert.ok(md.includes("│가로"), `괘선 조각이 표시값으로: ${JSON.stringify(md)}`)
    assert.ok(!/[\u{F0000}-\u{FFFFD}]/u.test(md), `미매핑 PUA 잔여 없음: ${JSON.stringify(md)}`)
  })

  it("서식 마커와 공백 접합은 종전대로", () => {
    const blocks: IRBlock[] = [
      { type: "paragraph", text: "굵게 보통", spans: [{ text: "굵게", bold: true }, { text: " 보통" }] },
    ]
    assert.ok(blocksToMarkdown(blocks).includes("**굵게** 보통"))
  })
})

describe("sanitizeText — 소프트 하이픈", () => {
  it("한컴 보이는 붙임표(글머리·음수 부호)는 - 로, 낱말 안 꺾임 표시는 그대로", () => {
    assert.equal(sanitizeText("­ 3D 프린터"), "- 3D 프린터")
    assert.equal(sanitizeText("­7,445"), "-7,445")
    assert.equal(sanitizeText("infor­mation"), "infor­mation")
  })
})
