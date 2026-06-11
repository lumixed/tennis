/**
 * Scene assembly and the render half of the loop.
 *
 * Reads engine state and reacts to engine events. Holds no game logic of its
 * own — if this file were deleted the match would still play out correctly,
 * just invisibly.
 */

import * as THREE from "three";
import { COURT } from "../engine/constants";
import type { RallyEvent } from "../engine/rally";
import type { Side } from "../engine/scoring";
import type { ShotKind } from "../engine/shotTypes";
import type { Session } from "../game/session";
import { createAvatar, type Avatar } from "./avatar";
import { createBallVisual } from "./ballMesh";
import { createCourt, PALETTE } from "./court";

/** Which swing animation each resolved shot should play. */
const KIND_TO_ARC: Record<ShotKind, Parameters<Avatar["swing"]>[0]> = {
  topspin: "low-to-high",
  lob: "low-to-high",
  drive: "flat",
  slice: "high-to-low",
  smash: "overhead",
  serve: "overhead",
};

export type GameScene = {
  render: (session: Session, dt: number) => void;
  resize: (width: number, height: number) => void;
  dispose: () => void;
};

/**
 * Build the scene into `container`.
 *
 * The canvas is created here rather than passed in, so every scene owns a fresh
 * one. Reusing a single canvas element meant each remount built a second
 * WebGLRenderer on a context whose resources the previous `dispose()` had just
 * released — React StrictMode remounts every effect in development, and the
 * result was an intermittently black, half-drawn court.
 */
export function createGameScene(container: HTMLElement): GameScene {
  const canvas = document.createElement("canvas");
  canvas.className = "scene-canvas";
  container.appendChild(canvas);

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    powerPreference: "high-performance",
  });
  // Capped at 1.5 rather than 2: on a retina display that is the difference
  // between a 2560x1440 and a 1920x1080 buffer, roughly half the fragment work,
  // and at this flat-shaded art style the difference is not visible.
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x070b10);
  // The far baseline sits ~38 m from the camera, so fog has to start beyond
  // that or the opponent's half sinks into the background.
  scene.fog = new THREE.Fog(0x070b10, 62, 125);

  // Broadcast framing: high behind the baseline looking down the court. Low and
  // close, the near avatar fills a third of the screen and hides the play.
  const camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 250);
  const CAMERA_HOME = new THREE.Vector3(0, 11.5, -26.5);
  const CAMERA_TARGET = new THREE.Vector3(0, 0.6, 1.5);
  camera.position.copy(CAMERA_HOME);
  camera.lookAt(CAMERA_TARGET);

  scene.add(new THREE.AmbientLight(0xb8d4e6, 0.75));

  const key = new THREE.DirectionalLight(0xffffff, 2.1);
  key.position.set(9, 22, -4);
  key.castShadow = true;
  // 1024 is plenty for soft blob shadows and a quarter of the shadow-pass cost.
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.left = -20;
  key.shadow.camera.right = 20;
  key.shadow.camera.top = 24;
  key.shadow.camera.bottom = -24;
  key.shadow.camera.far = 60;
  scene.add(key);

  const rim = new THREE.DirectionalLight(0x6fd4ff, 0.75);
  rim.position.set(-12, 9, 14);
  scene.add(rim);

  // Lifts the far half, which the key light rakes across at a shallow angle.
  const fill = new THREE.DirectionalLight(0xdfeeff, 0.85);
  fill.position.set(-4, 14, 26);
  scene.add(fill);

  scene.add(createCourt());

  const avatars: Record<Side, Avatar> = {
    near: createAvatar("near", PALETTE.near),
    far: createAvatar("far", PALETTE.far),
  };
  scene.add(avatars.near.group, avatars.far.group);

  const ball = createBallVisual();
  scene.add(ball.group);

  // Camera shake, driven by engine events.
  let shake = 0;

  const handleEvents = (events: RallyEvent[]) => {
    for (const event of events) {
      if (event.type === "hit") {
        avatars[event.by].swing(KIND_TO_ARC[event.kind]);
        shake = Math.min(1, shake + 0.18);
      } else if (event.type === "serve") {
        avatars[event.by].swing("overhead");
      } else if (event.type === "bounce") {
        shake = Math.min(1, shake + 0.05);
      }
    }
  };

  return {
    render(session, dt) {
      handleEvents(session.events);

      const state = session.state;
      ball.update(state.ball.pos, dt, camera);

      // Each avatar tracks the ball when it is theirs to play, and recentres
      // otherwise — the auto-positioning the whole design rests on.
      for (const side of ["near", "far"] as const) {
        const avatar = avatars[side];
        const isStriker = state.strike?.striker === side;
        const target = isStriker
          ? (state.strike?.contact.x ?? 0)
          : state.ball.pos.x * 0.25;
        avatar.moveTowards(target, dt);
        avatar.update(dt);
      }

      shake = Math.max(0, shake - dt * 2.4);
      const wobble = shake * shake * 0.14;
      const now = performance.now();
      camera.position.set(
        CAMERA_HOME.x + Math.sin(now * 0.037) * wobble * 1.4,
        CAMERA_HOME.y + Math.sin(now * 0.05) * wobble,
        CAMERA_HOME.z
      );

      // Drift the aim gently with play so the court does not feel static.
      camera.lookAt(
        CAMERA_TARGET.x + state.ball.pos.x * 0.1,
        CAMERA_TARGET.y,
        CAMERA_TARGET.z
      );

      renderer.render(scene, camera);
    },

    resize(width, height) {
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height, false);
    },

    dispose() {
      renderer.dispose();
      canvas.remove();
      ball.dispose();

      // Matches anything carrying GPU resources, not just Mesh: the ball's glow
      // is a Sprite and its trail is a Line, and both were being leaked.
      scene.traverse((object) => {
        const holder = object as Partial<THREE.Mesh>;
        holder.geometry?.dispose();
        const material = holder.material;
        if (Array.isArray(material)) material.forEach((m) => m.dispose());
        else material?.dispose();
      });
    },
  };
}

/** Useful for the HUD: how far the near player is from the singles sideline. */
export const courtHalfWidth = COURT.halfSinglesWidth;
