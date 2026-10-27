import { describe, it } from "node:test"
import assert from "node:assert/strict"
import JSZip from "jszip"
import { createXmlParser } from "../src/hwpx/parser-shared.js"
import { renderHwpxToSvg } from "../src/render/svg-render.js"

const ns = 'xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core"'
const head = `<hh:head ${ns}><hh:fontfaces><hh:fontface lang="HANGUL"><hh:font id="0" face="함초롬바탕" type="TTF"/></hh:fontface></hh:fontfaces>` +
  `<hh:charProperties><hh:charPr id="0" height="1000"><hh:fontRef hangul="0"/></hh:charPr></hh:charProperties>` +
  `<hh:paraProperties><hh:paraPr id="0"><hh:align horizontal="LEFT"/><hh:lineSpacing type="PERCENT" value="160"/></hh:paraPr></hh:paraProperties></hh:head>`
const para = (t: string) => `<hp:p paraPrIDRef="0"><hp:run charPrIDRef="0"><hp:t>${t}</hp:t></hp:run></hp:p>`

const seg = (v: number, h: number) => `<hp:linesegarray><hp:lineseg textpos="0" vertpos="${v}" vertsize="${h}" textheight="${h}" baseline="${Math.round(h * 0.85)}" spacing="600" horzpos="0" horzsize="28000" flags="393216"/></hp:linesegarray>`

/**
 * 글자처럼 취급하는 1×1 표 — 칸에 줄 lines 개, 저장 높이(표 sz·칸 cellSz)는 한 줄 몫 2000 그대로(편집으로 칸 글만 늘어난 꼴).
 * cached 면 한컴 저장본처럼 표 문단·뒤 문단에 옛 조판 캐시(표 2000 + 바깥 여백 기준)를 단다 — 칸 문단만 캐시가 없다(패치가 지운 꼴)
 */
async function render(lines: number, cached: { host: boolean; after?: number } = { host: false }): Promise<Map<string, number>> {
  const cell = Array.from({ length: lines }, (_, i) => para(`칸${i + 1}`)).join("")
  const tbl = `<hp:tbl rowCnt="1" colCnt="1" cellSpacing="0"><hp:sz width="10000" height="2000"/><hp:pos treatAsChar="1" vertRelTo="PARA" horzRelTo="PARA"/>` +
    `<hp:outMargin left="141" right="141" top="141" bottom="141"/><hp:inMargin left="141" right="141" top="141" bottom="141"/>` +
    `<hp:tr><hp:tc><hp:subList vertAlign="TOP">${cell}</hp:subList><hp:cellAddr colAddr="0" rowAddr="0"/><hp:cellSpan colSpan="1" rowSpan="1"/><hp:cellSz width="10000" height="2000"/></hp:tc></hp:tr></hp:tbl>`
  const sec = `<hs:sec ${ns}><hp:p paraPrIDRef="0"><hp:run charPrIDRef="0"><hp:secPr><hp:pagePr width="30000" height="60000"><hp:margin left="1000" right="1000" top="1000" bottom="1000" header="0" footer="0"/></hp:pagePr></hp:secPr><hp:t>앞 문단</hp:t></hp:run>${cached.host || cached.after !== undefined ? seg(0, 1000) : ""}</hp:p>` +
    `<hp:p paraPrIDRef="0"><hp:run charPrIDRef="0">${tbl}<hp:t/></hp:run>${cached.host ? seg(1600, 2282) : ""}</hp:p>` +
    `<hp:p paraPrIDRef="0"><hp:run charPrIDRef="0"><hp:t>뒤 문단</hp:t></hp:run>${cached.after !== undefined ? seg(cached.after, 1000) : ""}</hp:p>` +
    `<hp:p paraPrIDRef="0"><hp:run charPrIDRef="0"><hp:t>끝 문단</hp:t></hp:run>${cached.after !== undefined ? seg(cached.after + 1600, 1000) : ""}</hp:p></hs:sec>`
  const z = new JSZip()
  z.file("Contents/header.xml", head); z.file("Contents/section0.xml", sec)
  const { svg } = await renderHwpxToSvg(await z.generateAsync({ type: "uint8array" }), { reflow: true })
  const doc = createXmlParser().parseFromString(svg, "image/svg+xml")
  const ys = new Map<string, number>()
  for (const t of Array.from(doc.getElementsByTagName("text"))) {
    const s = t.textContent?.trim() ?? ""
    if (s && !ys.has(s)) ys.set(s, Number(t.getAttribute("y")))
  }
  return ys
}

describe("render: 칸 글이 저장 높이보다 길어진 글자처럼 취급 표", () => {
  it("표는 제 줄 맨 위에 그리고, 뒤 문단은 자란 표 아래로 민다", async () => {
    const one = await render(1), many = await render(8)
    // 표 위치는 칸 글 줄 수와 상관없다 — 저장 높이로 기준선에 얹으면 자란 만큼 아래로 내려가 위에 빈 자리가 생겼다
    assert.equal(many.get("칸1"), one.get("칸1"))
    assert.ok(many.get("칸8")! < many.get("뒤 문단")!, `뒤 문단(${many.get("뒤 문단")})이 표 끝 줄(${many.get("칸8")})과 겹침`)
  })

  it("뒤 문단에 옛 조판 캐시가 남아 있어도 자란 표 아래로 민다", async () => {
    const many = await render(8, { host: false, after: 4482 })
    assert.ok(many.get("칸8")! < many.get("뒤 문단")!, `뒤 문단(${many.get("뒤 문단")})이 표 끝 줄(${many.get("칸8")})과 겹침`)
    // 밀린 문단 뒤 캐시 문단도 — 저장 자리는 앞 문단의 저장 자리와 견준다(밀린 자리와 견주면 새 쪽 첫 줄로 보고 다음 쪽에 그렸다)
    assert.ok(many.get("뒤 문단")! < many.get("끝 문단")!, `끝 문단(${many.get("끝 문단")})이 뒤 문단(${many.get("뒤 문단")}) 위`)
  })

  it("표 문단 캐시가 옛 표 높이여도 표 줄을 다시 짜 뒤 문단을 민다", async () => {
    const one = await render(1, { host: true, after: 4482 }), many = await render(8, { host: true, after: 4482 })
    assert.equal(many.get("칸1"), one.get("칸1"))
    assert.ok(many.get("칸8")! < many.get("뒤 문단")!, `뒤 문단(${many.get("뒤 문단")})이 표 끝 줄(${many.get("칸8")})과 겹침`)
  })

  it("칸 글이 저장 높이에 들면 뒤 문단은 저장 자리 그대로", async () => {
    // 뒤 문단 캐시를 1000 내려 적으면 그린 자리도 그만큼 내려간다 — 캐시를 믿는다
    const a = await render(1, { host: true, after: 4482 }), b = await render(1, { host: true, after: 5482 })
    assert.ok(b.get("뒤 문단")! > a.get("뒤 문단")!)
    assert.equal(b.get("칸1"), a.get("칸1"))
  })
})
