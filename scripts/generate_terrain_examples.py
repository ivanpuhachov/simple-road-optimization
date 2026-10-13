#!/usr/bin/env python3
"""Generate terrain JSON/OBJ examples.

Run with:
    uv run python scripts/generate_terrain_examples.py

The JSON files store a south-first, row-major height array in metres. The OBJ
files contain the same 100 x 100 vertices as a triangulated terrain surface.
"""

from __future__ import annotations

import argparse
import json
import math
import random
from pathlib import Path
from typing import Sequence


GRID_SIZE = 100
CELL_SIZE_M = 1.0
ORIGIN_M = (0.0, 0.0)
HILL_PEAK_M = 20.0
HILL_SIGMA_M = 12.0
RIDGE_PEAK_M = 20.0
RIDGE_SIGMA_M = 6.0


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


def make_random_hills_heights(
    rng: random.Random,
    hill_count: int,
    min_width_m: float,
    max_width_m: float,
    max_height_m: float,
) -> tuple[list[float], list[dict[str, float]], float]:
    """Make randomly placed Gaussian hills, with widths measured at half height.

    The individual hills are added together, then uniformly scaled if needed
    so the resulting terrain never rises above ``max_height_m``.
    """
    hills: list[dict[str, float]] = []
    for _ in range(hill_count):
        hills.append(
            {
                "x_m": rng.uniform(0.0, (GRID_SIZE - 1) * CELL_SIZE_M),
                "y_m": rng.uniform(0.0, (GRID_SIZE - 1) * CELL_SIZE_M),
                "width_m": rng.uniform(min_width_m, max_width_m),
                "peak_height_m": rng.uniform(max_height_m * 0.4, max_height_m)
                if max_height_m > 0
                else 0.0,
            }
        )

    heights: list[float] = []
    fwhm_factor = 4.0 * math.log(2.0)
    for j in range(GRID_SIZE):
        y = ORIGIN_M[1] + j * CELL_SIZE_M
        for i in range(GRID_SIZE):
            x = ORIGIN_M[0] + i * CELL_SIZE_M
            elevation = 0.0
            for hill in hills:
                dx = x - hill["x_m"]
                dy = y - hill["y_m"]
                width = hill["width_m"]
                elevation += hill["peak_height_m"] * math.exp(
                    -fwhm_factor * (dx * dx + dy * dy) / (width * width)
                )
            heights.append(elevation)

    terrain_peak = max(heights, default=0.0)
    scale = min(1.0, max_height_m / terrain_peak) if terrain_peak > 0 else 1.0
    if scale != 1.0:
        heights = [height * scale for height in heights]
    return heights, hills, scale


def make_diagonal_ridge_heights(
    peak_height_m: float = RIDGE_PEAK_M,
    sigma_m: float = RIDGE_SIGMA_M,
) -> list[float]:
    """Convolve a Gaussian hill along the southwest-to-northeast diagonal.

    The line integral has a Gaussian cross section and smoothly rounded ends.
    Its sampled peak is normalized to ``peak_height_m``.
    """
    if sigma_m <= 0:
        raise ValueError("Ridge sigma must be greater than zero")
    if peak_height_m < 0:
        raise ValueError("Ridge peak height must be nonnegative")

    sqrt_two = math.sqrt(2.0)
    line_length = math.sqrt(2.0) * (GRID_SIZE - 1) * CELL_SIZE_M
    heights: list[float] = []
    for j in range(GRID_SIZE):
        y = ORIGIN_M[1] + j * CELL_SIZE_M
        for i in range(GRID_SIZE):
            x = ORIGIN_M[0] + i * CELL_SIZE_M
            along = (x + y) / sqrt_two
            across = (y - x) / sqrt_two
            end_integral = math.erf((line_length - along) / (sqrt_two * sigma_m))
            end_integral += math.erf(along / (sqrt_two * sigma_m))
            value = (
                sigma_m
                * math.sqrt(math.pi / 2.0)
                * math.exp(-(across * across) / (2.0 * sigma_m * sigma_m))
                * end_integral
            )
            heights.append(value)

    sampled_peak = max(heights, default=0.0)
    if sampled_peak == 0 or peak_height_m == 0:
        return [0.0] * len(heights)
    scale = peak_height_m / sampled_peak
    return [height * scale for height in heights]


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
    terrain_parameters: dict[str, object] | None = None,
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
    parser.add_argument(
        "--min-hills",
        type=int,
        default=3,
        help="minimum random hill count (default: 3)",
    )
    parser.add_argument(
        "--max-hills",
        type=int,
        default=7,
        help="maximum random hill count (default: 7)",
    )
    parser.add_argument(
        "--maxheight",
        "--max-height",
        dest="maxheight",
        type=float,
        default=25.0,
        help="maximum random terrain elevation in metres (default: 25)",
    )
    parser.add_argument(
        "--minw",
        "--min-width",
        dest="minw",
        type=float,
        default=8.0,
        help="minimum random hill full width at half maximum, in metres (default: 8)",
    )
    parser.add_argument(
        "--maxw",
        "--max-width",
        dest="maxw",
        type=float,
        default=24.0,
        help="maximum random hill full width at half maximum, in metres (default: 24)",
    )
    parser.add_argument(
        "--seed",
        type=int,
        default=42,
        help="random seed for repeatable random hills (default: 42)",
    )
    parser.add_argument(
        "--ridge-height",
        type=float,
        default=RIDGE_PEAK_M,
        help=f"diagonal ridge peak height in metres (default: {RIDGE_PEAK_M:g})",
    )
    parser.add_argument(
        "--ridge-sigma",
        type=float,
        default=RIDGE_SIGMA_M,
        help=f"diagonal ridge Gaussian sigma in metres (default: {RIDGE_SIGMA_M:g})",
    )
    args = parser.parse_args()

    if args.hill_height < 0:
        parser.error("--hill-height must be nonnegative")
    if args.hill_sigma <= 0:
        parser.error("--hill-sigma must be greater than zero")
    if args.min_hills < 0 or args.max_hills < args.min_hills:
        parser.error("hill counts must satisfy 0 <= --min-hills <= --max-hills")
    if args.maxheight < 0:
        parser.error("--maxheight must be nonnegative")
    if args.minw <= 0 or args.maxw < args.minw:
        parser.error("widths must satisfy 0 < --minw <= --maxw")
    if args.ridge_height < 0:
        parser.error("--ridge-height must be nonnegative")
    if args.ridge_sigma <= 0:
        parser.error("--ridge-sigma must be greater than zero")

    rng = random.Random(args.seed)
    random_hill_count = rng.randint(args.min_hills, args.max_hills)
    random_heights, random_hills, random_height_scale = make_random_hills_heights(
        rng,
        random_hill_count,
        args.minw,
        args.maxw,
        args.maxheight,
    )

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
    write_example(
        args.output_dir,
        "random_hills",
        "Randomly placed smooth hills on a flat base.",
        random_heights,
        {
            "seed": args.seed,
            "hill_count": random_hill_count,
            "max_height_m": args.maxheight,
            "min_width_m": args.minw,
            "max_width_m": args.maxw,
            "width_definition": "full width at half maximum",
            "height_scale": random_height_scale,
            "hills": random_hills,
        },
    )
    write_example(
        args.output_dir,
        "diagonal_ridge",
        "A Gaussian hill convolved along the southwest-to-northeast diagonal.",
        make_diagonal_ridge_heights(args.ridge_height, args.ridge_sigma),
        {
            "peak_height_m": args.ridge_height,
            "gaussian_sigma_m": args.ridge_sigma,
            "path": "southwest to northeast diagonal",
        },
    )

    print(f"Wrote terrain examples to {args.output_dir}")


if __name__ == "__main__":
    main()
