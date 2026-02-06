import * as THREE from 'three';
import { createNoise2D } from 'simplex-noise';

// --- Seeded PRNG (Mulberry32) ---
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- fBm noise with octaves ---
function fbm(noise2D, x, z, octaves, lacunarity, gain) {
  let value = 0;
  let amplitude = 1;
  let frequency = 1;
  let max = 0;
  for (let i = 0; i < octaves; i++) {
    value += amplitude * noise2D(x * frequency, z * frequency);
    max += amplitude;
    amplitude *= gain;
    frequency *= lacunarity;
  }
  return value / max;
}

// --- Shared terrain height sampler (for placing objects) ---
function sampleHeight(noise2D, x, z, halfSize) {
  const scale = 0.015;
  const dx = x / halfSize;
  const dz = z / halfSize;
  const dist = Math.sqrt(dx * dx + dz * dz);
  const falloff = Math.max(0, 1 - Math.pow(dist, 3));

  let h = fbm(noise2D, x * scale, z * scale, 3, 2.0, 0.5);
  h = (h + 1) / 2;
  h = Math.pow(h, 1.8);
  h *= falloff;
  return h;
}

// --- Color helpers ---
function lerpColor(c1, c2, t) {
  return new THREE.Color().lerpColors(c1, c2, THREE.MathUtils.clamp(t, 0, 1));
}

function getTerrainColor(height) {
  const sand = new THREE.Color(0xc2b280);
  const grass = new THREE.Color(0x4a7c3f);
  const rock = new THREE.Color(0x6b6b6b);
  const snow = new THREE.Color(0xf0f0f0);

  if (height < 0.08) return sand;
  if (height < 0.15) return lerpColor(sand, grass, (height - 0.08) / 0.07);
  if (height < 0.45) return grass;
  if (height < 0.55) return lerpColor(grass, rock, (height - 0.45) / 0.10);
  if (height < 0.75) return rock;
  if (height < 0.85) return lerpColor(rock, snow, (height - 0.75) / 0.10);
  return snow;
}

// --- Terrain mesh ---
function createTerrain(noise2D, size, segments) {
  const geometry = new THREE.PlaneGeometry(size, size, segments, segments);
  geometry.rotateX(-Math.PI / 2);

  const positions = geometry.attributes.position;
  const count = positions.count;
  const colors = new Float32Array(count * 3);
  const halfSize = size / 2;

  for (let i = 0; i < count; i++) {
    const x = positions.getX(i);
    const z = positions.getZ(i);
    const h = sampleHeight(noise2D, x, z, halfSize);
    const elevation = h * 30;
    positions.setY(i, elevation);

    const color = getTerrainColor(h);
    colors[i * 3] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;
  }

  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.computeVertexNormals();

  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.85,
    metalness: 0.05,
    flatShading: false,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

// --- Water plane with wave-capable geometry ---
function createWater(size) {
  const segs = 80;
  const geometry = new THREE.PlaneGeometry(size * 1.2, size * 1.2, segs, segs);
  geometry.rotateX(-Math.PI / 2);

  // Store original Y positions for wave animation
  const pos = geometry.attributes.position;
  const baseY = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    baseY[i] = pos.getY(i);
  }
  geometry.userData = { baseY };

  const material = new THREE.MeshPhongMaterial({
    color: 0x1a6ea0,
    transparent: true,
    opacity: 0.65,
    shininess: 120,
    specular: 0x88ccff,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.y = 2.0;
  mesh.receiveShadow = true;
  return mesh;
}

// --- Trees ---
function createTrees(noise2D, rng, size) {
  const treeGroup = new THREE.Group();
  const count = Math.floor(150 + rng() * 100);
  const halfSize = size / 2;

  const trunkGeo = new THREE.CylinderGeometry(0.15, 0.2, 1.5, 6);
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x5c3d1e, roughness: 0.9 });
  const foliageGeo = new THREE.ConeGeometry(1.0, 2.5, 7);
  const foliageMat = new THREE.MeshStandardMaterial({ color: 0x2d6b1e, roughness: 0.8 });

  for (let i = 0; i < count; i++) {
    const x = (rng() - 0.5) * size * 0.85;
    const z = (rng() - 0.5) * size * 0.85;
    const h = sampleHeight(noise2D, x, z, halfSize);

    if (h < 0.12 || h > 0.48) continue;

    const elevation = h * 30;
    const treeScale = 0.7 + rng() * 0.8;

    const trunk = new THREE.Mesh(trunkGeo, trunkMat);
    trunk.position.set(x, elevation + 0.75 * treeScale, z);
    trunk.scale.setScalar(treeScale);
    trunk.castShadow = true;

    const foliage = new THREE.Mesh(foliageGeo, foliageMat);
    foliage.position.set(x, elevation + 2.2 * treeScale, z);
    foliage.scale.setScalar(treeScale);
    foliage.rotation.y = rng() * Math.PI * 2;
    foliage.castShadow = true;

    treeGroup.add(trunk);
    treeGroup.add(foliage);
  }

  return treeGroup;
}

// --- Rocks / Boulders ---
function createRocks(noise2D, rng, size) {
  const rockGroup = new THREE.Group();
  const count = Math.floor(80 + rng() * 60); // 80-140 rocks
  const halfSize = size / 2;

  const rockGeo = new THREE.DodecahedronGeometry(1, 1);
  const rockMat = new THREE.MeshStandardMaterial({
    color: 0x7a7a7a,
    roughness: 0.95,
    metalness: 0.05,
    flatShading: true,
  });

  for (let i = 0; i < count; i++) {
    const x = (rng() - 0.5) * size * 0.85;
    const z = (rng() - 0.5) * size * 0.85;
    const h = sampleHeight(noise2D, x, z, halfSize);

    // Place rocks in the rock/mountain zone
    if (h < 0.42 || h > 0.88) continue;

    const elevation = h * 30;
    const s = 0.3 + rng() * 1.0;

    const rock = new THREE.Mesh(rockGeo, rockMat);
    rock.position.set(x, elevation + s * 0.3, z);
    rock.scale.set(s * (0.8 + rng() * 0.4), s * (0.5 + rng() * 0.5), s * (0.8 + rng() * 0.4));
    rock.rotation.set(rng() * 0.5, rng() * Math.PI * 2, rng() * 0.5);
    rock.castShadow = true;
    rock.receiveShadow = true;
    rockGroup.add(rock);
  }

  return rockGroup;
}

// --- Wildflowers ---
function createFlowers(noise2D, rng, size) {
  const flowerGroup = new THREE.Group();
  const count = Math.floor(200 + rng() * 150); // 200-350 flowers
  const halfSize = size / 2;

  const petalColors = [0xff6b8a, 0xffaa33, 0xdd44ff, 0xffee44, 0xff4466, 0x66bbff];
  const stemGeo = new THREE.CylinderGeometry(0.02, 0.02, 0.4, 4);
  const stemMat = new THREE.MeshStandardMaterial({ color: 0x3a8a2a });

  // Create shared petal geometries
  const petalGeo = new THREE.SphereGeometry(0.12, 5, 4);

  for (let i = 0; i < count; i++) {
    const x = (rng() - 0.5) * size * 0.85;
    const z = (rng() - 0.5) * size * 0.85;
    const h = sampleHeight(noise2D, x, z, halfSize);

    // Only place flowers in grass zone
    if (h < 0.13 || h > 0.43) continue;

    const elevation = h * 30;
    const flowerScale = 0.6 + rng() * 0.8;
    const colorIdx = Math.floor(rng() * petalColors.length);

    // Stem
    const stem = new THREE.Mesh(stemGeo, stemMat);
    stem.position.set(x, elevation + 0.2 * flowerScale, z);
    stem.scale.setScalar(flowerScale);
    flowerGroup.add(stem);

    // Flower head (cluster of small spheres)
    const headMat = new THREE.MeshStandardMaterial({
      color: petalColors[colorIdx],
      roughness: 0.6,
    });
    const petals = 3 + Math.floor(rng() * 3);
    for (let p = 0; p < petals; p++) {
      const petal = new THREE.Mesh(petalGeo, headMat);
      const angle = (p / petals) * Math.PI * 2;
      const r = 0.06 * flowerScale;
      petal.position.set(
        x + Math.cos(angle) * r,
        elevation + 0.42 * flowerScale,
        z + Math.sin(angle) * r
      );
      petal.scale.setScalar(flowerScale);
      flowerGroup.add(petal);
    }
  }

  return flowerGroup;
}

// --- Sky dome ---
function createSkyDome(radius) {
  const geometry = new THREE.SphereGeometry(radius, 32, 16);
  const count = geometry.attributes.position.count;
  const colors = new Float32Array(count * 3);

  const zenith = new THREE.Color(0x1a3a6a);
  const horizon = new THREE.Color(0x87ceeb);

  for (let i = 0; i < count; i++) {
    const y = geometry.attributes.position.getY(i);
    const t = Math.max(0, y / radius);
    const color = lerpColor(horizon, zenith, Math.pow(t, 0.6));
    colors[i * 3] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;
  }

  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  const material = new THREE.MeshBasicMaterial({
    vertexColors: true,
    side: THREE.BackSide,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'sky';
  return mesh;
}

// --- Clouds ---
function createClouds(rng, size) {
  const cloudGroup = new THREE.Group();
  cloudGroup.name = 'clouds';
  const clusterCount = Math.floor(15 + rng() * 10);
  const cloudMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 1.0,
    transparent: true,
    opacity: 0.85,
  });

  for (let c = 0; c < clusterCount; c++) {
    const cx = (rng() - 0.5) * size * 1.2;
    const cy = 28 + rng() * 15;
    const cz = (rng() - 0.5) * size * 1.2;
    const puffs = 3 + Math.floor(rng() * 5);

    for (let p = 0; p < puffs; p++) {
      const radius = 2 + rng() * 3;
      const geo = new THREE.SphereGeometry(radius, 8, 6);
      const puff = new THREE.Mesh(geo, cloudMat);
      puff.position.set(
        cx + (rng() - 0.5) * 6,
        cy + (rng() - 0.5) * 1.5,
        cz + (rng() - 0.5) * 6
      );
      puff.scale.set(1, 0.4 + rng() * 0.3, 1);
      cloudGroup.add(puff);
    }
  }

  return cloudGroup;
}

// --- Update sky dome colors for time of day ---
export function updateSkyColors(skyMesh, timeOfDay) {
  // timeOfDay: 0 = midnight, 0.25 = sunrise, 0.5 = noon, 0.75 = sunset, 1 = midnight
  const geometry = skyMesh.geometry;
  const positions = geometry.attributes.position;
  const colors = geometry.attributes.color;
  const count = positions.count;
  const radius = 500;

  // Interpolate sky palette based on time
  let zenith, horizon;

  if (timeOfDay < 0.2) {
    // Night
    zenith = new THREE.Color(0x050510);
    horizon = new THREE.Color(0x0a0a20);
  } else if (timeOfDay < 0.3) {
    // Dawn
    const t = (timeOfDay - 0.2) / 0.1;
    zenith = lerpColor(new THREE.Color(0x050510), new THREE.Color(0x1a3a6a), t);
    horizon = lerpColor(new THREE.Color(0x0a0a20), new THREE.Color(0xff8844), t);
  } else if (timeOfDay < 0.5) {
    // Morning → Noon
    const t = (timeOfDay - 0.3) / 0.2;
    zenith = lerpColor(new THREE.Color(0x1a3a6a), new THREE.Color(0x0a2a5a), t);
    horizon = lerpColor(new THREE.Color(0xff8844), new THREE.Color(0x87ceeb), t);
  } else if (timeOfDay < 0.7) {
    // Noon → Afternoon
    zenith = new THREE.Color(0x0a2a5a);
    horizon = new THREE.Color(0x87ceeb);
  } else if (timeOfDay < 0.8) {
    // Sunset
    const t = (timeOfDay - 0.7) / 0.1;
    zenith = lerpColor(new THREE.Color(0x0a2a5a), new THREE.Color(0x1a1a3a), t);
    horizon = lerpColor(new THREE.Color(0x87ceeb), new THREE.Color(0xff6633), t);
  } else if (timeOfDay < 0.9) {
    // Dusk
    const t = (timeOfDay - 0.8) / 0.1;
    zenith = lerpColor(new THREE.Color(0x1a1a3a), new THREE.Color(0x050510), t);
    horizon = lerpColor(new THREE.Color(0xff6633), new THREE.Color(0x1a0a20), t);
  } else {
    // Night
    zenith = new THREE.Color(0x050510);
    horizon = new THREE.Color(0x0a0a20);
  }

  for (let i = 0; i < count; i++) {
    const y = positions.getY(i);
    const t = Math.max(0, y / radius);
    const color = lerpColor(horizon, zenith, Math.pow(t, 0.6));
    colors.setXYZ(i, color.r, color.g, color.b);
  }

  colors.needsUpdate = true;
}

// --- Animate water waves ---
// Waves are strongest in the ocean (edges) and calm in interior lakes.
export function animateWater(waterMesh, time) {
  const geo = waterMesh.geometry;
  const pos = geo.attributes.position;
  const baseY = geo.userData.baseY;
  if (!baseY) return;

  // Water plane is size*1.2, so halfExtent = size*0.6 = 120
  const halfExtent = 120;

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);

    // Distance from center, normalized so island edge (~100) ≈ 0.83
    const dist = Math.sqrt(x * x + z * z) / halfExtent;

    // Wave strength: 0 in interior (lakes), ramps up toward ocean
    // Uses the same cubic falloff shape as terrain island — where terrain
    // is high, waves are suppressed; where terrain falls away, waves appear.
    const terrainFalloff = Math.max(0, 1 - Math.pow(dist * 1.2, 3));
    const waveStrength = 1 - terrainFalloff;

    const wave = (Math.sin(x * 0.08 + time * 1.2) * 0.15
      + Math.sin(z * 0.06 + time * 0.9) * 0.12
      + Math.sin((x + z) * 0.05 + time * 1.5) * 0.08) * waveStrength;

    pos.setY(i, baseY[i] + wave);
  }

  pos.needsUpdate = true;
  geo.computeVertexNormals();
}

// --- Main export ---
export function generateLandscape(seed) {
  const rng = mulberry32(seed);
  const noise2D = createNoise2D(rng);

  const size = 200;
  const segments = 200;

  const group = new THREE.Group();
  group.name = 'landscape';

  const terrain = createTerrain(noise2D, size, segments);
  group.add(terrain);

  const water = createWater(size);
  water.name = 'water';
  group.add(water);

  const trees = createTrees(noise2D, rng, size);
  group.add(trees);

  const rocks = createRocks(noise2D, rng, size);
  group.add(rocks);

  const flowers = createFlowers(noise2D, rng, size);
  group.add(flowers);

  const sky = createSkyDome(500);
  group.add(sky);

  const clouds = createClouds(rng, size);
  group.add(clouds);

  return group;
}
