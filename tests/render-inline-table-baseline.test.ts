import { describe, it } from "node:test"
import assert from "node:assert/strict"
import JSZip from "jszip"
import { renderHwpxPages } from "../src/render/index.js"
import { markdownToHwpx } from "../src/hwpx/generator.js"

const cellSeg = `<hp:lineseg textpos="0" vertpos="0" vertsize="1000" textheight="1000" baseline="850" spacing="600" horzpos="0" horzsize="5000" flags="393216"/>`
const tbl = (text: string, h: number) => `<hp:tbl textWrap="TOP_AND_BOTTOM" pageBreak="NONE" rowCnt="1" colCnt="1" cellSpacing="0"><hp:sz width="6000" widthRelTo="ABSOLUTE" height="${h}" heightRelTo="ABSOLUTE"/>` +
  `<hp:pos treatAsChar="1" vertRelTo="PARA" horzRelTo="PARA" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/><hp:outMargin left="140" right="140" top="140" bottom="140"/><hp:inMargin left="0" right="0" top="0" bottom="0"/>` +
  `<hp:tr><hp:tc><hp:subList vertAlign="TOP"><hp:p paraPrIDRef="0"><hp:run charPrIDRef="0"><hp:t>${text}</hp:t></hp:run><hp:linesegarray>${cellSeg}</hp:linesegarray></hp:p></hp:subList>` +
  `<hp:cellAddr colAddr="0" rowAddr="0"/><hp:cellSpan colSpan="1" rowSpan="1"/><hp:cellSz width="6000" height="${h}"/><hp:cellMargin left="0" right="0" top="0" bottom="0"/></hp:tc></hp:tr></hp:tbl>`

describe("render: 한 줄에 나란한 높이가 다른 인라인 표", () => {
  it("작은 표도 바깥 여백까지 든 높이의 85% 를 줄 기준선 위에 둔다", async () => {
    const zip = await JSZip.loadAsync(await markdownToHwpx("자리표"))
    const name = Object.keys(zip.files).find(n => /section0\.xml$/.test(n))!
    let sec = await zip.file(name)!.async("string")
    const host = `<hp:p paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0">${tbl("큰표", 11298)}${tbl("작은표", 8172)}<hp:t/></hp:run>` +
      `<hp:linesegarray><hp:lineseg textpos="0" vertpos="0" vertsize="11578" textheight="11578" baseline="9841" spacing="600" horzpos="0" horzsize="48000" flags="393216"/></hp:linesegarray></hp:p>`
    const k = sec.indexOf("자리표"), a = sec.lastIndexOf("<hp:p ", k), b = sec.indexOf("</hp:p>", k) + "</hp:p>".length
    sec = sec.slice(0, a) + host + sec.slice(b)
    zip.file(name, sec)
    const r = await renderHwpxPages(new Uint8Array(await zip.generateAsync({ type: "nodebuffer" })))
    const svg = r.pageSvgs.get(1)!
    const y = (t: string) => Number([...svg.matchAll(/<text x="[-\d.]+" y="([-\d.]+)"[^>]*>([^<]+)</g)].find(m => m[2] === t)![1])
    // 큰 표 위 = 줄 위 + 140, 작은 표 위 = 줄 위 + 9841 − 0.85 × 8452 + 140 = 2797 → 차이 26.57pt(바닥을 기준선에 두면 13.89pt)
    assert.ok(Math.abs(y("작은표") - y("큰표") - 26.57) < 0.1, `${y("작은표") - y("큰표")}`)
  })
})
