#!/usr/bin/env python3
"""Generate flat and centered-hill terrain JSON/OBJ examples.

Run with:
    uv run python scripts/generate_terrain_examples.py

The JSON files store a south-first, row-major height array in metres. The OBJ
files contain the same 100 x 100 vertices as a triangulated terrain surface.
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Sequence


GRID_SIZE = 100
CELL_SIZE_M = 1.0
ORIGIN_M = (0.0, 0.0)
HILL_PEAK_M = 20.0
HILL_SIGMA_M = 12.0


def make_flat_heights() -> list[float]:
    return [0.0] * (GRID_SIZE * GRID_SIZE)


def make_centered_hill_heights(
    peak_height_m: float = HILL_PEAK_M,
    sigma_m: float = HILL_SIGMA_M,
) -> list[float]:
    """Return a smooth Gaussian hill centered on the middle of the grid."""
    if sigma_m <= 0:
        raise ValueError("Hill sigma must be greater than zero")

    center = (GRID_SIZE - 1) / 2
    heights: list[float] = []
    for j in range(GRID_SIZE):
        for i in range(GRID_SIZE):
            dx = (i - center) * CELL_SIZE_M
            dy = (j - center) * CELL_SIZE_M
            r_squared = dx * dx + dy * dy
            height = peak_height_m * math.exp(-r_squared / (2 * sigma_m**2))
            heights.append(height)
    return heights


def write_obj(path: Path, heights: Sequence[float], object_name: str) -> None:
    """Write a triangulated OBJ whose winding faces upward (+z)."""
    lines = [f"o {object_name}"]
    for j in range(GRID_SIZE):
        y = ORIGIN_M[1] + j * CELL_SIZE_M
        for i in range(GRID_SIZE):
            x = ORIGIN_M[0] + i * CELL_SIZE_M
            z = heights[j * GRID_SIZE + i]
            lines.append(f"v {x:.6f} {y:.6f} {z:.6f}")

    # OBJ indices are one-based. Each grid cell is split along its southwest
    # to northeast diagonal; both triangles have upward-facing winding.
    for j in range(GRID_SIZE - 1):
        for i in range(GRID_SIZE - 1):
            southwest = j * GRID_SIZE + i + 1
            southeast = southwest + 1
            northwest = southwest + GRID_SIZE
            northeast = northwest + 1
            lines.append(f"f {southwest} {southeast} {northeast}")
            lines.append(f"f {southwest} {northeast} {northwest}")

    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def write_example(
    output_dir: Path,
    name: str,
    description: str,
    heights: Sequence[float],
    terrain_parameters: dict[str, float] | None = None,
) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    obj_path = output_dir / f"{name}.obj"
    json_path = output_dir / f"{name}.json"
    write_obj(obj_path, heights, name)

    terrain: dict[str, object] = {"type": name, "description": description}
    if terrain_parameters:
        terrain["parameters"] = terrain_parameters

    document = {
        "terrain": terrain,
        "heightmap": {
            "width": GRID_SIZE,
            "height": GRID_SIZE,
            "origin_m": list(ORIGIN_M),
            "cell_size_m": [CELL_SIZE_M, CELL_SIZE_M],
            "units": "m",
            "indexing": "row-major, south row first; index = 100 * j + i",
            "heights": list(heights),
        },
        "obj_file": obj_path.name,
        "A": 0,
        "B": GRID_SIZE * GRID_SIZE - 1,
        "w": 5.0,
        "maxs": 0.1,
        "maxc": 0.1,
        "earth_dig": 1.0,
        "earth_fill": 1.0,
    }
    json_path.write_text(
        json.dumps(document, indent=2, allow_nan=False) + "\n", encoding="utf-8"
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path("data/terrains"),
        help="directory for the JSON and OBJ files (default: data/terrains)",
    )
    parser.add_argument(
        "--hill-height",
        type=float,
        default=HILL_PEAK_M,
        help=f"centered hill peak height in metres (default: {HILL_PEAK_M:g})",
    )
    parser.add_argument(
        "--hill-sigma",
        type=float,
        default=HILL_SIGMA_M,
        help=f"centered hill Gaussian sigma in metres (default: {HILL_SIGMA_M:g})",
    )
    args = parser.parse_args()

    if args.hill_height < 0:
        parser.error("--hill-height must be nonnegative")
    if args.hill_sigma <= 0:
        parser.error("--hill-sigma must be greater than zero")

    write_example(
        args.output_dir,
        "flat",
        "Flat terrain at 0 m elevation.",
        make_flat_heights(),
    )
    write_example(
        args.output_dir,
        "centered_hill",
        "A single smooth hill centered on the 99 m by 99 m grid.",
        make_centered_hill_heights(args.hill_height, args.hill_sigma),
        {"peak_height_m": args.hill_height, "gaussian_sigma_m": args.hill_sigma},
    )

    print(f"Wrote terrain examples to {args.output_dir}")


if __name__ == "__main__":
    main()
