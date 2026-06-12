/**
 * Court geometry, built to the same regulation dimensions the engine uses.
 *
 * Pure presentation: nothing here is consulted by the simulation, so the court
 * can be restyled freely without touching gameplay.
 */

import * as THREE from "three";
import { COURT } from "../engine/constants";

const LINE_WIDTH = 0.05;
const LINE_LIFT = 0.006;

export const PALETTE = {
  surface: 0x1d5a7a,
  surround: 0x14313f,
  line: 0xf2f7fa,
  net: 0x0d1a22,
  netTape: 0xf2f7fa,
  post: 0x2a3b44,
  near: 0xc8ff3d,
  far: 0xff6b4a,
} as const;

function line(
  width: number,
  depth: number,
  x: number,
  z: number,
  material: THREE.Material
): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, 0.01, depth), material);
  mesh.position.set(x, LINE_LIFT, z);
  mesh.receiveShadow = true;
  return mesh;
}

/** The playing surface, its markings, and the net. */
export function createCourt(): THREE.Group {
  const group = new THREE.Group();

  const surround = new THREE.Mesh(
    new THREE.PlaneGeometry(38, 52),
    new THREE.MeshStandardMaterial({ color: PALETTE.surround, roughness: 0.95 })
  );
  surround.rotation.x = -Math.PI / 2;
  surround.position.y = -0.02;
  surround.receiveShadow = true;
  group.add(surround);

  const surface = new THREE.Mesh(
    new THREE.PlaneGeometry(COURT.doublesWidth + 6.4, COURT.length + 12.8),
    new THREE.MeshStandardMaterial({ color: PALETTE.surface, roughness: 0.9 })
  );
  surface.rotation.x = -Math.PI / 2;
  surface.receiveShadow = true;
  group.add(surface);

  const lineMaterial = new THREE.MeshStandardMaterial({
    color: PALETTE.line,
    roughness: 0.7,
  });

  // Baselines and service lines run across the court.
  group.add(
    line(COURT.doublesWidth, LINE_WIDTH, 0, -COURT.halfLength, lineMaterial)
  );
  group.add(
    line(COURT.doublesWidth, LINE_WIDTH, 0, COURT.halfLength, lineMaterial)
  );
  group.add(
    line(COURT.singlesWidth, LINE_WIDTH, 0, -COURT.serviceLine, lineMaterial)
  );
  group.add(
    line(COURT.singlesWidth, LINE_WIDTH, 0, COURT.serviceLine, lineMaterial)
  );

  // Sidelines run the length.
  for (const sign of [-1, 1]) {
    group.add(
      line(
        LINE_WIDTH,
        COURT.length,
        sign * COURT.halfDoublesWidth,
        0,
        lineMaterial
      )
    );
    group.add(
      line(
        LINE_WIDTH,
        COURT.length,
        sign * COURT.halfSinglesWidth,
        0,
        lineMaterial
      )
    );
  }

  // Centre service line and the small centre marks on each baseline.
  group.add(line(LINE_WIDTH, COURT.serviceLine * 2, 0, 0, lineMaterial));
  for (const sign of [-1, 1]) {
    group.add(
      line(LINE_WIDTH, 0.3, 0, sign * (COURT.halfLength - 0.15), lineMaterial)
    );
  }

  group.add(createNet());
  return group;
}

function createNet(): THREE.Group {
  const net = new THREE.Group();
  const width = COURT.netHalfWidth * 2;

  // The cord sags towards the middle, so the mesh is built from strips whose
  // height follows the same curve `netHeightAt` uses.
  const segments = 48;
  const positions: number[] = [];
  const indices: number[] = [];

  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const x = -COURT.netHalfWidth + t * width;
    const sag = Math.abs(x) / COURT.netHalfWidth;
    const height =
      COURT.netHeightCentre + (COURT.netHeightPost - COURT.netHeightCentre) * sag;
    positions.push(x, 0, 0, x, height, 0);
  }

  for (let i = 0; i < segments; i++) {
    const a = i * 2;
    indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positions, 3)
  );
  geometry.setIndex(indices);
  geometry.computeVertexNormals();

  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({
      color: PALETTE.net,
      transparent: true,
      opacity: 0.62,
      side: THREE.DoubleSide,
      roughness: 1,
    })
  );
  net.add(mesh);

  // White tape along the top edge.
  const tapePoints: THREE.Vector3[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const x = -COURT.netHalfWidth + t * width;
    const sag = Math.abs(x) / COURT.netHalfWidth;
    const height =
      COURT.netHeightCentre + (COURT.netHeightPost - COURT.netHeightCentre) * sag;
    tapePoints.push(new THREE.Vector3(x, height, 0));
  }
  const tape = new THREE.Mesh(
    new THREE.TubeGeometry(
      new THREE.CatmullRomCurve3(tapePoints),
      segments,
      0.028,
      6,
      false
    ),
    new THREE.MeshStandardMaterial({ color: PALETTE.netTape, roughness: 0.6 })
  );
  net.add(tape);

  const postMaterial = new THREE.MeshStandardMaterial({
    color: PALETTE.post,
    roughness: 0.5,
    metalness: 0.3,
  });
  for (const sign of [-1, 1]) {
    const post = new THREE.Mesh(
      new THREE.CylinderGeometry(0.06, 0.06, COURT.netHeightPost + 0.1, 12),
      postMaterial
    );
    post.position.set(
      sign * COURT.netHalfWidth,
      (COURT.netHeightPost + 0.1) / 2,
      0
    );
    post.castShadow = true;
    net.add(post);
  }

  return net;
}
