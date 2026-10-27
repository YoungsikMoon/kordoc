/** kordoc CLI 명령 — 기관팩 — pack build·info */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs"
import { basename, dirname, resolve } from "path"
import { buildAgencyPack, loadAgencyPack, packSummary } from "../hwpx/agency-pack.js"
import { KordocError, sanitizeError } from "../utils.js"
import type { Command } from "commander"

export function registerPackCommands(program: Command): void {
  const pack = program.command("pack").description("기관팩 — 기관 문서(HWPX) 몇 건으로 서식 묶음(.kpack)을 만들고, kordoc generate --pack 으로 그 서식대로 새 문서를 만든다")

  pack
    .command("build <samples...>")
    .description("견본 HWPX 들로 기관팩 만들기 — kordoc pack build 보고서1.hwpx 보고서2.hwpx --name 광양시 -o 광양시.kpack")
    .requiredOption("--name <기관>", "기관 이름 (팩 이름)")
    .option("--kind <kind>", "이 견본들의 문서 종류 (기본 report — 보도자료는 press 처럼 종류마다 따로 만들어 --into 로 더한다)", "report")
    .option("--into <kpack>", "이미 있는 팩에 이 종류를 더한다(같은 종류면 바꾼다)")
    .option("-o, --output <path>", "출력 .kpack 경로 (기본: <기관>.kpack)")
    .option("--json", "결과를 JSON 으로 (pack.json 내용)")
    .action(async (samples: string[], opts: { name: string; kind: string; into?: string; output?: string; json?: boolean }) => {
      try {
        // -o 는 최상위 명령(kordoc 파일 -o)과 겹쳐 그쪽에 잡힐 수 있다 — 둘 다 본다
        const output: string | undefined = opts.output ?? program.opts().output
        const list = samples.map((f) => {
          if (!/\.hwpx$/i.test(f)) throw new KordocError(`견본은 HWPX 만 받습니다 — "${f}" (HWP 는 한글에서 .hwpx 로 저장, 이름에 빈칸이 있으면 따옴표로 묶기: --name "광양시 청년일자리과")`)
          if (!existsSync(resolve(f))) throw new KordocError(`견본 파일이 없습니다: ${f}`)
          return { data: readFileSync(resolve(f)), kind: opts.kind }
        })
        const into = opts.into ? await loadAgencyPack(readFileSync(resolve(opts.into))) : undefined
        const { pack: bytes, manifest } = await buildAgencyPack(opts.name, list, into)
        const out = resolve(output ?? opts.into ?? `${opts.name.trim()}.kpack`)
        if (!/\.kpack$/i.test(out)) throw new KordocError(`출력은 .kpack 이어야 합니다: ${out}`)
        if (samples.some((f) => resolve(f) === out)) throw new KordocError("출력 경로가 견본과 같습니다 — -o 로 .kpack 경로를 주세요")
        mkdirSync(dirname(out), { recursive: true })
        writeFileSync(out, bytes)
        if (opts.json) process.stdout.write(JSON.stringify({ output: out, manifest }, null, 2) + "\n")
        else process.stderr.write(`[kordoc] 기관팩 → ${out}\n${packSummary(manifest)}\n작성 요령: kordoc pack info "${out}" --guide\n`)
      } catch (err) {
        process.stderr.write(`[kordoc] ${sanitizeError(err)}\n`)
        process.exit(1)
      }
    })

  pack
    .command("info <kpack>")
    .description("기관팩 요약과 작성 요령 보기 — kordoc pack info 광양시.kpack --guide")
    .option("--guide", "작성 요령(guide.md) 전체를 출력")
    .option("--json", "pack.json 을 그대로")
    .action(async (file: string, opts: { guide?: boolean; json?: boolean }) => {
      try {
        const path = resolve(file)
        if (!existsSync(path)) throw new KordocError(`파일이 없습니다: ${file}`)
        const p = await loadAgencyPack(readFileSync(path))
        if (opts.json) process.stdout.write(JSON.stringify(p.manifest, null, 2) + "\n")
        else process.stdout.write(`${packSummary(p.manifest)}\n${opts.guide ? `\n${p.guide}\n` : ""}`)
      } catch (err) {
        process.stderr.write(`[kordoc] ${sanitizeError(err)}\n`)
        process.exit(1)
      }
    })
}
