import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { createXmlParser } from "../src/hwpx/parser-shared.js"
import { parseRenderStyles } from "../src/render/head-styles.js"
import { reflowSection } from "../src/render/reflow.js"

const ns = 'xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section"'
const head = `<hh:head ${ns}><hh:refList><hh:charProperties><hh:charPr id="0" height="1200"/><hh:charPr id="1" height="900"/></hh:charProperties><hh:paraProperties><hh:paraPr id="0"/></hh:paraProperties></hh:refList></hh:head>`
const seg = (y: number) => `<hp:linesegarray><hp:lineseg textpos="0" vertpos="${y}" vertsize="1200" textheight="1200" spacing="720"/></hp:linesegarray>`

function positions(cached: number[]) {
  const ps = cached.map(y => `<hp:p paraPrIDRef="0"><hp:run charPrIDRef="0"><hp:t>저장 문단</hp:t></hp:run>${seg(y)}</hp:p>`).join("")
  const doc = createXmlParser().parseFromString(`<hs:sec ${ns}><hp:p paraPrIDRef="0"><hp:run charPrIDRef="1"><hp:t>■ 줄 정보 없는 머리 문단</hp:t></hp:run></hp:p>${ps}</hs:sec>`, "text/xml")
  const root = doc.documentElement as unknown as Element
  reflowSection(root, parseRenderStyles(head), { BODY_W: 48190, BODY_H: 70018 })
  const all = root.getElementsByTagName("hp:lineseg")
  const s0 = all[0]
  const bottom = Number(s0.getAttribute("vertpos")) + Number(s0.getAttribute("vertsize")) + Number(s0.getAttribute("spacing"))
  return { bottom, cached: Array.from({ length: cached.length }, (_, i) => Number(all[i + 1].getAttribute("vertpos"))) }
}

describe("캐시 없는 문단 뒤의 낡은 저장 자리", () => {
  it("뒤 캐시 문단은 다시 짠 바닥에 붙고, 같은 쪽의 다음 캐시 문단도 같이 옮긴다", () => {
    const r = positions([1920, 3840])
    assert.notEqual(r.bottom, 1920)
    assert.deepEqual(r.cached, [r.bottom, r.bottom + 1920])
  })
  it("위로는 크게 어긋나도 옮긴다", () => {
    const r = positions([9000, 10920])
    assert.deepEqual(r.cached, [r.bottom, r.bottom + 1920])
  })
  it("칸 저장 높이 합보다 크게 남은 표 sz 는 행 합으로 짜고, 뒤 캐시 문단도 그 바닥으로 올린다", () => {
    const cell = `<hp:tc><hp:subList><hp:p paraPrIDRef="0"><hp:run charPrIDRef="1"><hp:t>*</hp:t></hp:run></hp:p></hp:subList><hp:cellAddr colAddr="0" rowAddr="0"/><hp:cellSpan colSpan="1" rowSpan="1"/><hp:cellSz width="16000" height="282"/><hp:cellMargin left="0" right="0" top="141" bottom="141"/></hp:tc>`
    const tbl = `<hp:tbl rowCnt="1" colCnt="1" pageBreak="CELL"><hp:sz width="16000" height="11565"/><hp:pos treatAsChar="1" vertRelTo="PARA"/><hp:outMargin left="0" right="0" top="0" bottom="0"/><hp:tr>${cell}</hp:tr></hp:tbl>`
    const doc = createXmlParser().parseFromString(`<hs:sec ${ns}><hp:p paraPrIDRef="0"><hp:run charPrIDRef="0">${tbl}<hp:t/></hp:run></hp:p><hp:p paraPrIDRef="0"><hp:run charPrIDRef="0"><hp:t>뒤 문단</hp:t></hp:run>${seg(13485)}</hp:p></hs:sec>`, "text/xml")
    const root = doc.documentElement as unknown as Element
    reflowSection(root, parseRenderStyles(head), { BODY_W: 48190, BODY_H: 70018 })
    const ps = root.getElementsByTagName("hp:p")
    const host = ps[0].getElementsByTagName("hp:lineseg")
    const hostSeg = host[host.length - 1]
    assert.ok(Number(hostSeg.getAttribute("vertsize")) < 3000, hostSeg.toString())
    const after = Number(ps[ps.length - 1].getElementsByTagName("hp:lineseg")[0].getAttribute("vertpos"))
    assert.equal(after, Number(hostSeg.getAttribute("vertpos")) + Number(hostSeg.getAttribute("vertsize")) + Number(hostSeg.getAttribute("spacing")))
  })
  it("쪽 넘김으로 생긴 차이는 옮기지 않는다", () => {
    const r = positions([1920, 0])
    assert.deepEqual(r.cached, [r.bottom, 0])
  })
})
