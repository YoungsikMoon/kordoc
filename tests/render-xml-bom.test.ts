import { describe, it } from "node:test"
import assert from "node:assert/strict"
import JSZip from "jszip"
import { renderHwpxPages } from "../src/render/index.js"
import { markdownToHwpx } from "../src/hwpx/generator.js"

describe("render: UTF-8 BOM 이 붙은 XML", () => {
  it("header·구역 XML 앞 BOM 은 파서처럼 걷고 렌더한다", async () => {
    const zip = await JSZip.loadAsync(await markdownToHwpx("BOM 문단"))
    for (const name of Object.keys(zip.files).filter(n => /Contents\/(header|section\d+)\.xml$/.test(n))) {
      zip.file(name, "﻿" + await zip.file(name)!.async("string"))
    }
    const r = await renderHwpxPages(new Uint8Array(await zip.generateAsync({ type: "nodebuffer" })), { reflow: true })
    assert.equal(r.pageSvgs.size, 1)
    assert.match(r.pageSvgs.get(1)!, /BOM/)
  })
})
