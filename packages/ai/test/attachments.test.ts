import { describe, expect, it } from "vitest";
import { ATTACHMENT_LIMITS, checkAttachment } from "../src/index.ts";

const T = (s: string) => new TextEncoder().encode(s);
const png = () => Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const ftyp = (brand: string) => T(`\0\0\0\x18ftyp${brand}\0\0\0\0`);
const zip = (...names: string[]) => T(`PK\u0003\u0004[Content_Types].xml ${names.join(" ")}`);
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

describe("checkAttachment", () => {
  it("detects kinds by bytes", () => {
    expect(checkAttachment("", png())).toEqual({ ok: true, kind: "image", mime: "image/png" });
    expect(checkAttachment("", ftyp("isom"))).toEqual({ ok: true, kind: "video", mime: "video/mp4" });
    expect(checkAttachment("", ftyp("qt  "))).toEqual({ ok: true, kind: "video", mime: "video/quicktime" });
    expect(checkAttachment("", ftyp("M4A "))).toEqual({ ok: true, kind: "audio", mime: "audio/mp4" });
    expect(checkAttachment("video/webm", Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 1]))).toEqual({ ok: true, kind: "video", mime: "video/webm" });
    expect(checkAttachment("audio/webm", Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 1]))).toMatchObject({ kind: "audio" });
    expect(checkAttachment("", T("%PDF-1.7 x"))).toMatchObject({ kind: "document", mime: "application/pdf" });
    expect(checkAttachment("", zip("word/document.xml"))).toMatchObject({ mime: DOCX });
    expect(checkAttachment("", zip("xl/workbook.xml"))).toMatchObject({ kind: "document" });
    expect(checkAttachment("", zip("ppt/presentation.xml"))).toMatchObject({ kind: "document" });
    expect(checkAttachment("text/plain", T("hello é"))).toEqual({ ok: true, kind: "document", mime: "text/plain" });
    expect(checkAttachment("text/csv", T("a,b\n1,2"))).toEqual({ ok: true, kind: "document", mime: "text/csv" });
  });
  it("refuses spoofed, unknown and executable content", () => {
    expect(checkAttachment("image/png", Uint8Array.from([0x4d, 0x5a, 0x90, 0]))).toEqual({ ok: false, code: "executable_content" });
    expect(checkAttachment("image/png", T("\u007fELF\u0002\u0001"))).toEqual({ ok: false, code: "executable_content" });
    expect(checkAttachment("text/plain", T("#!/bin/sh\nrm -rf /"))).toEqual({ ok: false, code: "executable_content" });
    expect(checkAttachment("text/plain", T("<script>alert(1)</script>"))).toEqual({ ok: false, code: "executable_content" });
    expect(checkAttachment("text/plain", T("<!DOCTYPE html><html>"))).toEqual({ ok: false, code: "executable_content" });
    expect(checkAttachment("", zip("evil/payload.bin"))).toEqual({ ok: false, code: "unsupported_media" });
    expect(checkAttachment("", Uint8Array.from([0, 1, 2, 3, 0, 0]))).toEqual({ ok: false, code: "unsupported_media" });
    expect(checkAttachment("", Uint8Array.from([0xc3, 0x28, 0x41]))).toEqual({ ok: false, code: "unsupported_media" });
    expect(checkAttachment("", new Uint8Array())).toEqual({ ok: false, code: "empty_media" });
  });
  it("strict mode (uploads) needs the declared type to agree; channel mode ignores the label", () => {
    expect(checkAttachment("application/pdf", png(), { strict: true })).toEqual({ ok: false, code: "mime_mismatch" });
    expect(checkAttachment("application/octet-stream", png(), { strict: true })).toEqual({ ok: false, code: "unsupported_media" });
    expect(checkAttachment("image/jpg", Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]), { strict: true })).toMatchObject({ ok: true, mime: "image/jpeg" });
    expect(checkAttachment("video/mp4", ftyp("isom"), { strict: true })).toMatchObject({ ok: true });
    expect(checkAttachment("application/pdf", png())).toMatchObject({ ok: true, kind: "image" });
  });
  it("applies a cap per kind, overridable", () => {
    const big = (n: number) => { const b = new Uint8Array(n); b.set(png()); return b; };
    expect(checkAttachment("", big(ATTACHMENT_LIMITS.image + 1))).toEqual({ ok: false, code: "media_too_large" });
    expect(checkAttachment("", big(ATTACHMENT_LIMITS.image))).toMatchObject({ ok: true });
    expect(checkAttachment("", big(100), { limits: { image: 50 } })).toEqual({ ok: false, code: "media_too_large" });
    const vid = new Uint8Array(ATTACHMENT_LIMITS.video + 1); vid.set(ftyp("isom"));
    expect(checkAttachment("", vid)).toEqual({ ok: false, code: "media_too_large" });
    expect(ATTACHMENT_LIMITS).toEqual({ image: 5 << 20, audio: 20 << 20, video: 25 << 20, document: 10 << 20 });
  });
});
