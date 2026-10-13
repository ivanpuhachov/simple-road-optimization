# Problem 0: Check and price a fixed road

## Goal

Given a heightmap and a fixed 3D polyline, check the road grade and horizontal curvature limits. Then calculate the work volumes, road length, and total cost for a level road surface of constant width. The polyline is an input to this problem. No route or elevation optimization occurs here.

## Inputs and units

- The heightmap $H(x,y)$ gives existing ground elevation. Use the grid, indexing, and units in [Data conventions](data-convention.md). Use bilinear interpolation between grid samples.
- The ordered polyline vertices are $P_i=(x_i,y_i,z_i)$, for $i=0,\ldots,n$, with $n\geq1$. $P_0$ and $P_n$ are the fixed 3D positions given by heightmap indices $A$ and $B$.
- The road width $w>0$ is measured in the horizontal plane across each road section, in metres.
- The maximum grade $\mathrm{maxs}\geq0$ is a rise divided by a horizontal run. For example, $0.10$ means 10%.
- The maximum discrete horizontal curvature $\mathrm{maxc}\geq0$ is in inverse metres. For a densely sampled smooth road, $1/\mathrm{maxc}$ is the approximate minimum radius when $\mathrm{maxc}>0$.
- The nonnegative cost rates $r_b$, $e_d$, $e_f$, $e_i$, and $e_x$ have the meanings and units in Data conventions.

## Road surface

Let $p_i=(x_i,y_i)$, $v_i=p_{i+1}-p_i$, and $\ell_i=\lVert v_i\rVert$. Reject a segment with $\ell_i=0$. At an internal vertex, estimate the forward tangent from the normalized sum of the incoming and outgoing unit segment directions. At an endpoint, use its adjacent segment direction. Rotate each tangent by 90 degrees to get a unit cross-section direction $N_i$. Reject an exact reversal, for which the internal tangent is undefined.

For each segment, set $\widetilde N_i(t)=(1-t)\cdot N_i+t\cdot N_{i+1}$ and $N_i(t)=\widetilde N_i(t)/\lVert\widetilde N_i(t)\rVert$, where $0\leq t\leq1$. The road surface is the following swept strip, with $-w/2\leq u\leq w/2$:

$$
Q_i(t,u)=(1-t)\cdot p_i+t\cdot p_{i+1}+u\cdot N_i(t),\qquad Z_i(t,u)=(1-t)\cdot z_i+t\cdot z_{i+1}.
$$

Each cross section has width $w$ and one elevation. Adjacent strips meet at the same cross section and elevation. The cross-section directions approximate normals to a smooth road as the polyline is sampled more densely. Reject a strip that folds, leaves the heightmap, or overlaps another strip outside their shared boundary. These checks keep the road surface single valued.

## Constraint checks

**Grade.** For every segment, calculate $g_i=|z_{i+1}-z_i|/\ell_i$. The centerline grade is valid when $g_i\leq\mathrm{maxs}$ for all $i$. This definition uses horizontal run, rather than 3D segment length.

**Curvature.** At each internal vertex, let $\theta_i\in[0,\pi]$ be the turn angle between $v_{i-1}$ and $v_i$. Use the discrete turning rate

$$
\kappa_i=\frac{2\cdot\theta_i}{\ell_{i-1}+\ell_i}.
$$

The discrete curvature check passes when $\kappa_i\leq\mathrm{maxc}$ at every internal vertex. A literal polyline has a sharp corner and no finite classical curvature at that corner. Thus, this check treats the vertices as samples of an intended smooth centerline. Its result depends on sample spacing. A later design stage can check curvature on a specified smooth reconstruction of the road.

The grade limit above applies to the centerline. If the limit must apply to every longitudinal line across the full width, also check the shorter path along the inside of each bend. Define that stronger rule before using it as an acceptance criterion.

## Work volumes and cost

Use the horizontal area element $J_i(t,u)=\det(\partial_t Q_i,\partial_u Q_i)$. A valid strip has $J_i(t,u)>0$. With $[a]_+=\max(a,0)$, the volumes are

$$
V_{\rm cut}=\sum_i\int_0^1\int_{-w/2}^{w/2}[H(Q_i(t,u))-Z_i(t,u)]_+\cdot J_i(t,u)\,\mathrm{d}u\,\mathrm{d}t,
$$

$$
V_{\rm fill}=\sum_i\int_0^1\int_{-w/2}^{w/2}[Z_i(t,u)-H(Q_i(t,u))]_+\cdot J_i(t,u)\,\mathrm{d}u\,\mathrm{d}t.
$$

Assume all excavated soil can be reused as fill, with no change in volume. The imported and exported volumes are $V_{\rm import}=[V_{\rm fill}-V_{\rm cut}]_+$ and $V_{\rm export}=[V_{\rm cut}-V_{\rm fill}]_+$. The 3D centerline length is $L=\sum_i\sqrt{\ell_i^2+(z_{i+1}-z_i)^2}$. The total cost is

$$
C=r_b\cdot L+e_d\cdot V_{\rm cut}+e_f\cdot V_{\rm fill}+e_i\cdot V_{\rm import}+e_x\cdot V_{\rm export}.
$$

The road-building rate covers construction for the given width $w$ after grading. The import rate adds procurement and delivery cost to fill work. The export rate adds removal and disposal cost to dig work. Integrate the cut and fill volumes numerically over each strip. Refine the integration near heightmap cell boundaries and where the difference between road and ground changes sign. Report the integration tolerance with the result.

This model prices vertical cut and fill inside the road footprint and a fixed rate for each metre of built road. It does not include grading outside the road edges, hauling soil between points on the site, drainage, bridges, or tunnels. Those items require more inputs and can be added later.

## Output

Return a validity result and clear reasons for any failure. Report the maximum segment grade, maximum discrete curvature, 3D centerline length, cut volume, fill volume, import volume, export volume, each cost component, and total cost. A geometric or heightmap coverage failure makes the cost undefined. A grade or curvature failure can still have a computed cost, but the result must be marked invalid.

## Current scripts

The [constraint checker](scripts/check_road_constraints.py) reads a road JSON object with four required fields: `curve`, `terrain`, `constraints`, and `costs`. `curve` contains at least two finite 3D vertices, each as `[x, y, z]` or an object with `x`, `y`, and `z`. `terrain` is an embedded terrain object or a JSON path relative to the road JSON file. The terrain object supplies `heightmap`, `A`, and `B`. `constraints` supplies `w`, `maxs`, and `maxc`. `costs` supplies `rb`, `ed`, `ef`, `ei`, and `ex`. The checker validates the cost rates but does not use them to calculate length, volumes, or price; its output marks them with `used_for_this_check: false`.

The checker returns `status: valid` or `status: invalid` with separate `path_geometry`, `road_strip`, `grade`, and `curvature` checks. Bad or missing input returns `status: invalid_input`. The `road_strip.boundary` result gives terrain bounds, sampled road bounds, the number of outside edge samples, and the first outside sample with its segment, position, and boundary direction. Use `road_strip.valid` together with `path_geometry.valid` before pricing. `road_strip.heightmap_coverage.valid` alone does not prove coverage when strip sampling could not run.

The separate [cost calculator](scripts/calculate_road_cost.py) reads the same road JSON and calls the checker before pricing. It uses NumPy to integrate cut and fill over the swept strip with bilinear ground interpolation. It refines a uniform midpoint grid until the change in each volume meets the requested absolute and relative tolerances. The reported change is an empirical error estimate, not a proven bound. It also checks every integration point for heightmap coverage and a positive area element. If path or strip geometry is invalid, or integration does not converge, the total cost is undefined. A grade or curvature violation keeps the result invalid but does not prevent pricing. Run it with `uv run python scripts/calculate_road_cost.py road.json`; use `--volume-atol-m3`, `--volume-rtol`, `--initial-step-m`, and `--max-refinements` to control integration.

## Edge cases and weak points

- **Input contract.** Require two distinct heightmap indices $A$ and $B$ in the range 0–9999. The first and last road vertices must match their 3D heightmap positions. Require a 100 × 100 grid with origin `[0, 0]`, cell size `[1, 1]`, and 10,000 finite elevations. The checker uses a 10⁻⁸ m endpoint tolerance and rejects horizontal segments at or below 10⁻¹⁰ m.
- **Cost field names.** The equation symbols $r_b$, $e_d$, $e_f$, $e_i$, and $e_x$ map to the road JSON cost fields `rb`, `ed`, `ef`, `ei`, and `ex`. The terrain generator also writes these names at the terrain JSON root as example rates. The checker reads rates from the road JSON `costs` object, so a caller must supply that object even when the terrain file contains example rates.
- **Grid edge.** Check the full road strip, including its first and last cross sections. A centerline point can be inside the grid while part of the strip is outside. The current generated terrains set $A=0$ and $B=9999$. Their corner endpoints make full heightmap coverage impossible for any $w>0$ under the centered cross-section rule. Choose interior endpoints or provide more terrain around them.
- **Strip geometry.** Reject exact or near reversals, a nonpositive area element $J_i$, and overlaps between strip interiors. Do not count an overlapping area twice. The current checker samples strip edges at a nominal maximum 0.25 m step, with at least 16 intervals per segment and extra samples for normal rotation. It uses sampled polygons to find overlaps. It can miss a fold, boundary crossing, or overlap between samples, so treat its geometry result as an approximate check.
- **Terrain surface.** Use bilinear height interpolation and never extrapolate outside the grid. The terrain OBJ generator splits each cell into triangles, so the displayed mesh can differ from the bilinear surface inside a cell. The cost calculation must use the surface defined here.
- **Cut and fill.** Calculate cut and fill separately at each area sample. Both can occur in one cross section. Netting the signed height difference before integration loses work volume. Apply the import or export balance once to the total volumes for the whole road, not once per segment or cell.
- **Soil reuse.** The balance formula assumes all cut soil is suitable for fill and that 1 m³ of cut produces 1 m³ of fill. Soil loss, expansion, compaction, or material quality needs more inputs and a different balance formula.
- **Numerical precision.** A sign change between road and ground can occur inside a heightmap cell or integration panel. Refine these panels and report an error estimate for $V_{\rm cut}$ and $V_{\rm fill}$. If the requested accuracy is not reached, report a numerical failure instead of an authoritative total cost. Use a stated tolerance for grade, curvature, coverage, and fold checks near their limits.
