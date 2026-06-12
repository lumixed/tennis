/**
 * Player avatars.
 *
 * Stylised on purpose. The avatar auto-positions to the ball, so its job is to
 * make the ball's arrival *legible* — where it is going and when it will be
 * struck — rather than to be anatomically convincing.
 */

import * as THREE from "three";
import { COURT } from "../engine/constants";
import type { Side } from "../engine/scoring";

export type Avatar = {
  group: THREE.Group;
  /** Slide towards a lateral position, easing rather than snapping. */
  moveTowards: (x: number, dt: number) => void;
  /** Kick off a swing animation. */
  swing: (arc: "low-to-high" | "high-to-low" | "overhead" | "flat") => void;
  update: (dt: number) => void;
};

const BODY_HEIGHT = 1.15;
const SHOULDER_Y = 1.35;

export function createAvatar(side: Side, color: number): Avatar {
  const group = new THREE.Group();
  const facing = side === "near" ? 1 : -1;

  const material = new THREE.MeshStandardMaterial({
    color,
    roughness: 0.55,
    metalness: 0.05,
  });

  const legs = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.17, 0.6, 6, 12),
    new THREE.MeshStandardMaterial({ color: 0x1b2733, roughness: 0.8 })
  );
  legs.position.y = 0.46;
  legs.castShadow = true;
  group.add(legs);

  const torso = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.24, BODY_HEIGHT * 0.5, 6, 14),
    material
  );
  torso.position.y = 1.06;
  torso.castShadow = true;
  group.add(torso);

  const head = new THREE.Mesh(
    new THREE.SphereGeometry(0.17, 18, 14),
    new THREE.MeshStandardMaterial({ color: 0xe8c9a0, roughness: 0.7 })
  );
  head.position.y = 1.62;
  head.castShadow = true;
  group.add(head);

  // The arm pivots at the shoulder; the racket hangs off its end.
  const arm = new THREE.Group();
  arm.position.set(0.22 * facing, SHOULDER_Y, 0);
  group.add(arm);

  const upperArm = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.07, 0.42, 5, 10),
    material
  );
  upperArm.position.y = -0.26;
  upperArm.castShadow = true;
  arm.add(upperArm);

  const racket = new THREE.Group();
  racket.position.y = -0.56;
  arm.add(racket);

  const handle = new THREE.Mesh(
    new THREE.CylinderGeometry(0.022, 0.022, 0.22, 8),
    new THREE.MeshStandardMaterial({ color: 0x232b33, roughness: 0.6 })
  );
  handle.position.y = -0.11;
  racket.add(handle);

  const head3d = new THREE.Mesh(
    new THREE.TorusGeometry(0.15, 0.018, 8, 24),
    new THREE.MeshStandardMaterial({ color: 0xf2f7fa, roughness: 0.4 })
  );
  head3d.position.y = -0.36;
  head3d.rotation.y = Math.PI / 2;
  racket.add(head3d);

  const strings = new THREE.Mesh(
    new THREE.CircleGeometry(0.14, 20),
    new THREE.MeshStandardMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.18,
      side: THREE.DoubleSide,
    })
  );
  strings.position.y = -0.36;
  strings.rotation.y = Math.PI / 2;
  racket.add(strings);

  group.position.set(
    0,
    0,
    side === "near" ? -COURT.halfLength - 0.6 : COURT.halfLength + 0.6
  );
  group.rotation.y = side === "near" ? 0 : Math.PI;

  // Swing animation state.
  let swingTime = Infinity;
  let swingFrom = 0;
  let swingTo = 0;
  const SWING_DURATION = 0.42;

  const restAngle = -0.35;
  arm.rotation.x = restAngle;

  return {
    group,

    moveTowards(x, dt) {
      // Ease rather than teleport; the lag reads as the player running.
      const limit = COURT.halfSinglesWidth + 1.6;
      const target = Math.max(-limit, Math.min(limit, x));
      const k = 1 - Math.exp(-6 * dt);
      group.position.x += (target - group.position.x) * k;
    },

    swing(arc) {
      swingTime = 0;
      switch (arc) {
        case "low-to-high":
          swingFrom = 0.9;
          swingTo = -1.5;
          break;
        case "high-to-low":
          swingFrom = -1.3;
          swingTo = 0.6;
          break;
        case "overhead":
          swingFrom = -2.4;
          swingTo = 0.4;
          break;
        default:
          swingFrom = 0.4;
          swingTo = -1.1;
      }
    },

    update(dt) {
      if (swingTime === Infinity) return;
      swingTime += dt;

      if (swingTime >= SWING_DURATION) {
        swingTime = Infinity;
        arm.rotation.x = restAngle;
        arm.rotation.z = 0;
        return;
      }

      const t = swingTime / SWING_DURATION;
      // Fast through contact, slower on the follow-through.
      const eased = t < 0.45 ? (t / 0.45) ** 0.6 : 1 - ((t - 0.45) / 0.55) * 0.25;
      arm.rotation.x = swingFrom + (swingTo - swingFrom) * eased;
      arm.rotation.z = Math.sin(t * Math.PI) * 0.7 * facing;
    },
  };
}
