/**
 * COM 폴백 PowerShell — 한컴 보안 승인 모듈 등록 인수
 *
 * RegisterModule 의 첫 인수(모듈 종류)는 한컴 오토메이션이 정한 'FilePathCheckDLL' 이어야 한다.
 * 다른 이름이면 DLL 을 레지스트리에 등록해 둔 환경에서도 늘 False 라 접근 확인 창 억제가 걸리지 않는다.
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

describe("COM 폴백 — 보안 승인 모듈 등록", () => {
  it("RegisterModule 은 모듈 종류 'FilePathCheckDLL' 로 부른다", async () => {
    const { comPowerShellInvocation } = await import("../src/hwpx/com-fallback.js")
    const { args } = comPowerShellInvocation("C:\\in\\a.hwpx")
    const script = args[args.length - 1]
    assert.ok(script.includes("$hwp.RegisterModule('FilePathCheckDLL', 'FilePathCheckerModuleExample')"), script)
    assert.ok(!script.includes("RegisterModule('FilePathCheckerModule'"))
  })
  it("임시 폴더 만들기·복사는 try 안에 있어 실패해도 finally 가 지운다 (#177)", async () => {
    const { comPowerShellInvocation } = await import("../src/hwpx/com-fallback.js")
    const script = comPowerShellInvocation("C:\\in\\a.hwpx").args.at(-1)!
    const tryAt = script.indexOf("try {")
    assert.ok(tryAt > 0 && tryAt < script.indexOf("New-Item -ItemType Directory"), script)
    assert.ok(tryAt < script.indexOf("Copy-Item -LiteralPath"), script)
    assert.ok(script.indexOf("$tmpDir = Join-Path") < tryAt, "finally 가 쓸 경로는 try 앞에서 정한다")
  })
  it("벤치 한컴 PDF 스크립트도 같은 종류 이름을 쓴다", () => {
    const ps1 = readFileSync(new URL("../bench/hangul-com-pdf.ps1", import.meta.url), "utf8")
    assert.ok(ps1.includes("RegisterModule('FilePathCheckDLL', 'FilePathCheckerModuleExample')"))
  })
})
