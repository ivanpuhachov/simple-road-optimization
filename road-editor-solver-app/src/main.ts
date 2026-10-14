import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import './style.css';

type Point2 = { x: number; y: number };
type TerrainFile = {
  terrain: { type: string; description: string };
  heightmap: {
    width: number;
    height: number;
    origin_m: [number, number];
    cell_size_m: [number, number];
    units: string;
    heights: number[];
    [key: string]: unknown;
  };
  A?: number;
  B?: number;
  [key: string]: unknown;
};
type RoadDocument = {
  curve: number[][];
  terrain: TerrainFile;
  constraints: { w: number; maxs: number; maxc: number };
  costs: { rb: number; ed: number; ef: number; ei: number; ex: number };
  problem2?: { control_indices: number[] };
};
type CostReport = {
  status: string;
  valid: boolean;
  length_m: number;
  total_cost: number;
  volumes_m3: { cut: number; fill: number; import: number; export: number };
};
type SolveResponse = {
  status: string;
  valid?: boolean;
  error?: string;
  solution?: RoadDocument;
  report?: CostReport;
  checks?: Record<string, unknown>;
};
type MapFrame = { left: number; top: number; scale: number; width: number; height: number };
type HandleName = 'c1' | 'c2';
type DragTarget = HandleName | 'A' | 'B';
type EndpointMode = 'A' | 'B' | null;

const terrainTitles: Record<string, string> = {
  flat: 'Flat field',
  cliff: 'Diagonal cliff',
  centered_hill: 'Central hill',
  diagonal_ridge: 'Diagonal ridge',
  random_hills: 'Rolling hills',
};

const terrainSelect = document.querySelector<HTMLSelectElement>('#terrain-select')!;
const mapCanvas = document.querySelector<HTMLCanvasElement>('#map-canvas')!;
const mapContext = mapCanvas.getContext('2d')!;
const sceneHost = document.querySelector<HTMLDivElement>('#scene-host')!;
const sceneLoading = document.querySelector<HTMLDivElement>('#scene-loading')!;
const sceneError = document.querySelector<HTMLDivElement>('#scene-error')!;
const planStatus = document.querySelector<HTMLSpanElement>('#plan-status')!;
const mapInstruction = document.querySelector<HTMLSpanElement>('#map-instruction')!;
const solveButton = document.querySelector<HTMLButtonElement>('#solve-road')!;
const solve2dButton = document.querySelector<HTMLButtonElement>('#solve-road-2d')!;
const importSolutionButton = document.querySelector<HTMLButtonElement>('#import-solution')!;
const solutionFilesInput = document.querySelector<HTMLInputElement>('#solution-files')!;
const endpointAButton = document.querySelector<HTMLButtonElement>('#set-a')!;
const endpointBButton = document.querySelector<HTMLButtonElement>('#set-b')!;
const widthInput = document.querySelector<HTMLInputElement>('#width')!;
const sampleSpacingInput = document.querySelector<HTMLInputElement>('#sample-spacing')!;
const movablePointsSelect = document.querySelector<HTMLSelectElement>('#movable-points')!;
const routeDetailSummary = document.querySelector<HTMLParagraphElement>('#route-detail-summary')!;
const routeDetailDialog = document.querySelector<HTMLDialogElement>('#route-detail-dialog')!;
const previewState = document.querySelector<HTMLSpanElement>('#preview-state')!;
const originalTerrainLegend = document.querySelector<HTMLDivElement>('#solution-legend')!;
const defaultPreviewLegend = document.querySelector<HTMLDivElement>('#default-preview-legend')!;
const solutionStats = document.querySelector<HTMLDivElement>('#solution-stats')!;
const surfaceSelector = document.querySelector<HTMLFieldSetElement>('#surface-selector')!;
const originalSurfaceRadio = document.querySelector<HTMLInputElement>('#surface-original')!;
const solutionSurfaceRadio = document.querySelector<HTMLInputElement>('#surface-solution')!;
const originalSurfaceKey = document.querySelector<HTMLElement>('#original-surface-key')!;
const solutionSurfaceKey = document.querySelector<HTMLElement>('#solution-surface-key')!;

const scene = new THREE.Scene();
scene.background = new THREE.Color('#182421');
scene.fog = new THREE.Fog('#182421', 180, 420);

let camera: THREE.PerspectiveCamera | THREE.OrthographicCamera = new THREE.PerspectiveCamera(38, 1, 0.1, 1200);
camera.up.set(0, 0, 1);
let projectionMode: 'perspective' | 'orthographic' = 'perspective';

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.12;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
sceneHost.prepend(renderer.domElement);
renderer.domElement.setAttribute('aria-label', 'Three dimensional terrain and solved road. Drag to rotate and scroll to zoom.');

let controls = createOrbitControls(camera);
controls.target.set(49.5, 49.5, 0);

scene.add(new THREE.HemisphereLight('#eff1d7', '#30433b', 2.2));
const keyLight = new THREE.DirectionalLight('#fff0d4', 3.1);
keyLight.position.set(-45, -40, 115);
keyLight.castShadow = true;
keyLight.shadow.mapSize.set(2048, 2048);
keyLight.shadow.camera.left = -100;
keyLight.shadow.camera.right = 100;
keyLight.shadow.camera.top = 100;
keyLight.shadow.camera.bottom = -100;
keyLight.shadow.bias = -0.0003;
scene.add(keyLight);
const fillLight = new THREE.DirectionalLight('#9bbab5', 1.05);
fillLight.position.set(85, 55, 60);
scene.add(fillLight);

const terrainColors = [
  { at: 0, color: new THREE.Color('#537b69') },
  { at: 0.16, color: new THREE.Color('#77936a') },
  { at: 0.42, color: new THREE.Color('#a2a276') },
  { at: 0.68, color: new THREE.Color('#b98d69') },
  { at: 0.88, color: new THREE.Color('#d1b58b') },
  { at: 1, color: new THREE.Color('#eee0bd') },
];
const solutionTerrainColors = [
  { at: 0, color: new THREE.Color('#35566f') },
  { at: 0.16, color: new THREE.Color('#4d7289') },
  { at: 0.42, color: new THREE.Color('#7397a4') },
  { at: 0.68, color: new THREE.Color('#9cb8bb') },
  { at: 0.88, color: new THREE.Color('#c6d3cd') },
  { at: 1, color: new THREE.Color('#e2e8d9') },
];

let currentData: TerrainFile | null = null;
let currentTerrainKey = 'flat';
let activeEndpoint: EndpointMode = null;
let activeDrag: DragTarget | null = null;
let dragStartPoint: Point2 | null = null;
let dragControlStart: Point2 | null = null;
let roadDirty = true;
let hasRoadPreview = false;
let sceneTerrainKey = '';
let terrainMesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial> | null = null;
let roadMesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial> | null = null;
let comparisonTerrainLines: THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial> | null = null;
const referenceAxes = new THREE.Group();
scene.add(referenceAxes);
let solutionImported = false;
let solutionOriginalTerrain: TerrainFile | null = null;
let solutionSolvedTerrain: TerrainFile | null = null;
let importedSolutionPlan: Point2[] | null = null;
let endpointAIndex = 2020;
let endpointBIndex = 7979;
let controlA: Point2 = { x: 34, y: 34 };
let controlB: Point2 = { x: 65, y: 65 };
let loadSequence = 0;
let editVersion = 0;
let solving = false;
let terrainLoading = false;

const MAX_CURVE_SEGMENTS = 200;

function colorAt(normalizedHeight: number, palette = terrainColors): THREE.Color {
  const value = THREE.MathUtils.clamp(normalizedHeight, 0, 1);
  for (let index = 1; index < palette.length; index += 1) {
    const upper = palette[index];
    if (value <= upper.at) {
      const lower = palette[index - 1];
      const local = (value - lower.at) / (upper.at - lower.at);
      return lower.color.clone().lerp(upper.color, local);
    }
  }
  return palette[palette.length - 1].color.clone();
}

function pointForIndex(index: number): Point2 {
  if (!currentData) return { x: 0, y: 0 };
  const map = currentData.heightmap;
  const i = index % map.width;
  const j = Math.floor(index / map.width);
  return {
    x: map.origin_m[0] + i * map.cell_size_m[0],
    y: map.origin_m[1] + j * map.cell_size_m[1],
  };
}

function indexForPoint(point: Point2): number {
  if (!currentData) return 0;
  const map = currentData.heightmap;
  const i = THREE.MathUtils.clamp(
    Math.round((point.x - map.origin_m[0]) / map.cell_size_m[0]),
    0,
    map.width - 1,
  );
  const j = THREE.MathUtils.clamp(
    Math.round((point.y - map.origin_m[1]) / map.cell_size_m[1]),
    0,
    map.height - 1,
  );
  return j * map.width + i;
}

function groundAt(x: number, y: number): number {
  if (!currentData) return 0;
  const map = currentData.heightmap;
  const fx = THREE.MathUtils.clamp((x - map.origin_m[0]) / map.cell_size_m[0], 0, map.width - 1);
  const fy = THREE.MathUtils.clamp((y - map.origin_m[1]) / map.cell_size_m[1], 0, map.height - 1);
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(map.width - 1, x0 + 1);
  const y1 = Math.min(map.height - 1, y0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const h00 = map.heights[y0 * map.width + x0];
  const h10 = map.heights[y0 * map.width + x1];
  const h01 = map.heights[y1 * map.width + x0];
  const h11 = map.heights[y1 * map.width + x1];
  const south = h00 * (1 - tx) + h10 * tx;
  const north = h01 * (1 - tx) + h11 * tx;
  return south * (1 - ty) + north * ty;
}

function resetHandles(): void {
  if (!currentData) return;
  const a = pointForIndex(endpointAIndex);
  const b = pointForIndex(endpointBIndex);
  controlA = { x: a.x + (b.x - a.x) / 3, y: a.y + (b.y - a.y) / 3 };
  controlB = { x: a.x + (2 * (b.x - a.x)) / 3, y: a.y + (2 * (b.y - a.y)) / 3 };
}

function bezierAt(t: number): Point2 {
  const a = pointForIndex(endpointAIndex);
  const b = pointForIndex(endpointBIndex);
  const oneMinus = 1 - t;
  const aa = oneMinus * oneMinus * oneMinus;
  const ab = 3 * oneMinus * oneMinus * t;
  const ac = 3 * oneMinus * t * t;
  const ad = t * t * t;
  return {
    x: aa * a.x + ab * controlA.x + ac * controlB.x + ad * b.x,
    y: aa * a.y + ab * controlA.y + ac * controlB.y + ad * b.y,
  };
}

function desiredBezierSegments(spacing: number): number {
  const a = pointForIndex(endpointAIndex);
  const b = pointForIndex(endpointBIndex);
  const controlLength = Math.hypot(controlA.x - a.x, controlA.y - a.y)
    + Math.hypot(controlB.x - controlA.x, controlB.y - controlA.y)
    + Math.hypot(b.x - controlB.x, b.y - controlB.y);
  return Math.max(2, Math.ceil(controlLength / spacing));
}

function sampleBezier(): Point2[] {
  const rawSpacing = sampleSpacingInput.valueAsNumber;
  const spacing = Number.isFinite(rawSpacing) && rawSpacing > 0 ? rawSpacing : 3;
  const count = Math.min(desiredBezierSegments(spacing), MAX_CURVE_SEGMENTS);
  return Array.from({ length: count + 1 }, (_, index) => bezierAt(index / count));
}

function moveControlIndices(vertexCount: number): number[] {
  const interiorCount = Math.max(0, vertexCount - 2);
  const requested = movablePointsSelect.value === 'all'
    ? interiorCount : Number(movablePointsSelect.value);
  const count = Math.min(interiorCount, requested);
  return Array.from({ length: count }, (_, index) =>
    Math.round((index + 1) * (interiorCount + 1) / (count + 1)));
}

function getMapFrame(): MapFrame {
  const width = mapCanvas.clientWidth;
  const height = mapCanvas.clientHeight;
  if (!currentData) return { left: 0, top: 0, scale: 1, width, height };
  const map = currentData.heightmap;
  const padding = 30;
  const worldWidth = (map.width - 1) * map.cell_size_m[0];
  const worldHeight = (map.height - 1) * map.cell_size_m[1];
  const scale = Math.max(0.01, Math.min((width - padding * 2) / worldWidth, (height - padding * 2) / worldHeight));
  const pixelWidth = worldWidth * scale;
  const pixelHeight = worldHeight * scale;
  return {
    left: (width - pixelWidth) / 2,
    top: (height - pixelHeight) / 2,
    scale,
    width: pixelWidth,
    height: pixelHeight,
  };
}

function toCanvas(point: Point2, frame: MapFrame): Point2 {
  if (!currentData) return { x: 0, y: 0 };
  const map = currentData.heightmap;
  return {
    x: frame.left + ((point.x - map.origin_m[0]) / map.cell_size_m[0]) * frame.scale,
    y: frame.top + frame.height - ((point.y - map.origin_m[1]) / map.cell_size_m[1]) * frame.scale,
  };
}

function fromCanvas(point: Point2, frame: MapFrame): Point2 {
  if (!currentData) return { x: 0, y: 0 };
  const map = currentData.heightmap;
  const i = THREE.MathUtils.clamp((point.x - frame.left) / frame.scale, 0, map.width - 1);
  const j = THREE.MathUtils.clamp((frame.top + frame.height - point.y) / frame.scale, 0, map.height - 1);
  return {
    x: map.origin_m[0] + i * map.cell_size_m[0],
    y: map.origin_m[1] + j * map.cell_size_m[1],
  };
}

function drawMap(): void {
  if (!currentData) return;
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  const width = mapCanvas.clientWidth;
  const height = mapCanvas.clientHeight;
  if (width < 1 || height < 1) return;
  if (mapCanvas.width !== Math.round(width * pixelRatio) || mapCanvas.height !== Math.round(height * pixelRatio)) {
    mapCanvas.width = Math.round(width * pixelRatio);
    mapCanvas.height = Math.round(height * pixelRatio);
  }
  mapContext.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  mapContext.clearRect(0, 0, width, height);
  mapContext.fillStyle = '#e3e6da';
  mapContext.fillRect(0, 0, width, height);

  const map = currentData.heightmap;
  const frame = getMapFrame();
  const cellWidth = map.cell_size_m[0] * frame.scale;
  const cellHeight = map.cell_size_m[1] * frame.scale;
  const low = Math.min(...map.heights);
  const high = Math.max(...map.heights);
  const range = high - low || 1;

  for (let j = 0; j < map.height - 1; j += 1) {
    for (let i = 0; i < map.width - 1; i += 1) {
      const elevation = (
        map.heights[j * map.width + i]
        + map.heights[j * map.width + i + 1]
        + map.heights[(j + 1) * map.width + i]
        + map.heights[(j + 1) * map.width + i + 1]
      ) / 4;
      const color = colorAt((elevation - low) / range);
      const x = frame.left + i * cellWidth;
      const y = frame.top + frame.height - (j + 1) * cellHeight;
      mapContext.fillStyle = '#' + color.getHexString();
      mapContext.fillRect(x, y, cellWidth + 0.35, cellHeight + 0.35);
    }
  }

  mapContext.strokeStyle = '#e9eadf9c';
  mapContext.lineWidth = 0.65;
  mapContext.beginPath();
  for (let i = 0; i < map.width; i += 10) {
    const x = frame.left + i * cellWidth;
    mapContext.moveTo(x, frame.top);
    mapContext.lineTo(x, frame.top + frame.height);
  }
  for (let j = 0; j < map.height; j += 10) {
    const y = frame.top + frame.height - j * cellHeight;
    mapContext.moveTo(frame.left, y);
    mapContext.lineTo(frame.left + frame.width, y);
  }
  mapContext.stroke();
  mapContext.strokeStyle = '#f1f0e8';
  mapContext.lineWidth = 1;
  mapContext.strokeRect(frame.left, frame.top, frame.width, frame.height);

  const start = toCanvas(pointForIndex(endpointAIndex), frame);
  const end = toCanvas(pointForIndex(endpointBIndex), frame);
  const firstHandle = toCanvas(controlA, frame);
  const secondHandle = toCanvas(controlB, frame);
  if (!importedSolutionPlan) {
    mapContext.setLineDash([4, 4]);
    mapContext.strokeStyle = '#f8f6e8d9';
    mapContext.lineWidth = 1.1;
    mapContext.beginPath();
    mapContext.moveTo(start.x, start.y);
    mapContext.lineTo(firstHandle.x, firstHandle.y);
    mapContext.moveTo(end.x, end.y);
    mapContext.lineTo(secondHandle.x, secondHandle.y);
    mapContext.stroke();
    mapContext.setLineDash([]);
  }

  const route = importedSolutionPlan || sampleBezier();
  const moveIndices = moveControlIndices(route.length);
  const moveCount = moveIndices.length;
  routeDetailSummary.textContent = route.length + ' road vertices · '
    + moveCount + ' move ' + (moveCount === 1 ? 'point' : 'points')
    + ' · up to ' + Math.min(60, 8 + 4 * moveCount) + ' search trials';
  const curve = route.map((point) => toCanvas(point, frame));
  mapContext.beginPath();
  curve.forEach((point, index) => {
    if (index === 0) mapContext.moveTo(point.x, point.y);
    else mapContext.lineTo(point.x, point.y);
  });
  mapContext.lineCap = 'round';
  mapContext.lineJoin = 'round';
  mapContext.strokeStyle = '#f5f1df';
  mapContext.lineWidth = Math.max(4, Number(widthInput.value || 5) * frame.scale);
  mapContext.stroke();
  mapContext.strokeStyle = '#617a53';
  mapContext.lineWidth = 2;
  mapContext.stroke();

  if (!importedSolutionPlan && moveCount < route.length - 2) {
    for (const index of moveIndices) {
      const point = curve[index];
      mapContext.beginPath();
      mapContext.arc(point.x, point.y, 3.5, 0, Math.PI * 2);
      mapContext.fillStyle = '#f8f7ef';
      mapContext.fill();
      mapContext.lineWidth = 1.5;
      mapContext.strokeStyle = '#476447';
      mapContext.stroke();
    }
  }

  if (!importedSolutionPlan) {
    drawHandle(firstHandle, 'P1');
    drawHandle(secondHandle, 'P2');
  }
  drawEndpoint(start, 'A', '#577a57');
  drawEndpoint(end, 'B', '#c47d59');
  updateEndpointLabels();
  document.querySelector('#vertex-count')!.textContent = String(route.length);
}

function drawHandle(point: Point2, label: string): void {
  mapContext.beginPath();
  mapContext.arc(point.x, point.y, 7, 0, Math.PI * 2);
  mapContext.fillStyle = '#f8f7ef';
  mapContext.fill();
  mapContext.lineWidth = 2;
  mapContext.strokeStyle = '#526c48';
  mapContext.stroke();
  mapContext.fillStyle = '#42533b';
  mapContext.font = '8px "DM Mono", monospace';
  mapContext.textAlign = 'center';
  mapContext.fillText(label, point.x, point.y - 11);
}

function drawEndpoint(point: Point2, label: string, color: string): void {
  mapContext.beginPath();
  mapContext.arc(point.x, point.y, 8, 0, Math.PI * 2);
  mapContext.fillStyle = '#f8f7ef';
  mapContext.fill();
  mapContext.lineWidth = 3;
  mapContext.strokeStyle = color;
  mapContext.stroke();
  mapContext.fillStyle = color;
  mapContext.font = 'bold 9px "DM Sans", sans-serif';
  mapContext.textAlign = 'center';
  mapContext.textBaseline = 'middle';
  mapContext.fillText(label, point.x, point.y + 0.5);
}

function updateEndpointLabels(): void {
  if (!currentData) return;
  const a = pointForIndex(endpointAIndex);
  const b = pointForIndex(endpointBIndex);
  document.querySelector('#a-index')!.textContent = String(endpointAIndex);
  document.querySelector('#b-index')!.textContent = String(endpointBIndex);
  document.querySelector('#a-coords')!.textContent = '(' + a.x.toFixed(0) + ', ' + a.y.toFixed(0) + ')';
  document.querySelector('#b-coords')!.textContent = '(' + b.x.toFixed(0) + ', ' + b.y.toFixed(0) + ')';
}

function setDirty(message?: string, routeChanged = false): void {
  editVersion += 1;
  sceneError.hidden = true;
  const wasShowingSolution = routeChanged && importedSolutionPlan !== null;
  if (routeChanged) importedSolutionPlan = null;
  if (wasShowingSolution) {
    mapInstruction.textContent = activeEndpoint
      ? 'Click a heightmap grid point to set endpoint ' + activeEndpoint + '.'
      : 'Drag A / B to move endpoints, or P1 / P2 to shape the curve.';
  }
  roadDirty = true;
  if (hasRoadPreview) {
    solutionStats.hidden = true;
    previewState.textContent = 'SOLUTION STALE';
    previewState.className = 'preview-state stale';
  }
  planStatus.textContent = message || (hasRoadPreview ? 'Inputs changed · solve again' : 'Route ready · press Solve');
  drawMap();
}

function setEndpointSelection(mode: EndpointMode): void {
  activeEndpoint = mode;
  endpointAButton.setAttribute('aria-pressed', String(mode === 'A'));
  endpointBButton.setAttribute('aria-pressed', String(mode === 'B'));
  mapCanvas.classList.toggle('pick-mode', mode !== null);
  mapInstruction.textContent = mode
    ? 'Click a heightmap grid point to set endpoint ' + mode + '.'
    : importedSolutionPlan
      ? 'Solution route shown · reset curve to edit Bézier handles.'
      : 'Drag A / B to move endpoints, or P1 / P2 to shape the curve.';
}

function eventPoint(event: PointerEvent): Point2 {
  const rect = mapCanvas.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function handleAt(point: Point2, frame: MapFrame): HandleName | null {
  if (importedSolutionPlan) return null;
  const c1 = toCanvas(controlA, frame);
  const c2 = toCanvas(controlB, frame);
  const d1 = Math.hypot(point.x - c1.x, point.y - c1.y);
  const d2 = Math.hypot(point.x - c2.x, point.y - c2.y);
  if (Math.min(d1, d2) > 15) return null;
  return d1 < d2 ? 'c1' : 'c2';
}

function endpointAt(point: Point2, frame: MapFrame): 'A' | 'B' | null {
  const a = toCanvas(pointForIndex(endpointAIndex), frame);
  const b = toCanvas(pointForIndex(endpointBIndex), frame);
  const dA = Math.hypot(point.x - a.x, point.y - a.y);
  const dB = Math.hypot(point.x - b.x, point.y - b.y);
  if (Math.min(dA, dB) > 16) return null;
  return dA <= dB ? 'A' : 'B';
}

function setPickedEndpoint(mode: 'A' | 'B', point: Point2): void {
  const index = indexForPoint(point);
  if ((mode === 'A' && index === endpointBIndex) || (mode === 'B' && index === endpointAIndex)) {
    planStatus.textContent = 'A and B must be different heightmap indices';
    return;
  }
  if (mode === 'A') endpointAIndex = index;
  else endpointBIndex = index;
  resetHandles();
  setEndpointSelection(null);
  setDirty('Endpoint updated · adjust curve or solve again', true);
}

mapCanvas.addEventListener('pointerdown', (event) => {
  if (!currentData) return;
  const point = eventPoint(event);
  if (activeEndpoint) {
    setPickedEndpoint(activeEndpoint, fromCanvas(point, getMapFrame()));
    return;
  }
  const frame = getMapFrame();
  const endpoint = endpointAt(point, frame);
  if (endpoint) {
    activeDrag = endpoint;
    dragStartPoint = pointForIndex(endpoint === 'A' ? endpointAIndex : endpointBIndex);
    dragControlStart = { ...(endpoint === 'A' ? controlA : controlB) };
  } else {
    activeDrag = handleAt(point, frame);
  }
  if (activeDrag) {
    mapCanvas.classList.add('dragging');
    mapCanvas.setPointerCapture(event.pointerId);
  }
});

mapCanvas.addEventListener('pointermove', (event) => {
  if (!activeDrag || !currentData) return;
  const point = fromCanvas(eventPoint(event), getMapFrame());
  if (activeDrag === 'A' || activeDrag === 'B') {
    const nextIndex = indexForPoint(point);
    if ((activeDrag === 'A' && nextIndex === endpointBIndex)
      || (activeDrag === 'B' && nextIndex === endpointAIndex)) {
      planStatus.textContent = 'A and B must stay on different heightmap indices';
      return;
    }
    if (activeDrag === 'A') endpointAIndex = nextIndex;
    else endpointBIndex = nextIndex;
    const nextAnchor = pointForIndex(nextIndex);
    const start = dragStartPoint!;
    const handleStart = dragControlStart!;
    const dx = nextAnchor.x - start.x;
    const dy = nextAnchor.y - start.y;
    if (activeDrag === 'A') controlA = { x: handleStart.x + dx, y: handleStart.y + dy };
    else controlB = { x: handleStart.x + dx, y: handleStart.y + dy };
    setDirty('Endpoint moved · press Solve again', true);
    return;
  }
  const bounds = currentData.heightmap;
  const xMax = bounds.origin_m[0] + (bounds.width - 1) * bounds.cell_size_m[0];
  const yMax = bounds.origin_m[1] + (bounds.height - 1) * bounds.cell_size_m[1];
  const moved = {
    x: THREE.MathUtils.clamp(point.x, bounds.origin_m[0], xMax),
    y: THREE.MathUtils.clamp(point.y, bounds.origin_m[1], yMax),
  };
  if (activeDrag === 'c1') controlA = moved;
  else controlB = moved;
  setDirty('Curve changed · press Solve again', true);
});

function stopMapDrag(): void {
  activeDrag = null;
  dragStartPoint = null;
  dragControlStart = null;
  mapCanvas.classList.remove('dragging');
}
mapCanvas.addEventListener('pointerup', stopMapDrag);
mapCanvas.addEventListener('pointercancel', stopMapDrag);

endpointAButton.addEventListener('click', () => setEndpointSelection(activeEndpoint === 'A' ? null : 'A'));
endpointBButton.addEventListener('click', () => setEndpointSelection(activeEndpoint === 'B' ? null : 'B'));
document.querySelector<HTMLButtonElement>('#reset-curve')!.addEventListener('click', () => {
  resetHandles();
  setDirty('Curve reset to a straight route', true);
});

function disposeMesh<TGeometry extends THREE.BufferGeometry, TMaterial extends THREE.Material>(
  mesh: THREE.Mesh<TGeometry, TMaterial> | null,
): void {
  if (!mesh) return;
  scene.remove(mesh);
  mesh.geometry.dispose();
  mesh.material.dispose();
}

function createOrbitControls(activeCamera: THREE.PerspectiveCamera | THREE.OrthographicCamera): OrbitControls {
  const orbit = new OrbitControls(activeCamera, renderer.domElement);
  orbit.enableDamping = true;
  orbit.dampingFactor = 0.07;
  orbit.minDistance = 55;
  orbit.maxDistance = 360;
  orbit.minZoom = 0.5;
  orbit.maxZoom = 5;
  orbit.maxPolarAngle = Math.PI;
  return orbit;
}

function setOrthographicHalfHeight(halfHeight: number): void {
  if (!(camera instanceof THREE.OrthographicCamera)) return;
  const aspect = sceneHost.clientWidth / Math.max(sceneHost.clientHeight, 1);
  camera.left = -halfHeight * aspect;
  camera.right = halfHeight * aspect;
  camera.top = halfHeight;
  camera.bottom = -halfHeight;
}

function setProjection(mode: 'perspective' | 'orthographic'): void {
  if (projectionMode === mode) return;
  controls.update();

  const target = controls.target.clone();
  const previousPosition = camera.position.clone();
  const viewOffset = previousPosition.clone().sub(target);
  const viewDistance = viewOffset.length();
  const up = camera.up.clone();
  const near = camera.near;
  const far = camera.far;
  const aspect = sceneHost.clientWidth / Math.max(sceneHost.clientHeight, 1);
  let nextCamera: THREE.PerspectiveCamera | THREE.OrthographicCamera;

  if (mode === 'orthographic') {
    const halfHeight = camera instanceof THREE.PerspectiveCamera
      ? viewDistance * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))
      : (camera.top - camera.bottom) / (2 * camera.zoom);
    nextCamera = new THREE.OrthographicCamera(-halfHeight * aspect, halfHeight * aspect, halfHeight, -halfHeight, near, far);
    nextCamera.position.copy(previousPosition);
  } else {
    const visibleHalfHeight = camera instanceof THREE.OrthographicCamera
      ? (camera.top - camera.bottom) / (2 * camera.zoom)
      : viewDistance * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    const perspectiveDistance = visibleHalfHeight / Math.tan(THREE.MathUtils.degToRad(19));
    nextCamera = new THREE.PerspectiveCamera(38, aspect, near, far);
    nextCamera.position.copy(target).addScaledVector(viewOffset.normalize(), perspectiveDistance);
  }

  nextCamera.up.copy(up);
  nextCamera.lookAt(target);
  controls.dispose();
  camera = nextCamera;
  controls = createOrbitControls(camera);
  controls.target.copy(target);
  if (camera instanceof THREE.PerspectiveCamera) {
    const perspectiveDistance = camera.position.distanceTo(target);
    controls.minDistance = Math.min(55, perspectiveDistance * 0.9);
    controls.maxDistance = Math.max(360, perspectiveDistance * 1.1);
  }
  controls.update();
  projectionMode = mode;
  document.querySelector<HTMLButtonElement>('#perspective-mode')!.setAttribute('aria-pressed', String(mode === 'perspective'));
  document.querySelector<HTMLButtonElement>('#orthographic-mode')!.setAttribute('aria-pressed', String(mode === 'orthographic'));
  resizeRenderer();
}

function clearReferenceAxes(): void {
  for (const child of [...referenceAxes.children]) {
    referenceAxes.remove(child);
    child.traverse((object) => {
      const renderable = object as THREE.Mesh | THREE.Line;
      if ('geometry' in renderable && renderable.geometry) renderable.geometry.dispose();
      if ('material' in renderable && renderable.material) {
        const materials = Array.isArray(renderable.material) ? renderable.material : [renderable.material];
        for (const material of materials) material.dispose();
      }
    });
  }
}

function updateReferenceAxes(data: TerrainFile): void {
  clearReferenceAxes();
  const { cell_size_m: cell, width, height, heights } = data.heightmap;
  const start = new THREE.Vector3(0, 0, 0);
  const xLength = Math.min(30, (width - 1) * cell[0] * 0.34);
  const yLength = Math.min(30, (height - 1) * cell[1] * 0.34);
  const zLength = Math.max(18, Math.min(32, Math.max(...heights) - Math.min(...heights) + 8));

  const configureMaterial = (material: THREE.Material | THREE.Material[], opacity: number): void => {
    const materials = Array.isArray(material) ? material : [material];
    for (const item of materials) {
      item.depthTest = false;
      item.depthWrite = false;
      item.transparent = true;
      item.opacity = opacity;
    }
  };

  const addArrow = (direction: THREE.Vector3, color: string, length: number): void => {
    const arrow = new THREE.ArrowHelper(direction, start, length, color, Math.min(4, length * 0.17), 2.2);
    configureMaterial(arrow.line.material, 0.88);
    configureMaterial(arrow.cone.material, 0.94);
    arrow.renderOrder = 10;
    arrow.line.renderOrder = 10;
    arrow.cone.renderOrder = 10;
    referenceAxes.add(arrow);
  };

  addArrow(new THREE.Vector3(1, 0, 0), '#ee827c', xLength);
  addArrow(new THREE.Vector3(0, 1, 0), '#89c08c', yLength);
  addArrow(new THREE.Vector3(0, 0, 1), '#83b5e3', zLength);

  const originMarker = new THREE.Mesh(
    new THREE.RingGeometry(0.8, 1.4, 32),
    new THREE.MeshBasicMaterial({ color: '#f2e2b7', side: THREE.DoubleSide, depthTest: false, depthWrite: false }),
  );
  originMarker.position.copy(start);
  originMarker.renderOrder = 11;
  referenceAxes.add(originMarker);
}

function buildTerrain(data: TerrainFile, resetCamera: boolean, surface: 'terrain' | 'original' | 'solution' = 'terrain'): void {
  const map = data.heightmap;
  const min = Math.min(...map.heights);
  const max = Math.max(...map.heights);
  const range = max - min || 1;
  const positions = new Float32Array(map.width * map.height * 3);
  const colors = new Float32Array(map.width * map.height * 3);
  const indices: number[] = [];
  const palette = surface === 'solution' ? solutionTerrainColors : terrainColors;

  for (let j = 0; j < map.height; j += 1) {
    for (let i = 0; i < map.width; i += 1) {
      const vertex = j * map.width + i;
      const elevation = map.heights[vertex];
      positions[vertex * 3] = map.origin_m[0] + i * map.cell_size_m[0];
      positions[vertex * 3 + 1] = map.origin_m[1] + j * map.cell_size_m[1];
      positions[vertex * 3 + 2] = elevation;
      const color = colorAt((elevation - min) / range, palette);
      colors[vertex * 3] = color.r;
      colors[vertex * 3 + 1] = color.g;
      colors[vertex * 3 + 2] = color.b;
      if (i < map.width - 1 && j < map.height - 1) {
        const southwest = vertex;
        const southeast = vertex + 1;
        const northwest = vertex + map.width;
        const northeast = northwest + 1;
        indices.push(southwest, southeast, northwest, southeast, northeast, northwest);
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.94, side: THREE.DoubleSide }),
  );
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  disposeMesh(terrainMesh);
  terrainMesh = mesh;
  scene.add(mesh);
  updateReferenceAxes(data);
  sceneTerrainKey = currentTerrainKey;

  document.querySelector('#scene-terrain-name')!.textContent = (terrainTitles[currentTerrainKey] || currentTerrainKey).toUpperCase();
  document.querySelector('#scene-size')!.textContent = ((map.width - 1) * map.cell_size_m[0])
    + ' × ' + ((map.height - 1) * map.cell_size_m[1]) + ' M';

  if (resetCamera) {
    const centerX = map.origin_m[0] + ((map.width - 1) * map.cell_size_m[0]) / 2;
    const centerY = map.origin_m[1] + ((map.height - 1) * map.cell_size_m[1]) / 2;
    const centerZ = (min + max) / 2;
    const distance = Math.max((map.width - 1) * map.cell_size_m[0], (map.height - 1) * map.cell_size_m[1]) * 1.72;
    controls.target.set(centerX, centerY, centerZ);
    controls.minDistance = 55;
    camera.up.set(0, 0, 1);
    camera.position.set(centerX + distance * 0.78, centerY - distance * 0.95, centerZ + distance * 0.86);
    camera.near = Math.max(0.1, distance / 1000);
    camera.far = distance * 12;
    controls.maxDistance = Math.max(360, distance * 1.5);
    if (camera instanceof THREE.OrthographicCamera) {
      setOrthographicHalfHeight(camera.position.distanceTo(controls.target) * Math.tan(THREE.MathUtils.degToRad(19)));
      camera.zoom = 1;
    }
    camera.updateProjectionMatrix();
    controls.update();
  }
}

function resetTopView(data: TerrainFile): void {
  const map = data.heightmap;
  const width = (map.width - 1) * map.cell_size_m[0];
  const height = (map.height - 1) * map.cell_size_m[1];
  const centerX = map.origin_m[0] + width / 2;
  const centerY = map.origin_m[1] + height / 2;
  const centerZ = (Math.min(...map.heights) + Math.max(...map.heights)) / 2;
  const aspect = sceneHost.clientWidth / Math.max(sceneHost.clientHeight, 1);
  const distance = camera instanceof THREE.PerspectiveCamera
    ? 1.15 * Math.max(height, width / aspect) / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)))
    : Math.max(height, width / aspect) * 1.15;

  controls.target.set(centerX, centerY, centerZ);
  // A slight southern offset keeps north at the top while avoiding a singular look direction.
  camera.up.set(0, 0, 1);
  camera.position.set(centerX, centerY - distance * 0.005, centerZ + distance);
  camera.near = Math.max(0.1, distance / 1000);
  camera.far = distance * 12;
  controls.minDistance = 55;
  if (camera instanceof THREE.OrthographicCamera) {
    setOrthographicHalfHeight(Math.max(height, width / aspect) * 0.575);
    camera.zoom = 1;
  }
  camera.updateProjectionMatrix();
  controls.maxDistance = Math.max(360, distance * 1.5);
  if (scene.fog instanceof THREE.Fog) scene.fog.far = Math.max(420, distance * 2.5);
  controls.enableDamping = false;
  controls.update();
  controls.enableDamping = true;
}

function makeTerrainLines(data: TerrainFile, color = '#dfc99d'): THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial> {
  const map = data.heightmap;
  const points: number[] = [];
  const zOffset = 0.06;
  const at = (i: number, j: number): [number, number, number] => [
    map.origin_m[0] + i * map.cell_size_m[0],
    map.origin_m[1] + j * map.cell_size_m[1],
    map.heights[j * map.width + i] + zOffset,
  ];
  const rowIndices = new Set<number>();
  const columnIndices = new Set<number>();
  for (let j = 0; j < map.height; j += 4) rowIndices.add(j);
  for (let i = 0; i < map.width; i += 4) columnIndices.add(i);
  rowIndices.add(map.height - 1);
  columnIndices.add(map.width - 1);

  for (const j of rowIndices) {
    for (let i = 0; i < map.width - 1; i += 1) points.push(...at(i, j), ...at(i + 1, j));
  }
  for (const i of columnIndices) {
    for (let j = 0; j < map.height - 1; j += 1) points.push(...at(i, j), ...at(i, j + 1));
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
  const lines = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({
    color,
    transparent: true,
    opacity: 0.78,
    depthTest: false,
    depthWrite: false,
  }));
  lines.renderOrder = 3;
  return lines;
}

function makeSolutionRoad(curve: number[][], width: number): THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial> {
  const positions = new Float32Array(curve.length * 6);
  const indices: number[] = [];
  for (let index = 0; index < curve.length; index += 1) {
    const previous = curve[Math.max(0, index - 1)];
    const next = curve[Math.min(curve.length - 1, index + 1)];
    let dx = next[0] - previous[0];
    let dy = next[1] - previous[1];
    const length = Math.hypot(dx, dy) || 1;
    dx /= length;
    dy /= length;
    const nx = -dy;
    const ny = dx;
    const halfWidth = width / 2;
    const point = curve[index];
    const offset = index * 6;
    positions[offset] = point[0] + nx * halfWidth;
    positions[offset + 1] = point[1] + ny * halfWidth;
    positions[offset + 2] = point[2] + 0.12;
    positions[offset + 3] = point[0] - nx * halfWidth;
    positions[offset + 4] = point[1] - ny * halfWidth;
    positions[offset + 5] = point[2] + 0.12;
    if (index > 0) {
      const previousLeft = (index - 1) * 2;
      const previousRight = previousLeft + 1;
      const currentLeft = index * 2;
      const currentRight = currentLeft + 1;
      indices.push(previousLeft, currentLeft, currentRight, previousLeft, currentRight, previousRight);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const road = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
    color: '#dedacb',
    side: THREE.DoubleSide,
    depthTest: false,
    depthWrite: false,
  }));
  road.renderOrder = 5;
  return road;
}

function clearSolutionOverlay(): void {
  if (comparisonTerrainLines) {
    scene.remove(comparisonTerrainLines);
    comparisonTerrainLines.geometry.dispose();
    comparisonTerrainLines.material.dispose();
    comparisonTerrainLines = null;
  }
  solutionImported = false;
  solutionOriginalTerrain = null;
  solutionSolvedTerrain = null;
  importedSolutionPlan = null;
  surfaceSelector.hidden = true;
  surfaceSelector.dataset.surface = 'solution';
  solutionSurfaceRadio.checked = true;
  originalSurfaceKey.className = 'original-key';
  solutionSurfaceKey.className = 'terrain-key';
  solutionStats.hidden = true;
  originalTerrainLegend.hidden = true;
  defaultPreviewLegend.hidden = false;
  document.querySelector('#preview-subtitle')!.textContent = 'Select a route and solve its height field';
}

function updateSolutionSurface(): void {
  if (!solutionImported || !solutionOriginalTerrain || !solutionSolvedTerrain) return;
  const showOriginal = originalSurfaceRadio.checked;
  const primary = showOriginal ? solutionOriginalTerrain : solutionSolvedTerrain;
  const comparison = showOriginal ? solutionSolvedTerrain : solutionOriginalTerrain;
  buildTerrain(primary, false, showOriginal ? 'original' : 'solution');
  sceneTerrainKey = solutionOriginalTerrain.terrain.type;
  if (comparisonTerrainLines) {
    scene.remove(comparisonTerrainLines);
    comparisonTerrainLines.geometry.dispose();
    comparisonTerrainLines.material.dispose();
  }
  comparisonTerrainLines = makeTerrainLines(comparison, showOriginal ? '#86c0d1' : '#dfc99d');
  scene.add(comparisonTerrainLines);
  surfaceSelector.dataset.surface = showOriginal ? 'original' : 'solution';
  const terrainKey = solutionOriginalTerrain.terrain.type;
  const terrainName = terrainTitles[terrainKey] || solutionOriginalTerrain.terrain.description || terrainKey;
  document.querySelector('#scene-terrain-name')!.textContent = terrainName.toUpperCase()
    + (showOriginal ? ' · ORIGINAL' : ' · SOLUTION');
  previewState.textContent = roadDirty ? 'SOLUTION STALE' : showOriginal ? 'ORIGINAL' : 'SOLUTION';
  previewState.className = roadDirty
    ? 'preview-state stale'
    : showOriginal ? 'preview-state original' : 'preview-state solution';
  originalSurfaceKey.className = showOriginal ? 'original-terrain-key' : 'original-key';
  solutionSurfaceKey.className = showOriginal ? 'solution-key' : 'solution-terrain-key';
}

originalSurfaceRadio.addEventListener('change', updateSolutionSurface);
solutionSurfaceRadio.addEventListener('change', updateSolutionSurface);

function formatMetric(value: number, digits = 2): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: digits });
}

function setControlsFromCurve(curve: number[][]): void {
  if (curve.length < 3) {
    resetHandles();
    return;
  }
  const a = pointForIndex(endpointAIndex);
  const b = pointForIndex(endpointBIndex);
  const scale = (curve.length - 1) / 3;
  const first = curve[1];
  const last = curve[curve.length - 2];
  controlA = { x: a.x + (first[0] - a.x) * scale, y: a.y + (first[1] - a.y) * scale };
  controlB = { x: b.x + (last[0] - b.x) * scale, y: b.y + (last[1] - b.y) * scale };
}

async function fetchJson<T>(path: string): Promise<T> {
  const response = await fetch(path);
  if (!response.ok) throw new Error('Could not load ' + path + ' (' + response.status + ')');
  return (await response.json()) as T;
}

type SelectedJson = { file: File; value: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRoadDocument(value: unknown): value is RoadDocument {
  if (!isRecord(value) || !Array.isArray(value.curve) || !isRecord(value.terrain)
    || !isRecord(value.constraints) || !isRecord(value.costs)) return false;
  const terrain = value.terrain;
  return isRecord(terrain.terrain) && isRecord(terrain.heightmap);
}

function isCostReport(value: unknown): value is CostReport {
  if (!isRecord(value) || !isRecord(value.volumes_m3)) return false;
  const volumes = value.volumes_m3;
  return typeof value.status === 'string'
    && typeof value.valid === 'boolean'
    && typeof value.length_m === 'number'
    && typeof value.total_cost === 'number'
    && typeof volumes.cut === 'number'
    && typeof volumes.fill === 'number'
    && typeof volumes.import === 'number'
    && typeof volumes.export === 'number';
}

async function parseSelectedJson(files: File[]): Promise<SelectedJson[]> {
  return Promise.all(files.map(async (file) => {
    try {
      return { file, value: JSON.parse(await file.text()) as unknown };
    } catch {
      throw new Error(file.name + ' is not valid JSON.');
    }
  }));
}

function validateTerrain(terrain: TerrainFile, label: string): void {
  const map = terrain.heightmap;
  if (typeof terrain.terrain.type !== 'string'
    || !Number.isInteger(map.width) || map.width < 2
    || !Number.isInteger(map.height) || map.height < 2
    || !Array.isArray(map.origin_m) || map.origin_m.length !== 2
    || !map.origin_m.every(Number.isFinite)
    || !Array.isArray(map.cell_size_m) || map.cell_size_m.length !== 2
    || !map.cell_size_m.every((value) => Number.isFinite(value) && value > 0)
    || !Array.isArray(map.heights) || map.heights.length !== map.width * map.height
    || !map.heights.every(Number.isFinite)) {
    throw new Error(label + ' does not contain a valid terrain heightmap.');
  }
}

function validateSolution(solution: RoadDocument): void {
  if (!solution.curve || solution.curve.length < 2
    || solution.curve.some((point) => !Array.isArray(point) || point.length !== 3
      || point.some((value) => !Number.isFinite(value)))) {
    throw new Error('The solution file does not contain a valid 3D road curve.');
  }
  validateTerrain(solution.terrain, 'The solution file');
  const constraints = solution.constraints;
  const costs = solution.costs;
  if (!Number.isFinite(constraints.w) || constraints.w <= 0
    || !Number.isFinite(constraints.maxs) || constraints.maxs < 0
    || !Number.isFinite(constraints.maxc) || constraints.maxc < 0
    || ![costs.rb, costs.ed, costs.ef, costs.ei, costs.ex].every((value) => Number.isFinite(value) && value >= 0)) {
    throw new Error('The solution file is missing road constraints or cost rates.');
  }
}

function sameHeightmapGrid(left: TerrainFile, right: TerrainFile): boolean {
  const a = left.heightmap;
  const b = right.heightmap;
  return a.width === b.width && a.height === b.height
    && a.origin_m[0] === b.origin_m[0] && a.origin_m[1] === b.origin_m[1]
    && a.cell_size_m[0] === b.cell_size_m[0] && a.cell_size_m[1] === b.cell_size_m[1];
}

async function originalTerrainFor(solution: RoadDocument, input: RoadDocument | undefined): Promise<TerrainFile> {
  if (input) {
    validateTerrain(input.terrain, 'The input file');
    return input.terrain;
  }
  const terrainType = solution.terrain.terrain.type;
  try {
    return await fetchJson<TerrainFile>('/terrains/' + encodeURIComponent(terrainType) + '.json');
  } catch {
    if (currentData?.terrain.type === terrainType) return currentData;
    throw new Error('Could not find the original terrain for ' + terrainType + '. Select its input JSON too.');
  }
}

function displaySolution(
  solution: RoadDocument,
  oldTerrain: TerrainFile,
  report: CostReport | undefined,
  message: string,
  keepEditing: boolean,
): void {
  validateSolution(solution);
  validateTerrain(oldTerrain, 'The original terrain');
  if (oldTerrain.terrain.type !== solution.terrain.terrain.type
    || !sameHeightmapGrid(oldTerrain, solution.terrain)) {
    throw new Error('The original and solved terrain heightmaps must use the same grid.');
  }

  loadSequence += 1;
  terrainLoading = false;
  solveButton.disabled = solving;
  solve2dButton.disabled = solving;
  if (!keepEditing) editVersion += 1;
  clearSolutionOverlay();
  disposeMesh(roadMesh);
  roadMesh = null;
  currentData = oldTerrain;
  const terrainKey = oldTerrain.terrain.type;
  currentTerrainKey = terrainKey;
  terrainSelect.value = terrainTitles[terrainKey] ? terrainKey : '';
  endpointAIndex = oldTerrain.A ?? solution.terrain.A ?? indexForPoint({ x: solution.curve[0][0], y: solution.curve[0][1] });
  endpointBIndex = oldTerrain.B ?? solution.terrain.B ?? indexForPoint({
    x: solution.curve[solution.curve.length - 1][0],
    y: solution.curve[solution.curve.length - 1][1],
  });
  document.querySelector('#terrain-description')!.textContent = oldTerrain.terrain.description;
  widthInput.value = String(solution.constraints.w);
  document.querySelector<HTMLInputElement>('#max-grade')!.value = String(solution.constraints.maxs);
  document.querySelector<HTMLInputElement>('#max-curvature')!.value = String(solution.constraints.maxc);
  document.querySelector<HTMLInputElement>('#cost-rb')!.value = String(solution.costs.rb);
  document.querySelector<HTMLInputElement>('#cost-ed')!.value = String(solution.costs.ed);
  document.querySelector<HTMLInputElement>('#cost-ef')!.value = String(solution.costs.ef);
  document.querySelector<HTMLInputElement>('#cost-ei')!.value = String(solution.costs.ei);
  document.querySelector<HTMLInputElement>('#cost-ex')!.value = String(solution.costs.ex);
  if (!keepEditing) {
    importedSolutionPlan = solution.curve.map((point) => ({ x: point[0], y: point[1] }));
    setControlsFromCurve(solution.curve);
  }
  drawMap();
  mapInstruction.textContent = keepEditing
    ? 'Drag A / B to move endpoints, or P1 / P2 to shape the curve.'
    : 'Solution route shown · reset curve to edit Bézier handles.';

  solutionOriginalTerrain = oldTerrain;
  solutionSolvedTerrain = solution.terrain;
  originalSurfaceRadio.checked = false;
  solutionSurfaceRadio.checked = true;
  surfaceSelector.hidden = false;
  surfaceSelector.dataset.surface = 'solution';
  buildTerrain(solution.terrain, false, 'solution');
  comparisonTerrainLines = makeTerrainLines(oldTerrain);
  scene.add(comparisonTerrainLines);
  roadMesh = makeSolutionRoad(solution.curve, solution.constraints.w);
  scene.add(roadMesh);
  solutionImported = true;
  hasRoadPreview = true;
  roadDirty = false;

  originalTerrainLegend.hidden = false;
  defaultPreviewLegend.hidden = true;
  document.querySelector('#preview-subtitle')!.textContent = 'Choose a surface · comparison shown as wireframe';
  const terrainName = terrainTitles[terrainKey] || oldTerrain.terrain.description || terrainKey;
  document.querySelector('#scene-terrain-name')!.textContent = terrainName.toUpperCase() + ' · SOLUTION';
  previewState.textContent = 'SOLUTION';
  previewState.className = 'preview-state solution';
  originalSurfaceKey.className = 'original-key';
  solutionSurfaceKey.className = 'solution-terrain-key';
  planStatus.textContent = message + ' · ' + solution.curve.length + ' vertices';
  solutionStats.hidden = true;
  if (report) {
    const volumes = report.volumes_m3;
    document.querySelector('#solution-cost')!.textContent = formatMetric(report.total_cost);
    document.querySelector('#solution-length')!.textContent = formatMetric(report.length_m) + ' m';
    document.querySelector('#solution-cut-fill')!.textContent = formatMetric(volumes.cut, 1) + ' / ' + formatMetric(volumes.fill, 1);
    document.querySelector('#solution-import-export')!.textContent = formatMetric(volumes.import, 1) + ' / ' + formatMetric(volumes.export, 1);
    solutionStats.hidden = false;
  }
  sceneLoading.hidden = true;
  sceneError.hidden = true;
}

async function importSolution(files: File[]): Promise<void> {
  const sequence = loadSequence;
  importSolutionButton.disabled = true;
  importSolutionButton.textContent = 'Loading…';
  sceneError.hidden = true;
  try {
    const selected = await parseSelectedJson(files);
    if (sequence !== loadSequence) return;
    const roadDocuments = selected.filter((entry): entry is SelectedJson & { value: RoadDocument } => isRoadDocument(entry.value));
    const solutionEntry = roadDocuments.find((entry) => /solution/i.test(entry.file.name))
      ?? roadDocuments.find((entry) => !/input|original/i.test(entry.file.name));
    if (!solutionEntry) throw new Error('Select a road solution JSON file.');
    const inputEntry = roadDocuments.find((entry) => entry !== solutionEntry && /input|original/i.test(entry.file.name))
      ?? (roadDocuments.length > 1 ? roadDocuments.find((entry) => entry !== solutionEntry) : undefined);
    const reportEntry = selected.find((entry) => isCostReport(entry.value));
    const reportFile = selected.find((entry) => /report/i.test(entry.file.name));
    if (reportFile && !isCostReport(reportFile.value)) throw new Error(reportFile.file.name + ' is not a valid cost report.');
    const solution = solutionEntry.value;
    const report = reportEntry && isCostReport(reportEntry.value) ? reportEntry.value : undefined;
    const input = inputEntry?.value;
    validateSolution(solution);
    if (report && (!['optimal', 'best_found'].includes(report.status) || !report.valid
      || !Number.isFinite(report.total_cost) || !Number.isFinite(report.length_m))) {
      throw new Error('The cost report does not describe a valid solution.');
    }

    const oldTerrain = await originalTerrainFor(solution, input);
    if (sequence !== loadSequence) return;
    displaySolution(solution, oldTerrain, report, 'Imported ' + solutionEntry.file.name, false);
  } catch (error) {
    console.error(error);
    planStatus.textContent = error instanceof Error ? error.message : 'Could not import solution';
  } finally {
    importSolutionButton.disabled = false;
    importSolutionButton.innerHTML = 'Import solution <span>↙</span>';
    solutionFilesInput.value = '';
  }
}

importSolutionButton.addEventListener('click', () => solutionFilesInput.click());
solutionFilesInput.addEventListener('change', () => {
  const files = Array.from(solutionFilesInput.files || []);
  if (files.length) void importSolution(files);
});

function requiredNumber(id: string, label: string, minimum: number): number {
  const input = document.querySelector<HTMLInputElement>('#' + id)!;
  const value = input.valueAsNumber;
  if (!Number.isFinite(value) || value < minimum) {
    throw new Error(label + ' must be ' + (minimum === 0 ? 'nonnegative' : 'greater than zero'));
  }
  return value;
}

function buildExportDocument(): RoadDocument {
  if (!currentData || terrainLoading) throw new Error('Terrain is still loading');
  if (endpointAIndex === endpointBIndex) throw new Error('A and B must be different heightmap indices');
  const spacing = sampleSpacingInput.valueAsNumber;
  if (!Number.isFinite(spacing) || spacing < 1 || spacing > 20) {
    throw new Error('Curve sample spacing must be between 1 and 20 m');
  }
  if (!importedSolutionPlan && desiredBezierSegments(spacing) > MAX_CURVE_SEGMENTS) {
    throw new Error('This spacing needs more than 200 road segments; increase the spacing');
  }
  const costs = {
    rb: requiredNumber('cost-rb', 'Build cost', 0),
    ed: requiredNumber('cost-ed', 'Excavate cost', 0),
    ef: requiredNumber('cost-ef', 'Place fill cost', 0),
    ei: requiredNumber('cost-ei', 'Import cost', 0),
    ex: requiredNumber('cost-ex', 'Export cost', 0),
  };
  if (Object.values(costs).every((value) => value === 0)) throw new Error('At least one cost rate must be positive');

  const map = currentData.heightmap;
  const route = importedSolutionPlan || sampleBezier();
  const curve = route.map((point) => [
    point.x,
    point.y,
    groundAt(point.x, point.y),
  ]);
  curve[0] = [pointForIndex(endpointAIndex).x, pointForIndex(endpointAIndex).y, map.heights[endpointAIndex]];
  curve[curve.length - 1] = [pointForIndex(endpointBIndex).x, pointForIndex(endpointBIndex).y, map.heights[endpointBIndex]];

  return {
    curve,
    terrain: {
      terrain: currentData.terrain,
      heightmap: currentData.heightmap,
      A: endpointAIndex,
      B: endpointBIndex,
    },
    constraints: {
      w: requiredNumber('width', 'Road width', Number.MIN_VALUE),
      maxs: requiredNumber('max-grade', 'Maximum grade', 0),
      maxc: requiredNumber('max-curvature', 'Maximum curvature', 0),
    },
    costs,
    problem2: { control_indices: moveControlIndices(curve.length) },
  };
}

function solveFailureMessage(result: SolveResponse): string {
  const checks = result.checks;
  if (isRecord(checks)) {
    const path = checks.path_geometry;
    if (isRecord(path) && Array.isArray(path.errors) && typeof path.errors[0] === 'string') {
      return path.errors[0];
    }
    const strip = checks.road_strip;
    if (isRecord(strip)) {
      for (const key of ['folding', 'heightmap_coverage']) {
        const check = strip[key];
        if (isRecord(check) && typeof check.error === 'string') return check.error;
      }
      if (Array.isArray(strip.errors) && typeof strip.errors[0] === 'string') return strip.errors[0];
      const overlap = strip.overlap;
      if (isRecord(overlap) && Array.isArray(overlap.segment_pairs) && overlap.segment_pairs.length) {
        return 'The road footprint overlaps itself';
      }
    }
    const curvature = checks.curvature;
    if (isRecord(curvature) && Array.isArray(curvature.violations) && curvature.violations.length) {
      return 'The route exceeds the maximum curvature';
    }
  }
  return result.error || 'Solver returned ' + result.status;
}

async function solveRoad(displacement: boolean): Promise<void> {
  if (solving) return;
  let road: RoadDocument;
  try {
    road = buildExportDocument();
  } catch (error) {
    planStatus.textContent = error instanceof Error ? error.message : 'Could not prepare the route';
    return;
  }

  const version = editVersion;
  if (displacement && road.curve.length < 3) {
    planStatus.textContent = '2D solve needs at least one interior road vertex';
    return;
  }
  solving = true;
  solveButton.disabled = true;
  solve2dButton.disabled = true;
  const activeButton = displacement ? solve2dButton : solveButton;
  activeButton.textContent = 'Solving…';
  sceneError.hidden = true;
  sceneLoading.innerHTML = '<span class="spinner"></span> '
    + (displacement ? 'Searching road positions and elevations' : 'Solving road elevations');
  sceneLoading.hidden = false;
  previewState.textContent = 'SOLVING';
  previewState.className = 'preview-state';
  planStatus.textContent = displacement
    ? 'Searching ' + road.problem2!.control_indices.length + ' independent move points across '
      + road.curve.length + ' road vertices…'
    : 'Optimizing ' + road.curve.length + ' road vertices…';

  try {
    const response = await fetch(displacement ? '/api/solve-2d' : '/api/solve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ document: road }),
    });
    const result = (await response.json()) as SolveResponse;
    if (!response.ok) throw new Error(result.error || 'Solver request failed (' + response.status + ')');
    if (version !== editVersion) {
      planStatus.textContent = 'Inputs changed while solving · press Solve again';
      previewState.textContent = hasRoadPreview ? 'SOLUTION STALE' : 'TERRAIN';
      previewState.className = hasRoadPreview ? 'preview-state stale' : 'preview-state';
      return;
    }
    if (result.status !== (displacement ? 'best_found' : 'optimal')) {
      throw new Error(solveFailureMessage(result));
    }
    if (!isRoadDocument(result.solution) || !isCostReport(result.report)) {
      throw new Error('Solver returned an incomplete solution');
    }
    displaySolution(
      result.solution,
      road.terrain,
      result.report,
      displacement ? 'Solved 2D displacement and height field' : 'Solved height field',
      !displacement,
    );
    if (displacement) resetTopView(result.solution.terrain);
  } catch (error) {
    if (version === editVersion) {
      const message = error instanceof Error ? error.message : 'Could not solve route';
      planStatus.textContent = message;
      sceneError.textContent = message;
      sceneError.hidden = false;
      previewState.textContent = 'SOLVE FAILED';
      previewState.className = 'preview-state stale';
    }
  } finally {
    solving = false;
    solveButton.disabled = terrainLoading;
    solve2dButton.disabled = terrainLoading;
    solveButton.innerHTML = 'Solve <span>↗</span>';
    solve2dButton.innerHTML = 'Solve with 2D displacement <span>↗</span>';
    if (!terrainLoading) sceneLoading.hidden = true;
  }
}

solveButton.addEventListener('click', () => { void solveRoad(false); });
solve2dButton.addEventListener('click', () => { void solveRoad(true); });

function exportJson(): void {
  try {
    const document = buildExportDocument();
    const blob = new Blob([JSON.stringify(document, null, 2) + '\n'], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = documentCreateLink();
    link.href = url;
    link.download = 'road-input.json';
    link.click();
    URL.revokeObjectURL(url);
    planStatus.textContent = 'Road JSON downloaded';
  } catch (error) {
    planStatus.textContent = error instanceof Error ? error.message : 'Could not export route';
  }
}

function documentCreateLink(): HTMLAnchorElement {
  return window.document.createElement('a');
}
document.querySelector<HTMLButtonElement>('#export-json')!.addEventListener('click', exportJson);

async function loadTerrain(key: string): Promise<void> {
  const sequence = ++loadSequence;
  editVersion += 1;
  terrainLoading = true;
  solveButton.disabled = true;
  solve2dButton.disabled = true;
  currentTerrainKey = key;
  sceneError.hidden = true;
  sceneLoading.innerHTML = '<span class="spinner"></span> Loading terrain model';
  sceneLoading.hidden = false;
  try {
    const response = await fetch('/terrains/' + key + '.json');
    if (!response.ok) throw new Error('Could not load terrain: ' + response.status);
    const data = (await response.json()) as TerrainFile;
    if (sequence !== loadSequence) return;
    const map = data.heightmap;
    if (!map || map.heights.length !== map.width * map.height) throw new Error('Heightmap dimensions do not match its samples');
    clearSolutionOverlay();
    disposeMesh(roadMesh);
    roadMesh = null;
    currentData = data;
    mapInstruction.textContent = 'Drag A / B to move endpoints, or P1 / P2 to shape the curve.';
    document.querySelector('#terrain-description')!.textContent = data.terrain.description;
    if (endpointAIndex >= map.width * map.height || endpointBIndex >= map.width * map.height) {
      endpointAIndex = Math.round((map.height - 1) * 0.2) * map.width
        + Math.round((map.width - 1) * 0.2);
      endpointBIndex = Math.round((map.height - 1) * 0.8) * map.width
        + Math.round((map.width - 1) * 0.8);
    }
    resetHandles();
    drawMap();
    buildTerrain(data, true);
    hasRoadPreview = false;
    roadDirty = true;
    previewState.textContent = 'TERRAIN';
    previewState.className = 'preview-state';
    planStatus.textContent = 'Route ready · press Solve';
    sceneLoading.hidden = true;
  } catch (error) {
    if (sequence !== loadSequence) return;
    console.error(error);
    sceneLoading.hidden = true;
    sceneError.textContent = error instanceof Error ? error.message : 'Terrain could not be loaded.';
    sceneError.hidden = false;
  } finally {
    if (sequence === loadSequence) {
      terrainLoading = false;
      solveButton.disabled = solving;
      solve2dButton.disabled = solving;
    }
  }
}

terrainSelect.addEventListener('change', () => {
  void loadTerrain(terrainSelect.value);
});
widthInput.addEventListener('input', () => {
  setDirty('Road width changed · press Solve again');
});
sampleSpacingInput.addEventListener('input', () => {
  setDirty('Curve sampling changed · press Solve again', true);
});
movablePointsSelect.addEventListener('change', () => {
  setDirty('2D move points changed · press Solve again');
});
document.querySelector<HTMLButtonElement>('#route-detail-help')!.addEventListener('click', () => {
  routeDetailDialog.showModal();
});
document.querySelector<HTMLButtonElement>('#close-route-detail-help')!.addEventListener('click', () => {
  routeDetailDialog.close();
});
for (const id of ['max-grade', 'max-curvature', 'cost-rb', 'cost-ed', 'cost-ef', 'cost-ei', 'cost-ex']) {
  document.querySelector<HTMLInputElement>('#' + id)!.addEventListener('input', () => {
    setDirty('Inputs changed · press Solve again');
  });
}

function resizeRenderer(): void {
  const width = sceneHost.clientWidth;
  const height = sceneHost.clientHeight;
  if (width < 1 || height < 1) return;
  renderer.setSize(width, height, false);
  const aspect = width / height;
  if (camera instanceof THREE.PerspectiveCamera) {
    camera.aspect = aspect;
  } else {
    const halfHeight = (camera.top - camera.bottom) / 2;
    camera.left = -halfHeight * aspect;
    camera.right = halfHeight * aspect;
  }
  camera.updateProjectionMatrix();
}

document.querySelector<HTMLButtonElement>('#perspective-mode')!.addEventListener('click', () => setProjection('perspective'));
document.querySelector<HTMLButtonElement>('#orthographic-mode')!.addEventListener('click', () => setProjection('orthographic'));

new ResizeObserver(() => {
  resizeRenderer();
  drawMap();
}).observe(sceneHost);
new ResizeObserver(drawMap).observe(mapCanvas);

window.addEventListener('resize', () => {
  resizeRenderer();
  drawMap();
});

resizeRenderer();
void loadTerrain(terrainSelect.value);
renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});
