import { describe, it } from "node:test"
import assert from "node:assert/strict"
import JSZip from "jszip"
import { createXmlParser } from "../src/hwpx/parser-shared.js"
import { renderHwpxToSvg } from "../src/render/svg-render.js"

const ns = 'xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core"'
const head = `<hh:head ${ns}><hh:fontfaces><hh:fontface lang="HANGUL"><hh:font id="0" face="함초롬바탕" type="TTF"/></hh:fontface></hh:fontfaces>` +
  `<hh:charProperties><hh:charPr id="0" height="1000"><hh:fontRef hangul="0"/></hh:charPr></hh:charProperties>` +
  `<hh:paraProperties><hh:paraPr id="0"><hh:align horizontal="LEFT"/><hh:lineSpacing type="PERCENT" value="160"/></hh:paraPr></hh:paraProperties></hh:head>`

/** 1×2 표(칸 4000 × 2) — 칸 간격 sp 면 표 너비 = 8000 + sp × 3(한컴 저장 규칙). 칸 글 "가"·"나" 의 x·y */
async function cells(sp: number): Promise<Map<string, { x: number; y: number }>> {
  const tc = (c: number, t: string) => `<hp:tc><hp:subList vertAlign="TOP"><hp:p paraPrIDRef="0"><hp:run charPrIDRef="0"><hp:t>${t}</hp:t></hp:run></hp:p></hp:subList>` +
    `<hp:cellAddr colAddr="${c}" rowAddr="0"/><hp:cellSpan colSpan="1" rowSpan="1"/><hp:cellSz width="4000" height="2000"/><hp:cellMargin left="0" right="0" top="0" bottom="0"/></hp:tc>`
  const tbl = `<hp:tbl rowCnt="1" colCnt="2" cellSpacing="${sp}"><hp:sz width="${8000 + sp * 3}" height="${2000 + sp * 2}"/><hp:pos treatAsChar="0" vertRelTo="PARA" horzRelTo="PARA" vertOffset="0" horzOffset="0"/>` +
    `<hp:outMargin left="0" right="0" top="0" bottom="0"/><hp:inMargin left="0" right="0" top="0" bottom="0"/><hp:tr>${tc(0, "가")}${tc(1, "나")}</hp:tr></hp:tbl>`
  const sec = `<hs:sec ${ns}><hp:p paraPrIDRef="0"><hp:run charPrIDRef="0"><hp:secPr><hp:pagePr width="30000" height="60000"><hp:margin left="1000" right="1000" top="1000" bottom="1000" header="0" footer="0"/></hp:pagePr></hp:secPr>${tbl}<hp:t/></hp:run></hp:p></hs:sec>`
  const z = new JSZip()
  z.file("Contents/header.xml", head); z.file("Contents/section0.xml", sec)
  const { svg } = await renderHwpxToSvg(await z.generateAsync({ type: "uint8array" }), { reflow: true })
  const doc = createXmlParser().parseFromString(svg, "image/svg+xml")
  const out = new Map<string, { x: number; y: number }>()
  for (const t of Array.from(doc.getElementsByTagName("text"))) {
    const s = t.textContent?.trim() ?? ""
    if (s && !out.has(s)) out.set(s, { x: Number(t.getAttribute("x")), y: Number(t.getAttribute("y")) })
  }
  return out
}

describe("render: 칸 간격(cellSpacing)", () => {
  it("첫 칸은 표 왼끝에, 다음 칸은 칸 사이 간격만큼 민다 · 칸은 위 간격만큼 내린다", async () => {
    const flat = await cells(0), spaced = await cells(255)
    assert.ok(Math.abs(spaced.get("가")!.x - flat.get("가")!.x) < 0.05, `첫 칸 x ${spaced.get("가")!.x} ≠ ${flat.get("가")!.x}`)
    // 간격을 칸 너비에 나눠 섞으면 둘째 칸이 4000 × 8765/8000 = 4382 로 가 2.55pt 가 아니라 3.8pt 밀렸다
    assert.ok(Math.abs(spaced.get("나")!.x - flat.get("나")!.x - 2.55) < 0.05, `둘째 칸 x 차 ${spaced.get("나")!.x - flat.get("나")!.x}`)
    assert.ok(Math.abs(spaced.get("가")!.y - flat.get("가")!.y - 2.55) < 0.05, `칸 y 차 ${spaced.get("가")!.y - flat.get("가")!.y}`)
  })
})
