"""Local API for the road editor and the existing Problem 1 solver."""

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
from scripts.solve_problem1 import solve  # noqa: E402


class SolveRequest(BaseModel):
    document: dict[str, Any]


app = FastAPI(title="Road Editor Solver")


@app.post("/api/solve")
def solve_route(request: SolveRequest) -> dict[str, Any]:
    """Run the unchanged file based solver in an isolated temporary directory."""
    curve = request.document.get("curve")
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
                json.dumps(request.document, allow_nan=False), encoding="utf-8"
            )
            result = solve(
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

        if result["status"] != "optimal":
            return result

        solution = json.loads(output_path.read_text(encoding="utf-8"))
        report = json.loads(report_path.read_text(encoding="utf-8"))
        for key in ("input", "output", "report"):
            report.pop(key, None)
        return {"status": "optimal", "solution": solution, "report": report}


dist = Path(__file__).resolve().parent / "dist"
if dist.is_dir():
    app.mount("/", StaticFiles(directory=dist, html=True), name="frontend")
