/**
 * 부서 서식 견본 zip 읽기·새 문서 zip 묶기 (generate --template).
 *
 * 견본은 사용자가 준 신뢰할 수 없는 파일이다 — 파서(hwpx/parser.ts)와 같은 ZIP bomb 방어(중앙 디렉터리 사전 검사·
 * 실제 엔트리 수·엔트리별 해제 상한)를 걸고, 해제량은 모든 읽기가 한 예산을 나눠 쓴다. 엔트리 이름에 상위 경로(..)·
 * 절대 경로·역슬래시가 있으면 거절한다(새 zip 에 그대로 옮겨 적기 때문). section0·header 는 정규식으로 훑기 전에
 * DOM 으로 정형성을 확인한다 — 깨진 XML 에서 정규식이 끝까지 헤매지 않게.
 */

import JSZip from "jszip"
import { MAX_DECOMPRESS_SIZE, MAX_ZIP_ENTRIES, readZipEntry, createXmlParser } from "./parser-shared.js"
import { precheckZipSize, KordocError } from "../utils.js"
import { resolveSectionPaths } from "./zip-sections.js"
import { isEncryptedHwpx } from "./com-fallback.js"
import { escapeXml } from "./gen-ids.js"
import type { ParseWarning } from "../types.js"

/** 정규식으로 훑는 XML 의 크기 상한 — 실제 공문 section0 는 수 MB 이내 */
const MAX_XML = 32 * 1024 * 1024

export interface TemplateZip {
  zip: JSZip
  /** 구역 파일 경로 */
  sections: string[]
  /** 구역마다 XML (sections 순서, 깨진 뒤 구역은 빈 글) — 생성은 그중 본문 구역 하나만 쓴다(gen-from-template pickBodySection) */
  sectionXmls: string[]
  headerXml: string
  /** 바탕쪽 XML (개체 id·그림 참조 계산용) */
  masterXmls: string[]
  /** 모든 엔트리 읽기가 나눠 쓰는 해제 예산 */
  budget: { used: number }
}

async function readText(zip: JSZip, name: string, budget: { used: number }): Promise<string> {
  const s = await readZipEntry(zip.file(name)!, "text", budget.used)
  budget.used += s.length
  return s
}

/** DOCTYPE 금지 + DOM 정형성 확인 — 깨진 견본은 정규식 단계 전에 멈춘다 */
function assertWellFormed(xml: string, name: string): void {
  if (xml.length > MAX_XML) throw new KordocError(`견본 ${name} 이 너무 큽니다 (${(xml.length / 1048576).toFixed(1)}MB)`)
  if (/<!DOCTYPE/i.test(xml)) throw new KordocError(`견본 ${name} 에 DOCTYPE 이 있습니다 — 한글 저장본이 아닙니다`)
  const issues: ParseWarning[] = []
  createXmlParser(issues).parseFromString(xml, "text/xml")
  if (issues.some((w) => !/경고/.test(w.message))) throw new KordocError(`견본 ${name} XML 이 올바르지 않습니다: ${issues[0].message}`)
}

export async function loadTemplateZip(template: Uint8Array | ArrayBuffer): Promise<TemplateZip> {
  const buf = template instanceof Uint8Array ? template.buffer.slice(template.byteOffset, template.byteOffset + template.byteLength) as ArrayBuffer : template
  precheckZipSize(buf, MAX_DECOMPRESS_SIZE, MAX_ZIP_ENTRIES)
  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(buf)
  } catch {
    throw new KordocError("견본이 HWPX(zip)가 아닙니다 — 한글에서 .hwpx 로 저장한 파일을 쓰세요 (.hwp 는 kordoc 으로 먼저 변환)")
  }
  const names = Object.keys(zip.files)
  if (names.length > MAX_ZIP_ENTRIES) throw new KordocError("견본 ZIP 엔트리 수 초과 (ZIP bomb 의심)")
  const bad = names.find((n) => n.split("/").includes("..") || n.startsWith("/") || n.includes("\\") || /^[A-Za-z]:/.test(n))
  if (bad) throw new KordocError(`견본 ZIP 에 허용하지 않는 경로가 있습니다: ${bad.slice(0, 80)}`)
  const budget = { used: 0 }
  const manifest = zip.file("META-INF/manifest.xml")
  if (manifest && isEncryptedHwpx(await readText(zip, "META-INF/manifest.xml", budget))) {
    throw new KordocError("암호가 걸린 견본입니다 — 한글에서 암호를 풀고 저장한 파일을 쓰세요")
  }
  const sections = await resolveSectionPaths(zip)
  if (!sections.length || !zip.file(sections[0]) || !zip.file("Contents/header.xml")) {
    throw new KordocError("견본 HWPX 에 Contents/header.xml 또는 section0.xml 이 없습니다")
  }
  const sectionXmls: string[] = []
  for (const [i, name] of sections.entries()) {
    if (!zip.file(name)) throw new KordocError(`견본 HWPX 에 ${name} 이 없습니다`)
    const xml = await readText(zip, name, budget)
    // 첫 구역이 깨졌으면 멈춘다. 뒤 구역(붙임 등)이 깨졌으면 그 구역만 빼고 쓴다 — 종전엔 첫 구역만 읽어 그런 견본도 받았다
    if (i === 0) assertWellFormed(xml, name)
    else try { assertWellFormed(xml, name) } catch { sectionXmls.push(""); continue }
    sectionXmls.push(xml)
  }
  const headerXml = await readText(zip, "Contents/header.xml", budget)
  assertWellFormed(headerXml, "header.xml")
  const masterXmls: string[] = []
  for (const name of names) if (/^Contents\/masterpage\d*\.xml$/i.test(name)) masterXmls.push(await readText(zip, name, budget))
  return { zip, sections, sectionXmls, headerXml, masterXmls, budget }
}

export interface PackInput { newSection: string; headerXml: string; title: string | null; prvText: string }

const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** 견본 zip 을 바탕으로 새 zip — mimetype 무압축 첫 엔트리, 바꾼 파일만 갈아 끼우고 안 쓰는 구역·그림·미리보기 그림은 뺀다 */
export async function packTemplateZip(t: TemplateZip, p: PackInput): Promise<ArrayBuffer> {
  const { zip, sections, budget } = t
  const names = Object.keys(zip.files)
  const nameSet = new Set(names)
  const hpfName = zip.file("Contents/content.hpf") ? "Contents/content.hpf" : names.find((n) => /content\.hpf$/i.test(n))
  let hpf = hpfName ? await readText(zip, hpfName, budget) : ""
  const drop = new Set<string>([...sections.slice(1), "Preview/PrvImage.png"])
  const resolveHref = (href: string) => (nameSet.has(href) ? href : nameSet.has(`Contents/${href}`) ? `Contents/${href}` : href)
  // 안 쓰는 BinData — 새 section·header·바탕쪽 어디에서도 binaryItemIDRef 로 안 부르는 항목
  const refs = new Set<string>()
  for (const xml of [p.newSection, p.headerXml, ...t.masterXmls]) for (const m of xml.matchAll(/\bbinaryItemIDRef="([^"]{1,256})"/g)) refs.add(m[1])
  const ITEM_RE = /<opf:item\b[^>]{0,4096}>/g
  for (const m of hpf.matchAll(ITEM_RE)) {
    const id = /\bid="([^"]{0,256})"/.exec(m[0])?.[1] ?? "", name = resolveHref(/\bhref="([^"]{0,1024})"/.exec(m[0])?.[1] ?? "")
    if (/^BinData\//i.test(name) && !refs.has(id)) drop.add(name)
  }
  if (hpf) {
    // 뺀 파일의 manifest 항목과 spine 참조를 함께 지운다 (id 를 먼저 모으고 itemref 는 따로)
    const droppedIds = new Set<string>()
    hpf = hpf.replace(ITEM_RE, (tag) => {
      if (!drop.has(resolveHref(/\bhref="([^"]{0,1024})"/.exec(tag)?.[1] ?? ""))) return tag
      const id = /\bid="([^"]{0,256})"/.exec(tag)?.[1]
      if (id) droppedIds.add(id)
      return ""
    })
    hpf = hpf.replace(/<opf:itemref\b[^>]{0,4096}?\bidref="([^"]{0,256})"[^>]{0,4096}?\/>/g, (tag, id: string) => (droppedIds.has(id) ? "" : tag))
    if (p.title) hpf = hpf.replace(/<opf:title>[^<]{0,65536}<\/opf:title>|<opf:title\/>/, `<opf:title>${escapeXml(p.title)}</opf:title>`)
  }
  const replaced = new Map<string, string>([
    [sections[0], p.newSection], ["Contents/header.xml", p.headerXml], ["Preview/PrvText.txt", p.prvText],
  ])
  if (hpfName) replaced.set(hpfName, hpf)
  const dropRes = [...drop].map((n) => new RegExp(`rdf:(?:about|resource)="${escRe(n)}"`))
  const out = new JSZip()
  out.file("mimetype", "application/hwp+zip", { compression: "STORE" })
  for (const name of names) {
    const f = zip.files[name]
    if (f.dir || name === "mimetype" || drop.has(name)) continue
    if (replaced.has(name)) { out.file(name, replaced.get(name)!, { compression: "DEFLATE" }); replaced.delete(name); continue }
    const bytes = await readZipEntry(f, "uint8array", budget.used)
    budget.used += bytes.length
    let data: string | Uint8Array = bytes
    // 커서 자리는 견본 문단을 가리킨다 — 문서 첫머리로
    if (name === "settings.xml") data = new TextDecoder().decode(bytes).replace(/<ha:CaretPosition\b[^>]{0,1024}\/>/, `<ha:CaretPosition listIDRef="0" paraIDRef="0" pos="0"/>`)
    // 패키지 목록(rdf)도 뺀 구역·그림을 가리키지 않게
    if (name === "META-INF/container.rdf" && drop.size) {
      data = new TextDecoder().decode(bytes).replace(/<rdf:Description\b[^>]{0,1024}>(?:(?!<\/rdf:Description>)[\s\S]){0,8192}<\/rdf:Description>/g,
        (block) => (dropRes.some((re) => re.test(block)) ? "" : block))
    }
    out.file(name, data, { compression: "DEFLATE" })
  }
  for (const [name, data] of replaced) out.file(name, data, { compression: "DEFLATE" })
  return out.generateAsync({ type: "arraybuffer" })
}
