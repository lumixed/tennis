/**
 * Player avatars.
 *
 * Stylised on purpose. The avatar auto-positions to the ball, so its job is to
 * make the ball's arrival *legible* — where it is going and when it will be
 * struck — rather than to be anatomically convincing.
 *
 * It does have to look like it is *moving*, though. A figure that slides
 * sideways without its legs changing reads as a bug rather than as a player
 * covering the court, which undermines the auto-positioning the whole design
 * rests on.
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

const HIP_Y = 0.92;
const SHOULDER_Y = 1.35;

/** Lateral speed, m/s, at which the run cycle is at full amplitude. */
const FULL_STRIDE_SPEED = 4.5;

export function createAvatar(side: Side, color: number): Avatar {
  const group = new THREE.Group();
  const facing = side === "near" ? 1 : -1;

  const material = new THREE.MeshStandardMaterial({
    color,
    roughness: 0.55,
    metalness: 0.05,
  });
  const kitMaterial = new THREE.MeshStandardMaterial({
    color: 0x1b2733,
    roughness: 0.8,
  });

  /**
   * Everything above the hips, so the torso can lean without dragging the legs
   * off the ground with it.
   */
  const body = new THREE.Group();
  body.position.y = HIP_Y;
  group.add(body);

  const torso = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.24, 0.58, 6, 14),
    material
  );
  torso.position.y = 0.14;
  torso.castShadow = true;
  body.add(torso);

  const head = new THREE.Mesh(
    new THREE.SphereGeometry(0.17, 18, 14),
    new THREE.MeshStandardMaterial({ color: 0xe8c9a0, roughness: 0.7 })
  );
  head.position.y = 0.7;
  head.castShadow = true;
  body.add(head);

  // Legs pivot at the hip so they can scissor.
  const makeLeg = (offset: number) => {
    const pivot = new THREE.Group();
    pivot.position.set(offset, HIP_Y, 0);
    const limb = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.135, 0.5, 5, 10),
      kitMaterial
    );
    limb.position.y = -0.42;
    limb.castShadow = true;
    pivot.add(limb);
    group.add(pivot);
    return pivot;
  };

  const legLeft = makeLeg(-0.12);
  const legRight = makeLeg(0.12);

  // The arm pivots at the shoulder; the racket hangs off its end.
  const arm = new THREE.Group();
  arm.position.set(0.22 * facing, SHOULDER_Y - HIP_Y, 0);
  body.add(arm);

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

  const rim = new THREE.Mesh(
    new THREE.TorusGeometry(0.15, 0.018, 8, 24),
    new THREE.MeshStandardMaterial({ color: 0xf2f7fa, roughness: 0.4 })
  );
  rim.position.y = -0.36;
  rim.rotation.y = Math.PI / 2;
  racket.add(rim);

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

  // Motion state.
  let velocityX = 0;
  let runPhase = 0;
  // Offset by side so the two players do not bob in lockstep, without
  // reaching for randomness the rest of the project deliberately avoids.
  let idlePhase = side === "near" ? 0 : Math.PI * 0.6;

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
      if (dt <= 0) return;
      // Ease rather than teleport; the lag reads as the player running.
      const limit = COURT.halfSinglesWidth + 1.6;
      const target = Math.max(-limit, Math.min(limit, x));
      const previous = group.position.x;
      const k = 1 - Math.exp(-6 * dt);
      group.position.x += (target - previous) * k;

      // Smoothed so the stride does not stutter on a single slow frame.
      const instant = (group.position.x - previous) / dt;
      velocityX += (instant - velocityX) * Math.min(1, dt * 12);
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
      const speed = Math.abs(velocityX);
      const effort = Math.min(1, speed / FULL_STRIDE_SPEED);

      // Legs scissor in the frontal plane, which is the plane the camera sees
      // from behind the baseline — a fore-and-aft stride would be invisible.
      runPhase += (4 + effort * 12) * dt;
      const stride = Math.sin(runPhase) * effort * 0.42;
      legLeft.rotation.z = stride;
      legRight.rotation.z = -stride;

      // Idle: a small split-step bob, so a waiting player is not a statue.
      idlePhase += dt * 3.2;
      const bob = Math.sin(idlePhase) * 0.012 * (1 - effort);
      const strideBob = Math.abs(Math.sin(runPhase)) * effort * 0.045;
      group.position.y = bob + strideBob;

      // Lean into the run. Computed in the avatar's own frame, since the far
      // player is rotated to face the other way.
      const localVelocity = velocityX * facing;
      body.rotation.z = -Math.max(-0.32, Math.min(0.32, localVelocity * 0.07));

      if (swingTime === Infinity) {
        arm.rotation.x = restAngle;
        arm.rotation.z = 0;
        return;
      }

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
