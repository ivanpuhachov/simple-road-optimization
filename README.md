# Road Optimizer

`road-editor-solver-app` is a web app for planning a road on a terrain map. Set the route, road limits, and cost rates in the 2D editor. Use **Solve** to find road heights, or **Solve with 2D displacement** to also move the route sideways. The app shows the result on a 3D terrain view.

## Requirements

Python 3.14 or newer, `uv`, Node.js, npm, and tmux.

## Run

From the repository root, install the Python and web app packages:

```sh
./install.sh
```

Start the API and web app in one tmux session:

```sh
./run.sh
```

Open `http://127.0.0.1:5173`. Detach from tmux with Ctrl-B, then D. Run `./run.sh` to join the running session, or `./run.sh -r` to restart both servers. The web app sends solve requests to the API at `127.0.0.1:8765`.

See the [app README](road-editor-solver-app/README.md) for more details.
