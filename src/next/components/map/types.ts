/**
 * The canvas map's contract with the UI (§11.5). The map reads one MapFrame per
 * drawn frame through `getFrame()`, reports input through MapInputHandlers and
 * hands back a MapHandle for camera moves; nothing else crosses the boundary.
 */
import type { ArmyId, MapMode, OrderPreview, ProvinceIx, Sim } from '@/next/game/types';

/** Base space to CSS pixels: screen = k x base + (x, y). */
export interface Camera {
  k: number;
  x: number;
  y: number;
}
export interface MapFrame {
  sim: Sim;
  alpha: number;
  selectedArmies: ReadonlySet<ArmyId>;
  selectedProvince: ProvinceIx | null;
  hover: ProvinceIx | null;
  preview: OrderPreview | null;
  mode: MapMode;
  showAll: boolean;
  highlights: readonly ProvinceIx[];
  coarse: boolean;
}
export interface MapInputHandlers {
  tapMarker(armies: readonly ArmyId[], additive: boolean): void;
  tapProvince(p: ProvinceIx, additive: boolean): void;
  secondary(p: ProvinceIx, append: boolean): void;
  longPressMarker(armies: readonly ArmyId[]): void;
  longPressProvince(p: ProvinceIx): void;
  box(armies: readonly ArmyId[], additive: boolean): void;
  hover(p: ProvinceIx | null): void;
  dragOrder(armies: readonly ArmyId[], p: ProvinceIx): void;
  cameraChanged(camera: Camera, gesturing: boolean): void;
}
export interface MapHandle {
  frameProvinces(ps: readonly ProvinceIx[], ms: number): void;
  zoomBy(factor: number): void;
  home(): void;
}
