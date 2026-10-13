#!/usr/bin/env python3
"""Calculate Problem 0 earthwork volumes and road cost from a road JSON file.

The input format is the same as for check_road_constraints.py. The checker
validates the road before integration. Grade or curvature violations leave
the road invalid but do not prevent a cost estimate.

Run with:
    uv run python scripts/calculate_road_cost.py road.json
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path
from typing import Any, Sequence

import numpy as np

if __package__:
    from .check_road_constraints import (
        GEOMETRY_EPSILON,
        Heightmap,
        MissingParameterError,
        check_road,
        load_input,
    )
else:
    from check_road_constraints import (
        GEOMETRY_EPSILON,
        Heightmap,
        MissingParameterError,
        check_road,
        load_input,
    )


MAX_BATCH_POINTS = 65536
BOUNDARY_TOLERANCE_M = 1e-9


class IntegrationGeometryError(ValueError):
    """An integration point violates the road strip geometry."""


def vertex_normals(curve: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    vectors = np.diff(curve[:, :2], axis=0)
    lengths = np.linalg.norm(vectors, axis=1)
    if np.any(lengths <= GEOMETRY_EPSILON):
        raise IntegrationGeometryError("a road segment has zero horizontal length")
    directions = vectors / lengths[:, None]
    tangents = np.empty_like(curve[:, :2])
    tangents[0] = directions[0]
    tangents[-1] = directions[-1]
    if len(curve) > 2:
        middle = directions[:-1] + directions[1:]
        middle_lengths = np.linalg.norm(middle, axis=1)
        if np.any(middle_lengths <= GEOMETRY_EPSILON):
            raise IntegrationGeometryError("a road vertex is an exact reversal")
        tangents[1:-1] = middle / middle_lengths[:, None]
    return np.column_stack((-tangents[:, 1], tangents[:, 0])), lengths


def ground_height(x: np.ndarray, y: np.ndarray, terrain: np.ndarray) -> np.ndarray:
    i = np.minimum(np.floor(x).astype(np.intp), terrain.shape[1] - 2)
    j = np.minimum(np.floor(y).astype(np.intp), terrain.shape[0] - 2)
    fx = x - i
    fy = y - j
    return (
        (1.0 - fx) * (1.0 - fy) * terrain[j, i]
        + fx * (1.0 - fy) * terrain[j, i + 1]
        + (1.0 - fx) * fy * terrain[j + 1, i]
        + fx * fy * terrain[j + 1, i + 1]
    )


def integrate_segment(
    start: np.ndarray,
    end: np.ndarray,
    normal_start: np.ndarray,
    normal_end: np.ndarray,
    heightmap: Heightmap,
    terrain: np.ndarray,
    width: float,
    t_count: int,
    u_count: int,
    segment_index: int,
) -> tuple[float, float]:
    vector = end - start
    normal_delta = normal_end - normal_start
    u = -width / 2.0 + (np.arange(u_count) + 0.5) * width / u_count
    row_count = max(1, MAX_BATCH_POINTS // u_count)
    cut_parts: list[float] = []
    fill_parts: list[float] = []
    origin_x, origin_y = heightmap.origin
    cell_x, cell_y = heightmap.cell_size
    max_x, max_y = heightmap.max_x, heightmap.max_y

    for row_start in range(0, t_count, row_count):
        row_end = min(t_count, row_start + row_count)
        t = (np.arange(row_start, row_end) + 0.5) / t_count
        raw_normal = normal_start[None, :] + t[:, None] * normal_delta[None, :]
        raw_length = np.linalg.norm(raw_normal, axis=1)
        if np.any(raw_length <= GEOMETRY_EPSILON):
            raise IntegrationGeometryError(
                f"segment {segment_index} has an undefined cross section"
            )
        normal = raw_normal / raw_length[:, None]
        projection = np.sum(raw_normal * normal_delta[None, :], axis=1)
        normal_derivative = (
            normal_delta[None, :] / raw_length[:, None]
            - raw_normal * (projection / raw_length**3)[:, None]
        )

        center_x = start[0] + t * vector[0]
        center_y = start[1] + t * vector[1]
        x = center_x[:, None] + normal[:, 0, None] * u[None, :]
        y = center_y[:, None] + normal[:, 1, None] * u[None, :]
        if (
            np.any(x < origin_x - BOUNDARY_TOLERANCE_M)
            or np.any(x > max_x + BOUNDARY_TOLERANCE_M)
            or np.any(y < origin_y - BOUNDARY_TOLERANCE_M)
            or np.any(y > max_y + BOUNDARY_TOLERANCE_M)
        ):
            raise IntegrationGeometryError(
                f"segment {segment_index} has an integration point outside the heightmap"
            )
        x_grid = np.clip((x - origin_x) / cell_x, 0.0, heightmap.width - 1.0)
        y_grid = np.clip((y - origin_y) / cell_y, 0.0, heightmap.height - 1.0)

        base_jacobian = vector[0] * normal[:, 1] - vector[1] * normal[:, 0]
        normal_jacobian = (
            normal_derivative[:, 0] * normal[:, 1]
            - normal_derivative[:, 1] * normal[:, 0]
        )
        jacobian = base_jacobian[:, None] + normal_jacobian[:, None] * u[None, :]
        if np.any(jacobian <= GEOMETRY_EPSILON):
            raise IntegrationGeometryError(
                f"segment {segment_index} folds at an integration point"
            )

        road_z = start[2] + t[:, None] * vector[2]
        difference = ground_height(x_grid, y_grid, terrain) - road_z
        panel_area = width / (t_count * u_count)
        cut_parts.append(float(np.sum(np.maximum(difference, 0.0) * jacobian) * panel_area))
        fill_parts.append(float(np.sum(np.maximum(-difference, 0.0) * jacobian) * panel_area))

    return math.fsum(cut_parts), math.fsum(fill_parts)


def integrate_level(
    curve: np.ndarray,
    normals: np.ndarray,
    lengths: np.ndarray,
    heightmap: Heightmap,
    terrain: np.ndarray,
    width: float,
    initial_step_m: float,
    refinement: int,
) -> tuple[np.ndarray, int]:
    scale = 1 << refinement
    u_count = max(1, math.ceil(width / initial_step_m)) * scale
    volumes = np.empty((len(lengths), 2), dtype=np.float64)
    panel_count = 0
    for index, length in enumerate(lengths):
        t_count = max(1, math.ceil(float(length) / initial_step_m)) * scale
        volumes[index] = integrate_segment(
            curve[index],
            curve[index + 1],
            normals[index],
            normals[index + 1],
            heightmap,
            terrain,
            width,
            t_count,
            u_count,
            index,
        )
        panel_count += t_count * u_count
    return volumes, panel_count


def integrate_volumes(
    curve: np.ndarray,
    heightmap: Heightmap,
    width: float,
    initial_step_m: float,
    absolute_tolerance_m3: float,
    relative_tolerance: float,
    max_refinements: int,
) -> tuple[tuple[float, float] | None, dict[str, Any]]:
    normals, lengths = vertex_normals(curve)
    terrain = np.asarray(heightmap.heights, dtype=np.float64).reshape(
        heightmap.height, heightmap.width
    )
    previous, _ = integrate_level(
        curve, normals, lengths, heightmap, terrain, width, initial_step_m, 0
    )
    for refinement in range(1, max_refinements + 1):
        current, panel_count = integrate_level(
            curve, normals, lengths, heightmap, terrain, width, initial_step_m, refinement
        )
        cut = math.fsum(float(value) for value in current[:, 0])
        fill = math.fsum(float(value) for value in current[:, 1])
        change = np.sum(np.abs(current - previous), axis=0)
        cut_change, fill_change = float(change[0]), float(change[1])
        info = {
            "method": "composite midpoint; each refinement halves both grid steps",
            "error_estimate_note": "The sum of absolute segment changes between the last two grids is empirical, not a guaranteed error bound.",
            "initial_step_m": initial_step_m,
            "absolute_tolerance_m3": absolute_tolerance_m3,
            "relative_tolerance": relative_tolerance,
            "refinements": refinement,
            "panel_count": panel_count,
            "estimated_error_m3": {"cut": cut_change, "fill": fill_change},
            "last_estimate_m3": {"cut": cut, "fill": fill},
        }
        if (
            cut_change <= absolute_tolerance_m3 + relative_tolerance * cut
            and fill_change <= absolute_tolerance_m3 + relative_tolerance * fill
        ):
            info["converged"] = True
            return (cut, fill), info
        previous = current
    info["converged"] = False
    return None, info


def calculate(
    road_file: Path,
    initial_step_m: float,
    absolute_tolerance_m3: float,
    relative_tolerance: float,
    max_refinements: int,
) -> dict[str, Any]:
    if not math.isfinite(initial_step_m) or initial_step_m <= 0:
        raise ValueError("initial step must be finite and greater than zero")
    if not math.isfinite(absolute_tolerance_m3) or absolute_tolerance_m3 < 0:
        raise ValueError("absolute volume tolerance must be finite and nonnegative")
    if not math.isfinite(relative_tolerance) or relative_tolerance < 0:
        raise ValueError("relative volume tolerance must be finite and nonnegative")
    if max_refinements < 1:
        raise ValueError("max refinements must be at least one")

    vertices, heightmap, terrain_document, constraints, rates = load_input(road_file)
    check = check_road(vertices, heightmap, terrain_document, constraints)
    result: dict[str, Any] = {
        "status": check["status"],
        "valid": check["valid"],
        "checks": check["checks"],
        "length_m": None,
        "volumes_m3": None,
        "cost_components": None,
        "total_cost": None,
        "integration": None,
    }
    if not check["checks"]["path_geometry"]["valid"] or not check["checks"]["road_strip"]["valid"]:
        result["error"] = "cost is undefined because the path or road strip is invalid"
        return result

    curve = np.asarray(vertices, dtype=np.float64)
    length = float(np.sum(np.linalg.norm(np.diff(curve, axis=0), axis=1)))
    result["length_m"] = length
    try:
        volumes, integration = integrate_volumes(
            curve,
            heightmap,
            constraints["w"],
            initial_step_m,
            absolute_tolerance_m3,
            relative_tolerance,
            max_refinements,
        )
    except IntegrationGeometryError as error:
        result["status"] = "invalid"
        result["valid"] = False
        result["error"] = str(error)
        return result
    result["integration"] = integration
    if volumes is None:
        result["status"] = "numerical_failure"
        result["valid"] = False
        result["error"] = "volume estimates did not reach the requested tolerance"
        return result

    cut, fill = volumes
    imported = max(fill - cut, 0.0)
    exported = max(cut - fill, 0.0)
    components = {
        "road_build": rates["rb"] * length,
        "earth_dig": rates["ed"] * cut,
        "earth_fill": rates["ef"] * fill,
        "earth_import": rates["ei"] * imported,
        "earth_export": rates["ex"] * exported,
    }
    result["volumes_m3"] = {
        "cut": cut,
        "fill": fill,
        "import": imported,
        "export": exported,
    }
    result["cost_components"] = components
    result["total_cost"] = math.fsum(components.values())
    return result


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("road_json", type=Path, help="road input JSON")
    parser.add_argument(
        "--initial-step-m",
        type=float,
        default=0.5,
        help="maximum initial integration panel width in metres (default: 0.5)",
    )
    parser.add_argument(
        "--volume-atol-m3",
        type=float,
        default=0.01,
        help="absolute tolerance for each volume in cubic metres (default: 0.01)",
    )
    parser.add_argument(
        "--volume-rtol",
        type=float,
        default=1e-4,
        help="relative tolerance for each volume (default: 0.0001)",
    )
    parser.add_argument(
        "--max-refinements",
        type=int,
        default=5,
        help="maximum grid refinements after the initial grid (default: 5)",
    )
    args = parser.parse_args(argv)

    try:
        result = calculate(
            args.road_json,
            args.initial_step_m,
            args.volume_atol_m3,
            args.volume_rtol,
            args.max_refinements,
        )
    except MissingParameterError as error:
        print(f"Missing required parameter(s): {', '.join(error.parameters)}", file=sys.stderr)
        result = {"status": "invalid_input", "valid": False, "error": str(error)}
    except (OSError, json.JSONDecodeError, ValueError, OverflowError) as error:
        result = {"status": "invalid_input", "valid": False, "error": str(error)}

    print(json.dumps(result, indent=2, allow_nan=False))
    return {
        "valid": 0,
        "invalid": 1,
        "invalid_input": 2,
        "numerical_failure": 3,
    }[result["status"]]


if __name__ == "__main__":
    sys.exit(main())
