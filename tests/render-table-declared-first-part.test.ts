import { describe, it } from "node:test"
import assert from "node:assert/strict"
import JSZip from "jszip"
import { renderHwpxPages } from "../src/render/index.js"
import { markdownToHwpx } from "../src/hwpx/generator.js"

describe("render: 표 sz 에 적힌 첫 쪽 조각", () => {
  it("sz 가 첫 쪽 안쪽 행 경계와 맞으면 뒤 행이 이 쪽에 들어도 그 행부터 다음 쪽", async () => {
    const md = Array.from({ length: 36 }, (_, i) => `문단 ${i + 1}`).join("\n\n") + "\n\n| 머리 |\n|---|\n| 둘째 |\n| 셋째 |"
    const zip = await JSZip.loadAsync(await markdownToHwpx(md))
    const name = Object.keys(zip.files).find(f => /section0\.xml$/.test(f))!
    let sec = await zip.file(name)!.async("string")
    // 셋째 행을 100pt 로 키워 표가 쪽을 넘게 하고, sz 는 첫 행 높이(한컴이 첫 쪽 조각만 적은 저장본)
    const k = sec.indexOf("셋째"), a = sec.lastIndexOf("<hp:tc ", k), b = sec.indexOf("</hp:tc>", k)
    sec = sec.slice(0, a) + sec.slice(a, b).replace(/(<hp:cellSz width="\d+" height=")\d+"/, '$110000"') + sec.slice(b)
    sec = sec.replace(/(<hp:sz width="\d+" widthRelTo="ABSOLUTE" height=")\d+"/, '$11500"')
    zip.file(name, sec)
    const r = await renderHwpxPages(new Uint8Array(await zip.generateAsync({ type: "nodebuffer" })), { reflow: true })
    const page = (t: string) => [...r.pageSvgs].find(([, s]) => s.includes(`>${t}<`))?.[0]
    assert.equal(page("머리"), 1)
    assert.equal(page("둘째"), 2)
  })
})
