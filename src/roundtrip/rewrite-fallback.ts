/**
 * patch 로 다 못 고친 편집본의 대체본 — 원본 서식으로 문서 전체를 새로 쓴다.
 *
 * patch 는 원본 바이트를 제자리에서 고쳐 서식이 가장 정확하지만, 표 열·병합을 바꾸거나 개체가 낀 자리처럼 제자리 반영이
 * 안 되는 편집은 건너뛴다. 그때 "미적용"만 돌려주면 받는 쪽(사람·에이전트)이 칸을 비우거나 체크리스트로 미루게 된다.
 * 그래서 편집 내용을 다 담은 판을 같이 만든다: HWPX 원본은 그 문서를 견본으로(글꼴·문단·표 서식·쪽 설정 — generate
 * template 과 같은 경로), HWP 5.x 원본은 견본으로 쓸 수 없어 kordoc 기본 서식 HWPX 로.
 */

import { markdownToHwpx } from "../hwpx/generator.js"
import type { PatchResult } from "../types.js"

/** 대체본이 필요한 결과인가 — 패치 실패, 또는 글을 반영 못 한(부분 적용이 아닌) 건너뜀이 있음 */
export function needsRewrite(result: PatchResult): boolean {
  return !result.success || !result.data || result.skipped.some(s => !s.partial)
}

/** 대체본 경로 — 출력 경로 옆 `<이름>.rewrite.hwpx` */
export function rewritePath(outPath: string): string {
  return outPath.replace(/\.hwpx?$/i, "") + ".rewrite.hwpx"
}

/**
 * 편집 마크다운 전체를 원본 서식으로 새로 쓴다. plainOk 면 원본을 견본으로 못 쓸 때 kordoc 기본 서식으로라도 쓴다 — 패치가
 * 원본을 읽고도 일부를 못 고친 경우만 켠다(원본이 문서로 읽히지도 않으면 대체본도 만들지 않는다). 만들지 못하면 null
 */
export async function rewriteEdited(
  original: Uint8Array, isHwpx: boolean, markdown: string, plainOk: boolean,
): Promise<{ data: Uint8Array; templated: boolean; warnings: string[] } | null> {
  const warnings: string[] = []
  if (!isHwpx && !plainOk) return null
  try {
    const buf = await markdownToHwpx(markdown, isHwpx ? { template: original, warnings } : { warnings })
    return { data: new Uint8Array(buf), templated: isHwpx, warnings }
  } catch {
    if (!isHwpx || !plainOk) return null
    try {
      // 견본으로 못 읽는 HWPX(서식 구조 비정형) — 기본 서식으로라도 내용을 다 담는다
      const buf = await markdownToHwpx(markdown, { warnings })
      return { data: new Uint8Array(buf), templated: false, warnings }
    } catch {
      return null
    }
  }
}
