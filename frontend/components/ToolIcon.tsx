// 기존 ToolButton 의 벡터 아이콘을 SVG 로 옮김 (34×30)
import { cloudOutline, ptsToSvg } from "@/lib/geometry";
import type { MarkupKind } from "@/lib/types";

export function ToolIcon({ kind, color }: { kind: MarkupKind; color: string }) {
  const c = color;
  let body;
  switch (kind) {
    case "textbox":
      body = (<><rect x={7} y={7} width={20} height={16} fill="none" stroke={c} strokeWidth={1.5} /><text x={17} y={19} textAnchor="middle" fontFamily="Arial" fontWeight={700} fontSize={11} fill={c}>T</text></>);
      break;
    case "callout":
      body = (<><rect x={12} y={6} width={17} height={11} fill="none" stroke={c} strokeWidth={1.5} /><line x1={12} y1={12} x2={7} y2={22} stroke={c} strokeWidth={1.5} /><polygon points="5,25 6,19 10,21" fill={c} /></>);
      break;
    case "line":
      body = <line x1={7} y1={23} x2={27} y2={7} stroke={c} strokeWidth={2} />;
      break;
    case "arrow":
      body = (<><line x1={7} y1={23} x2={24} y2={10} stroke={c} strokeWidth={2} /><polygon points="27,7 18,10 23,15" fill={c} /></>);
      break;
    case "rect":
      body = <rect x={7} y={8} width={20} height={14} fill="none" stroke={c} strokeWidth={2} />;
      break;
    case "ellipse":
      body = <ellipse cx={17} cy={15} rx={10} ry={7} fill="none" stroke={c} strokeWidth={2} />;
      break;
    case "polygon":
      body = <polygon points="8,22 10,9 20,6 27,15 22,23" fill="none" stroke={c} strokeWidth={2} />;
      break;
    case "cloud":
      body = <polyline points={ptsToSvg(cloudOutline(0, 0, 20, 12, 4.5).map(([x, y]) => [7 + x + 0.5, 9 + y + 0.5]))} fill="none" stroke={c} strokeWidth={1.3} />;
      break;
  }
  return <svg width={34} height={30} viewBox="0 0 34 30" aria-hidden>{body}</svg>;
}
