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

// --- Chickens ---
function createChickens(noise2D, rng, size) {
  const chickenGroup = new THREE.Group();
  chickenGroup.name = 'chickens';
  const halfSize = size / 2;
  const count = Math.floor(15 + rng() * 16); // 15-30

  // Color palette for body feathers
  const bodyColors = [0xfff8e7, 0xf5deb3, 0xdaa520, 0xcd853f, 0xf0f0f0];

  // Shared geometries
  const bodyGeo = new THREE.SphereGeometry(0.45, 8, 6);
  const headGeo = new THREE.SphereGeometry(0.25, 8, 6);
  const eyeWhiteGeo = new THREE.SphereGeometry(0.08, 6, 4);
  const pupilGeo = new THREE.SphereGeometry(0.045, 5, 4);
  const beakGeo = new THREE.ConeGeometry(0.08, 0.2, 4);
  const combGeo = new THREE.SphereGeometry(0.06, 5, 4);
  const wattleGeo = new THREE.SphereGeometry(0.05, 5, 4);
  const wingGeo = new THREE.SphereGeometry(0.2, 6, 4);
  const legGeo = new THREE.CylinderGeometry(0.025, 0.025, 0.3, 4);
  const footGeo = new THREE.BoxGeometry(0.12, 0.02, 0.15);
  const tailGeo = new THREE.ConeGeometry(0.06, 0.2, 4);

  // Shared materials
  const eyeWhiteMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3 });
  const pupilMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.2 });
  const beakMat = new THREE.MeshStandardMaterial({ color: 0xff8c00, roughness: 0.6 });
  const combMat = new THREE.MeshStandardMaterial({ color: 0xcc1111, roughness: 0.5 });
  const legMat = new THREE.MeshStandardMaterial({ color: 0xd4880f, roughness: 0.7 });

  for (let i = 0; i < count; i++) {
    const x = (rng() - 0.5) * size * 0.8;
    const z = (rng() - 0.5) * size * 0.8;
    const h = sampleHeight(noise2D, x, z, halfSize);

    // Only grass zone
    if (h < 0.13 || h > 0.43) continue;

    const elevation = h * 30;
    const chicken = new THREE.Group();
    const colorIdx = Math.floor(rng() * bodyColors.length);
    const bodyMat = new THREE.MeshStandardMaterial({ color: bodyColors[colorIdx], roughness: 0.8 });

    // Body (squashed sphere)
    const body = new THREE.Mesh(bodyGeo, bodyMat);
    body.scale.set(1, 0.8, 1.2);
    body.position.y = 0.45;
    chicken.add(body);

    // Head (oversized for comedy)
    const head = new THREE.Mesh(headGeo, bodyMat);
    head.position.set(0, 0.85, 0.35);
    chicken.add(head);

    // Eyes - big googly
    const eyeL = new THREE.Mesh(eyeWhiteGeo, eyeWhiteMat);
    eyeL.position.set(-0.12, 0.9, 0.52);
    chicken.add(eyeL);
    const eyeR = new THREE.Mesh(eyeWhiteGeo, eyeWhiteMat);
    eyeR.position.set(0.12, 0.9, 0.52);
    chicken.add(eyeR);

    const pupilL = new THREE.Mesh(pupilGeo, pupilMat);
    pupilL.position.set(-0.12, 0.9, 0.58);
    chicken.add(pupilL);
    const pupilR = new THREE.Mesh(pupilGeo, pupilMat);
    pupilR.position.set(0.12, 0.9, 0.58);
    chicken.add(pupilR);

    // Beak (orange cone pointing forward)
    const beak = new THREE.Mesh(beakGeo, beakMat);
    beak.rotation.x = -Math.PI / 2;
    beak.position.set(0, 0.82, 0.58);
    chicken.add(beak);

    // Comb (3 red spheres on top of head)
    for (let c = 0; c < 3; c++) {
      const comb = new THREE.Mesh(combGeo, combMat);
      comb.position.set((c - 1) * 0.07, 1.06 + (c === 1 ? 0.04 : 0), 0.3);
      chicken.add(comb);
    }

    // Wattle (small red sphere under beak)
    const wattle = new THREE.Mesh(wattleGeo, combMat);
    wattle.position.set(0, 0.72, 0.55);
    chicken.add(wattle);

    // Wings (tiny flattened spheres on sides)
    const wingL = new THREE.Mesh(wingGeo, bodyMat);
    wingL.scale.set(0.3, 0.6, 0.8);
    wingL.position.set(-0.38, 0.5, 0);
    chicken.add(wingL);
    const wingR = new THREE.Mesh(wingGeo, bodyMat);
    wingR.scale.set(0.3, 0.6, 0.8);
    wingR.position.set(0.38, 0.5, 0);
    chicken.add(wingR);

    // Legs
    const legL = new THREE.Mesh(legGeo, legMat);
    legL.position.set(-0.12, 0.15, 0);
    chicken.add(legL);
    const legR = new THREE.Mesh(legGeo, legMat);
    legR.position.set(0.12, 0.15, 0);
    chicken.add(legR);

    // Feet
    const footL = new THREE.Mesh(footGeo, legMat);
    footL.position.set(-0.12, 0.01, 0.03);
    chicken.add(footL);
    const footR = new THREE.Mesh(footGeo, legMat);
    footR.position.set(0.12, 0.01, 0.03);
    chicken.add(footR);

    // Tail (2 small upward cones at rear)
    const tail1 = new THREE.Mesh(tailGeo, bodyMat);
    tail1.position.set(-0.06, 0.7, -0.45);
    tail1.rotation.x = 0.3;
    chicken.add(tail1);
    const tail2 = new THREE.Mesh(tailGeo, bodyMat);
    tail2.position.set(0.06, 0.75, -0.48);
    tail2.rotation.x = 0.2;
    chicken.add(tail2);

    // Place chicken
    chicken.position.set(x, elevation, z);
    const facing = rng() * Math.PI * 2;
    chicken.rotation.y = facing;

    // Animation state in userData
    chicken.userData = {
      state: 'idle',
      stateTimer: rng() * 3,
      phase: rng() * Math.PI * 2,
      targetX: x,
      targetZ: z,
      headRef: head,
      bodyRef: body,
      legLRef: legL,
      legRRef: legR,
      wingLRef: wingL,
      wingRRef: wingR,
      baseY: elevation,
    };

    chickenGroup.add(chicken);
  }

  return chickenGroup;
}

// --- Animate chickens ---
export function animateChickens(chickenGroup, elapsed, delta, getHeight) {
  if (!chickenGroup) return;

  for (const chicken of chickenGroup.children) {
    const ud = chicken.userData;
    if (!ud.state) continue;

    ud.stateTimer -= delta;

    // State transitions
    if (ud.stateTimer <= 0) {
      const roll = Math.random();
      if (roll < 0.4) {
        ud.state = 'walking';
        ud.stateTimer = 2 + Math.random() * 3;
        // Pick random nearby target
        const angle = Math.random() * Math.PI * 2;
        const dist = 2 + Math.random() * 6;
        ud.targetX = chicken.position.x + Math.cos(angle) * dist;
        ud.targetZ = chicken.position.z + Math.sin(angle) * dist;
        // Clamp to bounds
        const bound = 85;
        ud.targetX = Math.max(-bound, Math.min(bound, ud.targetX));
        ud.targetZ = Math.max(-bound, Math.min(bound, ud.targetZ));
      } else if (roll < 0.7) {
        ud.state = 'pecking';
        ud.stateTimer = 1 + Math.random() * 2;
      } else {
        ud.state = 'idle';
        ud.stateTimer = 1.5 + Math.random() * 2.5;
      }
    }

    const t = elapsed + ud.phase;

    if (ud.state === 'walking') {
      // Move toward target
      const dx = ud.targetX - chicken.position.x;
      const dz = ud.targetZ - chicken.position.z;
      const dist = Math.sqrt(dx * dx + dz * dz);

      if (dist > 0.3) {
        const speed = 1.5 * delta;
        const nx = dx / dist;
        const nz = dz / dist;
        chicken.position.x += nx * speed;
        chicken.position.z += nz * speed;

        // Face target
        chicken.rotation.y = Math.atan2(nx, nz);

        // Track terrain
        const groundY = getHeight(chicken.position.x, chicken.position.z);
        chicken.position.y = groundY;
      } else {
        // Arrived, switch to idle
        ud.state = 'idle';
        ud.stateTimer = 1 + Math.random() * 2;
      }

      // Body bob while walking
      if (ud.bodyRef) {
        ud.bodyRef.position.y = 0.45 + Math.sin(t * 10) * 0.03;
      }
      // Leg alternation
      if (ud.legLRef && ud.legRRef) {
        ud.legLRef.rotation.x = Math.sin(t * 10) * 0.4;
        ud.legRRef.rotation.x = Math.sin(t * 10 + Math.PI) * 0.4;
      }
      // Wing flap while walking
      if (ud.wingLRef && ud.wingRRef) {
        const wingFlap = Math.sin(t * 8) * 0.1;
        ud.wingLRef.rotation.z = wingFlap;
        ud.wingRRef.rotation.z = -wingFlap;
      }
      // Head bob forward/back
      if (ud.headRef) {
        ud.headRef.position.z = 0.35 + Math.sin(t * 10) * 0.05;
        ud.headRef.position.y = 0.85;
        ud.headRef.rotation.x = 0;
      }
    } else if (ud.state === 'pecking') {
      // Head bobs down/up
      if (ud.headRef) {
        const peckPhase = Math.sin(t * 6);
        ud.headRef.position.y = 0.85 - Math.max(0, peckPhase) * 0.3;
        ud.headRef.position.z = 0.35 + Math.max(0, peckPhase) * 0.15;
        ud.headRef.rotation.x = Math.max(0, peckPhase) * 0.5;
      }
      // Body leans forward slightly
      if (ud.bodyRef) {
        ud.bodyRef.rotation.x = Math.sin(t * 6) * 0.08;
        ud.bodyRef.position.y = 0.45;
      }
      // Legs still
      if (ud.legLRef) ud.legLRef.rotation.x = 0;
      if (ud.legRRef) ud.legRRef.rotation.x = 0;
      // Wings still
      if (ud.wingLRef) ud.wingLRef.rotation.z = 0;
      if (ud.wingRRef) ud.wingRRef.rotation.z = 0;
    } else {
      // Idle: gentle body bob, head looks around
      if (ud.bodyRef) {
        ud.bodyRef.position.y = 0.45 + Math.sin(t * 2) * 0.015;
        ud.bodyRef.rotation.x = 0;
      }
      if (ud.headRef) {
        ud.headRef.rotation.y = Math.sin(t * 1.2) * 0.4;
        ud.headRef.position.y = 0.85;
        ud.headRef.position.z = 0.35;
        ud.headRef.rotation.x = 0;
      }
      // Legs still
      if (ud.legLRef) ud.legLRef.rotation.x = 0;
      if (ud.legRRef) ud.legRRef.rotation.x = 0;
      // Wings gentle
      if (ud.wingLRef) ud.wingLRef.rotation.z = 0;
      if (ud.wingRRef) ud.wingRRef.rotation.z = 0;
    }
  }
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

// --- Blockify: convert smooth terrain to voxel blocks ---
export function blockifyTerrain(landscapeGroup) {
  const { noise2D, size } = landscapeGroup.userData;
  const halfSize = size / 2;
  const WATER_Y = 2.0;
  const DEPTH = 3; // blocks deep per column

  // Block type definitions matching BLOCK_TYPES in app.js
  const types = [
    { name: 'Dirt',  color: 0x8B6914 }, // 0
    { name: 'Grass', color: 0x4a7c3f }, // 1
    { name: 'Stone', color: 0x888888 }, // 2
    { name: 'Wood',  color: 0x9e7c4a }, // 3
    { name: 'Sand',  color: 0xd4c48a }, // 4
  ];

  // Collect positions per type
  const positions = new Map(); // typeIndex -> [x,y,z, x,y,z, ...]
  for (let i = 0; i < types.length; i++) positions.set(i, []);

  for (let ix = -halfSize; ix < halfSize; ix++) {
    for (let iz = -halfSize; iz < halfSize; iz++) {
      const h = sampleHeight(noise2D, ix, iz, halfSize);
      const elevation = h * 30;

      // Skip columns below water
      if (elevation < WATER_Y) continue;

      // Determine surface and fill types
      let surfaceType, fillType;
      if (h < 0.15) {
        surfaceType = 4; // Sand
        fillType = 4;
      } else if (h < 0.45) {
        surfaceType = 1; // Grass
        fillType = 0;    // Dirt
      } else {
        surfaceType = 2; // Stone
        fillType = 2;
      }

      const surfaceY = Math.floor(elevation) + 0.5;

      // Surface block
      positions.get(surfaceType).push(ix + 0.5, surfaceY, iz + 0.5);

      // Fill blocks below surface
      for (let d = 1; d < DEPTH; d++) {
        const fy = surfaceY - d;
        if (fy < 0) break;
        positions.get(fillType).push(ix + 0.5, fy, iz + 0.5);
      }
    }
  }

  const group = new THREE.Group();
  group.name = 'voxelTerrain';

  const boxGeo = new THREE.BoxGeometry(1, 1, 1);

  for (const [typeIdx, posArr] of positions) {
    const count = posArr.length / 3;
    if (count === 0) continue;

    const mat = new THREE.MeshStandardMaterial({
      color: types[typeIdx].color,
      roughness: 0.9,
      metalness: 0.05,
    });

    const mesh = new THREE.InstancedMesh(boxGeo, mat, count);
    mesh.castShadow = true;
    mesh.receiveShadow = true;

    const dummy = new THREE.Object3D();
    for (let i = 0; i < count; i++) {
      dummy.position.set(posArr[i * 3], posArr[i * 3 + 1], posArr[i * 3 + 2]);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    }

    mesh.instanceMatrix.needsUpdate = true;
    group.add(mesh);
  }

  return group;
}

// --- Main export ---
export function generateLandscape(seed) {
  const rng = mulberry32(seed);
  const noise2D = createNoise2D(rng);

  const size = 200;
  const segments = 200;

  const group = new THREE.Group();
  group.name = 'landscape';
  group.userData.noise2D = noise2D;
  group.userData.size = size;

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

  const chickens = createChickens(noise2D, rng, size);
  group.add(chickens);

  const sky = createSkyDome(500);
  group.add(sky);

  const clouds = createClouds(rng, size);
  group.add(clouds);

  return group;
}
