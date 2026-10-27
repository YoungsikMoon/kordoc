#!/usr/bin/env node
/**
 * 공문서 생성 재현율 — 정답지(실제 결재문서 HWPX)의 글을 프리셋 규약 마크다운으로 옮겨 생성한 HWPX 가 정답지와 서식이
 * 얼마나 같은지 잰다. 문단을 글 순서로 짝지어(부호·공백을 뺀 글 LCS) 역할(□·ㅇ·-·※·*·장·제목·담당·요약·목차·표 칸)마다
 * 글꼴·크기·굵기·색·정렬·줄간격·문단 위/아래 간격을 대조한다. 정답지에서 짝을 못 찾은 문단은 누락, 생성본에만 있는 문단은 잉여.
 *
 * 사용: node bench/gen-repro.mjs [케이스 이름…] [--verbose]
 * 케이스: bench/corpus-gen/<set>/<이름>.repro.json — { "hwpx": "원본.hwpx", "md": "입력.md", "options": { gongmun: {…} },
 *         "from": "본문 시작 글(앞은 표지·점검표)" }
 * 정답지·입력 마크다운은 git 밖(corpus-gen) — 정보소통광장 결재문서.
 */
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { markdownToHwpx } from "../dist/index.js"
import { scoreRepro, printRow } from "./repro-lib.mjs"

const root = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const verbose = args.includes("--verbose")
const only = args.filter(a => !a.startsWith("--"))
const sets = ["seoul-bangchim"]

const rows = []
for (const set of sets) {
  const dir = join(root, "corpus-gen", set)
  if (!existsSync(dir)) continue
  for (const f of readdirSync(dir).filter(f => f.endsWith(".repro.json"))) {
    const name = f.replace(/\.repro\.json$/, "")
    if (only.length && !only.includes(name)) continue
    const c = JSON.parse(readFileSync(join(dir, f), "utf8"))
    const md = readFileSync(join(dir, c.md), "utf8")
    const row = { name, ...scoreRepro(readFileSync(join(dir, c.hwpx)), Buffer.from(await markdownToHwpx(md, c.options ?? {})), c.from) }
    rows.push(row)
    printRow(row, verbose)
  }
}
writeFileSync(join(root, "out", "gen-repro.json"), JSON.stringify({ generatedAt: new Date().toISOString(), rows }, null, 1))
