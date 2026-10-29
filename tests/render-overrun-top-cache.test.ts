import { describe, it } from "node:test"
import assert from "node:assert/strict"
import JSZip from "jszip"
import { renderHwpxPages } from "../src/render/index.js"
import { markdownToHwpx } from "../src/hwpx/generator.js"

describe("render: 쪽으로 되돌아가지 않는 최상위 줄 캐시", () => {
  it("본문 높이를 크게 넘는 자리까지 이어진 캐시는 버리고 다시 조판해 쪽을 나눈다", async () => {
    const md = Array.from({ length: 80 }, (_, i) => `문단 ${i + 1}`).join("\n\n")
    const zip = await JSZip.loadAsync(await markdownToHwpx(md))
    const name = Object.keys(zip.files).find(n => /section0\.xml$/.test(n))!
    let sec = await zip.file(name)!.async("string")
    // 한컴이 아닌 도구가 쓴 캐시 — 문단마다 1600 씩 늘기만 하고 쪽마다 0 으로 되돌아가지 않는다
    let i = 0
    sec = sec.replace(/<hp:linesegarray>[\s\S]*?<\/hp:linesegarray>/g, "").replace(/<\/hp:run><\/hp:p>/g, () =>
      `</hp:run><hp:linesegarray><hp:lineseg textpos="0" vertpos="${1600 * i++}" vertsize="1000" textheight="1000" baseline="850" spacing="600" horzpos="0" horzsize="40000" flags="393216"/></hp:linesegarray></hp:p>`)
    zip.file(name, sec)
    const r = await renderHwpxPages(new Uint8Array(await zip.generateAsync({ type: "nodebuffer" })))
    assert.ok(r.pageSvgs.size >= 2, `쪽 ${r.pageSvgs.size}`)
    for (const svg of r.pageSvgs.values()) for (const m of svg.matchAll(/<text x="[-\d.]+" y="([-\d.]+)"/g)) assert.ok(Number(m[1]) < 842, `쪽 밖 글 y ${m[1]}`)
  })
})
