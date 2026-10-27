/**
 * 기관팩(.kpack) — 기관 서식을 kordoc 코어에 담지 않고, 사용자가 자기 기관 문서(HWPX) 몇 건으로 만들어 쓰는 서식 묶음.
 *
 * 팩은 코드 없는 zip 이다: pack.json(목록·근거) + 문서 종류별 견본 HWPX(원문 글을 비운 판) + guide.md(작성 요령).
 * 생성은 기존 견본 모드(gen-from-template)를 그대로 쓴다 — 팩이 하는 일은 (1) 여러 견본 중 대표를 고르고 (2) 원문 글·작성자
 * 정보를 비워 남에게 건넬 수 있게 만들고 (3) 그 견본으로 쓸 때의 요령을 적어 두는 것.
 *
 * 대표 견본 고르기: 견본 하나를 아무거나 쓰면 같은 기관 문서도 재현율이 46~82%로 흔들렸다(서울 방침서 16건 실측 —
 * 문서마다 □·ㅇ 글꼴·크기를 손으로 바꾼 것이 섞여 있다). 역할(□·ㅇ·-·※·제목·요약·담당·장)마다 견본들의 다수결 서식을
 * 내고, 그 다수결과 가장 많이 맞는 견본(medoid)을 고른다.
 */

import JSZip from "jszip"
import { createHash } from "crypto"
import { loadTemplateZip, packTemplateZip } from "./template-zip.js"
import { markdownToHwpxFromTemplate, pickBodySection } from "./gen-from-template.js"
import { elementAt, isMarkerChar, lineRole, paraPlain, parsePara, removeElements, type RoleKey } from "./template-scan.js"
import { topLevelParagraphs } from "../roundtrip/structure-edit.js"
import { mapPuaText } from "../shared/pua.js"
import { MAX_DECOMPRESS_SIZE, readZipEntry } from "./parser-shared.js"
import { parseHwpxDocument } from "./parser.js"
import { KordocError, precheckZipSize, VERSION } from "../utils.js"

/** 역할 하나의 서식 — 비교용 요약 */
export interface RoleStyle { font: string; pt: number; bold: boolean; align: string; lineSpacing: string }

interface HeaderIndex {
  chars: Map<string, { font: string; pt: number; bold: boolean; color: string }>
  paras: Map<string, { align: string; lineSpacing: string; prev: string; next: string }>
}

function attr(tag: string, name: string): string | undefined {
  return new RegExp(`\\b${name}="([^"]{0,256})"`).exec(tag)?.[1]
}

/** header.xml → 글자·문단 모양 요약 (한글 글꼴 이름·크기·굵게 / 정렬·줄간격) */
export function indexHeader(headerXml: string): HeaderIndex {
  const faces = new Map<string, string>()
  const hangul = /<hh:fontface\b[^>]{0,512}\blang="HANGUL"[^>]{0,512}>([\s\S]{0,1048576}?)<\/hh:fontface>/.exec(headerXml)?.[1] ?? ""
  for (const m of hangul.matchAll(/<hh:font\b[^>]{0,1024}>/g)) {
    const id = attr(m[0], "id"), face = attr(m[0], "face")
    if (id && face) faces.set(id, face)
  }
  const chars = new Map<string, { font: string; pt: number; bold: boolean; color: string }>()
  for (const m of headerXml.matchAll(/<hh:charPr\b[^>]{0,4096}>[\s\S]{0,8192}?<\/hh:charPr>/g)) {
    const open = /^<hh:charPr\b[^>]{0,4096}>/.exec(m[0])![0]
    const id = attr(open, "id")
    if (!id) continue
    const fontId = attr(/<hh:fontRef\b[^>]{0,1024}>/.exec(m[0])?.[0] ?? "", "hangul") ?? "0"
    chars.set(id, { font: faces.get(fontId) ?? "", pt: Number(attr(open, "height") ?? 1000) / 100, bold: /<hh:bold\b/.test(m[0]) || attr(open, "bold") === "1", color: (attr(open, "textColor") ?? "#000000").toUpperCase() })
  }
  const paras = new Map<string, { align: string; lineSpacing: string; prev: string; next: string }>()
  for (const m of headerXml.matchAll(/<hh:paraPr\b[^>]{0,4096}>[\s\S]{0,16384}?<\/hh:paraPr>/g)) {
    const id = attr(/^<hh:paraPr\b[^>]{0,4096}>/.exec(m[0])![0], "id")
    if (!id) continue
    const ls = /<hh:lineSpacing\b[^>]{0,512}>/.exec(m[0])?.[0] ?? ""
    const margin = (k: string) => attr(new RegExp(`<hc:${k}\\b[^>]{0,256}>`).exec(m[0])?.[0] ?? "", "value") ?? "0"
    paras.set(id, { align: attr(/<hh:align\b[^>]{0,512}>/.exec(m[0])?.[0] ?? "", "horizontal") ?? "JUSTIFY", lineSpacing: `${attr(ls, "value") ?? ""}${attr(ls, "type") === "PERCENT" ? "%" : ""}`, prev: margin("prev"), next: margin("next") })
  }
  return { chars, paras }
}

/**
 * 원형 문단 하나의 서식 — 견본 모드가 새 글에 입히는 글자 모양(fillParagraph: 부호 뒤 글이 가장 많은 run)과 문단 모양.
 * 첫 run 을 보면 "(현황)" 같은 굵은 머리말 run 이 잡혀 같은 서식을 다르게 읽었다
 */
function protoStyle(xml: string, ix: HeaderIndex): RoleStyle | null {
  const p = elementAt(xml, 0)
  if (!p) return null
  const model = parsePara(xml, p)
  const paraPr = /\bparaPrIDRef="(\d+)"/.exec(xml.slice(p.start, p.openEnd))?.[1] ?? "0"
  const plain = paraPlain(model)
  let prefix = /^[\s　]*/.exec(plain)![0].length
  const cp = plain.codePointAt(prefix)
  if (cp !== undefined && isMarkerChar(mapPuaText(String.fromCodePoint(cp)))) {
    prefix += String.fromCodePoint(cp).length
    prefix += /^[\s　]*/.exec(plain.slice(prefix))![0].length
  }
  let best = "", bestN = 0, pos = 0
  for (const r of model.runs) {
    let n = 0
    for (const part of r.parts) for (const tok of part.toks) for (let i = 0; i < tok.s.length; i++, pos++) if (pos >= prefix && tok.xml === null && /\S/.test(tok.s[i])) n++
    if (n > bestN) { bestN = n; best = r.charPr }
  }
  const charPr = best || model.runs.at(-1)?.charPr
  const c = charPr ? ix.chars.get(charPr) : undefined
  const q = ix.paras.get(paraPr)
  if (!c || !q) return null
  return { ...c, ...q }
}

/** 서식을 비교하는 역할 — 표·띠·기호 원형은 칸 서식이 여럿이라 뺀다 */
export const COMPARED_ROLES: RoleKey[] = ["title", "contact", "summary", "chapter", "L0", "L1", "L2", "L3", "ref", "body"]

/** 견본 HWPX → 역할별 서식 (본문 구역 기준) */
export interface TemplateRoles {
  roles: Map<RoleKey, RoleStyle>
  /** 견본이 갖춘 역할 원형 */
  protoRoles: RoleKey[]
  /** 참고 띠 아래 첫 항목의 역할 (template-scan bandItem) */
  bandItem: RoleKey | null
  /** 제목표 안에 담당 칸이 있다 */
  contactInTitle: boolean
  /** 글 없이 기호만 있는 기호 원형 ("*" 한 글자 문단) — 골격 원고도 기호만 써야 같은 역할로 다시 읽힌다 */
  bareSyms: string[]
  /** 본문 구역에서 역할마다 문단 수 — 대표 고르기 무게 (ㅇ·- 문단이 대부분이고 제목·담당은 한 줄) */
  counts: Map<RoleKey, number>
}

export async function templateRoleStyles(hwpx: Uint8Array | ArrayBuffer): Promise<TemplateRoles> {
  const tz = await loadTemplateZip(hwpx)
  const { scan, xml: bodyXml } = pickBodySection(tz.sectionXmls, tz.headerXml)
  const ix = indexHeader(tz.headerXml)
  const roles = new Map<RoleKey, RoleStyle>()
  for (const k of COMPARED_ROLES) {
    const xml = scan.protos.get(k)
    if (!xml) continue
    // 표 안 글(제목표·요약 상자)은 첫 칸 첫 문단을 본다
    const inner = /<hp:tbl\b/.test(xml) ? /<hp:p\b[\s\S]*?<\/hp:p>/.exec(xml.slice(xml.indexOf("<hp:subList")))?.[0] ?? xml : xml
    const st = protoStyle(inner, ix)
    if (st) roles.set(k, st)
  }
  const bareSyms: string[] = []
  for (const [k, xml] of scan.protos) {
    if (!k.startsWith("sym:")) continue
    const p = elementAt(xml, 0)
    if (p && paraPlain(parsePara(xml, p)).trim() === k.slice(4)) bareSyms.push(k.slice(4))
  }
  const counts = new Map<RoleKey, number>()
  for (const { start, end } of topLevelParagraphs(bodyXml)) {
    const frag = bodyXml.slice(start, end), p = elementAt(frag, 0)
    if (!p) continue
    const r = lineRole(paraPlain(parsePara(frag, p))) ?? "body"
    counts.set(r, (counts.get(r) ?? 0) + 1)
  }
  for (const r of ["title", "contact", "summary", "chapter"] as RoleKey[]) if (scan.protos.has(r)) counts.set(r, Math.max(1, counts.get(r) ?? 0))
  return { roles, protoRoles: [...scan.protos.keys()], bandItem: scan.bandItem, contactInTitle: scan.contactInTitle, bareSyms, counts }
}

const key = (s: RoleStyle) => JSON.stringify([s.font, s.pt, s.bold, s.align, s.lineSpacing])

/** 다수결을 내는 서식 속성 — 채점(gen-repro)처럼 속성마다 따로 본다. 한 역할 서식을 통째로 비교하면 정렬·줄간격 하나만 달라도 다른
 *  표가 되어, 견본 15건에서 같은 표가 2~3건뿐이라 대표 고르기가 흔들렸다 */
const PROPS = ["font", "pt", "bold", "align", "lineSpacing"] as const

/**
 * 대표 견본 고르기 — 역할·속성마다 견본들의 다수결 값(같은 값이 2건 이상일 때)과 맞는 칸 수가 가장 많은 견본.
 * 같으면 역할을 더 많이 갖춘 견본, 그래도 같으면 앞 견본. scores 는 견본마다 맞은 칸 수, consensus 는 다수결 칸 수
 */
export function chooseRepresentative(samples: TemplateRoles[]): { index: number; scores: number[]; max: number; consensus: Map<string, string> } {
  const consensus = new Map<string, string>()
  for (const k of COMPARED_ROLES) for (const prop of PROPS) {
    const count = new Map<string, number>()
    for (const s of samples) {
      const st = s.roles.get(k)
      if (!st) continue
      const v = String(st[prop])
      count.set(v, (count.get(v) ?? 0) + 1)
    }
    const top = [...count].sort((a, b) => b[1] - a[1])[0]
    if (top && top[1] >= 2) consensus.set(`${k}/${prop}`, top[0])
  }
  // 무게 — 역할은 견본들의 평균 문단 수(쓰이는 만큼), 속성은 글꼴·크기·굵기 1 · 정렬·줄간격 0.5(문서마다 손으로 맞추는 값)
  // 문단 수는 견본마다 비율로 — 긴 문서(780문단) 하나가 무게를 다 가져가지 않게
  const share = samples.map((s) => { const n = [...s.counts.values()].reduce((a, b) => a + b, 0) || 1; return (k: RoleKey) => (s.counts.get(k) ?? 0) / n })
  const weight = (k: RoleKey) => share.reduce((a, f) => a + f(k), 0) / samples.length
  const pw = { font: 1, pt: 1, bold: 1, align: 0.5, lineSpacing: 0.5 }
  const scores = samples.map((s) => [...consensus].reduce((sum, [cell, v]) => {
    const [k, prop] = cell.split("/") as [RoleKey, (typeof PROPS)[number]]
    const st = s.roles.get(k)
    return sum + (st !== undefined && String(st[prop]) === v ? weight(k) * pw[prop] : 0)
  }, 0))
  const max = [...consensus.keys()].reduce((sum, cell) => { const [k, prop] = cell.split("/") as [RoleKey, (typeof PROPS)[number]]; return sum + weight(k) * pw[prop] }, 0)
  let index = 0
  for (let i = 1; i < samples.length; i++) {
    if (scores[i] > scores[index] || (scores[i] === scores[index] && samples[i].protoRoles.length > samples[index].protoRoles.length)) index = i
  }
  return { index, scores, max, consensus }
}

// ─── 교차 재현으로 대표 고르기 ─────────────────────────────

/** 문단 서식 비교 속성 (재현 채점 gen-repro 와 같은 여덟 가지) */
type ParaFmt = { key: string; f: string[] }
const KEY_STRIP = /[\s\u00a0\u3000\t□■○●ㅇ◦❍\-‐–·ㆍ※*▪▸\u{F0000}-\u{FFFFF}]/gu

/** HWPX 본문 구역의 문단(표 칸 안까지 문서 순서) → 글 키와 서식 */
async function paraFormats(hwpx: Uint8Array | ArrayBuffer): Promise<ParaFmt[]> {
  const tz = await loadTemplateZip(hwpx)
  const { xml } = pickBodySection(tz.sectionXmls, tz.headerXml)
  const ix = indexHeader(tz.headerXml)
  const out: ParaFmt[] = []
  for (const m of xml.matchAll(/<hp:p\b[^>]{0,4096}>/g)) {
    const p = elementAt(xml, m.index!)
    if (!p) continue
    const model = parsePara(xml, p)
    const text = paraPlain(model)
    const key = text.replace(KEY_STRIP, "")
    if (!key) continue
    let best = "", bestN = 0
    for (const r of model.runs) { const n = r.parts.reduce((a, pt) => a + pt.toks.reduce((b, t) => b + (t.xml === null ? t.s.replace(/\s/g, "").length : 0), 0), 0); if (n > bestN) { bestN = n; best = r.charPr } }
    const c = ix.chars.get(best), q = ix.paras.get(/\bparaPrIDRef="(\d+)"/.exec(xml.slice(p.start, p.openEnd))?.[1] ?? "0")
    out.push({ key, f: [c?.font ?? "", String(c?.pt ?? ""), c?.bold ? "1" : "0", c?.color ?? "", q?.align ?? "", q?.lineSpacing ?? "", q?.prev ?? "", q?.next ?? ""] })
  }
  return out
}

/** 두 문서 문단을 글 순서로 짝지어(LCS) 서식 속성이 같은 비율 — 대표 고르기용 가늠자(평가는 bench/gen-repro 채점기) */
function formatAgreement(gt: ParaFmt[], gen: ParaFmt[]): number {
  const a = gt.slice(0, 1500), b = gen.slice(0, 1500), n = a.length, m = b.length
  if (!n || !m) return 0
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i].key === b[j].key ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  let ok = 0, tot = 0
  for (let i = 0, j = 0; i < n && j < m;) {
    if (a[i].key === b[j].key) { for (let k = 0; k < 8; k++) { tot++; if (a[i].f[k] === b[j].f[k]) ok++ } i++; j++ }
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++
    else j++
  }
  // 짝 못 찾은 정답 문단은 모든 속성을 틀린 것으로
  tot += (n - dp[0][0]) * 8
  return tot ? ok / tot : 0
}

/** 교차 재현에 쓰는 후보·참조 수 상한 — 견본이 많아도 후보 6 × 참조 6 생성으로 끝나게 */
const XVAL_CANDIDATES = 6
const XVAL_REFS = 6

/**
 * 후보마다 다른 견본들의 글(kordoc 이 읽은 마크다운)을 그 후보 견본으로 다시 만들어 원본과 서식을 대조한 평균. 다수결(역할별 서식)로
 * 후보를 추린 뒤 이 점수로 고른다 — 서울 방침서 16건 하나 빼기 실험에서 다수결만 쓰면 71.5%, 교차 재현이면 74.6%(최고 견본 76.2%)
 */
async function crossScores(samples: Uint8Array[], candidates: number[]): Promise<Map<number, number>> {
  const refs = samples.map((_, i) => i).slice(0, Math.max(XVAL_REFS + 1, candidates.length))
  const md = new Map<number, string>(), fmt = new Map<number, ParaFmt[]>()
  for (const j of refs) {
    try {
      const r = await parseHwpxDocument(samples[j].buffer.slice(samples[j].byteOffset, samples[j].byteOffset + samples[j].byteLength) as ArrayBuffer)
      if (r.markdown.trim()) { md.set(j, r.markdown); fmt.set(j, await paraFormats(samples[j])) }
    } catch { /* 못 읽는 견본은 참조에서 뺀다 */ }
  }
  const out = new Map<number, number>()
  for (const i of candidates) {
    const others = [...md.keys()].filter((j) => j !== i).slice(0, XVAL_REFS)
    let sum = 0
    for (const j of others) {
      try { sum += formatAgreement(fmt.get(j)!, await paraFormats(await markdownToHwpxFromTemplate(md.get(j)!, samples[i], []))) } catch { /* 0 */ }
    }
    out.set(i, others.length ? sum / others.length : 0)
  }
  return out
}

// ─── 팩 만들기·읽기 ─────────────────────────────────────

/** 팩 형식 판 — 읽는 쪽은 이 값만 받는다 */
export const PACK_FORMAT = 1
/** 문서 종류 이름 — 파일 이름에 쓰므로 영문 소문자·숫자·붙임표·한글만 */
const KIND_RE = /^[a-z0-9\-가-힣]{1,20}$/u
/** 팩 한 개 상한 — 견본 HWPX 몇 개와 작성 요령이면 수 MB 이내 */
const MAX_PACK_BYTES = 64 * 1024 * 1024
const MAX_KINDS = 16

export interface PackKindInfo {
  /** 팩 안 견본 파일 이름 (kinds/<종류>.hwpx) */
  template: string
  /** 견본 수 */
  samples: number
  /** 대표로 고른 견본 (pack build 에 준 순서, 0부터) */
  chosen: number
  /** 비운 견본을 다시 훑었을 때 원 견본과 달라진 점 — 비어 있어야 정상 */
  drift: string[]
  /** 대표 견본이 갖춘 역할 */
  roles: RoleKey[]
  /** 대표 견본에 없어 가까운 서식으로 대신할 역할 (title·contact·summary·chapter·L0~L2·ref·table 중) */
  missing: RoleKey[]
  /** 견본들의 역할·속성별 다수결 서식과 맞는 비율 (견본마다, 문단 수 무게, 0~1) — 낮은 견본은 다른 서식일 수 있다 */
  agreement: number[]
  /** 비운 견본에 남은 글 — 머리말·꼬리말·바탕쪽·표 머리 같은 고정 글 (기관명 등). 원문 본문이 아닌지 사람이 확인할 것 */
  leftover: string[]
  /** 견본에 든 그림 수 (로고 등 — 팩을 남에게 줄 때 사용 허락 확인) */
  images: number
  /** 참고 띠 아래 항목 역할·제목표 안 담당 칸·기호만 있는 원형 — 작성 요령의 원고 예를 견본과 맞게 */
  bandItem: RoleKey | null
  contactInTitle: boolean
  bareSyms: string[]
}

export interface PackManifest {
  kordocPack: number
  name: string
  createdAt: string
  kordocVersion: string
  kinds: Record<string, PackKindInfo>
  /** 견본 지문 — 원본 파일은 팩에 들지 않는다 */
  sources: { kind: string; sha256: string }[]
}

export interface AgencyPack {
  manifest: PackManifest
  /** 문서 종류 → 견본 HWPX */
  templates: Map<string, Uint8Array>
  /** 작성 요령 (마크다운) */
  guide: string
}

export interface PackSample { data: Uint8Array; kind?: string }

/** 대표 견본이 갖추면 좋은 역할 — 없으면 missing 으로 알린다 */
const EXPECTED: RoleKey[] = ["title", "contact", "summary", "chapter", "L0", "L1", "L2", "ref", "table"]

/** 역할 → 그 역할로 읽히는 줄 머리 */
function rolePrefix(r: RoleKey): string {
  return r === "L0" ? "□ " : r === "L1" ? "ㅇ " : r === "L2" ? "- " : r === "L3" ? "· " : r === "ref" ? "※ " : r.startsWith("sym:") ? `${r.slice(4).replace(/^([*+#>|\\-])/, "\\$1")} ` : ""
}

/**
 * 역할을 한 번씩 쓰는 골격 원고 — 대표 견본으로 이 원고를 생성한 결과가 팩 견본(원문 글이 빠진 판)이 된다. 다시 훑었을 때
 * 같은 원형이 잡히도록 견본 상태(제목표 안 담당 칸·참고 띠 아래 항목 역할)도 그대로 옮긴다
 */
export function skeletonMarkdown(t: Pick<TemplateRoles, "protoRoles" | "bandItem" | "contactInTitle"> & { bareSyms?: string[] }): string {
  const has = new Set(t.protoRoles)
  // 제목은 견본에 있을 때만 — 없는 견본에 제목을 넣으면 다시 훑을 때 요약 상자가 제목 자리로 잡힌다
  const out: string[] = has.has("title") ? ["# 문서 제목"] : []
  if (has.has("subtitle")) out.push("- 부제 -")
  // 결재선 칸(과장·팀장·담당)은 원고에 없는 직위 칸에 견본 글(실명·전화)을 남긴다(gen-from-template matchRoleSlots). 견본 칸에
  // 없는 직위(센터장)를 섞어 칸을 차례로 다시 채우게 한다 — 남는 칸은 비고, 견본 이름은 남지 않는다
  if (has.has("contact") || t.contactInTitle) out.push("과장 : ○○○ ☎ ○○○○  팀장 : ○○○ ☎ ○○○○  담당 : ○○○ ☎ ○○○○  센터장 : ○○○")
  if (has.has("summary")) out.push("> 문서 요약 문구")
  if (has.has("chapter")) out.push("## 장 제목")
  // 단계는 빠진 것도 늘 쓴다 — 위 단계가 없으면 "- 항목"이 1단계로 올라가 다른 원형이 된다. 빠진 단계는 견본 모드가 이웃
  // 단계 서식으로 채우고, 쓸 때도 같은 규칙으로 채우므로 결과가 같다
  out.push("□ 첫째 단계 항목", "ㅇ 둘째 단계 항목", "- 셋째 단계 항목", "· 넷째 단계 항목")
  // 마크다운 목록 표지(* + -)·제목(#)·인용(>)으로 읽히는 기호는 이스케이프
  for (const k of has) if (k.startsWith("sym:")) out.push(`${k.slice(4).replace(/^([*+#>|\\-])/, "\\$1")}${t.bareSyms?.includes(k.slice(4)) ? "" : " 기호 항목"}`)
  if (has.has("body")) out.push("부호 없는 본문 문단")
  if (has.has("ref")) out.push("※ 참고 문구")
  if (has.has("table")) out.push("| 구분 | 내용 | 비고 |\n| --- | --- | --- |\n| 합계 | ○ | ○ |\n| 가 | ○ | ○ |\n| 나 | ○ | ○ |\n| 다 | ○ | ○ |")
  if (has.has("band")) out.push("## 참고1 참고 제목", ...(t.bandItem ? [`${rolePrefix(t.bandItem)}참고 항목`] : []))
  return out.join("\n\n") + "\n"
}

/** 역할 이름 (사람이 읽는 말) */
export function roleName(r: RoleKey): string {
  const N: Partial<Record<RoleKey, string>> = { title: "제목표", subtitle: "부제", contact: "담당 칸", summary: "요약 상자", chapter: "장 띠", band: "참고 띠", table: "표", body: "본문 문단", ref: "※ 참고", L0: "□ 1단계", L1: "ㅇ 2단계", L2: "- 3단계", L3: "· 4단계" }
  return N[r] ?? (r.startsWith("sym:") ? `${r.slice(4)} 기호 줄` : r)
}

/** 두 견본 훑기 결과의 차이 — 역할 원형·역할별 서식·참고 띠 항목·제목표 담당 칸 */
function roleDrift(a: TemplateRoles, b: TemplateRoles): string[] {
  const out: string[] = []
  const sa = new Set(a.protoRoles), sb = new Set(b.protoRoles)
  for (const r of sa) if (!sb.has(r)) out.push(`${roleName(r)}: 원 견본에 있는데 빠짐`)
  // 빠진 단계(□·ㅇ·-··)는 골격 원고가 늘 써서 이웃 단계 서식으로 생긴다 — 쓸 때도 같은 규칙으로 채우므로 차이가 아니다
  for (const r of sb) if (!sa.has(r) && !/^L[0-3]$/.test(r)) out.push(`${roleName(r)}: 원 견본에 없는데 생김`)
  for (const [r, st] of a.roles) { const o = b.roles.get(r); if (o && key(o) !== key(st)) out.push(`${roleName(r)}: 서식이 달라짐`) }
  if (a.bandItem !== b.bandItem) out.push("참고 띠 아래 항목 서식이 달라짐")
  if (a.contactInTitle !== b.contactInTitle) out.push("제목표 안 담당 칸이 달라짐")
  return out
}

/** 작성 요령의 원고 예 — 팩이 가진 역할만, 사람이 읽을 꼴로(골격 원고와 달리 빠진 단계·합계 행·가짜 직위를 넣지 않는다) */
export function guideExample(k: Pick<PackKindInfo, "roles" | "bandItem" | "contactInTitle" | "bareSyms">): string {
  const has = new Set(k.roles)
  const out: string[] = []
  if (has.has("title")) out.push("# 문서 제목")
  if (has.has("subtitle")) out.push("- 부제 -")
  if (has.has("contact") || k.contactInTitle) out.push("담당 : 홍길동 ☎ 000-0000")
  if (has.has("summary")) out.push("> 문서 목적을 한 문장으로")
  if (has.has("chapter")) out.push("## 장 제목")
  if (has.has("L0")) out.push("□ 1단계 항목")
  if (has.has("L1")) out.push("ㅇ 2단계 항목")
  if (has.has("L2")) out.push("- 3단계 항목")
  if (has.has("L3")) out.push("· 4단계 항목")
  for (const r of k.roles) if (r.startsWith("sym:")) out.push(`${r.slice(4).replace(/^([*+#>|\\-])/, "\\$1")}${k.bareSyms?.includes(r.slice(4)) ? "" : " 기호로 시작하는 줄"}`)
  if (has.has("body")) out.push("부호 없는 본문 문단")
  if (has.has("ref")) out.push("※ 참고 문구")
  if (has.has("table")) out.push("| 구분 | 내용 |\n| --- | --- |\n| 가 | ○○ |\n| 나 | ○○ |")
  if (has.has("band")) out.push("## 참고1 참고 제목", ...(k.bandItem ? [`${rolePrefix(k.bandItem)}참고 항목`] : []))
  return out.join("\n\n") + "\n"
}

/**
 * 원고가 팩에 없는 역할을 쓰는지 — 견본 모드는 없는 역할을 가까운 서식으로 대신하지만 제목·담당·요약·장은 대신한 줄을 알리지 않는다.
 * 팩으로 생성할 때 이 경고를 함께 낸다
 */
export function packRoleWarnings(k: PackKindInfo, markdown: string): string[] {
  const has = new Set(k.roles), out: string[] = []
  const lines = markdown.split(/\r?\n/)
  const uses = (re: RegExp) => lines.some((l) => re.test(l))
  if (uses(/^#\s/) && !has.has("title")) out.push("pack: 이 팩에는 제목표가 없어 `# 제목` 을 본문 글로 넣었습니다")
  // 담당 줄은 제목 다음 머리 줄만 — 본문의 "※ 문의 … ☎" 는 ※ 줄이다
  const headEnd = lines.findIndex((l) => /^(##\s|[□■ㅇ○◦❍※\-·*|]|\d{1,9}[.)]\s)/u.test(l.trim()))
  const head = lines.slice(0, headEnd < 0 ? lines.length : headEnd)
  if (head.some((l) => /☎|담당자?\s*[:：]/.test(l)) && !has.has("contact") && !k.contactInTitle) out.push("pack: 이 팩에는 담당 칸이 없어 담당 줄을 본문 글로 넣었습니다")
  if (uses(/^>\s/) && !has.has("summary")) out.push("pack: 이 팩에는 요약 상자가 없어 `>` 줄을 다른 서식으로 넣었습니다")
  if (uses(/^##\s/) && !has.has("chapter") && !has.has("band")) out.push("pack: 이 팩에는 장 띠가 없어 `##` 제목을 □ 항목으로 넣었습니다")
  if (uses(/^\|/) && !has.has("table")) out.push("pack: 이 팩에는 표 서식이 없어 기본 테두리 표로 넣었습니다")
  // 줄 머리 "2026." 은 마크다운 번호 목록 — 날짜로 시작하는 줄이 항목 부호로 바뀐다
  if (uses(/^\d{1,9}\.\s/)) out.push("pack: 숫자와 마침표로 시작하는 줄(예: \"2026. 3. 1.\")은 번호 목록으로 읽혀 항목 부호가 붙습니다 — 날짜 줄이면 \"2026\\. 3. 1.\" 처럼 마침표 앞에 \\ 를 붙이세요")
  return out
}

/** HWPX 안 글 조각 — 비운 견본에 남은 글을 알리려고 */
function xmlTexts(xml: string): string[] {
  const out: string[] = []
  for (const m of xml.matchAll(/<hp:t\b(?:[^>/]|\/(?!>)){0,256}>([\s\S]{0,65536}?)<\/hp:t>/g)) {
    const t = m[1].replace(/<[^>]{1,1024}>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&").trim()
    if (t) out.push(t)
  }
  return out
}

/**
 * 사람 정보 지우기 — 제목표 결재선 칸이 여러 문단이면 견본 모드가 첫 문단만 새로 채워 다른 직위의 실명·전화가 비운 견본에
 * 남았다(서울 방침서 3건). 직위 낱말·쌍점·☎ 같은 틀 글자는 두고(다시 훑을 때 담당 칸으로 읽혀야 한다) 이름·번호는 ○ 로, 직위 앞
 * 부서 이름("도시정책과장" → "과장")은 뺀다 — 다른 부서가 팩으로 쓸 때 원고에 없는 칸에 엉뚱한 부서가 남지 않게
 */
const ROLE_LABEL_RE = /(?:\([^()]{1,20}\)[\s　]*)?[가-힣·]{0,20}?((?:과장|팀장|국장|실장|주무관|담당관|담당자?|본부장|센터장|소장|부장|계장)[\s　]*[:：][\s　]*)([^☎\s　:：][^☎:：]{0,20}?)(?=[\s　]*(?:☎|$)|[\s　]+[^\s　:：]{1,20}[\s　]*[:：])/gu
const PHONE_RE = /(☎[\s　]*)?\(?\d{2,4}\)?(?:[\s　]?[-)][\s　]?\d{3,4}){1,2}|☎[\s　]*\d{3,4}/gu

const scrubText = (t: string) => t.replace(ROLE_LABEL_RE, (_m, label: string) => `${label}○○○`).replace(PHONE_RE, (m, tel: string | undefined) => `${tel ?? (m.startsWith("☎") ? "☎" : "")}○○○○`)

export function scrubPeople(xml: string): string {
  return xml.replace(/(<hp:t\b(?:[^>/]|\/(?!>)){0,256}>)([\s\S]{0,65536}?)(<\/hp:t>)/g, (all, open: string, body: string, close: string) => {
    if (!body.includes("<")) return open + scrubText(body) + close
    // 글 안 인라인 표지(전각 빈칸·탭 …)로 이름이 갈린 조각("김<hp:fwSpace/>석") — 평문으로 보고 바뀌면 평문으로 갈아 끼운다
    const plain = body.replace(/<hp:(?:fwSpace|nbSpace)\/>/g, " ").replace(/<hp:tab\b[^>]{0,256}\/>/g, "\t").replace(/<[^>]{1,1024}>/g, "")
    const out = scrubText(plain)
    return out === plain ? all : open + out.replace(/&(?!(?:amp|lt|gt|quot|apos);)/g, "&amp;").replace(/</g, "&lt;") + close
  })
}

/** content.hpf 의 작성자·날짜·설명 메타를 비운다 (opf:title 은 골격 제목으로 이미 바뀌어 있다) */
function scrubMeta(hpf: string): string {
  return hpf.replace(/(<opf:meta\b[^>]{0,1024}?\bname="(?:creator|lastsaveby|CreatedDate|ModifiedDate|date|keyword|description|subject)"[^>]{0,1024}>)[^<]{0,65536}(<\/opf:meta>)/g, "$1$2")
}

/** 비운 견본 — 골격 원고로 생성하고 작성자 메타를 지운다. 남은 글·그림 수를 함께 */
async function scrubbedTemplate(sample: Uint8Array, t: TemplateRoles): Promise<{ data: Uint8Array; leftover: string[]; images: number }> {
  const skeleton = skeletonMarkdown(t)
  const gen = await markdownToHwpxFromTemplate(skeleton, sample, [])
  const zip = await JSZip.loadAsync(gen)
  const hpfName = Object.keys(zip.files).find((n) => /content\.hpf$/i.test(n))
  if (hpfName) zip.file(hpfName, scrubMeta(await zip.file(hpfName)!.async("string")))
  for (const n of Object.keys(zip.files)) {
    if (/^Contents\/(section\d+|masterpage\d*)\.xml$/i.test(n)) zip.file(n, scrubPeople(await zip.file(n)!.async("string")))
  }
  const known = new Set(skeleton.split(/\n+/).flatMap((l) => l.replace(/^[#>\s□ㅇ○\-·※|]+/u, "").split("|")).map((x) => x.trim()).filter(Boolean))
  const leftover = new Set<string>()
  for (const n of Object.keys(zip.files)) {
    if (!/^Contents\/(section\d+|masterpage\d*)\.xml$/i.test(n)) continue
    for (const t of xmlTexts(await zip.file(n)!.async("string"))) {
      const bare = t.replace(/^[□ㅇ○◦❍\-·ㆍ▸※*\s]+/u, "").trim()
      // 장 번호(Ⅰ·1)·○ 자리 글은 틀 글이라 알리지 않는다
      if (bare && ![...known].some((k) => bare.includes(k) || k.includes(bare)) && !/^[○\s☎\-:.,0-9ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩⅪⅫ]*$/.test(bare)) leftover.add(t.slice(0, 80))
    }
  }
  const images = Object.keys(zip.files).filter((n) => /^BinData\//i.test(n) && !zip.files[n].dir).length
  const data = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" })
  return { data, leftover: [...leftover], images }
}

/** 가린 판에서 남기는 틀 낱말 — 견본 훑기가 역할을 가르는 데 쓰는 글(목차 상자·참고 띠·합계 행·결재선 직위) */
const KEEP_WORDS = /(목\s*차|차\s*례|참\s*고|별\s*첨|붙\s*임|합\s*계|총\s*계|소\s*계|구\s*분|담당관|담당자|담당|주무관|과장|팀장|국장|실장|본부장|센터장|소장|부장|계장)/u

/** 글 가리기 — 틀 낱말·부호·문장부호·☎·로마 숫자는 두고, 숫자는 0, 그 밖의 글자는 ○ (날짜 꼴·부호 갈래가 그대로 남는다) */
export function maskText(t: string): string {
  return t.split(KEEP_WORDS).map((part, i) => (i % 2 ? part : part.replace(/\d/g, "0").replace(/[\p{L}]/gu, (ch) => (/[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩⅪⅫ□■○●ㅇ◦❍ㆍ※]/u.test(ch) ? ch : "○")))).join("")
}

function maskXml(xml: string): string {
  return xml.replace(/(<hp:t\b(?:[^>/]|\/(?!>)){0,256}>)([\s\S]{0,65536}?)(<\/hp:t>)/g, (_all, open: string, body: string, close: string) =>
    open + body.split(/(<[^>]{1,1024}>)/).map((seg) => (seg.startsWith("<") ? seg : maskText(seg))).join("") + close)
}

/**
 * 가린 판 — 골격 원고로 다시 만든 견본이 원 견본과 다르게 읽힐 때(제목 없이 요약 상자만 있는 견본, 제목표를 담당 칸으로 읽는 견본) 쓴다.
 * 원 견본 본문 구역을 그대로 두고 글만 가리므로 역할 판정이 어긋나지 않는다. 본문 그림은 뺀다(사진일 수 있다)
 */
async function maskedTemplate(sample: Uint8Array): Promise<{ data: Uint8Array; leftover: string[]; images: number }> {
  const tz = await loadTemplateZip(sample)
  const { xml } = pickBodySection(tz.sectionXmls, tz.headerXml)
  const body = maskXml(removeElements(xml, ["pic"]))
  const packed = await packTemplateZip(tz, { newSection: body, headerXml: tz.headerXml, title: "○○", prvText: "" })
  const zip = await JSZip.loadAsync(packed)
  const hpfName = Object.keys(zip.files).find((n) => /content\.hpf$/i.test(n))
  if (hpfName) zip.file(hpfName, scrubMeta(await zip.file(hpfName)!.async("string")))
  for (const n of Object.keys(zip.files)) if (/^Contents\/masterpage\d*\.xml$/i.test(n)) zip.file(n, maskXml(await zip.file(n)!.async("string")))
  const images = Object.keys(zip.files).filter((n) => /^BinData\//i.test(n) && !zip.files[n].dir).length
  return { data: await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" }), leftover: [], images }
}

/** 작성 요령 — 에이전트가 이 팩으로 원고를 쓸 때 읽는다 */
function guideFor(name: string, manifest: PackManifest): string {
  const ROLE_DOC: Partial<Record<RoleKey, string>> = {
    title: "`# 제목` — 첫 줄. 견본 제목표에 들어간다",
    subtitle: "제목 다음 `- 부제 -` 줄 — 부제",
    contact: "제목 다음 담당 줄(`담당 : 홍길동 ☎ 1234` 처럼 ☎ 또는 '담당:' 포함) — 견본 담당 칸",
    summary: "제목 다음 `> 요약 한 문장` — 견본 요약 상자",
    chapter: "`## 장 제목` — 견본 장 띠(번호는 Ⅰ Ⅱ … 자동)",
    L0: "`□ 항목` — 1단계", L1: "`ㅇ 항목` — 2단계 (견본의 ○·ㅇ 부호를 따른다)", L2: "`- 항목` — 3단계", L3: "`· 항목` — 4단계",
    ref: "`※ 참고` — 참고 문구", body: "부호 없는 문단 — 견본 본문 문단",
    table: "GFM 표 — 견본 표 서식(머리행·본문·합계 행)", band: "`## 참고1 제목` — 견본 참고 띠, 그 아래 항목은 견본 참고 쪽 서식",
  }
  const lines = [`# ${name} 기관팩 — 작성 요령`, "",
    "이 팩은 kordoc 견본 모드로 새 문서를 만든다: `kordoc generate 원고.md --pack 이팩.kpack` 또는 MCP generate_document 의 pack_path.",
    "원고는 아래 역할 규칙대로 쓴다. 견본에 없는 역할은 가까운 서식으로 대신하고 경고한다. 그림·각주·인라인 수식은 넣지 않는다.",
    "날짜처럼 숫자와 마침표로 시작하는 줄(\"2026. 3. 1.\")은 마크다운 번호 목록으로 읽힌다 — \"2026\\. 3. 1.\" 처럼 쓴다.",
    "생성 때 나오는 표기·문체 지적(쌍점 띄어쓰기 등)은 참고용이다 — 기관 관행과 다르면 사용자에게 물어 정한다.", ""]
  for (const [kind, k] of Object.entries(manifest.kinds)) {
    const low = k.agreement.map((a, i) => ({ a, i })).filter((x) => x.a < 0.5).map((x) => x.i + 1)
    lines.push(`## 문서 종류: ${kind}`, "", `견본 ${k.samples}건 중 ${k.chosen + 1}번째를 대표로 씀 (역할별 다수결 서식과 가장 많이 맞는 견본).`)
    if (low.length) lines.push(`다른 서식으로 보이는 견본: ${low.join("·")}번째 — 같은 종류 문서인지 확인하고, 아니면 종류를 나눠 다시 만들 것.`)
    if (k.drift.length) lines.push(`⚠ 비운 견본이 원 견본과 다르게 읽힘(${k.drift.join(", ")}) — 다른 견본을 더 넣어 다시 만들 것.`)
    lines.push("", "쓸 수 있는 역할:", "")
    for (const r of k.roles) if (ROLE_DOC[r]) lines.push(`- ${ROLE_DOC[r]}`)
    if (k.contactInTitle && !k.roles.includes("contact")) lines.push(`- ${ROLE_DOC.contact} (제목표 안)`)
    const syms = k.roles.filter((r) => r.startsWith("sym:")).map((r) => r.slice(4))
    if (syms.length) lines.push(`- \`${syms.join("`·`")}\` 로 시작하는 줄 — 견본의 같은 기호 문단`)
    if (k.missing.length) lines.push("", `견본에 없는 역할(가까운 서식으로 대신): ${k.missing.map(roleName).join(", ")}`)
    lines.push("", "원고 예 (이 꼴 그대로 내용만 바꿔 쓴다):", "", "```markdown", guideExample(k).trimEnd(), "```", "")
  }
  return lines.join("\n")
}

/**
 * 기관팩 만들기 — 같은 종류 문서마다 대표 견본을 골라 비운 판을 담는다. 원본 견본은 팩에 들지 않는다(지문만).
 * into 를 주면 그 팩에 종류를 더하거나 같은 종류를 바꾼다.
 */
export async function buildAgencyPack(name: string, samples: PackSample[], into?: AgencyPack): Promise<{ pack: Uint8Array; manifest: PackManifest; guide: string }> {
  const trimmed = name.trim()
  if (!trimmed || trimmed.length > 60) throw new KordocError("pack: 기관 이름(1~60자)이 필요합니다")
  if (!samples.length) throw new KordocError("pack: 견본 HWPX 가 한 건 이상 필요합니다")
  const byKind = new Map<string, Uint8Array[]>()
  for (const s of samples) {
    const kind = s.kind ?? "report"
    if (!KIND_RE.test(kind)) throw new KordocError(`pack: 문서 종류 이름 "${kind}" — 영문 소문자·숫자·한글·붙임표 1~20자`)
    byKind.set(kind, [...(byKind.get(kind) ?? []), s.data])
  }
  const manifest: PackManifest = {
    kordocPack: PACK_FORMAT, name: trimmed, createdAt: new Date().toISOString(), kordocVersion: VERSION,
    kinds: { ...(into?.manifest.kinds ?? {}) }, sources: (into?.manifest.sources ?? []).filter((s) => !byKind.has(s.kind)),
  }
  const templates = new Map(into?.templates ?? [])
  for (const [kind, list] of byKind) {
    const sigs = []
    for (const [i, data] of list.entries()) {
      try { sigs.push(await templateRoleStyles(data)) } catch (e) {
        throw new KordocError(`pack: ${kind} 견본 ${i + 1}번째를 읽지 못했습니다 — ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    const pick = chooseRepresentative(sigs)
    // 다수결 상위 후보를 교차 재현 점수로 다시 줄 세운다(견본 3건 이상). 비운 견본이 원 견본과 같은 원형으로 다시 읽히는지도 확인 —
    // 어긋나면(제목 없이 요약 상자만 있는 견본 등 훑기 판정이 갈리는 꼴) 다음 견본을 쓴다. 다 어긋나면 가장 나은 견본을 쓰고 알린다
    const byVote = sigs.map((_, i) => i).sort((a, b) => pick.scores[b] - pick.scores[a] || (a === pick.index ? -1 : b === pick.index ? 1 : a - b))
    const cross = list.length >= 3 ? await crossScores(list, byVote.slice(0, XVAL_CANDIDATES)) : new Map<number, number>()
    const order = [...byVote.slice(0, XVAL_CANDIDATES)].sort((a, b) => (cross.get(b) ?? 0) - (cross.get(a) ?? 0) || byVote.indexOf(a) - byVote.indexOf(b)).concat(byVote.slice(XVAL_CANDIDATES))
    let chosen = -1, scrub: Awaited<ReturnType<typeof scrubbedTemplate>> | null = null, drift: string[] = []
    for (const i of order) {
      const cand = await scrubbedTemplate(list[i], sigs[i])
      const d = roleDrift(sigs[i], await templateRoleStyles(cand.data))
      if (chosen < 0 || (drift.length && !d.length)) { chosen = i; scrub = cand; drift = d }
      if (!d.length) break
    }
    // 골격으로 다시 만든 판이 모두 어긋나면 첫 후보의 가린 판(원 견본 구조 그대로, 글만 ○)
    if (drift.length) {
      const i = order[0], masked = await maskedTemplate(list[i])
      const d = roleDrift(sigs[i], await templateRoleStyles(masked.data))
      if (d.length < drift.length) { chosen = i; scrub = masked; drift = d }
    }
    // 팩의 역할은 비운 견본을 다시 읽은 것(실제 동작) — 원 견본에 없어 이웃 단계로 채운 단계는 역할로 치지 않는다
    const rep = sigs[chosen], actual = await templateRoleStyles(scrub!.data)
    const roles = actual.protoRoles.filter((r) => !/^L[0-3]$/.test(r) || rep.protoRoles.includes(r))
    const denom = pick.max || 1
    manifest.kinds[kind] = {
      template: `kinds/${kind}.hwpx`, samples: list.length, chosen, roles, drift,
      missing: EXPECTED.filter((r) => !roles.includes(r)),
      agreement: pick.scores.map((s) => Math.round((s / denom) * 100) / 100),
      leftover: scrub!.leftover, images: scrub!.images, bandItem: actual.bandItem, contactInTitle: actual.contactInTitle, bareSyms: actual.bareSyms,
    }
    templates.set(kind, scrub!.data)
    for (const data of list) manifest.sources.push({ kind, sha256: createHash("sha256").update(data).digest("hex") })
  }
  if (Object.keys(manifest.kinds).length > MAX_KINDS) throw new KordocError(`pack: 문서 종류는 ${MAX_KINDS}개까지`)
  const guide = guideFor(trimmed, manifest)
  const zip = new JSZip()
  zip.file("pack.json", JSON.stringify(manifest, null, 2))
  zip.file("guide.md", guide)
  for (const [kind, data] of templates) zip.file(`kinds/${kind}.hwpx`, data, { compression: "STORE" })
  return { pack: await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" }), manifest, guide }
}

/** 기관팩 읽기 — 신뢰할 수 없는 파일로 다룬다(zip 크기·경로·형식 판 검사). 견본은 생성 때 견본 방어를 한 번 더 거친다 */
export async function loadAgencyPack(data: Uint8Array | ArrayBuffer): Promise<AgencyPack> {
  const buf = data instanceof Uint8Array ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer : data
  if (buf.byteLength > MAX_PACK_BYTES) throw new KordocError("pack: 팩 파일이 너무 큽니다")
  precheckZipSize(buf, MAX_DECOMPRESS_SIZE, 64)
  let zip: JSZip
  try { zip = await JSZip.loadAsync(buf) } catch { throw new KordocError("pack: 기관팩(.kpack, zip)이 아닙니다") }
  const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir)
  const allowed = (n: string) => n === "pack.json" || n === "guide.md" || /^kinds\/[a-z0-9\-가-힣]{1,20}\.hwpx$/u.test(n)
  const bad = names.find((n) => !allowed(n))
  if (bad) throw new KordocError(`pack: 팩에 허용하지 않는 파일이 있습니다: ${bad.slice(0, 80)} (pack.json·guide.md·kinds/*.hwpx 만)`)
  if (!zip.file("pack.json")) throw new KordocError("pack: pack.json 이 없습니다")
  let used = 0
  const text = async (n: string) => { const s = await readZipEntry(zip.file(n)!, "text", used); used += s.length; return s }
  let manifest: PackManifest
  try { manifest = JSON.parse(await text("pack.json")) } catch { throw new KordocError("pack: pack.json 이 올바른 JSON 이 아닙니다") }
  if (manifest?.kordocPack !== PACK_FORMAT) throw new KordocError(`pack: 지원하지 않는 팩 형식 판 ${String(manifest?.kordocPack)} — 이 kordoc 은 ${PACK_FORMAT}판을 읽습니다`)
  if (typeof manifest.name !== "string" || !manifest.kinds || typeof manifest.kinds !== "object") throw new KordocError("pack: pack.json 에 name·kinds 가 없습니다")
  const templates = new Map<string, Uint8Array>()
  for (const [kind, info] of Object.entries(manifest.kinds)) {
    if (!KIND_RE.test(kind) || info?.template !== `kinds/${kind}.hwpx` || !zip.file(info.template)) throw new KordocError(`pack: 종류 ${kind.slice(0, 20)} 의 견본이 없습니다`)
    const bytes = await readZipEntry(zip.file(info.template)!, "uint8array", used)
    used += bytes.length
    templates.set(kind, bytes)
  }
  if (!templates.size) throw new KordocError("pack: 문서 종류가 하나도 없습니다")
  return { manifest, templates, guide: zip.file("guide.md") ? await text("guide.md") : "" }
}

/** 팩 문서 종류 정하기 — 종류를 안 주면 종류가 하나일 때 그것, 여럿이면 report */
export function resolvePackKind(pack: AgencyPack, kind?: string): string {
  const kinds = [...pack.templates.keys()]
  const k = kind ?? (kinds.length === 1 ? kinds[0] : "report")
  if (!pack.templates.has(k)) throw new KordocError(`pack: ${pack.manifest.name} 팩에 '${k}' 종류가 없습니다 — ${kinds.join("·")} 중에서 고르세요`)
  return k
}

/** 팩에서 종류별 견본 */
export function packTemplate(pack: AgencyPack, kind?: string): Uint8Array {
  return pack.templates.get(resolvePackKind(pack, kind))!
}

/** 팩 요약 — 종류마다 견본 수·대표·역할·빠진 역할·주의할 점 */
export function packSummary(m: PackManifest): string {
  const out = [`기관팩: ${m.name} (kordoc ${m.kordocVersion}, ${m.createdAt.slice(0, 10)})`]
  for (const [kind, k] of Object.entries(m.kinds)) {
    out.push(`- ${kind}: 견본 ${k.samples}건 중 ${k.chosen + 1}번째를 대표로 · 역할 ${k.roles.length}개`)
    if (k.missing.length) out.push(`  없는 역할(가까운 서식으로 대신): ${k.missing.map(roleName).join(", ")}`)
    const low = k.agreement.map((a, i) => ({ a, i })).filter((x) => x.a < 0.5).map((x) => x.i + 1)
    if (low.length && k.samples > 2) out.push(`  ⚠ 다른 서식으로 보이는 견본: ${low.join("·")}번째 — 같은 종류 문서인지 확인`)
    if (k.drift.length) out.push(`  ⚠ 비운 견본이 원 견본과 다르게 읽힘(${k.drift.join(", ")}) — 이 역할은 견본과 다르게 나올 수 있다. 같은 종류 견본을 더 넣어 다시 만들 것`)
    if (k.leftover.length) out.push(`  ⚠ 비운 견본에 남은 글 ${k.leftover.length}개(머리말·꼬리말·고정 칸 글) — 남에게 주기 전에 확인: ${k.leftover.slice(0, 5).join(" / ")}`)
    if (k.images) out.push(`  그림 ${k.images}개(로고 등) 포함 — 남에게 줄 때 사용 허락 확인`)
  }
  return out.join("\n")
}
