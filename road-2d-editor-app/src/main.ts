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
type MapFrame = { left: number; top: number; scale: number; width: number; height: number };
type HandleName = 'c1' | 'c2';
type DragTarget = HandleName | 'A' | 'B';
type EndpointMode = 'A' | 'B' | null;

const terrainTitles: Record<string, string> = {
  flat: 'Flat field',
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
const updatePreviewButton = document.querySelector<HTMLButtonElement>('#update-preview')!;
const endpointAButton = document.querySelector<HTMLButtonElement>('#set-a')!;
const endpointBButton = document.querySelector<HTMLButtonElement>('#set-b')!;
const widthInput = document.querySelector<HTMLInputElement>('#width')!;
const previewState = document.querySelector<HTMLSpanElement>('#preview-state')!;

const scene = new THREE.Scene();
scene.background = new THREE.Color('#182421');
scene.fog = new THREE.Fog('#182421', 180, 420);

const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 1200);
camera.up.set(0, 0, 1);

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.12;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
sceneHost.prepend(renderer.domElement);
renderer.domElement.setAttribute('aria-label', 'Three dimensional terrain and flat road preview. Drag to rotate and scroll to zoom.');

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.07;
controls.minDistance = 55;
controls.maxDistance = 360;
controls.maxPolarAngle = Math.PI;
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
let endpointAIndex = 303;
let endpointBIndex = 9696;
let controlA: Point2 = { x: 34, y: 34 };
let controlB: Point2 = { x: 65, y: 65 };
let loadSequence = 0;

function colorAt(normalizedHeight: number): THREE.Color {
  const value = THREE.MathUtils.clamp(normalizedHeight, 0, 1);
  for (let index = 1; index < terrainColors.length; index += 1) {
    const upper = terrainColors[index];
    if (value <= upper.at) {
      const lower = terrainColors[index - 1];
      const local = (value - lower.at) / (upper.at - lower.at);
      return lower.color.clone().lerp(upper.color, local);
    }
  }
  return terrainColors[terrainColors.length - 1].color.clone();
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

function sampleBezier(): Point2[] {
  const a = pointForIndex(endpointAIndex);
  const b = pointForIndex(endpointBIndex);
  const controlLength = Math.hypot(controlA.x - a.x, controlA.y - a.y)
    + Math.hypot(controlB.x - controlA.x, controlB.y - controlA.y)
    + Math.hypot(b.x - controlB.x, b.y - controlB.y);
  const count = THREE.MathUtils.clamp(Math.ceil(controlLength / 3), 32, 160);
  return Array.from({ length: count + 1 }, (_, index) => bezierAt(index / count));
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

  const curve = sampleBezier().map((point) => toCanvas(point, frame));
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

  drawHandle(firstHandle, 'P1');
  drawHandle(secondHandle, 'P2');
  drawEndpoint(start, 'A', '#577a57');
  drawEndpoint(end, 'B', '#c47d59');
  updateEndpointLabels();
  document.querySelector('#vertex-count')!.textContent = String(curve.length);
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

function setDirty(message?: string): void {
  roadDirty = true;
  if (hasRoadPreview) {
    previewState.textContent = 'PREVIEW STALE';
    previewState.className = 'preview-state stale';
  }
  planStatus.textContent = message || (hasRoadPreview ? 'Plan changed · update preview' : 'Route ready · update preview to add road');
  drawMap();
}

function setEndpointSelection(mode: EndpointMode): void {
  activeEndpoint = mode;
  endpointAButton.setAttribute('aria-pressed', String(mode === 'A'));
  endpointBButton.setAttribute('aria-pressed', String(mode === 'B'));
  mapCanvas.classList.toggle('pick-mode', mode !== null);
  mapInstruction.textContent = mode
    ? 'Click a heightmap grid point to set endpoint ' + mode + '.'
    : 'Drag A / B to move endpoints, or P1 / P2 to shape the curve.';
}

function eventPoint(event: PointerEvent): Point2 {
  const rect = mapCanvas.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function handleAt(point: Point2, frame: MapFrame): HandleName | null {
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
  setDirty('Endpoint updated · adjust curve or refresh preview');
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
    setDirty('Endpoint moved · update preview');
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
  setDirty('Curve changed · update preview');
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
  setDirty('Curve reset to a straight route');
});

function disposeMesh<TGeometry extends THREE.BufferGeometry, TMaterial extends THREE.Material>(
  mesh: THREE.Mesh<TGeometry, TMaterial> | null,
): void {
  if (!mesh) return;
  scene.remove(mesh);
  mesh.geometry.dispose();
  mesh.material.dispose();
}

function buildTerrain(data: TerrainFile, resetCamera: boolean): void {
  const map = data.heightmap;
  const min = Math.min(...map.heights);
  const max = Math.max(...map.heights);
  const range = max - min || 1;
  const positions = new Float32Array(map.width * map.height * 3);
  const colors = new Float32Array(map.width * map.height * 3);
  const indices: number[] = [];

  for (let j = 0; j < map.height; j += 1) {
    for (let i = 0; i < map.width; i += 1) {
      const vertex = j * map.width + i;
      const elevation = map.heights[vertex];
      positions[vertex * 3] = map.origin_m[0] + i * map.cell_size_m[0];
      positions[vertex * 3 + 1] = map.origin_m[1] + j * map.cell_size_m[1];
      positions[vertex * 3 + 2] = elevation;
      const color = colorAt((elevation - min) / range);
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
  sceneTerrainKey = currentTerrainKey;

  document.querySelector('#scene-terrain-name')!.textContent = terrainTitles[currentTerrainKey].toUpperCase();
  document.querySelector('#scene-size')!.textContent = ((map.width - 1) * map.cell_size_m[0])
    + ' × ' + ((map.height - 1) * map.cell_size_m[1]) + ' M';

  if (resetCamera) {
    const centerX = map.origin_m[0] + ((map.width - 1) * map.cell_size_m[0]) / 2;
    const centerY = map.origin_m[1] + ((map.height - 1) * map.cell_size_m[1]) / 2;
    const centerZ = (min + max) / 2;
    const distance = Math.max((map.width - 1) * map.cell_size_m[0], (map.height - 1) * map.cell_size_m[1]) * 1.72;
    controls.target.set(centerX, centerY, centerZ);
    camera.position.set(centerX + distance * 0.78, centerY - distance * 0.95, centerZ + distance * 0.86);
    camera.near = Math.max(0.1, distance / 1000);
    camera.far = distance * 12;
    camera.updateProjectionMatrix();
    controls.update();
  }
}

function makeRoadMesh(points: Point2[], width: number, flatZ: number): THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial> {
  const positions = new Float32Array(points.length * 6);
  const indices: number[] = [];
  for (let index = 0; index < points.length; index += 1) {
    const previous = points[Math.max(0, index - 1)];
    const next = points[Math.min(points.length - 1, index + 1)];
    let dx = next.x - previous.x;
    let dy = next.y - previous.y;
    const length = Math.hypot(dx, dy) || 1;
    dx /= length;
    dy /= length;
    const nx = -dy;
    const ny = dx;
    const offset = width / 2;
    const leftX = points[index].x + nx * offset;
    const leftY = points[index].y + ny * offset;
    const rightX = points[index].x - nx * offset;
    const rightY = points[index].y - ny * offset;
    const vertex = index * 6;
    positions[vertex] = leftX;
    positions[vertex + 1] = leftY;
    positions[vertex + 2] = flatZ;
    positions[vertex + 3] = rightX;
    positions[vertex + 4] = rightY;
    positions[vertex + 5] = flatZ;
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
  const material = new THREE.MeshBasicMaterial({
    color: '#d9d8c9',
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.94,
    depthTest: false,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.renderOrder = 5;
  return mesh;
}

function update3DPreview(): void {
  if (!currentData) return;
  const width = widthInput.valueAsNumber;
  if (!Number.isFinite(width) || width <= 0) {
    planStatus.textContent = 'Road width must be greater than zero';
    widthInput.focus();
    return;
  }
  if (endpointAIndex === endpointBIndex) {
    planStatus.textContent = 'A and B must be different heightmap indices';
    return;
  }
  const resetCamera = sceneTerrainKey !== currentTerrainKey;
  if (resetCamera || !terrainMesh) buildTerrain(currentData, resetCamera || !terrainMesh);
  disposeMesh(roadMesh);
  const elevations = currentData.heightmap.heights;
  const min = Math.min(...elevations);
  const route = sampleBezier();
  roadMesh = makeRoadMesh(route, width, min + 0.18);
  scene.add(roadMesh);
  hasRoadPreview = true;
  roadDirty = false;
  previewState.textContent = 'ROAD READY';
  previewState.className = 'preview-state ready';
  planStatus.textContent = 'Preview refreshed · ' + route.length + ' path vertices';
  sceneLoading.hidden = true;
}

updatePreviewButton.addEventListener('click', update3DPreview);

function requiredNumber(id: string, label: string, minimum: number): number {
  const input = document.querySelector<HTMLInputElement>('#' + id)!;
  const value = input.valueAsNumber;
  if (!Number.isFinite(value) || value < minimum) {
    throw new Error(label + ' must be ' + (minimum === 0 ? 'nonnegative' : 'greater than zero'));
  }
  return value;
}

function buildExportDocument(): object {
  if (!currentData) throw new Error('Terrain is still loading');
  if (endpointAIndex === endpointBIndex) throw new Error('A and B must be different heightmap indices');
  const costs = {
    rb: requiredNumber('cost-rb', 'Build cost', 0),
    ed: requiredNumber('cost-ed', 'Excavate cost', 0),
    ef: requiredNumber('cost-ef', 'Place fill cost', 0),
    ei: requiredNumber('cost-ei', 'Import cost', 0),
    ex: requiredNumber('cost-ex', 'Export cost', 0),
  };
  if (Object.values(costs).every((value) => value === 0)) throw new Error('At least one cost rate must be positive');

  const map = currentData.heightmap;
  const curve = sampleBezier().map((point) => [
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
  };
}

function exportJson(): void {
  try {
    const document = buildExportDocument();
    const blob = new Blob([JSON.stringify(document, null, 2) + '\n'], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = documentCreateLink();
    link.href = url;
    link.download = 'problem1-road-input.json';
    link.click();
    URL.revokeObjectURL(url);
    planStatus.textContent = 'Problem 1 JSON downloaded';
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
  currentTerrainKey = key;
  sceneError.hidden = true;
  sceneLoading.hidden = false;
  try {
    const response = await fetch('/' + key + '.json');
    if (!response.ok) throw new Error('Could not load terrain: ' + response.status);
    const data = (await response.json()) as TerrainFile;
    if (sequence !== loadSequence) return;
    const map = data.heightmap;
    if (!map || map.heights.length !== map.width * map.height) throw new Error('Heightmap dimensions do not match its samples');
    currentData = data;
    document.querySelector('#terrain-description')!.textContent = data.terrain.description;
    if (endpointAIndex >= map.width * map.height || endpointBIndex >= map.width * map.height) {
      endpointAIndex = Math.min(map.width * 3 + 3, map.width * map.height - 2);
      endpointBIndex = Math.max((map.height - 4) * map.width + map.width - 4, 1);
    }
    resetHandles();
    drawMap();
    updateEndpointLabels();
    if (!terrainMesh) buildTerrain(data, true);
    roadDirty = true;
    if (hasRoadPreview || sceneTerrainKey !== currentTerrainKey) {
      previewState.textContent = 'PREVIEW STALE';
      previewState.className = 'preview-state stale';
      planStatus.textContent = hasRoadPreview
        ? 'Terrain changed · update preview'
        : 'Terrain changed · preview it from pane 02';
    } else {
      previewState.textContent = 'TERRAIN';
      previewState.className = 'preview-state';
      planStatus.textContent = 'Route ready · update preview to add road';
    }
    sceneLoading.hidden = true;
  } catch (error) {
    if (sequence !== loadSequence) return;
    console.error(error);
    sceneLoading.hidden = true;
    sceneError.hidden = false;
  }
}

terrainSelect.addEventListener('change', () => {
  void loadTerrain(terrainSelect.value);
});
widthInput.addEventListener('input', () => {
  drawMap();
  if (hasRoadPreview) setDirty('Road width changed · update preview');
});
for (const id of ['max-grade', 'max-curvature', 'cost-rb', 'cost-ed', 'cost-ef', 'cost-ei', 'cost-ex']) {
  document.querySelector<HTMLInputElement>('#' + id)!.addEventListener('input', () => {
    if (!hasRoadPreview || !roadDirty) planStatus.textContent = 'Input values ready to export';
  });
}

function resizeRenderer(): void {
  const width = sceneHost.clientWidth;
  const height = sceneHost.clientHeight;
  if (width < 1 || height < 1) return;
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}

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
