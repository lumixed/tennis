/**
 * The ball, its trail, and the shadow that sells its height.
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
 * A regulation ball is 6.7 cm across and the camera sits ~30 m back, which
 * leaves it a couple of pixels wide — unreadable, and the game is entirely about
 * reading the ball. Physics uses the true radius; only the mesh is inflated.
 */
const VISUAL_SCALE = 2.1;

export type BallVisual = {
  group: THREE.Group;
  update: (pos: Vec3, dt: number) => void;
  reset: (pos: Vec3) => void;
};

export function createBallVisual(): BallVisual {
  const group = new THREE.Group();

  const ball = new THREE.Mesh(
    new THREE.SphereGeometry(BALL.radius * VISUAL_SCALE, 20, 16),
    new THREE.MeshStandardMaterial({
      color: 0xd7f24a,
      roughness: 0.75,
      emissive: 0x2a3a08,
    })
  );
  ball.castShadow = true;
  group.add(ball);

  const shadow = new THREE.Mesh(
    new THREE.CircleGeometry(BALL.radius * VISUAL_SCALE, 16),
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
  const trailGeometry = new THREE.BufferGeometry();
  trailGeometry.setAttribute(
    "position",
    new THREE.BufferAttribute(trailPositions, 3)
  );
  const trail = new THREE.Line(
    trailGeometry,
    new THREE.LineBasicMaterial({
      color: 0xeaff7a,
      transparent: true,
      opacity: 0.75,
    })
  );
  trail.frustumCulled = false;
  group.add(trail);

  const history: Vec3[] = [];

  const writeTrail = () => {
    for (let i = 0; i < TRAIL_LENGTH; i++) {
      // Pad the unused head of the buffer with the oldest sample so the line
      // does not shoot back to the origin before the history fills.
      const sample = history[Math.min(i, history.length - 1)] ?? { x: 0, y: 0, z: 0 };
      trailPositions[i * 3] = sample.x;
      trailPositions[i * 3 + 1] = sample.y;
      trailPositions[i * 3 + 2] = sample.z;
    }
    trailGeometry.attributes.position!.needsUpdate = true;
  };

  return {
    group,

    update(pos) {
      ball.position.set(pos.x, pos.y, pos.z);

      shadow.position.set(pos.x, 0.012, pos.z);
      // Higher balls cast a larger, fainter shadow.
      const lift = Math.max(0, pos.y - BALL.radius);
      const scale = 1 + lift * 0.55;
      shadow.scale.setScalar(scale);
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
    },
  };
}
