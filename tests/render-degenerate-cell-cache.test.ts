import { describe, it } from "node:test"
import assert from "node:assert/strict"
import JSZip from "jszip"
import { renderHwpxPages } from "../src/render/index.js"
import { markdownToHwpx } from "../src/hwpx/generator.js"

describe("render: 칸 안 줄이 모두 같은 vertpos 인 캐시", () => {
  for (const [what, vps] of [["모두 0", [0, 0, 0, 0]], ["0 다음 연달아 셋이 0", [1600, 0, 0, 0]]] as const) it(`줄마다 쪽을 넘기지 않고 그 칸을 다시 조판한다 — ${what}`, async () => {
    const zip = await JSZip.loadAsync(await markdownToHwpx("| 머리 |\n|---|\n| 자리 |"))
    const name = Object.keys(zip.files).find(n => /section0\.xml$/.test(n))!
    let sec = await zip.file(name)!.async("string")
    const k = sec.indexOf("자리"), a = sec.lastIndexOf("<hp:p ", k), b = sec.indexOf("</hp:p>", k) + "</hp:p>".length
    const p = sec.slice(a, b).replace(/<hp:linesegarray>[\s\S]*?<\/hp:linesegarray>/, "")
    // 줄이 나아가지 않은 캐시 — 칸 문단 넷이 모두 vertpos 0
    const para = (t: string, i: number) => p.replace("자리", t).replace("</hp:p>", `<hp:linesegarray><hp:lineseg textpos="0" vertpos="${vps[i]}" vertsize="1000" textheight="1000" baseline="850" spacing="600" horzpos="0" horzsize="40000" flags="393216"/></hp:linesegarray></hp:p>`)
    sec = sec.slice(0, a) + ["첫째", "둘째", "셋째", "넷째"].map(para).join("") + sec.slice(b)
    zip.file(name, sec)
    const r = await renderHwpxPages(new Uint8Array(await zip.generateAsync({ type: "nodebuffer" })))
    assert.equal(r.pageSvgs.size, 1)
    const ys = ["첫째", "둘째", "셋째", "넷째"].map(t => Number(/<text x="[-\d.]+" y="([-\d.]+)"[^>]*>([^<]+)</.exec([...r.pageSvgs.get(1)!.matchAll(/<text x="[-\d.]+" y="[-\d.]+"[^>]*>[^<]+</g)].map(m => m[0]).find(s => s.includes(t))!)![1]))
    assert.ok(ys.every((y, i) => i === 0 || y > ys[i - 1]), ys.join(","))
  })
})

describe("render: 글 높이가 글자 크기와 맞지 않는 칸 캐시", () => {
  it("글만 든 칸 문단의 줄 글 높이가 글자 크기의 1.5배를 넘으면 그 칸을 다시 조판한다", async () => {
    const zip = await JSZip.loadAsync(await markdownToHwpx("| 머리 |\n|---|\n| 자리 |"))
    const name = Object.keys(zip.files).find(n => /section0\.xml$/.test(n))!
    const sec = await zip.file(name)!.async("string")
    const k = sec.indexOf("자리"), b = sec.indexOf("</hp:p>", k)
    const yOf = async (th: number, base: number) => {
      zip.file(name, sec.slice(0, b) + `<hp:linesegarray><hp:lineseg textpos="0" vertpos="0" vertsize="${th}" textheight="${th}" baseline="${base}" spacing="600" horzpos="0" horzsize="40000" flags="393216"/></hp:linesegarray>` + sec.slice(b))
      const r = await renderHwpxPages(new Uint8Array(await zip.generateAsync({ type: "nodebuffer" })), { reflow: true })
      return Number(/<text x="[-\d.]+" y="([-\d.]+)"[^>]*>자리</.exec(r.pageSvgs.get(1)!)![1])
    }
    // 10pt 글에 글 높이 25pt 로 적힌 캐시(rhwp 시험 문서) — 캐시 없이 다시 짠 자리와 같아야 한다
    const bad = await yOf(2518, 1959)
    zip.file(name, sec)
    const r = await renderHwpxPages(new Uint8Array(await zip.generateAsync({ type: "nodebuffer" })), { reflow: true })
    const fresh = Number(/<text x="[-\d.]+" y="([-\d.]+)"[^>]*>자리</.exec(r.pageSvgs.get(1)!)![1])
    assert.ok(Math.abs(bad - fresh) < 0.5, `${bad} vs ${fresh}`)
  })
})
