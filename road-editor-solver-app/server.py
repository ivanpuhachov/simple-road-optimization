"""Local API for the road editor and the Problem 1 and 2 solvers."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any

import cvxpy as cp
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel


ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.check_road_constraints import MissingParameterError  # noqa: E402
from scripts.solve_problem1 import solve as solve_problem1  # noqa: E402
from scripts.solve_problem2 import solve as solve_problem2  # noqa: E402


class SolveRequest(BaseModel):
    document: dict[str, Any]


app = FastAPI(title="Road Editor Solver")


@app.post("/api/solve")
def solve_route(request: SolveRequest) -> dict[str, Any]:
    """Solve road elevations on the current XY route."""
    return _run_solver(request.document, displacement=False)


@app.post("/api/solve-2d")
def solve_route_2d(request: SolveRequest) -> dict[str, Any]:
    """Search lateral road displacements and solve each candidate's elevations."""
    return _run_solver(request.document, displacement=True)


def _run_solver(document: dict[str, Any], displacement: bool) -> dict[str, Any]:
    """Run a file based solver in an isolated temporary directory."""
    curve = document.get("curve")
    if isinstance(curve, list) and len(curve) > 201:
        return {
            "status": "invalid_input",
            "valid": False,
            "error": "road curve may contain at most 201 vertices",
        }
    with TemporaryDirectory(prefix="road-solve-") as directory:
        working_dir = Path(directory)
        input_path = working_dir / "road-input.json"
        output_path = working_dir / "road-solution.json"
        report_path = working_dir / "road-report.json"
        try:
            input_path.write_text(
                json.dumps(document, allow_nan=False), encoding="utf-8"
            )
            if displacement:
                problem2 = document.get("problem2")
                controls = problem2.get("control_indices") if isinstance(problem2, dict) else None
                move_count = len(controls) if isinstance(controls, list) else (
                    max(0, len(curve) - 2) if isinstance(curve, list) else 0
                )
                result = solve_problem2(
                    input_path,
                    output_path,
                    report_path,
                    max_offset_m=None,
                    max_evaluations=min(60, 8 + 4 * move_count),
                    initial_move_m=1.0,
                    min_move_m=0.05,
                    seed=0,
                    quadrature_step_m=0.25,
                    initial_step_m=0.5,
                    volume_atol_m3=0.01,
                    volume_rtol=1e-4,
                    max_refinements=5,
                )
            else:
                result = solve_problem1(
                    input_path,
                    output_path,
                    report_path,
                    quadrature_step_m=0.25,
                    initial_step_m=0.5,
                    absolute_tolerance_m3=0.01,
                    relative_tolerance=1e-4,
                    max_refinements=5,
                )
        except MissingParameterError as error:
            return {"status": "invalid_input", "valid": False, "error": str(error)}
        except (OSError, json.JSONDecodeError, ValueError, OverflowError) as error:
            return {"status": "invalid_input", "valid": False, "error": str(error)}
        except cp.SolverError as error:
            return {"status": "solver_failure", "valid": False, "error": str(error)}

        success_status = "best_found" if displacement else "optimal"
        if result["status"] != success_status:
            return result

        solution = json.loads(output_path.read_text(encoding="utf-8"))
        report = json.loads(report_path.read_text(encoding="utf-8"))
        for key in ("input", "output", "report"):
            report.pop(key, None)
        return {"status": success_status, "solution": solution, "report": report}


dist = Path(__file__).resolve().parent / "dist"
if dist.is_dir():
    app.mount("/", StaticFiles(directory=dist, html=True), name="frontend")
