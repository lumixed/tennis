/**
 * A target ring showing where the ball will bounce.
 *
 * From behind the baseline, depth is the hardest thing to judge: a ball landing
 * at the service line and one landing at the baseline travel almost the same
 * distance across the screen. The marker puts the answer on the court itself.
 *
 * It converges as the ball arrives, so it reads as a countdown as well as a
 * position — the outer ring closing in *is* the time remaining.
 */

import * as THREE from "three";
import { COURT } from "../engine/constants";
import type { Vec3 } from "../engine/vec3";

/** Seconds of lead time at which the ring is drawn at full size. */
const LEAD_SECONDS = 1.1;
/** Ring radius in metres at full lead, and at the moment of the bounce. */
const MAX_RADIUS = 1.5;
const MIN_RADIUS = 0.42;
/** How long the flash lingers after the bounce, in seconds. */
const FLASH_SECONDS = 0.32;

export type LandingMarker = {
  group: THREE.Group;
  /**
   * `secondsUntil` may be negative, meaning the ball has already bounced and
   * the marker is playing out its flash.
   */
  update: (landing: Vec3 | null, secondsUntil: number, dt: number) => void;
  dispose: () => void;
};

export function createLandingMarker(): LandingMarker {
  const group = new THREE.Group();
  group.visible = false;

  // Closing outer ring: the countdown.
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.86, 1, 40),
    new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.75,
      side: THREE.DoubleSide,
      depthWrite: false,
    })
  );
  ring.rotation.x = -Math.PI / 2;
  group.add(ring);

  // Fixed inner disc: the place itself, which must not move as the ring closes.
  const spot = new THREE.Mesh(
    new THREE.CircleGeometry(MIN_RADIUS * 0.5, 24),
    new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.22,
      side: THREE.DoubleSide,
      depthWrite: false,
    })
  );
  spot.rotation.x = -Math.PI / 2;
  group.add(spot);

  const ringMaterial = ring.material as THREE.MeshBasicMaterial;
  const spotMaterial = spot.material as THREE.MeshBasicMaterial;

  let flash = 0;

  return {
    group,

    update(landing, secondsUntil, dt) {
      flash = Math.max(0, flash - dt);

      if (!landing) {
        group.visible = flash > 0;
        if (!group.visible) return;
      } else {
        group.visible = true;
        // Lifted clear of the court lines so it never z-fights with them.
        group.position.set(landing.x, 0.02, landing.z);

        // Landing outside the singles court is a losing shot: colour it as one
        // rather than letting the player discover it a moment later.
        const out =
          Math.abs(landing.x) > COURT.halfSinglesWidth ||
          Math.abs(landing.z) > COURT.halfLength;
        const colour = out ? 0xff6b4a : 0xc8ff3d;
        ringMaterial.color.setHex(colour);
        spotMaterial.color.setHex(colour);

        if (secondsUntil <= 0 && flash === 0) flash = FLASH_SECONDS;
      }

      if (flash > 0) {
        // Bloom outwards on impact, so the bounce has a moment of its own.
        const t = 1 - flash / FLASH_SECONDS;
        const radius = MIN_RADIUS + t * 1.1;
        ring.scale.setScalar(radius);
        ringMaterial.opacity = 0.9 * (1 - t);
        spotMaterial.opacity = 0.3 * (1 - t);
        return;
      }

      const lead = Math.max(0, Math.min(1, secondsUntil / LEAD_SECONDS));
      ring.scale.setScalar(MIN_RADIUS + lead * (MAX_RADIUS - MIN_RADIUS));
      // Fades up as it closes, so a far-off ball is a hint and an imminent one
      // is a demand.
      ringMaterial.opacity = 0.35 + (1 - lead) * 0.5;
      spotMaterial.opacity = 0.12 + (1 - lead) * 0.22;
    },

    dispose() {
      ring.geometry.dispose();
      ringMaterial.dispose();
      spot.geometry.dispose();
      spotMaterial.dispose();
    },
  };
}
