# Road 2D Editor

A standalone route editor for creating Problem 1 road inputs. It does not modify or depend on viewer-app.

Terrain choices include the flat field, diagonal cliff, central hill, diagonal ridge, and rolling hills examples in data/terrains.

Use Import solution to choose a Problem 1 solution JSON. You can also select its input JSON and cost report JSON in the same file picker. The app uses the matching bundled terrain as the original surface when no input JSON is selected. The 3D preview lets you choose which surface to shade and shows the other as a wireframe, alongside the solved road profile. Cost details appear when a report JSON is selected.

## Run

From this folder, run npm install followed by npm run dev. Open the local URL printed by Vite. Use the Export problem 1 JSON button to download a road input file.

## Editing a route

Drag A or B directly to move an endpoint, snapping it to the nearest heightmap index. You can also choose Set A or Set B, then click a terrain grid point. Drag the P1 and P2 Bézier handles to shape the cubic curve. Update 3D preview refreshes the flat road deck and terrain in the right pane.

The road path is sampled into a fixed horizontal polyline. The export uses the Problem 0 road JSON field names (curve, terrain, constraints, and costs) so it can be read alongside the Problem 1 input. The terrain, including the selected A and B indices, is embedded in the downloaded file. Interior curve elevations are initialized from the terrain samples; Problem 1 treats only the endpoint elevations as fixed.
