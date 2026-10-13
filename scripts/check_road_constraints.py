#!/usr/bin/env python3
"""Check a road polyline against Problem 0 geometry and constraints.

Input JSON format::

    {
      "curve": [[x, y, z], ...],
      "terrain": "terrain.json",
      "constraints": {"w": 5.0, "maxs": 0.1, "maxc": 0.1},
      "costs": {"earth_dig": 1.0, "earth_fill": 1.0}
    }

The terrain path is relative to the input JSON. A terrain object can be
embedded instead of a path. Costs are accepted and validated here for the
next stage, but are not used by this constraint checker.

Run with:
    uv run python scripts/check_road_constraints.py road.json
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, Sequence


Point2 = tuple[float, float]
Point3 = tuple[float, float, float]
GEOMETRY_STEP_M = 0.25
GEOMETRY_EPSILON = 1e-10
ENDPOINT_TOLERANCE_M = 1e-8


@dataclass(frozen=True)
class Heightmap:
    width: int
    height: int
    origin: Point2
    cell_size: Point2
    heights: list[float]

    @property
    def max_x(self) -> float:
        return self.origin[0] + (self.width - 1) * self.cell_size[0]

    @property
    def max_y(self) -> float:
        return self.origin[1] + (self.height - 1) * self.cell_size[1]

    def vertex(self, index: int) -> Point3:
        j, i = divmod(index, self.width)
        return (
            self.origin[0] + i * self.cell_size[0],
            self.origin[1] + j * self.cell_size[1],
            self.heights[index],
        )


def finite_number(value: Any, name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{name} must be a number")
    number = float(value)
    if not math.isfinite(number):
        raise ValueError(f"{name} must be finite")
    return number


def positive_int(value: Any, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ValueError(f"{name} must be a positive integer")
    return value


def parse_point3(value: Any, name: str) -> Point3:
    if isinstance(value, Mapping):
        raw = (value.get("x"), value.get("y"), value.get("z"))
    elif isinstance(value, Sequence) and not isinstance(value, (str, bytes)):
        raw = value
    else:
        raise ValueError(f"{name} must be [x, y, z] or an object with x, y, z")
    if len(raw) != 3:
        raise ValueError(f"{name} must contain exactly three coordinates")
    return tuple(finite_number(raw[i], f"{name}[{i}]") for i in range(3))  # type: ignore[return-value]


def parse_pair(value: Any, name: str) -> Point2:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes)) or len(value) != 2:
        raise ValueError(f"{name} must contain exactly two numbers")
    return (
        finite_number(value[0], f"{name}[0]"),
        finite_number(value[1], f"{name}[1]"),
    )


def parse_heightmap(terrain_document: Mapping[str, Any]) -> Heightmap:
    raw = terrain_document.get("heightmap")
    if not isinstance(raw, Mapping):
        raise ValueError("terrain must contain a heightmap object")

    width = positive_int(raw.get("width"), "heightmap.width")
    height = positive_int(raw.get("height"), "heightmap.height")
    origin = parse_pair(raw.get("origin_m"), "heightmap.origin_m")
    cell_size = parse_pair(raw.get("cell_size_m"), "heightmap.cell_size_m")
    if cell_size[0] <= 0 or cell_size[1] <= 0:
        raise ValueError("heightmap cell sizes must be greater than zero")

    raw_heights = raw.get("heights")
    if not isinstance(raw_heights, list) or len(raw_heights) != width * height:
        raise ValueError("heightmap.heights must contain width * height values")
    heights = [
        finite_number(value, f"heightmap.heights[{index}]")
        for index, value in enumerate(raw_heights)
    ]
    return Heightmap(width, height, origin, cell_size, heights)


def load_terrain(terrain_spec: Any, road_file: Path) -> tuple[Mapping[str, Any], Heightmap]:
    if isinstance(terrain_spec, str):
        terrain_path = Path(terrain_spec)
        if not terrain_path.is_absolute():
            terrain_path = road_file.parent / terrain_path
        with terrain_path.open(encoding="utf-8") as handle:
            terrain_document = json.load(handle)
    elif isinstance(terrain_spec, Mapping):
        terrain_document = terrain_spec
    else:
        raise ValueError('"terrain" must be a JSON path or an embedded terrain object')

    if not isinstance(terrain_document, Mapping):
        raise ValueError("terrain JSON root must be an object")
    return terrain_document, parse_heightmap(terrain_document)


def load_input(path: Path) -> tuple[list[Point3], Heightmap, Mapping[str, Any], Mapping[str, float], Mapping[str, float]]:
    with path.open(encoding="utf-8") as handle:
        document = json.load(handle)
    if not isinstance(document, Mapping):
        raise ValueError("road JSON root must be an object")

    raw_curve = document.get("curve")
    if not isinstance(raw_curve, list) or len(raw_curve) < 2:
        raise ValueError('"curve" must contain at least two [x, y, z] vertices')
    curve = [parse_point3(vertex, f"curve[{index}]") for index, vertex in enumerate(raw_curve)]

    terrain_document, heightmap = load_terrain(document.get("terrain"), path)

    raw_constraints = document.get("constraints")
    if not isinstance(raw_constraints, Mapping):
        raise ValueError('"constraints" must be an object with w, maxs, and maxc')
    constraints = {
        "w": finite_number(raw_constraints.get("w"), "constraints.w"),
        "maxs": finite_number(raw_constraints.get("maxs"), "constraints.maxs"),
        "maxc": finite_number(raw_constraints.get("maxc"), "constraints.maxc"),
    }
    if constraints["w"] <= 0:
        raise ValueError("constraints.w must be greater than zero")
    if constraints["maxs"] < 0 or constraints["maxc"] < 0:
        raise ValueError("constraints.maxs and constraints.maxc must be nonnegative")

    raw_costs = document.get("costs")
    if not isinstance(raw_costs, Mapping):
        raise ValueError('"costs" must be an object with earth_dig and earth_fill')
    costs = {
        "earth_dig": finite_number(raw_costs.get("earth_dig"), "costs.earth_dig"),
        "earth_fill": finite_number(raw_costs.get("earth_fill"), "costs.earth_fill"),
    }
    if costs["earth_dig"] < 0 or costs["earth_fill"] < 0:
        raise ValueError("earthwork costs must be nonnegative")

    return curve, heightmap, terrain_document, constraints, costs


def subtract(a: Point2, b: Point2) -> Point2:
    return (a[0] - b[0], a[1] - b[1])


def dot(a: Point2, b: Point2) -> float:
    return a[0] * b[0] + a[1] * b[1]


def cross(a: Point2, b: Point2) -> float:
    return a[0] * b[1] - a[1] * b[0]


def norm(a: Point2) -> float:
    return math.hypot(a[0], a[1])


def endpoint_errors(
    curve: Sequence[Point3], terrain_document: Mapping[str, Any], heightmap: Heightmap
) -> list[str]:
    errors: list[str] = []
    for label, actual, field in (
        ("start", curve[0], "A"),
        ("end", curve[-1], "B"),
    ):
        if field not in terrain_document:
            continue
        index = terrain_document[field]
        if isinstance(index, bool) or not isinstance(index, int):
            errors.append(f"terrain.{field} must be an integer height index")
            continue
        if index < 0 or index >= len(heightmap.heights):
            errors.append(f"terrain.{field} index is outside the heightmap")
            continue
        expected = heightmap.vertex(index)
        if max(abs(actual[k] - expected[k]) for k in range(3)) > ENDPOINT_TOLERANCE_M:
            errors.append(
                f"curve {label} vertex does not match terrain.{field} position "
                f"({expected[0]:g}, {expected[1]:g}, {expected[2]:g})"
            )
    return errors


def point_on_segment(point: Point2, start: Point2, end: Point2) -> bool:
    direction = subtract(end, start)
    offset = subtract(point, start)
    tolerance = 1e-9 * max(1.0, norm(direction))
    if abs(cross(direction, offset)) > tolerance:
        return False
    return dot(offset, subtract(point, end)) <= tolerance


def point_in_polygon_strict(point: Point2, polygon: Sequence[Point2]) -> bool:
    inside = False
    previous = polygon[-1]
    for current in polygon:
        if point_on_segment(point, previous, current):
            return False
        if (current[1] > point[1]) != (previous[1] > point[1]):
            crossing_x = current[0] + (point[1] - current[1]) * (
                previous[0] - current[0]
            ) / (previous[1] - current[1])
            if point[0] < crossing_x:
                inside = not inside
        previous = current
    return inside


def proper_segment_intersection(a: Point2, b: Point2, c: Point2, d: Point2) -> bool:
    ab_c = cross(subtract(b, a), subtract(c, a))
    ab_d = cross(subtract(b, a), subtract(d, a))
    cd_a = cross(subtract(d, c), subtract(a, c))
    cd_b = cross(subtract(d, c), subtract(b, c))
    tolerance = 1e-10
    return (
        ((ab_c > tolerance and ab_d < -tolerance) or (ab_c < -tolerance and ab_d > tolerance))
        and ((cd_a > tolerance and cd_b < -tolerance) or (cd_a < -tolerance and cd_b > tolerance))
    )


def polygon_bounds(polygon: Sequence[Point2]) -> tuple[float, float, float, float]:
    xs = [point[0] for point in polygon]
    ys = [point[1] for point in polygon]
    return min(xs), min(ys), max(xs), max(ys)


def bounds_overlap(
    first: tuple[float, float, float, float],
    second: tuple[float, float, float, float],
) -> bool:
    return not (
        first[2] < second[0]
        or second[2] < first[0]
        or first[3] < second[1]
        or second[3] < first[1]
    )


def polygons_overlap(
    first: Sequence[Point2],
    first_center: Point2,
    second: Sequence[Point2],
    second_center: Point2,
) -> bool:
    if not bounds_overlap(polygon_bounds(first), polygon_bounds(second)):
        return False

    first_edges = list(zip(first, (*first[1:], first[0])))
    second_edges = list(zip(second, (*second[1:], second[0])))
    for a, b in first_edges:
        edge_bounds = (
            min(a[0], b[0]), min(a[1], b[1]), max(a[0], b[0]), max(a[1], b[1])
        )
        for c, d in second_edges:
            other_bounds = (
                min(c[0], d[0]), min(c[1], d[1]), max(c[0], d[0]), max(c[1], d[1])
            )
            if bounds_overlap(edge_bounds, other_bounds) and proper_segment_intersection(a, b, c, d):
                return True

    if any(point_in_polygon_strict(point, second) for point in first):
        return True
    if any(point_in_polygon_strict(point, first) for point in second):
        return True
    return point_in_polygon_strict(first_center, second) or point_in_polygon_strict(
        second_center, first
    )


def check_road(
    curve: Sequence[Point3],
    heightmap: Heightmap,
    terrain_document: Mapping[str, Any],
    constraints: Mapping[str, float],
) -> dict[str, Any]:
    width = constraints["w"]
    half_width = width / 2.0
    xy = [(vertex[0], vertex[1]) for vertex in curve]
    vectors = [subtract(xy[index + 1], xy[index]) for index in range(len(xy) - 1)]
    lengths = [norm(vector) for vector in vectors]
    path_errors: list[str] = endpoint_errors(curve, terrain_document, heightmap)

    for index, length in enumerate(lengths):
        if length <= GEOMETRY_EPSILON:
            path_errors.append(f"segment {index} has zero horizontal length")

    directions: list[Point2 | None] = [
        (vector[0] / length, vector[1] / length)
        if length > GEOMETRY_EPSILON
        else None
        for vector, length in zip(vectors, lengths)
    ]

    turns: list[float | None] = []
    curvatures: list[float | None] = []
    for index in range(1, len(curve) - 1):
        incoming = directions[index - 1]
        outgoing = directions[index]
        if incoming is None or outgoing is None:
            turns.append(None)
            curvatures.append(None)
            continue
        turn_cos = max(-1.0, min(1.0, dot(incoming, outgoing)))
        angle = math.acos(turn_cos)
        turns.append(angle)
        if norm((incoming[0] + outgoing[0], incoming[1] + outgoing[1])) <= GEOMETRY_EPSILON:
            path_errors.append(f"vertex {index} is an exact reversal")
        curvatures.append(2.0 * angle / (lengths[index - 1] + lengths[index]))

    grades: list[float | None] = []
    for index, (start, end, length) in enumerate(zip(curve, curve[1:], lengths)):
        if length <= GEOMETRY_EPSILON:
            grades.append(None)
        else:
            grade = abs(end[2] - start[2]) / length
            grades.append(grade)

    grade_violations = [
        {"segment": index, "grade": grade, "limit": constraints["maxs"]}
        for index, grade in enumerate(grades)
        if grade is not None and grade > constraints["maxs"] + 1e-12
    ]
    curvature_violations = [
        {"vertex": index + 1, "curvature": curvature, "limit": constraints["maxc"]}
        for index, curvature in enumerate(curvatures)
        if curvature is not None and curvature > constraints["maxc"] + 1e-12
    ]

    strip_errors: list[str] = []
    fold_error: str | None = None
    coverage_error: str | None = None
    first_boundary_violation: dict[str, Any] | None = None
    outside_boundary_samples = 0
    sampled_edge_count = 0
    sampled_road_bounds: list[float] | None = None
    strip_polygons: list[list[Point2]] = []
    strip_centers: list[Point2] = []
    vertex_normals: list[Point2] | None = None

    if all(direction is not None for direction in directions):
        unit_directions = [direction for direction in directions if direction is not None]
        tangents: list[Point2] = [unit_directions[0]]
        for index in range(1, len(curve) - 1):
            incoming = unit_directions[index - 1]
            outgoing = unit_directions[index]
            tangent_sum = (incoming[0] + outgoing[0], incoming[1] + outgoing[1])
            tangent_length = norm(tangent_sum)
            if tangent_length <= GEOMETRY_EPSILON:
                tangents.append((math.nan, math.nan))
            else:
                tangents.append((tangent_sum[0] / tangent_length, tangent_sum[1] / tangent_length))
        tangents.append(unit_directions[-1])
        if all(math.isfinite(component) for tangent in tangents for component in tangent):
            vertex_normals = [(-tangent[1], tangent[0]) for tangent in tangents]

    if vertex_normals is None:
        strip_errors.append("cross-section directions are undefined at a reversal")
    else:
        for segment_index, (vector, length) in enumerate(zip(vectors, lengths)):
            n0 = vertex_normals[segment_index]
            n1 = vertex_normals[segment_index + 1]
            if dot(n0, n1) <= -1.0 + 1e-12:
                strip_errors.append(
                    f"segment {segment_index} has opposite endpoint cross-section directions"
                )
                continue

            angle_change = abs(math.atan2(cross(n0, n1), dot(n0, n1)))
            sample_count = max(
                16,
                math.ceil(length / GEOMETRY_STEP_M),
                math.ceil(angle_change / math.radians(5.0)),
            )
            sample_count = min(sample_count, 10000)
            left_edge: list[Point2] = []
            right_edge: list[Point2] = []
            for sample in range(sample_count + 1):
                t = sample / sample_count
                raw_normal = (
                    (1.0 - t) * n0[0] + t * n1[0],
                    (1.0 - t) * n0[1] + t * n1[1],
                )
                raw_norm = norm(raw_normal)
                if raw_norm <= GEOMETRY_EPSILON:
                    strip_errors.append(
                        f"segment {segment_index} has an undefined interpolated cross-section"
                    )
                    break
                normal = (raw_normal[0] / raw_norm, raw_normal[1] / raw_norm)
                normal_delta = (n1[0] - n0[0], n1[1] - n0[1])
                projection = dot(raw_normal, normal_delta)
                normal_derivative = (
                    normal_delta[0] / raw_norm
                    - raw_normal[0] * projection / (raw_norm**3),
                    normal_delta[1] / raw_norm
                    - raw_normal[1] * projection / (raw_norm**3),
                )
                center = (
                    xy[segment_index][0] + t * vector[0],
                    xy[segment_index][1] + t * vector[1],
                )
                edges = []
                for side in (-1.0, 1.0):
                    u = side * half_width
                    edge_point = (
                        center[0] + u * normal[0],
                        center[1] + u * normal[1],
                    )
                    edges.append(edge_point)
                    sampled_edge_count += 1
                    if sampled_road_bounds is None:
                        sampled_road_bounds = [
                            edge_point[0], edge_point[1], edge_point[0], edge_point[1]
                        ]
                    else:
                        sampled_road_bounds[0] = min(sampled_road_bounds[0], edge_point[0])
                        sampled_road_bounds[1] = min(sampled_road_bounds[1], edge_point[1])
                        sampled_road_bounds[2] = max(sampled_road_bounds[2], edge_point[0])
                        sampled_road_bounds[3] = max(sampled_road_bounds[3], edge_point[1])
                    jacobian = cross(
                        (
                            vector[0] + u * normal_derivative[0],
                            vector[1] + u * normal_derivative[1],
                        ),
                        normal,
                    )
                    if jacobian <= GEOMETRY_EPSILON and fold_error is None:
                        fold_error = (
                            f"segment {segment_index} folds or has zero area near "
                            f"t={t:.4f}, u={u:.4f} m (Jacobian {jacobian:.6g})"
                        )
                    outside = []
                    if edge_point[0] < heightmap.origin[0] - 1e-9:
                        outside.append("west")
                    if edge_point[0] > heightmap.max_x + 1e-9:
                        outside.append("east")
                    if edge_point[1] < heightmap.origin[1] - 1e-9:
                        outside.append("south")
                    if edge_point[1] > heightmap.max_y + 1e-9:
                        outside.append("north")
                    if outside:
                        outside_boundary_samples += 1
                        if first_boundary_violation is None:
                            first_boundary_violation = {
                                "segment": segment_index,
                                "t": t,
                                "cross_section_side": "negative width edge" if side < 0 else "positive width edge",
                                "point_m": list(edge_point),
                                "outside_edges": outside,
                            }
                    if outside and coverage_error is None:
                        coverage_error = (
                            f"segment {segment_index} road edge leaves heightmap boundary "
                            f"near t={t:.4f}"
                        )
                left_edge.append(edges[0])
                right_edge.append(edges[1])

            if left_edge and right_edge:
                strip_polygons.append(left_edge + list(reversed(right_edge)))
                strip_centers.append(
                    (
                        xy[segment_index][0] + 0.5 * vector[0],
                        xy[segment_index][1] + 0.5 * vector[1],
                    )
                )

    overlap_pairs: list[list[int]] = []
    if len(strip_polygons) == len(vectors):
        for first_index in range(len(strip_polygons)):
            for second_index in range(first_index + 1, len(strip_polygons)):
                if polygons_overlap(
                    strip_polygons[first_index],
                    strip_centers[first_index],
                    strip_polygons[second_index],
                    strip_centers[second_index],
                ):
                    overlap_pairs.append([first_index, second_index])

    path_valid = not path_errors
    boundary_valid = sampled_edge_count > 0 and first_boundary_violation is None
    boundary_result = {
        "checked": sampled_edge_count > 0,
        "valid": boundary_valid,
        "terrain_bounds_m": {
            "x_min": heightmap.origin[0],
            "y_min": heightmap.origin[1],
            "x_max": heightmap.max_x,
            "y_max": heightmap.max_y,
        },
        "sampled_road_bounds_m": (
            {
                "x_min": sampled_road_bounds[0],
                "y_min": sampled_road_bounds[1],
                "x_max": sampled_road_bounds[2],
                "y_max": sampled_road_bounds[3],
            }
            if sampled_road_bounds is not None
            else None
        ),
        "outside_sample_count": outside_boundary_samples,
        "first_outside_sample": first_boundary_violation,
        "sampling_step_m": GEOMETRY_STEP_M,
    }
    strip_valid = (
        vertex_normals is not None
        and not strip_errors
        and fold_error is None
        and boundary_valid
        and not overlap_pairs
    )
    checks: dict[str, Any] = {
        "path_geometry": {"valid": path_valid, "errors": path_errors},
        "road_strip": {
            "valid": strip_valid,
            "folding": {"valid": fold_error is None, "error": fold_error},
            "boundary": boundary_result,
            "heightmap_coverage": {"valid": coverage_error is None, "error": coverage_error},
            "overlap": {"valid": not overlap_pairs, "segment_pairs": overlap_pairs},
            "errors": strip_errors,
            "sampling_step_m": GEOMETRY_STEP_M,
        },
        "grade": {
            "valid": not grade_violations and all(grade is not None for grade in grades),
            "maximum": max((grade for grade in grades if grade is not None), default=None),
            "limit": constraints["maxs"],
            "segment_values": grades,
            "violations": grade_violations,
        },
        "curvature": {
            "valid": not curvature_violations and all(value is not None for value in curvatures),
            "maximum": max((value for value in curvatures if value is not None), default=0.0),
            "limit": constraints["maxc"],
            "vertex_values": curvatures,
            "violations": curvature_violations,
        },
    }
    valid = all(check["valid"] for check in checks.values())
    return {"status": "valid" if valid else "invalid", "valid": valid, "checks": checks}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("road_json", type=Path, help="road input JSON")
    args = parser.parse_args()

    try:
        curve, heightmap, terrain_document, constraints, costs = load_input(args.road_json)
        result = check_road(curve, heightmap, terrain_document, constraints)
        result["costs"] = {
            "earth_dig": costs["earth_dig"],
            "earth_fill": costs["earth_fill"],
            "used_for_this_check": False,
        }
    except (OSError, json.JSONDecodeError, ValueError, KeyError) as error:
        result = {"status": "invalid_input", "valid": False, "error": str(error)}
        print(json.dumps(result, indent=2, allow_nan=False))
        return 2

    print(json.dumps(result, indent=2, allow_nan=False))
    return 0 if result["valid"] else 1


if __name__ == "__main__":
    sys.exit(main())
