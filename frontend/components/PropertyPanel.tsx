"use client";

// 기존 PropertyPanel(마크업 속성): A. 스타일(채움·스트로크·너비)은 즉시 반영, B. 텍스트 형식은 '적용' 버튼으로 반영.
import { useEffect, useRef, useState } from "react";
import { FILL_SUGGEST, FILL_TOOLS, FONT_CHOICES, FONT_SIZE_RANGE, TEXT_TOOLS, TOOL_LABEL, WIDTH_RANGE } from "@/lib/geometry";
import type { MarkupKind, MarkupStyle } from "@/lib/types";

export type PropTarget = { kind: "markup"; mk: MarkupKind; style: MarkupStyle } | { kind: "default"; mk: MarkupKind; style: MarkupStyle } | null;

const HEX = /^#[0-9A-Fa-f]{6}$/;

function num(v: string, name: string, [lo, hi]: [number, number]): number {
  const f = Number(v.trim());
  if (v.trim() === "" || !Number.isFinite(f)) throw new Error(`${name}: 숫자가 아닙니다`);
  if (f < lo || f > hi) throw new Error(`${name}: ${lo}~${hi} 범위여야 합니다 (입력 ${f})`);
  return f;
}

export function PropertyPanel({ target, onApply, onSaveDefault, onClose }: {
  target: PropTarget;
  onApply: (part: Partial<MarkupStyle>) => void;
  onSaveDefault: (kind: MarkupKind, style: MarkupStyle) => void;
  onClose: () => void;
}) {
  const st = target?.style;
  const [fill, setFill] = useState("");
  const [nofill, setNofill] = useState(true);
  const [stroke, setStroke] = useState("#0000FF");
  const [width, setWidth] = useState("1");
  const [textColor, setTextColor] = useState("#000000");
  const [font, setFont] = useState<string>("Arial");
  const [size, setSize] = useState("12");
  const [err, setErr] = useState<string | null>(null);
  const wJob = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = () => {
    const s = st ?? { fill: null, stroke: "#0000FF", width: 1, text_color: "#000000", font: "Arial", font_size: 12 };
    setFill(s.fill ?? "");
    setNofill(!s.fill);
    setStroke(s.stroke);
    setWidth(String(s.width));
    setTextColor(s.text_color);
    setFont(s.font);
    setSize(String(s.font_size));
    setErr(null);
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(refresh, [target?.kind, target?.mk, st?.fill, st?.stroke, st?.width, st?.text_color, st?.font, st?.font_size]);

  const kind = target?.mk ?? null;
  const fillOk = kind !== null && FILL_TOOLS.includes(kind);
  const textOk = kind !== null && TEXT_TOOLS.includes(kind);

  /** A. 스타일만 검증해 즉시 반영. strict 면 오류 표시 후 기존 값으로 되돌림 */
  function applyA(over: Partial<{ fill: string; nofill: boolean; stroke: string; width: string }> = {}, strict = false): boolean {
    if (!target) return false;
    const f = over.fill ?? fill, nf = over.nofill ?? nofill, s = over.stroke ?? stroke, w = over.width ?? width;
    try {
      if (!HEX.test(s)) throw new Error("스트로크 색상: 잘못된 색상 값");
      if (!nf && fillOk && !HEX.test(f)) throw new Error("채움 색상: 잘못된 색상 값");
      const part: Partial<MarkupStyle> = { stroke: s.toUpperCase(), width: num(w, "너비", WIDTH_RANGE) };
      if (fillOk) part.fill = nf ? null : f.toUpperCase();
      if (Object.entries(part).every(([k2, v2]) => (target.style as unknown as Record<string, unknown>)[k2] === v2)) return true;
      onApply(part);
      setErr(null);
      return true;
    } catch (e) {
      if (strict) {
        setErr(`${(e as Error).message} – 기존 값은 유지됩니다.`);
        refresh();
      }
      return false;
    }
  }
  function collect(): MarkupStyle {
    if (!HEX.test(stroke) || !HEX.test(textColor) || (!nofill && !HEX.test(fill))) throw new Error("색상 값이 올바르지 않습니다");
    return {
      fill: nofill || !fillOk ? null : fill.toUpperCase(),
      stroke: stroke.toUpperCase(),
      width: num(width, "너비", WIDTH_RANGE),
      text_color: textColor.toUpperCase(),
      font,
      font_size: num(size, "글꼴 크기", FONT_SIZE_RANGE),
    };
  }
  function applyB() {
    if (!target) return;
    try {
      const s = collect();
      const part: Partial<MarkupStyle> = { stroke: s.stroke, width: s.width };
      if (fillOk) part.fill = s.fill;
      if (textOk) Object.assign(part, { text_color: s.text_color, font: s.font, font_size: s.font_size });
      onApply(part);
      setErr(null);
    } catch (e) {
      setErr(`${(e as Error).message} – 기존 값은 유지됩니다.`);
      refresh();
    }
  }
  function saveDefault() {
    if (!target) return;
    try {
      onSaveDefault(target.mk, collect());
      setErr(null);
    } catch (e) {
      setErr(`${(e as Error).message} – 기존 값은 유지됩니다.`);
    }
  }

  const color = (label: string, val: string, set: (v: string) => void, enabled: boolean, auto: boolean) => (
    <label className="block" style={{ opacity: enabled ? 1 : 0.4 }}>
      <span style={{ color: "var(--body)" }}>{label}</span>
      <input type="color" disabled={!enabled} className="block h-6 w-full cursor-pointer" value={HEX.test(val) ? val : "#FFFFFF"}
        onChange={(e) => {
          const vv = e.target.value.toUpperCase();
          set(vv);
          if (label === "채움 색상") setNofill(false);
          if (auto) applyA(label === "채움 색상" ? { fill: vv, nofill: false } : { stroke: vv });
        }} />
    </label>
  );

  return (
    <div className="absolute right-0 top-0 z-30 flex h-full w-[151px] flex-col text-xs" style={{ background: "var(--card)", border: "1px solid var(--border)" }} onPointerDown={(e) => e.stopPropagation()}>
      <div className="flex items-center px-1.5 py-1" style={{ background: "var(--border)" }}>
        <span className="sec flex-1">마크업 속성</span>
        <button type="button" onClick={onClose}>✕</button>
      </div>
      <div className="flex-1 space-y-1 overflow-y-auto p-1.5">
        <div style={{ color: target ? "var(--fg2)" : "var(--warn)" }}>
          {target?.kind === "markup" ? `선택한 마크업: ${TOOL_LABEL[target.mk]}` : target ? `도구 기본값: ${TOOL_LABEL[target.mk]} (새로 만들 마크업에 적용)` : "수정할 대상이 없습니다. 도면에서 마크업을 클릭해 선택하거나, 도구를 선택하세요."}
        </div>
        <div className="sec pt-1">A. 스타일 (즉시 반영)</div>
        {color("채움 색상", fill || FILL_SUGGEST, setFill, fillOk && !!target, true)}
        <label className="flex items-center gap-1" style={{ opacity: fillOk ? 1 : 0.4 }}>
          <input type="checkbox" disabled={!fillOk} checked={nofill} onChange={(e) => {
            const nf = e.target.checked;
            setNofill(nf);
            const f = nf ? "" : fill || FILL_SUGGEST;
            setFill(f);
            applyA({ nofill: nf, fill: f });
          }} />채움 없음
        </label>
        {color("스트로크 색상", stroke, setStroke, !!target, true)}
        <label className="block">
          <span style={{ color: "var(--body)" }}>너비 (pt)</span>
          <input className="inp block w-full" disabled={!target} value={width}
            onChange={(e) => {
              setWidth(e.target.value);
              if (wJob.current) clearTimeout(wJob.current);
              const val = e.target.value;
              wJob.current = setTimeout(() => applyA({ width: val }), 400);
            }}
            onKeyDown={(e) => e.key === "Enter" && applyA({}, true)}
            onBlur={() => !applyA({}, false) && refresh()} />
        </label>
        <div className="sec pt-1">B. 기본 텍스트 형식</div>
        {color("텍스트 색상", textColor, setTextColor, textOk, false)}
        <label className="block" style={{ opacity: textOk ? 1 : 0.4 }}>
          <span style={{ color: "var(--body)" }}>글꼴</span>
          <select className="inp block w-full" disabled={!textOk} value={font} onChange={(e) => setFont(e.target.value)}>
            {FONT_CHOICES.map((f) => <option key={f}>{f}</option>)}
          </select>
        </label>
        <label className="block" style={{ opacity: textOk ? 1 : 0.4 }}>
          <span style={{ color: "var(--body)" }}>글꼴 크기 (pt)</span>
          <input className="inp block w-full" disabled={!textOk} value={size} onChange={(e) => setSize(e.target.value)} onKeyDown={(e) => e.key === "Enter" && applyB()} />
        </label>
        {err && <div style={{ color: "var(--red)" }}>{err}</div>}
      </div>
      <div className="space-y-1 p-1.5">
        <button type="button" className="bigbtn" style={{ background: "var(--blue)", padding: 4 }} disabled={!target} onClick={applyB}>적용 (B 항목)</button>
        <button type="button" className="bigbtn" style={{ background: "var(--purple)", padding: 4 }} disabled={!target} onClick={saveDefault}>도구 기본값 저장</button>
      </div>
    </div>
  );
}
