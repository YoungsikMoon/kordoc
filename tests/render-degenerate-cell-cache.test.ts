import { describe, it } from "node:test"
import assert from "node:assert/strict"
import JSZip from "jszip"
import { renderHwpxPages } from "../src/render/index.js"
import { markdownToHwpx } from "../src/hwpx/generator.js"

describe("render: 칸 안 줄이 모두 같은 vertpos 인 캐시", () => {
  it("줄마다 쪽을 넘기지 않고 그 칸을 다시 조판한다", async () => {
    const zip = await JSZip.loadAsync(await markdownToHwpx("| 머리 |\n|---|\n| 자리 |"))
    const name = Object.keys(zip.files).find(n => /section0\.xml$/.test(n))!
    let sec = await zip.file(name)!.async("string")
    const k = sec.indexOf("자리"), a = sec.lastIndexOf("<hp:p ", k), b = sec.indexOf("</hp:p>", k) + "</hp:p>".length
    const p = sec.slice(a, b).replace(/<hp:linesegarray>[\s\S]*?<\/hp:linesegarray>/, "")
    // 줄이 나아가지 않은 캐시 — 칸 문단 넷이 모두 vertpos 0
    const para = (t: string) => p.replace("자리", t).replace("</hp:p>", `<hp:linesegarray><hp:lineseg textpos="0" vertpos="0" vertsize="1000" textheight="1000" baseline="850" spacing="600" horzpos="0" horzsize="40000" flags="393216"/></hp:linesegarray></hp:p>`)
    sec = sec.slice(0, a) + ["첫째", "둘째", "셋째", "넷째"].map(para).join("") + sec.slice(b)
    zip.file(name, sec)
    const r = await renderHwpxPages(new Uint8Array(await zip.generateAsync({ type: "nodebuffer" })))
    assert.equal(r.pageSvgs.size, 1)
    const ys = ["첫째", "둘째", "셋째", "넷째"].map(t => Number(/<text x="[-\d.]+" y="([-\d.]+)"[^>]*>([^<]+)</.exec([...r.pageSvgs.get(1)!.matchAll(/<text x="[-\d.]+" y="[-\d.]+"[^>]*>[^<]+</g)].map(m => m[0]).find(s => s.includes(t))!)![1]))
    assert.ok(ys.every((y, i) => i === 0 || y > ys[i - 1]), ys.join(","))
  })
})
