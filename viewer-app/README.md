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

The app reads JSON samples from `../data/terrains`. It uses the row-major, south-first height order and maps east, north, and elevation to X, Y, and Z.

## Controls

Choose a sample from the menu. Drag to rotate, scroll to zoom, and use the slider to change vertical exaggeration. Turn on the surface grid to show 10 m intervals. Choose **Perspective** or **Orthographic** to change projection. Click an axis on the orientation gizmo to align the view, or select **Top View** to look down from above. Select **Reset View** to restore the camera.
