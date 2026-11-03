/** Types for mockPictures.js (plain JS, so the end-to-end file server can use it as it is). */
export interface MockWho {
  label: string;
  kind: "photo" | "drawn";
  skin: string;
  hair: string;
  bg: [string, string];
}
export const MOCK_WHO: MockWho[];
export function mockPicture(rel: string): { who: MockWho; width: number; height: number; bbox: [number, number, number, number]; score: number; size: number };
export function mockSvg(rel: string, face?: { bbox: number[]; around: number }): string;
