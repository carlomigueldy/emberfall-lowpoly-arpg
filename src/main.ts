import './style.css';
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

const TAU = Math.PI * 2;
const IS_SMOKE = new URLSearchParams(window.location.search).has('smoke');

type Ability = 'attack' | 'nova' | 'dash' | 'potion';
type EnemyKind = 'emberImp' | 'ashHound' | 'obsidianBrute' | 'cinderMatriarch';
type LootKind = 'gold' | 'potion' | 'relic';

type CollisionShape =
  | { kind: 'circle'; x: number; z: number; r: number }
  | { kind: 'rect'; x: number; z: number; w: number; d: number };

interface PlayerState {
  group: THREE.Group;
  sword: THREE.Group;
  ring: THREE.Mesh;
  position: THREE.Vector3;
  direction: THREE.Vector3;
  radius: number;
  hp: number;
  maxHp: number;
  mana: number;
  maxMana: number;
  xp: number;
  level: number;
  gold: number;
  potions: number;
  cooldowns: Record<Ability, number>;
  maxCooldowns: Record<Ability, number>;
  clickTarget: THREE.Vector3 | null;
  dashTimer: number;
  invulnerableTimer: number;
  attackAnim: number;
}

interface EnemyState {
  id: number;
  kind: EnemyKind;
  group: THREE.Group;
  body: THREE.Object3D;
  position: THREE.Vector3;
  spawn: THREE.Vector3;
  radius: number;
  hp: number;
  maxHp: number;
  speed: number;
  damage: number;
  xp: number;
  gold: number;
  attackTimer: number;
  specialTimer: number;
  stunTimer: number;
  dead: boolean;
  healthGroup: THREE.Group;
  healthFill: THREE.Mesh;
}

interface LootState {
  id: number;
  kind: LootKind;
  value: number;
  group: THREE.Group;
  position: THREE.Vector3;
  radius: number;
  bobSeed: number;
}

interface EffectEntry {
  object: THREE.Object3D;
  life: number;
  maxLife: number;
  velocity: THREE.Vector3;
  grow: number;
  spin: number;
  gravity: number;
  material?: THREE.Material & { opacity: number };
}

interface DebugState {
  hp: number;
  mana: number;
  level: number;
  xp: number;
  gold: number;
  potions: number;
  player: { x: number; z: number };
  enemiesAlive: number;
  bossHp: number;
  lootCount: number;
  objective: string;
  errors: string[];
}

declare global {
  interface Window {
    __EMBERFALL__?: {
      hold: (code: string, down: boolean) => void;
      step: (code?: string, frames?: number, dt?: number) => DebugState;
      cast: (ability: Ability) => DebugState;
      teleport: (x: number, z: number) => DebugState;
      state: () => DebugState;
      errors: string[];
    };
  }
}

function mustGet<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing required DOM node #${id}`);
  return node as T;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function rand(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function distance2D(a: THREE.Vector3, b: THREE.Vector3): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

function setShadow(object: THREE.Object3D, cast = true, receive = false): void {
  object.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      child.castShadow = cast;
      child.receiveShadow = receive;
    }
  });
}

function makeCanvasTexture(seed: number, base: string, fleck: string): THREE.CanvasTexture {
  const rng = rand(seed);
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D is unavailable.');
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  for (let i = 0; i < 680; i += 1) {
    const alpha = 0.035 + rng() * 0.13;
    ctx.fillStyle = fleck.replace('ALPHA', alpha.toFixed(3));
    ctx.fillRect(rng() * 256, rng() * 256, 1 + rng() * 4, 1 + rng() * 4);
  }
  for (let i = 0; i < 24; i += 1) {
    ctx.strokeStyle = `rgba(255, 185, 85, ${0.025 + rng() * 0.05})`;
    ctx.beginPath();
    ctx.moveTo(rng() * 256, rng() * 256);
    ctx.lineTo(rng() * 256, rng() * 256);
    ctx.stroke();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.repeat.set(18, 18);
  return texture;
}

class EmberfallGame {
  private readonly canvas = mustGet<HTMLCanvasElement>('game-canvas');
  private readonly minimap = mustGet<HTMLCanvasElement>('minimap');
  private readonly healthFill = mustGet<HTMLElement>('health-fill');
  private readonly healthLabel = mustGet<HTMLElement>('health-label');
  private readonly manaFill = mustGet<HTMLElement>('mana-fill');
  private readonly manaLabel = mustGet<HTMLElement>('mana-label');
  private readonly xpFill = mustGet<HTMLElement>('xp-fill');
  private readonly xpLabel = mustGet<HTMLElement>('xp-label');
  private readonly goldLabel = mustGet<HTMLElement>('gold-label');
  private readonly objectiveLabel = mustGet<HTMLElement>('objective-label');
  private readonly questCopy = mustGet<HTMLElement>('quest-copy');
  private readonly combatLog = mustGet<HTMLElement>('combat-log');
  private readonly centerToast = mustGet<HTMLElement>('center-toast');
  private readonly bossFrame = mustGet<HTMLElement>('boss-frame');
  private readonly bossFill = mustGet<HTMLElement>('boss-fill');
  private readonly potionLabel = mustGet<HTMLElement>('potion-label');
  private readonly joystick = mustGet<HTMLElement>('joystick');
  private readonly joystickKnob = this.joystick.querySelector('span') as HTMLElement;

  private readonly renderer: THREE.WebGLRenderer;
  private readonly composer: EffectComposer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(42, window.innerWidth / window.innerHeight, 0.1, 170);
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private readonly clock = new THREE.Clock();
  private readonly keys = new Set<string>();
  private readonly world = new THREE.Group();
  private readonly actors = new THREE.Group();
  private readonly effectsGroup = new THREE.Group();
  private readonly obstacles: CollisionShape[] = [];
  private readonly enemies: EnemyState[] = [];
  private readonly loot: LootState[] = [];
  private readonly effects: EffectEntry[] = [];
  private readonly errorLog: string[] = [];
  private readonly rng = rand(20260708);
  private readonly materials: Record<string, THREE.Material>;
  private readonly tmp = new THREE.Vector3();
  private readonly tmp2 = new THREE.Vector3();
  private readonly bounds = { minX: -25.5, maxX: 25.5, minZ: -31.5, maxZ: 18.5 };
  private player!: PlayerState;
  private enemyId = 1;
  private lootId = 1;
  private lastUiUpdate = 0;
  private elapsed = 0;
  private objective = 'Purge the ember crypt';
  private gameWon = false;
  private joystickVector = new THREE.Vector2(0, 0);
  private joystickPointerId: number | null = null;

  constructor() {
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.32;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.materials = this.createMaterials();
    this.scene.background = new THREE.Color(0x10070a);
    this.scene.fog = new THREE.FogExp2(0x1c0d10, 0.026);
    this.scene.add(this.world, this.actors, this.effectsGroup);

    this.buildLighting();
    this.buildWorld();
    this.player = this.createPlayer();
    this.actors.add(this.player.group);
    this.spawnEncounter();
    this.composer = this.createComposer();
    this.setupInput();
    this.setupDebugApi();
    this.onResize();

    this.log('The ember crypt opens. Claim relic gold and hunt the Ashen Crown.');
    window.addEventListener('resize', () => this.onResize());
    window.addEventListener('error', (event: ErrorEvent) => this.errorLog.push(event.message));
    window.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => this.errorLog.push(String(event.reason)));

    if (IS_SMOKE) this.centerToast.classList.remove('show');
    else window.setTimeout(() => this.centerToast.classList.remove('show'), 5200);

    this.animate();
  }

  private createMaterials(): Record<string, THREE.Material> {
    const floorTexture = makeCanvasTexture(12, '#3b211d', 'rgba(255, 207, 135, ALPHA)');
    const wallTexture = makeCanvasTexture(23, '#2a1718', 'rgba(255, 136, 59, ALPHA)');
    const mat = (color: number, roughness = 0.82, metalness = 0.02, emissive = 0x000000, emissiveIntensity = 0): THREE.MeshStandardMaterial =>
      new THREE.MeshStandardMaterial({ color, roughness, metalness, emissive, emissiveIntensity, flatShading: true });

    return {
      floor: new THREE.MeshStandardMaterial({ color: 0x5a3429, roughness: 0.95, metalness: 0.0, flatShading: true, map: floorTexture }),
      floorDark: mat(0x2b181a),
      floorEdge: mat(0x6e3a2b),
      wall: new THREE.MeshStandardMaterial({ color: 0x302026, roughness: 0.86, metalness: 0.04, flatShading: true, map: wallTexture }),
      wallTop: mat(0x7d4230),
      obsidian: mat(0x181219, 0.58, 0.18),
      ember: mat(0xff7624, 0.45, 0.0, 0xff4a13, 1.7),
      hot: mat(0xffcf68, 0.42, 0.0, 0xff8a28, 2.4),
      gold: mat(0xffbf45, 0.38, 0.55, 0xff8218, 0.18),
      blood: mat(0x8e1622, 0.62, 0.04, 0x260006, 0.08),
      playerArmor: mat(0x263142, 0.66, 0.22),
      playerCloak: mat(0x9c2734, 0.76, 0.02),
      playerSkin: mat(0xf1b77d, 0.8, 0.0),
      steel: mat(0xc8d1d4, 0.35, 0.7),
      imp: mat(0xd95530, 0.78, 0.02, 0x4c0800, 0.18),
      hound: mat(0x4e2930, 0.84, 0.03, 0x160008, 0.08),
      brute: mat(0x24202b, 0.58, 0.18, 0x2b0610, 0.15),
      boss: mat(0x56131d, 0.46, 0.18, 0x3a0007, 0.25),
      toxic: mat(0x7df45c, 0.55, 0.02, 0x49ff2f, 1.3),
      transparentGold: new THREE.MeshBasicMaterial({ color: 0xffb54b, transparent: true, opacity: 0.45, blending: THREE.AdditiveBlending, depthWrite: false }),
      transparentRed: new THREE.MeshBasicMaterial({ color: 0xff4535, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false }),
      transparentBlue: new THREE.MeshBasicMaterial({ color: 0x74d8ff, transparent: true, opacity: 0.48, blending: THREE.AdditiveBlending, depthWrite: false }),
      shadow: new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.28, depthWrite: false }),
    };
  }

  private createComposer(): EffectComposer {
    const composer = new EffectComposer(this.renderer);
    composer.addPass(new RenderPass(this.scene, this.camera));
    const bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.52, 0.48, 0.62);
    composer.addPass(bloom);
    composer.addPass(new OutputPass());
    return composer;
  }

  private buildLighting(): void {
    const hemi = new THREE.HemisphereLight(0xffd6a3, 0x1e0c10, 2.55);
    this.scene.add(hemi);

    const moon = new THREE.DirectionalLight(0xffe2b8, 2.85);
    moon.position.set(-13, 28, 13);
    moon.target.position.set(0, 0, -5);
    moon.castShadow = true;
    moon.shadow.mapSize.set(2048, 2048);
    moon.shadow.camera.left = -38;
    moon.shadow.camera.right = 38;
    moon.shadow.camera.top = 36;
    moon.shadow.camera.bottom = -36;
    moon.shadow.camera.near = 0.5;
    moon.shadow.camera.far = 80;
    moon.shadow.bias = -0.00012;
    moon.shadow.normalBias = 0.035;
    this.scene.add(moon, moon.target);

    const rim = new THREE.DirectionalLight(0xb55cff, 0.55);
    rim.position.set(13, 20, -25);
    this.scene.add(rim);
  }

  private buildWorld(): void {
    this.buildFloor();
    this.buildBoundaryWalls();
    this.buildSetPieces();
    this.buildTorches();
    this.buildLavaFissures();
  }

  private buildFloor(): void {
    const tileGeo = new THREE.BoxGeometry(2.08, 0.24, 2.08);
    const edgeGeo = new THREE.BoxGeometry(2.08, 0.32, 2.08);
    for (let x = -12; x <= 12; x += 1) {
      for (let z = -15; z <= 9; z += 1) {
        const isEdge = x === -12 || x === 12 || z === -15 || z === 9;
        const mesh = new THREE.Mesh(isEdge ? edgeGeo : tileGeo, isEdge ? this.materials.floorEdge : this.materials.floor);
        mesh.position.set(x * 2 + (this.rng() - 0.5) * 0.08, -0.14 + this.rng() * 0.04, z * 2 + (this.rng() - 0.5) * 0.08);
        mesh.rotation.y = Math.floor(this.rng() * 4) * Math.PI * 0.5;
        mesh.scale.y = 0.8 + this.rng() * 0.35;
        mesh.receiveShadow = true;
        this.world.add(mesh);
      }
    }

    const dais = new THREE.Mesh(new THREE.CylinderGeometry(7.5, 8.5, 0.7, 8), this.materials.floorEdge);
    dais.position.set(0, 0.12, -24);
    dais.rotation.y = Math.PI / 8;
    dais.receiveShadow = true;
    this.world.add(dais);

    const stairMat = this.materials.wallTop;
    for (let i = 0; i < 7; i += 1) {
      const step = new THREE.Mesh(new THREE.BoxGeometry(15 - i * 1.3, 0.22, 1.0), stairMat);
      step.position.set(0, 0.02 + i * 0.05, -16.8 - i * 0.82);
      step.receiveShadow = true;
      this.world.add(step);
    }
  }

  private buildBoundaryWalls(): void {
    const wallGeo = new THREE.BoxGeometry(2, 2.7, 2);
    const wallTopGeo = new THREE.CylinderGeometry(0.8, 1.05, 0.75, 5);
    const wallPositions: Array<[number, number]> = [];
    for (let x = -13; x <= 13; x += 1) {
      wallPositions.push([x * 2, 20], [x * 2, -32]);
    }
    for (let z = -15; z <= 9; z += 1) {
      wallPositions.push([-27, z * 2], [27, z * 2]);
    }
    wallPositions.forEach(([x, z], index) => {
      const wall = new THREE.Group();
      const base = new THREE.Mesh(wallGeo, this.materials.wall);
      base.position.y = 1.1 + this.rng() * 0.34;
      base.scale.set(0.92 + this.rng() * 0.2, 0.88 + this.rng() * 0.5, 0.92 + this.rng() * 0.2);
      base.rotation.y = this.rng() * 0.5;
      wall.add(base);
      if (index % 3 !== 0) {
        const cap = new THREE.Mesh(wallTopGeo, this.materials.wallTop);
        cap.position.y = 2.55 + this.rng() * 0.36;
        cap.rotation.y = this.rng() * TAU;
        wall.add(cap);
      }
      wall.position.set(x, 0, z);
      setShadow(wall, true, true);
      this.world.add(wall);
    });
  }

  private buildSetPieces(): void {
    const columns: Array<[number, number, number]> = [
      [-15, -9, 1.35], [15, -9, 1.35], [-15, 7, 1.15], [15, 7, 1.15], [-6, -4, 1.0], [7.5, 1.5, 1.0], [-8, 12, 0.95], [9, -15, 0.95], [-5.5, -22.5, 1.05], [5.5, -22.5, 1.05],
    ];
    columns.forEach(([x, z, r], i) => {
      const column = new THREE.Group();
      const base = new THREE.Mesh(new THREE.CylinderGeometry(r * 1.05, r * 1.15, 0.55, 6), this.materials.wallTop);
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.58, r * 0.74, 3.1 + (i % 2) * 0.7, 6), this.materials.wall);
      const crown = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.92, r * 0.7, 0.55, 6), this.materials.wallTop);
      shaft.position.y = 1.85;
      crown.position.y = 3.55 + (i % 2) * 0.55;
      column.add(base, shaft, crown);
      column.position.set(x, 0, z);
      column.rotation.y = this.rng() * TAU;
      setShadow(column, true, true);
      this.world.add(column);
      this.obstacles.push({ kind: 'circle', x, z, r: r + 0.35 });
    });

    const rubbleSpots: Array<[number, number]> = [[-18, 2], [19, -3], [-17, -18], [13, -25], [3, 9], [-1, -11], [20, 13]];
    rubbleSpots.forEach(([x, z], spotIndex) => {
      const count = 6 + Math.floor(this.rng() * 6);
      for (let i = 0; i < count; i += 1) {
        const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(0.22 + this.rng() * 0.5, 0), this.rng() > 0.2 ? this.materials.obsidian : this.materials.wallTop);
        rock.position.set(x + (this.rng() - 0.5) * 2.8, 0.1 + this.rng() * 0.22, z + (this.rng() - 0.5) * 2.8);
        rock.scale.y = 0.55 + this.rng();
        rock.rotation.set(this.rng() * TAU, this.rng() * TAU, this.rng() * TAU);
        setShadow(rock, true, true);
        this.world.add(rock);
      }
      if (spotIndex < 5) this.obstacles.push({ kind: 'circle', x, z, r: 1.2 });
    });

    const gate = new THREE.Group();
    for (let i = -3; i <= 3; i += 1) {
      const spike = new THREE.Mesh(new THREE.ConeGeometry(0.24, 2.4, 4), this.materials.obsidian);
      spike.position.set(i * 0.8, 1.3, 0);
      spike.rotation.y = Math.PI / 4;
      gate.add(spike);
    }
    const lintel = new THREE.Mesh(new THREE.BoxGeometry(7, 0.55, 0.55), this.materials.wallTop);
    lintel.position.y = 2.75;
    gate.add(lintel);
    gate.position.set(0, 0, -17.8);
    setShadow(gate, true, true);
    this.world.add(gate);
  }

  private buildTorches(): void {
    const torchPositions: Array<[number, number]> = [
      [-22, 15], [22, 15], [-22, -14], [22, -14], [-11, -25], [11, -25], [-4, -17], [4, -17], [-18, -5], [18, 6],
    ];
    torchPositions.forEach(([x, z], index) => {
      const torch = new THREE.Group();
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.22, 1.8, 5), this.materials.obsidian);
      post.position.y = 0.9;
      const bowl = new THREE.Mesh(new THREE.CylinderGeometry(0.46, 0.32, 0.26, 6), this.materials.wallTop);
      bowl.position.y = 1.85;
      const flame = new THREE.Mesh(new THREE.ConeGeometry(0.34, 0.86, 6), index % 2 ? this.materials.hot : this.materials.ember);
      flame.name = 'animated-flame';
      flame.position.y = 2.28;
      torch.add(post, bowl, flame);
      torch.position.set(x, 0, z);
      setShadow(torch, true, true);
      this.world.add(torch);
      const light = new THREE.PointLight(0xff842b, 2.1, 11, 2.1);
      light.position.set(x, 2.35, z);
      this.scene.add(light);
    });
  }

  private buildLavaFissures(): void {
    const fissures: Array<[number, number, number, number]> = [
      [-10, -13, 8, -0.2], [8, -7, 7.5, 0.48], [-15, 11, 5.5, 0.2], [13, -21, 6, -0.42], [0, -26, 7, 0.0],
    ];
    fissures.forEach(([x, z, length, angle]) => {
      const glow = new THREE.Mesh(new THREE.BoxGeometry(length, 0.04, 0.28), this.materials.ember);
      glow.position.set(x, 0.025, z);
      glow.rotation.y = angle;
      this.world.add(glow);
      const core = new THREE.Mesh(new THREE.BoxGeometry(length * 0.78, 0.05, 0.08), this.materials.hot);
      core.position.set(x, 0.05, z);
      core.rotation.y = angle;
      this.world.add(core);
    });
  }

  private createPlayer(): PlayerState {
    const group = new THREE.Group();
    const shadow = new THREE.Mesh(new THREE.CircleGeometry(0.82, 18), this.materials.shadow);
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.025;
    group.add(shadow);

    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.86, 0.035, 6, 36), this.materials.transparentBlue);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.07;
    group.add(ring);

    const hips = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.5, 0.58, 6), this.materials.playerArmor);
    hips.position.y = 0.62;
    const torso = new THREE.Mesh(new THREE.CylinderGeometry(0.38, 0.58, 0.92, 6), this.materials.playerArmor);
    torso.position.y = 1.23;
    const chest = new THREE.Mesh(new THREE.BoxGeometry(0.85, 0.52, 0.36), this.materials.steel);
    chest.position.set(0, 1.28, -0.08);
    const cloak = new THREE.Mesh(new THREE.ConeGeometry(0.66, 1.35, 5, 1, true), this.materials.playerCloak);
    cloak.position.set(0, 0.92, 0.34);
    cloak.rotation.x = -0.2;
    const head = new THREE.Mesh(new THREE.DodecahedronGeometry(0.34, 0), this.materials.playerSkin);
    head.position.y = 1.9;
    const helm = new THREE.Mesh(new THREE.ConeGeometry(0.38, 0.45, 5), this.materials.steel);
    helm.position.y = 2.18;
    const leftShoulder = new THREE.Mesh(new THREE.DodecahedronGeometry(0.23, 0), this.materials.steel);
    leftShoulder.position.set(-0.54, 1.42, 0);
    leftShoulder.scale.set(1.25, 0.74, 0.85);
    const rightShoulder = leftShoulder.clone();
    rightShoulder.position.x = 0.54;
    group.add(hips, torso, chest, cloak, head, helm, leftShoulder, rightShoulder);

    const sword = new THREE.Group();
    const blade = new THREE.Mesh(new THREE.BoxGeometry(0.13, 1.28, 0.13), this.materials.steel);
    blade.position.y = 0.58;
    const guard = new THREE.Mesh(new THREE.BoxGeometry(0.58, 0.11, 0.13), this.materials.gold);
    guard.position.y = -0.06;
    const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.065, 0.065, 0.42, 6), this.materials.obsidian);
    grip.position.y = -0.28;
    sword.add(blade, guard, grip);
    sword.position.set(0.66, 1.18, -0.2);
    sword.rotation.set(0.15, 0.18, -0.65);
    group.add(sword);

    group.position.set(0, 0, 12);
    group.rotation.y = Math.PI;
    setShadow(group, true, false);

    return {
      group,
      sword,
      ring,
      position: group.position,
      direction: new THREE.Vector3(0, 0, -1),
      radius: 0.55,
      hp: 130,
      maxHp: 130,
      mana: 78,
      maxMana: 78,
      xp: 0,
      level: 1,
      gold: 0,
      potions: 3,
      cooldowns: { attack: 0, nova: 0, dash: 0, potion: 0 },
      maxCooldowns: { attack: 0.42, nova: 5.4, dash: 4.2, potion: 1.0 },
      clickTarget: null,
      dashTimer: 0,
      invulnerableTimer: 0,
      attackAnim: 0,
    };
  }

  private spawnEncounter(): void {
    const spawns: Array<[EnemyKind, number, number]> = [
      ['emberImp', -8, 7], ['emberImp', 8, 7], ['ashHound', -14, 3], ['ashHound', 14, -2],
      ['obsidianBrute', -6, -7], ['emberImp', 0, -8], ['emberImp', 8, -10], ['ashHound', -13, -13],
      ['obsidianBrute', 13, -16], ['emberImp', -18, -20], ['ashHound', 17, -23], ['cinderMatriarch', 0, -25.2],
    ];
    spawns.forEach(([kind, x, z]) => this.spawnEnemy(kind, x, z));
    this.spawnLoot('relic', 1, -19, 14);
    this.spawnLoot('gold', 18, 18, 13);
    this.spawnLoot('gold', 14, -18, -11);
  }

  private spawnEnemy(kind: EnemyKind, x: number, z: number): void {
    const group = new THREE.Group();
    const config = this.enemyConfig(kind);
    const shadow = new THREE.Mesh(new THREE.CircleGeometry(config.radius * 1.14, 16), this.materials.shadow);
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.035;
    group.add(shadow);
    const body = this.createEnemyModel(kind);
    group.add(body);
    const healthGroup = this.createHealthBar(config.radius * 2.2, kind === 'cinderMatriarch' ? 3.7 : 2.45);
    group.add(healthGroup);
    group.position.set(x, 0, z);
    setShadow(group, true, false);
    this.actors.add(group);

    this.enemies.push({
      id: this.enemyId,
      kind,
      group,
      body,
      position: group.position,
      spawn: new THREE.Vector3(x, 0, z),
      radius: config.radius,
      hp: config.hp,
      maxHp: config.hp,
      speed: config.speed,
      damage: config.damage,
      xp: config.xp,
      gold: config.gold,
      attackTimer: 0.6 + this.rng() * 1.2,
      specialTimer: kind === 'cinderMatriarch' ? 2.4 : 0,
      stunTimer: 0,
      dead: false,
      healthGroup,
      healthFill: healthGroup.children[1] as THREE.Mesh,
    });
    this.enemyId += 1;
  }

  private enemyConfig(kind: EnemyKind): { hp: number; speed: number; damage: number; radius: number; xp: number; gold: number } {
    switch (kind) {
      case 'emberImp': return { hp: 34, speed: 2.05, damage: 8, radius: 0.46, xp: 14, gold: 6 };
      case 'ashHound': return { hp: 42, speed: 2.85, damage: 10, radius: 0.58, xp: 18, gold: 8 };
      case 'obsidianBrute': return { hp: 86, speed: 1.35, damage: 18, radius: 0.78, xp: 34, gold: 18 };
      case 'cinderMatriarch': return { hp: 310, speed: 1.12, damage: 22, radius: 1.45, xp: 140, gold: 75 };
    }
  }

  private createEnemyModel(kind: EnemyKind): THREE.Group {
    const group = new THREE.Group();
    if (kind === 'emberImp') {
      const torso = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.48, 0.9, 5), this.materials.imp);
      torso.position.y = 0.78;
      const head = new THREE.Mesh(new THREE.DodecahedronGeometry(0.35, 0), this.materials.imp);
      head.position.y = 1.44;
      const hornA = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.42, 4), this.materials.hot);
      hornA.position.set(-0.22, 1.78, 0.03);
      hornA.rotation.z = 0.35;
      const hornB = hornA.clone();
      hornB.position.x = 0.22;
      hornB.rotation.z = -0.35;
      group.add(torso, head, hornA, hornB);
    } else if (kind === 'ashHound') {
      const body = new THREE.Mesh(new THREE.BoxGeometry(1.05, 0.54, 0.52), this.materials.hound);
      body.position.y = 0.62;
      const head = new THREE.Mesh(new THREE.DodecahedronGeometry(0.32, 0), this.materials.hound);
      head.position.set(0, 0.72, -0.58);
      const spine = new THREE.Mesh(new THREE.ConeGeometry(0.18, 0.7, 4), this.materials.ember);
      spine.position.set(0, 1.02, 0.05);
      spine.rotation.x = Math.PI;
      for (let i = 0; i < 4; i += 1) {
        const leg = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.55, 0.16), this.materials.obsidian);
        leg.position.set(i < 2 ? -0.35 : 0.35, 0.28, i % 2 ? -0.24 : 0.26);
        group.add(leg);
      }
      group.add(body, head, spine);
    } else if (kind === 'obsidianBrute') {
      const torso = new THREE.Mesh(new THREE.CylinderGeometry(0.58, 0.76, 1.45, 6), this.materials.brute);
      torso.position.y = 1.0;
      const core = new THREE.Mesh(new THREE.DodecahedronGeometry(0.28, 0), this.materials.ember);
      core.position.set(0, 1.18, -0.52);
      const head = new THREE.Mesh(new THREE.DodecahedronGeometry(0.48, 0), this.materials.obsidian);
      head.position.y = 1.95;
      const club = new THREE.Mesh(new THREE.BoxGeometry(0.28, 1.65, 0.28), this.materials.wallTop);
      club.position.set(0.82, 1.0, 0.05);
      club.rotation.z = -0.25;
      group.add(torso, core, head, club);
    } else {
      const abdomen = new THREE.Mesh(new THREE.DodecahedronGeometry(1.28, 0), this.materials.boss);
      abdomen.position.y = 1.25;
      abdomen.scale.set(1.18, 0.82, 1.34);
      const thorax = new THREE.Mesh(new THREE.CylinderGeometry(0.78, 1.12, 1.2, 7), this.materials.boss);
      thorax.position.set(0, 1.1, -0.98);
      thorax.rotation.x = Math.PI / 2;
      const crown = new THREE.Mesh(new THREE.CylinderGeometry(0.38, 0.82, 0.62, 6), this.materials.hot);
      crown.position.set(0, 2.25, -1.28);
      for (let side = -1; side <= 1; side += 2) {
        for (let i = 0; i < 3; i += 1) {
          const leg = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.26, 1.75), this.materials.obsidian);
          leg.position.set(side * (0.85 + i * 0.24), 0.62, -0.35 + i * 0.55);
          leg.rotation.z = side * (0.32 + i * 0.12);
          leg.rotation.y = side * (0.5 - i * 0.22);
          group.add(leg);
        }
      }
      group.add(abdomen, thorax, crown);
    }
    return group;
  }

  private createHealthBar(width: number, y: number): THREE.Group {
    const group = new THREE.Group();
    const back = new THREE.Mesh(new THREE.PlaneGeometry(width, 0.16), new THREE.MeshBasicMaterial({ color: 0x130408, transparent: true, opacity: 0.72, depthWrite: false }));
    const fill = new THREE.Mesh(new THREE.PlaneGeometry(width, 0.11), new THREE.MeshBasicMaterial({ color: 0xff4736, transparent: true, opacity: 0.94, depthWrite: false }));
    fill.position.z = 0.01;
    group.add(back, fill);
    group.position.y = y;
    group.visible = false;
    return group;
  }

  private spawnLoot(kind: LootKind, value: number, x: number, z: number): void {
    const group = new THREE.Group();
    if (kind === 'gold') {
      const coin = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 0.08, 8), this.materials.gold);
      coin.rotation.x = Math.PI / 2;
      group.add(coin);
      for (let i = 0; i < 2; i += 1) {
        const extra = coin.clone();
        extra.position.set((this.rng() - 0.5) * 0.45, 0.06 + i * 0.07, (this.rng() - 0.5) * 0.45);
        group.add(extra);
      }
    } else if (kind === 'potion') {
      const bottle = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.23, 0.46, 6), this.materials.toxic);
      bottle.position.y = 0.28;
      const cork = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.15, 0.13), this.materials.wallTop);
      cork.position.y = 0.58;
      group.add(bottle, cork);
    } else {
      const relic = new THREE.Mesh(new THREE.OctahedronGeometry(0.38, 0), this.materials.hot);
      relic.position.y = 0.4;
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.45, 0.025, 5, 18), this.materials.transparentGold);
      ring.rotation.x = Math.PI / 2;
      group.add(relic, ring);
    }
    group.position.set(x, 0.25, z);
    setShadow(group, true, false);
    this.actors.add(group);
    this.loot.push({ id: this.lootId, kind, value, group, position: group.position, radius: kind === 'relic' ? 0.82 : 0.56, bobSeed: this.rng() * TAU });
    this.lootId += 1;
  }

  private setupInput(): void {
    window.addEventListener('keydown', (event: KeyboardEvent) => {
      const gameplayKeys = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'KeyQ', 'KeyE', 'KeyR', 'ShiftLeft'];
      if (gameplayKeys.includes(event.code)) event.preventDefault();
      if (!this.keys.has(event.code)) {
        if (event.code === 'Space') this.useAbility('attack');
        if (event.code === 'KeyQ') this.useAbility('nova');
        if (event.code === 'KeyE') this.useAbility('dash');
        if (event.code === 'KeyR') this.useAbility('potion');
      }
      this.keys.add(event.code);
      this.player.clickTarget = null;
    });
    window.addEventListener('keyup', (event: KeyboardEvent) => this.keys.delete(event.code));

    this.canvas.addEventListener('pointerdown', (event: PointerEvent) => {
      this.canvas.setPointerCapture(event.pointerId);
      this.handleWorldPointer(event, true);
    });
    this.canvas.addEventListener('pointermove', (event: PointerEvent) => {
      if (event.buttons > 0) this.handleWorldPointer(event, false);
    });

    const bindButton = (id: string, ability: Ability): void => {
      mustGet<HTMLButtonElement>(id).addEventListener('pointerdown', (event: PointerEvent) => {
        event.preventDefault();
        this.useAbility(ability);
      });
    };
    bindButton('attack-btn', 'attack');
    bindButton('nova-btn', 'nova');
    bindButton('dash-btn', 'dash');
    bindButton('potion-btn', 'potion');
    bindButton('mobile-attack', 'attack');
    bindButton('mobile-nova', 'nova');
    bindButton('mobile-dash', 'dash');

    this.joystick.addEventListener('pointerdown', (event: PointerEvent) => {
      this.joystickPointerId = event.pointerId;
      this.joystick.setPointerCapture(event.pointerId);
      this.updateJoystick(event);
    });
    this.joystick.addEventListener('pointermove', (event: PointerEvent) => {
      if (this.joystickPointerId === event.pointerId) this.updateJoystick(event);
    });
    const resetJoystick = (event: PointerEvent): void => {
      if (this.joystickPointerId === event.pointerId) {
        this.joystickPointerId = null;
        this.joystickVector.set(0, 0);
        this.joystickKnob.style.transform = 'translate(0px, 0px)';
      }
    };
    this.joystick.addEventListener('pointerup', resetJoystick);
    this.joystick.addEventListener('pointercancel', resetJoystick);
  }

  private updateJoystick(event: PointerEvent): void {
    event.preventDefault();
    const rect = this.joystick.getBoundingClientRect();
    const cx = rect.left + rect.width * 0.5;
    const cy = rect.top + rect.height * 0.5;
    const dx = event.clientX - cx;
    const dy = event.clientY - cy;
    const len = Math.hypot(dx, dy);
    const max = rect.width * 0.34;
    const scale = len > max ? max / len : 1;
    const x = dx * scale;
    const y = dy * scale;
    this.joystickKnob.style.transform = `translate(${x}px, ${y}px)`;
    this.joystickVector.set(x / max, y / max);
    if (this.joystickVector.lengthSq() > 1) this.joystickVector.normalize();
    this.player.clickTarget = null;
  }

  private handleWorldPointer(event: PointerEvent, triggerAttack: boolean): void {
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hit = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(this.groundPlane, hit)) return;
    hit.x = clamp(hit.x, this.bounds.minX + 1, this.bounds.maxX - 1);
    hit.z = clamp(hit.z, this.bounds.minZ + 1, this.bounds.maxZ - 1);
    const clickedEnemy = this.enemies.find((enemy) => !enemy.dead && Math.hypot(enemy.position.x - hit.x, enemy.position.z - hit.z) < enemy.radius + 0.75);
    if (clickedEnemy && triggerAttack) {
      this.faceTowards(clickedEnemy.position);
      this.useAbility(distance2D(this.player.position, clickedEnemy.position) < 3.1 ? 'attack' : 'dash');
    } else {
      this.player.clickTarget = hit;
    }
  }

  private setupDebugApi(): void {
    window.__EMBERFALL__ = {
      hold: (code: string, down: boolean) => {
        if (down) this.keys.add(code);
        else this.keys.delete(code);
      },
      step: (code?: string, frames = 1, dt = 1 / 60) => {
        if (code) this.keys.add(code);
        for (let i = 0; i < frames; i += 1) this.update(dt);
        if (code) this.keys.delete(code);
        this.render();
        return this.debugState();
      },
      cast: (ability: Ability) => {
        this.useAbility(ability);
        this.update(1 / 60);
        this.render();
        return this.debugState();
      },
      teleport: (x: number, z: number) => {
        this.player.position.set(clamp(x, this.bounds.minX + 1, this.bounds.maxX - 1), 0, clamp(z, this.bounds.minZ + 1, this.bounds.maxZ - 1));
        this.update(1 / 60);
        this.render();
        return this.debugState();
      },
      state: () => this.debugState(),
      errors: this.errorLog,
    };
  }

  private animate(): void {
    requestAnimationFrame(() => this.animate());
    const dt = Math.min(this.clock.getDelta(), 0.045);
    this.update(dt);
    this.render();
  }

  private update(dt: number): void {
    this.elapsed += dt;
    this.updateCooldowns(dt);
    this.updatePlayer(dt);
    this.updateEnemies(dt);
    this.updateLoot(dt);
    this.updateEffects(dt);
    this.updateAnimatedWorld(dt);
    this.updateObjective();
    if (this.elapsed - this.lastUiUpdate > 0.07) {
      this.updateHud();
      this.drawMinimap();
      this.lastUiUpdate = this.elapsed;
    }
  }

  private render(): void {
    const target = this.player.position.clone().add(new THREE.Vector3(0, 0.8, 0));
    const offset = new THREE.Vector3(10.5, 13.5, 13.5);
    const desired = target.clone().add(offset);
    this.camera.position.lerp(desired, 0.075);
    this.camera.lookAt(target.x, target.y, target.z);
    this.enemies.forEach((enemy) => enemy.healthGroup.lookAt(this.camera.position));
    this.composer.render();
  }

  private updateCooldowns(dt: number): void {
    (Object.keys(this.player.cooldowns) as Ability[]).forEach((ability) => {
      this.player.cooldowns[ability] = Math.max(0, this.player.cooldowns[ability] - dt);
    });
    this.player.mana = Math.min(this.player.maxMana, this.player.mana + dt * (5.5 + this.player.level * 0.7));
    this.player.invulnerableTimer = Math.max(0, this.player.invulnerableTimer - dt);
    this.player.attackAnim = Math.max(0, this.player.attackAnim - dt * 4.2);
  }

  private updatePlayer(dt: number): void {
    const input = this.readMovementInput();
    let movement = input.clone();

    if (movement.lengthSq() < 0.001 && this.player.clickTarget) {
      movement.set(this.player.clickTarget.x - this.player.position.x, 0, this.player.clickTarget.z - this.player.position.z);
      if (movement.length() < 0.35) {
        this.player.clickTarget = null;
        movement.set(0, 0, 0);
      } else {
        movement.normalize();
      }
    }

    if (this.player.dashTimer > 0) {
      this.player.dashTimer -= dt;
      movement.copy(this.player.direction).multiplyScalar(4.35);
      this.player.invulnerableTimer = Math.max(this.player.invulnerableTimer, 0.12);
      this.damageEnemiesInLine(this.player.position, this.player.direction, 1.2, 26 * dt, false);
    }

    if (movement.lengthSq() > 0.001) {
      if (movement.lengthSq() > 1) movement.normalize();
      const speed = (this.keys.has('ShiftLeft') ? 5.3 : 3.85) * (this.player.dashTimer > 0 ? 2.45 : 1);
      this.player.direction.copy(movement).normalize();
      this.moveWithCollision(this.player.position, movement.x * speed * dt, movement.z * speed * dt, this.player.radius);
      this.player.group.rotation.y = Math.atan2(this.player.direction.x, this.player.direction.z);
    }

    const bob = Math.sin(this.elapsed * (movement.lengthSq() > 0.001 ? 12 : 3.2));
    this.player.group.position.y = Math.abs(bob) * (movement.lengthSq() > 0.001 ? 0.06 : 0.025);
    this.player.sword.rotation.z = -0.65 - Math.sin(this.player.attackAnim * Math.PI) * 1.7;
    this.player.sword.rotation.x = 0.15 + Math.sin(this.player.attackAnim * Math.PI) * 0.45;
    this.player.ring.rotation.z += dt * 1.4;
    this.pickupNearbyLoot();
  }

  private readMovementInput(): THREE.Vector3 {
    const input = new THREE.Vector3(0, 0, 0);
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) input.z -= 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) input.z += 1;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) input.x -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) input.x += 1;
    input.x += this.joystickVector.x;
    input.z += this.joystickVector.y;
    if (input.lengthSq() > 1) input.normalize();
    return input;
  }

  private updateEnemies(dt: number): void {
    for (const enemy of this.enemies) {
      if (enemy.dead) continue;
      enemy.attackTimer = Math.max(0, enemy.attackTimer - dt);
      enemy.specialTimer = Math.max(0, enemy.specialTimer - dt);
      enemy.stunTimer = Math.max(0, enemy.stunTimer - dt);
      enemy.body.rotation.y += Math.sin(this.elapsed * 1.7 + enemy.id) * dt * 0.08;
      enemy.group.position.y = Math.abs(Math.sin(this.elapsed * (enemy.kind === 'ashHound' ? 9.5 : 4.7) + enemy.id)) * 0.025;

      const toPlayer = this.tmp.subVectors(this.player.position, enemy.position);
      toPlayer.y = 0;
      const distance = toPlayer.length();
      const aggroRange = enemy.kind === 'cinderMatriarch' ? 26 : 14;
      if (distance < aggroRange && enemy.stunTimer <= 0 && !this.gameWon) {
        toPlayer.normalize();
        enemy.group.rotation.y = Math.atan2(toPlayer.x, toPlayer.z);
        if (distance > enemy.radius + this.player.radius + 0.72) {
          const pace = enemy.speed * (enemy.hp < enemy.maxHp * 0.35 ? 1.18 : 1);
          this.moveWithCollision(enemy.position, toPlayer.x * pace * dt, toPlayer.z * pace * dt, enemy.radius);
        } else if (enemy.attackTimer <= 0) {
          enemy.attackTimer = enemy.kind === 'cinderMatriarch' ? 1.55 : 1.15 + this.rng() * 0.4;
          this.hurtPlayer(enemy.damage, enemy.kind === 'cinderMatriarch' ? 'Crown fang' : 'Claw strike');
          this.spawnRing(enemy.position, 1.1 + enemy.radius, 0xff4736, 0.42, 0.32);
        }
      }

      if (enemy.kind === 'cinderMatriarch' && enemy.specialTimer <= 0 && distance < 28 && !this.gameWon) {
        enemy.specialTimer = 6.4;
        this.bossSpecial(enemy);
      }

      const healthRatio = enemy.hp / enemy.maxHp;
      enemy.healthGroup.visible = healthRatio < 0.999 && !enemy.dead;
      enemy.healthFill.scale.x = Math.max(0.001, healthRatio);
    }

    this.separateEnemies();
  }

  private separateEnemies(): void {
    for (let i = 0; i < this.enemies.length; i += 1) {
      const a = this.enemies[i];
      if (a.dead) continue;
      for (let j = i + 1; j < this.enemies.length; j += 1) {
        const b = this.enemies[j];
        if (b.dead) continue;
        const dx = b.position.x - a.position.x;
        const dz = b.position.z - a.position.z;
        const dist = Math.hypot(dx, dz);
        const min = a.radius + b.radius + 0.08;
        if (dist > 0.001 && dist < min) {
          const push = (min - dist) * 0.5;
          const nx = dx / dist;
          const nz = dz / dist;
          this.moveWithCollision(a.position, -nx * push, -nz * push, a.radius);
          this.moveWithCollision(b.position, nx * push, nz * push, b.radius);
        }
      }
    }
  }

  private bossSpecial(enemy: EnemyState): void {
    this.log('The Cinder Matriarch brands the floor with a molten curse.');
    this.spawnRing(enemy.position, 5.0, 0xff6f2b, 0.72, 0.86);
    window.setTimeout(() => {
      if (enemy.dead || this.gameWon) return;
      const distance = distance2D(enemy.position, this.player.position);
      if (distance < 5.2) this.hurtPlayer(24, 'Molten brand');
      this.spawnParticleBurst(enemy.position, 0xff8e2f, 30, 1.8);
    }, 620);
  }

  private updateLoot(dt: number): void {
    this.loot.forEach((item) => {
      item.group.rotation.y += dt * (item.kind === 'relic' ? 1.7 : 2.4);
      item.group.position.y = 0.28 + Math.sin(this.elapsed * 2.4 + item.bobSeed) * 0.12;
    });
  }

  private updateEffects(dt: number): void {
    for (let i = this.effects.length - 1; i >= 0; i -= 1) {
      const effect = this.effects[i];
      effect.life -= dt;
      effect.velocity.y -= effect.gravity * dt;
      effect.object.position.addScaledVector(effect.velocity, dt);
      effect.object.rotation.y += effect.spin * dt;
      if (effect.grow !== 0) {
        const amount = effect.grow * dt;
        effect.object.scale.x += amount;
        effect.object.scale.y += amount;
        effect.object.scale.z += amount;
      }
      if (effect.material) effect.material.opacity = Math.max(0, (effect.life / effect.maxLife) * (effect.material.userData.baseOpacity as number));
      if (effect.life <= 0) {
        this.effectsGroup.remove(effect.object);
        this.effects.splice(i, 1);
      }
    }
  }

  private updateAnimatedWorld(dt: number): void {
    this.world.traverse((object) => {
      if (object.name === 'animated-flame') {
        object.scale.setScalar(0.86 + Math.sin(this.elapsed * 9 + object.id) * 0.12 + this.rng() * 0.01);
        object.rotation.y += dt * 3.2;
      }
    });
  }

  private useAbility(ability: Ability): void {
    if (this.gameWon) return;
    if (this.player.cooldowns[ability] > 0) return;
    if (ability === 'attack') this.basicAttack();
    if (ability === 'nova') this.castNova();
    if (ability === 'dash') this.castDash();
    if (ability === 'potion') this.drinkPotion();
  }

  private basicAttack(): void {
    this.player.cooldowns.attack = this.player.maxCooldowns.attack;
    this.player.attackAnim = 1;
    const hit = this.damageEnemiesInLine(this.player.position, this.player.direction, 2.45, 24 + this.player.level * 5, true);
    this.spawnSlashArc();
    if (hit === 0) this.log('Moon Slash cuts sparks from the stone.');
  }

  private castNova(): void {
    if (this.player.mana < 24) {
      this.log('Not enough mana for Ember Nova.');
      return;
    }
    this.player.mana -= 24;
    this.player.cooldowns.nova = this.player.maxCooldowns.nova;
    this.spawnRing(this.player.position, 4.6, 0xff9a32, 0.7, 0.7);
    this.spawnParticleBurst(this.player.position, 0xffb14a, 36, 2.5);
    let hits = 0;
    for (const enemy of this.enemies) {
      if (enemy.dead) continue;
      const dist = distance2D(enemy.position, this.player.position);
      if (dist < 4.85) {
        hits += 1;
        this.damageEnemy(enemy, 38 + this.player.level * 8, 'Ember Nova');
        enemy.stunTimer = Math.max(enemy.stunTimer, 0.35);
      }
    }
    this.log(hits ? `Ember Nova scorches ${hits} foe${hits === 1 ? '' : 's'}.` : 'Ember Nova blooms, but no foe stands inside it.');
  }

  private castDash(): void {
    this.player.cooldowns.dash = this.player.maxCooldowns.dash;
    const input = this.readMovementInput();
    if (input.lengthSq() > 0.001) this.player.direction.copy(input).normalize();
    this.player.dashTimer = 0.2;
    this.player.invulnerableTimer = 0.34;
    this.player.clickTarget = null;
    this.spawnRing(this.player.position, 1.2, 0x74d8ff, 0.36, 0.26);
    this.log('Rift Dash slips between ember shadows.');
  }

  private drinkPotion(): void {
    if (this.player.potions <= 0) {
      this.log('No potions left. Hunt green vials from elites.');
      return;
    }
    if (this.player.hp >= this.player.maxHp) {
      this.log('Health is already full.');
      return;
    }
    this.player.potions -= 1;
    this.player.cooldowns.potion = this.player.maxCooldowns.potion;
    const healed = Math.min(this.player.maxHp - this.player.hp, 46 + this.player.level * 8);
    this.player.hp += healed;
    this.spawnRing(this.player.position, 1.35, 0x78ff5b, 0.42, 0.38);
    this.log(`Potion restores ${Math.round(healed)} health.`);
  }

  private damageEnemiesInLine(origin: THREE.Vector3, direction: THREE.Vector3, range: number, damage: number, logHit: boolean): number {
    let hits = 0;
    const dir = direction.clone().normalize();
    for (const enemy of this.enemies) {
      if (enemy.dead) continue;
      const toEnemy = this.tmp.subVectors(enemy.position, origin);
      toEnemy.y = 0;
      const dist = toEnemy.length();
      if (dist > range + enemy.radius) continue;
      const forward = dist > 0.001 ? toEnemy.normalize().dot(dir) : 1;
      if (forward > 0.32 || dist < 1.2) {
        hits += 1;
        this.damageEnemy(enemy, damage, 'Moon Slash');
        enemy.stunTimer = Math.max(enemy.stunTimer, 0.12);
      }
    }
    if (hits > 0 && logHit) this.log(`Moon Slash hits ${hits} foe${hits === 1 ? '' : 's'}.`);
    return hits;
  }

  private damageEnemy(enemy: EnemyState, amount: number, source: string): void {
    if (enemy.dead) return;
    const actual = Math.min(enemy.hp, amount * (0.88 + this.rng() * 0.24));
    enemy.hp -= actual;
    this.spawnDamageSprite(enemy.position, Math.round(actual), enemy.kind === 'cinderMatriarch' ? '#ffd27a' : '#ffefc1');
    this.spawnParticleBurst(enemy.position, enemy.kind === 'cinderMatriarch' ? 0xff5d36 : 0xffaa4a, enemy.kind === 'cinderMatriarch' ? 12 : 8, 1.0);
    if (enemy.hp <= 0) this.killEnemy(enemy, source);
  }

  private killEnemy(enemy: EnemyState, source: string): void {
    enemy.dead = true;
    enemy.group.visible = false;
    this.player.gold += enemy.gold;
    this.player.xp += enemy.xp;
    this.spawnLoot('gold', enemy.gold, enemy.position.x + (this.rng() - 0.5) * 0.8, enemy.position.z + (this.rng() - 0.5) * 0.8);
    if (this.rng() < 0.22 || enemy.kind === 'obsidianBrute') this.spawnLoot('potion', 1, enemy.position.x - 0.65 + this.rng() * 1.3, enemy.position.z - 0.65 + this.rng() * 1.3);
    this.spawnRing(enemy.position, 1.4 + enemy.radius, 0xffb54b, 0.55, 0.42);
    this.log(`${this.enemyName(enemy.kind)} falls to ${source}. +${enemy.xp} XP`);
    this.checkLevelUp();
    if (enemy.kind === 'cinderMatriarch') this.winGame();
  }

  private enemyName(kind: EnemyKind): string {
    switch (kind) {
      case 'emberImp': return 'Ember imp';
      case 'ashHound': return 'Ash hound';
      case 'obsidianBrute': return 'Obsidian brute';
      case 'cinderMatriarch': return 'Cinder Matriarch';
    }
  }

  private checkLevelUp(): void {
    let needed = this.xpNeeded();
    while (this.player.xp >= needed) {
      this.player.xp -= needed;
      this.player.level += 1;
      this.player.maxHp += 18;
      this.player.maxMana += 10;
      this.player.hp = this.player.maxHp;
      this.player.mana = this.player.maxMana;
      this.spawnRing(this.player.position, 2.0, 0xffd36a, 0.62, 0.75);
      this.log(`Level ${this.player.level}! Vitality and mana surge.`);
      needed = this.xpNeeded();
    }
  }

  private xpNeeded(): number {
    return 55 + (this.player.level - 1) * 42;
  }

  private hurtPlayer(amount: number, source: string): void {
    if (this.player.invulnerableTimer > 0 || this.gameWon) return;
    this.player.hp = Math.max(0, this.player.hp - amount);
    this.player.invulnerableTimer = 0.24;
    this.spawnDamageSprite(this.player.position, Math.round(amount), '#ff8c8c');
    this.spawnRing(this.player.position, 0.95, 0xff2830, 0.35, 0.28);
    this.log(`${source} deals ${Math.round(amount)} damage.`);
    if (this.player.hp <= 0) this.respawnPlayer();
  }

  private respawnPlayer(): void {
    this.player.hp = Math.max(35, this.player.maxHp * 0.55);
    this.player.mana = this.player.maxMana * 0.75;
    this.player.gold = Math.max(0, this.player.gold - 20);
    this.player.position.set(0, 0, 12);
    this.player.clickTarget = null;
    this.spawnRing(this.player.position, 2.6, 0x74d8ff, 0.7, 0.65);
    this.log('A hearth sigil saves you, at the cost of twenty gold.');
  }

  private winGame(): void {
    this.gameWon = true;
    this.objective = 'Ashen Crown shattered';
    this.centerToast.innerHTML = '<h2>Ashen Crown Shattered</h2><p>The crypt exhales. Emberfall is yours — refresh to challenge it again.</p>';
    this.centerToast.classList.add('show');
    this.spawnRing(this.player.position, 5.2, 0xffd36a, 0.8, 1.25);
    this.spawnParticleBurst(this.player.position, 0xffd36a, 70, 3.2);
    this.log('Victory! The Cinder Matriarch is ash.');
  }

  private faceTowards(target: THREE.Vector3): void {
    this.tmp.subVectors(target, this.player.position);
    this.tmp.y = 0;
    if (this.tmp.lengthSq() > 0.001) {
      this.player.direction.copy(this.tmp.normalize());
      this.player.group.rotation.y = Math.atan2(this.player.direction.x, this.player.direction.z);
    }
  }

  private moveWithCollision(position: THREE.Vector3, dx: number, dz: number, radius: number): void {
    const oldX = position.x;
    const oldZ = position.z;
    position.x += dx;
    if (!this.canStand(position.x, position.z, radius)) position.x = oldX;
    position.z += dz;
    if (!this.canStand(position.x, position.z, radius)) position.z = oldZ;
  }

  private canStand(x: number, z: number, radius: number): boolean {
    if (x < this.bounds.minX + radius || x > this.bounds.maxX - radius || z < this.bounds.minZ + radius || z > this.bounds.maxZ - radius) return false;
    for (const shape of this.obstacles) {
      if (shape.kind === 'circle') {
        if (Math.hypot(x - shape.x, z - shape.z) < radius + shape.r) return false;
      } else {
        const closestX = clamp(x, shape.x - shape.w / 2, shape.x + shape.w / 2);
        const closestZ = clamp(z, shape.z - shape.d / 2, shape.z + shape.d / 2);
        if (Math.hypot(x - closestX, z - closestZ) < radius) return false;
      }
    }
    return true;
  }

  private pickupNearbyLoot(): void {
    for (let i = this.loot.length - 1; i >= 0; i -= 1) {
      const item = this.loot[i];
      if (distance2D(this.player.position, item.position) > item.radius + this.player.radius + 0.22) continue;
      if (item.kind === 'gold') {
        this.player.gold += item.value;
        this.log(`Collected ${item.value} gold.`);
      } else if (item.kind === 'potion') {
        this.player.potions += 1;
        this.log('Collected a potion.');
      } else {
        this.player.gold += 40;
        this.player.xp += 30;
        this.log('Ancient relic claimed. +30 XP, +40 gold.');
        this.checkLevelUp();
      }
      this.spawnRing(item.position, 0.95, item.kind === 'potion' ? 0x78ff5b : 0xffd36a, 0.35, 0.34);
      this.actors.remove(item.group);
      this.loot.splice(i, 1);
    }
  }

  private spawnSlashArc(): void {
    const arc = new THREE.Mesh(new THREE.TorusGeometry(1.25, 0.045, 6, 32, Math.PI * 1.05), this.materials.transparentGold.clone());
    arc.position.copy(this.player.position).add(this.player.direction.clone().multiplyScalar(0.92));
    arc.position.y = 1.05;
    arc.rotation.x = Math.PI / 2;
    arc.rotation.z = -Math.atan2(this.player.direction.z, this.player.direction.x) - 0.5;
    this.addEffect(arc, 0.2, new THREE.Vector3(0, 0.4, 0), 1.8, 3.5, 0);
  }

  private spawnRing(position: THREE.Vector3, radius: number, color: number, opacity: number, duration: number): void {
    const material = new THREE.MeshBasicMaterial({ color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false });
    material.userData.baseOpacity = opacity;
    const ring = new THREE.Mesh(new THREE.TorusGeometry(radius, 0.035, 6, 42), material);
    ring.position.set(position.x, 0.12, position.z);
    ring.rotation.x = -Math.PI / 2;
    this.addEffect(ring, duration, new THREE.Vector3(0, 0, 0), radius * 1.5, 0, 0, material);
  }

  private spawnParticleBurst(position: THREE.Vector3, color: number, count: number, strength: number): void {
    for (let i = 0; i < count; i += 1) {
      const material = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.86, blending: THREE.AdditiveBlending, depthWrite: false });
      material.userData.baseOpacity = 0.86;
      const particle = new THREE.Mesh(new THREE.DodecahedronGeometry(0.06 + this.rng() * 0.08, 0), material);
      particle.position.set(position.x + (this.rng() - 0.5) * 0.7, 0.45 + this.rng() * 0.8, position.z + (this.rng() - 0.5) * 0.7);
      const velocity = new THREE.Vector3((this.rng() - 0.5) * strength, 1.2 + this.rng() * strength, (this.rng() - 0.5) * strength);
      this.addEffect(particle, 0.55 + this.rng() * 0.45, velocity, 0.02, (this.rng() - 0.5) * 6, 2.6, material);
    }
  }

  private spawnDamageSprite(position: THREE.Vector3, amount: number, color: string): void {
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.font = '900 38px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 7;
    ctx.strokeStyle = 'rgba(20, 3, 5, 0.9)';
    ctx.strokeText(String(amount), 64, 33);
    ctx.fillStyle = color;
    ctx.fillText(String(amount), 64, 33);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const material = new THREE.SpriteMaterial({ map: texture, transparent: true, opacity: 1, depthWrite: false });
    material.userData.baseOpacity = 1;
    const sprite = new THREE.Sprite(material);
    sprite.scale.set(1.5, 0.75, 1);
    sprite.position.set(position.x, 2.2, position.z);
    this.addEffect(sprite, 0.75, new THREE.Vector3((this.rng() - 0.5) * 0.5, 1.2, (this.rng() - 0.5) * 0.5), 0.0, 0, 0.35, material);
  }

  private addEffect(
    object: THREE.Object3D,
    life: number,
    velocity: THREE.Vector3,
    grow: number,
    spin: number,
    gravity: number,
    material?: THREE.Material & { opacity: number },
  ): void {
    if (material && material.userData.baseOpacity === undefined) material.userData.baseOpacity = material.opacity;
    this.effectsGroup.add(object);
    this.effects.push({ object, life, maxLife: life, velocity, grow, spin, gravity, material });
  }

  private updateObjective(): void {
    const minions = this.enemies.filter((enemy) => !enemy.dead && enemy.kind !== 'cinderMatriarch').length;
    const boss = this.enemies.find((enemy) => enemy.kind === 'cinderMatriarch');
    if (this.gameWon) {
      this.objective = 'Ashen Crown shattered';
      return;
    }
    if (minions > 0) this.objective = `Purge ${minions} crypt fiends`;
    else if (boss && !boss.dead) this.objective = 'Defeat the Cinder Matriarch';
    else this.objective = 'Claim victory';
  }

  private updateHud(): void {
    const healthRatio = clamp(this.player.hp / this.player.maxHp, 0, 1);
    const manaRatio = clamp(this.player.mana / this.player.maxMana, 0, 1);
    const xpRatio = clamp(this.player.xp / this.xpNeeded(), 0, 1);
    this.healthFill.style.transform = `scaleX(${healthRatio})`;
    this.healthLabel.textContent = `${Math.ceil(this.player.hp)} / ${this.player.maxHp}`;
    this.manaFill.style.transform = `scaleX(${manaRatio})`;
    this.manaLabel.textContent = `${Math.floor(this.player.mana)} / ${this.player.maxMana}`;
    this.xpFill.style.transform = `scaleX(${xpRatio})`;
    this.xpLabel.textContent = `Level ${this.player.level} · ${Math.floor(this.player.xp)}/${this.xpNeeded()} XP`;
    this.goldLabel.textContent = `${this.player.gold} gold`;
    this.potionLabel.textContent = `Potion ×${this.player.potions}`;
    this.objectiveLabel.textContent = this.objective;
    this.questCopy.textContent = this.gameWon ? 'The Ashen Crown is shattered. The crypt returns to warm silence.' : 'Cleanse the ember crypt, collect relic gold, and defeat the Cinder Matriarch.';

    (['attack', 'nova', 'dash', 'potion'] as Ability[]).forEach((ability) => {
      const cd = this.player.cooldowns[ability];
      const max = this.player.maxCooldowns[ability];
      const node = mustGet<HTMLElement>(`cd-${ability}`);
      node.style.height = `${clamp(cd / max, 0, 1) * 100}%`;
    });

    const boss = this.enemies.find((enemy) => enemy.kind === 'cinderMatriarch');
    if (boss && !boss.dead && (boss.hp < boss.maxHp || distance2D(boss.position, this.player.position) < 14)) {
      this.bossFrame.classList.remove('hidden');
      this.bossFill.style.transform = `scaleX(${clamp(boss.hp / boss.maxHp, 0, 1)})`;
    } else {
      this.bossFrame.classList.add('hidden');
    }
  }

  private drawMinimap(): void {
    const ctx = this.minimap.getContext('2d');
    if (!ctx) return;
    const w = this.minimap.width;
    const h = this.minimap.height;
    ctx.clearRect(0, 0, w, h);
    const grd = ctx.createRadialGradient(w / 2, h / 2, 10, w / 2, h / 2, w / 2);
    grd.addColorStop(0, 'rgba(66, 27, 22, 0.92)');
    grd.addColorStop(1, 'rgba(9, 3, 6, 0.96)');
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(255, 198, 112, 0.34)';
    ctx.lineWidth = 2;
    ctx.strokeRect(8, 8, w - 16, h - 16);

    const mapX = (x: number): number => ((x - this.bounds.minX) / (this.bounds.maxX - this.bounds.minX)) * (w - 24) + 12;
    const mapZ = (z: number): number => ((z - this.bounds.minZ) / (this.bounds.maxZ - this.bounds.minZ)) * (h - 24) + 12;

    ctx.fillStyle = 'rgba(255, 145, 50, 0.28)';
    this.obstacles.forEach((shape) => {
      ctx.beginPath();
      if (shape.kind === 'circle') ctx.arc(mapX(shape.x), mapZ(shape.z), shape.r * 2, 0, TAU);
      else ctx.rect(mapX(shape.x - shape.w / 2), mapZ(shape.z - shape.d / 2), shape.w * 2, shape.d * 2);
      ctx.fill();
    });

    this.loot.forEach((item) => {
      ctx.fillStyle = item.kind === 'potion' ? '#78ff5b' : '#ffd36a';
      ctx.beginPath();
      ctx.arc(mapX(item.position.x), mapZ(item.position.z), item.kind === 'relic' ? 3.5 : 2.2, 0, TAU);
      ctx.fill();
    });

    this.enemies.forEach((enemy) => {
      if (enemy.dead) return;
      ctx.fillStyle = enemy.kind === 'cinderMatriarch' ? '#ff5738' : '#d92832';
      ctx.beginPath();
      ctx.arc(mapX(enemy.position.x), mapZ(enemy.position.z), enemy.kind === 'cinderMatriarch' ? 5 : 2.8, 0, TAU);
      ctx.fill();
    });

    ctx.fillStyle = '#75d8ff';
    ctx.beginPath();
    ctx.arc(mapX(this.player.position.x), mapZ(this.player.position.z), 4.4, 0, TAU);
    ctx.fill();
  }

  private log(message: string): void {
    const line = document.createElement('div');
    line.className = 'log-line';
    line.textContent = message;
    this.combatLog.prepend(line);
    while (this.combatLog.children.length > 5) this.combatLog.removeChild(this.combatLog.lastElementChild as ChildNode);
  }

  private onResize(): void {
    const width = window.innerWidth;
    const height = window.innerHeight;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
    this.composer.setSize(width, height);
  }

  private debugState(): DebugState {
    const boss = this.enemies.find((enemy) => enemy.kind === 'cinderMatriarch');
    return {
      hp: Math.round(this.player.hp),
      mana: Math.round(this.player.mana),
      level: this.player.level,
      xp: Math.round(this.player.xp),
      gold: this.player.gold,
      potions: this.player.potions,
      player: { x: Number(this.player.position.x.toFixed(2)), z: Number(this.player.position.z.toFixed(2)) },
      enemiesAlive: this.enemies.filter((enemy) => !enemy.dead).length,
      bossHp: boss && !boss.dead ? Math.round(boss.hp) : 0,
      lootCount: this.loot.length,
      objective: this.objective,
      errors: [...this.errorLog],
    };
  }
}

new EmberfallGame();
