import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { createXmlParser } from "../src/hwpx/parser-shared.js"
import { footNoteStories } from "../src/render/page-stories.js"

const ns = 'xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section"'
const note = (n: number) => `<hp:ctrl><hp:footNote number="${n}"><hp:subList><hp:p><hp:run><hp:t>각주${n}</hp:t></hp:run><hp:linesegarray><hp:lineseg textpos="0" vertpos="0" vertsize="900" textheight="900" baseline="765" spacing="0" horzpos="0" horzsize="9000"/></hp:linesegarray></hp:p></hp:subList></hp:footNote></hp:ctrl>`
const seg = (tp: number, v: number) => `<hp:lineseg textpos="${tp}" vertpos="${v}" vertsize="1000" textheight="1000" baseline="850" spacing="600" horzpos="0" horzsize="9000"/>`

describe("render: 쪽에 걸친 문단의 각주", () => {
  it("각주는 참조 글자가 든 줄의 쪽 아래에 놓는다", () => {
    // 첫 줄(글자 0~3)은 1쪽 바닥, 둘째 줄(글자 4~)은 2쪽 맨 위 — 각주1 은 첫 줄, 각주2 는 둘째 줄
    const root = createXmlParser().parseFromString(`<hs:sec ${ns}><hp:p><hp:run><hp:t>가나</hp:t>${note(1)}<hp:t>다라마</hp:t>${note(2)}<hp:t>바</hp:t></hp:run>` +
      `<hp:linesegarray>${seg(0, 68000)}${seg(4, 0)}</hp:linesegarray></hp:p></hs:sec>`, "text/xml").documentElement as unknown as Element
    const p = root.getElementsByTagName("hp:p")[0] as unknown as Element
    const { stories } = footNoteStories(root, new Map([[p, [0, 1]]]), { ML: 0, MT: 0, BODY_W: 10000, BODY_H: 70000 })
    assert.deepEqual(stories.map(s => s.page), [0, 1])
  })
})
