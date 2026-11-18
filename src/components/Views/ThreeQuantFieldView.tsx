import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { ChevronDown, ChevronUp, Compass, Play, ShieldCheck, Zap } from 'lucide-react';
import type { DigitStat } from '../../hooks/useDerivMarket.ts';
import {
  computeMarkovTransitionSurvival,
  evaluateDtraderPerfectSetup,
} from '../../lib/marketAnalysis.ts';
import {
  DERIV_MARKETS,
  type ContractTypeOption,
  type DurationUnit,
  type MarketSymbol,
  type TickPoint,
} from '../../shared/types.ts';
import { MarketSelector } from '../MarketSelector.tsx';

interface ThreeQuantFieldViewProps {
  activeSymbol: string;
  markets?: MarketSymbol[];
  currency?: string;
  authenticated?: boolean;
  ticks: TickPoint[];
  latestTick: TickPoint | null;
  computeDigitStats: (sampleSize: number) => DigitStat[];
  onSelectMarket: (symbol: string) => void;
  onRequireLogin?: () => void;
  onPlaceTrade: (params: {
    symbol: string;
    contractType: ContractTypeOption;
    barrier: number;
    stake: number;
    durationTicks: number;
    durationUnit?: DurationUnit;
    source: 'manual' | 'scanner';
  }) => boolean;
}

type CameraPresetId = 'orbital' | 'radar' | 'closeup' | 'helix';

const CAMERA_PRESETS: Record<
  CameraPresetId,
  { label: string; pos: [number, number, number]; target: [number, number, number] }
> = {
  orbital: { label: 'Orbital Arena', pos: [12.5, 9.5, 13.5], target: [0, 1.4, 0] },
  radar: { label: 'Top Radar', pos: [0.01, 18.5, 0.01], target: [0, 0.5, 0] },
  closeup: { label: 'Pylon Focus', pos: [8.5, 4.2, 9.2], target: [0, 1.8, 0] },
  helix: { label: '1000t Stream', pos: [-10.5, 6.8, 10.5], target: [0, 2.8, 0] },
};

function createGridTexture(maxAniso: number): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#0b1220';
  ctx.fillRect(0, 0, 512, 512);

  ctx.strokeStyle = 'rgba(56, 189, 248, 0.14)';
  ctx.lineWidth = 1;
  const step = 32;
  for (let i = 0; i <= 512; i += step) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i, 512);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, i);
    ctx.lineTo(512, i);
    ctx.stroke();
  }

  ctx.strokeStyle = 'rgba(20, 184, 166, 0.28)';
  ctx.lineWidth = 2;
  for (let i = 0; i <= 512; i += 128) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i, 512);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, i);
    ctx.lineTo(512, i);
    ctx.stroke();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(6, 6);
  tex.anisotropy = maxAniso;
  return tex;
}

function createContactShadowTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  const grad = ctx.createRadialGradient(64, 64, 4, 64, 64, 62);
  grad.addColorStop(0, 'rgba(0, 0, 0, 0.58)');
  grad.addColorStop(0.55, 'rgba(0, 0, 0, 0.22)');
  grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function createDigitBadgeTexture(digit: number): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#0f172a';
  ctx.fillRect(0, 0, 128, 128);
  ctx.strokeStyle = '#38bdf8';
  ctx.lineWidth = 6;
  ctx.strokeRect(6, 6, 116, 116);
  ctx.fillStyle = '#f8fafc';
  ctx.font = 'bold 72px "JetBrains Mono", monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(digit), 64, 68);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function ThreeQuantFieldView({
  activeSymbol,
  markets = DERIV_MARKETS,
  currency = 'USD',
  authenticated = false,
  ticks,
  latestTick,
  computeDigitStats,
  onSelectMarket,
  onRequireLogin,
  onPlaceTrade,
}: ThreeQuantFieldViewProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  const [selectedDigit, setSelectedDigit] = useState<number>(4);
  const [hoveredDigit, setHoveredDigit] = useState<number | null>(null);
  const [dockCollapsed, setDockCollapsed] = useState(false);
  const [activePreset, setActivePreset] = useState<CameraPresetId>('orbital');
  const [stake, setStake] = useState(5);

  const cameraTargetGoalRef = useRef<{
    active: boolean;
    pos: THREE.Vector3;
    target: THREE.Vector3;
  }>({
    active: false,
    pos: new THREE.Vector3(...CAMERA_PRESETS.orbital.pos),
    target: new THREE.Vector3(...CAMERA_PRESETS.orbital.target),
  });

  const activeMarketMeta = useMemo(
    () =>
      markets.find((m) => m.symbol === activeSymbol) ??
      DERIV_MARKETS.find((m) => m.symbol === activeSymbol) ??
      markets[0] ??
      DERIV_MARKETS[1],
    [activeSymbol, markets],
  );

  const digitStats1000 = useMemo(() => computeDigitStats(1000), [computeDigitStats]);
  const markov = useMemo(() => computeMarkovTransitionSurvival(ticks, 1000), [ticks]);
  const perfectSetup = useMemo(
    () => evaluateDtraderPerfectSetup(ticks, activeMarketMeta),
    [activeMarketMeta, ticks],
  );

  // Ref snapshot fed cleanly into the Three.js render loop without tearing down WebGL on every tick
  const liveStateRef = useRef({
    digitStats1000,
    ticks1000: ticks.slice(-1000),
    latestDigit: latestTick?.lastDigit ?? null,
    targetDigit: perfectSetup.barrier,
    allGatesPassed: perfectSetup.allGatesPassed,
    selectedDigit,
  });
  liveStateRef.current = {
    digitStats1000,
    ticks1000: ticks.slice(-1000),
    latestDigit: latestTick?.lastDigit ?? null,
    targetDigit: perfectSetup.barrier,
    allGatesPassed: perfectSetup.allGatesPassed,
    selectedDigit,
  };

  useEffect(() => {
    const container = mountRef.current;
    if (!container) return;

    const width = Math.max(320, container.clientWidth);
    const height = Math.max(240, container.clientHeight);

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
    });
    const gl = renderer.getContext();
    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
    const rendererString = debugInfo
      ? String(gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) || '')
      : '';
    const isSoftwareGl = /SwiftShader|llvmpipe|Software|Mesa OffScreen/i.test(rendererString);

    renderer.setPixelRatio(isSoftwareGl ? 1 : Math.min(2, window.devicePixelRatio || 1));
    renderer.setSize(width, height);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.shadowMap.enabled = !isSoftwareGl;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(renderer.domElement);

    const maxAniso = isSoftwareGl
      ? 1
      : Math.min(4, renderer.capabilities.getMaxAnisotropy());

    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#070B14');
    scene.fog = new THREE.FogExp2('#070B14', 0.02);

    const pmrem = new THREE.PMREMGenerator(renderer);
    const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = envTex;

    const camera = new THREE.PerspectiveCamera(46, width / height, 0.1, 120);
    camera.position.set(...CAMERA_PRESETS.orbital.pos);
    camera.layers.enable(1);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.06;
    controls.maxPolarAngle = Math.PI * 0.48;
    controls.minDistance = 7;
    controls.maxDistance = 28;
    controls.target.set(...CAMERA_PRESETS.orbital.target);

    const cancelGoalOnUserInput = () => {
      cameraTargetGoalRef.current.active = false;
    };
    controls.addEventListener('start', cancelGoalOnUserInput);

    // Lighting Rig
    const hemi = new THREE.HemisphereLight('#7dd3fc', '#0f172a', 0.8);
    scene.add(hemi);

    const dirLight = new THREE.DirectionalLight('#fff2df', 2.4);
    dirLight.position.set(10, 16, 11);
    dirLight.castShadow = !isSoftwareGl;
    if (!isSoftwareGl) {
      dirLight.shadow.mapSize.set(1024, 1024);
      dirLight.shadow.camera.near = 2;
      dirLight.shadow.camera.far = 45;
      dirLight.shadow.camera.left = -12;
      dirLight.shadow.camera.right = 12;
      dirLight.shadow.camera.top = 12;
      dirLight.shadow.camera.bottom = -12;
      dirLight.shadow.bias = -0.0005;
    }
    scene.add(dirLight);

    const rimLight = new THREE.DirectionalLight('#38bdf8', 0.9);
    rimLight.position.set(-12, 8, -10);
    scene.add(rimLight);

    // Arena Base + Procedural Grid + Contact Shadows
    const gridTex = createGridTexture(maxAniso);
    const shadowTex = createContactShadowTexture();

    const floorGeo = new THREE.CylinderGeometry(14.5, 15.2, 0.4, 48);
    const floorMat = new THREE.MeshStandardMaterial({
      map: gridTex,
      roughness: 0.65,
      metalness: 0.35,
    });
    const floorMesh = new THREE.Mesh(floorGeo, floorMat);
    floorMesh.position.y = -0.2;
    floorMesh.receiveShadow = true;
    scene.add(floorMesh);

    const outerRim = new THREE.Mesh(
      new THREE.TorusGeometry(14.6, 0.14, 16, 64),
      new THREE.MeshStandardMaterial({ color: '#1e293b', metalness: 0.85, roughness: 0.25 }),
    );
    outerRim.rotation.x = Math.PI / 2;
    outerRim.position.y = 0.04;
    scene.add(outerRim);

    const orbitTrack = new THREE.Mesh(
      new THREE.TorusGeometry(7.2, 0.05, 12, 64),
      new THREE.MeshStandardMaterial({ color: '#0284c7', emissive: '#0284c7', emissiveIntensity: 0.6 }),
    );
    orbitTrack.rotation.x = Math.PI / 2;
    orbitTrack.position.y = 0.03;
    scene.add(orbitTrack);

    // Central Composite Quantum Core (8-part THREE.Group)
    const coreGroup = new THREE.Group();
    scene.add(coreGroup);

    const coreShadow = new THREE.Mesh(
      new THREE.PlaneGeometry(5.6, 5.6),
      new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false }),
    );
    coreShadow.rotation.x = -Math.PI / 2;
    coreShadow.position.y = 0.02;
    coreGroup.add(coreShadow);

    const coreBase = new THREE.Mesh(
      new THREE.CylinderGeometry(1.7, 2.1, 0.45, 8),
      new THREE.MeshStandardMaterial({ color: '#1e293b', metalness: 0.85, roughness: 0.28 }),
    );
    coreBase.position.y = 0.22;
    coreBase.castShadow = true;
    coreGroup.add(coreBase);

    const coreCollar = new THREE.Mesh(
      new THREE.CylinderGeometry(1.2, 1.5, 0.3, 16),
      new THREE.MeshStandardMaterial({ color: '#334155', metalness: 0.9, roughness: 0.2 }),
    );
    coreCollar.position.y = 0.58;
    coreGroup.add(coreCollar);

    const coreEmitter = new THREE.Mesh(
      new THREE.TorusGeometry(1.3, 0.06, 12, 32),
      new THREE.MeshStandardMaterial({ color: '#14b8a6', emissive: '#14b8a6', emissiveIntensity: 1.1 }),
    );
    coreEmitter.rotation.x = Math.PI / 2;
    coreEmitter.position.y = 0.74;
    coreGroup.add(coreEmitter);

    const coreCrystal = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.95, 1),
      new THREE.MeshPhysicalMaterial({
        color: '#0ea5e9',
        emissive: '#0369a1',
        emissiveIntensity: 0.55,
        metalness: 0.2,
        roughness: 0.15,
        clearcoat: 1,
        clearcoatRoughness: 0.1,
      }),
    );
    coreCrystal.position.y = 2.25;
    coreCrystal.castShadow = true;
    coreGroup.add(coreCrystal);

    const gimbalOuter = new THREE.Mesh(
      new THREE.TorusGeometry(1.55, 0.055, 12, 48),
      new THREE.MeshStandardMaterial({ color: '#cbd5e1', metalness: 0.92, roughness: 0.18 }),
    );
    gimbalOuter.position.y = 2.25;
    coreGroup.add(gimbalOuter);

    const gimbalInner = new THREE.Mesh(
      new THREE.TorusGeometry(1.25, 0.045, 12, 48),
      new THREE.MeshStandardMaterial({ color: '#14b8a6', metalness: 0.85, roughness: 0.22 }),
    );
    gimbalInner.position.y = 2.25;
    gimbalInner.rotation.x = Math.PI / 3;
    coreGroup.add(gimbalInner);

    const coreCrown = new THREE.Mesh(
      new THREE.ConeGeometry(0.35, 0.65, 6),
      new THREE.MeshStandardMaterial({ color: '#e2e8f0', metalness: 0.85, roughness: 0.2 }),
    );
    coreCrown.position.y = 3.6;
    coreCrown.rotation.x = Math.PI;
    coreGroup.add(coreCrown);

    // Ten 4-Part Digit Frequency Pylons (Digits 0-9) on Radius 7.2
    const pylonRecords: {
      digit: number;
      group: THREE.Group;
      column: THREE.Mesh;
      columnMat: THREE.MeshPhysicalMaterial;
      cap: THREE.Group;
      ring: THREE.Mesh;
      ringMat: THREE.MeshStandardMaterial;
      currentScaleY: number;
    }[] = [];
    const hitTargets: THREE.Mesh[] = [];
    const disposableTextures: THREE.Texture[] = [gridTex, shadowTex];

    for (let d = 0; d < 10; d++) {
      const angle = (d / 10) * Math.PI * 2 - Math.PI / 2;
      const radius = 7.2;
      const px = Math.cos(angle) * radius;
      const pz = Math.sin(angle) * radius;

      const pylonGroup = new THREE.Group();
      pylonGroup.position.set(px, 0, pz);
      pylonGroup.lookAt(0, 0, 0);
      scene.add(pylonGroup);

      const pShadow = new THREE.Mesh(
        new THREE.PlaneGeometry(2.2, 2.2),
        new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false }),
      );
      pShadow.rotation.x = -Math.PI / 2;
      pShadow.position.y = 0.025;
      pylonGroup.add(pShadow);

      const plinth = new THREE.Mesh(
        new THREE.CylinderGeometry(0.75, 0.9, 0.28, 6),
        new THREE.MeshStandardMaterial({ color: '#1e293b', metalness: 0.82, roughness: 0.3 }),
      );
      plinth.position.y = 0.14;
      plinth.castShadow = true;
      pylonGroup.add(plinth);

      const ringMat = new THREE.MeshStandardMaterial({
        color: '#38bdf8',
        emissive: '#0284c7',
        emissiveIntensity: 0.4,
        metalness: 0.6,
        roughness: 0.25,
      });
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.68, 0.05, 10, 24), ringMat);
      ring.rotation.x = Math.PI / 2;
      ring.position.y = 0.29;
      pylonGroup.add(ring);

      const columnMat = new THREE.MeshPhysicalMaterial({
        color: '#0ea5e9',
        emissive: '#0369a1',
        emissiveIntensity: 0.25,
        metalness: 0.3,
        roughness: 0.2,
        clearcoat: 0.85,
      });
      const columnGeo = new THREE.CylinderGeometry(0.42, 0.48, 1.0, 12);
      columnGeo.translate(0, 0.5, 0);
      const column = new THREE.Mesh(columnGeo, columnMat);
      column.position.y = 0.28;
      column.castShadow = true;
      column.layers.enable(1);
      column.userData = { digit: d };
      pylonGroup.add(column);
      hitTargets.push(column);

      const badgeTex = createDigitBadgeTexture(d);
      disposableTextures.push(badgeTex);
      const cap = new THREE.Group();
      const capBody = new THREE.Mesh(
        new THREE.BoxGeometry(0.72, 0.72, 0.14),
        [
          new THREE.MeshStandardMaterial({ color: '#1e293b', metalness: 0.8, roughness: 0.3 }),
          new THREE.MeshStandardMaterial({ color: '#1e293b', metalness: 0.8, roughness: 0.3 }),
          new THREE.MeshStandardMaterial({ color: '#1e293b', metalness: 0.8, roughness: 0.3 }),
          new THREE.MeshStandardMaterial({ color: '#1e293b', metalness: 0.8, roughness: 0.3 }),
          new THREE.MeshBasicMaterial({ map: badgeTex }),
          new THREE.MeshBasicMaterial({ map: badgeTex }),
        ],
      );
      capBody.layers.enable(1);
      capBody.userData = { digit: d };
      hitTargets.push(capBody);
      cap.add(capBody);
      cap.position.y = 2.6;
      pylonGroup.add(cap);

      pylonRecords.push({
        digit: d,
        group: pylonGroup,
        column,
        columnMat,
        cap,
        ring,
        ringMat,
        currentScaleY: 1.5,
      });
    }

    // 1,000-Tick Helical Particle Stream (InstancedMesh, zero per-frame allocations)
    const maxInstances = 1000;
    const tickGeo = new THREE.OctahedronGeometry(0.085, 0);
    const tickMat = new THREE.MeshStandardMaterial({
      color: '#ffffff',
      roughness: 0.25,
      metalness: 0.5,
    });
    const instancedStream = new THREE.InstancedMesh(tickGeo, tickMat, maxInstances);
    instancedStream.count = 0;
    scene.add(instancedStream);

    const _dummy = new THREE.Object3D();
    const _color = new THREE.Color();
    const _evenColor = new THREE.Color('#14b8a6');
    const _oddColor = new THREE.Color('#38bdf8');
    const _hotColor = new THREE.Color('#f59e0b');

    // Throttled Raycasting on Layer 1
    const raycaster = new THREE.Raycaster();
    raycaster.layers.set(1);
    const pointerNdc = new THREE.Vector2();
    let pointerDownPos = { x: 0, y: 0 };
    let lastHoverTime = 0;

    const getHitDigit = (clientX: number, clientY: number): number | null => {
      const rect = renderer.domElement.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      pointerNdc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
      pointerNdc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointerNdc, camera);
      const hits = raycaster.intersectObjects(hitTargets, false);
      if (hits.length > 0 && typeof hits[0].object.userData?.digit === 'number') {
        return hits[0].object.userData.digit as number;
      }
      return null;
    };

    const onPointerMove = (e: PointerEvent) => {
      const now = performance.now();
      if (now - lastHoverTime < 50) return;
      lastHoverTime = now;
      const hit = getHitDigit(e.clientX, e.clientY);
      setHoveredDigit(hit);
      renderer.domElement.style.cursor = hit !== null ? 'pointer' : 'grab';
    };

    const onPointerDown = (e: PointerEvent) => {
      pointerDownPos = { x: e.clientX, y: e.clientY };
    };

    const onPointerUp = (e: PointerEvent) => {
      const dist = Math.hypot(e.clientX - pointerDownPos.x, e.clientY - pointerDownPos.y);
      if (dist > 6) return;
      const hit = getHitDigit(e.clientX, e.clientY);
      if (hit !== null) {
        setSelectedDigit(hit);
      }
    };

    renderer.domElement.addEventListener('pointermove', onPointerMove);
    renderer.domElement.addEventListener('pointerdown', onPointerDown);
    renderer.domElement.addEventListener('pointerup', onPointerUp);

    // ResizeObserver keeps viewport locked cleanly inside container
    const ro = new ResizeObserver(() => {
      if (!container) return;
      const w = Math.max(320, container.clientWidth);
      const h = Math.max(240, container.clientHeight);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    });
    ro.observe(container);

    let rafId = 0;
    let prevTime = performance.now();
    let elapsed = 0;

    const animate = () => {
      rafId = requestAnimationFrame(animate);
      const now = performance.now();
      const dt = Math.min(0.05, (now - prevTime) / 1000);
      prevTime = now;
      elapsed += dt;

      const state = liveStateRef.current;

      // Damped Camera Preset Transition
      const camGoal = cameraTargetGoalRef.current;
      if (camGoal.active) {
        camera.position.x = THREE.MathUtils.damp(camera.position.x, camGoal.pos.x, 5, dt);
        camera.position.y = THREE.MathUtils.damp(camera.position.y, camGoal.pos.y, 5, dt);
        camera.position.z = THREE.MathUtils.damp(camera.position.z, camGoal.pos.z, 5, dt);
        controls.target.x = THREE.MathUtils.damp(controls.target.x, camGoal.target.x, 5, dt);
        controls.target.y = THREE.MathUtils.damp(controls.target.y, camGoal.target.y, 5, dt);
        controls.target.z = THREE.MathUtils.damp(controls.target.z, camGoal.target.z, 5, dt);
        if (camera.position.distanceTo(camGoal.pos) < 0.08) {
          camGoal.active = false;
        }
      }
      controls.update();

      // Rotate Quantum Core
      coreCrystal.rotation.y += dt * 0.45;
      coreCrystal.rotation.x = Math.sin(elapsed * 0.7) * 0.25;
      gimbalOuter.rotation.y -= dt * 0.65;
      gimbalOuter.rotation.z = Math.sin(elapsed * 0.5) * 0.35;
      gimbalInner.rotation.x += dt * 0.55;
      coreEmitter.material.emissive.set(state.allGatesPassed ? '#10b981' : '#0ea5e9');

      // Update Digit Pylons smoothly via THREE.MathUtils.damp
      for (const rec of pylonRecords) {
        const stat = state.digitStats1000.find((s) => s.digit === rec.digit);
        const pct = stat?.pct ?? 10;
        const targetH = Math.max(0.8, Math.min(5.2, 0.6 + (pct / 15) * 3.6));
        rec.currentScaleY = THREE.MathUtils.damp(rec.currentScaleY, targetH, 7, dt);
        rec.column.scale.y = rec.currentScaleY;
        rec.cap.position.y = 0.28 + rec.currentScaleY + 0.55;
        rec.cap.rotation.y = Math.sin(elapsed * 0.6 + rec.digit) * 0.12;

        const isTarget = rec.digit === state.targetDigit;
        const isLive = rec.digit === state.latestDigit;
        const isSelected = rec.digit === state.selectedDigit;

        if (isTarget) {
          rec.columnMat.color.set('#14b8a6');
          rec.columnMat.emissive.set('#0f766e');
          rec.columnMat.emissiveIntensity = state.allGatesPassed ? 0.9 : 0.45;
        } else if (stat?.isHot) {
          rec.columnMat.color.set('#f43f5e');
          rec.columnMat.emissive.set('#be123c');
          rec.columnMat.emissiveIntensity = 0.35;
        } else {
          rec.columnMat.color.set('#38bdf8');
          rec.columnMat.emissive.set('#0369a1');
          rec.columnMat.emissiveIntensity = 0.25;
        }

        if (isLive) {
          rec.ringMat.color.set('#f59e0b');
          rec.ringMat.emissive.set('#d97706');
          rec.ringMat.emissiveIntensity = 1.4;
        } else if (isSelected) {
          rec.ringMat.color.set('#f8fafc');
          rec.ringMat.emissive.set('#38bdf8');
          rec.ringMat.emissiveIntensity = 0.95;
        } else {
          rec.ringMat.color.set('#334155');
          rec.ringMat.emissive.set('#0284c7');
          rec.ringMat.emissiveIntensity = 0.2;
        }
      }

      // Update 1,000-Tick Helical InstancedMesh
      const streamCount = Math.min(maxInstances, state.ticks1000.length);
      instancedStream.count = streamCount;
      for (let i = 0; i < streamCount; i++) {
        const pt = state.ticks1000[i];
        const ratio = i / Math.max(1, streamCount);
        const theta = ratio * Math.PI * 14 + elapsed * 0.22;
        const r = 2.6 + Math.sin(ratio * Math.PI * 3) * 0.45 + (pt.lastDigit / 10) * 0.65;
        const y = 0.65 + ratio * 5.2;
        _dummy.position.set(Math.cos(theta) * r, y, Math.sin(theta) * r);
        const scale = i === streamCount - 1 ? 1.85 : 0.85;
        _dummy.scale.set(scale, scale, scale);
        _dummy.rotation.y = theta;
        _dummy.updateMatrix();
        instancedStream.setMatrixAt(i, _dummy.matrix);

        if (pt.lastDigit === state.targetDigit) {
          _color.copy(_hotColor);
        } else if (pt.lastDigit % 2 === 0) {
          _color.copy(_evenColor);
        } else {
          _color.copy(_oddColor);
        }
        instancedStream.setColorAt(i, _color);
      }
      instancedStream.instanceMatrix.needsUpdate = true;
      if (instancedStream.instanceColor) instancedStream.instanceColor.needsUpdate = true;

      renderer.render(scene, camera);
    };

    rafId = requestAnimationFrame(animate);

    return () => {
      cancelAnimationFrame(rafId);
      ro.disconnect();
      controls.removeEventListener('start', cancelGoalOnUserInput);
      renderer.domElement.removeEventListener('pointermove', onPointerMove);
      renderer.domElement.removeEventListener('pointerdown', onPointerDown);
      renderer.domElement.removeEventListener('pointerup', onPointerUp);
      controls.dispose();
      pmrem.dispose();
      envTex.dispose();
      for (const tex of disposableTextures) tex.dispose();
      scene.traverse((obj) => {
        if ((obj as THREE.Mesh).isMesh) {
          const m = obj as THREE.Mesh;
          m.geometry.dispose();
          if (Array.isArray(m.material)) m.material.forEach((mat) => mat.dispose());
          else m.material.dispose();
        }
      });
      renderer.dispose();
      if (renderer.domElement.parentNode === container) {
        container.removeChild(renderer.domElement);
      }
    };
  }, []);

  const handleSelectPreset = (preset: CameraPresetId) => {
    setActivePreset(preset);
    const p = CAMERA_PRESETS[preset];
    cameraTargetGoalRef.current = {
      active: true,
      pos: new THREE.Vector3(...p.pos),
      target: new THREE.Vector3(...p.target),
    };
  };

  const inspectedStat =
    digitStats1000.find((s) => s.digit === (hoveredDigit ?? selectedDigit)) ??
    digitStats1000[selectedDigit];
  const inspectedMarkovSurv =
    markov.differSurvivalPctByDigit[hoveredDigit ?? selectedDigit] ?? 90;

  return (
    <div className="relative flex-1 w-full h-full overflow-hidden bg-[#070B14] select-none">
      {/* Full-bleed WebGL Canvas Mount */}
      <div ref={mountRef} className="w-full h-full" />

      {/* Top-Left Telemetry HUD (Solid crisp surface, NO backdrop-filter over WebGL) */}
      <div className="absolute top-3 left-3 z-10 w-[290px] rounded-lg bg-[#0F172A]/95 border border-slate-700/90 p-3.5 text-slate-100 shadow-lg space-y-2.5">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h1 className="font-display font-bold text-sm text-white tracking-tight">
              3D Quant Probability Arena
            </h1>
            <p className="text-[11px] text-slate-400">
              {ticks.length}t helix · 10×10 Markov digit pylons
            </p>
          </div>
          <span
            className={`px-2 py-0.5 rounded font-mono text-[10px] font-bold ${
              perfectSetup.allGatesPassed
                ? 'bg-teal-600 text-white'
                : 'bg-slate-800 text-slate-300 border border-slate-700'
            }`}
          >
            {perfectSetup.allGatesPassed ? '7/7 ARMED' : 'SCANNING'}
          </span>
        </div>

        <div className="grid grid-cols-2 gap-2 font-mono text-[11px] tabular-nums">
          <div className="rounded bg-slate-900 border border-slate-800 px-2.5 py-1.5">
            <div className="text-[10px] text-slate-400 font-sans">Master Target</div>
            <div className="font-bold text-teal-400">
              {perfectSetup.contractType} [{perfectSetup.barrier}]
            </div>
          </div>
          <div className="rounded bg-slate-900 border border-slate-800 px-2.5 py-1.5">
            <div className="text-[10px] text-slate-400 font-sans">Markov / EV</div>
            <div className="font-bold text-sky-400">
              {perfectSetup.markovSurvivalPct}% · {perfectSetup.expectedValuePct >= 0 ? '+' : ''}
              {perfectSetup.expectedValuePct}%
            </div>
          </div>
        </div>

        <div className="rounded bg-slate-900/90 border border-slate-800 px-2.5 py-2 flex items-center justify-between text-xs font-mono tabular-nums">
          <div>
            <span className="text-slate-400 text-[10px] font-sans block">
              {hoveredDigit !== null ? `Hovering Digit ${hoveredDigit}` : `Selected Digit ${selectedDigit}`}
            </span>
            <span className="font-bold text-white">
              Freq {inspectedStat?.pct ?? 10}% ({inspectedStat?.count ?? 0}t)
            </span>
          </div>
          <div className="text-right">
            <span className="text-slate-400 text-[10px] font-sans block">Markov Differ Surv</span>
            <span className="font-bold text-teal-400">{inspectedMarkovSurv.toFixed(1)}%</span>
          </div>
        </div>
      </div>

      {/* Top-Right Market & Stake Control */}
      <div className="absolute top-3 right-3 z-10 flex items-center gap-2 rounded-lg bg-[#0F172A]/95 border border-slate-700/90 px-3 py-2 text-xs text-slate-100 shadow-lg">
        <MarketSelector
          markets={markets}
          value={activeSymbol}
          onChange={onSelectMarket}
          digitsOnly
          className="rounded border border-slate-700 bg-slate-900 px-2.5 py-1 text-xs font-semibold text-slate-100"
        />
        <div className="font-mono font-bold tabular-nums text-sky-400 px-1.5">
          {latestTick ? latestTick.formattedQuote : '—'}
        </div>
      </div>

      {/* Collapsible Bottom-Center Camera & Trade Dock (Solid dark surface, no backdrop-filter) */}
      <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10 max-w-[94vw] rounded-lg bg-[#0F172A]/95 border border-slate-700/90 text-slate-100 shadow-xl">
        <div className="flex items-center justify-between gap-4 px-3.5 py-1.5 border-b border-slate-800">
          <div className="flex items-center gap-2 text-[11px] font-semibold text-slate-300">
            <Compass className="w-3.5 h-3.5 text-sky-400" />
            <span>3D Camera &amp; Direct Execution Dock</span>
          </div>
          <button
            type="button"
            onClick={() => setDockCollapsed((c) => !c)}
            className="text-slate-400 hover:text-white cursor-pointer p-0.5"
            aria-label={dockCollapsed ? 'Expand 3D dock' : 'Collapse 3D dock'}
          >
            {dockCollapsed ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </button>
        </div>

        {!dockCollapsed && (
          <div className="px-3.5 py-2.5 flex flex-wrap items-center gap-3 text-xs">
            <div className="flex items-center gap-1 bg-slate-900 p-1 rounded border border-slate-800">
              {(Object.keys(CAMERA_PRESETS) as CameraPresetId[]).map((id) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => handleSelectPreset(id)}
                  className={`px-2.5 py-1 rounded text-[11px] font-semibold cursor-pointer whitespace-nowrap ${
                    activePreset === id
                      ? 'bg-[#0E5A78] text-white'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  {CAMERA_PRESETS[id].label}
                </button>
              ))}
            </div>

            <div className="flex items-center gap-1.5 font-mono tabular-nums">
              <span className="text-[11px] text-slate-400 font-sans">Stake ({currency}):</span>
              <input
                type="number"
                min={0.35}
                step={0.5}
                value={stake}
                onChange={(e) => setStake(Math.max(0.35, Number(e.target.value) || 5))}
                className="w-16 rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs font-bold text-white"
              />
            </div>

            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => {
                  if (!authenticated) {
                    onRequireLogin?.();
                    return;
                  }
                  onPlaceTrade({
                    symbol: activeSymbol,
                    contractType: 'DIGITDIFF',
                    barrier: selectedDigit,
                    stake,
                    durationTicks: 1,
                    durationUnit: 't',
                    source: 'manual',
                  });
                }}
                className="inline-flex items-center gap-1 px-3 py-1.5 rounded bg-[#389E94] hover:bg-[#2F877E] text-white font-bold text-[11px] cursor-pointer whitespace-nowrap"
              >
                <Zap className="w-3.5 h-3.5" />
                <span>Differs [{selectedDigit}]</span>
              </button>

              {perfectSetup.allGatesPassed && (
                <button
                  type="button"
                  onClick={() => {
                    if (!authenticated) {
                      onRequireLogin?.();
                      return;
                    }
                    onPlaceTrade({
                      symbol: activeSymbol,
                      contractType: perfectSetup.contractType,
                      barrier: perfectSetup.barrier,
                      stake,
                      durationTicks: 1,
                      durationUnit: 't',
                      source: 'scanner',
                    });
                  }}
                  className="inline-flex items-center gap-1 px-3 py-1.5 rounded bg-teal-600 hover:bg-teal-700 text-white font-bold text-[11px] cursor-pointer whitespace-nowrap"
                >
                  <ShieldCheck className="w-3.5 h-3.5" />
                  <Play className="w-3 h-3 fill-current" />
                  <span>Fire Master Setup [{perfectSetup.barrier}]</span>
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
