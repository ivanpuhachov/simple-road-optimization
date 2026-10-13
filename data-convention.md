# Data conventions

## Heightmap and coordinates

The heightmap has 100 × 100 vertices and 99 × 99 cells. Adjacent vertices are 1 m apart, so the grid covers 99 m × 99 m. The coordinate system is right handed: $x$ points east, $y$ points north, and $z$ points up. Grid vertex $(0,0)$ is the southwest corner at $(x,y)=(0,0)$.

Grid indices $i$ and $j$ run from 0 to 99. Index $i$ increases east and index $j$ increases north. The height array is row major, with the south row first: $k=100\cdot j+i$ and $z=\mathrm{height}[k]$. Thus, height index 0 is southwest, 99 is southeast, 9900 is northwest, and 9999 is northeast. A grid vertex has 3D position $(i,j,\mathrm{height}[100\cdot j+i])$ in metres.

## Inputs

- $A$ and $B$ are zero-based integer indices into the height array, from 0 to 9999. Their 3D positions, including elevations, are fixed by the heightmap.
- $w$ is the road width in metres.
- $\mathrm{maxs}$ is the maximum absolute road grade: vertical rise divided by horizontal distance. It is dimensionless. For example, $\mathrm{maxs}=0.1$ means 10%.
- $\mathrm{maxc}$ is the maximum discrete horizontal curvature in $1/\mathrm{m}$. Use the polyline turning-rate definition in [Problem 0](problem0.md).
- $r_b$ is the cost to build 1 m of road, measured along the 3D centerline. This rate applies to the given width $w$ and excludes earthwork.
- $e_d$ is the cost to excavate 1 m³ of ground, before any export cost.
- $e_f$ is the cost to place 1 m³ of fill, before any import cost.
- $e_i$ is the added cost to obtain and deliver 1 m³ of soil when fill exceeds cut.
- $e_x$ is the added cost to transport and dispose of 1 m³ of soil when cut exceeds fill.

The road JSON uses the field names `rb`, `ed`, `ef`, `ei`, and `ex` for the rates $r_b$, $e_d$, $e_f$, $e_i$, and $e_x$. Assume 1 m³ of cut soil can provide 1 m³ of fill. With 3D centerline length $L$, the total cost is $C=r_b\cdot L+e_d\cdot V_{\rm cut}+e_f\cdot V_{\rm fill}+e_i\cdot[V_{\rm fill}-V_{\rm cut}]_++e_x\cdot[V_{\rm cut}-V_{\rm fill}]_+$, where $[q]_+=\max(q,0)$. Road vertices use $(x,y,z)$ coordinates in metres.
