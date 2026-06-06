import * as THREE from 'three';

// Lay out a club-style stage: floor, three-sided walls, deck, drum riser,
// two truss towers, and one overhead truss bar spanning between them. All
// geometry is added to `stageGroup` (which the caller adds to the scene),
// so toggling its visibility hides everything stage-related in one shot
// when the user switches the scene to an imported OBJ.
//
// Lights stay outside the group: they apply to everything regardless of
// which scene is active.
//
// SCALE controls the overall venue size. 1.0 = the original tight club
// layout; 1.5 = a noticeably larger room. Everything that describes the
// room (walls, deck, truss, slot positions, obstacles) is scaled in lockstep
// so the proportions stay consistent.
const SCALE = 1.5;
const S = (n) => n * SCALE;

export function createStage(scene) {
  const stageGroup = new THREE.Group();
  stageGroup.name = 'default-stage';
  scene.add(stageGroup);

  // Stronger defaults so the room is clearly visible when all DMX is dark.
  // Both are user-adjustable via the HUD panel.
  const ambient = new THREE.AmbientLight(0x8a92a8, 1.4);
  scene.add(ambient);
  const key = new THREE.DirectionalLight(0xeaf0ff, 0.8);
  key.position.set(4, 8, 6);
  scene.add(key);

  // Floor — light grey so the grid reads against it. The plane is huge
  // already; we still scale it so it's never smaller than the walls.
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(S(60), S(60)),
    new THREE.MeshStandardMaterial({ color: 0x3a4050, roughness: 0.85, metalness: 0.05 })
  );
  floor.rotation.x = -Math.PI / 2;
  stageGroup.add(floor);

  // Grid — keep 1 m grid spacing so the SCALE expands the count, not the
  // cell size (so distances stay legible).
  const grid = new THREE.GridHelper(S(60), Math.round(S(60)), 0x9aa4bd, 0x556070);
  grid.position.y = 0.002;
  stageGroup.add(grid);

  // Stage deck (raised platform behind y=0)
  const deck = new THREE.Mesh(
    new THREE.BoxGeometry(S(10), S(0.2), S(5)),
    new THREE.MeshStandardMaterial({ color: 0x4a5060, roughness: 0.9 })
  );
  const DECK_TOP_Y = S(0.2);
  deck.position.set(0, DECK_TOP_Y / 2, S(-2.5));
  stageGroup.add(deck);

  // Walls — three sides (back + left + right). Audience side (+Z) stays open.
  // Same material across all three so they read as one room.
  const wallMat = new THREE.MeshStandardMaterial({
    color: 0x6a7080, roughness: 0.95, side: THREE.DoubleSide,
  });
  const WALL_HEIGHT = S(6);
  const WALL_BACK_Z = S(-5);
  const WALL_BACK_WIDTH = S(14);
  const WALL_SIDE_X = S(7);
  const WALL_SIDE_LENGTH = S(10);   // back-wall (-5*SCALE) to z=+5*SCALE
  // Back wall
  const wall = new THREE.Mesh(new THREE.PlaneGeometry(WALL_BACK_WIDTH, WALL_HEIGHT), wallMat);
  wall.position.set(0, WALL_HEIGHT / 2, WALL_BACK_Z);
  stageGroup.add(wall);
  // Stage-left wall — faces +X (toward stage centre)
  const leftWall = new THREE.Mesh(new THREE.PlaneGeometry(WALL_SIDE_LENGTH, WALL_HEIGHT), wallMat);
  leftWall.position.set(-WALL_SIDE_X, WALL_HEIGHT / 2, WALL_BACK_Z + WALL_SIDE_LENGTH / 2);
  leftWall.rotation.y = Math.PI / 2;
  stageGroup.add(leftWall);
  // Stage-right wall — faces -X
  const rightWall = new THREE.Mesh(new THREE.PlaneGeometry(WALL_SIDE_LENGTH, WALL_HEIGHT), wallMat);
  rightWall.position.set(WALL_SIDE_X, WALL_HEIGHT / 2, WALL_BACK_Z + WALL_SIDE_LENGTH / 2);
  rightWall.rotation.y = -Math.PI / 2;
  stageGroup.add(rightWall);

  // Drum riser
  const RISER_HEIGHT = S(0.4);
  const riser = new THREE.Mesh(
    new THREE.BoxGeometry(S(2.5), RISER_HEIGHT, S(2)),
    new THREE.MeshStandardMaterial({ color: 0x52596a, roughness: 0.85 })
  );
  riser.position.set(0, DECK_TOP_Y + RISER_HEIGHT / 2, S(-3.5));
  stageGroup.add(riser);

  // Trussing
  const trussMat = new THREE.MeshStandardMaterial({
    color: 0x888a90, roughness: 0.45, metalness: 0.7,
  });
  const TRUSS_TOWER_HEIGHT = S(5);
  const TRUSS_TOWER_X = S(5.5);
  const TRUSS_SPAN_LENGTH = S(11);
  const TRUSS_SPAN_Y = S(4.95);
  const TRUSS_SPAN_Z_FRONT = S(-2);
  const TRUSS_SPAN_Z_BACK  = S(-2.5);
  for (const x of [-TRUSS_TOWER_X, TRUSS_TOWER_X]) {
    const tower = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, TRUSS_TOWER_HEIGHT, 12), trussMat);
    tower.position.set(x, TRUSS_TOWER_HEIGHT / 2, TRUSS_SPAN_Z_FRONT);
    stageGroup.add(tower);
  }
  const span = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, TRUSS_SPAN_LENGTH, 12), trussMat);
  span.rotation.z = Math.PI / 2;
  span.position.set(0, TRUSS_SPAN_Y, TRUSS_SPAN_Z_FRONT);
  stageGroup.add(span);

  const spanBack = span.clone();
  spanBack.position.z = TRUSS_SPAN_Z_BACK;
  stageGroup.add(spanBack);

  // Audience marker — moved further into the audience area so the bigger
  // room still has visible orientation cue.
  const cone = new THREE.Mesh(
    new THREE.ConeGeometry(0.12, 0.3, 16),
    new THREE.MeshStandardMaterial({ color: 0x2a2a30, roughness: 0.9 })
  );
  cone.position.set(0, 0.15, S(7));
  cone.rotation.x = Math.PI;
  stageGroup.add(cone);

  // Static collision shapes for the drag controller.
  const obstacles = [
    { id: 'deck',       cx:  0, cz: S(-2.5), hw: S(5),    hd: S(2.5), angle: 0, walkable: true,  yTop: DECK_TOP_Y },
    { id: 'riser',      cx:  0, cz: S(-3.5), hw: S(1.25), hd: S(1.0), angle: 0, walkable: true,  yTop: DECK_TOP_Y + RISER_HEIGHT },
    { id: 'wall-back',  cx:  0, cz: WALL_BACK_Z, hw: WALL_BACK_WIDTH / 2, hd: 0.1, angle: 0, walkable: false },
    { id: 'wall-left',  cx: -WALL_SIDE_X, cz: WALL_BACK_Z + WALL_SIDE_LENGTH / 2, hw: 0.1, hd: WALL_SIDE_LENGTH / 2, angle: 0, walkable: false },
    { id: 'wall-right', cx:  WALL_SIDE_X, cz: WALL_BACK_Z + WALL_SIDE_LENGTH / 2, hw: 0.1, hd: WALL_SIDE_LENGTH / 2, angle: 0, walkable: false },
  ];

  // Truss slots — child of stageGroup so they hide together
  const trussSlots = [];
  const slotMat = new THREE.MeshBasicMaterial({
    color: 0x6fa0ff, transparent: true, opacity: 0.55,
    toneMapped: false, depthWrite: false,
  });
  const slotXs = [-4.5, -3, -1.5, 0, 1.5, 3, 4.5].map(S);
  const slotZs = [TRUSS_SPAN_Z_FRONT, TRUSS_SPAN_Z_BACK];
  const SLOT_RING_Y = TRUSS_SPAN_Y - 0.12;     // hang just below the truss bar
  const SLOT_FIXTURE_Y = TRUSS_SPAN_Y - 0.45;  // body roughly half a metre below
  for (const z of slotZs) {
    for (const x of slotXs) {
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(0.14, 0.012, 8, 24),
        slotMat.clone(),
      );
      ring.rotation.x = Math.PI / 2;
      ring.position.set(x, SLOT_RING_Y, z);
      ring.userData.isSlotMarker = true;
      const line = new THREE.Mesh(
        new THREE.CylinderGeometry(0.005, 0.005, 0.12, 6),
        slotMat.clone(),
      );
      line.position.set(x, SLOT_RING_Y + 0.06, z);
      ring.add(line);
      line.raycast = () => {};
      line.userData.isSlotMarker = true;
      stageGroup.add(ring);
      trussSlots.push({
        x, y: SLOT_FIXTURE_Y, z,
        marker: ring,
        line,
        occupiedBy: null,
        id: `slot_${z.toFixed(1)}_${x.toFixed(1)}`,
      });
    }
  }

  return { stageGroup, ambient, key, obstacles, trussSlots };
}
