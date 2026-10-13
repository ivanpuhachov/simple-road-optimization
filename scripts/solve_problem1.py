#!/usr/bin/env python3
"""Optimize road elevations for a fixed horizontal path.

Read the road JSON exported by road-2d-editor-app. Only interior road
elevations change. Save the optimized curve and graded heightmap in the
same road JSON structure. Save costs against the original terrain separately.

Run with:
    uv run python scripts/solve_problem1.py data/problem1-road-input.json
"""

from __future__ import annotations

import argparse
import copy
import json
import math
import sys
from pathlib import Path
from typing import Any, Mapping, Sequence

import cvxpy as cp
import numpy as np
from scipy import sparse

if __package__:
    from .calculate_road_cost import (
        BOUNDARY_TOLERANCE_M,
        IntegrationGeometryError,
        ground_height,
        integrate_volumes,
        vertex_normals,
    )
    from .check_road_constraints import (
        GEOMETRY_EPSILON,
        Heightmap,
        MissingParameterError,
        check_road,
        load_input,
    )
else:
    from calculate_road_cost import (
        BOUNDARY_TOLERANCE_M,
        IntegrationGeometryError,
        ground_height,
        integrate_volumes,
        vertex_normals,
    )
    from check_road_constraints import (
        GEOMETRY_EPSILON,
        Heightmap,
        MissingParameterError,
        check_road,
        load_input,
    )


MAX_QUADRATURE_POINTS = 50000
GRADE_FEASIBILITY_TOLERANCE_M = 1e-9
MAX_SOLVER_ADJUSTMENT_M = 1e-4
FOOTPRINT_TOLERANCE_M = 1e-9


def output_path_for(input_path: Path) -> Path:
    stem = input_path.stem
    if stem.endswith("-input"):
        stem = stem[:-6]
    return input_path.with_name(stem + "-solution.json")


def report_path_for(output_path: Path) -> Path:
    stem = output_path.stem
    if stem.endswith("-solution"):
        stem = stem[:-9]
    return output_path.with_name(stem + "-report.json")


def build_quadrature(
    curve: np.ndarray,
    heightmap: Heightmap,
    width: float,
    step_m: float,
) -> tuple[sparse.csr_matrix, np.ndarray, np.ndarray, np.ndarray]:
    normals, lengths = vertex_normals(curve)
    t_counts = np.maximum(1, np.ceil(lengths / step_m).astype(np.intp))
    u_count = max(1, math.ceil(width / step_m))
    point_count = int(np.sum(t_counts) * u_count)
    if point_count > MAX_QUADRATURE_POINTS:
        raise ValueError(
            f"quadrature needs {point_count} points; increase --quadrature-step-m"
        )

    terrain = np.asarray(heightmap.heights, dtype=np.float64).reshape(
        heightmap.height, heightmap.width
    )
    u = -width / 2.0 + (np.arange(u_count) + 0.5) * width / u_count
    ground_parts: list[np.ndarray] = []
    weight_parts: list[np.ndarray] = []
    t_parts: list[np.ndarray] = []
    segment_parts: list[np.ndarray] = []
    origin_x, origin_y = heightmap.origin

    for segment, t_count in enumerate(t_counts):
        t = (np.arange(t_count) + 0.5) / t_count
        start = curve[segment]
        vector = curve[segment + 1] - start
        normal_start = normals[segment]
        normal_delta = normals[segment + 1] - normal_start
        raw_normal = normal_start[None, :] + t[:, None] * normal_delta[None, :]
        raw_length = np.linalg.norm(raw_normal, axis=1)
        if np.any(raw_length <= GEOMETRY_EPSILON):
            raise IntegrationGeometryError(
                f"segment {segment} has an undefined cross section"
            )
        normal = raw_normal / raw_length[:, None]
        projection = np.sum(raw_normal * normal_delta[None, :], axis=1)
        normal_derivative = (
            normal_delta[None, :] / raw_length[:, None]
            - raw_normal * (projection / raw_length**3)[:, None]
        )

        x = start[0] + t[:, None] * vector[0] + normal[:, 0, None] * u[None, :]
        y = start[1] + t[:, None] * vector[1] + normal[:, 1, None] * u[None, :]
        if (
            np.any(x < origin_x - BOUNDARY_TOLERANCE_M)
            or np.any(x > heightmap.max_x + BOUNDARY_TOLERANCE_M)
            or np.any(y < origin_y - BOUNDARY_TOLERANCE_M)
            or np.any(y > heightmap.max_y + BOUNDARY_TOLERANCE_M)
        ):
            raise IntegrationGeometryError(
                f"segment {segment} has a quadrature point outside the heightmap"
            )
        x_grid = np.clip(
            (x - origin_x) / heightmap.cell_size[0], 0.0, heightmap.width - 1.0
        )
        y_grid = np.clip(
            (y - origin_y) / heightmap.cell_size[1], 0.0, heightmap.height - 1.0
        )

        base_jacobian = vector[0] * normal[:, 1] - vector[1] * normal[:, 0]
        normal_jacobian = (
            normal_derivative[:, 0] * normal[:, 1]
            - normal_derivative[:, 1] * normal[:, 0]
        )
        jacobian = base_jacobian[:, None] + normal_jacobian[:, None] * u[None, :]
        if np.any(jacobian <= GEOMETRY_EPSILON):
            raise IntegrationGeometryError(
                f"segment {segment} folds at a quadrature point"
            )

        ground_parts.append(ground_height(x_grid, y_grid, terrain).ravel())
        weight_parts.append((jacobian * width / (t_count * u_count)).ravel())
        t_parts.append(np.repeat(t, u_count))
        segment_parts.append(np.full(t_count * u_count, segment, dtype=np.intp))

    ground = np.concatenate(ground_parts)
    weights = np.concatenate(weight_parts)
    fractions = np.concatenate(t_parts)
    segments = np.concatenate(segment_parts)
    rows = np.arange(point_count)
    interpolation = sparse.coo_matrix(
        (
            np.concatenate((1.0 - fractions, fractions)),
            (
                np.concatenate((rows, rows)),
                np.concatenate((segments, segments + 1)),
            ),
        ),
        shape=(point_count, len(curve)),
    ).tocsr()
    return interpolation, ground, weights, lengths


def project_to_grade(
    candidate: np.ndarray,
    lengths: np.ndarray,
    max_grade: float,
    start_z: float,
    end_z: float,
) -> np.ndarray:
    """Remove small solver constraint errors while keeping both endpoints fixed."""
    result = candidate.copy()
    result[0] = start_z
    result[-1] = end_z
    remaining = np.cumsum(lengths[::-1])[::-1]
    for index in range(1, len(result) - 1):
        step = max_grade * lengths[index - 1]
        reach = max_grade * remaining[index]
        lower = max(result[index - 1] - step, end_z - reach)
        upper = min(result[index - 1] + step, end_z + reach)
        if lower > upper + GRADE_FEASIBILITY_TOLERANCE_M:
            raise ValueError("grade projection found no feasible elevation")
        result[index] = np.clip(result[index], lower, upper)
    return result


def grade_heightmap_vertices(
    curve: np.ndarray,
    heightmap: Heightmap,
    width: float,
) -> tuple[list[float], dict[str, float | int]]:
    """Set each grid vertex inside the swept strip to its road elevation."""
    normals, _ = vertex_normals(curve)
    original = np.asarray(heightmap.heights, dtype=np.float64)
    graded = original.copy()
    covered = np.zeros(len(original), dtype=bool)
    indices = np.arange(len(original))
    x = heightmap.origin[0] + (indices % heightmap.width) * heightmap.cell_size[0]
    y = heightmap.origin[1] + (indices // heightmap.width) * heightmap.cell_size[1]
    half_width = width / 2.0

    for segment in range(len(curve) - 1):
        start = curve[segment]
        end = curve[segment + 1]
        n0 = normals[segment]
        n1 = normals[segment + 1]
        envelope = (
            (x >= min(start[0], end[0]) - half_width - FOOTPRINT_TOLERANCE_M)
            & (x <= max(start[0], end[0]) + half_width + FOOTPRINT_TOLERANCE_M)
            & (y >= min(start[1], end[1]) - half_width - FOOTPRINT_TOLERANCE_M)
            & (y <= max(start[1], end[1]) + half_width + FOOTPRINT_TOLERANCE_M)
        )
        candidates = np.flatnonzero(envelope)
        if len(candidates) == 0:
            continue
        px = x[candidates]
        py = y[candidates]
        start_side = (px - start[0]) * n0[1] - (py - start[1]) * n0[0]
        end_side = (px - end[0]) * n1[1] - (py - end[1]) * n1[0]
        between_sections = (
            (start_side >= -FOOTPRINT_TOLERANCE_M)
            & (end_side <= FOOTPRINT_TOLERANCE_M)
        )
        candidates = candidates[between_sections]
        if len(candidates) == 0:
            continue
        px = x[candidates]
        py = y[candidates]

        low = np.zeros(len(candidates))
        high = np.ones(len(candidates))
        normal_delta = n1 - n0
        vector = end - start
        for _ in range(48):
            middle = (low + high) / 2.0
            raw_normal = n0[None, :] + middle[:, None] * normal_delta[None, :]
            normal = raw_normal / np.linalg.norm(raw_normal, axis=1)[:, None]
            cx = start[0] + middle * vector[0]
            cy = start[1] + middle * vector[1]
            side = (px - cx) * normal[:, 1] - (py - cy) * normal[:, 0]
            low = np.where(side > 0.0, middle, low)
            high = np.where(side <= 0.0, middle, high)
        t = (low + high) / 2.0
        raw_normal = n0[None, :] + t[:, None] * normal_delta[None, :]
        normal = raw_normal / np.linalg.norm(raw_normal, axis=1)[:, None]
        offset_x = px - (start[0] + t * vector[0])
        offset_y = py - (start[1] + t * vector[1])
        u = offset_x * normal[:, 0] + offset_y * normal[:, 1]
        inside = np.abs(u) <= half_width + FOOTPRINT_TOLERANCE_M
        selected = candidates[inside]
        if len(selected) == 0:
            continue
        road_z = start[2] + t[inside] * vector[2]
        shared = covered[selected]
        if np.any(np.abs(graded[selected[shared]] - road_z[shared]) > 1e-7):
            raise IntegrationGeometryError(
                "a grid vertex has conflicting road elevations from overlapping strips"
            )
        graded[selected] = road_z
        covered[selected] = True

    change = graded - original
    return graded.tolist(), {
        "covered_grid_vertices": int(np.count_nonzero(covered)),
        "changed_grid_vertices": int(np.count_nonzero(np.abs(change) > 1e-9)),
        "maximum_absolute_height_change_m": float(np.max(np.abs(change))),
    }


def solve_heights(
    interpolation: sparse.csr_matrix,
    ground: np.ndarray,
    weights: np.ndarray,
    lengths: np.ndarray,
    max_grade: float,
    start_z: float,
    end_z: float,
    rates: Mapping[str, float],
) -> tuple[np.ndarray | None, dict[str, Any]]:
    heights = cp.Variable(interpolation.shape[1])
    differences = heights[1:] - heights[:-1]
    road_at_samples = interpolation @ heights
    signed_difference = road_at_samples - ground
    balance = cp.sum(cp.multiply(weights, signed_difference))

    terms: list[cp.Expression] = []
    if rates["rb"] > 0:
        segment_lengths = cp.norm(cp.vstack([lengths, differences]), axis=0)
        terms.append(rates["rb"] * cp.sum(segment_lengths))
    if rates["ed"] > 0:
        terms.append(
            rates["ed"]
            * cp.sum(cp.multiply(weights, cp.pos(-signed_difference)))
        )
    if rates["ef"] > 0:
        terms.append(
            rates["ef"]
            * cp.sum(cp.multiply(weights, cp.pos(signed_difference)))
        )
    if rates["ei"] > 0:
        terms.append(rates["ei"] * cp.pos(balance))
    if rates["ex"] > 0:
        terms.append(rates["ex"] * cp.pos(-balance))

    problem = cp.Problem(
        cp.Minimize(sum(terms)),
        [
            heights[0] == start_z,
            heights[-1] == end_z,
            differences <= max_grade * lengths,
            differences >= -max_grade * lengths,
        ],
    )
    if not problem.is_dcp():
        raise ValueError("internal error: the optimization model is not convex")
    distance = np.concatenate(([0.0], np.cumsum(lengths)))
    heights.value = start_z + (end_z - start_z) * distance / distance[-1]
    problem.solve(solver=cp.CLARABEL, warm_start=True)
    details = {
        "solver": "CLARABEL",
        "solver_status": problem.status,
        "quadrature_points": interpolation.shape[0],
        "sampled_objective": float(problem.value) if problem.value is not None else None,
    }
    if problem.status != cp.OPTIMAL or heights.value is None:
        return None, details
    return np.asarray(heights.value, dtype=np.float64).reshape(-1), details


def price_solution(
    curve: np.ndarray,
    heightmap: Heightmap,
    width: float,
    rates: Mapping[str, float],
    initial_step_m: float,
    absolute_tolerance_m3: float,
    relative_tolerance: float,
    max_refinements: int,
) -> tuple[dict[str, Any] | None, dict[str, Any]]:
    volumes, integration = integrate_volumes(
        curve,
        heightmap,
        width,
        initial_step_m,
        absolute_tolerance_m3,
        relative_tolerance,
        max_refinements,
    )
    if volumes is None:
        return None, integration
    cut, fill = volumes
    imported = max(fill - cut, 0.0)
    exported = max(cut - fill, 0.0)
    length = float(np.sum(np.linalg.norm(np.diff(curve, axis=0), axis=1)))
    components = {
        "road_build": rates["rb"] * length,
        "earth_dig": rates["ed"] * cut,
        "earth_fill": rates["ef"] * fill,
        "earth_import": rates["ei"] * imported,
        "earth_export": rates["ex"] * exported,
    }
    return {
        "length_m": length,
        "volumes_m3": {
            "cut": cut,
            "fill": fill,
            "import": imported,
            "export": exported,
        },
        "cost_components": components,
        "total_cost": math.fsum(components.values()),
    }, integration


def solve(
    input_path: Path,
    output_path: Path,
    report_path: Path,
    quadrature_step_m: float,
    initial_step_m: float,
    absolute_tolerance_m3: float,
    relative_tolerance: float,
    max_refinements: int,
) -> dict[str, Any]:
    if not math.isfinite(quadrature_step_m) or quadrature_step_m <= 0:
        raise ValueError("quadrature step must be finite and greater than zero")
    if not math.isfinite(initial_step_m) or initial_step_m <= 0:
        raise ValueError("integration step must be finite and greater than zero")
    if not math.isfinite(absolute_tolerance_m3) or absolute_tolerance_m3 < 0:
        raise ValueError("absolute volume tolerance must be finite and nonnegative")
    if not math.isfinite(relative_tolerance) or relative_tolerance < 0:
        raise ValueError("relative volume tolerance must be finite and nonnegative")
    if max_refinements < 1:
        raise ValueError("max refinements must be at least one")
    if input_path.resolve() == output_path.resolve():
        raise ValueError("output path must differ from input path")
    if report_path.resolve() in (input_path.resolve(), output_path.resolve()):
        raise ValueError("report path must differ from input and output paths")

    vertices, heightmap, terrain_document, constraints, rates = load_input(input_path)
    if not any(rate > 0 for rate in rates.values()):
        raise ValueError("at least one cost rate must be positive")
    input_check = check_road(vertices, heightmap, terrain_document, constraints)
    required_checks = ("path_geometry", "road_strip", "curvature")
    invalid_checks = [
        name for name in required_checks if not input_check["checks"][name]["valid"]
    ]
    if invalid_checks:
        return {
            "status": "invalid_path",
            "valid": False,
            "error": "fixed path fails: " + ", ".join(invalid_checks),
            "checks": input_check["checks"],
        }

    curve = np.asarray(vertices, dtype=np.float64)
    lengths = np.linalg.norm(np.diff(curve[:, :2], axis=0), axis=1)
    start_z = float(curve[0, 2])
    end_z = float(curve[-1, 2])
    possible_change = constraints["maxs"] * math.fsum(float(x) for x in lengths)
    if abs(end_z - start_z) > possible_change + GRADE_FEASIBILITY_TOLERANCE_M:
        return {
            "status": "infeasible_elevations",
            "valid": False,
            "error": "fixed endpoint elevations cannot meet the grade limit",
            "endpoint_difference_m": abs(end_z - start_z),
            "maximum_possible_difference_m": possible_change,
        }

    interpolation, ground, weights, lengths = build_quadrature(
        curve, heightmap, constraints["w"], quadrature_step_m
    )
    candidate, optimization = solve_heights(
        interpolation,
        ground,
        weights,
        lengths,
        constraints["maxs"],
        start_z,
        end_z,
        rates,
    )
    optimization["quadrature_step_m"] = quadrature_step_m
    if candidate is None:
        return {
            "status": "solver_failure",
            "valid": False,
            "error": "convex solver did not return an optimal profile",
            "optimization": optimization,
        }
    elevations = project_to_grade(
        candidate, lengths, constraints["maxs"], start_z, end_z
    )
    adjustment = float(np.max(np.abs(elevations - candidate)))
    optimization["grade_adjustment_m"] = adjustment
    if adjustment > MAX_SOLVER_ADJUSTMENT_M:
        return {
            "status": "solver_failure",
            "valid": False,
            "error": "solver profile needed too much grade correction",
            "optimization": optimization,
        }
    curve[:, 2] = elevations
    final_check = check_road(
        [tuple(point) for point in curve], heightmap, terrain_document, constraints
    )
    if not final_check["valid"]:
        return {
            "status": "solver_failure",
            "valid": False,
            "error": "optimized road failed the Problem 0 constraint check",
            "optimization": optimization,
            "checks": final_check["checks"],
        }

    try:
        price, integration = price_solution(
            curve,
            heightmap,
            constraints["w"],
            rates,
            initial_step_m,
            absolute_tolerance_m3,
            relative_tolerance,
            max_refinements,
        )
    except IntegrationGeometryError as error:
        return {
            "status": "invalid_path",
            "valid": False,
            "error": str(error),
            "optimization": optimization,
        }
    if price is None:
        return {
            "status": "numerical_failure",
            "valid": False,
            "error": "final volume estimates did not reach the requested tolerance",
            "optimization": optimization,
            "integration": integration,
        }

    try:
        graded_heights, terrain_update = grade_heightmap_vertices(
            curve, heightmap, constraints["w"]
        )
    except IntegrationGeometryError as error:
        return {
            "status": "invalid_path",
            "valid": False,
            "error": str(error),
            "optimization": optimization,
        }
    graded_heights[terrain_document["A"]] = start_z
    graded_heights[terrain_document["B"]] = end_z

    with input_path.open(encoding="utf-8") as handle:
        document = json.load(handle)
    document["curve"] = curve.tolist()
    document["terrain"] = copy.deepcopy(terrain_document)
    document["terrain"]["heightmap"]["heights"] = graded_heights
    document.pop("solution", None)
    report = {
        "status": "optimal",
        "valid": True,
        "optimality_scope": "fixed quadrature grid",
        "input": str(input_path),
        "output": str(output_path),
        "vertices": len(curve),
        "terrain_update": terrain_update,
        "optimization": optimization,
        **price,
        "maximum_grade": final_check["checks"]["grade"]["maximum"],
        "maximum_curvature": final_check["checks"]["curvature"]["maximum"],
        "integration": integration,
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps(document, indent=2, allow_nan=False) + "\n", encoding="utf-8"
    )
    report_path.write_text(
        json.dumps(report, indent=2, allow_nan=False) + "\n", encoding="utf-8"
    )
    return {**report, "report": str(report_path)}


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("road_json", type=Path, help="Problem 1 road input JSON")
    parser.add_argument(
        "--output",
        type=Path,
        help="output road JSON (default: input name ending in -solution.json)",
    )
    parser.add_argument(
        "--report",
        type=Path,
        help="cost report JSON (default: output name ending in -report.json)",
    )
    parser.add_argument(
        "--quadrature-step-m",
        type=float,
        default=0.25,
        help="maximum midpoint panel size in the optimization (default: 0.25 m)",
    )
    parser.add_argument(
        "--initial-step-m",
        type=float,
        default=0.5,
        help="initial step for final cost integration (default: 0.5 m)",
    )
    parser.add_argument(
        "--volume-atol-m3",
        type=float,
        default=0.01,
        help="absolute tolerance for each final volume (default: 0.01 m3)",
    )
    parser.add_argument(
        "--volume-rtol",
        type=float,
        default=1e-4,
        help="relative tolerance for each final volume (default: 0.0001)",
    )
    parser.add_argument(
        "--max-refinements",
        type=int,
        default=5,
        help="maximum final cost grid refinements (default: 5)",
    )
    args = parser.parse_args(argv)
    output = args.output or output_path_for(args.road_json)
    report = args.report or report_path_for(output)
    try:
        result = solve(
            args.road_json,
            output,
            report,
            args.quadrature_step_m,
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
    except cp.SolverError as error:
        result = {"status": "solver_failure", "valid": False, "error": str(error)}

    print(json.dumps(result, indent=2, allow_nan=False))
    return {
        "optimal": 0,
        "invalid_path": 1,
        "invalid_input": 2,
        "infeasible_elevations": 3,
        "solver_failure": 4,
        "numerical_failure": 5,
    }[result["status"]]


if __name__ == "__main__":
    sys.exit(main())
