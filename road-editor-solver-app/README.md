# Road Editor + Solver

Edit a cubic Bézier road route and solve its elevation profile with the existing
Problem 1 optimizer. **Solve with 2D displacement** runs the Problem 2 search,
which can move interior road vertices sideways before solving their elevations.
It displays the displaced road and graded terrain, then resets the 3D camera to
a north-up top view. The app retains the 2D editor's terrain choices, endpoint
controls, cost inputs, JSON export/import, and 3D terrain comparison.

The **Curve sample spacing** control sets the maximum distance between adjacent
road vertices along the Bézier curve. The default is 3 m; smaller spacing creates
more optimization variables and can take longer, especially for the 2D search.
It is separate from the solver's 0.25 m earthwork quadrature step. The app
limits a route to 200 segments. The 2D solver uses its default 3 m lateral
offset bound and a budget of 60 candidate evaluations.

## Run locally

From the repository root, install Python dependencies and start the API:

```sh
uv sync
uv run uvicorn server:app --app-dir road-editor-solver-app --port 8765
```

In another terminal, start the frontend:

```sh
cd road-editor-solver-app
npm ci
npm run dev
```

Open the URL printed by Vite. Vite proxies `/api/solve` and `/api/solve-2d` to
the API at `127.0.0.1:8765`.

For a single server after development, run `npm run build` in this directory,
then start the same Uvicorn command from the repository root and open
`http://127.0.0.1:8765`.

The bundled sample terrain JSON files live in `public/terrains`. The solver
uses temporary files per request and does not write solutions into `data/`.
The original CLIs in `scripts/solve_problem1.py` and `scripts/solve_problem2.py`
remain available.
