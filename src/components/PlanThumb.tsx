import { useUiStore } from '../uiStore';
import { ThumbSvg, type ThumbPlan } from './plan/ThumbSvg';

/**
 * A small static drawing of a plan (rooms, walls, openings, furniture) as
 * inline SVG — for option cards, the projects list, templates. It draws
 * whatever PlanData it is given (never the open plan) in the look the canvas
 * is using: coloured rooms and solid walls, or the plain line drawing.
 * The drawing itself is the pure <ThumbSvg>.
 */
export function PlanThumb({
  plan,
  width = 120,
  height = 90,
  showFurniture = true,
}: {
  plan: ThumbPlan;
  width?: number;
  height?: number;
  showFurniture?: boolean;
}) {
  const look = useUiStore((s) => s.drawingLook);
  return <ThumbSvg plan={plan} width={width} height={height} showFurniture={showFurniture} look={look} />;
}
