import { describe, it } from "node:test"
import assert from "node:assert/strict"
import JSZip from "jszip"
import { renderHwpxPages } from "../src/render/index.js"
import { markdownToHwpx } from "../src/hwpx/generator.js"

const seg = (v: number) => `<hp:linesegarray><hp:lineseg textpos="0" vertpos="${v}" vertsize="1000" textheight="1000" baseline="850" spacing="600" horzpos="0" horzsize="40000" flags="393216"/></hp:linesegarray>`
const row = (r: number) => `<hp:tr><hp:tc name="" header="0" hasMargin="0" protect="0" editable="0" dirty="0" borderFillIDRef="1"><hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="TOP" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">` +
  `<hp:p id="0" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0"><hp:t>행${r}</hp:t></hp:run>${seg(0)}</hp:p></hp:subList>` +
  `<hp:cellAddr colAddr="0" rowAddr="${r}"/><hp:cellSpan colSpan="1" rowSpan="1"/><hp:cellSz width="40000" height="3000"/><hp:cellMargin left="141" right="141" top="141" bottom="141"/></hp:tc></hp:tr>`
// 10행 30000 높이 표를 앵커 줄 아래 4000 띄워 둔다 — 앵커 50000 이면 표 위 54141, 본문 65762 를 넘어 다음 쪽으로 이어진다
const tbl = `<hp:tbl id="7" zOrder="0" numberingType="TABLE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" pageBreak="CELL" repeatHeader="0" rowCnt="10" colCnt="1" cellSpacing="0" borderFillIDRef="1" noAdjust="0">` +
  `<hp:sz width="40000" widthRelTo="ABSOLUTE" height="30000" heightRelTo="ABSOLUTE" protect="0"/><hp:pos treatAsChar="0" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="PARA" vertAlign="TOP" horzAlign="LEFT" vertOffset="4000" horzOffset="0"/>` +
  `<hp:outMargin left="141" right="141" top="141" bottom="141"/><hp:inMargin left="141" right="141" top="141" bottom="141"/>${Array.from({ length: 10 }, (_, r) => row(r)).join("")}</hp:tbl>`

describe("render: 세로 오프셋으로 띄운 쪽 넘는 표 위 문단", () => {
  it("앵커와 표 위 사이에 저장된 문단은 앵커 쪽, 표 아래 문단은 표 끝 쪽", async () => {
    const zip = await JSZip.loadAsync(await markdownToHwpx("앵커\n\n위글\n\n뒤글"))
    const name = Object.keys(zip.files).find(n => /section0\.xml$/.test(n))!
    let sec = (await zip.file(name)!.async("string")).replace(/<hp:linesegarray>[\s\S]*?<\/hp:linesegarray>/g, "")
    const v: Record<string, number> = { 앵커: 50000, 위글: 52000, 뒤글: 19000 }
    sec = sec.replace(/<hp:t>(앵커|위글|뒤글)<\/hp:t>([\s\S]*?)<\/hp:run><\/hp:p>/g, (m, t: string) =>
      (t === "앵커" ? m.replace("<hp:t>앵커</hp:t>", `${tbl}<hp:t>앵커</hp:t>`) : m).replace(/<\/hp:run><\/hp:p>$/, `</hp:run>${seg(v[t])}</hp:p>`))
    zip.file(name, sec)
    const r = await renderHwpxPages(new Uint8Array(await zip.generateAsync({ type: "nodebuffer" })))
    const pageOf = (t: string) => [...r.pageSvgs].filter(([, svg]) => svg.includes(`>${t}<`)).map(([n]) => n)
    assert.deepEqual(pageOf("위글"), [1])
    assert.deepEqual(pageOf("뒤글"), [2])
  })
})
