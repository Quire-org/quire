/**
 * Tiles' shapes (width / height), told by their pictures as they load, for the masonry grids
 * (Browse, Tags): kept while the app runs, for the library open, so a grid left for the viewer is
 * laid out as it was when it comes back. With only the shapes near the view known again, its
 * columns would fill differently and the pictures move around.
 */
let forRoot: string | null = null;
let shapes = new Map<string, number>();

export function tileShapes(root: string | null): Map<string, number> {
  if (root !== forRoot) {
    forRoot = root;
    shapes = new Map();
  }
  return shapes;
}
