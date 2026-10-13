# Problem 1: Solve earthwork for a fixed 2D road

## Goal

Choose the elevations of the interior road vertices for a fixed horizontal path. Keep the endpoint elevations fixed. Minimize the cost of road construction and earthwork while meeting the Problem 0 road constraints. Use the original terrain to calculate the cost.

## Given data

The original heightmap defines a bilinear ground surface $H(x,y)$ on the 100 × 100 grid in [Data conventions](data-convention.md). The fixed horizontal path has vertices $p_i=(x_i,y_i)$ for $i=0,\ldots,n$, where $n\geq1$. Its endpoints are the heightmap vertices selected by distinct indices $A$ and $B$, so their fixed elevations are $z_A=H(p_0)$ and $z_B=H(p_n)$. The inputs also include road width $w>0$, maximum grade $\mathrm{maxs}\geq0$, maximum discrete curvature $\mathrm{maxc}\geq0$, and nonnegative cost rates $r_b,e_d,e_f,e_i,e_x$, with at least one positive rate. Use the meanings and units in Data conventions.

The decision vector is $z=(z_0,\ldots,z_n)$. Only $z_1,\ldots,z_{n-1}$ can change; $z_0=z_A$ and $z_n=z_B$. The 3D road vertices are $P_i=(x_i,y_i,z_i)$. The exported interior elevations may be used as an initial display value, but they do not constrain the solution.

## Fixed footprint

Set $v_i=p_{i+1}-p_i$ and $\ell_i=\lVert v_i\rVert$ for $i=0,\ldots,n-1$. The horizontal geometry must have $\ell_i>0$ and no undefined reversal. Construct the vertex normals $N_i$ as in [Problem 0](problem0.md). For $0\leq t\leq1$ and $-w/2\leq u\leq w/2$, define

$$
\widetilde N_i(t)=(1-t)\cdot N_i+t\cdot N_{i+1},\qquad N_i(t)=\frac{\widetilde N_i(t)}{\lVert\widetilde N_i(t)\rVert},\qquad Q_i(t,u)=p_i+t\cdot v_i+u\cdot N_i(t).
$$

The road elevation and horizontal area element are

$$
Z_i(t,u;z)=(1-t)\cdot z_i+t\cdot z_{i+1},\qquad J_i(t,u)=\det\!\left(\partial_t Q_i(t,u),\partial_u Q_i(t,u)\right).
$$

The footprint $Q_i$ and area element $J_i$ depend only on the fixed path and $w$. Before optimization, require every strip to stay inside the heightmap, require $J_i(t,u)>0$, and reject overlaps between strip interiors. At each interior vertex, let $\theta_i$ be the turn angle between $v_{i-1}$ and $v_i$ and require

$$
\kappa_i=\frac{2\cdot\theta_i}{\ell_{i-1}+\ell_i}\leq\mathrm{maxc},\qquad i=1,\ldots,n-1.
$$

These path and curvature checks do not depend on $z$. Reject the input path if any of them fails.

## Elevation constraints

The grade of segment $i$ is $|z_{i+1}-z_i|/\ell_i$. The feasible elevations satisfy

$$
z_0=z_A,\qquad z_n=z_B,\qquad -\mathrm{maxs}\cdot\ell_i\leq z_{i+1}-z_i\leq\mathrm{maxs}\cdot\ell_i,\qquad i=0,\ldots,n-1.
$$

For a valid fixed path, a feasible elevation profile exists if and only if $|z_B-z_A|\leq\mathrm{maxs}\cdot\sum_{i=0}^{n-1}\ell_i$. If this inequality fails, report infeasible elevations.

## Volumes and cost

Write $[a]_+=\max(a,0)$. Positive $H(Q_i(t,u))-Z_i(t,u;z)$ means cut, and negative values mean fill. Calculate the two volumes separately:

$$
V_{\rm cut}(z)=\sum_{i=0}^{n-1}\int_0^1\int_{-w/2}^{w/2}[H(Q_i(t,u))-Z_i(t,u;z)]_+\cdot J_i(t,u)\,\mathrm{d}u\,\mathrm{d}t,
$$

$$
V_{\rm fill}(z)=\sum_{i=0}^{n-1}\int_0^1\int_{-w/2}^{w/2}[Z_i(t,u;z)-H(Q_i(t,u))]_+\cdot J_i(t,u)\,\mathrm{d}u\,\mathrm{d}t.
$$

Assume 1 m³ of cut soil can provide 1 m³ of fill. Apply the soil balance once to the full road:

$$
D(z)=V_{\rm fill}(z)-V_{\rm cut}(z)=\sum_{i=0}^{n-1}\int_0^1\int_{-w/2}^{w/2}[Z_i(t,u;z)-H(Q_i(t,u))]\cdot J_i(t,u)\,\mathrm{d}u\,\mathrm{d}t,
$$

$$
V_{\rm import}(z)=[D(z)]_+,\qquad V_{\rm export}(z)=[-D(z)]_+.
$$

The 3D centerline length and total cost are

$$
L(z)=\sum_{i=0}^{n-1}\sqrt{\ell_i^2+(z_{i+1}-z_i)^2},
$$

$$
C(z)=r_b\cdot L(z)+e_d\cdot V_{\rm cut}(z)+e_f\cdot V_{\rm fill}(z)+e_i\cdot V_{\rm import}(z)+e_x\cdot V_{\rm export}(z).
$$

The cost includes the items defined in Problem 0. It uses the original ground surface $H$, before terrain vertices are changed for the output.

## Optimization problem

After the fixed path passes its checks, solve

$$
\begin{aligned}
\underset{z\in\mathbb{R}^{n+1}}{\operatorname{minimize}}\quad & C(z)\\
\text{subject to}\quad & z_0=z_A,\quad z_n=z_B,\\
&-\mathrm{maxs}\cdot\ell_i\leq z_{i+1}-z_i\leq\mathrm{maxs}\cdot\ell_i,\quad i=0,\ldots,n-1.
\end{aligned}
$$

The road elevation is affine in $z$ at each point of the fixed footprint. Therefore $V_{\rm cut}$ and $V_{\rm fill}$ are convex in $z$, $D$ is affine in $z$, and $L$ is convex in $z$. With nonnegative cost rates, $C$ is convex. The grade constraints are linear. Any optimum is a global optimum of this continuous model.

## Sampled problem used by the solver

Numerical integration replaces each strip integral with positive weights $a_k=J_{i(k)}(t_k,u_k)\cdot\Delta t_k\cdot\Delta u_k$ at sample points $k$. Define $h_k=H(Q_{i(k)}(t_k,u_k))$ and $b_k(z)=(1-t_k)\cdot z_{i(k)}+t_k\cdot z_{i(k)+1}$. The solver minimizes the convex sampled cost

$$
\begin{aligned}
C_h(z)={}&r_b\cdot L(z)+e_d\cdot\sum_k a_k\cdot[h_k-b_k(z)]_++e_f\cdot\sum_k a_k\cdot[b_k(z)-h_k]_+\\
&+e_i\cdot[D_h(z)]_++e_x\cdot[-D_h(z)]_+,\qquad D_h(z)=\sum_k a_k\cdot[b_k(z)-h_k],
\end{aligned}
$$

under the same endpoint and grade constraints. Using the affine $D_h$ applies import or export once to the full road. The [current solver](scripts/solve_problem1.py) uses uniform midpoint samples with a default step of 0.25 m and solves this sampled problem with CVXPY and Clarabel. It then checks the road constraints and uses adaptive integration from the [cost calculator](scripts/calculate_road_cost.py) to estimate the cost under the continuous model. The reported sampled optimum is not a proof of an exact continuous optimum.

## Outputs

Report an optimal solution, an invalid fixed path, infeasible elevations, or a solver or numerical failure. For a solution, report the full 3D polyline, maximum grade, maximum discrete curvature, 3D length, cut and fill volumes, import and export volumes, each cost component, total cost, and the integration tolerance. If several elevation profiles have the same minimum cost, any one is valid.

Run `uv run python scripts/solve_problem1.py data/problem1-road-input.json`. The solver writes `data/problem1-road-solution.json` with the same top-level fields as the input. Its `curve` contains the optimized road elevations. For each heightmap vertex whose horizontal position lies inside the road footprint, the solver replaces the original terrain height with the road surface height at that position. All other heightmap vertices keep their original heights. The separate `data/problem1-road-report.json` records the earthwork cost calculated from the original terrain, before any heights are replaced. The heightmap has vertices 1 m apart, so cells crossed by a road edge only approximate the exact road shape.
