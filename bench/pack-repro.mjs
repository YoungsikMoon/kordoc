#!/usr/bin/env node
/**
 * 기관팩 재현율 — 처음 보는 문서를 같은 기관 다른 문서로 만든 팩으로 얼마나 재현하나 (하나 빼고 만들기, leave-one-out).
 * 문서마다: 그 문서를 뺀 나머지로 팩을 만들고(buildAgencyPack) 그 문서의 원고를 팩으로 생성해 원본과 서식을 대조한다(gen-repro 와
 * 같은 채점기 repro-lib). 대조군은 기관 서식 없이 쓰는 기본 보고서 프리셋, 상한은 그 문서 자신을 견본으로 쓴 것.
 *
 * 사용: node bench/pack-repro.mjs [--set=seoul-bangchim] [--dir=<HWPX 폴더>] [--privacy] [--verbose]
 *   --privacy : 재현 대신 견본마다 팩을 만들어 원문 사람 정보·본문 글이 남는지 점검 (남으면 exit 1)
 *   --set : bench/corpus-gen/<set> — 케이스(.repro.json)의 원고·본문 시작 글을 쓰고, 팩은 폴더의 모든 원본 HWPX 에서 그 문서를 빼고 만든다
 *   --dir : 원고가 없는 폴더 — 문서마다 kordoc 이 읽은 마크다운(parse)을 원고로 쓴다(에이전트가 견본을 읽고 다시 쓰는 흐름)
 */
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs"
import { join, dirname, basename } from "node:path"
import { fileURLToPath } from "node:url"
import { markdownToHwpx, parse, buildAgencyPack, loadAgencyPack, packTemplate } from "../dist/index.js"
import { scoreRepro } from "./repro-lib.mjs"

const root = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const opt = (k) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3)
const verbose = args.includes("--verbose")
const set = opt("set") ?? (opt("dir") ? null : "seoul-bangchim")
const dir = set ? join(root, "corpus-gen", set) : opt("dir")
if (!dir || !existsSync(dir)) { console.error(`폴더가 없습니다: ${dir}`); process.exit(1) }

const docs = readdirSync(dir).filter((f) => /\.hwpx$/i.test(f)).sort()
const bytes = Object.fromEntries(docs.map((f) => [f, readFileSync(join(dir, f))]))
// 케이스 — set 은 .repro.json(원고·본문 시작), dir 은 문서마다 parse 한 마크다운
const cases = []
if (set) {
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".repro.json")).sort()) {
    const c = JSON.parse(readFileSync(join(dir, f), "utf8"))
    cases.push({ name: f.replace(/\.repro\.json$/, ""), hwpx: c.hwpx, md: readFileSync(join(dir, c.md), "utf8"), from: c.from ?? null })
  }
} else {
  for (const f of docs) {
    const r = await parse(new Uint8Array(bytes[f]))
    if (r.success && r.markdown.trim()) cases.push({ name: basename(f, ".hwpx"), hwpx: f, md: r.markdown, from: null })
  }
}

/**
 * 개인정보 점검 — 견본마다 팩을 만들어, 견본의 사람 정보(☎ 번호·"직위 : 이름" 의 이름)와 본문 글 조각(8자 이상)이 팩 견본에 남는지 본다.
 * 남으면 실패로 센다(팩은 남에게 건네는 파일이다)
 */
async function privacyLeaks(hwpx) {
  const { pack } = await buildAgencyPack("점검", [{ data: new Uint8Array(hwpx) }])
  const JSZip = (await import("jszip")).default
  const tpl = await (await JSZip.loadAsync(pack)).file("kinds/report.hwpx").async("uint8array")
  const z = await JSZip.loadAsync(tpl)
  let all = ""
  for (const n of Object.keys(z.files)) if (/\.(xml|hpf|txt)$/i.test(n)) all += await z.file(n).async("string")
  const src = (await parse(new Uint8Array(hwpx))).markdown
  const people = [...src.matchAll(/(?:과장|팀장|국장|실장|주무관|담당자?|본부장|센터장)\s*[:：]\s*([가-힣]{2,4})/g)].map((m) => m[1])
    .concat([...src.matchAll(/☎\s*([\d-]{4,})/g)].map((m) => m[1]))
  const body = [...new Set(src.split(/\n+/).map((l) => l.replace(/[#>*|\-□ㅇ○◦·※\s]+/g, "")).filter((l) => l.length >= 8).map((l) => l.slice(0, 8)))]
  return [...people.filter((p) => all.includes(p)), ...body.filter((b) => all.replace(/<[^>]+>/g, "").replace(/\s+/g, "").includes(b))]
}
if (args.includes("--privacy")) {
  let bad = 0
  for (const f of docs) {
    const leaks = await privacyLeaks(bytes[f])
    if (leaks.length) bad++
    console.log(`${f}: ${leaks.length ? `✗ 남은 원문 ${leaks.length} — ${leaks.slice(0, 5).join(" / ")}` : "✓ 남은 원문 없음"}`)
  }
  console.log(`개인정보 점검: ${docs.length - bad}/${docs.length} 통과`)
  process.exit(bad ? 1 : 0)
}

const pct = (r) => (r.props * 100).toFixed(1)
const det = (r) => (100 * r.groups.결정적.ok / Math.max(1, r.groups.결정적.n)).toFixed(1)
const rows = []
for (const c of cases) {
  const gt = bytes[c.hwpx]
  const others = docs.filter((f) => f !== c.hwpx)
  const { pack, manifest } = await buildAgencyPack("벤치", others.map((f) => ({ data: new Uint8Array(bytes[f]) })))
  const tpl = packTemplate(await loadAgencyPack(pack))
  const gen = async (o) => Buffer.from(await markdownToHwpx(c.md, o))
  const base = scoreRepro(gt, await gen({ gongmun: { preset: "report", cover: false, toc: false } }), c.from)
  const viaPack = scoreRepro(gt, await gen({ template: tpl }), c.from)
  const self = scoreRepro(gt, await gen({ template: new Uint8Array(gt) }), c.from)
  const k = manifest.kinds.report
  rows.push({ name: c.name, base: base.props, pack: viaPack.props, self: self.props, baseDet: base.groups.결정적, packDet: viaPack.groups.결정적, selfDet: self.groups.결정적, chosen: others[k.chosen], drift: k.drift })
  console.log(`${c.name}: 기본 보고서 ${pct(base)}% (결정 ${det(base)}) · 팩 ${pct(viaPack)}% (결정 ${det(viaPack)}) · 자기 견본 ${pct(self)}% (결정 ${det(self)}) — 대표 ${others[k.chosen]}${k.drift.length ? ` ⚠ ${k.drift.join(",")}` : ""}`)
  if (verbose) for (const b of viaPack.bad.slice(0, 30)) console.log("    " + b)
}
const mean = (k) => rows.reduce((a, r) => a + r[k], 0) / Math.max(1, rows.length)
console.log(`평균 (${rows.length}건) · 기본 보고서 ${(mean("base") * 100).toFixed(1)}% · 기관팩 ${(mean("pack") * 100).toFixed(1)}% · 자기 견본(상한) ${(mean("self") * 100).toFixed(1)}%`)
writeFileSync(join(root, "out", "pack-repro.json"), JSON.stringify({ generatedAt: new Date().toISOString(), dir: set ?? dir, rows }, null, 1))
