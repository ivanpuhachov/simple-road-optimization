#!/usr/bin/env python3
"""Create an OBJ surface mesh for a road polyline.

The road JSON contains a ``curve`` array of [x, y, z] vertices. The separate
constraints JSON contains ``w`` (or a nested ``constraints.w``), the road width
in metres. By default, the OBJ is written next to the road JSON.

Run with:
    uv run python scripts/generate_road_obj.py data/flat_road_example.json data/flat_road_constraints.json
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path
from typing import Any, Mapping, Sequence


Point2 = tuple[float, float]
Point3 = tuple[float, float, float]
EPSILON = 1e-12


def number(value: Any, name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{name} must be a number")
    result = float(value)
    if not math.isfinite(result):
        raise ValueError(f"{name} must be finite")
    return result


def parse_vertex(value: Any, index: int) -> Point3:
    if isinstance(value, Mapping):
        values = (value.get("x"), value.get("y"), value.get("z"))
    elif isinstance(value, Sequence) and not isinstance(value, (str, bytes)):
        values = value
    else:
        raise ValueError(f"curve[{index}] must be [x, y, z] or an object with x, y, z")
    if len(values) != 3:
        raise ValueError(f"curve[{index}] must contain exactly three coordinates")
    return tuple(number(values[i], f"curve[{index}][{i}]") for i in range(3))  # type: ignore[return-value]


def load_curve(path: Path) -> list[Point3]:
    with path.open(encoding="utf-8") as handle:
        document = json.load(handle)
    raw_curve = document.get("curve") if isinstance(document, Mapping) else document
    if not isinstance(raw_curve, list) or len(raw_curve) < 2:
        raise ValueError("road JSON must contain at least two curve vertices")
    return [parse_vertex(vertex, index) for index, vertex in enumerate(raw_curve)]


def load_width(path: Path) -> float:
    with path.open(encoding="utf-8") as handle:
        document = json.load(handle)
    if not isinstance(document, Mapping):
        raise ValueError("constraints JSON must be an object")
    constraints = document.get("constraints", document)
    if not isinstance(constraints, Mapping):
        raise ValueError('constraints JSON "constraints" field must be an object')
    width = number(constraints.get("w"), "constraints.w")
    if width <= 0:
        raise ValueError("road width w must be greater than zero")
    return width


def subtract(a: Point2, b: Point2) -> Point2:
    return (a[0] - b[0], a[1] - b[1])


def dot(a: Point2, b: Point2) -> float:
    return a[0] * b[0] + a[1] * b[1]


def norm(a: Point2) -> float:
    return math.hypot(a[0], a[1])


def cross_section_normals(curve: Sequence[Point3]) -> list[Point2]:
    directions: list[Point2] = []
    for index, (start, end) in enumerate(zip(curve, curve[1:])):
        vector = (end[0] - start[0], end[1] - start[1])
        length = norm(vector)
        if length <= EPSILON:
            raise ValueError(f"curve segment {index} has zero horizontal length")
        directions.append((vector[0] / length, vector[1] / length))

    tangents = [directions[0]]
    for index in range(1, len(curve) - 1):
        incoming = directions[index - 1]
        outgoing = directions[index]
        summed = (incoming[0] + outgoing[0], incoming[1] + outgoing[1])
        summed_length = norm(summed)
        if summed_length <= EPSILON:
            raise ValueError(f"curve vertex {index} is an exact reversal")
        tangents.append((summed[0] / summed_length, summed[1] / summed_length))
    tangents.append(directions[-1])
    return [(-tangent[1], tangent[0]) for tangent in tangents]


def interpolate_normal(start: Point2, end: Point2, t: float, segment: int) -> Point2:
    x = (1.0 - t) * start[0] + t * end[0]
    y = (1.0 - t) * start[1] + t * end[1]
    length = math.hypot(x, y)
    if length <= EPSILON:
        raise ValueError(f"cross-section interpolation is undefined on segment {segment}")
    return (x / length, y / length)


def write_road_obj(path: Path, curve: Sequence[Point3], width: float, sample_step_m: float) -> tuple[int, int]:
    normals = cross_section_normals(curve)
    vertices: list[Point3] = []
    faces: list[tuple[int, int, int]] = []
    previous_row: tuple[int, int] | None = None
    half_width = width / 2.0

    for segment, (start, end) in enumerate(zip(curve, curve[1:])):
        horizontal_length = math.hypot(end[0] - start[0], end[1] - start[1])
        sample_count = max(1, math.ceil(horizontal_length / sample_step_m))
        first_sample = 0 if segment == 0 else 1
        for sample in range(first_sample, sample_count + 1):
            t = sample / sample_count
            normal = interpolate_normal(normals[segment], normals[segment + 1], t, segment)
            center_x = (1.0 - t) * start[0] + t * end[0]
            center_y = (1.0 - t) * start[1] + t * end[1]
            elevation = (1.0 - t) * start[2] + t * end[2]
            left_index = len(vertices) + 1
            vertices.append(
                (center_x - half_width * normal[0], center_y - half_width * normal[1], elevation)
            )
            right_index = len(vertices) + 1
            vertices.append(
                (center_x + half_width * normal[0], center_y + half_width * normal[1], elevation)
            )

            current_row = (left_index, right_index)
            if previous_row is not None:
                previous_left, previous_right = previous_row
                current_left, current_right = current_row
                # Across each quad, triangles wind upward for a positively
                # oriented strip (the same convention as Problem 0's Jacobian).
                faces.append((previous_left, current_left, current_right))
                faces.append((previous_left, current_right, previous_right))
            previous_row = current_row

    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="\n") as handle:
        handle.write(f"# Road surface mesh, width {width:g} m\n")
        handle.write("o road_surface\n")
        for x, y, z in vertices:
            handle.write(f"v {x:.6f} {y:.6f} {z:.6f}\n")
        for a, b, c in faces:
            handle.write(f"f {a} {b} {c}\n")
    return len(vertices), len(faces)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("road_json", type=Path, help="JSON file containing the curve")
    parser.add_argument("constraints_json", type=Path, help="JSON file containing road width w")
    parser.add_argument(
        "--output",
        type=Path,
        help="OBJ output path (default: road JSON path with .obj extension)",
    )
    parser.add_argument(
        "--step-m",
        type=float,
        default=1.0,
        help="maximum distance between road cross-sections in metres (default: 1)",
    )
    args = parser.parse_args()
    if not math.isfinite(args.step_m) or args.step_m <= 0:
        parser.error("--step-m must be finite and greater than zero")

    output_path = args.output or args.road_json.with_suffix(".obj")
    try:
        curve = load_curve(args.road_json)
        width = load_width(args.constraints_json)
        vertex_count, face_count = write_road_obj(output_path, curve, width, args.step_m)
    except (OSError, json.JSONDecodeError, ValueError) as error:
        print(json.dumps({"status": "invalid_input", "error": str(error)}, indent=2))
        return 2

    print(
        json.dumps(
            {
                "status": "written",
                "obj_file": str(output_path),
                "width_m": width,
                "vertices": vertex_count,
                "triangles": face_count,
            },
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
