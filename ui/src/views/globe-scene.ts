// The Topology globe's three.js scene (issue #1893): a sphere with the land's outline, a marker for each region (larger
// with more nodes) and an arc for the links between two regions. A person turns it by dragging, zooms with the wheel, and
// clicks a marker to pick its region. The outline is Natural Earth's land at 1:110m (world-atlas), built into the UI: no
// map tile and no call to an outside service. Loaded only when the globe shows (a chunk of its own). WebGL only: the view
// falls back to the graph when this throws (topology-globe.tsx).
import {
  BufferGeometry, Color, Group, Line, LineBasicMaterial, Mesh, MeshBasicMaterial, PerspectiveCamera, Raycaster, Scene, SphereGeometry,
  Vector2, Vector3, WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { feature } from 'topojson-client';
import type { GeometryCollection, Topology } from 'topojson-specification';
import land from 'world-atlas/land-110m.json';
import { arcPoints, toPoint, type GlobeArc, type GlobeRegion, type Point } from '@/model/topology-globe';

const R = 1;
/** A CSS colour of the page's theme as three.js reads it: drawn on a 1×1 canvas, read back as RGB (oklch included). */
function themeColor(host: HTMLElement, name: string, fallback: string): Color {
  const css = getComputedStyle(host).getPropertyValue(name).trim() || fallback;
  const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  if (!ctx) return new Color(fallback);
  ctx.canvas.width = ctx.canvas.height = 1;
  ctx.fillStyle = css;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return new Color((r ?? 0) / 255, (g ?? 0) / 255, (b ?? 0) / 255);
}

const lineOf = (points: Point[], material: LineBasicMaterial): Line =>
  new Line(new BufferGeometry().setFromPoints(points.map((p) => new Vector3(...p))), material);

/** The land's outline: each ring of Natural Earth's land, just above the sphere. */
function landLines(material: LineBasicMaterial): Group {
  const topo = land as unknown as Topology<{ land: GeometryCollection }>;
  const geo = feature(topo, topo.objects.land);
  const group = new Group();
  for (const f of geo.features) {
    const g = f.geometry;
    const polygons = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
    for (const ring of polygons.flat()) group.add(lineOf(ring.map(([lon, lat]) => toPoint(lat ?? 0, lon ?? 0, R * 1.001)), material));
  }
  return group;
}

export type GlobeHandle = { dispose: () => void };

/** Draws the globe into `host`; `onPick` gets the region of a marker clicked. Throws when WebGL cannot start. */
export function mountGlobe(host: HTMLElement, regions: readonly GlobeRegion[], arcs: readonly GlobeArc[], selected: string | undefined, onPick: (region: string) => void): GlobeHandle {
  const renderer = new WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  host.append(renderer.domElement);
  renderer.domElement.style.display = 'block';
  const scene = new Scene();
  const camera = new PerspectiveCamera(40, 1, 0.1, 100);
  const first = regions.find((r) => r.region === selected) ?? regions[0];
  const [x, y, z] = first ? toPoint(first.lat, first.lon, 3.4) : [0, 0, 3.4];
  camera.position.set(x, y, z);
  const [muted, line, mark, pick] = [themeColor(host, '--muted', '#eee'), themeColor(host, '--muted-foreground', '#888'), themeColor(host, '--ok', '#2a9'), themeColor(host, '--warn', '#e90')];
  const materials = { sphere: new MeshBasicMaterial({ color: muted }), land: new LineBasicMaterial({ color: line }), arc: new LineBasicMaterial({ color: mark, transparent: true, opacity: 0.7 }), mark: new MeshBasicMaterial({ color: mark }), pick: new MeshBasicMaterial({ color: pick }) };
  scene.add(new Mesh(new SphereGeometry(R, 64, 48), materials.sphere), landLines(materials.land));
  const byRegion = new Map(regions.map((r) => [r.region, r]));
  const most = Math.max(1, ...regions.map((r) => r.nodes.length));
  const markers: Mesh[] = regions.map((r) => {
    const m = new Mesh(new SphereGeometry(0.012 + 0.03 * Math.sqrt(r.nodes.length / most), 16, 12), r.region === selected ? materials.pick : materials.mark);
    m.position.set(...toPoint(r.lat, r.lon, R));
    m.userData.region = r.region;
    return m;
  });
  scene.add(...markers);
  for (const a of arcs) {
    const [from, to] = [byRegion.get(a.from), byRegion.get(a.to)];
    if (from && to) scene.add(lineOf(arcPoints(from, to, R), materials.arc));
  }
  const controls = new OrbitControls(camera, renderer.domElement);
  Object.assign(controls, { enablePan: false, minDistance: 1.4, maxDistance: 6, rotateSpeed: 0.5 });
  const render = (): void => renderer.render(scene, camera);
  controls.addEventListener('change', render);
  const size = (): void => {
    const w = host.clientWidth || 640;
    const h = Math.min(w, 520);
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    render();
  };
  const resize = new ResizeObserver(size);
  resize.observe(host);
  size();

  const ray = new Raycaster();
  const hit = (e: PointerEvent | MouseEvent): GlobeRegion | undefined => {
    const box = renderer.domElement.getBoundingClientRect();
    ray.setFromCamera(new Vector2(((e.clientX - box.left) / box.width) * 2 - 1, -((e.clientY - box.top) / box.height) * 2 + 1), camera);
    const region = ray.intersectObjects(markers)[0]?.object.userData.region as string | undefined;
    return region ? byRegion.get(region) : undefined;
  };
  let down: [number, number] | undefined;
  const onDown = (e: PointerEvent): void => { down = [e.clientX, e.clientY]; };
  const onUp = (e: PointerEvent): void => {
    const moved = down ? Math.hypot(e.clientX - down[0], e.clientY - down[1]) : Infinity;
    down = undefined;
    const r = moved < 5 ? hit(e) : undefined;
    if (r) onPick(r.region);
  };
  const onMove = (e: PointerEvent): void => {
    const r = hit(e);
    renderer.domElement.style.cursor = r ? 'pointer' : 'grab';
    renderer.domElement.title = r ? `${r.region} (${r.place}): ${r.nodes.length} ${r.nodes.length === 1 ? 'node' : 'nodes'}` : '';
  };
  renderer.domElement.addEventListener('pointerdown', onDown);
  renderer.domElement.addEventListener('pointerup', onUp);
  renderer.domElement.addEventListener('pointermove', onMove);

  return {
    dispose: () => {
      resize.disconnect();
      controls.dispose();
      renderer.domElement.removeEventListener('pointerdown', onDown);
      renderer.domElement.removeEventListener('pointerup', onUp);
      renderer.domElement.removeEventListener('pointermove', onMove);
      scene.traverse((o) => { if (o instanceof Mesh || o instanceof Line) o.geometry.dispose(); });
      for (const m of Object.values(materials)) m.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
