#!/usr/bin/env python3
"""Search joint normal offsets and solve Problem 1 for each valid road.

Run with:
    uv run python scripts/solve_problem2.py data/problem1-road-input.json

The optional input field problem2.offset_bounds_m contains one [lower, upper]
pair for each interior curve vertex. Without that field, all interior vertices
use the symmetric --max-offset-m bound (3 m by default).
"""

from __future__ import annotations

import argparse
import copy
import json
import math
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, Sequence

import cvxpy as cp
import numpy as np

if __package__:
    from .calculate_road_cost import IntegrationGeometryError, vertex_normals
    from .check_road_constraints import (
        Heightmap,
        MissingParameterError,
        check_road,
        endpoint_errors,
        finite_number,
        load_input,
    )
    from .solve_problem1 import (
        GRADE_FEASIBILITY_TOLERANCE_M,
        MAX_SOLVER_ADJUSTMENT_M,
        build_quadrature,
        grade_heightmap_vertices,
        price_solution,
        project_to_grade,
        solve_heights,
    )
else:
    from calculate_road_cost import IntegrationGeometryError, vertex_normals
    from check_road_constraints import (
        Heightmap,
        MissingParameterError,
        check_road,
        endpoint_errors,
        finite_number,
        load_input,
    )
    from solve_problem1 import (
        GRADE_FEASIBILITY_TOLERANCE_M,
        MAX_SOLVER_ADJUSTMENT_M,
        build_quadrature,
        grade_heightmap_vertices,
        price_solution,
        project_to_grade,
        solve_heights,
    )


DEFAULT_MAX_OFFSET_M = 3.0


def output_path_for(input_path: Path) -> Path:
    stem = input_path.stem
    if stem.endswith("-input"):
        stem = stem[:-6]
    return input_path.with_name(stem + "-problem2-solution.json")


def report_path_for(output_path: Path) -> Path:
    stem = output_path.stem
    if stem.endswith("-solution"):
        stem = stem[:-9]
    return output_path.with_name(stem + "-report.json")


def read_offset_bounds(
    document: Mapping[str, Any],
    interior_count: int,
    cli_max_offset_m: float | None,
) -> tuple[np.ndarray, np.ndarray, str]:
    raw_problem2 = document.get("problem2", {})
    if not isinstance(raw_problem2, Mapping):
        raise ValueError("problem2 must be an object")
    if cli_max_offset_m is not None:
        maximum = finite_number(cli_max_offset_m, "--max-offset-m")
        source = "--max-offset-m"
    elif "offset_bounds_m" in raw_problem2:
        pairs = raw_problem2["offset_bounds_m"]
        if not isinstance(pairs, list) or len(pairs) != interior_count:
            raise ValueError(
                "problem2.offset_bounds_m must have one [lower, upper] pair "
                "for each interior curve vertex"
            )
        lower: list[float] = []
        upper: list[float] = []
        for index, pair in enumerate(pairs):
            if not isinstance(pair, list) or len(pair) != 2:
                raise ValueError(f"problem2.offset_bounds_m[{index}] must be [lower, upper]")
            lo = finite_number(pair[0], f"problem2.offset_bounds_m[{index}][0]")
            hi = finite_number(pair[1], f"problem2.offset_bounds_m[{index}][1]")
            if lo > 0 or hi < 0:
                raise ValueError(f"problem2.offset_bounds_m[{index}] must contain zero")
            lower.append(lo)
            upper.append(hi)
        return np.asarray(lower), np.asarray(upper), "problem2.offset_bounds_m"
    elif "max_offset_m" in raw_problem2:
        maximum = finite_number(raw_problem2["max_offset_m"], "problem2.max_offset_m")
        source = "problem2.max_offset_m"
    else:
        maximum = DEFAULT_MAX_OFFSET_M
        source = "default"
    if maximum < 0:
        raise ValueError("maximum offset must be nonnegative")
    return (
        np.full(interior_count, -maximum),
        np.full(interior_count, maximum),
        source,
    )


@dataclass
class Candidate:
    offsets: np.ndarray
    status: str
    reason: str | None = None
    curve: np.ndarray | None = None
    price: dict[str, Any] | None = None
    optimization: dict[str, Any] | None = None
    integration: dict[str, Any] | None = None
    checks: dict[str, Any] | None = None

    @property
    def cost(self) -> float:
        return float(self.price["total_cost"]) if self.price is not None else math.inf


class CandidateEvaluator:
    def __init__(
        self,
        baseline: np.ndarray,
        baseline_normals: np.ndarray,
        heightmap: Heightmap,
        terrain_document: Mapping[str, Any],
        constraints: Mapping[str, float],
        rates: Mapping[str, float],
        max_evaluations: int,
        quadrature_step_m: float,
        initial_step_m: float,
        volume_atol_m3: float,
        volume_rtol: float,
        max_refinements: int,
    ) -> None:
        self.baseline = baseline
        self.baseline_normals = baseline_normals
        self.heightmap = heightmap
        self.terrain_document = terrain_document
        self.constraints = constraints
        self.rates = rates
        self.max_evaluations = max_evaluations
        self.quadrature_step_m = quadrature_step_m
        self.initial_step_m = initial_step_m
        self.volume_atol_m3 = volume_atol_m3
        self.volume_rtol = volume_rtol
        self.max_refinements = max_refinements
        self.cache: dict[tuple[float, ...], Candidate] = {}
        self.history: list[dict[str, Any]] = []

    @property
    def remaining(self) -> int:
        return self.max_evaluations - len(self.cache)

    def evaluate(self, offsets: np.ndarray) -> Candidate | None:
        offsets = np.asarray(offsets, dtype=np.float64)
        key = tuple(float(value) for value in offsets)
        if key in self.cache:
            return self.cache[key]
        if self.remaining <= 0:
            return None
        result = self._evaluate_uncached(offsets.copy())
        self.cache[key] = result
        self.history.append(
            {
                "evaluation": len(self.cache),
                "offsets_m": offsets.tolist(),
                "status": result.status,
                "total_cost": result.cost if math.isfinite(result.cost) else None,
                "reason": result.reason,
            }
        )
        return result

    def _evaluate_uncached(self, offsets: np.ndarray) -> Candidate:
        curve = self.baseline.copy()
        curve[1:-1, :2] += offsets[:, None] * self.baseline_normals[1:-1]
        if not np.all(np.isfinite(curve)):
            return Candidate(offsets, "invalid_path", "candidate coordinates are not finite")
        lengths = np.linalg.norm(np.diff(curve[:, :2], axis=0), axis=1)
        if not np.all(np.isfinite(lengths)):
            return Candidate(offsets, "invalid_path", "candidate segment lengths are not finite")
        start_z = float(curve[0, 2])
        end_z = float(curve[-1, 2])
        possible_change = self.constraints["maxs"] * math.fsum(float(x) for x in lengths)
        if abs(end_z - start_z) > possible_change + GRADE_FEASIBILITY_TOLERANCE_M:
            return Candidate(
                offsets,
                "infeasible_elevations",
                "fixed endpoint elevations cannot meet the grade limit",
            )

        precheck = check_road(
            [tuple(point) for point in curve],
            self.heightmap,
            self.terrain_document,
            self.constraints,
        )
        invalid_checks = [
            name
            for name in ("path_geometry", "road_strip", "curvature")
            if not precheck["checks"][name]["valid"]
        ]
        if invalid_checks:
            return Candidate(
                offsets,
                "invalid_path",
                "candidate fails: " + ", ".join(invalid_checks),
                checks=precheck["checks"],
            )

        try:
            interpolation, ground, weights, lengths = build_quadrature(
                curve,
                self.heightmap,
                self.constraints["w"],
                self.quadrature_step_m,
            )
            elevations, optimization = solve_heights(
                interpolation,
                ground,
                weights,
                lengths,
                self.constraints["maxs"],
                start_z,
                end_z,
                self.rates,
            )
            optimization["quadrature_step_m"] = self.quadrature_step_m
            if elevations is None:
                return Candidate(
                    offsets,
                    "solver_failure",
                    "convex solver did not return an optimal profile",
                    optimization=optimization,
                )
            projected = project_to_grade(
                elevations,
                lengths,
                self.constraints["maxs"],
                start_z,
                end_z,
            )
            adjustment = float(np.max(np.abs(projected - elevations)))
            optimization["grade_adjustment_m"] = adjustment
            if adjustment > MAX_SOLVER_ADJUSTMENT_M:
                return Candidate(
                    offsets,
                    "solver_failure",
                    "solver profile needed too much grade correction",
                    optimization=optimization,
                )
            curve[:, 2] = projected
            final_check = check_road(
                [tuple(point) for point in curve],
                self.heightmap,
                self.terrain_document,
                self.constraints,
            )
            if not final_check["valid"]:
                return Candidate(
                    offsets,
                    "solver_failure",
                    "optimized road failed the Problem 0 constraint check",
                    optimization=optimization,
                    checks=final_check["checks"],
                )
            price, integration = price_solution(
                curve,
                self.heightmap,
                self.constraints["w"],
                self.rates,
                self.initial_step_m,
                self.volume_atol_m3,
                self.volume_rtol,
                self.max_refinements,
            )
            if price is None:
                return Candidate(
                    offsets,
                    "numerical_failure",
                    "volume estimates did not reach the requested tolerance",
                    optimization=optimization,
                    integration=integration,
                )
        except IntegrationGeometryError as error:
            return Candidate(offsets, "invalid_path", str(error))
        except (cp.SolverError, ValueError, OverflowError) as error:
            return Candidate(offsets, "solver_failure", str(error))

        return Candidate(
            offsets,
            "valid",
            curve=curve,
            price=price,
            optimization=optimization,
            integration=integration,
            checks=final_check["checks"],
        )


def search_directions(baseline: np.ndarray, seed: int) -> list[np.ndarray]:
    segment_lengths = np.linalg.norm(np.diff(baseline[:, :2], axis=0), axis=1)
    station = np.cumsum(segment_lengths)[:-1] / math.fsum(float(x) for x in segment_lengths)
    directions: list[np.ndarray] = []

    def add(values: np.ndarray) -> None:
        scale = float(np.max(np.abs(values)))
        if scale <= 1e-12:
            return
        direction = np.asarray(values / scale, dtype=np.float64)
        if any(np.allclose(direction, known, atol=1e-9) or np.allclose(direction, -known, atol=1e-9) for known in directions):
            return
        directions.append(direction)

    harmonic_count = min(4, len(station))
    harmonics = [np.sin(math.pi * order * station) for order in range(1, harmonic_count + 1)]
    for harmonic in harmonics:
        add(harmonic)

    bump_count = min(7, len(station))
    taper = np.sin(math.pi * station)
    for index in range(1, bump_count + 1):
        center = index / (bump_count + 1)
        width = 1.0 / (bump_count + 1)
        add(np.exp(-0.5 * ((station - center) / width) ** 2) * taper)

    if harmonic_count > 1:
        rng = np.random.default_rng(seed)
        for _ in range(4):
            coefficients = rng.normal(size=harmonic_count)
            add(sum((coefficient * harmonic for coefficient, harmonic in zip(coefficients, harmonics)), np.zeros_like(station)))
    return directions


def search_offsets(
    evaluator: CandidateEvaluator,
    lower: np.ndarray,
    upper: np.ndarray,
    initial_move_m: float,
    min_move_m: float,
    seed: int,
) -> tuple[str, int, int]:
    directions = search_directions(evaluator.baseline, seed)
    current_offsets = np.zeros(len(lower), dtype=np.float64)
    current = evaluator.evaluate(current_offsets)
    if current is None:
        return "evaluation_budget", 0, len(directions)
    if not directions or np.all(lower == upper):
        return "fixed_offsets", 0, len(directions)

    move = initial_move_m
    accepted_moves = 0
    rotation = 0
    while move >= min_move_m:
        if evaluator.remaining <= 0:
            return "evaluation_budget", accepted_moves, len(directions)
        improved = False
        for count in range(len(directions)):
            direction_index = (rotation + count) % len(directions)
            direction = directions[direction_index]
            for sign in (1.0, -1.0):
                trial = np.clip(current_offsets + sign * move * direction, lower, upper)
                if np.array_equal(trial, current_offsets):
                    continue
                candidate = evaluator.evaluate(trial)
                if candidate is None:
                    return "evaluation_budget", accepted_moves, len(directions)
                improvement_tolerance = 1e-7 * max(1.0, abs(current.cost)) if math.isfinite(current.cost) else 0.0
                if math.isfinite(candidate.cost) and candidate.cost < current.cost - improvement_tolerance:
                    current = candidate
                    current_offsets = trial
                    accepted_moves += 1
                    rotation = (direction_index + 1) % len(directions)
                    improved = True
                    break
            if improved:
                break
        if not improved:
            move /= 2.0
    return "move_tolerance", accepted_moves, len(directions)


def solve(
    input_path: Path,
    output_path: Path,
    report_path: Path,
    max_offset_m: float | None,
    max_evaluations: int,
    initial_move_m: float,
    min_move_m: float,
    seed: int,
    quadrature_step_m: float,
    initial_step_m: float,
    volume_atol_m3: float,
    volume_rtol: float,
    max_refinements: int,
) -> dict[str, Any]:
    if max_evaluations < 1:
        raise ValueError("max evaluations must be at least one")
    if not math.isfinite(initial_move_m) or initial_move_m <= 0:
        raise ValueError("initial move must be finite and greater than zero")
    if not math.isfinite(min_move_m) or min_move_m <= 0 or min_move_m > initial_move_m:
        raise ValueError("minimum move must be positive and no greater than initial move")
    if not math.isfinite(quadrature_step_m) or quadrature_step_m <= 0:
        raise ValueError("quadrature step must be finite and greater than zero")
    if not math.isfinite(initial_step_m) or initial_step_m <= 0:
        raise ValueError("integration step must be finite and greater than zero")
    if not math.isfinite(volume_atol_m3) or volume_atol_m3 < 0:
        raise ValueError("absolute volume tolerance must be finite and nonnegative")
    if not math.isfinite(volume_rtol) or volume_rtol < 0:
        raise ValueError("relative volume tolerance must be finite and nonnegative")
    if max_refinements < 1:
        raise ValueError("max refinements must be at least one")
    if len({input_path.resolve(), output_path.resolve(), report_path.resolve()}) != 3:
        raise ValueError("input, output, and report paths must differ")

    vertices, heightmap, terrain_document, constraints, rates = load_input(input_path)
    if len(vertices) < 3:
        raise ValueError("Problem 2 needs at least one interior curve vertex")
    if not any(rate > 0 for rate in rates.values()):
        raise ValueError("at least one cost rate must be positive")
    endpoint_problems = endpoint_errors(vertices, terrain_document, heightmap)
    if endpoint_problems:
        raise ValueError("; ".join(endpoint_problems))
    with input_path.open(encoding="utf-8") as handle:
        document = json.load(handle)
    lower, upper, bounds_source = read_offset_bounds(
        document, len(vertices) - 2, max_offset_m
    )
    baseline = np.asarray(vertices, dtype=np.float64)
    try:
        baseline_normals, _ = vertex_normals(baseline)
    except IntegrationGeometryError as error:
        raise ValueError("baseline cannot define offset normals: " + str(error)) from error

    evaluator = CandidateEvaluator(
        baseline,
        baseline_normals,
        heightmap,
        terrain_document,
        constraints,
        rates,
        max_evaluations,
        quadrature_step_m,
        initial_step_m,
        volume_atol_m3,
        volume_rtol,
        max_refinements,
    )
    termination, accepted_moves, direction_count = search_offsets(
        evaluator, lower, upper, initial_move_m, min_move_m, seed
    )
    baseline_result = evaluator.cache[tuple(0.0 for _ in lower)]
    valid_candidates = sorted(
        (candidate for candidate in evaluator.cache.values() if math.isfinite(candidate.cost)),
        key=lambda candidate: candidate.cost,
    )
    chosen: Candidate | None = None
    graded_heights: list[float] | None = None
    terrain_update: dict[str, float | int] | None = None
    output_errors: list[str] = []
    for candidate in valid_candidates:
        try:
            graded_heights, terrain_update = grade_heightmap_vertices(
                candidate.curve, heightmap, constraints["w"]
            )
        except IntegrationGeometryError as error:
            output_errors.append(str(error))
            continue
        chosen = candidate
        break

    search_report = {
        "method": "bounded pattern search with joint smooth directions",
        "bounds_source": bounds_source,
        "offset_bounds_m": np.column_stack((lower, upper)).tolist(),
        "baseline_normals_xy": baseline_normals.tolist(),
        "seed": seed,
        "initial_move_m": initial_move_m,
        "minimum_move_m": min_move_m,
        "max_evaluations": max_evaluations,
        "evaluations": len(evaluator.cache),
        "accepted_moves": accepted_moves,
        "direction_count": direction_count,
        "termination": termination,
        "history": evaluator.history,
    }
    baseline_summary = {
        "status": baseline_result.status,
        "total_cost": baseline_result.cost if math.isfinite(baseline_result.cost) else None,
        "reason": baseline_result.reason,
    }
    if chosen is None:
        return {
            "status": "no_feasible_candidate",
            "valid": False,
            "error": "search found no candidate with a valid road and converged cost",
            "baseline": baseline_summary,
            "search": search_report,
            "output_errors": output_errors,
        }

    start_z = float(chosen.curve[0, 2])
    end_z = float(chosen.curve[-1, 2])
    graded_heights[terrain_document["A"]] = start_z
    graded_heights[terrain_document["B"]] = end_z
    document["curve"] = chosen.curve.tolist()
    document["terrain"] = copy.deepcopy(terrain_document)
    document["terrain"]["heightmap"]["heights"] = graded_heights
    document.pop("solution", None)

    baseline_cost = baseline_summary["total_cost"]
    report = {
        "status": "best_found",
        "valid": True,
        "optimality_scope": "best evaluated outer path; fixed-path sampled convex inner solve",
        "input": str(input_path),
        "output": str(output_path),
        "vertices": len(chosen.curve),
        "offsets_m": chosen.offsets.tolist(),
        "baseline": baseline_summary,
        "cost_change_from_baseline": chosen.cost - baseline_cost if baseline_cost is not None else None,
        "terrain_update": terrain_update,
        "search": search_report,
        "optimization": chosen.optimization,
        **chosen.price,
        "checks": chosen.checks,
        "maximum_grade": chosen.checks["grade"]["maximum"],
        "maximum_curvature": chosen.checks["curvature"]["maximum"],
        "integration": chosen.integration,
    }
    if output_errors:
        report["finalization_errors"] = output_errors
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
    parser.add_argument("road_json", type=Path, help="Problem 2 road input JSON")
    parser.add_argument("--output", type=Path, help="output road JSON")
    parser.add_argument("--report", type=Path, help="cost report JSON")
    parser.add_argument(
        "--max-offset-m",
        type=float,
        help="symmetric offset bound for every interior vertex; overrides input bounds",
    )
    parser.add_argument("--max-evaluations", type=int, default=60)
    parser.add_argument("--initial-move-m", type=float, default=1.0)
    parser.add_argument("--min-move-m", type=float, default=0.05)
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--quadrature-step-m", type=float, default=0.25)
    parser.add_argument("--initial-step-m", type=float, default=0.5)
    parser.add_argument("--volume-atol-m3", type=float, default=0.01)
    parser.add_argument("--volume-rtol", type=float, default=1e-4)
    parser.add_argument("--max-refinements", type=int, default=5)
    args = parser.parse_args(argv)
    output = args.output or output_path_for(args.road_json)
    report = args.report or report_path_for(output)
    try:
        result = solve(
            args.road_json,
            output,
            report,
            args.max_offset_m,
            args.max_evaluations,
            args.initial_move_m,
            args.min_move_m,
            args.seed,
            args.quadrature_step_m,
            args.initial_step_m,
            args.volume_atol_m3,
            args.volume_rtol,
            args.max_refinements,
        )
    except MissingParameterError as error:
        result = {"status": "invalid_input", "valid": False, "error": str(error)}
    except (OSError, json.JSONDecodeError, ValueError, OverflowError) as error:
        result = {"status": "invalid_input", "valid": False, "error": str(error)}
    if result["status"] == "best_found":
        summary = {
            "status": result["status"],
            "valid": True,
            "output": result["output"],
            "report": result["report"],
            "total_cost": result["total_cost"],
            "baseline_cost": result["baseline"]["total_cost"],
            "cost_change_from_baseline": result["cost_change_from_baseline"],
            "candidate_evaluations": result["search"]["evaluations"],
            "termination": result["search"]["termination"],
        }
    elif result["status"] == "no_feasible_candidate":
        summary = {
            "status": result["status"],
            "valid": False,
            "error": result["error"],
            "candidate_evaluations": result["search"]["evaluations"],
            "termination": result["search"]["termination"],
        }
    else:
        summary = result
    print(json.dumps(summary, indent=2, allow_nan=False))
    return {"best_found": 0, "no_feasible_candidate": 1, "invalid_input": 2}[result["status"]]


if __name__ == "__main__":
    sys.exit(main())
