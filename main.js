import * as THREE from 'https://unpkg.com/three@0.160.0/build/three.module.js';
import { XRButton } from 'https://unpkg.com/three@0.160.0/examples/jsm/webxr/XRButton.js';

let renderer, scene, camera, clock;
let xrRefSpace, xrViewerSpace, hitTestSource = null;

let reticle;
let hoopRoot;        // group anchored where you place it
let hoop, rim, backboard;
let placed = false;
let paused = false;

const balls = new Set();

let score = 0;
let shots = 0;

// tuning (meters, seconds)
const BALL_RADIUS = 0.08;
const BALL_LIFETIME = 8.0;           // seconds
const GRAVITY = new THREE.Vector3(0, -9.82, 0);
const BASE_THROW_SPEED = 2.8;        // m/s forward baseline
const SWIPE_SPEED_SCALE = 0.015;     // screen px/ms -> m/s scaler
const MAX_INITIAL_SPEED = 8.0;       // cap nonsense flicks

// hoop geometry
const RIM_INNER_RADIUS = 0.19;       // forgiving (real ~0.229)
const RIM_THICKNESS = 0.02;
const RIM_HEIGHT = 1.6;              // default height above floor

// UI
const $score = document.getElementById('score');
const $shots = document.getElementById('shots');
const $status = document.getElementById('status');
const $btnReset = document.getElementById('reset');
const $btnPause = document.getElementById('pause');
const $btnNudge = document.getElementById('nudge');

init();

function init() {
  // renderer
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.xr.enabled = true;
  document.body.appendChild(renderer.domElement);

  // scene + camera
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 30);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x333366, 1.0));
  scene.fog = new THREE.FogExp2(0x000000, 0.12);

  // reticle
  reticle = makeReticle();
  reticle.visible = false;
  scene.add(reticle);

  // hoop root (invisible holder)
  hoopRoot = new THREE.Group();
  hoopRoot.name = 'hoopRoot';
  scene.add(hoopRoot);

  // build hoop visuals (hidden until placed)
  ({ hoop, rim, backboard } = buildHoop());
  hoop.visible = false;
  scene.add(hoop);

  // input (tap to place, swipe to throw)
  renderer.domElement.addEventListener('pointerdown', onPointerDown);
  renderer.domElement.addEventListener('pointermove', onPointerMove);
  renderer.domElement.addEventListener('pointerup', onPointerUp);
  window.addEventListener('resize', onResize);

  // controls
  $btnReset.addEventListener('click', resetGame);
  $btnPause.addEventListener('click', () => { paused = !paused; $btnPause.textContent = paused ? 'resume' : 'pause'; });
  $btnNudge.addEventListener('click', () => { if (placed) { hoopRoot.position.y += 0.1; updateHoopTransform(); } });

  // XR button
  document.body.appendChild(XRButton.createButton(renderer, {
    requiredFeatures: ['hit-test', 'local-floor'],
    optionalFeatures: []
  }));

  renderer.xr.addEventListener('sessionstart', async () => {
    const session = renderer.xr.getSession();
    xrRefSpace = await session.requestReferenceSpace('local-floor');
    xrViewerSpace = await session.requestReferenceSpace('viewer');
    hitTestSource = await session.requestHitTestSource({ space: xrViewerSpace });
    clock = new THREE.Clock();
  });

  renderer.xr.addEventListener('sessionend', () => {
    hitTestSource = null;
    placed = false;
    hoop.visible = false;
    $status.textContent = 'find a surface, then tap to place the hoop.';
    clearBalls();
  });

  renderer.setAnimationLoop(onXRFrame);

  window.__app = { THREE, scene, renderer, camera, hoopRoot, hoop, balls };
}

function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

function onXRFrame(time, frame) {
  const dt = clock ? clock.getDelta() : 0.016;

  updateReticle(frame);

  if (!paused) {
    updateBalls(dt);
  }

  renderer.render(scene, camera);
}

function updateReticle(frame) {
  if (!hitTestSource || !frame || placed) {
    reticle.visible = !placed && false;
    return;
  }
  const hits = frame.getHitTestResults(hitTestSource);
  if (hits.length) {
    const pose = hits[0].getPose(xrRefSpace);
    if (pose) {
      reticle.visible = true;
      reticle.matrix.fromArray(pose.transform.matrix);
      reticle.matrix.decompose(reticle.position, reticle.quaternion, reticle.scale);
      // keep reticle flat to plane, status hint
      $status.textContent = 'tap to place the hoop (we’ll set height automatically).';
    } else {
      reticle.visible = false;
    }
  } else {
    reticle.visible = false;
    if (!placed) $status.textContent = 'move phone to help it find a surface…';
  }
}

// ---------- placement -------------------------------------------------------

function placeHoopAtReticleOrFallback() {
  if (reticle.visible) {
    // position hoop root at reticle, but raise to rim height and face the user
    hoopRoot.position.copy(reticle.position);
    hoopRoot.position.y = reticle.position.y + RIM_HEIGHT;   // move up from floor plane
    lookRootAtCamera(hoopRoot);
  } else {
    // fallback: 2m straight ahead, rim height
    const xrCam = renderer.xr.getCamera(camera);
    const origin = new THREE.Vector3().setFromMatrixPosition(xrCam.matrixWorld);
    const fwd = new THREE.Vector3(0,0,-1).applyQuaternion(xrCam.quaternion).normalize();
    hoopRoot.position.copy(origin).addScaledVector(fwd, 2.0);
    hoopRoot.position.y = origin.y + (RIM_HEIGHT * 0.8);
    lookRootAtCamera(hoopRoot);
  }
  updateHoopTransform();
  hoop.visible = true;
  placed = true;
  $status.textContent = 'swipe up/forward to throw. tap “nudge” if hoop is too low.';
}

function lookRootAtCamera(root) {
  const xrCam = renderer.xr.getCamera(camera);
  const camPos = new THREE.Vector3().setFromMatrixPosition(xrCam.matrixWorld);
  root.lookAt(camPos);
}

function updateHoopTransform() {
  hoop.position.copy(hoopRoot.position);
  hoop.quaternion.copy(hoopRoot.quaternion);
}

// ---------- hoop ------------------------------------------------------------

function buildHoop() {
  const group = new THREE.Group();
  group.name = 'hoop';

  // rim (torus)
  const rimGeo = new THREE.TorusGeometry(RIM_INNER_RADIUS + RIM_THICKNESS * 0.5, RIM_THICKNESS * 0.5, 12, 48);
  const rimMat = new THREE.MeshStandardMaterial({ color: 0xff7f00, metalness: 0.4, roughness: 0.4 });
  const rim = new THREE.Mesh(rimGeo, rimMat);
  rim.rotation.x = Math.PI / 2; // lay flat (ring parallel to ground)
  rim.position.y = 0.0;
  group.add(rim);

  // simple backboard (thin plane)
  const board = new THREE.Mesh(
    new THREE.PlaneGeometry(0.9, 0.6),
    new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 0.0, roughness: 1.0 })
  );
  board.position.set(0, 0.15, -0.16);
  // board faces towards the player because group will lookAt camera
  group.add(board);

  // support pole (pure visuals so it doesn’t look like it’s floating)
  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(0.02, 0.02, 1.6, 8),
    new THREE.MeshStandardMaterial({ color: 0x222222, metalness: 0.2, roughness: 0.8 })
  );
  pole.position.set(0, -0.8, -0.12);
  group.add(pole);

  return { hoop: group, rim, backboard: board };
}

// ---------- swipe → throw ---------------------------------------------------

let swipe = { active: false, x0: 0, y0: 0, t0: 0, x1: 0, y1: 0, t1: 0 };

function onPointerDown(e) {
  if (!placed) {
    placeHoopAtReticleOrFallback();
    return;
  }
  swipe.active = true;
  swipe.x0 = e.clientX; swipe.y0 = e.clientY; swipe.t0 = performance.now();
  swipe.x1 = swipe.x0; swipe.y1 = swipe.y0; swipe.t1 = swipe.t0;
}

function onPointerMove(e) {
  if (!swipe.active) return;
  swipe.x1 = e.clientX; swipe.y1 = e.clientY; swipe.t1 = performance.now();
}

function onPointerUp(e) {
  if (!swipe.active) return;
  swipe.active = false;

  const dx = swipe.x1 - swipe.x0;
  const dy = swipe.y1 - swipe.y0;
  const dt = Math.max(1, swipe.t1 - swipe.t0); // ms

  // ignore tiny swipes
  if (Math.hypot(dx, dy) < 8) return;

  // screen velocity (px/ms)
  const vx = dx / dt;
  const vy = -dy / dt; // upward swipe = positive vy

  // map to 3D velocity in camera space
  const xrCam = renderer.xr.getCamera(camera);
  const basisRight = new THREE.Vector3(1,0,0).applyQuaternion(xrCam.quaternion);
  const basisUp = new THREE.Vector3(0,1,0).applyQuaternion(xrCam.quaternion);
  const basisFwd = new THREE.Vector3(0,0,-1).applyQuaternion(xrCam.quaternion);

  let v = new THREE.Vector3()
    .addScaledVector(basisRight, vx * SWIPE_SPEED_SCALE * 30) // lateral aim
    .addScaledVector(basisUp, vy * SWIPE_SPEED_SCALE * 32)    // arc
    .addScaledVector(basisFwd, BASE_THROW_SPEED + Math.abs(vy) * 2.0); // push forward

  // cap insane speeds
  if (v.length() > MAX_INITIAL_SPEED) v.setLength(MAX_INITIAL_SPEED);

  // spawn ball at camera, slightly forward to avoid clipping
  const origin = new THREE.Vector3().setFromMatrixPosition(xrCam.matrixWorld);
  const startPos = origin.clone().addScaledVector(basisFwd, 0.15).addScaledVector(basisUp, -0.02);

  spawnBall(startPos, v);
}

function spawnBall(position, velocity) {
  const ball = makeBall();
  ball.position.copy(position);
  ball.userData.v = velocity.clone();
  ball.userData.alive = 0;
  scene.add(ball);
  balls.add(ball);

  shots += 1;
  updateHUD();
}

function makeBall() {
  const geo = new THREE.SphereGeometry(BALL_RADIUS, 16, 12);
  const mat = new THREE.MeshStandardMaterial({ color: 0xff8a3c, roughness: 0.6, metalness: 0.0, emissive: 0x1a0a00 });
  const m = new THREE.Mesh(geo, mat);
  m.userData.type = 'ball';
  return m;
}

// ---------- update / scoring -----------------------------------------------

function updateBalls(dt) {
  const toRemove = [];

  // precompute ring plane (center/normal) in world
  const ringCenter = new THREE.Vector3();
  rim.getWorldPosition(ringCenter);
  const ringNormal = new THREE.Vector3(0,1,0) // because rim is rotated X+90°, its local Y maps to world Z; better compute from rim quaternion:
    .copy(new THREE.Vector3(0,0,1))
    .applyQuaternion(rim.getWorldQuaternion(new THREE.Quaternion()))
    .normalize();

  for (const b of balls) {
    // integrate
    b.userData.v.addScaledVector(GRAVITY, dt);
    b.position.addScaledVector(b.userData.v, dt);
    b.userData.alive += dt;

    // simple lifetime cull
    if (b.userData.alive > BALL_LIFETIME) toRemove.push(b);

    // ring pass detection: did we cross the hoop plane this frame?
    // compute signed distances to ring plane at previous and current positions
    if (!b.userData.prevPos) b.userData.prevPos = b.position.clone();
    const prev = b.userData.prevPos;
    const curr = b.position;

    const d0 = ringNormal.dot(prev.clone().sub(ringCenter));
    const d1 = ringNormal.dot(curr.clone().sub(ringCenter));

    // crossed from front to back (or vice versa) near the center?
    if (d0 > 0 && d1 <= 0) {
      // project intersection point onto plane (linear approx)
      const t = d0 / (d0 - d1);
      const hit = new THREE.Vector3().lerpVectors(prev, curr, t);

      // distance from ring center projected into plane
      const radial = hit.clone().sub(ringCenter);
      // remove normal component
      const radialProj = radial.sub(ringNormal.clone().multiplyScalar(ringNormal.dot(radial)));
      const r = radialProj.length();

      if (r <= (RIM_INNER_RADIUS - BALL_RADIUS * 0.6)) {
        // score once per ball
        if (!b.userData.scored) {
          b.userData.scored = true;
          score += 1;
          // small flash
          rim.material.emissive = new THREE.Color(0x331100);
          setTimeout(() => rim.material.emissive = new THREE.Color(0x000000), 120);
          updateHUD();
        }
      }
    }

    // store for next frame
    b.userData.prevPos.copy(b.position);
  }

  for (const b of toRemove) {
    scene.remove(b);
    balls.delete(b);
  }
}

function clearBalls() {
  for (const b of balls) scene.remove(b);
  balls.clear();
}

// ---------- ui / utils ------------------------------------------------------

function resetGame() {
  score = 0; shots = 0;
  placed = false;
  paused = false; $btnPause.textContent = 'pause';
  hoop.visible = false;
  clearBalls();
  $status.textContent = 'find a surface, then tap to place the hoop.';
  updateHUD();
}

function updateHUD() {
  $score.textContent = String(score);
  $shots.textContent = String(shots);
}

function makeReticle() {
  const g1 = new THREE.RingGeometry(0.06, 0.075, 48);
  const m1 = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const ring = new THREE.Mesh(g1, m1);
  ring.rotation.x = -Math.PI / 2;

  const g2 = new THREE.CircleGeometry(0.006, 16);
  const m2 = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const dot = new THREE.Mesh(g2, m2);
  dot.position.y = 0.001; dot.rotation.x = -Math.PI / 2;

  const group = new THREE.Group();
  group.add(ring, dot);
  return group;
}
