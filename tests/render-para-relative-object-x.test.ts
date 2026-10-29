import { describe, it } from "node:test"
import assert from "node:assert/strict"
import JSZip from "jszip"
import { renderHwpxPages } from "../src/render/index.js"
import { markdownToHwpx } from "../src/hwpx/generator.js"

// 표를 담은 문단(문단 모양 0)에 왼쪽 여백 1500 을 주고, 표 가로 기준을 문단(PARA)·단(COLUMN)으로 바꿔 왼쪽 세로선 x 를 잰다
async function leftEdge(rel: "PARA" | "COLUMN"): Promise<number> {
  const zip = await JSZip.loadAsync(await markdownToHwpx("앞 문단\n\n| 머리 |\n|---|\n| 칸 |"))
  const secName = Object.keys(zip.files).find(f => /section0\.xml$/.test(f))!, hdrName = Object.keys(zip.files).find(f => /header\.xml$/.test(f))!
  const sec = await zip.file(secName)!.async("string"), hdr = await zip.file(hdrName)!.async("string")
  zip.file(secName, sec.replace(/(<hp:tbl [\s\S]*?<hp:pos [^>]*?)horzRelTo="\w+"/, `$1horzRelTo="${rel}"`))
  zip.file(hdrName, hdr.replace(/(<hh:paraPr id="0"[\s\S]*?<hc:left value=")0"/, '$11500"'))
  const r = await renderHwpxPages(new Uint8Array(await zip.generateAsync({ type: "nodebuffer" })), { reflow: true })
  const xs = [...r.pageSvgs.get(1)!.matchAll(/<line x1="([-\d.]+)" y1="([-\d.]+)" x2="([-\d.]+)" y2="([-\d.]+)"/g)].filter(m => m[1] === m[3]).map(m => +m[1])
  return Math.min(...xs)
}

describe("render: 문단 기준 가로 위치", () => {
  it("horzRelTo PARA 개체는 문단 왼쪽 여백만큼 오른쪽 — 단 기준은 그대로", async () => {
    const para = await leftEdge("PARA"), col = await leftEdge("COLUMN")
    assert.ok(Math.abs(para - col - 15) < 0.1, `${para} vs ${col}`)
  })
})
