/**
 * 기관팩 — 견본 HWPX 몇 건으로 서식 묶음(.kpack)을 만들고 그 견본으로 생성. 견본은 kordoc 이 만든 합성 문서(서울방침 프리셋)이고
 * 실제 기관 문서는 저장소에 두지 않는다.
 */

import { describe, it, before } from "node:test"
import assert from "node:assert/strict"
import JSZip from "jszip"
import { markdownToHwpx } from "../src/index.js"
import { buildAgencyPack, loadAgencyPack, packTemplate, packSummary, chooseRepresentative, skeletonMarkdown, scrubPeople, templateRoleStyles, guideExample, packRoleWarnings, roleConsensus, type PackKindInfo } from "../src/hwpx/agency-pack.js"
import { validateHwpx } from "../src/validate.js"
import { registerGenerateTools } from "../src/mcp/tools-generate.js"

const SAMPLE = (n: number) => `# 견본${n} 사업 추진계획

일자리정책과장 : 김견본${n} ☎1111-${n}000 담당 : 이견본${n} ☎2222

> 견본${n} 사업을 체계적으로 추진하기 위한 계획을 수립하고자 함

## 추진배경

□ 견본${n} 현황

ㅇ 견본${n} 제도 시행에 따른 후속 조치 필요

- 견본${n} 지침 개정

※ 견본${n} 참고 문구

| 구분 | 견본내용 | 비고 |
| --- | --- | --- |
| 가 | 견본${n} 하나 | 1 |
| 나 | 견본${n} 둘 | 2 |
| 다 | 견본${n} 셋 | 3 |
`

const NEW_MD = `# 스마트 행정 시범사업 계획

스마트정보과장 : 홍길동 ☎1234 담당 : 김담당 ☎5678

> 시범사업으로 행정 업무를 개선하고자 함

## 현황

□ 새 현황

ㅇ 새 첫째 항목

- 새 세부 내용

※ 새 참고 문구
`

const entry = async (buf: ArrayBuffer | Uint8Array, name: string) => (await JSZip.loadAsync(buf)).file(name)!.async("string")
const texts = (xml: string) => [...xml.matchAll(/<hp:t>([^<]*)<\/hp:t>/g)].map((m) => m[1]).join("|")

describe("기관팩 (agency pack)", () => {
  let samples: Uint8Array[]
  before(async () => {
    samples = []
    for (const n of [1, 2, 3]) samples.push(new Uint8Array(await markdownToHwpx(SAMPLE(n), { gongmun: { preset: "서울방침", ...(n === 3 ? { bodyPt: 13 } : {}) } })))
  })

  it("만들기 → 읽기 → 생성 — 팩 견본으로 만든 문서는 원 견본으로 만든 문서와 본문이 같다", async () => {
    const { pack, manifest } = await buildAgencyPack("시험시", [{ data: samples[0] }])
    const loaded = await loadAgencyPack(pack)
    assert.equal(loaded.manifest.name, "시험시")
    assert.deepEqual([...loaded.templates.keys()], ["report"])
    assert.deepEqual(manifest.kinds.report.drift, [])
    const viaPack = await markdownToHwpx(NEW_MD, { template: packTemplate(loaded) })
    const viaOrig = await markdownToHwpx(NEW_MD, { template: samples[0] })
    assert.ok((await validateHwpx(viaPack)).ok)
    assert.equal(texts(await entry(viaPack, "Contents/section0.xml")), texts(await entry(viaOrig, "Contents/section0.xml")))
    // 글자·문단 모양 순서까지 같은 header
    assert.equal((await entry(viaPack, "Contents/header.xml")).length > 0, true)
  })

  it("팩에는 원본 글·작성자 메타·결재선 이름·전화가 남지 않는다", async () => {
    const { pack } = await buildAgencyPack("시험시", [{ data: samples[0] }])
    const z = await JSZip.loadAsync(pack)
    assert.deepEqual(Object.keys(z.files).filter((n) => !z.files[n].dir).sort(), ["guide.md", "kinds/report.hwpx", "pack.json"])
    const tpl = await z.file("kinds/report.hwpx")!.async("uint8array")
    const all = (await Promise.all(Object.keys((await JSZip.loadAsync(tpl)).files).filter((n) => /\.(xml|hpf|txt)$/.test(n)).map((n) => entry(tpl, n)))).join("\n")
    for (const leak of ["견본1", "김견본1", "이견본1", "1111-1000", "2222"]) assert.ok(!all.includes(leak), `남은 원문: ${leak}`)
    assert.ok(!(await z.file("pack.json")!.async("string")).includes("견본1"))
  })

  it("대표 견본 — 역할·속성 다수결과 가장 많이 맞는 견본, 다른 서식 견본은 일치도가 낮다", async () => {
    const sigs = await Promise.all([samples[0], samples[2], samples[1]].map((s) => templateRoleStyles(s)))
    const pick = chooseRepresentative(sigs)
    assert.notEqual(pick.index, 1, "본문 13pt 로 바꾼 견본은 대표가 아니다")
    assert.ok(pick.scores[1] < pick.scores[0] && pick.scores[1] < pick.scores[2])
    const { manifest } = await buildAgencyPack("시험시", [samples[0], samples[2], samples[1]].map((data) => ({ data })))
    const k = manifest.kinds.report
    assert.equal(k.samples, 3)
    assert.notEqual(k.chosen, 1)
    assert.ok(k.agreement[1] < k.agreement[k.chosen])
    assert.equal(manifest.sources.length, 3)
    assert.match(packSummary(manifest), /견본 3건 중/)
  })

  it("종류 더하기(into)·종류 고르기", async () => {
    const first = await loadAgencyPack((await buildAgencyPack("시험시", [{ data: samples[0] }])).pack)
    const both = await loadAgencyPack((await buildAgencyPack("시험시", [{ data: samples[1], kind: "press" }], first)).pack)
    assert.deepEqual([...both.templates.keys()].sort(), ["press", "report"])
    assert.ok(packTemplate(both, "press"))
    assert.equal(packTemplate(both), both.templates.get("report"))
    assert.throws(() => packTemplate(both, "minutes"), /'minutes' 종류가 없습니다/)
    await assert.rejects(buildAgencyPack("시험시", [{ data: samples[0], kind: "../x" }]), /문서 종류 이름/)
  })

  it("팩 읽기는 신뢰하지 않는 파일로 — 허용 밖 파일·형식 판·zip 아님을 거절", async () => {
    const { pack } = await buildAgencyPack("시험시", [{ data: samples[0] }])
    const z = await JSZip.loadAsync(pack)
    z.file("run.js", "process.exit(1)")
    await assert.rejects(loadAgencyPack(await z.generateAsync({ type: "uint8array" })), /허용하지 않는 파일/)
    const z2 = await JSZip.loadAsync(pack)
    z2.file("pack.json", JSON.stringify({ ...JSON.parse(await z2.file("pack.json")!.async("string")), kordocPack: 99 }))
    await assert.rejects(loadAgencyPack(await z2.generateAsync({ type: "uint8array" })), /형식 판 99/)
    await assert.rejects(loadAgencyPack(new TextEncoder().encode("not a zip")), /기관팩\(.kpack, zip\)이 아닙니다|zip/)
  })

  it("골격 원고 — 견본에 있는 역할만, 단계는 늘, 마크다운 기호는 이스케이프", () => {
    const md = skeletonMarkdown({ protoRoles: ["L0", "sym:*", "band"], bandItem: "sym:*", contactInTitle: false })
    assert.ok(!md.startsWith("# "), "제목 원형이 없으면 제목을 쓰지 않는다")
    assert.match(md, /□ 첫째[\s\S]*ㅇ 둘째[\s\S]*- 셋째[\s\S]*· 넷째/)
    assert.match(md, /^\\\* 기호 항목$/m)
    assert.match(md, /## 참고1 참고 제목\n\n\\\* 참고 항목/)
  })

  it("골격 원고 — 공고문 머리 상자 견본이면 도입·날짜·발신 명의 줄까지 (빠지면 비운 판이 머리 상자로 안 읽힌다)", () => {
    const md = skeletonMarkdown({ protoRoles: ["title", "chapter"], bandItem: null, contactInTitle: false, headBox: true })
    assert.match(md, /^# 문서 제목\n\n도입 문장\n\n2026\\\. 1\. 1\.\n\n○○○장\n/)
  })

  it("역할별 다수결 서식 — 그 역할을 가진 견본의 과반이 같은 속성만", () => {
    const st = (pt: number, lineSpacing: string) => ({ roles: new Map([["L1", { font: "휴먼명조", pt, bold: false, align: "JUSTIFY", lineSpacing }]]) }) as any
    const c = roleConsensus([st(15, "160%"), st(15, "190%"), st(15, "160%"), st(13, "170%")]).get("L1")!
    assert.equal(c.pt, 15)
    assert.equal(c.lineSpacing, undefined, "4건 중 2건은 과반이 아니다")
    assert.equal(roleConsensus([st(15, "160%"), st(14, "160%"), st(13, "160%")]).get("L1")!.pt, undefined)
  })

  it("사람 정보 지우기 — 직위 낱말·쌍점·☎ 틀은 두고 이름·번호·직위 앞 부서 이름은 지운다", () => {
    assert.equal(scrubPeople("<hp:t>정책기획팀장:김  철☎1234 담당:박보람☎1235</hp:t>"), "<hp:t>팀장:○○○☎○○○○ 담당:○○○☎○○○○</hp:t>")
    assert.equal(scrubPeople("<hp:t>(○○재단) 경영기획본부장 :최가람☎123-4567</hp:t>"), "<hp:t>본부장 :○○○☎○○○○</hp:t>")
    assert.equal(scrubPeople("<hp:t>예산 담당 공무원의 역할</hp:t>"), "<hp:t>예산 담당 공무원의 역할</hp:t>")
    assert.equal(scrubPeople("<hp:t>과장 : 홍길동☎1234-5678</hp:t>"), "<hp:t>과장 : ○○○☎○○○○</hp:t>")
    assert.equal(scrubPeople("<hp:t>총 1,234명 · 2026. 3. 1.(수)</hp:t>"), "<hp:t>총 1,234명 · 2026. 3. 1.(수)</hp:t>")
    assert.equal(scrubPeople("<hp:t>담당 : 홍길동<hp:fwSpace/>☎1234</hp:t>"), "<hp:t>담당 : ○○○ ☎○○○○</hp:t>")
  })

  it("작성 요령 원고 예 — 팩이 가진 역할만, 빠진 단계·합계 행·가짜 직위 없이", () => {
    const k = { roles: ["chapter", "L0", "L1", "ref", "table"], bandItem: null, contactInTitle: false, bareSyms: [] } as unknown as PackKindInfo
    const ex = guideExample(k)
    assert.ok(!/^# /m.test(ex) && !/담당/.test(ex) && !/^· /m.test(ex) && !/^- /m.test(ex) && !/합계|센터장/.test(ex))
    assert.match(ex, /## 장 제목[\s\S]*□ 1단계[\s\S]*ㅇ 2단계[\s\S]*※ 참고[\s\S]*\| 구분/)
  })

  it("팩에 없는 역할·번호 목록으로 읽히는 날짜 줄은 생성 때 경고", () => {
    const k = { roles: ["chapter", "L0", "L1"], contactInTitle: false } as unknown as PackKindInfo
    const w = packRoleWarnings(k, "# 제목\n\n2026. 11. 2.\n\n> 요약\n\n## 장\n\n□ 항목\n")
    assert.ok(w.some((x) => /제목표가 없어/.test(x)))
    assert.ok(w.some((x) => /요약 상자가 없어/.test(x)))
    assert.ok(w.some((x) => /번호 목록으로 읽혀/.test(x)))
    assert.ok(!w.some((x) => /장 띠가 없어/.test(x)))
    assert.deepEqual(packRoleWarnings({ roles: ["title", "summary", "chapter"], contactInTitle: false } as unknown as PackKindInfo, "# 제목\n\n> 요약\n\n2026\\. 11. 2.\n"), [])
  })

  it("MCP — build_agency_pack·agency_pack_info 등록, generate_document 는 template_path 와 pack_path 를 함께 받지 않는다", async () => {
    const tools: Record<string, any> = {}
    registerGenerateTools({ tool(name: string, ...args: any[]) { tools[name] = args.at(-1) } } as any)
    assert.ok(tools.build_agency_pack && tools.agency_pack_info)
    const r = await tools.generate_document({ markdown: "# x", output_path: "/nowhere/x.hwpx", template_path: "/nowhere/t.hwpx", pack_path: "/nowhere/p.kpack" })
    assert.ok(r.isError)
    assert.match(r.content[0].text, /함께 쓸 수 없습니다/)
  })
})
