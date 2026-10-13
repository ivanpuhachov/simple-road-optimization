# Terrain Viewer

A small TypeScript app that displays the terrain samples in Three.js.

## Run

Install Node.js and npm. From this folder, run:

```sh
npm install
npm run dev
```

Open the local URL printed by Vite. To create a production build, run `npm run build`.

## Data

The app reads JSON samples from `../data/terrains` and the road mesh from `../data/flat_road_example.obj`. It uses the row-major, south-first height order and maps east, north, and elevation to X, Y, and Z.

The road keeps the elevations stored in its OBJ file. The flat road example stays flat when you change the terrain sample.

The coloured X and Y arrows mark east and north on the flat XY datum plane. The origin marker shows the southwest corner, and the blue Z arrow points up.

## Controls

Choose terrain and road samples from their separate menus. Drag to rotate, scroll to zoom, and use the slider to change vertical exaggeration. Turn on the surface grid to show 10 m intervals. Choose **Perspective** or **Orthographic** to change projection. Click an axis on the orientation gizmo to align the view, or select **Top View** to look down from above. Select **Reset View** to restore the camera.
