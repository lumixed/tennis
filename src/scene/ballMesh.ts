/**
 * The ball, its glow, its trail, and the shadow that sells its height.
 *
 * The ground shadow matters more than it sounds: from behind the baseline a ball
 * high in the air and a ball at head height project to nearly the same screen
 * position, and the shadow is what disambiguates them.
 */

import * as THREE from "three";
import { BALL } from "../engine/constants";
import type { Vec3 } from "../engine/vec3";

const TRAIL_LENGTH = 34;

/**
 * The ball is drawn larger than life.
 *
 * A regulation ball is 6.7 cm across and the camera sits ~19 m back at the near
 * baseline, which leaves it a couple of pixels wide — unreadable, and the game
 * is entirely about reading the ball. Physics uses the true radius; only the
 * mesh is inflated.
 */
const VISUAL_SCALE = 2.1;

/**
 * Distance at which the ball is drawn at exactly `VISUAL_SCALE`.
 *
 * Roughly the near baseline, so the near half looks true to size and the far
 * half is the part that gets helped.
 */
const REFERENCE_DISTANCE = 19;

/**
 * How hard to fight perspective, 0 (not at all) to 1 (constant screen size).
 *
 * The far baseline sits about 2.2x further from the camera than the near one, so
 * an uncorrected ball is less than half the size exactly where it is hardest to
 * pick out. Full correction would flatten the depth cue entirely, so this only
 * takes most of it back.
 */
const DISTANCE_COMPENSATION = 0.85;
const MAX_DISTANCE_SCALE = 2.4;

/** Glow sprite size, in multiples of the drawn ball radius. */
const GLOW_RADIUS_MULTIPLE = 5.5;

export type BallVisual = {
  group: THREE.Group;
  update: (pos: Vec3, dt: number, camera: THREE.Camera) => void;
  reset: (pos: Vec3) => void;
  dispose: () => void;
};

/**
 * A soft radial falloff, drawn at runtime rather than shipped as a file.
 *
 * Additive blending means the transparent edge fades to nothing on any
 * background, so this reads as a glow over the court and over the dark surround
 * alike.
 */
function createGlowTexture(): THREE.Texture {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;

  const ctx = canvas.getContext("2d")!;
  const gradient = ctx.createRadialGradient(
    size / 2,
    size / 2,
    0,
    size / 2,
    size / 2,
    size / 2
  );
  gradient.addColorStop(0, "rgba(240,255,190,0.95)");
  gradient.addColorStop(0.18, "rgba(226,255,110,0.55)");
  gradient.addColorStop(0.45, "rgba(200,255,61,0.18)");
  gradient.addColorStop(1, "rgba(200,255,61,0)");

  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export function createBallVisual(): BallVisual {
  const group = new THREE.Group();
  const drawnRadius = BALL.radius * VISUAL_SCALE;

  const ball = new THREE.Mesh(
    new THREE.SphereGeometry(drawnRadius, 20, 16),
    new THREE.MeshStandardMaterial({
      color: 0xeaff8a,
      roughness: 0.6,
      // Lifted well above the old value so the ball stays bright even when the
      // key light is raking across it at the far end of the court.
      emissive: 0xb6e02a,
      emissiveIntensity: 0.9,
    })
  );
  ball.castShadow = true;
  group.add(ball);

  const glowTexture = createGlowTexture();
  const glow = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: glowTexture,
      blending: THREE.AdditiveBlending,
      transparent: true,
      // Never occludes the ball or writes into the depth buffer behind it.
      depthWrite: false,
      opacity: 0.85,
    })
  );
  glow.scale.setScalar(drawnRadius * GLOW_RADIUS_MULTIPLE);
  group.add(glow);

  const shadow = new THREE.Mesh(
    new THREE.CircleGeometry(drawnRadius, 16),
    new THREE.MeshBasicMaterial({
      color: 0x000000,
      transparent: true,
      opacity: 0.32,
      depthWrite: false,
    })
  );
  shadow.rotation.x = -Math.PI / 2;
  group.add(shadow);

  const trailPositions = new Float32Array(TRAIL_LENGTH * 3);
  const trailColors = new Float32Array(TRAIL_LENGTH * 3);
  const trailGeometry = new THREE.BufferGeometry();
  trailGeometry.setAttribute(
    "position",
    new THREE.BufferAttribute(trailPositions, 3)
  );
  trailGeometry.setAttribute("color", new THREE.BufferAttribute(trailColors, 3));

  const trail = new THREE.Line(
    trailGeometry,
    new THREE.LineBasicMaterial({
      // Additive with a per-vertex ramp: WebGL ignores line width, so fading
      // brightness along the trail is the only way to give it any shape.
      vertexColors: true,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
    })
  );
  trail.frustumCulled = false;
  group.add(trail);

  const history: Vec3[] = [];
  const cameraPosition = new THREE.Vector3();

  const writeTrail = () => {
    for (let i = 0; i < TRAIL_LENGTH; i++) {
      // Pad the unused head of the buffer with the oldest sample so the line
      // does not shoot back to the origin before the history fills.
      const sample = history[Math.min(i, history.length - 1)] ?? {
        x: 0,
        y: 0,
        z: 0,
      };
      trailPositions[i * 3] = sample.x;
      trailPositions[i * 3 + 1] = sample.y;
      trailPositions[i * 3 + 2] = sample.z;

      // Oldest sample dark, newest bright.
      const age = i / (TRAIL_LENGTH - 1);
      const intensity = age * age;
      trailColors[i * 3] = 0.78 * intensity;
      trailColors[i * 3 + 1] = 1.0 * intensity;
      trailColors[i * 3 + 2] = 0.28 * intensity;
    }
    trailGeometry.attributes.position!.needsUpdate = true;
    trailGeometry.attributes.color!.needsUpdate = true;
  };

  return {
    group,

    update(pos, _dt, camera) {
      ball.position.set(pos.x, pos.y, pos.z);
      glow.position.set(pos.x, pos.y, pos.z);

      // Partly cancel perspective so the ball stays readable down the far end.
      camera.getWorldPosition(cameraPosition);
      const distance = cameraPosition.distanceTo(ball.position);
      const scale = Math.min(
        MAX_DISTANCE_SCALE,
        Math.max(1, (distance / REFERENCE_DISTANCE) ** DISTANCE_COMPENSATION)
      );
      ball.scale.setScalar(scale);
      glow.scale.setScalar(drawnRadius * GLOW_RADIUS_MULTIPLE * scale);

      shadow.position.set(pos.x, 0.012, pos.z);
      // Higher balls cast a larger, fainter shadow.
      const lift = Math.max(0, pos.y - BALL.radius);
      shadow.scale.setScalar((1 + lift * 0.55) * scale);
      (shadow.material as THREE.MeshBasicMaterial).opacity =
        0.34 / (1 + lift * 0.7);

      history.push({ x: pos.x, y: pos.y, z: pos.z });
      if (history.length > TRAIL_LENGTH) history.shift();
      writeTrail();
    },

    reset(pos) {
      history.length = 0;
      for (let i = 0; i < TRAIL_LENGTH; i++) {
        history.push({ x: pos.x, y: pos.y, z: pos.z });
      }
      writeTrail();
      ball.position.set(pos.x, pos.y, pos.z);
      glow.position.set(pos.x, pos.y, pos.z);
    },

    dispose() {
      glowTexture.dispose();
    },
  };
}
