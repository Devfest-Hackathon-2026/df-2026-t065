import type { PageInstance } from "./cdp";

export const EXPECTED_UPRIGHT_WIDTH: number;
export const EXPECTED_UPRIGHT_HEIGHT: number;

export const EXPECTED_CROP_X: number;
export const EXPECTED_CROP_Y: number;
export const EXPECTED_CROP_WIDTH: number;
export const EXPECTED_CROP_HEIGHT: number;

export type OrientationConfig = {
  w: number;
  h: number;
  name: string;
};

export const ORIENTATION_CONFIGS: Record<number, OrientationConfig>;
export const COLOR_RGB: Record<string, [number, number, number]>;

export function isRed(rgb: number[]): boolean;
export function isGreen(rgb: number[]): boolean;
export function isBlue(rgb: number[]): boolean;
export function isYellow(rgb: number[]): boolean;
export function assertUprightQuadrants(tl: number[], tr: number[], bl: number[], br: number[], label?: string): void;

export type CropSamplePixels = {
  leftEdgeMid: number[];
  rightEdgeMid: number[];
  topEdgeMid: number[];
  bottomEdgeMid: number[];
  center: number[];
  topLeft: number[];
  topRight: number[];
  bottomLeft: number[];
  bottomRight: number[];
};

export function assertCropBoundaryPixels(crop: CropSamplePixels, label?: string): void;

export function generateSyntheticExifJpegs(page: PageInstance): Promise<Record<number, Buffer>>;
