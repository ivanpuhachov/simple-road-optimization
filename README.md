# Road Optimizer

`road-editor-solver-app` is a web app for planning a road on a terrain map. Set the route, road limits, and cost rates in the 2D editor. Use **Solve** to find road heights, or **Solve with 2D displacement** to also move the route sideways. The app shows the result on a 3D terrain view.

## Requirements

Python 3.14 or newer, `uv`, Node.js, and npm.

## Run

In a terminal at the repository root, install the Python packages and start the API:

```sh
uv sync
uv run uvicorn server:app --app-dir road-editor-solver-app --port 8765
```

In a second terminal, start the web app:

```sh
cd road-editor-solver-app
npm ci
npm run dev
```

Open the URL shown by Vite. The web app sends solve requests to the API at `127.0.0.1:8765`.

See the [app README](road-editor-solver-app/README.md) for more details.
