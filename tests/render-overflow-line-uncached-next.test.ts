import { describe, it } from "node:test"
import assert from "node:assert/strict"
import JSZip from "jszip"
import { renderHwpxPages } from "../src/render/index.js"
import { markdownToHwpx } from "../src/hwpx/generator.js"

const seg = (v: number) => `<hp:linesegarray><hp:lineseg textpos="0" vertpos="${v}" vertsize="1000" textheight="1000" baseline="850" spacing="600" horzpos="0" horzsize="40000" flags="393216"/></hp:linesegarray>`

describe("render: 쪽 바닥을 넘친 캐시 줄 뒤 줄 정보 없는 문단", () => {
  it("넘친 줄은 다음 쪽 맨 위, 뒤 문단은 그 아래 — 넘친 줄을 앞 쪽 밖에 두고 뒤 문단을 새 쪽 맨 위에 겹치지 않는다", async () => {
    const zip = await JSZip.loadAsync(await markdownToHwpx("앞글\n\n넘침\n\n다음"))
    const name = Object.keys(zip.files).find(n => /section0\.xml$/.test(n))!
    let sec = (await zip.file(name)!.async("string")).replace(/<hp:linesegarray>[\s\S]*?<\/hp:linesegarray>/g, "")
    // 앞글 0, 넘침은 본문 높이 밖 90000(줄 위부터 쪽 밖), 다음은 줄 정보 없음
    const v: Record<string, number> = { 앞글: 0, 넘침: 90000 }
    sec = sec.replace(/<hp:t>(앞글|넘침)<\/hp:t>([\s\S]*?)<\/hp:run><\/hp:p>/g, (m, t: string) => m.replace(/<\/hp:run><\/hp:p>$/, `</hp:run>${seg(v[t])}</hp:p>`))
    zip.file(name, sec)
    const r = await renderHwpxPages(new Uint8Array(await zip.generateAsync({ type: "nodebuffer" })), { reflow: true })
    const svgOf = (t: string) => [...r.pageSvgs].filter(([, svg]) => svg.includes(`>${t}<`))
    assert.deepEqual(svgOf("넘침").map(([n]) => n), [2])
    assert.deepEqual(svgOf("다음").map(([n]) => n), [2])
    const y = (svg: string, t: string) => Number(svg.slice(0, svg.indexOf(`>${t}<`)).match(/y="([\d.]+)"[^>]*$/)?.[1])
    const p2 = svgOf("다음")[0][1]
    assert.ok(y(p2, "다음") - y(p2, "넘침") > 10, "다음 문단은 넘친 줄 아래")
  })
})
