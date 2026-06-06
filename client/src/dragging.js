import * as THREE from 'three';

// Oriented bounding box on the XZ plane for floor-level collision.
//
// - Pars: square 0.32×0.32, no rotation (they're symmetric around their
//   vertical axis even when yawed — yaw only affects the beam direction)
// - Horizontal bars: long rectangle, rotated by fixture.yaw around world Y
// - Vertical bars: square 0.32×0.32 (the cross-section), no rotation
//
// We pass the proposed center explicitly so we can probe candidate positions
// during drag without mutating the fixture state.
function obbFor(f, cx, cz) {
  let hw, hd, angle = 0;
  if (f.kind === 'bar' && f.orientation === 'horizontal') {
    hw = (f.length || 1) / 2 + 0.05;
    hd = 0.1;
    angle = f.yaw || 0;
  } else {
    hw = hd = 0.32;
  }
  const c = Math.cos(angle), s = Math.sin(angle);
  // Three's right-handed Y-up: a +yaw around Y maps local +X to world (cos,-sin)
  // in the XZ plane, and local +Z to world (sin, cos).
  return {
    cx, cz, hw, hd,
    ax: { x:  c, z: -s },   // local X axis in world XZ
    az: { x:  s, z:  c },   // local Z axis in world XZ
  };
}

function dot2(ax, az, bx, bz) { return ax * bx + az * bz; }

// SAT overlap test on a single axis (nx, nz must be a unit vector).
// Returns penetration depth (positive = overlap, ≤0 = separated).
function obbOverlapOnAxis(A, B, nx, nz) {
  const rA = Math.abs(A.hw * dot2(A.ax.x, A.ax.z, nx, nz))
           + Math.abs(A.hd * dot2(A.az.x, A.az.z, nx, nz));
  const rB = Math.abs(B.hw * dot2(B.ax.x, B.ax.z, nx, nz))
           + Math.abs(B.hd * dot2(B.az.x, B.az.z, nx, nz));
  const d = dot2(A.cx - B.cx, A.cz - B.cz, nx, nz);
  return { overlap: (rA + rB) - Math.abs(d), signedD: d };
}

// MTV: return the smallest push that takes A out of B, or null if separated.
function resolveOBB(A, B) {
  const axes = [A.ax, A.az, B.ax, B.az];
  let minOverlap = Infinity, mtvNx = 0, mtvNz = 0;
  for (const ax of axes) {
    const r = obbOverlapOnAxis(A, B, ax.x, ax.z);
    if (r.overlap <= 0) return null; // separating axis — no collision
    if (r.overlap < minOverlap) {
      minOverlap = r.overlap;
      // Push A in the direction from B toward A's center on this axis
      const sgn = r.signedD >= 0 ? 1 : -1;
      mtvNx = ax.x * sgn;
      mtvNz = ax.z * sgn;
    }
  }
  return { dx: mtvNx * minOverlap, dz: mtvNz * minOverlap };
}

// Build an OBB from a raw obstacle descriptor.
function obbFromObstacle(o) {
  const c = Math.cos(o.angle || 0), s = Math.sin(o.angle || 0);
  return {
    cx: o.cx, cz: o.cz, hw: o.hw, hd: o.hd,
    ax: { x:  c, z: -s },
    az: { x:  s, z:  c },
  };
}

// Point-in-OBB test (the fixture's CENTER is enough — the base disc is small).
function pointInObstacle(px, pz, o) {
  if (!o.angle) {
    return Math.abs(px - o.cx) <= o.hw && Math.abs(pz - o.cz) <= o.hd;
  }
  const c = Math.cos(-o.angle), s = Math.sin(-o.angle);
  const dx = px - o.cx, dz = pz - o.cz;
  const lx = dx * c - dz * s;
  const lz = dx * s + dz * c;
  return Math.abs(lx) <= o.hw && Math.abs(lz) <= o.hd;
}

// What Y should the fixture sit at if its center is at (x, z)? Highest yTop
// of any walkable obstacle containing the point, falling back to 0 (floor).
function computeStandingY(walkable, x, z) {
  let y = 0;
  for (const o of walkable) {
    if (pointInObstacle(x, z, o) && o.yTop > y) y = o.yTop;
  }
  return y;
}

// Y-tolerance for considering two fixtures "at the same level" for collision.
// Anything bigger and we treat them as vertically separated (e.g. one on the
// floor, one on the deck) and let them pass over each other in XZ.
const SAME_LEVEL_TOL = 0.1;

// Resolve overlaps between a candidate position for `active` and other
// floor-mounted fixtures + non-walkable obstacles. Walkable obstacles do NOT
// block — instead they raise the fixture's Y to their top surface so the
// fixture "climbs" onto them.
function resolveCollisions(active, fixtures, obstacles, x, z) {
  const walkable = obstacles.filter((o) => o.walkable);
  const blocking = obstacles.filter((o) => !o.walkable).map(obbFromObstacle);

  let nx = x, nz = z;
  let y = computeStandingY(walkable, nx, nz);

  for (let pass = 0; pass < 4; pass++) {
    let collided = false;
    const A = obbFor(active, nx, nz);
    // Only collide with fixtures roughly at the same vertical level
    for (const other of fixtures) {
      if (other === active) continue;
      if (other.mount !== 'floor') continue;
      if (Math.abs(y - other.group.position.y) > SAME_LEVEL_TOL) continue;
      const B = obbFor(other, other.group.position.x, other.group.position.z);
      const mtv = resolveOBB(A, B);
      if (mtv) {
        nx += mtv.dx; nz += mtv.dz;
        A.cx = nx; A.cz = nz;
        collided = true;
      }
    }
    // Walls and other non-walkable obstacles always block in XZ
    for (const B of blocking) {
      const mtv = resolveOBB(A, B);
      if (mtv) {
        nx += mtv.dx; nz += mtv.dz;
        A.cx = nx; A.cz = nz;
        collided = true;
      }
    }
    // After XZ resolution, recompute standing height — moving might have
    // climbed onto or dropped off a deck.
    y = computeStandingY(walkable, nx, nz);
    if (!collided) break;
  }

  return { x: nx, y, z: nz };
}

// Custom drag controller for floor-mounted fixtures.
//
// Constraints:
//   - Only fixtures with `mount === 'floor'` are pickable
//   - Drag is locked to the XZ plane at the fixture's current Y. The fixture
//     never lifts or sinks.
//   - OrbitControls is disabled while dragging, otherwise rotating the camera
//     fights the drag
//
// We pick by recursive raycast against each draggable fixture's root group
// (so the user can click anywhere on the body / base / segments), then walk
// up the parent chain to find which fixture was hit.
// Pixel distance the cursor needs to move between pointerdown and pointerup
// for the gesture to count as a drag rather than a click.
const CLICK_THRESHOLD_PX = 5;

export function setupDragging({ renderer, camera, controls, fixtures, obstacles = [], slots = [], models = [], onSelect, onSlotClick, onSelectModel }) {
  const dom = renderer.domElement;
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const plane = new THREE.Plane();
  const planeNormal = new THREE.Vector3(0, 1, 0);
  const intersection = new THREE.Vector3();
  const offset = new THREE.Vector3();

  let hovered = null;
  // Candidate fixture (or null) under cursor at pointerdown — held in
  // suspense until pointerup or threshold is crossed.
  let candidate = null;
  let dragStarted = false;
  let downX = 0, downY = 0;
  let activePointerId = null;

  // Placement mode — entered via startPlacement(). While active, the pointer
  // acts as a one-shot "click to place here" gesture, raycasting against
  // the supplied targets. Normal fixture pick/drag is suspended.
  let placement = null;     // { targets: Mesh[], onPlace, onCancel }
  // Drag plane Y stays pinned to the fixture's Y at grab-time so the cursor
  // → XZ math stays consistent even as the fixture climbs/descends decks.
  let dragPlaneY = 0;

  function setPointer(e) {
    const rect = dom.getBoundingClientRect();
    pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  }

  // Raycast against ALL fixtures (floor + truss), then extra models, then
  // visible slot markers. Returns { kind: 'fixture', fixture },
  // { kind: 'model', model }, { kind: 'slot', slot }, or null. Fixtures take
  // priority over models (a fixture standing on a model should still be the
  // pick target), and both take priority over slots.
  function pick() {
    raycaster.setFromCamera(pointer, camera);
    if (fixtures.length > 0) {
      const roots = fixtures.map((f) => f.group);
      const hits = raycaster.intersectObjects(roots, true);
      if (hits.length > 0) {
        let obj = hits[0].object;
        while (obj && !roots.includes(obj)) obj = obj.parent;
        if (obj) {
          const fixture = fixtures.find((f) => f.group === obj);
          if (fixture) return { kind: 'fixture', fixture };
        }
      }
    }
    if (models.length > 0) {
      const roots = models.map((m) => m.group);
      const hits = raycaster.intersectObjects(roots, true);
      if (hits.length > 0) {
        let obj = hits[0].object;
        while (obj && !roots.includes(obj)) obj = obj.parent;
        if (obj) {
          const model = models.find((m) => m.group === obj);
          if (model) return { kind: 'model', model };
        }
      }
    }
    if (slots.length > 0) {
      const markers = slots.filter((s) => s.marker.visible).map((s) => s.marker);
      if (markers.length > 0) {
        const hits = raycaster.intersectObjects(markers, false);
        if (hits.length > 0) {
          const slot = slots.find((s) => s.marker === hits[0].object);
          if (slot) return { kind: 'slot', slot };
        }
      }
    }
    return null;
  }

  function hoverCursor(h) {
    if (!h) return 'default';
    if (h.kind === 'slot') return 'pointer';
    if (h.kind === 'model') return 'grab';
    return h.fixture?.mount === 'floor' ? 'grab' : 'pointer';
  }

  function setCursor(c) { dom.style.cursor = c; }

  // Floor fixtures and extra models are draggable on the XZ plane; truss
  // fixtures and slots are not.
  function isDraggable(c) {
    if (!c) return false;
    if (c.kind === 'model') return true;
    return c.kind === 'fixture' && c.fixture.mount === 'floor';
  }

  // The root THREE.Group that a draggable candidate moves.
  function candidateGroup(c) {
    if (c?.kind === 'fixture') return c.fixture.group;
    if (c?.kind === 'model') return c.model.group;
    return null;
  }

  function beginDrag() {
    if (!isDraggable(candidate)) return false;
    const group = candidateGroup(candidate);
    dragStarted = true;
    controls.enabled = false;
    dragPlaneY = group.position.y;
    setCursor('grabbing');
    raycaster.setFromCamera(pointer, camera);
    plane.setFromNormalAndCoplanarPoint(
      planeNormal,
      new THREE.Vector3(0, dragPlaneY, 0),
    );
    if (raycaster.ray.intersectPlane(plane, intersection)) {
      offset.set(
        intersection.x - group.position.x,
        0,
        intersection.z - group.position.z,
      );
    }
    if (activePointerId != null) {
      try { dom.setPointerCapture(activePointerId); } catch {}
    }
    return true;
  }

  // Run a single raycast against the active placement targets. Returns the
  // first hit that isn't a slot marker, or null.
  function raycastPlacement() {
    if (!placement) return null;
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects(placement.targets, true);
    for (const h of hits) {
      // Skip slot rings + their child line
      if (h.object.userData?.isSlotMarker) continue;
      return h;
    }
    return null;
  }

  dom.addEventListener('pointermove', (e) => {
    setPointer(e);
    // Placement mode: update cursor based on hover-over-valid-target
    if (placement) {
      setCursor(raycastPlacement() ? 'crosshair' : 'not-allowed');
      return;
    }
    // Mid-drag: move the fixture or model.
    if (dragStarted && isDraggable(candidate)) {
      const group = candidateGroup(candidate);
      raycaster.setFromCamera(pointer, camera);
      plane.setFromNormalAndCoplanarPoint(
        planeNormal,
        new THREE.Vector3(0, dragPlaneY, 0),
      );
      if (raycaster.ray.intersectPlane(plane, intersection)) {
        const propX = intersection.x - offset.x;
        const propZ = intersection.z - offset.z;
        if (candidate.kind === 'fixture') {
          const resolved = resolveCollisions(candidate.fixture, fixtures, obstacles, propX, propZ);
          group.position.set(resolved.x, resolved.y, resolved.z);
        } else {
          // Models move freely on XZ — they have arbitrary footprints, so we
          // don't run them through the fixture OBB collision solver. Y stays
          // pinned at grab-time height.
          group.position.x = propX;
          group.position.z = propZ;
        }
      }
      e.preventDefault();
      return;
    }
    // Have a candidate but not yet a drag — check if we've crossed the
    // pixel threshold. Floor fixture: transition to drag. Truss fixture or
    // slot: abandon the candidate so the gesture acts as orbit instead.
    if (candidate && !dragStarted) {
      const dx = e.clientX - downX, dy = e.clientY - downY;
      if (dx * dx + dy * dy >= CLICK_THRESHOLD_PX * CLICK_THRESHOLD_PX) {
        if (isDraggable(candidate)) {
          beginDrag();
        } else {
          candidate = null;
        }
      }
      return;
    }
    // No interaction in progress — update hover state.
    const h = pick();
    if (h !== hovered) {
      hovered = h;
      setCursor(hoverCursor(h));
    }
  });

  dom.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return; // left button only
    setPointer(e);
    // Placement-mode click: place at the hit point, fire onPlace, exit.
    if (placement) {
      const hit = raycastPlacement();
      if (hit) {
        const cb = placement.onPlace;
        const p = hit.point.clone();
        finishPlacement();
        cb?.(p, hit);
      }
      e.preventDefault();
      return;
    }
    candidate = pick();          // may be null for empty-space click
    dragStarted = false;
    downX = e.clientX;
    downY = e.clientY;
    activePointerId = e.pointerId;
    // We intentionally don't disable orbit controls or capture the pointer
    // yet — those happen only once we know the gesture is a drag, so a
    // small mouse jitter on a click still works and orbit can run if the
    // user grabs a non-draggable truss fixture and moves the camera.
  });

  function finishGesture(e) {
    if (activePointerId !== null && e.pointerId !== activePointerId) return;
    const dx = e.clientX - downX, dy = e.clientY - downY;
    const wasClick = (dx * dx + dy * dy) < CLICK_THRESHOLD_PX * CLICK_THRESHOLD_PX;

    if (dragStarted) {
      controls.enabled = true;
      try { dom.releasePointerCapture(e.pointerId); } catch {}
    } else if (wasClick) {
      // Empty-space click → onSelect(null) (deselect). Fixture click →
      // onSelect(fixture). Slot click → onSlotClick(slot).
      if (!candidate) {
        onSelect?.(null);
      } else if (candidate.kind === 'fixture') {
        onSelect?.(candidate.fixture);
      } else if (candidate.kind === 'model') {
        onSelectModel?.(candidate.model);
      } else if (candidate.kind === 'slot') {
        onSlotClick?.(candidate.slot);
      }
    }
    candidate = null;
    dragStarted = false;
    activePointerId = null;
    setCursor(hoverCursor(hovered));
  }
  dom.addEventListener('pointerup', finishGesture);
  dom.addEventListener('pointercancel', finishGesture);

  // Esc cancels placement (and only placement — it doesn't deselect or close
  // menus on its own, those have their own handlers).
  document.addEventListener('keydown', (e) => {
    if (placement && e.key === 'Escape') {
      e.preventDefault();
      const cb = placement.onCancel;
      finishPlacement();
      cb?.();
    }
  }, true);

  function finishPlacement() {
    placement = null;
    controls.enabled = true;
    setCursor(hoverCursor(hovered));
  }

  return {
    startPlacement({ targets, onPlace, onCancel }) {
      if (placement) finishPlacement();
      placement = { targets, onPlace, onCancel };
      controls.enabled = false;        // left-drag would otherwise orbit
      setCursor('crosshair');
    },
    cancelPlacement() {
      if (!placement) return;
      const cb = placement.onCancel;
      finishPlacement();
      cb?.();
    },
    // XZ-only collision resolution — used to nudge a freshly-placed fixture
    // out of overlap with neighbours while preserving the raycast-derived Y.
    resolvePlacementXZ(fixture, x, z) {
      const r = resolveCollisions(fixture, fixtures, obstacles, x, z);
      return { x: r.x, z: r.z };
    },
  };
}
