/** kordoc CLI 명령 — 변환 — to-hwpx */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs"
import { dirname, resolve } from "path"
import { Command } from "commander"
import { sanitizeError, KordocError } from "../utils.js"

export function registerConvertCommands(program: Command): void {
  program
    .command("to-hwpx <file>")
    .description("HWP 문서를 HWPX 로 변환 — HWP 5.x 는 서식 그대로(글꼴·문단 모양·표·그림·도형·수식·머리말·각주·차트 …), HWP 3.x 는 글·표만")
    .option("-o, --output <path>", "저장 경로 (기본: 입력과 같은 이름의 .hwpx — 그 파일이 이미 있으면 덮어쓰지 않고 멈춘다)")
    .option("--password <pw>", "암호로 보호된 HWP 의 열기 암호")
    .option("--json", "결과 요약을 JSON 으로 stdout 에 출력")
    .action(async (file: string, opts) => {
      try {
        const { convertToHwpx, validateHwpx } = await import("../index.js")
        // 루트 커맨드의 동명 옵션(-o/--password)이 서브커맨드 옵션을 가로채는 commander 동작 보완
        const rootOpts = program.opts()
        const output: string | undefined = opts.output ?? rootOpts.output
        const password: string | undefined = opts.password ?? rootOpts.password
        const input = resolve(file)
        const out = resolve(output ?? input.replace(/\.(hwp|hml)$/i, "") + ".hwpx")
        if (out === input) throw new KordocError("출력 경로가 입력 파일과 같습니다 — -o 로 다른 경로를 지정하세요")
        // 같은 이름 .hwpx 는 한글로 따로 저장해 둔 문서일 수 있다 — 기본 경로로는 덮어쓰지 않는다
        if (!output && existsSync(out)) throw new KordocError(`${out} 이(가) 이미 있습니다 — 덮어쓰려면 -o 로 경로를 직접 지정하세요`)
        const result = await convertToHwpx(new Uint8Array(readFileSync(input)), { password })
        const check = await validateHwpx(result.data)
        mkdirSync(dirname(out), { recursive: true })
        writeFileSync(out, result.data)
        if (opts.json) {
          process.stdout.write(JSON.stringify({ output: out, mode: result.mode, bytes: result.data.length, valid: check.ok, warnings: result.warnings }, null, 2) + "\n")
        } else {
          process.stderr.write(`[kordoc] ${result.mode === "preserve" ? "서식 그대로" : "글·표만"} 변환: ${out} (${result.data.length.toLocaleString()} 바이트)\n`)
          for (const w of result.warnings) process.stderr.write(`[kordoc] ⚠️ ${w}\n`)
          if (!check.ok) for (const i of check.issues) process.stderr.write(`[kordoc] ✗ ${i.path ? `${i.path}: ` : ""}${i.message}\n`)
        }
        if (!check.ok) process.exit(1)
      } catch (err) {
        process.stderr.write(`[kordoc] 오류: ${sanitizeError(err)}\n`)
        process.exit(2)
      }
    })
}
