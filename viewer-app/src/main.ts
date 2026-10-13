import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import './style.css';

type TerrainFile = {
  terrain: { type: string; description: string };
  heightmap: {
    width: number;
    height: number;
    origin_m: [number, number];
    cell_size_m: [number, number];
    units: string;
    heights: number[];
  };
};

const terrainNames: Record<string, string> = {
  flat: 'Flat field',
  centered_hill: 'Central hill',
  diagonal_ridge: 'Diagonal ridge',
  random_hills: 'Rolling hills',
};

const viewport = document.querySelector<HTMLDivElement>('#viewport')!;
const terrainSelect = document.querySelector<HTMLSelectElement>('#terrain-select')!;
const loadingState = document.querySelector<HTMLDivElement>('#loading-state')!;
const errorState = document.querySelector<HTMLDivElement>('#error-state')!;
const exaggerationInput = document.querySelector<HTMLInputElement>('#exaggeration')!;
const gridToggle = document.querySelector<HTMLInputElement>('#grid-toggle')!;
const orientationGizmo = document.querySelector<SVGSVGElement>('#orientation-gizmo')!;

const scene = new THREE.Scene();
scene.background = new THREE.Color('#182421');
scene.fog = new THREE.Fog('#182421', 210, 430);

let camera: THREE.PerspectiveCamera | THREE.OrthographicCamera = new THREE.PerspectiveCamera(38, 1, 0.1, 1000);
camera.up.set(0, 0, 1);
let projectionMode: 'perspective' | 'orthographic' = 'perspective';

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.18;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
viewport.prepend(renderer.domElement);
renderer.domElement.setAttribute('aria-label', 'Three dimensional terrain model. Drag to rotate and scroll to zoom.');

let controls = createOrbitControls(camera);
controls.target.set(49.5, 49.5, 0);

scene.add(new THREE.HemisphereLight('#eff1d7', '#30433b', 2.25));
const keyLight = new THREE.DirectionalLight('#fff0d4', 3.15);
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

const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(800, 800),
  new THREE.MeshStandardMaterial({ color: '#263630', roughness: 1 }),
);
ground.position.set(49.5, 49.5, -0.16);
ground.receiveShadow = true;
scene.add(ground);
const referenceAxes = new THREE.Group();
scene.add(referenceAxes);

let terrainMesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial> | null = null;
let gridLines: THREE.LineSegments | null = null;
let currentData: TerrainFile | null = null;
let currentTerrainKey = 'flat';
let loadSequence = 0;

const heightColorStops = [
  { at: 0, color: new THREE.Color('#537b69') },
  { at: 0.16, color: new THREE.Color('#77936a') },
  { at: 0.42, color: new THREE.Color('#a2a276') },
  { at: 0.68, color: new THREE.Color('#b98d69') },
  { at: 0.88, color: new THREE.Color('#d1b58b') },
  { at: 1, color: new THREE.Color('#eee0bd') },
];

function colorAt(normalizedHeight: number): THREE.Color {
  const t = THREE.MathUtils.clamp(normalizedHeight, 0, 1);
  for (let i = 1; i < heightColorStops.length; i += 1) {
    const upper = heightColorStops[i];
    if (t <= upper.at) {
      const lower = heightColorStops[i - 1];
      const localT = (t - lower.at) / (upper.at - lower.at);
      return lower.color.clone().lerp(upper.color, localT);
    }
  }
  return heightColorStops[heightColorStops.length - 1].color.clone();
}

function buildTerrain(data: TerrainFile, resetCamera = true): void {
  const { width, height, origin_m: origin, cell_size_m: cell, heights } = data.heightmap;
  const min = Math.min(...heights);
  const max = Math.max(...heights);
  const range = max - min || 1;
  const exaggeration = Number(exaggerationInput.value);
  const vertices = width * height;
  const positions = new Float32Array(vertices * 3);
  const colors = new Float32Array(vertices * 3);
  const indices: number[] = [];

  for (let j = 0; j < height; j += 1) {
    for (let i = 0; i < width; i += 1) {
      const vertex = j * width + i;
      const elevation = heights[vertex];
      positions[vertex * 3] = origin[0] + i * cell[0];
      positions[vertex * 3 + 1] = origin[1] + j * cell[1];
      positions[vertex * 3 + 2] = elevation * exaggeration;
      const color = colorAt((elevation - min) / range);
      colors[vertex * 3] = color.r;
      colors[vertex * 3 + 1] = color.g;
      colors[vertex * 3 + 2] = color.b;

      if (i < width - 1 && j < height - 1) {
        const southWest = vertex;
        const southEast = vertex + 1;
        const northWest = vertex + width;
        const northEast = northWest + 1;
        indices.push(southWest, southEast, northWest, southEast, northEast, northWest);
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
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0, side: THREE.DoubleSide }),
  );
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  if (terrainMesh) {
    scene.remove(terrainMesh);
    terrainMesh.geometry.dispose();
    terrainMesh.material.dispose();
  }
  terrainMesh = mesh;
  scene.add(mesh);

  if (gridLines) {
    scene.remove(gridLines);
    gridLines.geometry.dispose();
    (gridLines.material as THREE.Material).dispose();
    gridLines = null;
  }
  if (gridToggle.checked) createGrid(data, exaggeration);

  updateDetails(data, min, max, resetCamera);
}

function createGrid(data: TerrainFile, exaggeration: number): void {
  const { width, height, origin_m: origin, cell_size_m: cell, heights } = data.heightmap;
  const points: number[] = [];
  const gridStep = 10;
  const zOffset = 0.045;
  const at = (i: number, j: number): [number, number, number] => [
    origin[0] + i * cell[0],
    origin[1] + j * cell[1],
    heights[j * width + i] * exaggeration + zOffset,
  ];

  for (let j = 0; j < height; j += gridStep) {
    for (let i = 0; i < width - 1; i += 1) points.push(...at(i, j), ...at(i + 1, j));
  }
  for (let i = 0; i < width; i += gridStep) {
    for (let j = 0; j < height - 1; j += 1) points.push(...at(i, j), ...at(i, j + 1));
  }
  const lastJ = height - 1;
  const lastI = width - 1;
  for (let i = 0; i < width - 1; i += 1) points.push(...at(i, lastJ), ...at(i + 1, lastJ));
  for (let j = 0; j < height - 1; j += 1) points.push(...at(lastI, j), ...at(lastI, j + 1));

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
  gridLines = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({
    color: '#e5d9b9',
    transparent: true,
    opacity: 0.3,
    depthWrite: false,
  }));
  scene.add(gridLines);
}

function updateDetails(data: TerrainFile, min: number, max: number, resetCamera: boolean): void {
  const { width, height, origin_m: origin, cell_size_m: cell } = data.heightmap;
  const sizeX = (width - 1) * cell[0];
  const sizeY = (height - 1) * cell[1];
  const minText = `${min.toFixed(1)} m`;
  const maxText = `${max.toFixed(1)} m`;
  document.querySelector('#min-height')!.textContent = minText;
  document.querySelector('#max-height')!.textContent = maxText;
  document.querySelector('#legend-min')!.textContent = `${min.toFixed(0)} m`;
  document.querySelector('#legend-max')!.textContent = `${max.toFixed(0)} m`;
  document.querySelector('#terrain-description')!.textContent = data.terrain.description;
  document.querySelector('#view-name')!.textContent = terrainNames[currentTerrainKey].toUpperCase();
  document.querySelector('#view-size')!.textContent = `${sizeX} × ${sizeY} M`;
  document.querySelector('#site-width')!.textContent = `${sizeX} m`;
  document.querySelector('#site-height')!.textContent = `${sizeY} m`;
  document.querySelector('#vertex-count')!.textContent = (width * height).toLocaleString();
  document.querySelector('#cell-count')!.textContent = `${(width - 1) * (height - 1)}`;
  document.querySelector('#heightmap-size')!.textContent = `${width} × ${height}`;
  document.querySelector('.section-index')!.textContent = `01 / ${String(Object.keys(terrainNames).length).padStart(2, '0')}`;
  const elevationScale = Number(exaggerationInput.value);
  const centerZ = ((min + max) / 2) * elevationScale;
  ground.position.set(origin[0] + sizeX / 2, origin[1] + sizeY / 2, min * elevationScale - 0.16);
  updateReferenceAxes(data, min, max, elevationScale);
  if (resetCamera) {
    controls.target.set(origin[0] + sizeX / 2, origin[1] + sizeY / 2, centerZ);
    setCameraForTerrain(sizeX, sizeY, centerZ);
  } else {
    const elevationShift = centerZ - controls.target.z;
    controls.target.z = centerZ;
    camera.position.z += elevationShift;
    controls.update();
  }
}

function setCameraForTerrain(sizeX: number, sizeY: number, centerZ = controls.target.z): void {
  const centerX = controls.target.x;
  const centerY = controls.target.y;
  const distance = Math.max(sizeX, sizeY) * 1.72;
  camera.up.set(0, 0, 1);
  camera.position.set(centerX + distance * 0.78, centerY - distance * 0.95, centerZ + distance * 0.86);
  camera.near = Math.max(0.1, distance / 1000);
  camera.far = distance * 12;
  if (camera instanceof THREE.OrthographicCamera) {
    const viewDistance = camera.position.distanceTo(controls.target);
    setOrthographicHalfHeight(viewDistance * Math.tan(THREE.MathUtils.degToRad(19)));
    camera.zoom = 1;
  }
  camera.updateProjectionMatrix();
  controls.update();
}

function createOrbitControls(activeCamera: THREE.PerspectiveCamera | THREE.OrthographicCamera): OrbitControls {
  const orbit = new OrbitControls(activeCamera, renderer.domElement);
  orbit.enableDamping = true;
  orbit.dampingFactor = 0.07;
  orbit.minDistance = 65;
  orbit.maxDistance = 360;
  orbit.minZoom = 0.5;
  orbit.maxZoom = 5;
  orbit.maxPolarAngle = Math.PI;
  return orbit;
}

function setOrthographicHalfHeight(halfHeight: number): void {
  if (!(camera instanceof THREE.OrthographicCamera)) return;
  const aspect = viewport.clientWidth / Math.max(viewport.clientHeight, 1);
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
  const aspect = viewport.clientWidth / Math.max(viewport.clientHeight, 1);
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
        for (const material of materials) {
          const texture = (material as THREE.Material & { map?: THREE.Texture | null }).map;
          texture?.dispose();
          material.dispose();
        }
      }
    });
  }
}

function updateReferenceAxes(data: TerrainFile, min: number, max: number, elevationScale: number): void {
  clearReferenceAxes();
  const { origin_m: origin, cell_size_m: cell, width, height } = data.heightmap;
  const baseZ = 0.04;
  const start = new THREE.Vector3(origin[0], origin[1], baseZ);
  const xLength = Math.min(30, (width - 1) * cell[0] * 0.34);
  const yLength = Math.min(30, (height - 1) * cell[1] * 0.34);
  const zLength = Math.max(18, Math.min(32, (max - min) * elevationScale + 8));

  const addArrow = (direction: THREE.Vector3, color: string, length: number): void => {
    const arrow = new THREE.ArrowHelper(direction, start, length, color, Math.min(4, length * 0.17), 2.2);
    arrow.line.material.depthTest = false;
    arrow.line.material.depthWrite = false;
    arrow.line.material.transparent = true;
    arrow.line.material.opacity = 0.88;
    arrow.cone.material.depthTest = false;
    arrow.cone.material.depthWrite = false;
    arrow.cone.material.transparent = true;
    arrow.cone.material.opacity = 0.94;
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

function alignCameraToAxis(axisName: string, sign: number): void {
  if (!currentData) return;
  const { width, height, cell_size_m: cell } = currentData.heightmap;
  const distance = Math.max((width - 1) * cell[0], (height - 1) * cell[1]) * 1.72;
  const direction = new THREE.Vector3();
  direction[axisName as 'x' | 'y' | 'z'] = sign;
  camera.up.set(0, axisName === 'z' ? 1 : 0, axisName === 'z' ? 0 : 1);
  camera.position.copy(controls.target).addScaledVector(direction, distance);
  camera.lookAt(controls.target);
  controls.update();
}

function updateOrientationGizmo(): void {
  const inverseCameraRotation = camera.quaternion.clone().invert();
  const axes = [
    { name: 'x', vector: new THREE.Vector3(1, 0, 0) },
    { name: 'y', vector: new THREE.Vector3(0, 1, 0) },
    { name: 'z', vector: new THREE.Vector3(0, 0, 1) },
  ];

  for (const axis of axes) {
    const projected = axis.vector.clone().applyQuaternion(inverseCameraRotation);
    for (const sign of [-1, 1]) {
      const x = 50 + projected.x * sign * 31;
      const y = 50 - projected.y * sign * 31;
      const signName = sign > 0 ? 'positive' : 'negative';
      const line = orientationGizmo.querySelector<SVGLineElement>(`#${axis.name}-${signName}-line`)!;
      line.setAttribute('x2', x.toFixed(1));
      line.setAttribute('y2', y.toFixed(1));
      line.style.opacity = projected.z * sign < 0 ? '1' : '0.38';

      const endpoint = orientationGizmo.querySelector<SVGGElement>(`.gizmo-endpoint[data-axis="${axis.name}"][data-sign="${sign}"]`)!;
      endpoint.setAttribute('transform', `translate(${x.toFixed(1)} ${y.toFixed(1)})`);
      endpoint.style.opacity = projected.z * sign < 0 ? '1' : '0.56';
      endpoint.style.visibility = projected.z * sign > 0 && Math.hypot(projected.x, projected.y) < 0.22 ? 'hidden' : 'visible';
    }
  }
}

async function loadTerrain(key: string): Promise<void> {
  const requestSequence = ++loadSequence;
  currentTerrainKey = key;
  errorState.hidden = true;
  loadingState.hidden = false;
  try {
    const response = await fetch(`/${key}.json`);
    if (requestSequence !== loadSequence) return;
    if (!response.ok) throw new Error(`Could not load ${key}: ${response.status}`);
    const data = (await response.json()) as TerrainFile;
    if (requestSequence !== loadSequence) return;
    const { width, height, heights } = data.heightmap;
    if (heights.length !== width * height) throw new Error('Heightmap dimensions do not match its samples.');
    currentData = data;
    buildTerrain(data);
    loadingState.hidden = true;
  } catch (error) {
    if (requestSequence !== loadSequence) return;
    console.error(error);
    loadingState.hidden = true;
    errorState.hidden = false;
  }
}

function resizeRenderer(): void {
  const width = viewport.clientWidth;
  const height = viewport.clientHeight;
  renderer.setSize(width, height, false);
  const aspect = width / Math.max(height, 1);
  if (camera instanceof THREE.PerspectiveCamera) {
    camera.aspect = aspect;
  } else {
    const halfHeight = (camera.top - camera.bottom) / 2;
    camera.left = -halfHeight * aspect;
    camera.right = halfHeight * aspect;
  }
  camera.updateProjectionMatrix();
}

terrainSelect.addEventListener('change', () => void loadTerrain(terrainSelect.value));
document.querySelector<HTMLButtonElement>('#perspective-mode')!.addEventListener('click', () => setProjection('perspective'));
document.querySelector<HTMLButtonElement>('#orthographic-mode')!.addEventListener('click', () => setProjection('orthographic'));
orientationGizmo.querySelectorAll<SVGGElement>('.gizmo-endpoint').forEach((endpoint) => {
  const align = () => alignCameraToAxis(endpoint.dataset.axis!, Number(endpoint.dataset.sign));
  endpoint.addEventListener('click', align);
  endpoint.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      align();
    }
  });
});
document.querySelector<HTMLButtonElement>('#top-view')!.addEventListener('click', () => alignCameraToAxis('z', 1));
exaggerationInput.addEventListener('input', () => {
  document.querySelector('#exaggeration-value')!.textContent = `${Number(exaggerationInput.value).toFixed(1)}×`;
  if (currentData) buildTerrain(currentData, false);
});
gridToggle.addEventListener('change', () => {
  if (!currentData) return;
  if (gridLines) {
    scene.remove(gridLines);
    gridLines.geometry.dispose();
    (gridLines.material as THREE.Material).dispose();
    gridLines = null;
  }
  if (gridToggle.checked) createGrid(currentData, Number(exaggerationInput.value));
});
document.querySelector<HTMLButtonElement>('#reset-view')!.addEventListener('click', () => {
  if (!currentData) return;
  const { width, height, cell_size_m: cell, origin_m: origin } = currentData.heightmap;
  const elevations = currentData.heightmap.heights;
  const min = Math.min(...elevations);
  const max = Math.max(...elevations);
  const exaggeration = Number(exaggerationInput.value);
  const centerZ = ((min + max) / 2) * exaggeration;
  controls.target.set(origin[0] + ((width - 1) * cell[0]) / 2, origin[1] + ((height - 1) * cell[1]) / 2, centerZ);
  setCameraForTerrain((width - 1) * cell[0], (height - 1) * cell[1], centerZ);
});

new ResizeObserver(resizeRenderer).observe(viewport);
resizeRenderer();
void loadTerrain(terrainSelect.value);

renderer.setAnimationLoop(() => {
  controls.update();
  updateOrientationGizmo();
  renderer.render(scene, camera);
});
