import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { generateLandscape, updateSkyColors, animateWater } from './terrain.js';

// --- Renderer ---
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
document.body.appendChild(renderer.domElement);

// --- Scene ---
const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x87ceeb, 0.003);

// --- Camera ---
const camera = new THREE.PerspectiveCamera(
  60,
  window.innerWidth / window.innerHeight,
  0.5,
  1000
);
camera.position.set(60, 40, 60);

// --- Post-processing (Bloom) ---
const composer = new EffectComposer(renderer);
const renderPass = new RenderPass(scene, camera);
composer.addPass(renderPass);

const bloomPass = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight),
  0.3, 0.8, 0.7
);
composer.addPass(bloomPass);

// --- Orbit Controls ---
const orbitControls = new OrbitControls(camera, renderer.domElement);
orbitControls.enableDamping = true;
orbitControls.dampingFactor = 0.08;
orbitControls.maxPolarAngle = Math.PI / 2 - 0.05;
orbitControls.minDistance = 10;
orbitControls.maxDistance = 200;
orbitControls.target.set(0, 5, 0);

// --- First Person Controls ---
const fpControls = new PointerLockControls(camera, document.body);

const fpvBtn = document.getElementById('fpv-btn');
const fpvHint = document.getElementById('fpv-hint');
const crosshair = document.getElementById('crosshair');
const hotbar = document.getElementById('hotbar');

let fpMode = false;
const moveState = { forward: false, backward: false, left: false, right: false, sprint: false };
const WALK_SPEED = 18;
const SPRINT_SPEED = 40;
const EYE_HEIGHT = 2.5;
const fpVelocity = new THREE.Vector3();
const fpDirection = new THREE.Vector3();

// --- Raycaster ---
const downRay = new THREE.Raycaster();
downRay.far = 200;
const aimRay = new THREE.Raycaster();
aimRay.far = 12; // block reach distance

function getTerrainHeight(x, z) {
  if (!currentLandscape) return 0;
  downRay.set(new THREE.Vector3(x, 100, z), new THREE.Vector3(0, -1, 0));
  const terrain = currentLandscape.children[0];
  if (!terrain) return 0;
  const hits = downRay.intersectObject(terrain);
  if (hits.length > 0) return hits[0].point.y;
  return 0;
}

// =============================================
// BLOCK BUILDING SYSTEM
// =============================================

const BLOCK_TYPES = [
  { name: 'Dirt',   color: 0x8B6914, roughness: 0.95, opacity: 1.0 },
  { name: 'Grass',  color: 0x4a7c3f, roughness: 0.9,  opacity: 1.0 },
  { name: 'Stone',  color: 0x888888, roughness: 0.95, opacity: 1.0 },
  { name: 'Wood',   color: 0x9e7c4a, roughness: 0.85, opacity: 1.0 },
  { name: 'Sand',   color: 0xd4c48a, roughness: 0.95, opacity: 1.0 },
  { name: 'Glass',  color: 0x8cc8ff, roughness: 0.1,  opacity: 0.4 },
];

let selectedSlot = 0;
const blockGroup = new THREE.Group();
blockGroup.name = 'blocks';
scene.add(blockGroup);

// Map of "x,y,z" -> mesh for O(1) lookup/removal
const placedBlocks = new Map();

// Shared block geometry
const blockGeo = new THREE.BoxGeometry(1, 1, 1);

// Pre-built materials for each block type
const blockMaterials = BLOCK_TYPES.map(bt => new THREE.MeshStandardMaterial({
  color: bt.color,
  roughness: bt.roughness,
  metalness: 0.05,
  transparent: bt.opacity < 1,
  opacity: bt.opacity,
}));

// Ghost preview block
const ghostMat = new THREE.MeshBasicMaterial({
  color: 0xffffff,
  transparent: true,
  opacity: 0.3,
  wireframe: false,
  depthWrite: false,
});
const ghostWireMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5 });
const ghostMesh = new THREE.Mesh(blockGeo, ghostMat);
const ghostWire = new THREE.LineSegments(new THREE.EdgesGeometry(blockGeo), ghostWireMat);
ghostMesh.add(ghostWire);
ghostMesh.visible = false;
scene.add(ghostMesh);

function blockKey(x, y, z) {
  return `${x},${y},${z}`;
}

function snapToGrid(v) {
  return Math.floor(v) + 0.5;
}

function placeBlock(gx, gy, gz) {
  const key = blockKey(gx, gy, gz);
  if (placedBlocks.has(key)) return; // already occupied

  const mesh = new THREE.Mesh(blockGeo, blockMaterials[selectedSlot]);
  mesh.position.set(gx, gy, gz);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.userData.isBlock = true;
  mesh.userData.blockKey = key;
  blockGroup.add(mesh);
  placedBlocks.set(key, mesh);
}

function removeBlock(mesh) {
  if (!mesh || !mesh.userData.isBlock) return;
  const key = mesh.userData.blockKey;
  blockGroup.remove(mesh);
  placedBlocks.delete(key);
  // Geometry is shared, no need to dispose per-block
}

function clearAllBlocks() {
  blockGroup.clear();
  placedBlocks.clear();
}

// Get aim target: returns { point, normal, object } or null
function getAimTarget() {
  if (!currentLandscape) return null;

  aimRay.setFromCamera(new THREE.Vector2(0, 0), camera);

  // Check placed blocks first, then terrain
  const targets = [blockGroup, currentLandscape.children[0]];
  const allHits = [];
  for (const t of targets) {
    if (!t) continue;
    const hits = aimRay.intersectObject(t, true);
    allHits.push(...hits);
  }

  if (allHits.length === 0) return null;
  allHits.sort((a, b) => a.distance - b.distance);
  return allHits[0];
}

// Compute placement position from a raycast hit
function getPlacementPos(hit) {
  if (hit.object.userData.isBlock) {
    // Place adjacent to the block face
    const n = hit.face.normal.clone();
    // Transform normal to world space
    n.transformDirection(hit.object.matrixWorld);
    const bx = Math.floor(hit.object.position.x) + 0.5 + Math.round(n.x);
    const by = Math.floor(hit.object.position.y) + 0.5 + Math.round(n.y);
    const bz = Math.floor(hit.object.position.z) + 0.5 + Math.round(n.z);
    return { x: bx, y: by, z: bz };
  } else {
    // Place on terrain surface
    const p = hit.point;
    const bx = snapToGrid(p.x);
    const by = snapToGrid(p.y);
    const bz = snapToGrid(p.z);
    return { x: bx, y: by, z: bz };
  }
}

// Update ghost preview each frame
function updateGhostBlock() {
  if (!fpMode || !fpControls.isLocked || blueprintActive) {
    ghostMesh.visible = false;
    return;
  }

  const hit = getAimTarget();
  if (!hit) {
    ghostMesh.visible = false;
    return;
  }

  const pos = getPlacementPos(hit);
  const key = blockKey(pos.x, pos.y, pos.z);

  // Don't show ghost where a block already exists
  if (placedBlocks.has(key)) {
    ghostMesh.visible = false;
    return;
  }

  ghostMesh.position.set(pos.x, pos.y, pos.z);
  // Tint ghost to match selected block color
  ghostMat.color.setHex(BLOCK_TYPES[selectedSlot].color);
  ghostMesh.visible = true;
}

// --- Hotbar UI ---
const hotbarSlots = document.querySelectorAll('.hotbar-slot');

function selectSlot(idx) {
  selectedSlot = THREE.MathUtils.clamp(idx, 0, BLOCK_TYPES.length - 1);
  hotbarSlots.forEach((el, i) => {
    el.classList.toggle('active', i === selectedSlot);
  });
}

hotbarSlots.forEach(el => {
  el.addEventListener('click', () => {
    selectSlot(parseInt(el.dataset.slot));
  });
});

// =============================================
// AI STRUCTURE BUILDER — BLUEPRINT SYSTEM
// =============================================

let blueprintBlocks = [];     // Array of {x, y, z, type} from API
let blueprintGroup = null;    // THREE.Group holding ghost meshes
let blueprintRotation = 0;    // 0-3 (90° increments)
let blueprintActive = false;

// Ghost materials for blueprint (one per block type)
const blueprintMaterials = BLOCK_TYPES.map(bt => new THREE.MeshBasicMaterial({
  color: bt.color,
  transparent: true,
  opacity: 0.35,
  depthWrite: false,
}));
const blueprintWireMat = new THREE.LineBasicMaterial({
  color: 0xffffff,
  transparent: true,
  opacity: 0.4,
});

// --- API Key Management ---
const apiKeyToggle = document.getElementById('api-key-toggle');
const apiKeyBody = document.getElementById('api-key-body');
const apiKeyInput = document.getElementById('api-key-input');
const apiKeySaveBtn = document.getElementById('api-key-save-btn');

// Pre-fill from localStorage
const storedKey = localStorage.getItem('anthropic_api_key');
if (storedKey) apiKeyInput.value = storedKey;

apiKeyToggle.addEventListener('click', () => {
  apiKeyBody.classList.toggle('visible');
});

function saveApiKey() {
  const key = apiKeyInput.value.trim();
  if (key) {
    localStorage.setItem('anthropic_api_key', key);
  } else {
    localStorage.removeItem('anthropic_api_key');
  }
}

apiKeySaveBtn.addEventListener('click', saveApiKey);
apiKeyInput.addEventListener('blur', saveApiKey);
apiKeyInput.addEventListener('keydown', (e) => e.stopPropagation());

// --- AI Build UI ---
const aiPromptInput = document.getElementById('ai-prompt-input');
const aiBuildBtn = document.getElementById('ai-build-btn');
const aiLoading = document.getElementById('ai-loading');
const aiError = document.getElementById('ai-error');
const blueprintHint = document.getElementById('blueprint-hint');

function showAiError(msg) {
  aiError.textContent = msg;
  aiError.classList.add('visible');
}
function clearAiError() {
  aiError.textContent = '';
  aiError.classList.remove('visible');
}
function setAiLoading(loading) {
  if (loading) {
    aiLoading.classList.add('visible');
    aiBuildBtn.disabled = true;
  } else {
    aiLoading.classList.remove('visible');
    aiBuildBtn.disabled = false;
  }
}

const AI_SYSTEM_PROMPT = `You are a Minecraft-style architect. Output ONLY a JSON array of blocks. No explanation, no markdown fences, just the raw JSON array.

Coordinate system:
- X = east/west
- Y = up (Y=0 is ground level)
- Z = north/south
- Center the structure on X=0, Z=0
- Build starting at Y=0 (ground level)

Block types (use the number):
0 = Dirt
1 = Grass
2 = Stone
3 = Wood
4 = Sand
5 = Glass

Rules:
- Stay within 20x20x20 bounding box
- Maximum 500 blocks
- Use appropriate materials: stone for foundations, wood for walls/framing, glass for windows, grass for rooftops/gardens, dirt for ground, sand for paths
- Make structures look good and recognizable
- All coordinates must be integers

Output format: [{"x":0,"y":0,"z":0,"type":2},{"x":1,"y":0,"z":0,"type":2},...]`;

async function generateStructure(prompt) {
  const apiKey = localStorage.getItem('anthropic_api_key');
  if (!apiKey) {
    showAiError('Set API key first (click "API Key" below)');
    return null;
  }

  clearAiError();
  setAiLoading(true);

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 16384,
        system: AI_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!response.ok) {
      const errBody = await response.json().catch(() => ({}));
      const errMsg = errBody?.error?.message || `API error (${response.status})`;
      showAiError(errMsg);
      return null;
    }

    const data = await response.json();
    let text = data.content?.[0]?.text;
    if (!text) {
      showAiError('No response from AI');
      return null;
    }

    // If response was truncated due to max_tokens, salvage complete blocks
    if (data.stop_reason === 'max_tokens') {
      const lastBrace = text.lastIndexOf('}');
      if (lastBrace !== -1) {
        text = text.substring(0, lastBrace + 1).replace(/,\s*$/, '') + ']';
      }
    }

    // Extract JSON array from response — handle code fences, surrounding text, etc.
    let blocks;
    try {
      // Try direct parse first
      blocks = JSON.parse(text.trim());
    } catch {
      // Try extracting from code fences
      const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
      if (fenceMatch) {
        try {
          blocks = JSON.parse(fenceMatch[1].trim());
        } catch { /* fall through */ }
      }
      // Try finding a raw JSON array in the text
      if (!blocks) {
        const bracketStart = text.indexOf('[');
        const bracketEnd = text.lastIndexOf(']');
        if (bracketStart !== -1 && bracketEnd > bracketStart) {
          try {
            blocks = JSON.parse(text.slice(bracketStart, bracketEnd + 1));
          } catch { /* fall through */ }
        }
      }
      if (!blocks) {
        showAiError('Failed to parse structure JSON');
        return null;
      }
    }

    if (!Array.isArray(blocks) || blocks.length === 0) {
      showAiError('No blocks generated');
      return null;
    }

    // Validate and clamp to 500 blocks
    const validated = [];
    for (const b of blocks) {
      if (typeof b.x !== 'number' || typeof b.y !== 'number' || typeof b.z !== 'number') continue;
      const type = typeof b.type === 'number' ? Math.max(0, Math.min(5, Math.round(b.type))) : 2;
      validated.push({
        x: Math.round(b.x),
        y: Math.round(b.y),
        z: Math.round(b.z),
        type,
      });
      if (validated.length >= 500) break;
    }

    if (validated.length === 0) {
      showAiError('No valid blocks in response');
      return null;
    }

    return validated;
  } catch (err) {
    showAiError(err.message || 'Network error');
    return null;
  } finally {
    setAiLoading(false);
  }
}

// --- Rotate block positions ---
function rotateBlocksCW(blocks) {
  // 90° clockwise around Y axis: (x, z) -> (z, -x) which is equivalent to (-z, x) for CCW
  // CW: (x,z) -> (-z, x)
  return blocks.map(b => ({ x: -b.z, y: b.y, z: b.x, type: b.type }));
}

function getRotatedBlocks() {
  let blocks = blueprintBlocks;
  for (let i = 0; i < blueprintRotation; i++) {
    blocks = rotateBlocksCW(blocks);
  }
  return blocks;
}

// --- Create blueprint ghost group ---
function createBlueprintGroup(blocks) {
  const group = new THREE.Group();
  for (const b of blocks) {
    const mat = blueprintMaterials[b.type];
    const mesh = new THREE.Mesh(blockGeo, mat);
    mesh.position.set(b.x + 0.5, b.y + 0.5, b.z + 0.5);
    const wire = new THREE.LineSegments(new THREE.EdgesGeometry(blockGeo), blueprintWireMat);
    mesh.add(wire);
    group.add(mesh);
  }
  return group;
}

// --- Update blueprint position each frame ---
function updateBlueprint() {
  if (!blueprintActive || !blueprintGroup) return;

  // Get camera forward direction (XZ only)
  const forward = new THREE.Vector3();
  camera.getWorldDirection(forward);
  forward.y = 0;
  forward.normalize();

  // Place blueprint 8 units ahead, snapped to grid
  const targetX = Math.round(camera.position.x + forward.x * 8);
  const targetZ = Math.round(camera.position.z + forward.z * 8);

  // Ground the blueprint: find terrain height at center
  const groundY = getTerrainHeight(targetX, targetZ);
  const waterLevel = 2.0;
  const baseY = Math.max(groundY, waterLevel);
  const targetY = Math.round(baseY);

  blueprintGroup.position.set(targetX, targetY, targetZ);
}

// --- Rebuild the ghost group after rotation ---
function rebuildBlueprintGroup() {
  if (!blueprintActive) return;
  const pos = blueprintGroup ? blueprintGroup.position.clone() : new THREE.Vector3();
  if (blueprintGroup) {
    scene.remove(blueprintGroup);
    // Dispose ghost meshes
    blueprintGroup.traverse(obj => {
      if (obj.geometry && obj.geometry !== blockGeo) obj.geometry.dispose();
    });
  }
  const rotated = getRotatedBlocks();
  blueprintGroup = createBlueprintGroup(rotated);
  blueprintGroup.position.copy(pos);
  scene.add(blueprintGroup);
}

// --- Activate blueprint mode ---
function activateBlueprint(blocks) {
  blueprintBlocks = blocks;
  blueprintRotation = 0;
  blueprintActive = true;

  // Enter FP mode if not already
  if (!fpMode) {
    enterFPMode();
  } else if (!fpControls.isLocked) {
    fpControls.lock();
  }

  // Hide single-block ghost
  ghostMesh.visible = false;

  // Show blueprint hint, hide normal hint
  blueprintHint.style.display = 'block';
  fpvHint.style.display = 'none';

  // Create ghost group
  const rotated = getRotatedBlocks();
  blueprintGroup = createBlueprintGroup(rotated);
  scene.add(blueprintGroup);
}

// --- Cancel blueprint ---
function cancelBlueprint() {
  if (!blueprintActive) return;
  blueprintActive = false;
  if (blueprintGroup) {
    scene.remove(blueprintGroup);
    blueprintGroup.traverse(obj => {
      if (obj.geometry && obj.geometry !== blockGeo) obj.geometry.dispose();
    });
    blueprintGroup = null;
  }
  blueprintBlocks = [];
  blueprintRotation = 0;

  // Restore normal hints
  blueprintHint.style.display = 'none';
  if (fpMode) fpvHint.style.display = 'block';
}

// --- Place all blueprint blocks ---
function placeBlueprint() {
  if (!blueprintActive || !blueprintGroup) return;

  const rotated = getRotatedBlocks();
  const origin = blueprintGroup.position;
  const savedSlot = selectedSlot;

  for (const b of rotated) {
    const wx = origin.x + b.x + 0.5;
    const wy = origin.y + b.y + 0.5;
    const wz = origin.z + b.z + 0.5;
    // Temporarily set selectedSlot to the block's type for placeBlock
    selectedSlot = b.type;
    placeBlock(wx, wy, wz);
  }

  selectedSlot = savedSlot;
  cancelBlueprint();
}

// --- Wire up Build button ---
aiBuildBtn.addEventListener('click', async () => {
  const prompt = aiPromptInput.value.trim();
  if (!prompt) return;

  const blocks = await generateStructure(prompt);
  if (blocks) {
    activateBlueprint(blocks);
  }
});

aiPromptInput.addEventListener('keydown', (e) => {
  e.stopPropagation(); // Prevent WASD/blueprint keys while typing
  if (e.key === 'Enter') {
    aiBuildBtn.click();
  }
});

// --- Mouse handlers for block place/remove ---
document.addEventListener('mousedown', (e) => {
  if (!fpMode || !fpControls.isLocked) return;

  // Blueprint mode intercepts clicks
  if (blueprintActive) {
    if (e.button === 0) {
      placeBlueprint();
    } else if (e.button === 2) {
      cancelBlueprint();
    }
    return;
  }

  const hit = getAimTarget();
  if (!hit) return;

  if (e.button === 0) {
    // Left click: place block
    const pos = getPlacementPos(hit);
    // Don't place block inside the player
    const dx = pos.x - camera.position.x;
    const dy = pos.y - camera.position.y;
    const dz = pos.z - camera.position.z;
    if (Math.abs(dx) < 0.8 && Math.abs(dz) < 0.8 && dy > -2 && dy < 0.5) return;
    placeBlock(pos.x, pos.y, pos.z);
  } else if (e.button === 2) {
    // Right click: remove block
    if (hit.object.userData.isBlock) {
      removeBlock(hit.object);
    }
  }
});

// Prevent context menu in FP mode
document.addEventListener('contextmenu', (e) => {
  if (fpMode) e.preventDefault();
});

// Scroll wheel to cycle block types
document.addEventListener('wheel', (e) => {
  if (!fpMode) return;
  const dir = e.deltaY > 0 ? 1 : -1;
  selectSlot((selectedSlot + dir + BLOCK_TYPES.length) % BLOCK_TYPES.length);
});

// =============================================
// FIRST PERSON MODE TOGGLE
// =============================================

function showFPUI(show) {
  crosshair.style.display = show ? 'block' : 'none';
  hotbar.style.display = show ? 'flex' : 'none';
  fpvHint.style.display = show ? 'block' : 'none';
}

function enterFPMode() {
  fpMode = true;
  fpvBtn.classList.add('active');
  fpvBtn.textContent = 'Orbit View';
  showFPUI(true);

  orbitControls.enabled = false;

  const startX = 20;
  const startZ = 20;
  const groundY = getTerrainHeight(startX, startZ);
  camera.position.set(startX, Math.max(groundY, 2.5) + EYE_HEIGHT, startZ);

  fpControls.lock();
}

function exitFPMode() {
  fpMode = false;
  fpvBtn.classList.remove('active');
  fpvBtn.textContent = 'First Person';
  showFPUI(false);
  ghostMesh.visible = false;
  cancelBlueprint();

  fpControls.unlock();

  camera.position.set(60, 40, 60);
  orbitControls.target.set(0, 5, 0);
  orbitControls.enabled = true;
}

fpvBtn.addEventListener('click', () => {
  if (fpMode) exitFPMode();
  else enterFPMode();
});

renderer.domElement.addEventListener('click', () => {
  if (fpMode && !fpControls.isLocked) {
    fpControls.lock();
  }
});

fpControls.addEventListener('unlock', () => {
  if (fpMode && !blueprintActive) {
    fpvHint.style.display = 'block';
  }
});

// --- WASD + block hotbar keys ---
function onKeyDown(e) {
  if (!fpMode) return;

  // Blueprint rotation keys
  if (blueprintActive) {
    switch (e.code) {
      case 'KeyQ':
        blueprintRotation = (blueprintRotation + 3) % 4; // CCW
        rebuildBlueprintGroup();
        return;
      case 'KeyE':
        blueprintRotation = (blueprintRotation + 1) % 4; // CW
        rebuildBlueprintGroup();
        return;
      case 'Escape':
        cancelBlueprint();
        return;
    }
  }

  switch (e.code) {
    case 'KeyW': moveState.forward = true; break;
    case 'KeyS': moveState.backward = true; break;
    case 'KeyA': moveState.left = true; break;
    case 'KeyD': moveState.right = true; break;
    case 'ShiftLeft': case 'ShiftRight': moveState.sprint = true; break;
    case 'Digit1': selectSlot(0); break;
    case 'Digit2': selectSlot(1); break;
    case 'Digit3': selectSlot(2); break;
    case 'Digit4': selectSlot(3); break;
    case 'Digit5': selectSlot(4); break;
    case 'Digit6': selectSlot(5); break;
  }
}
function onKeyUp(e) {
  switch (e.code) {
    case 'KeyW': moveState.forward = false; break;
    case 'KeyS': moveState.backward = false; break;
    case 'KeyA': moveState.left = false; break;
    case 'KeyD': moveState.right = false; break;
    case 'ShiftLeft': case 'ShiftRight': moveState.sprint = false; break;
  }
}
document.addEventListener('keydown', onKeyDown);
document.addEventListener('keyup', onKeyUp);

// --- Lighting ---
const sunLight = new THREE.DirectionalLight(0xfff4e0, 1.8);
sunLight.position.set(50, 80, 40);
sunLight.castShadow = true;
sunLight.shadow.mapSize.width = 2048;
sunLight.shadow.mapSize.height = 2048;
sunLight.shadow.camera.left = -100;
sunLight.shadow.camera.right = 100;
sunLight.shadow.camera.top = 100;
sunLight.shadow.camera.bottom = -100;
sunLight.shadow.camera.near = 0.5;
sunLight.shadow.camera.far = 200;
sunLight.shadow.bias = -0.0005;
scene.add(sunLight);

const hemiLight = new THREE.HemisphereLight(0x87ceeb, 0x4a7c3f, 0.5);
scene.add(hemiLight);

const ambientLight = new THREE.AmbientLight(0x404060, 0.3);
scene.add(ambientLight);

// --- Time of day ---
let timeOfDay = 0.35;

function updateTimeOfDay(t) {
  timeOfDay = t;

  const sunAngle = (t - 0.25) * Math.PI;
  const sunY = Math.sin(sunAngle) * 80;
  const sunXZ = Math.cos(sunAngle) * 80;
  sunLight.position.set(sunXZ, Math.max(sunY, -10), 40);

  const dayFactor = THREE.MathUtils.clamp(sunY / 80, 0, 1);
  sunLight.intensity = 0.1 + dayFactor * 1.7;

  const lowSunColor = new THREE.Color(0xff8844);
  const highSunColor = new THREE.Color(0xfff4e0);
  sunLight.color.lerpColors(lowSunColor, highSunColor, dayFactor);

  hemiLight.intensity = 0.05 + dayFactor * 0.5;
  ambientLight.intensity = 0.15 + (1 - dayFactor) * 0.15;

  const dayFog = new THREE.Color(0x87ceeb);
  const sunsetFog = new THREE.Color(0xff9966);
  const nightFog = new THREE.Color(0x0a0a18);

  if (t < 0.2 || t > 0.9) {
    scene.fog.color.copy(nightFog);
  } else if (t < 0.3) {
    scene.fog.color.lerpColors(nightFog, sunsetFog, (t - 0.2) / 0.1);
  } else if (t < 0.45) {
    scene.fog.color.lerpColors(sunsetFog, dayFog, (t - 0.3) / 0.15);
  } else if (t < 0.7) {
    scene.fog.color.copy(dayFog);
  } else if (t < 0.8) {
    scene.fog.color.lerpColors(dayFog, sunsetFog, (t - 0.7) / 0.1);
  } else {
    scene.fog.color.lerpColors(sunsetFog, nightFog, (t - 0.8) / 0.1);
  }

  const isLowSun = (t > 0.2 && t < 0.35) || (t > 0.7 && t < 0.85);
  bloomPass.strength = isLowSun ? 0.6 : (dayFactor < 0.2 ? 0.15 : 0.25);
  renderer.toneMappingExposure = 0.4 + dayFactor * 0.8;

  if (currentLandscape) {
    const sky = currentLandscape.getObjectByName('sky');
    if (sky) updateSkyColors(sky, t);
  }
}

function getTimeLabel(t) {
  if (t < 0.15) return 'Night';
  if (t < 0.25) return 'Pre-dawn';
  if (t < 0.35) return 'Sunrise';
  if (t < 0.45) return 'Morning';
  if (t < 0.55) return 'Noon';
  if (t < 0.65) return 'Afternoon';
  if (t < 0.75) return 'Evening';
  if (t < 0.85) return 'Sunset';
  if (t < 0.92) return 'Dusk';
  return 'Night';
}

// --- Landscape state ---
let currentLandscape = null;
let currentSeed = null;

function disposeLandscape() {
  if (!currentLandscape) return;

  currentLandscape.traverse((obj) => {
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) {
      if (Array.isArray(obj.material)) {
        obj.material.forEach((m) => m.dispose());
      } else {
        obj.material.dispose();
      }
    }
  });

  scene.remove(currentLandscape);
  currentLandscape = null;
}

function generate(seed) {
  if (seed === undefined) {
    seed = Math.floor(Math.random() * 2147483647);
  }
  currentSeed = seed;

  if (fpMode) exitFPMode();

  disposeLandscape();
  clearAllBlocks();
  currentLandscape = generateLandscape(seed);
  scene.add(currentLandscape);

  updateTimeOfDay(timeOfDay);

  document.getElementById('seed-value').textContent = seed;
  document.getElementById('seed-input').value = '';
}

// --- UI: buttons ---
document.getElementById('generate-btn').addEventListener('click', () => generate());

document.getElementById('screenshot-btn').addEventListener('click', () => {
  composer.render();
  const link = document.createElement('a');
  link.download = `landscape-${currentSeed || 'unknown'}.png`;
  link.href = renderer.domElement.toDataURL('image/png');
  link.click();
});

// --- UI: Time of day slider ---
const timeSlider = document.getElementById('time-slider');
const timeLabel = document.getElementById('time-label');

timeSlider.addEventListener('input', (e) => {
  const t = parseInt(e.target.value) / 100;
  timeOfDay = t;
  updateTimeOfDay(t);
  timeLabel.textContent = getTimeLabel(t);
});

// --- UI: Seed input ---
const seedInput = document.getElementById('seed-input');
const seedGoBtn = document.getElementById('seed-go-btn');

function applySeedInput() {
  const val = seedInput.value.trim();
  if (!val) return;
  const parsed = parseInt(val, 10);
  if (isNaN(parsed)) {
    let hash = 0;
    for (let i = 0; i < val.length; i++) {
      hash = ((hash << 5) - hash + val.charCodeAt(i)) | 0;
    }
    generate(Math.abs(hash));
  } else {
    generate(parsed);
  }
}

seedGoBtn.addEventListener('click', applySeedInput);
seedInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') applySeedInput();
});

// --- Resize ---
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
});

// --- Render loop ---
const clock = new THREE.Clock();
let prevTime = 0;

function animate() {
  requestAnimationFrame(animate);

  const elapsed = clock.getElapsedTime();
  const delta = elapsed - prevTime;
  prevTime = elapsed;

  // --- First-person movement ---
  if (fpMode && fpControls.isLocked) {
    const speed = moveState.sprint ? SPRINT_SPEED : WALK_SPEED;

    fpDirection.set(0, 0, 0);
    if (moveState.forward) fpDirection.z -= 1;
    if (moveState.backward) fpDirection.z += 1;
    if (moveState.left) fpDirection.x -= 1;
    if (moveState.right) fpDirection.x += 1;

    if (fpDirection.lengthSq() > 0) {
      fpDirection.normalize();

      const forward = new THREE.Vector3();
      camera.getWorldDirection(forward);
      forward.y = 0;
      forward.normalize();

      const right = new THREE.Vector3();
      right.crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();

      fpVelocity.set(0, 0, 0);
      fpVelocity.addScaledVector(forward, -fpDirection.z);
      fpVelocity.addScaledVector(right, fpDirection.x);
      fpVelocity.normalize().multiplyScalar(speed * delta);

      camera.position.add(fpVelocity);
    }

    const halfBound = 95;
    camera.position.x = THREE.MathUtils.clamp(camera.position.x, -halfBound, halfBound);
    camera.position.z = THREE.MathUtils.clamp(camera.position.z, -halfBound, halfBound);

    const groundY = getTerrainHeight(camera.position.x, camera.position.z);
    const waterLevel = 2.0;
    const floorY = Math.max(groundY, waterLevel);
    const targetY = floorY + EYE_HEIGHT;
    camera.position.y += (targetY - camera.position.y) * Math.min(1, delta * 8);

    // Update ghost block preview
    updateGhostBlock();
    // Update blueprint position
    updateBlueprint();
  } else {
    orbitControls.update();
  }

  if (currentLandscape) {
    const water = currentLandscape.getObjectByName('water');
    if (water) animateWater(water, elapsed);

    const clouds = currentLandscape.getObjectByName('clouds');
    if (clouds) {
      clouds.position.x = Math.sin(elapsed * 0.02) * 5;
      clouds.position.z = elapsed * 0.3 % 50 - 25;
    }
  }

  composer.render();
}

animate();

// --- Auto-generate on load ---
generate();
updateTimeOfDay(timeOfDay);
timeLabel.textContent = getTimeLabel(timeOfDay);
